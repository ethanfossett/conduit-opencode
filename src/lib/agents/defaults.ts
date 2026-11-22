// ─── Bundled default agents ──────────────────────────────────────────────────
// Shipped in the repository at agents/defaults/*.json. The directory is found
// by walking up from this module, so it works from src (dev) and dist (build).

import { access, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "../logger.js";
import {
	isValidAgentName,
	type LibraryAgent,
	splitNamedAgent,
} from "./types.js";

let cachedDir: string | null | undefined;

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

/** Directory of this module (src/lib/agents in dev, dist/src/lib/agents built). */
function moduleDir(): string {
	return dirname(fileURLToPath(import.meta.url));
}

/** Walk up from `startDir` until an `agents/defaults` directory is found. */
export async function findDefaultsDir(
	startDir: string = moduleDir(),
): Promise<string | null> {
	let dir = startDir;
	for (;;) {
		const candidate = join(dir, "agents", "defaults");
		if (await pathExists(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Load all bundled defaults. Missing directory → empty list. */
export async function listDefaultAgents(log?: Logger): Promise<LibraryAgent[]> {
	if (cachedDir === undefined) cachedDir = await findDefaultsDir();
	if (!cachedDir) {
		log?.warn("[agents] bundled defaults directory not found");
		return [];
	}
	let files: string[];
	try {
		files = await readdir(cachedDir);
	} catch {
		return [];
	}
	const agents: LibraryAgent[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const fallbackName = file.slice(0, -5);
		try {
			const raw = JSON.parse(await readFile(join(cachedDir, file), "utf-8"));
			const split = splitNamedAgent(raw);
			if (!split) throw new Error("missing or invalid name");
			agents.push({
				name: split.name,
				source: "default",
				definition: split.definition,
			});
		} catch (err) {
			log?.warn(`[agents] skipping invalid default ${file}: ${err}`);
			// Keep the name visible for diagnostics when valid.
			if (isValidAgentName(fallbackName)) continue;
		}
	}
	agents.sort((a, b) => a.name.localeCompare(b.name));
	return agents;
}

/** Test seam: forget the cached defaults directory. */
export function resetDefaultsCache(): void {
	cachedDir = undefined;
}
