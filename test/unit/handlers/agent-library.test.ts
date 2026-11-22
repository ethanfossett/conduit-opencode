// ─── Agent Library Handler Tests ─────────────────────────────────────────────

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleApplyAgents,
	handleDeleteAgent,
	handleExportAgents,
	handleImportAgents,
	handleListAgentLibrary,
	handleRemoveAppliedAgents,
	handleSaveAgent,
} from "../../../src/lib/handlers/agent-library.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

let configDir: string;
let projectDir: string;

function makeDeps() {
	const deps = createMockHandlerDeps();
	(deps.config as { configDir?: string }).configDir = configDir;
	(deps.config as { projectDir: string }).projectDir = projectDir;
	return deps;
}

function sent(
	deps: ReturnType<typeof makeDeps>,
	type: string,
): Record<string, unknown> | undefined {
	const call = (
		deps.wsHandler.sendTo as unknown as {
			mock: { calls: Array<[string, Record<string, unknown>]> };
		}
	).mock.calls.find(([, msg]) => msg["type"] === type);
	return call?.[1];
}

beforeEach(async () => {
	configDir = await mkdtemp(join(tmpdir(), "agent-lib-cfg-"));
	projectDir = await mkdtemp(join(tmpdir(), "agent-lib-proj-"));
});

afterEach(async () => {
	await rm(configDir, { recursive: true, force: true });
	await rm(projectDir, { recursive: true, force: true });
});

describe("agent library handlers", () => {
	it("saves an agent and lists it with source=library", async () => {
		const deps = makeDeps();
		await handleSaveAgent(deps, "c1", {
			name: "my-agent",
			definition: { prompt: "hello", mode: "primary" },
		});
		expect(sent(deps, "agent_saved")).toMatchObject({ name: "my-agent" });

		await handleListAgentLibrary(deps, "c1", {});
		const lib = sent(deps, "agent_library");
		const agents = lib?.["agents"] as Array<{ name: string; source: string }>;
		const mine = agents.find((a) => a.name === "my-agent");
		expect(mine?.source).toBe("library");
		expect(lib?.["applied"]).toEqual([]);
	});

	it("includes bundled defaults in the library listing", async () => {
		const deps = makeDeps();
		await handleListAgentLibrary(deps, "c1", {});
		const agents = sent(deps, "agent_library")?.["agents"] as Array<{
			name: string;
			source: string;
		}>;
		const reviewer = agents.find((a) => a.name === "reviewer");
		expect(reviewer?.source).toBe("default");
	});

	it("exports and re-imports a bundle", async () => {
		const deps = makeDeps();
		await handleSaveAgent(deps, "c1", {
			name: "portable",
			definition: { prompt: "take me with you" },
		});
		await handleExportAgents(deps, "c1", {});
		const exported = sent(deps, "agent_export")?.["bundle"] as {
			agents: Array<{ name: string }>;
		};
		expect(exported.agents.map((a) => a.name)).toContain("portable");

		// Fresh config dir: the bundle travels between machines.
		const otherConfigDir = await mkdtemp(join(tmpdir(), "agent-lib-cfg2-"));
		const deps2 = makeDeps();
		(deps2.config as { configDir?: string }).configDir = otherConfigDir;
		try {
			await handleImportAgents(deps2, "c2", { bundle: exported });
			expect(sent(deps2, "agent_import_result")).toMatchObject({
				imported: ["portable"],
				skipped: [],
			});
		} finally {
			await rm(otherConfigDir, { recursive: true, force: true });
		}
	});

	it("applies a default agent to the project and removes it again", async () => {
		const deps = makeDeps();
		await handleApplyAgents(deps, "c1", { names: ["reviewer"] });
		expect(sent(deps, "agents_applied")).toMatchObject({ names: ["reviewer"] });

		const overlay = JSON.parse(
			await readFile(join(projectDir, ".opencode", "opencode.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(Object.keys(overlay["agent"] as object)).toEqual(["reviewer"]);

		await handleListAgentLibrary(deps, "c1", {});
		expect(sent(deps, "agent_library")?.["applied"]).toEqual(["reviewer"]);

		await handleRemoveAppliedAgents(deps, "c1", { names: ["reviewer"] });
		expect(sent(deps, "agents_removed")).toMatchObject({
			removed: ["reviewer"],
		});
	});

	it("rejects applying an unknown agent", async () => {
		const deps = makeDeps();
		await expect(
			handleApplyAgents(deps, "c1", { names: ["nope"] }),
		).rejects.toThrow(/unknown agent/);
	});

	it("deletes a library agent without touching defaults", async () => {
		const deps = makeDeps();
		await handleSaveAgent(deps, "c1", {
			name: "gone",
			definition: { prompt: "x" },
		});
		await handleDeleteAgent(deps, "c1", { name: "gone" });
		expect(sent(deps, "agent_deleted")).toMatchObject({
			name: "gone",
			deleted: true,
		});

		await handleListAgentLibrary(deps, "c1", {});
		const agents = sent(deps, "agent_library")?.["agents"] as Array<{
			name: string;
		}>;
		expect(agents.map((a) => a.name)).not.toContain("gone");
	});
});
