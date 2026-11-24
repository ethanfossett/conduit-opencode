import { NODECODE_MODEL_ID } from "../nodecode.js";

import type { ChatReasoning } from "./types.js";

const MAX_REPLY = 64_000;

export interface CompletionMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export class ChatStreamError extends Error {}

export async function streamNodeCode(
	key: string,
	prompt: string,
	signal: AbortSignal,
	onText: (text: string) => void,
	reasoning?: ChatReasoning,
	model = NODECODE_MODEL_ID,
	endpoint = "https://api.nodecode.ai/v1/chat/completions",
	outputLimit?: number,
	structured?: CompletionMessage[],
): Promise<string> {
	const stall = new AbortController();
	let watchdog: ReturnType<typeof setTimeout> | undefined;
	function deadline(ms: number, message: string) {
		clearTimeout(watchdog);
		watchdog = setTimeout(() => stall.abort(new ChatStreamError(message)), ms);
		watchdog.unref?.();
	}

	const limit = AbortSignal.timeout(120_000);
	const started = Date.now();
	let headersAt = 0;
	let textAt = 0;
	const backend = key ? "NodeCode" : "Local model";
	let result = "completed";
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		const largeRequest =
			Buffer.byteLength(prompt) > 24_000 || reasoning === "high";
		deadline(
			largeRequest ? 50_000 : 25_000,
			`${backend} did not open a response. Try again.`,
		);
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				...(key && { Authorization: `Bearer ${key}` }),
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			},
			body: JSON.stringify({
				model,
				stream: true,
				...(outputLimit && { max_tokens: outputLimit }),
				...(reasoning && { reasoning_effort: reasoning }),
				messages: structured ?? [{ role: "user", content: prompt }],
				...(structured && { temperature: 0.35 }),
			}),
			redirect: "error",
			signal: AbortSignal.any([signal, stall.signal, limit]),
		});
		headersAt = Date.now();
		if (
			!response.ok ||
			!response.body ||
			!response.headers.get("content-type")?.includes("text/event-stream")
		) {
			await response.body?.cancel().catch(() => undefined);
			throw new ChatStreamError(
				response.status === 429
					? `${backend} is rate limiting requests. Try again shortly.`
					: response.status === 401 || response.status === 403
						? `${backend} rejected authentication. Check the configured model access.`
						: `${backend} could not start the reply (HTTP ${response.status}).`,
			);
		}
		reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let reply = "";
		for (;;) {
			deadline(
				25_000,
				`${backend} stopped sending updates. Any text received is shown below.`,
			);
			const chunk = await reader.read();
			buffer += chunk.done
				? `${decoder.decode()}\n`
				: decoder.decode(chunk.value, { stream: true });
			let end = buffer.indexOf("\n");
			while (end >= 0) {
				const line = buffer.slice(0, end).trim();
				buffer = buffer.slice(end + 1);
				end = buffer.indexOf("\n");
				if (!line.startsWith("data:")) continue;
				const data = line.slice(5).trim();
				if (!data) continue;
				if (data === "[DONE]") {
					if (!reply.trim())
						throw new ChatStreamError(`${backend} returned no answer text.`);
					return reply;
				}
				const frame = JSON.parse(data) as {
					error?: unknown;
					choices?: {
						finish_reason?: unknown;
						delta?: { content?: unknown };
					}[];
				};
				if (frame.error)
					throw new ChatStreamError(`${backend} reported a stream error.`);
				const choice = frame.choices?.[0];
				const text = choice?.delta?.content;
				if (typeof text === "string" && text) {
					if (!textAt && text.trim()) textAt = Date.now();
					reply = (reply + text).slice(0, MAX_REPLY);
					onText(reply);
				}
				if (
					reply.length === MAX_REPLY ||
					choice?.finish_reason === "stop" ||
					choice?.finish_reason === "length"
				) {
					if (!reply.trim())
						throw new ChatStreamError(`${backend} returned no answer text.`);
					return reply;
				}
			}
			if (chunk.done)
				throw new ChatStreamError(
					`${backend} disconnected before finishing. Any text received is shown below.`,
				);
			if (buffer.length > 256_000)
				throw new ChatStreamError(
					`${backend} sent an oversized response frame.`,
				);
		}
	} catch (error) {
		result = signal.aborted ? "stopped" : "failed";
		if (signal.aborted) throw error;
		if (stall.signal.aborted) throw stall.signal.reason;
		if (limit.aborted)
			throw new ChatStreamError(
				`${backend} did not finish in time. Any text received is shown below.`,
			);
		if (error instanceof ChatStreamError) throw error;
		throw new ChatStreamError(
			`Could not read the ${backend} response. Any text received is shown below.`,
		);
	} finally {
		clearTimeout(watchdog);
		await reader?.cancel().catch(() => undefined);
		reader?.releaseLock();
		const elapsed = Date.now() - started;
		if (
			key &&
			(result === "failed" || (result === "completed" && elapsed > 8_000))
		) {
			console.warn("NodeCode Chat timing", {
				result,
				elapsed,
				headersMs: headersAt ? headersAt - started : null,
				firstTextMs: textAt ? textAt - started : null,
			});
		}
	}
}
