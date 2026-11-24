import type { ChatFile, ChatFileSelection } from "../../chat/types.js";

export interface DraftPdf {
	file: ChatFile;
	pageInput: string;
}

export function pdfSelections(draft: DraftPdf[]): ChatFileSelection[] {
	return draft.map(({ file, pageInput }) => {
		const input = pageInput.trim();
		if (!input) return { id: file.id };
		const pages = new Set<number>();
		for (const part of input.split(",")) {
			const bounds = /^\s*(\d{1,3})(?:\s*-\s*(\d{1,3}))?\s*$/.exec(part);
			if (!bounds)
				throw new Error(`Use page numbers or ranges for ${file.name}.`);
			const start = Number(bounds[1]);
			const end = Number(bounds[2] ?? bounds[1]);
			if (start < 1 || end < start || end > file.pages) {
				throw new Error(`Choose pages 1–${file.pages} for ${file.name}.`);
			}
			for (let page = start; page <= end; page++) {
				pages.add(page);
				if (pages.size > 8)
					throw new Error("Choose up to eight pages per PDF.");
			}
		}
		return { id: file.id, pages: [...pages] };
	});
}
