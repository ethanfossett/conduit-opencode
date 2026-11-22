// ─── Question / Ask-User Bridge ──────────────────────────────────────────────

import type { AskUserQuestion } from "../types.js";

/**
 * Map OpenCode question format (with `multiple` field) to frontend format (with `multiSelect` field).
 */
export function mapQuestionFields(
	ocQuestions: Array<{
		question?: string;
		header?: string;
		options?: Array<{ label?: string; description?: string }>;
		multiple?: boolean;
		custom?: boolean;
		key?: string;
		fieldType?: string;
	}>,
): AskUserQuestion[] {
	return ocQuestions.map((q) => ({
		question: q.question ?? "",
		header: q.header ?? "",
		options: (q.options ?? []).map((o) => ({
			label: o.label ?? "",
			description: o.description ?? "",
		})),
		multiSelect: q.multiple ?? false,
		custom: q.custom ?? true,
		...(q.key != null && { key: q.key }),
		...(q.fieldType != null && { fieldType: q.fieldType }),
	}));
}
