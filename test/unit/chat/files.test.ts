import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatFiles, documentCitations } from "../../../src/lib/chat/files.js";
import { recognizePdfPage } from "../../../src/lib/chat/pdf.js";

vi.mock("../../../src/lib/chat/pdf.js", () => ({
	pdfAvailable: () => true,
	pdfOcrAvailable: () => true,
	pdfPageTextLimit: () => 16_000,
	recognizePdfPage: vi.fn(
		async (_bytes: Buffer, _page: number) =>
			"Scanned receipt total is 48.72 dollars.",
	),
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

it("requires exact reviewed excerpts and scrubs stored copies from conversations and branches", async () => {
	const { ChatService } = await import("../../../src/lib/chat/service.js");
	const { handleChatApi } = await import("../../../src/lib/chat/http.js");
	const { createServer } = await import("node:http");
	const generate = vi.fn(
		async (_prompt: string) => "The fee is 321 dollars. [D1:p2]",
	);
	const chat = new ChatService(directory, generate);
	const app = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://localhost");
		void handleChatApi(chat, url.pathname, req, res);
	});
	await new Promise<void>((resolve) => app.listen(0, "127.0.0.1", resolve));
	const address = app.address();
	if (!address || typeof address === "string")
		throw new Error("Missing test relay.");
	const base = `http://127.0.0.1:${address.port}/api/chat`;
	const request = (path: string, method: string, data?: unknown) =>
		fetch(base + path, {
			method,
			headers: { "Content-Type": "application/json", "X-Conduit-Chat": "1" },
			...(data !== undefined && { body: JSON.stringify(data) }),
		});

	try {
		const owner = await chat.create(false);
		const other = await chat.create(false);
		const file = await chat.uploadFile(
			owner.id,
			"Private-identity.pdf",
			Buffer.from("fixture"),
		);
		const selections = [{ id: file.id, pages: [2] }];
		const turn = {
			requestId: "a0000000-0000-4000-8000-000000000001",
			text: "What is the fee?",
		};
		const turnPath = `/${owner.id}/turns`;
		expect(
			(await request(turnPath, "POST", { ...turn, files: selections })).status,
		).toBe(409);
		const preview = await request(`/${owner.id}/file-review`, "POST", {
			prompt: turn.text,
			files: selections,
		});
		expect(preview.headers.get("Cache-Control")).toBe("no-store");
		const review = await preview.json();
		expect(review.documents[0]?.pages).toEqual([
			{ page: 2, excerpt: "The quarterly renewal fee is 321 dollars." },
		]);
		const approval = {
			reviewId: review.reviewId,
			documents: [
				{
					id: file.id,
					pages: [{ page: 2, excerpt: "The [redacted] fee is 321 dollars." }],
				},
			],
		};
		expect(
			(
				await request(`/${other.id}/turns`, "POST", {
					...turn,
					documentApproval: approval,
				})
			).status,
		).toBe(409);
		expect(
			(
				await request(turnPath, "POST", {
					...turn,
					text: "Changed prompt",
					documentApproval: approval,
				})
			).status,
		).toBe(409);
		expect(
			(
				await request(turnPath, "POST", {
					...turn,
					documentApproval: {
						...approval,
						documents: [
							{ id: file.id, pages: [{ page: 2, excerpt: "999 dollars" }] },
						],
					},
				})
			).status,
		).toBe(400);
		expect(generate).not.toHaveBeenCalled();

		expect(
			(await request(turnPath, "POST", { ...turn, documentApproval: approval }))
				.status,
		).toBe(202);
		await vi.waitFor(async () =>
			expect((await chat.get(owner.id)).turn).toBeUndefined(),
		);
		const providerInput = generate.mock.calls[0]?.[0];
		expect(providerInput).toContain("The [redacted] fee is 321 dollars.");
		expect(providerInput).not.toContain("quarterly renewal");
		expect(providerInput).not.toContain(file.name);
		expect(providerInput).not.toContain(file.id);
		expect((await chat.get(owner.id)).messages[1]?.fileCitations).toMatchObject(
			[{ id: file.id, page: 2 }],
		);

		const branch = await chat.create(false, { id: owner.id, through: 2 });
		const deleted = await request(
			`/files/${file.id}?removeExcerpts=1`,
			"DELETE",
		);
		expect(deleted.status).toBe(200);
		await expect(chat.files.details(file.id)).rejects.toMatchObject({
			status: 404,
		});
		for (const id of [owner.id, branch.id]) {
			const saved = await chat.get(id);
			expect(saved.messages[0]?.documents).toBeUndefined();
			expect(saved.messages[1]?.fileCitations).toBeUndefined();
			expect(saved.messages[1]?.text).toContain("321 dollars");
			expect(saved.contextStart).toBe(2);
		}
		await chat.send(owner.id, "A fresh question");
		expect(generate.mock.calls[1]?.[0]).not.toContain("321 dollars");
	} finally {
		app.closeAllConnections();
		await new Promise<void>((resolve) => app.close(() => resolve()));
	}
});

it("runs local OCR only for a chosen image page and keeps searchable results with the PDF", async () => {
	const files = new ChatFiles(directory);
	const document = await files.upload(
		"owner",
		"scan.pdf",
		Buffer.from("image fixture"),
		false,
	);
	const localOcr = vi.mocked(recognizePdfPage);
	localOcr.mockClear();
	expect(await files.readPageText(document.id, 2)).toMatchObject({
		source: "native",
	});
	expect(localOcr).not.toHaveBeenCalled();
	expect(await files.list("scanned receipt", "owner")).toEqual([]);

	localOcr.mockRejectedValueOnce(new Error("Synthetic local OCR failure"));
	await expect(files.readPageText(document.id, 3)).rejects.toThrow(
		"Synthetic local OCR failure",
	);
	expect((await files.details(document.id)).textPages).toBe(2);
	expect(await files.list("scanned receipt", "owner")).toEqual([]);

	expect(await files.readPageText(document.id, 3)).toMatchObject({
		source: "ocr",
		page: 3,
		text: "Scanned receipt total is 48.72 dollars.",
	});
	const reopened = new ChatFiles(directory);
	expect(await reopened.readPageText(document.id, 3)).toMatchObject({
		source: "ocr",
	});
	expect(localOcr).toHaveBeenCalledTimes(2);
	expect(await reopened.list("48.72", "owner")).toHaveLength(1);
	await reopened.remove(document.id);
	expect(await reopened.list("48.72", "owner")).toEqual([]);
});

it("keeps Temporary Chat OCR in its original chat and behind excerpt review", async () => {
	const { ChatService } = await import("../../../src/lib/chat/service.js");
	const generate = vi.fn(async (_input: string) => "A cited reply [D1:p3]");
	const service = new ChatService(directory, generate);
	const owner = await service.create(true);
	const another = await service.create(true);
	const document = await service.uploadFile(
		owner.id,
		"temporary-scan.pdf",
		Buffer.from("image fixture"),
	);
	await expect(
		service.readPdfText(document.id, 3, another.id),
	).rejects.toMatchObject({ status: 403 });
	await expect(service.readPdfText(document.id, 3)).rejects.toMatchObject({
		status: 403,
	});
	const ocr = await service.readPdfText(document.id, 3, owner.id);
	const selections = [{ id: document.id, pages: [3] }];
	const review = await service.reviewDocuments(
		owner.id,
		"What is the total?",
		selections,
	);
	expect(review.documents[0]?.pages[0]?.excerpt).toBe(ocr.text);
	expect(generate).not.toHaveBeenCalled();
	expect(await readdir(directory)).toEqual([]);
	await service.remove(owner.id);
	await expect(service.files.details(document.id)).rejects.toMatchObject({
		status: 404,
	});
	expect(await readdir(directory)).toEqual([]);
});
