import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
	ChatDuplex,
	sameChatVoiceOrigin,
} from "../../../src/lib/chat/duplex.js";
import { ChatService } from "../../../src/lib/chat/service.js";

it("passes simultaneous microphone and playback frames only through a same-origin voice session", async () => {
	const directory = await mkdtemp(join(tmpdir(), "conduit-duplex-"));
	const worker = new WebSocketServer({ host: "127.0.0.1", port: 0 });
	await once(worker, "listening");
	const service = new ChatService(directory, async () => "Reply");
	const chat = await service.create(true);
	await service.send(chat.id, "Goal: synthetic voice context");
	const bridge = new ChatDuplex(
		service,
		`ws://127.0.0.1:${(worker.address() as AddressInfo).port}/v1/realtime`,
	);
	const server = createServer();
	server.on("upgrade", (req, socket, head) => {
		if (!sameChatVoiceOrigin(req)) {
			socket.destroy();
			return;
		}
		void bridge.upgrade(req, socket, head, chat.id);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
	let client: WebSocket | undefined;
	try {
		const wrongOrigin = new WebSocket(`ws://${host}`, {
			origin: "https://example.com",
		});
		await expect(once(wrongOrigin, "open")).rejects.toThrow();
		const incoming = once(worker, "connection");
		client = new WebSocket(`ws://${host}`, { origin: `http://${host}` });
		const [upstream] = (await incoming) as [WebSocket];
		const [configuration] = await once(upstream, "message");
		expect(JSON.parse(configuration.toString()).session.instructions).toContain(
			"synthetic voice context",
		);
		const ready = once(client, "message");
		upstream.send(JSON.stringify({ type: "session.created" }));
		expect((await ready)[0].toString()).toBe("ready");

		const playback = once(client, "message");
		const microphone = once(upstream, "message");
		const frame = Buffer.alloc(1920 * 4);
		frame.writeFloatLE(0.25);
		client.send(frame);
		upstream.send(
			JSON.stringify({
				type: "response.output_audio.delta",
				sample_rate_hz: 24000,
				delta: "AAE=",
			}),
		);
		expect(Buffer.from((await playback)[0])).toEqual(Buffer.from([0, 1]));
		expect(JSON.parse((await microphone)[0].toString())).toMatchObject({
			type: "input_audio_buffer.append",
			sample_rate_hz: 24000,
			is_speech: true,
		});
		const closing = once(client, "close");
		client.send("not audio");
		expect((await closing)[0]).toBe(1008);
	} finally {
		client?.terminate();
		for (const peer of worker.clients) peer.terminate();
		await Promise.all([
			new Promise<void>((resolve) => server.close(() => resolve())),
			new Promise<void>((resolve) => worker.close(() => resolve())),
		]);
		await rm(directory, { recursive: true, force: true });
	}
});
