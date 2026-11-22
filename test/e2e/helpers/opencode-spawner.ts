import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/** Get a random available port. */
async function getEphemeralPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			if (addr && typeof addr === "object") {
				const port = addr.port;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("Failed to get ephemeral port")));
			}
		});
		srv.on("error", reject);
	});
}

/**
 * Wait for OpenCode to become healthy.
 *
 * v2 mounts the JSON API under `/api` and — unlike v1 — treats an empty
 * `OPENCODE_SERVER_PASSWORD` as "generate a random password" rather than "no
 * auth". We therefore always set a known password and probe the authenticated
 * `/api/location` endpoint.
 */
async function waitForHealth(
	port: number,
	password: string,
	timeoutMs = 30_000,
): Promise<void> {
	const start = Date.now();
	const auth = Buffer.from(`opencode:${password}`).toString("base64");
	while (Date.now() - start < timeoutMs) {
		try {
			const res = await fetch(`http://localhost:${port}/api/location`, {
				headers: { Authorization: `Basic ${auth}` },
			});
			if (res.ok) return;
		} catch {
			// Not ready yet
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(
		`OpenCode did not become healthy on port ${port} within ${timeoutMs}ms`,
	);
}

export interface SpawnedOpenCode {
	port: number;
	url: string;
	/** Basic-auth password configured for the spawned server. */
	password: string;
	process: ChildProcess;
	tmpDir: string;
	/** Kill the process and clean up the temp directory. */
	stop(): void;
}

/**
 * Spawn an ephemeral OpenCode instance on a random port with an isolated
 * database directory. Call stop() to kill it and clean up.
 */
export async function spawnOpenCode(opts?: {
	timeoutMs?: number;
	env?: Record<string, string>;
}): Promise<SpawnedOpenCode> {
	const port = await getEphemeralPort();
	const tmpDir = mkdtempSync(path.join(tmpdir(), "opencode-e2e-"));
	const password = `conduit-test-${randomBytes(12).toString("hex")}`;

	// Expose the password to in-process consumers (relay clients, harnesses)
	// that read OPENCODE_SERVER_PASSWORD when constructing their client.
	process.env["OPENCODE_SERVER_PASSWORD"] = password;

	const proc = spawn("opencode", ["serve", "--port", String(port)], {
		env: {
			...process.env,
			XDG_DATA_HOME: tmpDir,
			// Isolate config so the ephemeral instance doesn't read the
			// user's ~/.config/opencode/ (which may set auth, providers, etc.)
			XDG_CONFIG_HOME: path.join(tmpDir, "config"),
			// v2 always authenticates; an empty password generates a random
			// one that callers cannot know. Set a known password instead.
			OPENCODE_SERVER_PASSWORD: password,
			...opts?.env,
		},
		stdio: "pipe",
		detached: false,
	});

	// Propagate spawn errors
	const spawnError = new Promise<never>((_, reject) => {
		proc.once("error", reject);
	});

	try {
		await Promise.race([
			waitForHealth(port, password, opts?.timeoutMs ?? 30_000),
			spawnError,
		]);
	} catch (err) {
		proc.kill("SIGTERM");
		rmSync(tmpDir, { recursive: true, force: true });
		throw err;
	}

	return {
		port,
		url: `http://localhost:${port}`,
		password,
		process: proc,
		tmpDir,
		stop() {
			proc.removeAllListeners();
			proc.kill("SIGTERM");
			// Give it a moment to exit gracefully, then force
			setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}, 3000);
			try {
				rmSync(tmpDir, { recursive: true, force: true });
			} catch {}
		},
	};
}
