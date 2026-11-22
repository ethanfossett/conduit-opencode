// ─── Reference handler ───────────────────────────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import { handleGetReferences } from "../../../src/lib/handlers/reference.js";
import type { ReferenceInfo } from "../../../src/lib/shared-types.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

const REFERENCES: ReferenceInfo[] = [
	{
		name: "opencode",
		path: "/home/me/.cache/opencode/repos/opencode",
		description: "OpenCode docs",
		source: { type: "git", repository: "sst/opencode", branch: "main" },
	},
];

describe("handleGetReferences", () => {
	it("replies with reference_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listReferences).mockResolvedValue(REFERENCES);
		await handleGetReferences(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "reference_list",
			references: REFERENCES,
		});
	});

	it("degrades to an empty list on failure", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.client.listReferences).mockRejectedValue(new Error("boom"));
		await handleGetReferences(deps, "client-1", {});
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith("client-1", {
			type: "reference_list",
			references: [],
		});
	});
});
