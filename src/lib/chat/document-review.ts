import { randomUUID } from "node:crypto";
import { ChatError } from "./errors.js";
import type { ChatDocumentApproval, ChatDocumentReview } from "./types.js";

const REVIEW_LIFETIME = 10 * 60_000;
const REVIEW_LIMIT = 32;

export class DocumentReviews {
	private readonly entries = new Map<
		string,
		{
			prompt: string;
			review: ChatDocumentReview;
			expiresAt: number;
			timer: NodeJS.Timeout;
		}
	>();

	create(
		chatId: string,
		prompt: string,
		documents: ChatDocumentReview["documents"],
	): ChatDocumentReview {
		this.clear(chatId);
		const oldest = this.entries.keys().next().value;
		if (oldest && this.entries.size >= REVIEW_LIMIT) this.clear(oldest);
		const review = { reviewId: randomUUID(), documents };
		this.entries.set(chatId, {
			prompt: prompt.trim(),
			review,
			expiresAt: Date.now() + REVIEW_LIFETIME,
			timer: setTimeout(() => this.clear(chatId), REVIEW_LIFETIME).unref(),
		});
		return review;
	}

	approve(chatId: string, prompt: string, approval: ChatDocumentApproval) {
		const entry = this.entries.get(chatId);
		if (
			!entry ||
			entry.expiresAt <= Date.now() ||
			entry.review.reviewId !== approval.reviewId ||
			entry.prompt !== prompt.trim()
		)
			throw new ChatError(409, "Review the PDF excerpts again before sending.");
		return approval.documents.map(({ id, pages }) => {
			const source = entry.review.documents.find(
				(document) => document.id === id,
			);
			if (!source)
				throw new ChatError(400, "The PDF was not part of this review.");
			return {
				id,
				name: source.name,
				pages: pages.map(({ page, excerpt }) => {
					const original = source.pages.find((item) => item.page === page);
					if (!original || !isTrimmedOrRedacted(original.excerpt, excerpt))
						throw new ChatError(
							400,
							"Trim the excerpt or replace sensitive text with [redacted].",
						);
					return { page, excerpt };
				}),
			};
		});
	}

	clear(chatId: string) {
		const entry = this.entries.get(chatId);
		if (entry) clearTimeout(entry.timer);
		this.entries.delete(chatId);
	}

	forgetFile(id: string) {
		for (const [chatId, entry] of this.entries) {
			if (entry.review.documents.some((document) => document.id === id))
				this.clear(chatId);
		}
	}
}

function isTrimmedOrRedacted(original: string, excerpt: string): boolean {
	let cursor = 0;
	for (const part of excerpt.split("[redacted]")) {
		if (!part) continue;
		const found = original.indexOf(part, cursor);
		if (found < 0) return false;
		cursor = found + part.length;
	}
	return true;
}
