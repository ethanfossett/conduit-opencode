import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatFiles, documentCitations } from "../../../src/lib/chat/files.js";

vi.mock("../../../src/lib/chat/pdf.js", () => ({
	pdfAvailable: () => true,
	extractPdf: async () => [
		"First page introduction",
		"The quarterly renewal fee is 321 dollars.",
		"",
	],
	renderPdfPage: async (_bytes: Buffer, page: number) =>
		Buffer.from(`Page ${page}`),
}));

let directory: string;
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "conduit-chat-files-"));
});
afterEach(async () => {
	await rm(directory, { recursive: true, force: true });
});

it("reopens a PDF, shares a library reference, and only links supplied pages", async () => {
	const files = new ChatFiles(directory);
	const file = await files.upload(
		"owner",
		"plans.pdf",
		Buffer.from("original"),
		false,
	);
	expect(await files.list("")).toEqual([]);
	expect(await files.list("", undefined, true)).toEqual([file]);
	expect(await files.list("renewal", "owner")).toEqual([file]);
	await expect(
		files.context("other", false, [{ id: file.id }], "fee"),
	).rejects.toMatchObject({ status: 403 });

	await files.update(file.id, { saved: true, name: "Renewal.pdf" });
	const restarted = new ChatFiles(directory);
	expect((await restarted.list("quarterly"))[0]?.name).toBe("Renewal.pdf");
	const documents = await restarted.context(
		"other",
		false,
		[{ id: file.id, pages: [2] }],
		"fee",
	);
	expect(
		documentCitations("[D1:p2] [D1:p1] [D2:p2] [D1:p2]", documents),
	).toMatchObject([
		{
			id: file.id,
			page: 2,
			excerpt: "The quarterly renewal fee is 321 dollars.",
		},
	]);
	expect((await restarted.page(file.id, 2)).toString()).toBe("Page 2");
	expect(await readdir(directory)).toEqual([file.id]);

	await restarted.remove(file.id);
	expect(await restarted.retained(documents)).toEqual([]);
	await expect(restarted.content(file.id)).rejects.toMatchObject({
		status: 404,
	});
});

it("keeps temporary uploads out of disk and expires their originals with the chat", async () => {
	const files = new ChatFiles(directory);
	const file = await files.upload(
		"temporary-owner",
		"private.pdf",
		Buffer.from("transient"),
		true,
	);
	expect(await readdir(directory)).toEqual([]);
	expect(await files.list("")).toEqual([]);
	await expect(files.update(file.id, { saved: true })).rejects.toMatchObject({
		status: 403,
	});
	await expect(
		files.context("other", false, [{ id: file.id }], "fee"),
	).rejects.toMatchObject({ status: 403 });
	files.dropTemporary("temporary-owner");
	await expect(files.details(file.id)).rejects.toMatchObject({ status: 404 });
});
