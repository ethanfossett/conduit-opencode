import { describe, expect, it, vi } from "vitest";
import {
	handleCancel,
	handleMessage,
	handleRunCommand,
} from "../../../src/lib/handlers/prompt.js";
import { withSubmissionReceipt } from "../../../src/lib/handlers/submission.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

describe("submission receipts", () => {
	it("joins concurrent duplicate submissions and returns the same receipt", async () => {
		const deps = createMockHandlerDeps();
		const send = vi.fn().mockResolvedValue(true);
		const payload = { requestId: "same-request", sessionId: "s1" };
		await Promise.all([
			withSubmissionReceipt(deps, "c1", payload, "message", send),
			withSubmissionReceipt(deps, "c2", payload, "message", send),
		]);
		expect(send).toHaveBeenCalledTimes(1);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"c2",
			expect.objectContaining({ accepted: true }),
		);
	});
	it("rejects reuse of a request ID for different content", async () => {
		const deps = createMockHandlerDeps();
		const send = vi.fn().mockResolvedValue(true);
		await withSubmissionReceipt(
			deps,
			"c1",
			{ requestId: "id", sessionId: "s1" },
			"message",
			send,
		);
		await withSubmissionReceipt(
			deps,
			"c1",
			{ requestId: "id", sessionId: "s2" },
			"message",
			send,
		);
		expect(send).toHaveBeenCalledTimes(1);
		expect(deps.wsHandler.sendTo).toHaveBeenLastCalledWith(
			"c1",
			expect.objectContaining({ accepted: false }),
		);
	});
	it("acknowledges upstream rejection without claiming acceptance", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("s1");
		vi.mocked(deps.client.sendMessageAsync).mockRejectedValue(
			new Error("unavailable"),
		);
		await handleMessage(deps, "c1", {
			text: "hello",
			sessionId: "s1",
			requestId: "reject",
		});
		expect(deps.wsHandler.sendTo).toHaveBeenLastCalledWith(
			"c1",
			expect.objectContaining({ type: "submission_result", accepted: false }),
		);
		expect(deps.messageCache.remove).toHaveBeenCalledWith("s1");
		expect(deps.pendingUserMessages.size).toBe(0);
	});
	it("does not send prepared messages or commands to a different active chat", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("s2");
		await handleMessage(deps, "c1", {
			text: "hello",
			sessionId: "s1",
			requestId: "stale",
		});
		deps.client.runCommand = vi.fn();
		await handleRunCommand(deps, "c1", {
			name: "test",
			sessionId: "s1",
			requestId: "stale-command",
		});
		expect(deps.client.sendMessageAsync).not.toHaveBeenCalled();
		expect(deps.client.runCommand).not.toHaveBeenCalled();
	});
	it("accepts attachment-only prompts", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("s1");
		await handleMessage(deps, "c1", {
			text: "",
			files: [{ uri: "data:text/plain;base64,aGk=", name: "hello.txt" }],
			requestId: "file",
		});
		expect(deps.client.sendMessageAsync).toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({ text: "", files: expect.any(Array) }),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenLastCalledWith(
			"c1",
			expect.objectContaining({ accepted: true }),
		);
	});
	it("does not announce a session stopped when abort fails", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("s1");
		vi.mocked(deps.client.abortSession).mockRejectedValue(new Error("offline"));
		await handleCancel(deps, "c1", {});
		expect(deps.wsHandler.sendToSession).not.toHaveBeenCalledWith(
			"s1",
			expect.objectContaining({ type: "done" }),
		);
		expect(deps.wsHandler.sendTo).toHaveBeenCalledWith(
			"c1",
			expect.objectContaining({ type: "error" }),
		);
	});
});
