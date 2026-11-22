// ─── MCP Add/Replace Form (component) ────────────────────────────────────────
// Verifies the Settings → MCP add-server form builds a valid McpServerConfig
// and sends it as `mcp_add` over the WebSocket.

import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";

const wsSendSpy = vi.fn();
const toastSpy = vi.fn();

vi.mock("../../../src/lib/frontend/stores/ws.svelte.js", () => ({
	wsSend: (...args: unknown[]) => wsSendSpy(...args),
}));

vi.mock("../../../src/lib/frontend/stores/ui.svelte.js", () => ({
	showToast: (...args: unknown[]) => toastSpy(...args),
}));

import McpAddForm from "../../../src/lib/frontend/components/overlays/McpAddForm.svelte";

async function renderForm(props: { editName?: string | null } = {}) {
	const result = render(McpAddForm, { props });
	flushSync();
	await tick();
	return result;
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("McpAddForm", () => {
	it("disables submit until a name and command are present", async () => {
		await renderForm();
		const submit = screen.getByTestId("mcp-add-submit") as HTMLButtonElement;
		expect(submit.disabled).toBe(true);

		await fireEvent.input(screen.getByTestId("mcp-name-input"), {
			target: { value: "fs" },
		});
		flushSync();
		expect(submit.disabled).toBe(true);

		await fireEvent.input(screen.getByTestId("mcp-command-input"), {
			target: { value: "npx -y server ." },
		});
		flushSync();
		expect(submit.disabled).toBe(false);
	});

	it("sends mcp_add with a local config on submit", async () => {
		await renderForm();
		await fireEvent.input(screen.getByTestId("mcp-name-input"), {
			target: { value: "fs" },
		});
		await fireEvent.input(screen.getByTestId("mcp-command-input"), {
			target: { value: "npx -y @mcp/server ." },
		});
		await fireEvent.input(screen.getByTestId("mcp-env-input"), {
			target: { value: "TOKEN=abc" },
		});
		flushSync();

		await fireEvent.click(screen.getByTestId("mcp-add-submit"));

		expect(wsSendSpy).toHaveBeenCalledWith({
			type: "mcp_add",
			server: "fs",
			config: {
				type: "local",
				command: ["npx", "-y", "@mcp/server", "."],
				environment: { TOKEN: "abc" },
			},
		});
	});

	it("surfaces build errors as a toast without sending", async () => {
		await renderForm();
		await fireEvent.input(screen.getByTestId("mcp-name-input"), {
			target: { value: "fs" },
		});
		await fireEvent.input(screen.getByTestId("mcp-command-input"), {
			target: { value: "server" },
		});
		await fireEvent.input(screen.getByTestId("mcp-env-input"), {
			target: { value: "NOT_A_KV" },
		});
		flushSync();

		await fireEvent.click(screen.getByTestId("mcp-add-submit"));

		expect(wsSendSpy).not.toHaveBeenCalled();
		expect(toastSpy).toHaveBeenCalledWith(
			expect.stringContaining("KEY=VALUE"),
			expect.objectContaining({ variant: "warn" }),
		);
	});

	it("prefills and locks the name when replacing a server", async () => {
		await renderForm({ editName: "github" });
		const nameInput = screen.getByTestId("mcp-name-input") as HTMLInputElement;
		expect(nameInput.value).toBe("github");
		expect(nameInput.disabled).toBe(true);

		await fireEvent.input(screen.getByTestId("mcp-command-input"), {
			target: { value: "gh-mcp" },
		});
		flushSync();
		await fireEvent.click(screen.getByTestId("mcp-add-submit"));

		expect(wsSendSpy).toHaveBeenCalledWith({
			type: "mcp_add",
			server: "github",
			config: { type: "local", command: ["gh-mcp"] },
		});
	});
});
