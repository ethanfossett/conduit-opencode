import { NODECODE_MODEL_ID } from "../nodecode.js";

import type { ChatReasoning } from "./types.js";

const MAX_REPLY = 64_000;

export async function streamNodeCode(
	key: string,
	prompt: string,
	signal: AbortSignal,
	onText: (text: string) => void,
	reasoning?: ChatReasoning,
): Promise<string> {
	const response = await fetch("https://api.nodecode.ai/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
		},
		body: JSON.stringify({
			model: NODECODE_MODEL_ID,
			stream: true,
			...(reasoning && { reasoning_effort: reasoning }),
			messages: [{ role: "user", content: prompt }],
		}),
		redirect: "error",
		signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
	});
	if (
		!response.ok ||
		!response.body ||
		!response.headers.get("content-type")?.includes("text/event-stream")
	) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error("NodeCode stream unavailable.");
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let reply = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("NodeCode stream ended early.");
			buffer += decoder.decode(chunk.value, { stream: true });
			let end = buffer.indexOf("\n");
			while (end >= 0) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				end = buffer.indexOf("\n");
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (data === "[DONE]") return reply;
				const frame = JSON.parse(data) as {
					error?: unknown;
					choices?: { delta?: { content?: unknown } }[];
				};
				if (frame.error) throw new Error("NodeCode stream failed.");
				const text = frame.choices?.[0]?.delta?.content;
				if (typeof text !== "string" || !text) continue;
				reply = (reply + text).slice(0, MAX_REPLY);
				onText(reply);
				if (reply.length === MAX_REPLY) return reply;
			}
			if (buffer.length > 256_000)
				throw new Error("NodeCode stream frame too large.");
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
