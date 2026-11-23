export interface ChatAttachment {
	name: string;
	text: string;
}

export interface ChatMessage {
	role: "user" | "assistant";
	text: string;
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
}

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
	error?: string;
}

export interface ChatTurnRequest {
	requestId: string;
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
