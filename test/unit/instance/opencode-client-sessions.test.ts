// ─── v2 session listing / search query surface ───────────────────────────────
// Locks in the exact query parameters conduit sends to v2's GET /api/session
// (limit, order, search, parentID, directory, project, subpath, cursor) and the
// opaque pagination cursor it reads back, plus abort-signal cancellation.

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeClient } from "../../../src/lib/instance/opencode-client.js";

function jsonResponse(body: unknown): Response {
	return {
		ok: true,
		status: 200,
		headers: { get: () => "application/json" },
		json: async () => body,
		text: async () => JSON.stringify(body),
	} as unknown as Response;
}

function makeClient() {
	return new OpenCodeClient({
		baseUrl: "http://oc.test",
		auth: { username: "u", password: "p" },
		retries: 0,
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("OpenCodeClient.listSessionsPage — query params", () => {
	it("forwards the full v2 query surface and reads the cursor", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			jsonResponse({
				data: [
					{
						id: "ses_1",
						projectID: "p",
						title: "One",
						time: { created: 1, updated: 2 },
					},
				],
				cursor: { previous: "cur-prev", next: "cur-next" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const page = await makeClient().listSessionsPage({
			limit: 5,
			order: "asc",
			search: "foo bar",
			parentID: "ses_parent",
			directory: "/tmp/dir",
			project: "prj",
			subpath: "sub/dir",
			cursor: "cur-in",
		});

		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toContain("/api/session?");
		expect(url).toContain("limit=5");
		expect(url).toContain("order=asc");
		expect(url).toContain("search=foo+bar");
		expect(url).toContain("parentID=ses_parent");
		expect(url).toContain("directory=%2Ftmp%2Fdir");
		expect(url).toContain("project=prj");
		expect(url).toContain("subpath=sub%2Fdir");
		expect(url).toContain("cursor=cur-in");
		expect(page.cursor).toEqual({ previous: "cur-prev", next: "cur-next" });
		expect(page.sessions[0]?.id).toBe("ses_1");
	});

	it("maps roots:true to parentID=null", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ data: [], cursor: {} }));
		vi.stubGlobal("fetch", fetchMock);

		await makeClient().listSessionsPage({ roots: true });
		expect(fetchMock.mock.calls[0]?.[0]).toContain("parentID=null");
	});

	it("prefers an explicit parentID over roots", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ data: [], cursor: {} }));
		vi.stubGlobal("fetch", fetchMock);

		await makeClient().listSessionsPage({ roots: true, parentID: "ses_child" });
		const url = fetchMock.mock.calls[0]?.[0] as string;
		expect(url).toContain("parentID=ses_child");
		expect(url).not.toContain("parentID=null");
	});

	it("omits the query string entirely when no options are given", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ data: [], cursor: {} }));
		vi.stubGlobal("fetch", fetchMock);

		await makeClient().listSessionsPage();
		expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/api\/session$/);
	});
});

describe("OpenCodeClient.writeFile", () => {
	it("POSTs raw content to the experimental fs write endpoint", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(jsonResponse({ data: { path: "src/a.ts" } }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await makeClient().writeFile("src/a.ts", "hello world");

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/api/experimental/fs/write?path=src%2Fa.ts");
		expect(init.method).toBe("POST");
		expect(init.body).toBe("hello world");
		expect(result.path).toBe("src/a.ts");
	});
});

describe("OpenCodeClient — abort signal", () => {
	it("rejects immediately without fetching when the signal is already aborted", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const controller = new AbortController();
		controller.abort();

		await expect(
			makeClient().listSessionsPage({ signal: controller.signal }),
		).rejects.toThrow(/abort/i);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
