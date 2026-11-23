export interface ChatAttachment {
	name: string;
	text: string;
}

export interface ChatMessage {
	role: "user" | "assistant";
	text: string;
	attachments?: ChatAttachment[];
}

export interface ChatConversation {
	id: string;
	title: string;
	updatedAt: number;
	temporary: boolean;
	messages: ChatMessage[];
}
