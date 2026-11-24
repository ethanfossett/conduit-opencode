import { randomUUID } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { ChatError } from "./errors.js";
import {
	extractPdf,
	pdfAvailable,
	pdfOcrAvailable,
	pdfPageTextLimit,
	recognizePdfPage,
	renderPdfPage,
} from "./pdf.js";
import type {
	ChatDocumentCitation,
	ChatDocumentContext,
	ChatFile,
	ChatFileSelection,
	ChatPageText,
} from "./types.js";

interface DocumentRecord extends ChatFile {
	owner: string;
	text: string[];
	ocrPages?: number[];
}

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_TEMP_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 100;

export class ChatFiles {
	private readonly temporary = new Map<
		string,
		{ record: DocumentRecord; bytes: Buffer }
	>();
	private writing = false;

	constructor(private readonly directory: string) {}

	get enabled() {
		return pdfAvailable();
	}

	get ocrEnabled() {
		return pdfOcrAvailable();
	}

	private async writeMetadata(record: DocumentRecord) {
		const folder = this.path(record.id);
		const staging = join(folder, `.metadata-${randomUUID()}`);
		try {
			await writeFile(staging, JSON.stringify(record), { mode: 0o600 });
			await rename(staging, join(folder, "metadata.json"));
		} finally {
			await rm(staging, { force: true });
		}
	}

	private path(id: string) {
		if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
			throw new ChatError(404, "PDF not found.");
		return join(this.directory, id);
	}

	private async record(id: string): Promise<DocumentRecord> {
		const temporary = this.temporary.get(id);
		if (temporary) return temporary.record;
		try {
			return JSON.parse(
				await readFile(join(this.path(id), "metadata.json"), "utf8"),
			) as DocumentRecord;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT")
				throw new ChatError(404, "PDF not found.");
			throw error;
		}
	}

	private async records() {
		const names = await readdir(this.directory).catch(
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return [];
				throw error;
			},
		);
		const records: DocumentRecord[] = [];
		for (const id of names.filter((name) => /^[a-f0-9-]{36}$/.test(name))) {
			try {
				records.push(await this.record(id));
			} catch (error) {
				if (!(error instanceof ChatError && error.status === 404)) throw error;
			}
		}
		return records;
	}

	private summary({
		id,
		name,
		size,
		createdAt,
		pages,
		textPages,
		saved,
		temporary,
	}: DocumentRecord): ChatFile {
		return {
			id,
			name,
			size,
			pages,
			textPages,
			saved,
			temporary,
			...(createdAt !== undefined && { createdAt }),
		};
	}

	async upload(
		owner: string,
		name: string,
		data: Buffer,
		temporary: boolean,
	): Promise<ChatFile> {
		if (!this.enabled)
			throw new ChatError(503, "PDF tools are unavailable on this server.");
		if (!data.length || data.length > MAX_FILE_BYTES)
			throw new ChatError(413, "Choose a PDF of up to 10 MB.");
		if (this.writing)
			throw new ChatError(
				429,
				"Another PDF is being uploaded. Try again shortly.",
			);
		this.writing = true;
		try {
			const records = temporary
				? [...this.temporary.values()].map(({ record }) => record)
				: await this.records();
			const used = records.reduce((bytes, file) => bytes + file.size, 0);
			if (
				records.length >= MAX_FILES ||
				used + data.length > (temporary ? MAX_TEMP_BYTES : MAX_TOTAL_BYTES)
			)
				throw new ChatError(
					429,
					"File storage is full. Delete files before uploading more.",
				);
			const text = await extractPdf(data);
			const record: DocumentRecord = {
				id: randomUUID(),
				owner,
				name: cleanName(name),
				size: data.length,
				createdAt: Date.now(),
				pages: text.length,
				textPages: text.filter(Boolean).length,
				saved: false,
				temporary,
				text,
			};
			if (temporary) {
				this.temporary.set(record.id, { record, bytes: data });
			} else {
				await mkdir(this.directory, { recursive: true, mode: 0o700 });
				const staging = join(this.directory, `.upload-${record.id}`);
				await mkdir(staging, { mode: 0o700 });
				try {
					await writeFile(join(staging, "original.pdf"), data, { mode: 0o600 });
					await writeFile(
						join(staging, "metadata.json"),
						JSON.stringify(record),
						{ mode: 0o600 },
					);
					await rename(staging, this.path(record.id));
				} finally {
					await rm(staging, { recursive: true, force: true });
				}
			}
			return this.summary(record);
		} finally {
			this.writing = false;
		}
	}

	async list(query: string, owner?: string, all = false) {
		const test = query.toLowerCase().trim();
		const records = await this.records();
		return records
			.filter((record) => all || record.saved || record.owner === owner)
			.filter(
				(record) =>
					!test ||
					record.name.toLowerCase().includes(test) ||
					record.text.some((page) => page.toLowerCase().includes(test)),
			)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
			.map((record) => this.summary(record));
	}

	async retained(
		documents: ChatDocumentContext[],
	): Promise<ChatDocumentContext[]> {
		const present = await Promise.all(
			documents.map(async (document) => {
				try {
					await this.record(document.id);
					return document;
				} catch (error) {
					if (!(error instanceof ChatError) || error.status !== 404)
						throw error;
					return undefined;
				}
			}),
		);
		return present.filter((document) => document !== undefined);
	}

	async details(id: string) {
		return this.summary(await this.record(id));
	}

	async update(id: string, changes: { name?: string; saved?: boolean }) {
		if (this.writing)
			throw new ChatError(429, "File storage is busy. Try again shortly.");
		this.writing = true;
		try {
			const file = await this.record(id);
			if (file.temporary)
				throw new ChatError(403, "Temporary files stay in this chat.");
			const updated = {
				...file,
				...changes,
				...(changes.name !== undefined && { name: cleanName(changes.name) }),
			};
			await this.writeMetadata(updated);
			return this.summary(updated);
		} finally {
			this.writing = false;
		}
	}

	async remove(id: string) {
		if (this.writing)
			throw new ChatError(429, "File storage is busy. Try again shortly.");
		this.writing = true;
		try {
			const file = await this.record(id);
			if (file.temporary) this.temporary.delete(id);
			else await rm(this.path(id), { recursive: true, force: true });
		} finally {
			this.writing = false;
		}
	}

	dropTemporary(owner: string) {
		for (const [id, { record }] of this.temporary) {
			if (record.owner === owner) this.temporary.delete(id);
		}
	}

	async content(id: string) {
		const record = await this.record(id);
		const bytes =
			this.temporary.get(id)?.bytes ??
			(await readFile(join(this.path(id), "original.pdf")));
		return { file: this.summary(record), bytes };
	}

	async page(id: string, page: number) {
		const { file, bytes } = await this.content(id);
		if (!Number.isInteger(page) || page < 1 || page > file.pages)
			throw new ChatError(404, "Page not found.");
		return renderPdfPage(bytes, page);
	}

	async readPageText(
		id: string,
		page: number,
		chatId?: string,
	): Promise<ChatPageText> {
		if (this.writing)
			throw new ChatError(429, "File storage is busy. Try again shortly.");
		this.writing = true;
		try {
			const record = await this.record(id);
			if (record.temporary && record.owner !== chatId)
				throw new ChatError(
					403,
					"Temporary files stay in their original chat.",
				);
			if (!Number.isInteger(page) || page < 1 || page > record.pages)
				throw new ChatError(404, "Page not found.");
			const existing = record.text[page - 1];
			if (existing)
				return {
					file: this.summary(record),
					page,
					text: existing,
					source: record.ocrPages?.includes(page) ? "ocr" : "native",
				};
			const transient = this.temporary.get(id);
			const bytes =
				transient?.bytes ??
				(await readFile(join(this.path(id), "original.pdf")));
			const text = (await recognizePdfPage(bytes, page)).slice(
				0,
				pdfPageTextLimit(record.pages),
			);
			const pages = [...record.text];
			pages[page - 1] = text;
			const updated = {
				...record,
				text: pages,
				textPages: pages.filter(Boolean).length,
				ocrPages: [...(record.ocrPages ?? []), page],
			};
			if (transient) {
				if (this.temporary.get(id) !== transient)
					throw new ChatError(404, "Temporary PDF expired.");
				this.temporary.set(id, { record: updated, bytes });
			} else await this.writeMetadata(updated);
			return { file: this.summary(updated), page, text, source: "ocr" };
		} finally {
			this.writing = false;
		}
	}

	async context(
		owner: string,
		temporary: boolean,
		selections: ChatFileSelection[],
		query: string,
	): Promise<ChatDocumentContext[]> {
		return Promise.all(
			selections.map(async (selection) => {
				const record = await this.record(selection.id);
				if (record.owner !== owner && (!record.saved || temporary))
					throw new ChatError(
						403,
						"This PDF is unavailable in the selected chat.",
					);
				const pages = choosePages(record, selection.pages, query);
				if (!pages.length)
					throw new ChatError(
						422,
						"No text is available for the selected pages. Open a page and choose Read text from this page.",
					);
				return { id: record.id, name: record.name, pages };
			}),
		);
	}
}

function cleanName(name: string) {
	const base = (name.split(/[\\/]/).at(-1) || "Document.pdf")
		.replace(/[\p{Cc}\p{Cf}]/gu, "")
		.trim()
		.slice(0, 120);
	return base || "Document.pdf";
}

function choosePages(
	record: DocumentRecord,
	selected: number[] | undefined,
	query: string,
) {
	if (selected?.some((page) => page < 1 || page > record.pages))
		throw new ChatError(400, "A selected PDF page is out of range.");
	if (selected?.some((page) => !record.text[page - 1]))
		throw new ChatError(
			422,
			"A selected page has no text yet. Open it and choose Read text from this page.",
		);

	const terms = [
		...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []),
	].slice(0, 24);
	const pages = record.text.flatMap((text, index) => {
		const page = index + 1;
		if (!text || (selected && !selected.includes(page))) return [];
		const lower = text.toLowerCase();
		const hits = terms
			.map((term) => lower.indexOf(term))
			.filter((position) => position >= 0);
		const start = hits.length ? Math.max(0, Math.min(...hits) - 280) : 0;
		return [
			{ page, excerpt: text.slice(start, start + 2200), score: hits.length },
		];
	});
	if (!selected) pages.sort((a, b) => b.score - a.score);
	return pages
		.slice(0, selected ? 8 : 4)
		.sort((a, b) => a.page - b.page)
		.map(({ page, excerpt }) => ({ page, excerpt }));
}

export function documentCitations(
	reply: string,
	documents: ChatDocumentContext[],
): ChatDocumentCitation[] {
	const seen = new Set<string>();
	const citations: ChatDocumentCitation[] = [];
	for (const match of reply.matchAll(/\[D(\d+):p(\d+)\]/gi)) {
		const document = documents[Number(match[1]) - 1];
		const excerpt = document?.pages.find(
			({ page }) => page === Number(match[2]),
		);
		if (!document || !excerpt) continue;
		const key = `${document.id}:${excerpt.page}`;
		if (seen.has(key)) continue;
		seen.add(key);
		citations.push({ id: document.id, name: document.name, ...excerpt });
	}
	return citations;
}
