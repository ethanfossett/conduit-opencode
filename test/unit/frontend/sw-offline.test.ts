// ─── Service Worker Offline Shell Tests ──────────────────────────────────────
// Offline navigation must render without previously cached JS/CSS or private HTML.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (event: unknown) => void;

let listeners: Record<string, Listener[]>;
let cacheAddMock: ReturnType<typeof vi.fn>;
let cacheMatchMock: ReturnType<typeof vi.fn>;
let cachesOpenMock: ReturnType<typeof vi.fn>;
let cachesKeysMock: ReturnType<typeof vi.fn>;
let cachesDeleteMock: ReturnType<typeof vi.fn>;
let skipWaitingMock: ReturnType<typeof vi.fn>;
let claimMock: ReturnType<typeof vi.fn>;

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function createLifecycleEvent() {
	const promises: Promise<unknown>[] = [];
	return {
		waitUntil: vi.fn((p: Promise<unknown>) => {
			promises.push(p);
		}),
		_promises: promises,
	};
}

function createFetchEvent(request: Record<string, unknown>) {
	let respondWithArg: Promise<unknown> | undefined;
	return {
		request,
		respondWith: vi.fn((p: Promise<unknown>) => {
			respondWithArg = p;
		}),
		get responded() {
			return respondWithArg;
		},
	};
}

function listener(type: string): Listener {
	const fn = listeners[type]?.[0];
	if (!fn) throw new Error(`${type} listener not registered`);
	return fn;
}

beforeEach(async () => {
	vi.resetModules();
	listeners = {};

	cacheAddMock = vi.fn().mockResolvedValue(undefined);
	cacheMatchMock = vi.fn().mockResolvedValue(new Response("shell"));
	cachesOpenMock = vi.fn().mockResolvedValue({ add: cacheAddMock });
	cachesKeysMock = vi.fn().mockResolvedValue(["conduit-shell-v1", "old-v0"]);
	cachesDeleteMock = vi.fn().mockResolvedValue(true);
	skipWaitingMock = vi.fn().mockResolvedValue(undefined);
	claimMock = vi.fn().mockResolvedValue(undefined);

	const swSelf = {
		addEventListener: vi.fn((type: string, handler: Listener) => {
			(listeners[type] ??= []).push(handler);
		}),
		skipWaiting: skipWaitingMock,
		clients: { claim: claimMock, matchAll: vi.fn(), openWindow: vi.fn() },
		registration: { showNotification: vi.fn(), scope: "/" },
		location: { origin: "http://localhost:2633" },
	};
	vi.stubGlobal("self", swSelf);
	vi.stubGlobal("caches", {
		open: cachesOpenMock,
		keys: cachesKeysMock,
		match: cacheMatchMock,
		delete: cachesDeleteMock,
	});

	await import("../../../src/lib/frontend/sw.js");
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("install", () => {
	it("activates without fetching or caching authenticated pages", async () => {
		const event = createLifecycleEvent();
		listener("install")(event);
		await Promise.all(event._promises);
		expect(cachesOpenMock).not.toHaveBeenCalled();
		expect(cacheAddMock).not.toHaveBeenCalled();
		expect(skipWaitingMock).toHaveBeenCalled();
	});
});

describe("activate", () => {
	it("removes obsolete Conduit shells and preserves unrelated caches", async () => {
		const event = createLifecycleEvent();
		listener("activate")(event);
		await Promise.all(event._promises);
		expect(cachesDeleteMock).not.toHaveBeenCalledWith("old-v0");
		expect(cachesDeleteMock).toHaveBeenCalledWith("conduit-shell-v1");
		expect(claimMock).toHaveBeenCalled();
	});
});

describe("fetch", () => {
	it("renders a standalone offline page even with an empty browser cache", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
		const event = createFetchEvent({
			method: "GET",
			url: "http://localhost:2633/p/my-project/",
			mode: "navigate",
		});
		listener("fetch")(event);
		expect(event.responded).toBeDefined();
		const response = await event.responded;
		await flush();
		expect(cacheMatchMock).not.toHaveBeenCalled();
		const html = await (response as Response).text();
		expect(html).toContain("Conduit is offline");
		expect(html).not.toMatch(/<script|<link|<img/);
		expect((response as Response).status).toBe(503);
	});

	it("passes through online navigations", async () => {
		const online = new Response("live");
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(online));
		const event = createFetchEvent({
			method: "GET",
			url: "http://localhost:2633/p/my-project/",
			mode: "navigate",
		});
		listener("fetch")(event);
		const response = await event.responded;
		expect(await (response as Response).text()).toBe("live");
		expect(cacheMatchMock).not.toHaveBeenCalled();
	});

	it("never intercepts API or static requests", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		for (const url of [
			"http://localhost:2633/api/session",
			"http://localhost:2633/static/manifest.webmanifest",
		]) {
			const event = createFetchEvent({ method: "GET", url, mode: "cors" });
			listener("fetch")(event);
			expect(event.respondWith).not.toHaveBeenCalled();
		}
	});

	it("ignores non-GET requests", () => {
		const event = createFetchEvent({
			method: "POST",
			url: "http://localhost:2633/p/x/",
			mode: "navigate",
		});
		listener("fetch")(event);
		expect(event.respondWith).not.toHaveBeenCalled();
	});
});
