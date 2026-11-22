// ─── SessionManager.searchSessionsPage ───────────────────────────────────────
// Server-side search (delegates to the v2 `search` param), cursor pass-through,
// and cancellation of superseded searches.

import { describe, expect, it, vi } from "vitest";
import type { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";
import {
	SearchCancelledError,
	SessionManager,
} from "../../../src/lib/session/session-manager.js";

function session(id: string, title: string) {
	return { id, title, time: { created: 1, updated: 2 } };
}

describe("SessionManager.searchSessionsPage", () => {
	it("passes the query as a server-side search and returns the cursor", async () => {
		const listSessionsPage = vi.fn().mockResolvedValue({
			sessions: [session("ses_1", "Match")],
			cursor: { previous: null, next: "cur-2" },
		});
		const mgr = new SessionManager({
			client: { listSessionsPage } as unknown as OpenCodeClient,
		});

		const page = await mgr.searchSessionsPage("query", {
			roots: true,
			limit: 10,
		});

		expect(listSessionsPage).toHaveBeenCalledWith(
			expect.objectContaining({ search: "query", roots: true, limit: 10 }),
		);
		expect(page.sessions.map((s) => s.id)).toEqual(["ses_1"]);
		expect(page.cursor.next).toBe("cur-2");
	});

	it("supersedes an in-flight search and rejects it with SearchCancelledError", async () => {
		let resolveSecond:
			| ((value: {
					sessions: ReturnType<typeof session>[];
					cursor: { previous: null; next: null };
			  }) => void)
			| undefined;
		const listSessionsPage = vi.fn(
			(opts: { signal?: AbortSignal; search?: string }) =>
				new Promise((resolve, reject) => {
					const signal = opts.signal;
					if (signal?.aborted) {
						reject(new Error("aborted"));
						return;
					}
					signal?.addEventListener("abort", () => reject(new Error("aborted")));
					if (opts.search === "second") {
						resolveSecond = resolve;
					}
				}),
		);
		const mgr = new SessionManager({
			client: { listSessionsPage } as unknown as OpenCodeClient,
		});

		const first = mgr.searchSessionsPage("first");
		const second = mgr.searchSessionsPage("second");

		await expect(first).rejects.toBeInstanceOf(SearchCancelledError);

		resolveSecond?.({
			sessions: [session("ses_2", "Second")],
			cursor: { previous: null, next: null },
		});
		await expect(second).resolves.toMatchObject({
			sessions: [expect.objectContaining({ id: "ses_2" })],
		});
	});
});
