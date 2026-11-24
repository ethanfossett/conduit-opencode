import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { assembleHistory } from "./context.js";
import type { ChatService } from "./service.js";

const SAMPLE_RATE = 24_000;
const FRAME_MS = 80;
const FRAME_BYTES = (SAMPLE_RATE * FRAME_MS * 4) / 1_000;
const MAX_QUEUE = 64 * 1024;
const MODEL = "nvidia/personaplex-7b-v1";

export function configuredDuplexEndpoint() {
	const port = Number(process.env["CONDUIT_CHAT_DUPLEX_PORT"]);
	return Number.isInteger(port) && port >= 1024 && port <= 65535
		? `ws://127.0.0.1:${port}/v1/realtime?duplex=1&autostart=0&model=${encodeURIComponent(MODEL)}`
		: undefined;
}

export class ChatDuplex {
	private readonly server = new WebSocketServer({
		noServer: true,
		maxPayload: FRAME_BYTES,
		perMessageDeflate: false,
	});
	private active = false;

	constructor(
		private readonly chat: ChatService,
		private readonly endpoint: string,
	) {}

	async upgrade(
		req: IncomingMessage,
		socket: Duplex,
		head: Buffer,
		id: string,
	) {
		if (this.active) {
			socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
			return;
		}
		this.active = true;
		const abandon = () => {
			this.active = false;
		};
		// If the peer disappears during storage or the upgrade is malformed,
		// release the slot before the next call comes in.
		socket.once("close", abandon);
		try {
			const chat = await this.chat.get(id);
			if (socket.destroyed) return;
			const entries = assembleHistory(chat, chat.messages.length, "", 0)
				.filter(({ kind, role }) => role === "user" && kind !== "Recalled")
				.slice(-4)
				.map(({ role, text }) => `${role}: ${text.slice(0, 300)}`);
			const instructions = [
				"You are a concise and helpful voice assistant. Follow the user's current instructions.",
				...entries,
			]
				.join("\n")
				.slice(0, 1_500);
			this.server.handleUpgrade(req, socket, head, (browser) => {
				socket.off("close", abandon);
				this.bridge(browser, instructions, abandon);
			});
		} catch {
			socket.destroy();
		}
	}

	private bridge(
		browser: WebSocket,
		instructions: string,
		release: () => void,
	) {
		const worker = new WebSocket(this.endpoint, {
			handshakeTimeout: 5_000,
			maxPayload: 256 * 1024,
			perMessageDeflate: false,
			followRedirects: false,
		});
		let ready = false;
		let frames = 0;
		const setup = setTimeout(
			() => browser.close(1013, "Local voice model unavailable"),
			20_000,
		).unref();
		const deadline = setTimeout(
			() => browser.close(1000, "Voice session time limit"),
			230_000,
		).unref();
		browser.on("close", () => {
			clearTimeout(setup);
			clearTimeout(deadline);
			worker.terminate();
			release();
		});
		browser.on("error", () => browser.terminate());
		worker.on("error", () =>
			browser.close(1013, "Local voice model unavailable"),
		);
		worker.on("close", () =>
			browser.close(1013, "Local voice model disconnected"),
		);
		worker.on("open", () => {
			worker.send(
				JSON.stringify({
					type: "session.update",
					session: {
						model: MODEL,
						modalities: ["audio", "text"],
						input_audio_format: "pcm_f32le",
						output_audio_format: "pcm16",
						voice: "NATF2.pt",
						instructions,
						turn_detection: null,
						extra_body: { auto_response: true },
					},
				}),
			);
		});
		browser.on("message", (data, binary) => {
			if (
				!ready ||
				!binary ||
				!Buffer.isBuffer(data) ||
				data.length !== FRAME_BYTES
			) {
				browser.close(1008, "Invalid voice frame");
				return;
			}
			if (
				worker.readyState !== WebSocket.OPEN ||
				worker.bufferedAmount > MAX_QUEUE
			) {
				browser.close(1013, "Local voice fell behind");
				return;
			}
			let energy = 0;
			for (let offset = 0; offset < FRAME_BYTES; offset += 4) {
				const sample = data.readFloatLE(offset);
				if (!Number.isFinite(sample) || Math.abs(sample) > 1) {
					browser.close(1008, "Invalid voice sample");
					return;
				}
				energy += sample * sample;
			}
			worker.send(
				JSON.stringify({
					type: "input_audio_buffer.append",
					audio: data.toString("base64"),
					format: "pcm_f32le",
					sample_rate_hz: SAMPLE_RATE,
					duration_ms: FRAME_MS,
					audio_end_ms: ++frames * FRAME_MS,
					is_speech: energy / (FRAME_BYTES / 4) >= 1e-8,
				}),
			);
		});
		worker.on("message", (data) => {
			if (browser.readyState !== WebSocket.OPEN) return;
			try {
				const event = JSON.parse(data.toString()) as {
					type?: string;
					delta?: string;
					sample_rate_hz?: number;
				};
				if (event.type === "error") {
					browser.close(1013, "Local voice model unavailable");
				} else if (event.type === "session.created" && !ready) {
					clearTimeout(setup);
					ready = true;
					browser.send("ready");
				} else if (
					ready &&
					(event.type === "response.output_audio.delta" ||
						event.type === "response.audio.delta") &&
					event.sample_rate_hz === SAMPLE_RATE &&
					typeof event.delta === "string"
				) {
					const audio = Buffer.from(event.delta, "base64");
					if (
						browser.bufferedAmount > MAX_QUEUE ||
						audio.length > 24_000 ||
						audio.length % 2
					) {
						browser.close(1013, "Voice playback fell behind");
						return;
					}
					if (audio.length) browser.send(audio);
				}
			} catch {
				browser.close(1013, "Invalid response from local voice model");
			}
		});
	}
}

export function sameChatVoiceOrigin(req: IncomingMessage) {
	const origin = URL.parse(req.headers.origin ?? "");
	return (
		!!origin &&
		origin.host === req.headers.host &&
		(origin.protocol === "https:" ||
			(origin.protocol === "http:" &&
				["127.0.0.1", "localhost"].includes(origin.hostname)))
	);
}
