import type { IncomingMessage, ServerResponse } from "node:http";
import { readRawBody } from "../server/http-utils.js";
import { ChatError, type ChatService } from "./service.js";
import type { ChatAttachment } from "./types.js";

function respond(res: ServerResponse, status: number, value: unknown) {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(value));
}

export async function handleChatApi(
	service: ChatService | undefined,
	path: string,
	req: IncomingMessage,
	res: ServerResponse,
) {
	try {
		const root = "/api/chat";
		const id = /^\/api\/chat\/([0-9a-f-]{36})$/.exec(path)?.[1];
		if (path !== root && !id)
			throw new ChatError(404, "Unknown Chat operation.");
		if (path === root && req.method === "GET") {
			respond(res, 200, {
				enabled: !!service,
				conversations: (await service?.list()) ?? [],
			});
			return;
		}
		if (!service)
			throw new ChatError(503, "Chat needs a dedicated OpenCode instance.");
		if (req.method === "GET" && id) {
			respond(res, 200, await service.get(id));
			return;
		}
		if (req.method === "DELETE" && id) {
			if (req.headers["x-conduit-chat"] !== "1")
				throw new ChatError(403, "Chat request header required.");
			await service.remove(id);
			respond(res, 200, { deleted: true });
			return;
		}
		if (req.method !== "POST") throw new ChatError(405, "Unsupported method.");
		if (
			req.headers["x-conduit-chat"] !== "1" ||
			req.headers["content-type"]?.split(";")[0] !== "application/json"
		) {
			throw new ChatError(403, "Chat JSON request required.");
		}
		let body: Record<string, unknown>;
		try {
			const input: unknown = JSON.parse(
				(await readRawBody(req, 256 * 1024)).toString("utf8"),
			);
			if (!input || typeof input !== "object" || Array.isArray(input))
				throw new Error();
			body = input as Record<string, unknown>;
		} catch {
			throw new ChatError(400, "Invalid Chat request body.");
		}
		if (!id) {
			if (
				Object.keys(body).some((key) => key !== "temporary") ||
				(body["temporary"] !== undefined &&
					typeof body["temporary"] !== "boolean")
			)
				throw new ChatError(400, "Unsupported Chat option.");
			respond(res, 201, await service.create(body["temporary"] === true));
			return;
		}
		if (
			Object.keys(body).some(
				(key) => key !== "text" && key !== "attachments",
			) ||
			typeof body["text"] !== "string"
		) {
			throw new ChatError(400, "Chat accepts a text message.");
		}
		respond(
			res,
			200,
			await service.send(
				id,
				body["text"],
				readAttachments(body["attachments"]),
			),
		);
	} catch (err) {
		if (res.destroyed) return;
		respond(res, err instanceof ChatError ? err.status : 500, {
			message:
				err instanceof ChatError
					? err.message
					: "Chat could not complete this request.",
		});
	}
}

function readAttachments(input: unknown): ChatAttachment[] {
	if (input === undefined) return [];
	if (!Array.isArray(input) || input.length > 4)
		throw new ChatError(400, "Attach up to four text files of 16 KB each.");
	return input.map((item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new ChatError(400, "Invalid text attachment.");
		const { name, text } = item as Partial<ChatAttachment>;
		if (
			typeof name !== "string" ||
			name.length === 0 ||
			name.length > 255 ||
			[...name].some((character) => {
				const code = character.charCodeAt(0);
				return code < 32 || code === 127;
			}) ||
			typeof text !== "string" ||
			Buffer.byteLength(text) > 16_000 ||
			text.includes("\0")
		)
			throw new ChatError(400, "Invalid text attachment.");
		return { name, text };
	});
}
