import { expect, it } from "vitest";
import { createReplayHarness } from "../../e2e/helpers/e2e-harness.js";
import { TestWsClient } from "../helpers/test-ws-client.js";

it("reuses an upstream acceptance receipt across browser reconnects without resending the prompt", async () => {
	const harness = await createReplayHarness("chat-simple");
	const first = new TestWsClient(`ws://127.0.0.1:${harness.relayPort}/ws`);
	let second: TestWsClient | undefined;
	try {
		await first.waitForOpen();
		await first.waitForInitialState();
		const initial = await first.waitFor("session_switched");
		const sessionId = String(initial["id"]);
		const payload = {
			type: "message",
			sessionId,
			requestId: "reconnect-receipt",
			text: "Only submit this once",
		};
		first.send(payload);
		const accepted = await first.waitFor("submission_result");
		expect(accepted["accepted"]).toBe(true);
		await first.close();

		second = new TestWsClient(
			`ws://127.0.0.1:${harness.relayPort}/ws?session=${encodeURIComponent(sessionId)}`,
		);
		await second.waitForOpen();
		await second.waitForInitialState();
		second.send(payload);
		const replayed = await second.waitFor("submission_result");
		expect(replayed["accepted"]).toBe(true);
		expect(
			harness.mock.diagnostics.filter((entry) => entry.event === "prompt"),
		).toHaveLength(1);
	} finally {
		await first.close();
		await second?.close();
		await harness.stop();
	}
}, 10_000);
