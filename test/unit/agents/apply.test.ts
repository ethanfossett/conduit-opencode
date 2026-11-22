// ─── Project Apply/Remove Tests ──────────────────────────────────────────────
// Applying merges agents into <project>/.opencode/opencode.json and removing
// undoes exactly that, preserving every other overlay key.

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	applyAgentsToProject,
	listAppliedAgents,
	removeAgentsFromProject,
} from "../../../src/lib/agents/apply.js";

let projectDir: string;

async function readOverlay(): Promise<Record<string, unknown>> {
	const raw = await readFile(
		join(projectDir, ".opencode", "opencode.json"),
		"utf-8",
	);
	return JSON.parse(raw) as Record<string, unknown>;
}

beforeEach(async () => {
	projectDir = await mkdtemp(join(tmpdir(), "agent-apply-"));
});

afterEach(async () => {
	await rm(projectDir, { recursive: true, force: true });
});

describe("applyAgentsToProject", () => {
	it("creates the overlay when missing and lists applied agents", async () => {
		const applied = await applyAgentsToProject(projectDir, [
			{ name: "developer", definition: { mode: "primary", prompt: "x" } },
		]);
		expect(applied).toEqual(["developer"]);
		expect(await listAppliedAgents(projectDir)).toEqual(["developer"]);
		const overlay = await readOverlay();
		expect(overlay["agent"]).toEqual({
			developer: { mode: "primary", prompt: "x" },
		});
	});

	it("preserves unrelated overlay keys and other agents", async () => {
		await mkdir(join(projectDir, ".opencode"), { recursive: true });
		await writeFile(
			join(projectDir, ".opencode", "opencode.json"),
			JSON.stringify({
				model: "provider/model",
				agent: { existing: { prompt: "keep me" } },
			}),
		);

		await applyAgentsToProject(projectDir, [
			{ name: "reviewer", definition: { prompt: "review" } },
		]);

		const overlay = await readOverlay();
		expect(overlay["model"]).toBe("provider/model");
		expect(overlay["agent"]).toEqual({
			existing: { prompt: "keep me" },
			reviewer: { prompt: "review" },
		});
	});

	it("replaces an agent definition wholesale (no deep-merge leftovers)", async () => {
		await applyAgentsToProject(projectDir, [
			{ name: "developer", definition: { prompt: "old", model: "a/b" } },
		]);
		await applyAgentsToProject(projectDir, [
			{ name: "developer", definition: { prompt: "new" } },
		]);
		const overlay = await readOverlay();
		expect(overlay["agent"]).toEqual({ developer: { prompt: "new" } });
	});
});

describe("removeAgentsFromProject", () => {
	it("removes only the requested agents and reports what changed", async () => {
		await applyAgentsToProject(projectDir, [
			{ name: "a", definition: { prompt: "a" } },
			{ name: "b", definition: { prompt: "b" } },
		]);
		const removed = await removeAgentsFromProject(projectDir, ["a", "missing"]);
		expect(removed).toEqual(["a"]);
		expect(await listAppliedAgents(projectDir)).toEqual(["b"]);
	});

	it("drops the empty agent key when the last agent is removed", async () => {
		await applyAgentsToProject(projectDir, [
			{ name: "solo", definition: { prompt: "s" } },
		]);
		await removeAgentsFromProject(projectDir, ["solo"]);
		const overlay = await readOverlay();
		expect(overlay).not.toHaveProperty("agent");
	});

	it("is a no-op when there is nothing to remove", async () => {
		const removed = await removeAgentsFromProject(projectDir, ["ghost"]);
		expect(removed).toEqual([]);
	});
});
