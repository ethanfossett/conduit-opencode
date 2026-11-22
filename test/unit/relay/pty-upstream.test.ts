// ─── PTY Upstream (persistent v2) ────────────────────────────────────────────
// Locks in frame classification (raw output vs JSON control) and the connect
// URL construction for the persistent-PTY endpoint.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSilentLogger } from "../../../src/lib/logger.js";
import {
	classifyPtyFrame,
	connectPtyUpstream,
	type PtyUpstreamDeps,
} from "../../../src/lib/relay/pty-upstream.js";

// ─── Fake WebSocket ──────────────────────────────────────────────────────────

type Listener = (...args: unknown[]) => void;

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	url: string;
	options: Record<string, unknown>;
	readyState = 1;
	listeners = new Map<string, Listener[]>();

	constructor(url: string, options: Record<string, unknown>) {
		this.url = url;
		this.options = options;
		FakeWebSocket.instances.push(this);
	}

	static last(): FakeWebSocket {
		const ws = FakeWebSocket.instances.at(-1);
		if (!ws) throw new Error("no FakeWebSocket instance");
		return ws;
	}

	on(event: string, fn: Listener): this {
		const list = this.listeners.get(event) ?? [];
		list.push(fn);
		this.listeners.set(event, list);
		return this;
	}

	send(_data: unknown): void {}
	close(): void {
		this.readyState = 3;
	}
	terminate(): void {
		this.readyState = 3;
	}

	emit(event: string, ...args: unknown[]): void {
		for (const fn of this.listeners.get(event) ?? []) fn(...args);
	}
}

function createDeps(overrides?: Partial<PtyUpstreamDeps>) {
	const broadcasts: unknown[] = [];
	const deps: PtyUpstreamDeps = {
		ptyManager: {
			registerSession: vi.fn(),
			setAttachmentID: vi.fn(),
			closeSession: vi.fn(),
			appendScrollback: vi.fn(),
			markExited: vi.fn(),
			hasSession: vi.fn().mockReturnValue(true),
		},
		wsHandler: {
			broadcast: vi.fn((msg) => broadcasts.push(msg)),
		},
		client: {
			getAuthHeaders: vi.fn().mockReturnValue({
				"x-opencode-directory": "/tmp/proj",
			}),
			getApiBaseUrl: vi.fn().mockReturnValue("http://127.0.0.1:4096/api"),
		},
		opencodeUrl: "http://127.0.0.1:4096",
		log: createSilentLogger(),
		WebSocketClass:
			FakeWebSocket as unknown as PtyUpstreamDeps["WebSocketClass"],
		...overrides,
	};
	return { deps, broadcasts };
}

afterEach(() => {
	FakeWebSocket.instances = [];
	vi.unstubAllGlobals();
});

// ─── classifyPtyFrame ────────────────────────────────────────────────────────

describe("classifyPtyFrame", () => {
	it("treats raw ANSI bytes as terminal output", () => {
		const result = classifyPtyFrame(Buffer.from("\u001b[32mhello\u001b[0m"));
		expect(result).toEqual({
			kind: "output",
			text: "\u001b[32mhello\u001b[0m",
		});
	});

	it("classifies known JSON control frames", () => {
		const result = classifyPtyFrame(
			Buffer.from('{"type":"attached","attachmentID":"a1"}'),
		);
		expect(result?.kind).toBe("control");
		if (result?.kind === "control") {
			expect(result.frame.type).toBe("attached");
		}
	});

	it("captures exitCode from an exited control frame", () => {
		const result = classifyPtyFrame(
			Buffer.from('{"type":"exited","exitCode":7,"finalOffset":10}'),
		);
		expect(result?.kind).toBe("control");
		if (result?.kind === "control") {
			expect(result.frame.type).toBe("exited");
			expect(result.frame.exitCode).toBe(7);
		}
	});

	it("drops 0x00-prefixed legacy cursor metadata", () => {
		const buf = Buffer.concat([
			Buffer.from([0x00]),
			Buffer.from('{"cursor":42}'),
		]);
		expect(classifyPtyFrame(buf)).toBeNull();
	});

	it("drops empty frames", () => {
		expect(classifyPtyFrame(Buffer.alloc(0))).toBeNull();
	});

	it("forwards JSON-looking output that is not a control type", () => {
		// A user catting a JSON file must not vanish from the terminal.
		const text = '{"type":"custom-thing","value":1}';
		const result = classifyPtyFrame(Buffer.from(text));
		expect(result).toEqual({ kind: "output", text });
	});

	it("forwards malformed JSON verbatim", () => {
		const text = "{not json";
		expect(classifyPtyFrame(Buffer.from(text))).toEqual({
			kind: "output",
			text,
		});
	});
});

// ─── connectPtyUpstream ──────────────────────────────────────────────────────

describe("connectPtyUpstream", () => {
	it("connects to the persistent-PTY endpoint with cursor and location", async () => {
		// connect-token is best-effort; a non-ok response falls back gracefully.
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
		);

		const { deps } = createDeps();
		const promise = connectPtyUpstream(deps, "pty_abc", { cursor: 0 });
		// Let the ticket fetch settle before the WebSocket is constructed.
		await Promise.resolve();
		await Promise.resolve();

		const ws = FakeWebSocket.last();
		expect(ws.url).toContain(
			"/api/experimental/persistent-pty/pty_abc/connect",
		);
		expect(ws.url).toContain("cursor=0");
		expect(ws.url).toContain("role=controller");
		expect(ws.url).toContain("input_protocol=1");
		expect(ws.url).toContain(
			`location%5Bdirectory%5D=${encodeURIComponent("/tmp/proj")}`,
		);
		expect(ws.url.startsWith("ws://")).toBe(true);

		let ready = false;
		void promise.then(() => {
			ready = true;
		});
		ws.emit("open");
		await Promise.resolve();
		expect(ready).toBe(false);
		ws.emit(
			"message",
			Buffer.from(
				'{"type":"attached","attachmentID":"controller-1","inputProtocol":1,"role":"controller"}',
			),
		);
		await promise;
		expect(deps.ptyManager.registerSession).toHaveBeenCalledWith("pty_abc", ws);
		expect(deps.ptyManager.setAttachmentID).toHaveBeenCalledWith(
			"pty_abc",
			"controller-1",
			1,
		);
	});

	it("appends raw output to scrollback and broadcasts pty_output", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
		);
		const { deps, broadcasts } = createDeps();
		const promise = connectPtyUpstream(deps, "pty_out", { cursor: 0 });
		await Promise.resolve();
		await Promise.resolve();
		const ws = FakeWebSocket.last();
		ws.emit("open");
		ws.emit(
			"message",
			Buffer.from(
				'{"type":"attached","attachmentID":"controller-1","inputProtocol":1,"role":"controller"}',
			),
		);
		await promise;

		ws.emit("message", Buffer.from("hello world"));
		expect(deps.ptyManager.appendScrollback).toHaveBeenCalledWith(
			"pty_out",
			"hello world",
		);
		expect(broadcasts).toContainEqual({
			type: "pty_output",
			ptyId: "pty_out",
			data: "hello world",
		});

		// Control frames are consumed, not broadcast.
		ws.emit("message", Buffer.from('{"type":"replay_complete","endOffset":5}'));
		expect(
			broadcasts.some((b) =>
				(b as { data?: string }).data?.includes("replay_complete"),
			),
		).toBe(false);
	});

	it("broadcasts pty_exited with the control-frame exit code", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
		);
		const { deps, broadcasts } = createDeps();
		const promise = connectPtyUpstream(deps, "pty_exit", { cursor: 0 });
		await Promise.resolve();
		await Promise.resolve();
		const ws = FakeWebSocket.last();
		ws.emit("open");
		ws.emit(
			"message",
			Buffer.from(
				'{"type":"attached","attachmentID":"controller-1","inputProtocol":1,"role":"controller"}',
			),
		);
		await promise;

		ws.emit("message", Buffer.from('{"type":"exited","exitCode":3}'));
		expect(deps.ptyManager.markExited).toHaveBeenCalledWith("pty_exit", 3);
		expect(broadcasts).toContainEqual({
			type: "pty_exited",
			ptyId: "pty_exit",
			exitCode: 3,
		});
	});
});
