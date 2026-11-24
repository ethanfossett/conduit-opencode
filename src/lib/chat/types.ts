export interface ChatAttachment {
	name: string;
	text: string;
}

export type ChatReasoning = "low" | "high";

export interface ChatModel {
	id: string;
	label: string;
	reasoning: boolean;
	local?: true;
}

export interface ChatMessage {
	role: "user" | "assistant";
	text: string;
	reasoning?: ChatReasoning;
	model?: string;
	voice?: true;
	voiceTurnId?: string;
	interrupted?: true;
	attachments?: ChatAttachment[];
	documents?: ChatDocumentContext[];
	documentsReviewed?: boolean;
	fileCitations?: ChatDocumentCitation[];
	sourceContext?: Pick<ChatSearchResult, "query" | "sources">;
}

export interface ChatConversation {
	id: string;
	title: string;
	updatedAt: number;
	temporary: boolean;
	messages: ChatMessage[];
	pinned?: boolean;
	archived?: boolean;
	renamed?: boolean;
	turn?: ChatTurn;
	receipts?: string[];
	contextStart?: number;
	pinnedContext?: number[];
	excludedContext?: number[];
	lastContext?: {
		index: number;
		entries: Pick<ChatContextEntry, "index" | "kind">[];
	};
}

export interface ChatContextEntry {
	index: number;
	kind:
		| "Recent"
		| "Pinned"
		| "Goal"
		| "Decision"
		| "Constraint"
		| "Open question"
		| "Recalled";
	role: ChatMessage["role"];
	text: string;
}

export type ChatContextChange = "pin" | "unpin" | "exclude" | "restore";

export interface ChatSource {
	url: string;
	title: string;
	snippet: string;
	excerpt?: string;
}

export interface ChatSearchResult {
	id: string;
	query: string;
	sources: ChatSource[];
}

export interface ChatTurn {
	id: string;
	prompt: ChatMessage;
	status: "running" | "stopped" | "failed";
	replaceFrom?: number;
	reply?: string;
	played?: number;
	error?: string;
}

export interface ChatTurnRequest {
	requestId: string;
	model?: string;
	voice?: true;
	reasoning?: ChatReasoning;
	text?: string;
	attachments?: ChatAttachment[];
	files?: ChatFileSelection[];
	documentApproval?: ChatDocumentApproval;
	searchId?: string;
	editFrom?: number;
	regenerate?: boolean;
	retry?: boolean;
}

export type ChatSummary = Pick<
	ChatConversation,
	"id" | "title" | "updatedAt" | "archived" | "pinned"
>;

export interface ChatFile {
	id: string;
	name: string;
	size: number;
	createdAt?: number;
	pages: number;
	textPages: number;
	saved: boolean;
	temporary: boolean;
}

export interface ChatPageText {
	file: ChatFile;
	page: number;
	text: string;
	source: "native" | "ocr";
}

export interface ChatFileSelection {
	id: string;
	pages?: number[];
}

export interface ChatDocumentContext {
	id: string;
	name: string;
	pages: { page: number; excerpt: string }[];
}

export interface ChatDocumentCitation {
	id: string;
	name: string;
	page: number;
	excerpt: string;
}

export interface ChatDocumentApproval {
	reviewId: string;
	documents: {
		id: string;
		pages: { page: number; excerpt: string }[];
	}[];
}

export interface ChatDocumentReview {
	reviewId: string;
	documents: ChatDocumentContext[];
}
