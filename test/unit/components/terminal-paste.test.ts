// ─── Terminal Paste Registry Test ────────────────────────────────────────────
// The Paste toolbar button reads the clipboard and calls pasteToTerminal().
// TerminalTab registers its xterm adapter in the store registry on mount, so
// these tests verify routing without needing to mount a real xterm instance.

import { describe, expect, it, vi } from "vitest";
import {
	pasteToTerminal,
	registerTerminalAdapter,
	unregisterTerminalAdapter,
} from "../../../src/lib/frontend/stores/terminal.svelte.js";

describe("terminal paste registry", () => {
	it("routes pasted text to the registered adapter", () => {
		const adapter = { paste: vi.fn() };
		registerTerminalAdapter("pty-1", adapter);

		const command = "systemctl --user restart opencode-ios-compat.service";
		expect(pasteToTerminal("pty-1", command)).toBe(true);
		expect(adapter.paste).toHaveBeenCalledWith(command);

		unregisterTerminalAdapter("pty-1");
	});

	it("returns false for unknown PTY, null, or empty text", () => {
		expect(pasteToTerminal("pty-missing", "text")).toBe(false);
		expect(pasteToTerminal(null, "text")).toBe(false);
		expect(pasteToTerminal("pty-1", "")).toBe(false);
	});

	it("stops routing after the tab unregisters", () => {
		const adapter = { paste: vi.fn() };
		registerTerminalAdapter("pty-2", adapter);
		unregisterTerminalAdapter("pty-2");

		expect(pasteToTerminal("pty-2", "echo hi")).toBe(false);
		expect(adapter.paste).not.toHaveBeenCalled();
	});

	it("replaces a stale adapter when a tab remounts with the same PTY id", () => {
		const first = { paste: vi.fn() };
		const second = { paste: vi.fn() };
		registerTerminalAdapter("pty-3", first);
		registerTerminalAdapter("pty-3", second);

		expect(pasteToTerminal("pty-3", "ls")).toBe(true);
		expect(first.paste).not.toHaveBeenCalled();
		expect(second.paste).toHaveBeenCalledWith("ls");

		unregisterTerminalAdapter("pty-3");
	});
});
