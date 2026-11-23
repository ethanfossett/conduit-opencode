export interface ChatAttachment {
	name: string;
	text: string;
}

export interface ChatMessage {
	role: "user" | "assistant";
	text: string;
	attachments?: ChatAttachment[];
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
	searchId?: string;
	editFrom?: number;
	regenerate?: boolean;
	retry?: boolean;
}

export type ChatSummary = Pick<
	ChatConversation,
	"id" | "title" | "updatedAt" | "archived" | "pinned"
>;
