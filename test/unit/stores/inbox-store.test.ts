// ─── Session Inbox Store ─────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	cancelInboxItem,
	clearInboxState,
	getQueuedItems,
	handleInboxList,
	inboxState,
	requestInbox,
	setInboxDelivery,
} from "../../../src/lib/frontend/stores/inbox.svelte.js";
import { sessionState } from "../../../src/lib/frontend/stores/session.svelte.js";

beforeEach(() => {
	clearInboxState();
	// Reset the viewed session.
	sessionState.currentId = null;
});

describe("handleInboxList", () => {
	it("stores items for the viewed session", () => {
		sessionState.currentId = "ses_1";
		handleInboxList({
			type: "inbox_list",
			sessionId: "ses_1",
			items: [{ id: "msg_1", type: "user", delivery: "queue", text: "hi" }],
		});
		expect(inboxState.sessionId).toBe("ses_1");
		expect(inboxState.items).toHaveLength(1);
	});

	it("ignores lists for other sessions", () => {
		sessionState.currentId = "ses_1";
		handleInboxList({
			type: "inbox_list",
			sessionId: "ses_2",
			items: [{ id: "msg_9", type: "user", delivery: "queue", text: "x" }],
		});
		expect(inboxState.items).toHaveLength(0);
	});
});

describe("getQueuedItems", () => {
	it("returns only delivery=queue items", () => {
		sessionState.currentId = "ses_1";
		handleInboxList({
			type: "inbox_list",
			sessionId: "ses_1",
			items: [
				{ id: "msg_1", type: "user", delivery: "queue", text: "a" },
				{ id: "msg_2", type: "user", delivery: "steer", text: "b" },
			],
		});
		expect(getQueuedItems().map((i) => i.id)).toEqual(["msg_1"]);
	});
});

describe("actions", () => {
	beforeEach(() => {
		sessionState.currentId = "ses_1";
		handleInboxList({
			type: "inbox_list",
			sessionId: "ses_1",
			items: [
				{ id: "msg_1", type: "user", delivery: "queue", text: "a" },
				{ id: "msg_2", type: "user", delivery: "queue", text: "b" },
			],
		});
	});

	it("requestInbox sends list_inbox for the current session", () => {
		const send = vi.fn();
		requestInbox(send);
		expect(send).toHaveBeenCalledWith({
			type: "list_inbox",
			sessionId: "ses_1",
		});
	});

	it("cancelInboxItem removes optimistically and sends cancel_inbox", () => {
		const send = vi.fn();
		cancelInboxItem(send, "msg_1");
		expect(inboxState.items.map((i) => i.id)).toEqual(["msg_2"]);
		expect(send).toHaveBeenCalledWith({
			type: "cancel_inbox",
			inboxId: "msg_1",
			sessionId: "ses_1",
		});
	});

	it("setInboxDelivery flips the item and sends set_inbox_delivery", () => {
		const send = vi.fn();
		setInboxDelivery(send, "msg_2", "steer");
		expect(inboxState.items.find((i) => i.id === "msg_2")?.delivery).toBe(
			"steer",
		);
		expect(send).toHaveBeenCalledWith({
			type: "set_inbox_delivery",
			inboxId: "msg_2",
			delivery: "steer",
			sessionId: "ses_1",
		});
	});

	it("clearInboxState resets the store", () => {
		clearInboxState();
		expect(inboxState.items).toEqual([]);
		expect(inboxState.sessionId).toBeNull();
	});
});
