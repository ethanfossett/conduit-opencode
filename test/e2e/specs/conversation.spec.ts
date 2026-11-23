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
