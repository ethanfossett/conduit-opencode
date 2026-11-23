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
