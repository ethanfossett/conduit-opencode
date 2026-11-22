// ─── MCP add-server form logic ───────────────────────────────────────────────

import { describe, expect, it } from "vitest";
import {
	buildMcpConfig,
	isMcpProtocol,
	parseCommandLine,
	parseHeaderLines,
	parseKeyValueLines,
} from "../../../src/lib/frontend/utils/mcp-form.js";

describe("parseCommandLine", () => {
	it("splits on whitespace", () => {
		expect(parseCommandLine("npx -y @mcp/server .")).toEqual([
			"npx",
			"-y",
			"@mcp/server",
			".",
		]);
	});

	it("honours single and double quotes", () => {
		expect(parseCommandLine(`node -e "console.log('hi there')"`)).toEqual([
			"node",
			"-e",
			"console.log('hi there')",
		]);
		expect(parseCommandLine("echo 'a b' c")).toEqual(["echo", "a b", "c"]);
	});

	it("keeps empty quoted arguments", () => {
		expect(parseCommandLine(`cmd "" x`)).toEqual(["cmd", "", "x"]);
	});

	it("handles backslash escapes outside quotes", () => {
		expect(parseCommandLine("a\\ b c")).toEqual(["a b", "c"]);
	});

	it("returns an empty array for blank input", () => {
		expect(parseCommandLine("   ")).toEqual([]);
	});
});

describe("parseKeyValueLines", () => {
	it("parses KEY=VALUE lines and ignores blanks/comments", () => {
		const result = parseKeyValueLines(
			"# comment\nFOO=bar\n\nBAZ=a=b\n  QUX = 1 ",
		);
		expect(result).toEqual({
			ok: true,
			values: { FOO: "bar", BAZ: "a=b", QUX: "1" },
		});
	});

	it("rejects malformed lines", () => {
		const result = parseKeyValueLines("NOPE");
		expect(result.ok).toBe(false);
	});

	it("treats undefined as empty", () => {
		expect(parseKeyValueLines(undefined)).toEqual({ ok: true, values: {} });
	});
});

describe("parseHeaderLines", () => {
	it("parses Name: value lines", () => {
		const result = parseHeaderLines("Authorization: Bearer abc\nX-Multi: a:b");
		expect(result).toEqual({
			ok: true,
			values: { Authorization: "Bearer abc", "X-Multi": "a:b" },
		});
	});

	it("rejects malformed lines", () => {
		expect(parseHeaderLines("no-colon").ok).toBe(false);
	});
});

describe("buildMcpConfig", () => {
	it("builds a local config from the command line", () => {
		const result = buildMcpConfig({
			name: " fs ",
			transport: "local",
			command: "npx -y @modelcontextprotocol/server-filesystem .",
			cwd: " /tmp ",
			envText: "TOKEN=abc",
			disabled: true,
			codemode: true,
			protocol: "auto",
		});
		expect(result).toEqual({
			ok: true,
			name: "fs",
			config: {
				type: "local",
				command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
				cwd: "/tmp",
				environment: { TOKEN: "abc" },
				disabled: true,
				codemode: true,
				protocol: "auto",
			},
		});
	});

	it("builds a minimal local config", () => {
		const result = buildMcpConfig({
			name: "fs",
			transport: "local",
			command: "server",
		});
		expect(result).toEqual({
			ok: true,
			name: "fs",
			config: { type: "local", command: ["server"] },
		});
	});

	it("builds a remote config with headers", () => {
		const result = buildMcpConfig({
			name: "remote",
			transport: "remote",
			url: " https://example.com/mcp ",
			headersText: "Authorization: Bearer x",
		});
		expect(result).toEqual({
			ok: true,
			name: "remote",
			config: {
				type: "remote",
				url: "https://example.com/mcp",
				headers: { Authorization: "Bearer x" },
			},
		});
	});

	it("requires a name", () => {
		const result = buildMcpConfig({
			name: " ",
			transport: "local",
			command: "server",
		});
		expect(result.ok).toBe(false);
	});

	it("requires a command for local servers", () => {
		const result = buildMcpConfig({
			name: "fs",
			transport: "local",
			command: "   ",
		});
		expect(result).toEqual({
			ok: false,
			error: "Command is required for local servers",
		});
	});

	it("requires a URL for remote servers", () => {
		const result = buildMcpConfig({ name: "r", transport: "remote", url: "" });
		expect(result).toEqual({
			ok: false,
			error: "URL is required for remote servers",
		});
	});

	it("surfaces malformed env lines", () => {
		const result = buildMcpConfig({
			name: "fs",
			transport: "local",
			command: "server",
			envText: "NOPE",
		});
		expect(result.ok).toBe(false);
	});

	it("drops unknown protocol values", () => {
		const result = buildMcpConfig({
			name: "fs",
			transport: "local",
			command: "server",
			protocol: "bogus",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect("protocol" in result.config).toBe(false);
		}
	});

	it("isMcpProtocol accepts only schema values", () => {
		expect(isMcpProtocol("legacy")).toBe(true);
		expect(isMcpProtocol("auto")).toBe(true);
		expect(isMcpProtocol("2026-07-28")).toBe(true);
		expect(isMcpProtocol("bogus")).toBe(false);
	});
});
