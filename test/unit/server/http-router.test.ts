// ─── HTTP Router Tests ───────────────────────────────────────────────────────
// Tests for the RequestRouter class extracted from server.ts and daemon.ts.

import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthManager } from "../../../src/lib/auth.js";
import { ChatSearch } from "../../../src/lib/chat/search.js";
import { ChatService } from "../../../src/lib/chat/service.js";
import {
	MIME_TYPES,
	RequestRouter,
	type RequestRouterDeps,
	type RouterProject,
} from "../../../src/lib/server/http-router.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

// Shared temp static directory with index.html for SPA-shell-serving tests.
// Without this, tests fall back to dist/frontend/ which only exists after a build,
// causing failures in CI where tests run before the build step.
const sharedStaticDir = mkdtempSync(join(tmpdir(), "router-static-"));
writeFileSync(
	join(sharedStaticDir, "index.html"),
	"<!DOCTYPE html><html><body>Conduit</body></html>",
	"utf-8",
);

let nextPort = 18000;
function getPort(): number {
	return nextPort++;
}

/** Create a real HTTP server backed by a RequestRouter for integration testing. */
function createTestServer(overrides: Partial<RequestRouterDeps> = {}): {
	server: Server;
	router: RequestRouter;
	port: number;
	start: () => Promise<void>;
	stop: () => Promise<void>;
	url: (path: string) => string;
} {
	const port = getPort();
	const staticDir =
		overrides.staticDir ?? join(process.cwd(), "dist", "frontend");
	const auth = overrides.auth ?? new AuthManager();
	const projects: RouterProject[] = [];

	const deps: RequestRouterDeps = {
		auth,
		...(overrides.chat && { chat: overrides.chat }),
		staticDir,
		getProjects: overrides.getProjects ?? (() => projects),
		port,
		isTls: overrides.isTls ?? false,
		...(overrides.pushManager != null && {
			pushManager: overrides.pushManager,
		}),
		...(overrides.authExemptPaths != null && {
			authExemptPaths: overrides.authExemptPaths,
		}),
		...(overrides.getHealthResponse != null && {
			getHealthResponse: overrides.getHealthResponse,
		}),
		...(overrides.onProjectApiRequest != null && {
			onProjectApiRequest: overrides.onProjectApiRequest,
		}),
		...(overrides.caRootPath != null && {
			caRootPath: overrides.caRootPath,
		}),
	};

	const router = new RequestRouter(deps);
	const server = createServer((req, res) => {
		router.handleRequest(req, res).catch((err) => {
			console.error("[test] Request error:", err);
			if (!res.headersSent) {
				res.writeHead(500);
				res.end("Internal Server Error");
			}
		});
	});

	return {
		server,
		router,
		port,
		start: () =>
			new Promise<void>((resolve, reject) => {
				server.on("error", reject);
				server.listen(port, "127.0.0.1", () => resolve());
			}),
		stop: () =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
			}),
		url: (path: string) => `http://127.0.0.1:${port}${path}`,
	};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MIME_TYPES", () => {
	it("exports a complete map with all required extensions", () => {
		const required = [
			".html",
			".css",
			".js",
			".mjs",
			".json",
			".png",
			".jpg",
			".jpeg",
			".gif",
			".svg",
			".ico",
			".woff",
			".woff2",
			".ttf",
			".webp",
			".webmanifest",
			".map",
		];
		for (const ext of required) {
			expect(MIME_TYPES[ext]).toBeDefined();
			expect(typeof MIME_TYPES[ext]).toBe("string");
		}
	});

	it("has correct content types for key extensions", () => {
		expect(MIME_TYPES[".html"]).toBe("text/html; charset=utf-8");
		expect(MIME_TYPES[".json"]).toBe("application/json");
		expect(MIME_TYPES[".js"]).toBe("application/javascript; charset=utf-8");
		expect(MIME_TYPES[".svg"]).toBe("image/svg+xml");
		expect(MIME_TYPES[".webmanifest"]).toBe("application/manifest+json");
	});
});

describe("RequestRouter", () => {
	let testServer: ReturnType<typeof createTestServer>;

	afterEach(async () => {
		if (testServer) {
			await testServer.stop();
		}
	});

	// ─── CORS ────────────────────────────────────────────────────────────

	describe("CORS headers", () => {
		it("OPTIONS returns 204 with CORS headers", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/health"), {
				method: "OPTIONS",
			});
			expect(res.status).toBe(204);
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(res.headers.get("access-control-allow-methods")).toContain("GET");
			expect(res.headers.get("access-control-allow-headers")).toContain(
				"X-Relay-Pin",
			);
		});

		it("all responses include CORS headers", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/health"));
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
			expect(res.headers.get("access-control-allow-methods")).toContain("GET");
		});
	});

	// ─── Info endpoint ───────────────────────────────────────────────────

	describe("/info endpoint", () => {
		it("returns version JSON", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/info"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { version: string };
			expect(body.version).toBeDefined();
			expect(typeof body.version).toBe("string");
		});

		it("has CORS headers", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/info"));
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
		});
	});

	// ─── Health endpoint ─────────────────────────────────────────────────

	describe("/health endpoint", () => {
		it("returns default health response", async () => {
			const projects: RouterProject[] = [
				{ slug: "a", directory: "/tmp/a", title: "A" },
				{ slug: "b", directory: "/tmp/b", title: "B" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/health"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				ok: boolean;
				projects: number;
				uptime: number;
			};
			expect(body.ok).toBe(true);
			expect(body.projects).toBe(2);
			expect(typeof body.uptime).toBe("number");
		});

		it("/api/status also returns health response", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean };
			expect(body.ok).toBe(true);
		});

		it("uses custom getHealthResponse when provided", async () => {
			testServer = createTestServer({
				getHealthResponse: () => ({
					ok: true,
					custom: "status",
					projectCount: 42,
				}),
			});
			await testServer.start();

			const res = await fetch(testServer.url("/health"));
			const body = (await res.json()) as {
				ok: boolean;
				custom: string;
				projectCount: number;
			};
			expect(body.custom).toBe("status");
			expect(body.projectCount).toBe(42);
		});
	});

	// ─── Projects API ────────────────────────────────────────────────────

	describe("/api/projects", () => {
		it("returns empty project list", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				projects: unknown[];
				version: string;
			};
			expect(body.projects).toEqual([]);
			expect(typeof body.version).toBe("string");
		});

		it("includes error field for error-state projects", async () => {
			const projects: RouterProject[] = [
				{
					slug: "broken",
					directory: "/tmp/broken",
					title: "Broken",
					status: "error",
					error: "Connection refused",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: { slug: string; error?: string }[];
			};
			expect(body.projects[0]?.error).toBe("Connection refused");
		});

		it("includes status field in response", async () => {
			const projects: RouterProject[] = [
				{
					slug: "starting",
					directory: "/tmp/starting",
					title: "Starting",
					status: "registering",
				},
				{
					slug: "live",
					directory: "/tmp/live",
					title: "Live",
					status: "ready",
					clients: 2,
					sessions: 5,
					isProcessing: true,
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: Array<{
					slug: string;
					status: string;
					sessions: number;
					clients: number;
					isProcessing: boolean;
				}>;
			};
			const starting = body.projects.find((p) => p.slug === "starting");
			const live = body.projects.find((p) => p.slug === "live");
			expect(starting?.status).toBe("registering");
			expect(live?.status).toBe("ready");
			expect(live?.sessions).toBe(5);
			expect(live?.clients).toBe(2);
			expect(live?.isProcessing).toBe(true);
		});

		it("defaults status to ready when not provided", async () => {
			const projects: RouterProject[] = [
				{ slug: "legacy", directory: "/tmp/legacy", title: "Legacy" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: Array<{ slug: string; status: string }>;
			};
			expect(body.projects[0]?.status).toBe("ready");
		});

		it("returns registered projects", async () => {
			const projects: RouterProject[] = [
				{ slug: "app-1", directory: "/tmp/app-1", title: "App 1" },
				{ slug: "app-2", directory: "/tmp/app-2", title: "App 2" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			const body = (await res.json()) as {
				projects: { slug: string; title?: string }[];
			};
			expect(body.projects.length).toBe(2);
			expect(body.projects.map((p) => p.slug)).toContain("app-1");
			expect(body.projects.map((p) => p.slug)).toContain("app-2");
		});
	});

	// ─── Project routes ──────────────────────────────────────────────────

	describe("Project routes /p/{slug}/...", () => {
		it("returns 404 JSON for unknown slugs", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/p/nonexistent/"));
			expect(res.status).toBe(404);
			const body = (await res.json()) as {
				error: { code: string; message: string };
			};
			expect(body.error.code).toBe("NOT_FOUND");
			expect(body.error.message).toContain("nonexistent");
		});
	});

	// ─── Per-project status API ─────────────────────────────────────────

	describe("/p/:slug/api/status", () => {
		it("returns ready status for a ready project", async () => {
			const projects: RouterProject[] = [
				{
					slug: "my-app",
					directory: "/tmp/my-app",
					title: "My App",
					status: "ready",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/my-app/api/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { status: string; error?: string };
			expect(body.status).toBe("ready");
			expect(body.error).toBeUndefined();
		});

		it("returns registering status", async () => {
			const projects: RouterProject[] = [
				{
					slug: "starting",
					directory: "/tmp/starting",
					title: "Starting",
					status: "registering",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/starting/api/status"));
			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("registering");
		});

		it("returns error status with error message", async () => {
			const projects: RouterProject[] = [
				{
					slug: "broken",
					directory: "/tmp/broken",
					title: "Broken",
					status: "error",
					error: "Connection refused",
				},
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/broken/api/status"));
			const body = (await res.json()) as { status: string; error?: string };
			expect(body.status).toBe("error");
			expect(body.error).toBe("Connection refused");
		});

		it("returns 404 for unknown slug", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/p/ghost/api/status"));
			expect(res.status).toBe(404);
		});

		it("returns JSON 401 when PIN set and unauthenticated", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({
				auth,
				getProjects: () => [
					{
						slug: "secure",
						directory: "/tmp/secure",
						title: "Secure",
						status: "ready",
					},
				],
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/secure/api/status"));
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("AUTH_REQUIRED");
		});

		it("defaults status to ready when project has no status field", async () => {
			const projects: RouterProject[] = [
				{ slug: "legacy", directory: "/tmp/legacy", title: "Legacy" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/p/legacy/api/status"));
			const body = (await res.json()) as { status: string };
			expect(body.status).toBe("ready");
		});
	});

	// ─── Root routing ────────────────────────────────────────────────────

	describe("Root routing", () => {
		it("single project → redirect to /p/{slug}/", async () => {
			const projects: RouterProject[] = [
				{ slug: "my-app", directory: "/tmp/my-app", title: "My App" },
			];
			testServer = createTestServer({
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/"), {
				redirect: "manual",
			});
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/p/my-app/");
		});

		it("no projects → serves SPA shell", async () => {
			testServer = createTestServer({ staticDir: sharedStaticDir });
			await testServer.start();

			const res = await fetch(testServer.url("/"));
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("<!DOCTYPE html>");
		});
	});

	// ─── Auth gate ───────────────────────────────────────────────────────

	describe("Auth gate", () => {
		it("redirects browser routes to /auth when PIN is set", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			const projects: RouterProject[] = [
				{ slug: "proj", directory: "/tmp/proj", title: "Proj" },
			];
			testServer = createTestServer({
				auth,
				getProjects: () => projects,
			});
			await testServer.start();

			const res = await fetch(testServer.url("/"), {
				redirect: "manual",
			});
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/auth");
		});

		it("returns JSON 401 for API routes when not authenticated", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/api/projects"));
			expect(res.status).toBe(401);
			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("AUTH_REQUIRED");
		});

		it("exempts paths in authExemptPaths", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({
				auth,
				authExemptPaths: ["/health", "/setup"],
			});
			await testServer.start();

			// /health should be accessible without auth
			const res = await fetch(testServer.url("/health"));
			expect(res.status).toBe(200);
		});

		it("exempts /api/setup-info when in authExemptPaths", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({
				auth,
				authExemptPaths: ["/setup", "/api/setup-info"],
			});
			await testServer.start();

			// /api/setup-info should be accessible without auth
			const res = await fetch(testServer.url("/api/setup-info"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as { hasCert: boolean };
			expect(body).toHaveProperty("hasCert");
		});
	});

	// ─── Setup info ──────────────────────────────────────────────────────

	describe("/api/setup-info", () => {
		it("returns setup configuration JSON", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/setup-info"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				httpsUrl: string;
				httpUrl: string;
				hasCert: boolean;
				lanMode: boolean;
			};
			expect(body.httpsUrl).toContain("https://");
			expect(body.httpUrl).toContain("http://");
			expect(body.hasCert).toBe(false);
			expect(body.lanMode).toBe(false);
		});
	});

	// ─── Auth endpoint ───────────────────────────────────────────────────

	describe("POST /auth", () => {
		it("correct PIN returns cookie", async () => {
			const auth = new AuthManager();
			auth.setPin("5678");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/auth"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "5678" }),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean };
			expect(body.ok).toBe(true);
			expect(res.headers.get("set-cookie")).toBeTruthy();
		});

		it("wrong PIN returns 401", async () => {
			const auth = new AuthManager();
			auth.setPin("5678");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/auth"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "0000" }),
			});
			expect(res.status).toBe(401);
		});

		it("invalid JSON returns 400", async () => {
			const auth = new AuthManager();
			auth.setPin("5678");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/auth"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "not json{{{",
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("BAD_REQUEST");
		});
	});

	// ─── Static file serving ─────────────────────────────────────────────

	describe("Static file serving", () => {
		let tmpDir: string;

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "router-static-"));
			writeFileSync(
				join(tmpDir, "index.html"),
				"<!DOCTYPE html><html><body>Test App</body></html>",
			);
			writeFileSync(join(tmpDir, "style.css"), "body { color: red; }");
		});

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true });
		});

		it("serves static files with correct MIME types", async () => {
			testServer = createTestServer({ staticDir: tmpDir });
			await testServer.start();

			const res = await fetch(testServer.url("/style.css"));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("text/css; charset=utf-8");
			const body = await res.text();
			expect(body).toContain("body { color: red; }");
		});

		it("SPA fallback serves index.html for unknown paths", async () => {
			testServer = createTestServer({ staticDir: tmpDir });
			await testServer.start();

			const res = await fetch(testServer.url("/some/unknown/path"));
			expect(res.status).toBe(200);
			const body = await res.text();
			expect(body).toContain("Test App");
		});

		it("returns 404 when no index.html exists", async () => {
			const emptyDir = mkdtempSync(join(tmpdir(), "router-empty-"));
			testServer = createTestServer({ staticDir: emptyDir });
			await testServer.start();

			const res = await fetch(testServer.url("/nonexistent.js"));
			expect(res.status).toBe(404);

			rmSync(emptyDir, { recursive: true, force: true });
		});

		it("uses immutable cache for hash-named assets", async () => {
			writeFileSync(join(tmpDir, "app.a1b2c3d4.js"), "console.log('hello');");
			testServer = createTestServer({ staticDir: tmpDir });
			await testServer.start();

			const res = await fetch(testServer.url("/app.a1b2c3d4.js"));
			expect(res.status).toBe(200);
			expect(res.headers.get("cache-control")).toContain("immutable");
		});
	});

	// ─── Theme list API ─────────────────────────────────────────────────

	describe("/api/themes", () => {
		it("returns bundled themes as JSON", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/themes"));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("application/json");

			const body = (await res.json()) as {
				bundled: Record<string, { name: string; variant: string }>;
				custom: Record<string, unknown>;
			};
			expect(body.bundled).toBeDefined();
			expect(body.custom).toBeDefined();
			// At least 22 bundled themes
			expect(Object.keys(body.bundled).length).toBeGreaterThanOrEqual(22);
			// Spot-check a known theme
			expect(body.bundled["claude"]).toBeDefined();
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(body.bundled["claude"]!.name).toBe("Claude Dark");
			// biome-ignore lint/style/noNonNullAssertion: safe — guarded by prior assertion
			expect(body.bundled["claude"]!.variant).toBe("dark");
		});

		it("includes CORS headers", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/themes"));
			expect(res.headers.get("access-control-allow-origin")).toBe("*");
		});
	});

	// ─── CA download ─────────────────────────────────────────────────────

	describe("/ca/download", () => {
		it("returns 404 when no caRootPath is configured", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/ca/download"));
			expect(res.status).toBe(404);
			const body = (await res.json()) as {
				error: { code: string };
			};
			expect(body.error.code).toBe("NOT_FOUND");
		});

		it("serves PEM file when caRootPath is set", async () => {
			const tmpDir = mkdtempSync(join(tmpdir(), "router-ca-"));
			const caPath = join(tmpDir, "ca.pem");
			writeFileSync(
				caPath,
				"-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n",
			);
			testServer = createTestServer({ caRootPath: caPath });
			await testServer.start();

			const res = await fetch(testServer.url("/ca/download"));
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toBe("application/x-pem-file");
			const body = await res.text();
			expect(body).toContain("-----BEGIN CERTIFICATE-----");

			rmSync(tmpDir, { recursive: true, force: true });
		});
	});

	// ─── checkAuth (public method) ───────────────────────────────────────

	describe("checkAuth", () => {
		it("returns true when no PIN is set (auth.hasPin false)", async () => {
			const auth = new AuthManager();
			testServer = createTestServer({ auth });
			await testServer.start();

			// Authenticate and get cookie
			const res = await fetch(testServer.url("/auth"), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pin: "" }),
			});
			expect(res.status).toBe(200);
			const setCookie = res.headers.get("set-cookie");
			expect(setCookie).toBeTruthy();
		});
	});

	// ─── Auth status API ─────────────────────────────────────────────────

	describe("/api/auth/status", () => {
		it("returns hasPin=false and authenticated=true when no PIN set", async () => {
			testServer = createTestServer();
			await testServer.start();

			const res = await fetch(testServer.url("/api/auth/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				hasPin: boolean;
				authenticated: boolean;
			};
			expect(body.hasPin).toBe(false);
			expect(body.authenticated).toBe(true);
		});

		it("returns hasPin=true and authenticated=false when PIN set and no cookie", async () => {
			const auth = new AuthManager();
			auth.setPin("1234");
			testServer = createTestServer({ auth });
			await testServer.start();

			const res = await fetch(testServer.url("/api/auth/status"));
			expect(res.status).toBe(200);
			const body = (await res.json()) as {
				hasPin: boolean;
				authenticated: boolean;
			};
			expect(body.hasPin).toBe(true);
			expect(body.authenticated).toBe(false);
		});
	});
});

describe("projectless Chat", () => {
	it("requires auth and a same-origin mutation header, and exposes no Code actions", async () => {
		const directory = mkdtempSync(join(tmpdir(), "conduit-chat-"));
		const inputs: string[] = [];
		const generate = async (input: string) => {
			inputs.push(input);
			return "Test reply";
		};
		const chatDirectory = join(directory, "chat");
		const chat = new ChatService(chatDirectory, generate);
		const auth = new AuthManager({ statePath: join(directory, "auth.json") });
		auth.setPin("123456");
		const app = createTestServer({ chat, auth, staticDir: sharedStaticDir });
		await app.start();
		try {
			const request = (path: string, init?: RequestInit) =>
				fetch(app.url(path), init);
			const post = (body: unknown, includeHeader = true): RequestInit => ({
				method: "POST",
				body: JSON.stringify(body),
				headers: {
					"Content-Type": "application/json",
					"X-Relay-Pin": "123456",
					...(includeHeader && { "X-Conduit-Chat": "1" }),
				},
			});
			expect((await request("/api/chat")).status).toBe(401);
			expect((await request("/api/chat", post({}, false))).status).toBe(403);
			expect((await request("/api/chat/terminal", post({}))).status).toBe(404);
			expect(
				(
					await request(
						"/api/chat/ffffffff-ffff-ffff-ffff-ffffffffffff",
						post({ text: "Unknown ID" }),
					)
				).status,
			).toBe(404);
			expect(inputs).toEqual([]);

			const first = await request("/api/chat", post({ temporary: false }));
			expect(first.status).toBe(201);
			expect(first.headers.get("Access-Control-Allow-Origin")).toBeNull();
			expect(first.headers.get("Cache-Control")).toBe("no-store");
			const persisted = await first.json();
			const path = `/api/chat/${persisted.id}`;
			expect(
				(await request(path, post({ text: "No tools", tools: ["shell"] })))
					.status,
			).toBe(400);
			expect(
				(
					await request(
						path,
						post({
							text: "Use attachment",
							attachments: [{ name: "note.txt", text: "test context" }],
						}),
					)
				).status,
			).toBe(200);
			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toContain("test context");
			const temp = await (
				await request("/api/chat", post({ temporary: true }))
			).json();
			expect(
				(await request(`/api/chat/${temp.id}`, post({ text: "Transient" })))
					.status,
			).toBe(200);

			const restarted = new ChatService(chatDirectory, generate);
			expect((await restarted.list()).map((summary) => summary.id)).toEqual([
				persisted.id,
			]);
			expect((await restarted.get(persisted.id)).messages.at(-1)?.text).toBe(
				"Test reply",
			);
			await expect(restarted.get(temp.id)).rejects.toMatchObject({
				status: 404,
			});
			expect(readdirSync(chatDirectory)).toEqual([`${persisted.id}.json`]);
			expect(
				statSync(join(chatDirectory, `${persisted.id}.json`)).mode & 0o777,
			).toBe(0o600);
		} finally {
			await app.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("Chat private search", () => {
	it("isolates reviewed queries and attaches source context only on an explicit send", async () => {
		const directory = mkdtempSync(join(tmpdir(), "conduit-search-"));
		const lookup = vi.fn(async (_query: string) => [
			{
				title: "Source",
				url: "https://example.org/",
				snippet: "Indexed snippet",
			},
		]);
		const read = vi.fn(async (_url: string) => "Page excerpt");
		const generate = vi.fn(async (_prompt: string) => "Reply");
		const chat = new ChatService(
			directory,
			generate,
			new ChatSearch(lookup, read),
		);
		const app = createTestServer({ chat });
		await app.start();
		try {
			const post = (path: string, data: unknown) =>
				fetch(app.url(path), {
					method: "POST",
					headers: {
						"X-Conduit-Chat": "1",
						"Content-Type": "application/json",
					},
					body: JSON.stringify(data),
				});
			const current = `/api/chat/${(await chat.create(true)).id}`;
			const other = `/api/chat/${(await chat.create(true)).id}`;
			expect(
				(
					await post(`${current}/search`, {
						query: "public topic",
						text: "private draft",
					})
				).status,
			).toBe(400);
			expect(lookup).not.toHaveBeenCalled();

			const response = await post(`${current}/search`, {
				query: "public topic",
			});
			expect(response.status).toBe(200);
			expect(lookup).toHaveBeenCalledExactlyOnceWith("public topic");
			expect(generate).not.toHaveBeenCalled();
			const result = await response.json();
			expect(
				(await post(`${other}/search/read`, { searchId: result.id, index: 0 }))
					.status,
			).toBe(409);
			expect(
				(await post(`${current}/search/read`, { url: "https://example.org/" }))
					.status,
			).toBe(400);
			expect(read).not.toHaveBeenCalled();
			expect(
				(
					await post(`${current}/search/read`, {
						searchId: result.id,
						index: 0,
					})
				).status,
			).toBe(200);
			expect(read).toHaveBeenCalledExactlyOnceWith("https://example.org/");

			expect((await post(current, { text: "ordinary question" })).status).toBe(
				200,
			);
			expect(generate.mock.calls[0]?.[0]).not.toContain("Indexed snippet");
			expect(
				(await post(other, { text: "cross-chat", searchId: result.id })).status,
			).toBe(409);
			expect(
				(await post(current, { text: "use sources", searchId: result.id }))
					.status,
			).toBe(200);
			expect(generate.mock.calls[1]?.[0]).toContain("Page excerpt");
			expect(
				(await post(current, { text: "reuse sources", searchId: result.id }))
					.status,
			).toBe(409);

			lookup.mockRejectedValueOnce(new Error("test tunnel failure"));
			expect(
				(await post(`${other}/search`, { query: "another query" })).status,
			).toBe(503);
			expect(
				(await post(other, { text: "ordinary chat after outage" })).status,
			).toBe(200);
		} finally {
			await app.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("durable Chat turns and inbox", () => {
	it("accepts a turn once, reports partial text, and stops without replacing history", async () => {
		const directory = mkdtempSync(join(tmpdir(), "conduit-chat-turn-"));
		const generate = vi.fn(
			async (
				_input: string,
				signal: AbortSignal,
				onText: (text: string) => void,
			) => {
				onText("Visible partial reply");
				return new Promise<string>((_, reject) =>
					signal.addEventListener("abort", () => reject(new Error("Stopped")), {
						once: true,
					}),
				);
			},
		);
		const chat = new ChatService(directory, generate);
		const app = createTestServer({ chat });
		await app.start();
		try {
			const item = await chat.create(false);
			const root = `/api/chat/${item.id}`;
			const post = (path: string, body: unknown) =>
				fetch(app.url(path), {
					method: "POST",
					headers: {
						"X-Conduit-Chat": "1",
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
			const requestId = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
			const accepted = await post(`${root}/turns`, {
				requestId,
				text: "Recoverable prompt",
			});
			expect(accepted.status).toBe(202);
			expect((await accepted.json()).turn.id).toBe(requestId);
			await post(`${root}/turns`, { requestId, text: "Recoverable prompt" });
			expect(generate).toHaveBeenCalledTimes(1);
			const progress = await (await fetch(app.url(root))).json();
			expect(progress.turn).toMatchObject({
				status: "running",
				reply: "Visible partial reply",
			});

			const status = await (await fetch(app.url(`${root}/turns`))).json();
			expect(status).toEqual({
				running: { id: requestId, reply: "Visible partial reply" },
			});

			const restarted = new ChatService(directory, generate);
			expect((await restarted.get(item.id)).turn?.status).toBe("failed");
			const stopped = await (
				await post(`${root}/turns/stop`, { requestId })
			).json();
			expect(stopped.messages).toEqual([]);
			expect(stopped.turn).toMatchObject({
				status: "stopped",
				reply: "Visible partial reply",
			});
			expect((await restarted.get(item.id)).turn?.status).toBe("stopped");
		} finally {
			await app.stop();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("supports inbox metadata and branching without losing the original on a failed edit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "conduit-chat-history-"));
		const generate = vi.fn(async () => "A distinctive answer.");
		const chat = new ChatService(directory, generate);
		try {
			const parent = await chat.create(false);
			const temporary = await chat.create(true);
			await chat.send(parent.id, "Original prompt");
			const pinned = await chat.editMetadata(parent.id, {
				title: "Project notes",
				pinned: true,
				archived: true,
			});
			expect(pinned).toMatchObject({
				title: "Project notes",
				pinned: true,
				archived: true,
			});
			expect(await chat.list("distinctive")).toEqual([
				expect.objectContaining({ id: parent.id, archived: true }),
			]);
			expect(await chat.list("missing")).toEqual([]);
			const branch = await chat.create(false, { id: parent.id, through: 2 });
			expect(branch.messages).toEqual(pinned.messages);
			expect(branch.title).toBe("Branch of Project notes");
			await expect(
				chat.create(false, { id: temporary.id, through: 1 }),
			).rejects.toMatchObject({ status: 400 });

			generate.mockRejectedValueOnce(new Error("provider unavailable"));
			await chat.startTurn(parent.id, {
				requestId: "aaaabbbb-cccc-4444-eeee-ffffffffffff",
				text: "Revised prompt",
				editFrom: 0,
			});
			await vi.waitFor(async () => {
				const result = await chat.get(parent.id);
				expect(result.messages).toEqual(pinned.messages);
				expect(result.turn).toMatchObject({ status: "failed" });
			});
			await chat.startTurn(parent.id, {
				requestId: "aaaabbbb-cccc-4444-eeee-eeeeeeeeeeee",
				retry: true,
			});
			await vi.waitFor(async () => {
				const updated = await chat.get(parent.id);
				expect(updated.turn).toBeUndefined();
				expect(updated.messages[0]?.text).toBe("Revised prompt");
				expect(updated.title).toBe("Project notes");
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
