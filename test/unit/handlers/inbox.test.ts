// ─── Session Inbox handlers (queue vs steer) ─────────────────────────────────

import { describe, expect, it, vi } from "vitest";
import {
	handleCancelInbox,
	handleListInbox,
	handleSetInboxDelivery,
	normalizeInboxItem,
} from "../../../src/lib/handlers/inbox.js";
import { createMockHandlerDeps } from "../../helpers/mock-factories.js";

const item = {
	id: "msg_1",
	sessionID: "session-1",
	time: { created: 1000 },
	type: "user",
	delivery: "queue" as const,
	payload: { text: "queued hello" },
};

describe("normalizeInboxItem", () => {
	it("maps a v2 inbox entry to the frontend shape", () => {
		expect(normalizeInboxItem(item)).toEqual({
			id: "msg_1",
			type: "user",
			delivery: "queue",
			text: "queued hello",
			createdAt: 1000,
		});
	});

	it("defaults unknown delivery to steer and missing text to empty", () => {
		const result = normalizeInboxItem({
			...item,
			delivery: "weird" as never,
			payload: {},
		});
		expect(result.delivery).toBe("steer");
		expect(result.text).toBe("");
	});
});

describe("handleListInbox", () => {
	it("lists the client session's inbox and replies with inbox_list", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		vi.mocked(deps.client.listSessionInbox).mockResolvedValue([item]);
		await handleListInbox(deps, "client-1", {});
		expect(deps.client.listSessionInbox).toHaveBeenCalledWith("session-1");
		expect(deps.wsHandler.sendToSession).toHaveBeenCalledWith(
			"session-1",
			expect.objectContaining({
				type: "inbox_list",
				sessionId: "session-1",
				items: [expect.objectContaining({ id: "msg_1" })],
			}),
		);
	});

	it("is a no-op without a resolvable session", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue(undefined);
		await handleListInbox(deps, "client-1", {});
		expect(deps.client.listSessionInbox).not.toHaveBeenCalled();
	});
});

describe("handleCancelInbox", () => {
	it("cancels the item then refreshes the inbox", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleCancelInbox(deps, "client-1", { inboxId: "msg_1" });
		expect(deps.client.cancelInboxItem).toHaveBeenCalledWith(
			"session-1",
			"msg_1",
		);
		expect(deps.client.listSessionInbox).toHaveBeenCalledWith("session-1");
	});
});

describe("handleSetInboxDelivery", () => {
	it("updates delivery to steer and refreshes", async () => {
		const deps = createMockHandlerDeps();
		vi.mocked(deps.wsHandler.getClientSession).mockReturnValue("session-1");
		await handleSetInboxDelivery(deps, "client-1", {
			inboxId: "msg_1",
			delivery: "steer",
		});
		expect(deps.client.updateInboxItem).toHaveBeenCalledWith(
			"session-1",
			"msg_1",
			"steer",
		);
		expect(deps.client.listSessionInbox).toHaveBeenCalled();
	});
});
