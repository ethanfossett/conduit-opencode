import { afterEach, expect, it, vi } from "vitest";
import type { PendingAttachment } from "../../../src/lib/frontend/types.js";
import {
	clearAcceptedAttachmentDraft,
	loadAttachmentDraft,
	saveAttachmentDraft,
} from "../../../src/lib/frontend/utils/attachment-drafts.js";

const attachment: PendingAttachment = {
	id: "a",
	name: "test.txt",
	size: 3,
	mime: "text/plain",
	kind: "file",
	dataUrl: "data:text/plain,abc",
};
afterEach(() => vi.unstubAllGlobals());
it("retains files in memory and reports unavailable browser persistence", async () => {
	vi.stubGlobal("indexedDB", undefined);
	expect(await saveAttachmentDraft("unavailable", [attachment])).toBe(false);
	expect(await loadAttachmentDraft("unavailable")).toEqual([attachment]);
});
it("late acceptance cannot remove a newer attachment draft", async () => {
	vi.stubGlobal("indexedDB", undefined);
	await saveAttachmentDraft("late", [{ ...attachment, id: "new-file" }]);
	await clearAcceptedAttachmentDraft("late", [attachment]);
	expect((await loadAttachmentDraft("late"))[0]?.id).toBe("new-file");
	await clearAcceptedAttachmentDraft("late", [
		{ ...attachment, id: "new-file" },
	]);
	expect(await loadAttachmentDraft("late")).toEqual([]);
});
