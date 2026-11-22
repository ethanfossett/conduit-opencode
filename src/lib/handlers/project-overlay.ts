// ─── Project Config Overlay ─────────────────────────────────────────────────
// Writes Conduit-managed settings (subagent models, default model, permissions)
// into <project>/.opencode/opencode.json, a loadable OpenCode project config.
// Keeping them in a dedicated file means earlier values still persist and we
// never rewrite (or strip comments from) the user's own opencode.json/jsonc.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "../logger.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(
	base: Record<string, unknown>,
	patch: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		result[key] =
			isRecord(result[key]) && isRecord(value)
				? deepMerge(result[key] as Record<string, unknown>, value)
				: value;
	}
	return result;
}

export async function mergeProjectOverlay(
	projectDir: string,
	patch: Record<string, unknown>,
	log?: Logger,
): Promise<void> {
	const dir = join(projectDir, ".opencode");
	const file = join(dir, "opencode.json");
	let existing: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(await readFile(file, "utf-8"));
		if (isRecord(parsed)) existing = parsed;
	} catch {
		// Fresh overlay.
	}
	const merged = deepMerge(existing, patch);
	await mkdir(dir, { recursive: true });
	await writeFile(file, `${JSON.stringify(merged, null, 2)}\n`);
	log?.info(`[overlay] merged project config into ${file}`);
}
