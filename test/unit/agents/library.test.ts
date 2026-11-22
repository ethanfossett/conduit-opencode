// ─── Agent Library Tests ─────────────────────────────────────────────────────
// File-per-agent storage: round trip, validation, import/export semantics.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agentsDir,
	deleteLibraryAgent,
	exportAgentBundle,
	importAgentBundle,
	listLibraryAgents,
	readLibraryAgent,
	saveLibraryAgent,
} from "../../../src/lib/agents/library.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "agent-lib-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("agent library", () => {
	it("saves, lists and reads an agent as a file-per-agent JSON", async () => {
		const ok = await saveLibraryAgent(dir, "my-agent", {
			description: "test agent",
			mode: "subagent",
			prompt: "do the thing",
		});
		expect(ok).toBe(true);

		const onDisk = JSON.parse(
			await readFile(join(agentsDir(dir), "my-agent.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(onDisk["name"]).toBe("my-agent");
		expect(onDisk["prompt"]).toBe("do the thing");

		const listed = await listLibraryAgents(dir);
		expect(listed).toHaveLength(1);
		expect(listed[0]?.name).toBe("my-agent");
		expect(listed[0]?.source).toBe("library");

		const read = await readLibraryAgent(dir, "my-agent");
		expect(read?.definition["description"]).toBe("test agent");
	});

	it("returns an empty list when the library directory does not exist", async () => {
		const empty = await mkdtemp(join(tmpdir(), "agent-lib-empty-"));
		try {
			expect(await listLibraryAgents(empty)).toEqual([]);
		} finally {
			await rm(empty, { recursive: true, force: true });
		}
	});

	it("rejects invalid names and skips invalid files", async () => {
		expect(await saveLibraryAgent(dir, "Bad Name", { prompt: "x" })).toBe(
			false,
		);
		expect(await saveLibraryAgent(dir, "../escape", { prompt: "x" })).toBe(
			false,
		);
		expect(await saveLibraryAgent(dir, "UPPER", { prompt: "x" })).toBe(false);

		// A syntactically valid filename with broken content is skipped.
		await mkdir(agentsDir(dir), { recursive: true });
		await writeFile(join(agentsDir(dir), "broken.json"), "{ not json");
		await writeFile(
			join(agentsDir(dir), "nameless.json"),
			JSON.stringify({ prompt: "no name" }),
		);
		expect(await listLibraryAgents(dir)).toEqual([]);
	});

	it("deletes only the library file", async () => {
		await saveLibraryAgent(dir, "temp-agent", { prompt: "x" });
		expect(await deleteLibraryAgent(dir, "temp-agent")).toBe(true);
		expect(await deleteLibraryAgent(dir, "temp-agent")).toBe(false);
		expect(await readLibraryAgent(dir, "temp-agent")).toBeNull();
	});

	it("exports a versioned bundle of all agents", async () => {
		await saveLibraryAgent(dir, "a1", { prompt: "one" });
		await saveLibraryAgent(dir, "a2", { prompt: "two" });
		const bundle = await exportAgentBundle(dir);
		expect(bundle.version).toBe(1);
		expect(bundle.agents.map((a) => a.name).sort()).toEqual(["a1", "a2"]);
		expect(bundle.agents[0]).toHaveProperty("prompt");
	});

	it("imports bundles: new agents imported, existing skipped unless overwrite", async () => {
		await saveLibraryAgent(dir, "existing", { prompt: "old" });
		const bundle = {
			version: 1,
			agents: [
				{ name: "existing", prompt: "new" },
				{ name: "fresh", prompt: "hello" },
				{ name: "Bad Name", prompt: "nope" },
				"not-an-object",
			],
		};

		const first = await importAgentBundle(dir, bundle);
		expect(first.imported).toEqual(["fresh"]);
		expect(first.skipped).toEqual(["existing"]);
		expect(first.invalid).toHaveLength(2);
		const existing = await readLibraryAgent(dir, "existing");
		expect(existing?.definition["prompt"]).toBe("old");

		const second = await importAgentBundle(dir, bundle, { overwrite: true });
		expect(second.imported).toEqual(["existing", "fresh"]);
		const overwritten = await readLibraryAgent(dir, "existing");
		expect(overwritten?.definition["prompt"]).toBe("new");
	});

	it("rejects malformed bundles without touching the library", async () => {
		await saveLibraryAgent(dir, "keep", { prompt: "x" });
		const result = await importAgentBundle(dir, { nope: true });
		expect(result.imported).toEqual([]);
		expect(result.invalid.length).toBeGreaterThan(0);
		expect((await listLibraryAgents(dir)).map((a) => a.name)).toEqual(["keep"]);
	});
});
