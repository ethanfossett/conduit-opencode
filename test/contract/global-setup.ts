// ─── Contract Test Global Setup ────────────────────────────────────────────
// Spawns an ephemeral OpenCode instance on a random port so contract tests
// never hit the user's live instance at :4096.

import {
	type SpawnedOpenCode,
	spawnOpenCode,
} from "../e2e/helpers/opencode-spawner.js";

let instance: SpawnedOpenCode | undefined;

export async function setup(): Promise<void> {
	console.log("[contract] Starting ephemeral OpenCode instance...");
	instance = await spawnOpenCode({ timeoutMs: 60_000 });

	// Point contract test helpers at the ephemeral instance.
	// server-connection.ts reads OPENCODE_URL at import time;
	// setting it here (before forks) ensures workers inherit it.
	process.env["OPENCODE_URL"] = instance.url;

	// v2 always authenticates. Use the known password the spawner configured
	// so the contract helpers can send Basic auth headers.
	process.env["OPENCODE_SERVER_PASSWORD"] = instance.password;

	console.log(`[contract] OpenCode ready at ${instance.url}`);
}

export async function teardown(): Promise<void> {
	if (instance) {
		console.log("[contract] Stopping ephemeral OpenCode instance...");
		instance.stop();
		instance = undefined;
	}
}
