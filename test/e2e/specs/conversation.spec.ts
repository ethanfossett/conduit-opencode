import type {
	ChatConversation,
	ChatSearchResult,
} from "../../../src/lib/chat/types.js";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ recording: "chat-simple" });

test("Chat reviews private search and transfers only edited text into a Code draft", async ({
	page,
	relayUrl,
}) => {
	const chats = new Map<string, ChatConversation>();
	const search: ChatSearchResult = {
		id: "reviewed-search",
		query: "public search terms",
		sources: [
			{
				title: "Example",
				url: "https://example.org/",
				snippet: "Indexed excerpt",
			},
		],
	};
	const searches: unknown[] = [];
	const turns: unknown[] = [];
	const codeMessages: unknown[] = [];
	await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (["send_message", "message", "send"].includes(message.type))
				codeMessages.push(message);
			server.send(raw);
		});
	});
	await page.route(/\/api\/chat(?:\/.*)?$/, async (route) => {
		const request = route.request();
		const [, , , id, operation] = new URL(request.url()).pathname.split("/");
		const body = request.postDataJSON();
		if (!id && request.method() === "GET") {
			return route.fulfill({
				json: {
					enabled: true,
					searchEnabled: true,
					conversations: [...chats.values()].filter((chat) => !chat.temporary),
				},
			});
		}
		if (!id) {
			const chat = {
				id: crypto.randomUUID(),
				title: "New chat",
				updatedAt: Date.now(),
				temporary: body.temporary,
				messages: [],
			};
			chats.set(chat.id, chat);
			return route.fulfill({ json: chat });
		}
		const chat = chats.get(id);
		if (!chat) return route.fulfill({ status: 404, json: {} });
		if (operation === "search") {
			searches.push(body);
			return route.fulfill({ json: search });
		}
		if (request.method() === "POST") {
			turns.push(body);
			chat.title = body.text;
			chat.messages = [
				{ role: "user", text: body.text, sourceContext: search },
				{
					role: "assistant",
					text: "Only this excerpt is offered for the Code draft.",
				},
			];
		}
		return route.fulfill({ json: chat });
	});

	const code = new AppPage(page);
	await code.goto(relayUrl);
	await page.getByRole("link", { name: "Chat", exact: true }).click();
	await page.getByRole("button", { name: "New chat", exact: true }).click();
	await page
		.getByRole("textbox", { name: "Message", exact: true })
		.fill("Private message for the model");
	await page.reload();
	await expect(
		page.getByRole("textbox", { name: "Message", exact: true }),
	).toHaveValue("Private message for the model");

	await page.getByRole("button", { name: "Web search", exact: true }).click();
	const query = page.getByRole("textbox", { name: "Review your web query" });
	await expect(query).toHaveValue("");
	await query.fill(search.query);
	expect(searches).toEqual([]);
	await page.getByRole("button", { name: "Run search" }).click();
	await expect(page.getByText("Indexed excerpt")).toBeVisible();
	expect(searches).toEqual([{ query: search.query }]);
	await page.getByRole("checkbox", { name: /Send these sources/ }).check();
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.getByRole("link", { name: "Example" })).toBeVisible();
	expect(turns).toEqual([
		{ text: "Private message for the model", searchId: search.id },
	]);

	await page.getByRole("button", { name: "Continue in Code" }).last().click();
	const excerpt = page.getByRole("textbox", { name: "Review text for Code" });
	await expect(excerpt).toHaveValue(
		"Only this excerpt is offered for the Code draft.",
	);
	await excerpt.fill("Only the approved Code draft");
	await page.getByRole("button", { name: "Open Code project" }).click();
	await page.getByRole("button", { name: "Create session with draft" }).click();
	await expect(code.input).toHaveValue("Only the approved Code draft");
	expect(codeMessages).toEqual([]);
	await page.reload();
	await expect(code.input).toHaveValue("Only the approved Code draft");
});

test("an accepted Chat turn recovers after reload and is searchable once complete", async ({
	page,
	relayUrl,
}) => {
	const chat: ChatConversation = {
		id: crypto.randomUUID(),
		title: "Field notes",
		updatedAt: Date.now(),
		temporary: false,
		messages: [],
	};
	let calls = 0;
	let finish = false;
	let edits: unknown;
	await page.route(
		(url) => url.pathname.startsWith("/api/chat"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (url.pathname === "/api/chat") {
				const query = url.searchParams.get("q");
				return route.fulfill({
					json: {
						enabled: true,
						searchEnabled: false,
						turnsEnabled: true,
						conversations:
							!query || chat.messages.some(({ text }) => text.includes(query))
								? [
										{
											id: chat.id,
											title: chat.title,
											updatedAt: chat.updatedAt,
										},
									]
								: [],
					},
				});
			}
			if (url.pathname.endsWith("/turns") && request.method() === "POST") {
				calls++;
				const body = request.postDataJSON();
				chat.receipts = [...(chat.receipts ?? []), body.requestId];
				if (body.editFrom !== undefined) {
					edits = body;
					chat.messages[0] = { role: "user", text: body.text };
				} else {
					chat.turn = {
						id: body.requestId,
						prompt: { role: "user", text: body.text },
						status: "running",
						reply: "A visible fragment",
					};
				}
				return route.fulfill({ status: 202, json: chat });
			}
			if (finish && chat.turn) {
				chat.messages = [
					chat.turn.prompt,
					{ role: "assistant", text: "The complete searchable reply." },
				];
				delete chat.turn;
			}
			return route.fulfill({ json: chat });
		},
	);
	const base = new URL(relayUrl);
	await page.goto(new URL(`/chat?c=${chat.id}`, base).href);
	await page
		.getByRole("textbox", { name: "Message" })
		.fill("Checkpoint prompt");
	await page.getByRole("button", { name: "Send", exact: true }).click();
	await expect(page.getByText("A visible fragment")).toBeVisible();
	await page.reload();
	await expect(page.getByText("A visible fragment")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("");
	finish = true;
	await expect(page.getByText("The complete searchable reply.")).toBeVisible();
	expect(calls).toBe(1);

	await page
		.getByRole("searchbox", { name: "Search chat history" })
		.fill("searchable");
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(page.getByRole("button", { name: "Field notes" })).toBeVisible();
	await page.getByRole("button", { name: "Edit prompt" }).click();
	await page
		.getByRole("textbox", { name: "Message" })
		.fill("Revised checkpoint prompt");
	await page.getByRole("button", { name: "Send edit" }).click();
	await expect(page.getByText("Revised checkpoint prompt")).toBeVisible();
	expect(edits).toMatchObject({
		editFrom: 0,
		text: "Revised checkpoint prompt",
	});
});
