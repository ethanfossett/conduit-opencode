import type { IncomingMessage, ServerResponse } from "node:http";
import { readRawBody } from "../server/http-utils.js";
import { ChatError } from "./errors.js";
import { MAX_FILE_BYTES } from "./files.js";
import type { ChatService } from "./service.js";

export async function handleChatFiles(
	service: ChatService,
	path: string,
	req: IncomingMessage,
	res: ServerResponse,
	respond: (res: ServerResponse, status: number, value: unknown) => void,
): Promise<boolean> {
	const root = "/api/chat/files";
	const upload = /^\/api\/chat\/([0-9a-f-]{36})\/files$/.exec(path)?.[1];
	const match =
		/^\/api\/chat\/files\/([0-9a-f-]{36})(?:\/(download|page\/(\d+)))?$/.exec(
			path,
		);
	if (!upload && path !== root && !path.startsWith(`${root}/`)) return false;
	const url = new URL(req.url ?? path, "http://localhost");
	const id = match?.[1];
	const operation = match?.[2];

	if (req.method === "GET") {
		if (path === root || upload) {
			if (upload) {
				const chat = await service.get(upload);
				if (chat.temporary)
					throw new ChatError(
						403,
						"Temporary chats stay outside the file library.",
					);
			}
			respond(res, 200, {
				files: await service.files.list(
					url.searchParams.get("q")?.slice(0, 160) ?? "",
					upload,
					url.searchParams.get("scope") === "all",
				),
			});
		} else if (id && operation === "download") {
			const { file, bytes } = await service.files.content(id);
			res.writeHead(200, {
				"Content-Type": "application/pdf",
				"Content-Disposition": `attachment; filename="document.pdf"; filename*=UTF-8''${encodeURIComponent(file.name).replaceAll("'", "%27")}`,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			});
			res.end(bytes);
		} else if (id && match?.[3]) {
			const image = await service.files.page(id, Number(match[3]));
			res.writeHead(200, {
				"Content-Type": "image/png",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			});
			res.end(image);
		} else if (id && !operation) {
			const file = await service.files.details(id);
			respond(res, 200, { file, uses: await service.fileUses(id) });
		} else throw new ChatError(404, "PDF not found.");
		return true;
	}

	if (req.headers["x-conduit-chat"] !== "1")
		throw new ChatError(403, "Chat request header required.");
	if (upload && req.method === "POST") {
		if (req.headers["content-type"]?.split(";")[0] !== "application/pdf")
			throw new ChatError(415, "Choose a PDF to upload.");
		if (Number(req.headers["content-length"]) > MAX_FILE_BYTES)
			throw new ChatError(413, "Choose a PDF of up to 10 MB.");
		const name = url.searchParams.get("name")?.slice(0, 255) ?? "Document.pdf";
		await service.get(upload);
		const data = await readRawBody(req, MAX_FILE_BYTES);
		respond(res, 201, await service.uploadFile(upload, name, data));
		return true;
	}
	if (id && !operation && req.method === "DELETE") {
		await service.files.remove(id);
		respond(res, 200, { deleted: true });
		return true;
	}
	if (id && !operation && req.method === "POST") {
		if (req.headers["content-type"]?.split(";")[0] !== "application/json")
			throw new ChatError(415, "File changes require JSON.");
		let changes: Record<string, unknown>;
		try {
			changes = JSON.parse((await readRawBody(req, 2048)).toString());
			if (!changes || typeof changes !== "object" || Array.isArray(changes))
				throw new Error();
		} catch {
			throw new ChatError(400, "Invalid file details.");
		}
		const { name, saved } = changes;
		if (
			Object.keys(changes).some((key) => key !== "name" && key !== "saved") ||
			(name !== undefined &&
				(typeof name !== "string" || !name.trim() || name.length > 120)) ||
			(saved !== undefined && typeof saved !== "boolean")
		)
			throw new ChatError(400, "Invalid file details.");
		respond(res, 200, {
			file: await service.files.update(id, {
				...(typeof name === "string" && { name }),
				...(typeof saved === "boolean" && { saved }),
			}),
		});
		return true;
	}
	throw new ChatError(405, "Unsupported file operation.");
}
