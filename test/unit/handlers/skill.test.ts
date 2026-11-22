// ─── Skill handlers ──────────────────────────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import {
	handleActivateSkill,
	handleGetSkills,
} from "../../../src/lib/handlers/skill.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("handleGetSkills", () => {
	it("lists skills for the project directory and replies with skill_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listSkills).mockResolvedValue([
			{ id: "opencode", name: "OpenCode", description: "docs" },
		]);
		await handleGetSkills(deps, "client-1", {});
		expect(deps.client.listSkills).toHaveBeenCalledWith("/test/project");
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "skill_list",
			skills: [{ id: "opencode", name: "OpenCode", description: "docs" }],
		});
	});

	it("honours an explicit directory", async () => {
		const deps = createMockHandlerDeps();
		await handleGetSkills(deps, "client-1", { directory: "/other" });
		expect(deps.client.listSkills).toHaveBeenCalledWith("/other");
	});

	it("degrades to an empty list on failure", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listSkills).mockRejectedValue(new Error("boom"));
		await handleGetSkills(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "skill_list",
			skills: [],
		});
	});
});

describe("handleActivateSkill", () => {
	it("activates a skill for the client session and signals processing", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleActivateSkill(deps, "client-1", { skillId: "opencode" });
		expect(deps.client.activateSkill).toHaveBeenCalledWith(
			"session-1",
			"opencode",
			{},
		);
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith("session-1", {
			type: "status",
			status: "processing",
		});
	});

	it("passes an explicit resume flag through", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleActivateSkill(deps, "client-1", {
			skillId: "opencode",
			resume: false,
		});
		expect(deps.client.activateSkill).toHaveBeenCalledWith(
			"session-1",
			"opencode",
			{ resume: false },
		);
	});

	it("errors with NO_SESSION when no session is active", async () => {
		const deps = createMockHandlerDeps();
		await handleActivateSkill(deps, "client-1", { skillId: "opencode" });
		expect(deps.client.activateSkill).not.toHaveBeenCalled();
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({ type: "error", code: "NO_SESSION" }),
		);
	});

	it("clears processing and surfaces an error when activation fails", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		vi.mocked(deps.client.activateSkill).mockRejectedValue(new Error("nope"));
		await handleActivateSkill(deps, "client-1", { skillId: "opencode" });
		expect(deps.overrides.clearProcessingTimeout).toHaveBeenCalledWith(
			"session-1",
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"client-1",
			expect.objectContaining({
				type: "error",
				code: "SKILL_ACTIVATE_FAILED",
			}),
		);
	});
});
