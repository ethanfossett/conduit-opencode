import type { IncomingMessage, ServerResponse } from "node:http";
import { readRawBody } from "../server/http-utils.js";
import { handleChatFiles } from "./file-http.js";
import { ChatError, type ChatService } from "./service.js";
import type {
	ChatAttachment,
	ChatDocumentApproval,
	ChatFileSelection,
	ChatTurnRequest,
} from "./types.js";

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
		if (service && (await handleChatFiles(service, path, req, res, respond)))
			return;
		const match =
			/^\/api\/chat\/([0-9a-f-]{36})(\/search(?:\/read)?|\/turns(?:\/stop)?|\/metadata|\/file-review)?$/.exec(
				path,
			);
		const id = match?.[1];
		const operation = match?.[2];
		if (path !== root && !id)
			throw new ChatError(404, "Unknown Chat operation.");
		if (path === root && req.method === "GET") {
			respond(res, 200, {
				enabled: !!service,
				searchEnabled: service?.searchEnabled ?? false,
				turnsEnabled: !!service,
				filesEnabled: service?.files.enabled ?? false,
				ocrEnabled: service?.files.ocrEnabled ?? false,
				conversations:
					(await service?.list(
						new URL(req.url ?? root, "http://localhost").searchParams
							.get("q")
							?.slice(0, 240),
					)) ?? [],
			});
			return;
		}
		if (!service)
			throw new ChatError(503, "Chat needs a dedicated OpenCode instance.");
		if (req.method === "GET" && id && operation === "/turns") {
			respond(res, 200, { running: service.turnProgress(id) ?? null });
			return;
		}
		if (req.method === "GET" && id && !operation) {
			respond(res, 200, await service.get(id));
			return;
		}
		if (req.method === "DELETE" && id && !operation) {
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
		if (operation?.startsWith("/search") && id) {
			if (match?.[2] === "/search/read") {
				const searchId = body["searchId"];
				const index = body["index"];
				if (
					Object.keys(body).length !== 2 ||
					typeof searchId !== "string" ||
					typeof index !== "number" ||
					!Number.isInteger(index) ||
					index < 0 ||
					index >= 5
				) {
					throw new ChatError(400, "Choose a source from the current search.");
				}
				respond(res, 200, await service.readSource(id, searchId, index));
				return;
			}
			if (
				Object.keys(body).some((key) => key !== "query") ||
				typeof body["query"] !== "string"
			)
				throw new ChatError(400, "Chat search accepts one reviewed query.");
			respond(res, 200, await service.lookup(id, body["query"]));
			return;
		}
		if (id && operation === "/file-review") {
			const prompt = body["prompt"];
			if (
				Object.keys(body).length !== 2 ||
				typeof prompt !== "string" ||
				prompt.length > 24_000
			)
				throw new ChatError(400, "Enter a message and choose PDF pages.");
			respond(
				res,
				200,
				await service.reviewDocuments(id, prompt, readFiles(body["files"])),
			);
			return;
		}
		if (id && operation === "/turns") {
			respond(res, 202, await service.startTurn(id, readTurn(body)));
			return;
		}
		if (id && operation === "/turns/stop") {
			if (Object.keys(body).length !== 1 || !isRequestId(body["requestId"]))
				throw new ChatError(400, "A valid turn ID is required.");
			respond(res, 200, await service.stopTurn(id, body["requestId"]));
			return;
		}
		if (id && operation === "/metadata") {
			const title = body["title"];
			const pinned = body["pinned"];
			const archived = body["archived"];
			if (
				!Object.keys(body).length ||
				Object.keys(body).some(
					(key) => !["title", "pinned", "archived"].includes(key),
				) ||
				(title !== undefined && typeof title !== "string") ||
				(pinned !== undefined && typeof pinned !== "boolean") ||
				(archived !== undefined && typeof archived !== "boolean")
			)
				throw new ChatError(400, "Invalid conversation details.");
			respond(
				res,
				200,
				await service.editMetadata(id, {
					...(title !== undefined && { title }),
					...(pinned !== undefined && { pinned }),
					...(archived !== undefined && { archived }),
				}),
			);
			return;
		}
		if (!id) {
			if ("branch" in body) {
				const branch = body["branch"] as {
					id?: unknown;
					through?: unknown;
				} | null;
				if (
					Object.keys(body).length !== 1 ||
					!branch ||
					!isRequestId(branch.id) ||
					typeof branch.through !== "number"
				)
					throw new ChatError(400, "Choose an earlier reply to branch from.");
				respond(
					res,
					201,
					await service.create(false, {
						id: branch.id,
						through: branch.through,
					}),
				);
				return;
			}
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
				(key) => key !== "text" && key !== "attachments" && key !== "searchId",
			) ||
			typeof body["text"] !== "string" ||
			(body["searchId"] !== undefined && typeof body["searchId"] !== "string")
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
				body["searchId"],
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

function isRequestId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
	);
}

function readTurn(body: Record<string, unknown>): ChatTurnRequest {
	const requestId = body["requestId"];
	const text = body["text"];
	const searchId = body["searchId"];
	const editFrom = body["editFrom"];
	const regenerate = body["regenerate"];
	const retry = body["retry"];
	if (
		!isRequestId(requestId) ||
		Object.keys(body).some(
			(key) =>
				![
					"requestId",
					"text",
					"attachments",
					"files",
					"documentApproval",
					"searchId",
					"editFrom",
					"regenerate",
					"retry",
				].includes(key),
		) ||
		(regenerate !== undefined && regenerate !== true) ||
		(retry !== undefined && retry !== true) ||
		(regenerate || retry
			? Object.keys(body).length !== 2
			: typeof text !== "string") ||
		(searchId !== undefined && typeof searchId !== "string") ||
		(editFrom !== undefined &&
			(typeof editFrom !== "number" ||
				!Number.isInteger(editFrom) ||
				editFrom < 0))
	) {
		throw new ChatError(400, "Invalid chat turn.");
	}
	return {
		requestId,
		...(typeof text === "string" && { text }),
		...(body["attachments"] !== undefined && {
			attachments: readAttachments(body["attachments"]),
		}),
		...(body["files"] !== undefined && { files: readFiles(body["files"]) }),
		...(body["documentApproval"] !== undefined && {
			documentApproval: readApproval(body["documentApproval"]),
		}),
		...(typeof searchId === "string" && { searchId }),
		...(typeof editFrom === "number" && { editFrom }),
		...(regenerate === true && { regenerate }),
		...(retry === true && { retry }),
	};
}

function readFiles(input: unknown): ChatFileSelection[] {
	if (!Array.isArray(input) || input.length > 4)
		throw new ChatError(400, "Include up to four PDFs per message.");
	const seen = new Set<string>();
	return input.map((item: unknown) => {
		if (!item || typeof item !== "object" || Array.isArray(item))
			throw new ChatError(400, "Invalid PDF selection.");
		const { id, pages } = item as { id?: unknown; pages?: unknown };
		if (
			!isRequestId(id) ||
			seen.has(id) ||
			(pages !== undefined &&
				(!Array.isArray(pages) ||
					!pages.length ||
					pages.length > 8 ||
					pages.some(
						(page) => !Number.isInteger(page) || page < 1 || page > 200,
					)))
		) {
			throw new ChatError(
				400,
				"Choose unique PDFs and up to eight valid page numbers per PDF.",
			);
		}
		seen.add(id);
		return { id, ...(Array.isArray(pages) && { pages: [...new Set(pages)] }) };
	});
}

function readApproval(input: unknown): ChatDocumentApproval {
	const invalid = () =>
		new ChatError(400, "Choose valid excerpts from the PDF review.");
	if (!input || typeof input !== "object" || Array.isArray(input))
		throw invalid();
	const { reviewId, documents } = input as {
		reviewId?: unknown;
		documents?: unknown;
	};
	if (
		!isRequestId(reviewId) ||
		!Array.isArray(documents) ||
		documents.length < 1 ||
		documents.length > 4
	)
		throw invalid();
	const ids = new Set<string>();
	const parsed = documents.map((document: unknown) => {
		if (!document || typeof document !== "object") throw invalid();
		const { id, pages } = document as { id?: unknown; pages?: unknown };
		if (
			!isRequestId(id) ||
			ids.has(id) ||
			!Array.isArray(pages) ||
			pages.length < 1 ||
			pages.length > 8
		)
			throw invalid();
		ids.add(id);
		const seen = new Set<number>();
		return {
			id,
			pages: pages.map((item: unknown) => {
				if (!item || typeof item !== "object") throw invalid();
				const { page, excerpt } = item as { page?: unknown; excerpt?: unknown };
				if (
					typeof page !== "number" ||
					!Number.isInteger(page) ||
					page < 1 ||
					page > 200 ||
					seen.has(page) ||
					typeof excerpt !== "string" ||
					!excerpt.trim() ||
					excerpt.length > 2400
				)
					throw invalid();
				seen.add(page);
				return { page, excerpt };
			}),
		};
	});
	return { reviewId, documents: parsed };
}
