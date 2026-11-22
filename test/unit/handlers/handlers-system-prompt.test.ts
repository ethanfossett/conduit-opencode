// ─── Per-chat system prompt handler tests ────────────────────────────────────
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceRegistry } from "../../../src/lib/daemon/service-registry.js";
import { handleMessage } from "../../../src/lib/handlers/prompt.js";
import { handleSetSystemPrompt } from "../../../src/lib/handlers/system-prompt.js";
import type { HandlerDeps } from "../../../src/lib/handlers/types.js";
import { loadRelaySettings } from "../../../src/lib/relay/relay-settings.js";
import { SessionOverrides } from "../../../src/lib/session/session-overrides.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("handleSetSystemPrompt", () => {
	let configDir: string;
	let deps: HandlerDeps;
	let overrides: SessionOverrides;
	let sendToCalls: Array<{ clientId: string; msg: unknown }>;
	let sendToSessionCalls: Array<{ sessionId: string; msg: unknown }>;

	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "sysprompt-"));
		overrides = new SessionOverrides(new ServiceRegistry());
		sendToCalls = [];
		sendToSessionCalls = [];
		deps = createMockHandlerDeps({
			overrides,
			config: { configDir } as unknown as HandlerDeps["config"],
			wsHandler: {
				broadcast: vi.fn(),
				sendTo: (clientId: string, msg: unknown) =>
					sendToCalls.push({ clientId, msg }),
				setClientSession: vi.fn(),
				getClientSession: vi.fn().mockReturnValue("session-1"),
				getClientsForSession: vi.fn().mockReturnValue([]),
				sendToSession: (sessionId: string, msg: unknown) =>
					sendToSessionCalls.push({ sessionId, msg }),
			} as unknown as HandlerDeps["wsHandler"],
		});
	});

	afterEach(() => {
		rmSync(configDir, { recursive: true, force: true });
	});

	it("stores the prompt, persists it, and acks the client + session", async () => {
		await handleSetSystemPrompt(deps, "client-1", {
			text: "  You are a terse assistant.  ",
		});

		expect(overrides.getSystemPrompt("session-1")).toBe(
			"You are a terse assistant.",
		);
		expect(sendToCalls).toEqual([
			{
				clientId: "client-1",
				msg: {
					type: "system_prompt_info",
					text: "You are a terse assistant.",
					sessionId: "session-1",
				},
			},
		]);
		expect(sendToSessionCalls).toEqual([
			{
				sessionId: "session-1",
				msg: { type: "system_prompt_info", text: "You are a terse assistant." },
			},
		]);

		const settings = loadRelaySettings(configDir);
		expect(settings.sessionSystemPrompts?.["session-1"]).toBe(
			"You are a terse assistant.",
		);
	});

	it("uses payload.sessionId over the client's session", async () => {
		await handleSetSystemPrompt(deps, "client-1", {
			text: "Only for this chat",
			sessionId: "session-9",
		});
		expect(overrides.getSystemPrompt("session-9")).toBe("Only for this chat");
		expect(overrides.getSystemPrompt("session-1")).toBeUndefined();
	});

	it("clears the prompt when given empty or whitespace text", async () => {
		await handleSetSystemPrompt(deps, "client-1", { text: "Something" });
		await handleSetSystemPrompt(deps, "client-1", { text: "   " });

		expect(overrides.getSystemPrompt("session-1")).toBeUndefined();
		expect(
			loadRelaySettings(configDir).sessionSystemPrompts?.["session-1"],
		).toBe("");
		// Last ack carries the cleared value.
		expect(sendToCalls.at(-1)?.msg).toEqual({
			type: "system_prompt_info",
			text: "",
			sessionId: "session-1",
		});
	});

	it("warns and does nothing when there is no session", async () => {
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		await handleSetSystemPrompt(deps, "client-1", { text: "Nope" });
		expect(sendToCalls).toEqual([]);
		expect(sendToSessionCalls).toEqual([]);
	});
});

describe("handleMessage with a per-chat system prompt", () => {
	it("forwards the stored system prompt to OpenCode", async () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		overrides.setSystemPrompt("session-1", "Always answer in haiku.");
		const deps = createMockHandlerDeps({ overrides });
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");

		await handleMessage(deps, "client-1", { text: "Hello" });

		expect(deps.client.sendMessageAsync).toHaveBeenCalledWith("session-1", {
			text: "Hello",
			system: "Always answer in haiku.",
		});
	});

	it("omits the system field when no prompt is set", async () => {
		const overrides = new SessionOverrides(new ServiceRegistry());
		const deps = createMockHandlerDeps({ overrides });
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");

		await handleMessage(deps, "client-1", { text: "Hello" });

		expect(deps.client.sendMessageAsync).toHaveBeenCalledWith("session-1", {
			text: "Hello",
		});
	});
});
