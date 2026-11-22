// ─── MCP Add-Server Form Logic ───────────────────────────────────────────────
// Pure parsing/validation helpers for the Settings → MCP add-server form.
// Kept free of Svelte so they can be unit tested directly.

import type { McpServerConfig } from "../types.js";

// ─── Form values ────────────────────────────────────────────────────────────

export interface McpFormValues {
	name: string;
	transport: "local" | "remote";
	/** Local transport: the command line (e.g. `npx -y @modelcontextprotocol/server-filesystem .`). */
	command?: string;
	/** Remote transport: the server URL. */
	url?: string;
	/** Local transport: working directory. */
	cwd?: string;
	/** KEY=VALUE lines. */
	envText?: string;
	/** Header-Name: value lines (remote transport). */
	headersText?: string;
	disabled?: boolean;
	codemode?: boolean;
	/** "legacy" | "auto" | "2026-07-28" — empty means server default. */
	protocol?: string;
}

export type McpConfigResult =
	| { ok: true; name: string; config: McpServerConfig }
	| { ok: false; error: string };

// ─── Parsers ────────────────────────────────────────────────────────────────

/**
 * Split a command line into argv, honouring single quotes, double quotes and
 * backslash escapes. Empty segments are dropped.
 */
export function parseCommandLine(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let hasContent = false;

	for (let i = 0; i < input.length; i++) {
		const ch = input[i] ?? "";
		if (quote) {
			if (ch === "\\" && quote === '"' && i + 1 < input.length) {
				current += input[i + 1] ?? "";
				i++;
				hasContent = true;
				continue;
			}
			if (ch === quote) {
				quote = null;
				continue;
			}
			current += ch;
			hasContent = true;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			hasContent = true;
			continue;
		}
		if (ch === "\\" && i + 1 < input.length) {
			current += input[i + 1] ?? "";
			i++;
			hasContent = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (hasContent) {
				parts.push(current);
				current = "";
				hasContent = false;
			}
			continue;
		}
		current += ch;
		hasContent = true;
	}
	if (hasContent) parts.push(current);
	return parts;
}

/**
 * Parse `KEY=VALUE` lines into an object. Blank lines and lines starting with
 * `#` are ignored. Returns an error string for malformed lines.
 */
export function parseKeyValueLines(
	text: string | undefined,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
	const values: Record<string, string> = {};
	if (!text) return { ok: true, values };
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) {
			return {
				ok: false,
				error: `Invalid line (expected KEY=VALUE): "${line}"`,
			};
		}
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();
		if (!key) {
			return { ok: false, error: `Invalid line (empty key): "${line}"` };
		}
		values[key] = value;
	}
	return { ok: true, values };
}

/**
 * Parse `Name: value` header lines into an object. Blank lines and `#`
 * comments are ignored. Returns an error string for malformed lines.
 */
export function parseHeaderLines(
	text: string | undefined,
): { ok: true; values: Record<string, string> } | { ok: false; error: string } {
	const values: Record<string, string> = {};
	if (!text) return { ok: true, values };
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon <= 0) {
			return {
				ok: false,
				error: `Invalid header line (expected Name: value): "${line}"`,
			};
		}
		const name = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (!name) {
			return {
				ok: false,
				error: `Invalid header line (empty name): "${line}"`,
			};
		}
		values[name] = value;
	}
	return { ok: true, values };
}

// ─── Config builder ─────────────────────────────────────────────────────────

/** Protocol values accepted by the v2 Mcp.Protocol schema. */
export const MCP_PROTOCOLS = ["legacy", "auto", "2026-07-28"] as const;

export function isMcpProtocol(value: string): boolean {
	return (MCP_PROTOCOLS as readonly string[]).includes(value);
}

/**
 * Validate the form and build the McpServerConfig payload for `mcp_add`.
 * Only fields supported by the v2 Mcp.*ConfigEncoded schemas are emitted.
 */
export function buildMcpConfig(form: McpFormValues): McpConfigResult {
	const name = (form.name ?? "").trim();
	if (!name) return { ok: false, error: "Server name is required" };

	const protocol =
		form.protocol && isMcpProtocol(form.protocol) ? form.protocol : undefined;
	const common = {
		...(form.disabled ? { disabled: true } : {}),
		...(form.codemode ? { codemode: true } : {}),
		...(protocol ? { protocol } : {}),
	};

	if (form.transport === "local") {
		const command = parseCommandLine(form.command ?? "");
		if (command.length === 0) {
			return { ok: false, error: "Command is required for local servers" };
		}
		const env = parseKeyValueLines(form.envText);
		if (!env.ok) return { ok: false, error: env.error };
		const config: McpServerConfig = {
			type: "local",
			command,
			...common,
			...((form.cwd ?? "").trim() ? { cwd: (form.cwd ?? "").trim() } : {}),
			...(Object.keys(env.values).length > 0 && { environment: env.values }),
		};
		return { ok: true, name, config };
	}

	const url = (form.url ?? "").trim();
	if (!url) return { ok: false, error: "URL is required for remote servers" };
	const headers = parseHeaderLines(form.headersText);
	if (!headers.ok) return { ok: false, error: headers.error };
	const config: McpServerConfig = {
		type: "remote",
		url,
		...common,
		...(Object.keys(headers.values).length > 0 && {
			headers: headers.values,
		}),
	};
	return { ok: true, name, config };
}
