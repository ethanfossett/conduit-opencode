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

test("Chat dictation releases the microphone on interruption and saves reviewed text", async ({
	page,
	relayUrl,
}) => {
	const id = crypto.randomUUID();
	let submissions = 0;
	let dictations = 0;
	await page.addInitScript(() => {
		const state = { released: false, hidden: false };
		Object.assign(window, { voiceTest: state });
		Object.defineProperty(document, "hidden", {
			get: () => state.hidden,
			configurable: true,
		});
		const track = new EventTarget();
		Object.assign(track, {
			stop: () => {
				state.released = true;
			},
		});
		Object.defineProperty(navigator, "mediaDevices", {
			value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
		});
		class TestRecorder {
			static isTypeSupported() {
				return true;
			}
			state = "inactive";
			mimeType = "audio/mp4";
			ondataavailable?: (event: { data: Blob }) => void;
			onstop?: () => void;
			start() {
				this.state = "recording";
			}
			stop() {
				this.state = "inactive";
				setTimeout(() => {
					this.ondataavailable?.({
						data: new Blob(["sample"], { type: "audio/mp4" }),
					});
					this.onstop?.();
				});
			}
		}
		Object.defineProperty(window, "MediaRecorder", {
			value: TestRecorder,
			configurable: true,
		});
	});
	await page.route(
		(url) => url.pathname.startsWith("/api/chat"),
		async (route) => {
			if (route.request().method() === "POST") submissions++;
			const data = {
				id,
				title: "Voice test",
				updatedAt: Date.now(),
				temporary: false,
				messages: [],
			};
			return route.fulfill({
				json:
					new URL(route.request().url()).pathname === "/api/chat"
						? {
								enabled: true,
								searchEnabled: false,
								turnsEnabled: true,
								conversations: [data],
							}
						: data,
			});
		},
	);
	await page.route("**/api/stt", async (route) => {
		dictations++;
		expect(route.request().headers()["x-conduit-local-dictation"]).toBe("1");
		expect(route.request().headers()["content-type"]).toBe("audio/mp4");
		if (dictations === 1) return route.abort("internetdisconnected");
		return route.fulfill({ json: { text: "review this transcript" } });
	});
	await page.goto(new URL(`/chat?c=${id}`, relayUrl).href);
	const composer = page.getByRole("textbox", { name: "Message", exact: true });
	await composer.fill("Existing draft");
	await page.getByRole("button", { name: "Dictate", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Stop dictation" }),
	).toBeVisible();
	await page.evaluate(() => {
		const testState = (window as unknown as { voiceTest: { hidden: boolean } })
			.voiceTest;
		testState.hidden = true;
		document.dispatchEvent(new Event("visibilitychange"));
		testState.hidden = false;
	});
	await expect(
		page.getByRole("button", { name: "Retry dictation" }),
	).toBeVisible();
	expect(
		await page.evaluate(
			() =>
				(window as unknown as { voiceTest: { released: boolean } }).voiceTest
					.released,
		),
	).toBe(true);
	await page.getByRole("button", { name: "Retry dictation" }).click();
	await expect(composer).toHaveValue("Existing draft review this transcript");
	await page.reload();
	await expect(composer).toHaveValue("Existing draft review this transcript");
	expect(dictations).toBe(2);
	expect(submissions).toBe(0);
});

test("Chat read-aloud selects an on-device voice and supports playback controls", async ({
	page,
	relayUrl,
}) => {
	const id = crypto.randomUUID();
	await page.addInitScript(() => {
		const calls: string[] = [];
		Object.assign(window, { speechCalls: calls });
		Object.defineProperty(window, "SpeechSynthesisUtterance", {
			value: class {
				text: string;
				constructor(text: string) {
					this.text = text;
				}
			},
			configurable: true,
		});
		Object.defineProperty(window, "speechSynthesis", {
			value: {
				getVoices: () => [
					{ default: true, localService: false, lang: "en-US", name: "Remote" },
					{ default: false, localService: true, lang: "en-US", name: "Local" },
				],
				speak: (message: SpeechSynthesisUtterance) =>
					calls.push(`${message.voice?.name}: ${message.text}`),
				pause: () => calls.push("pause"),
				resume: () => calls.push("resume"),
				cancel: () => calls.push("cancel"),
			},
			configurable: true,
		});
	});
	await page.route(
		(url) => url.pathname.startsWith("/api/chat"),
		async (route) => {
			const data = {
				id,
				title: "Read-aloud test",
				updatedAt: Date.now(),
				temporary: false,
				messages: [{ role: "assistant", text: "**Ready** to listen." }],
			};
			return route.fulfill({
				json:
					new URL(route.request().url()).pathname === "/api/chat"
						? {
								enabled: true,
								searchEnabled: false,
								turnsEnabled: true,
								conversations: [data],
							}
						: data,
			});
		},
	);
	await page.goto(new URL(`/chat?c=${id}`, relayUrl).href);
	await page.getByRole("button", { name: "Read aloud" }).click();
	await page.getByRole("button", { name: "Pause playback" }).click();
	await page.getByRole("button", { name: "Resume playback" }).click();
	await page.getByRole("button", { name: "Stop playback" }).click();
	expect(
		await page.evaluate(
			() => (window as unknown as { speechCalls: string[] }).speechCalls,
		),
	).toEqual(["Local: Ready to listen.", "pause", "resume", "cancel"]);
});

test("PDF excerpts can be redacted before the browser submits the approval", async ({
	page,
	relayUrl,
}) => {
	const id = crypto.randomUUID();
	const fileId = crypto.randomUUID();
	const reviewId = crypto.randomUUID();
	const file = {
		id: fileId,
		name: "Receipt.pdf",
		size: 1024,
		pages: 1,
		textPages: 1,
		saved: false,
		temporary: false,
	};
	const conversation = {
		id,
		title: "Receipt review",
		updatedAt: Date.now(),
		temporary: false,
		messages: [],
	};
	const source = "Total $32. Account 123456789.";
	let submitted: unknown;
	await page.addInitScript(
		({ id, file }) => {
			localStorage.setItem(
				`conduit.draft.v1:conversation:${id}:pdfs`,
				JSON.stringify([{ file, pageInput: "" }]),
			);
		},
		{ id, file },
	);
	await page.route(
		(url) => url.pathname.startsWith("/api/chat"),
		async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/chat")
				return route.fulfill({
					json: {
						enabled: true,
						searchEnabled: false,
						turnsEnabled: true,
						filesEnabled: true,
						conversations: [conversation],
					},
				});
			if (path.endsWith("/file-review"))
				return route.fulfill({
					json: {
						reviewId,
						documents: [
							{
								id: fileId,
								name: file.name,
								pages: [{ page: 1, excerpt: source }],
							},
						],
					},
				});
			if (path.endsWith("/turns")) {
				submitted = route.request().postDataJSON();
				return route.fulfill({
					status: 202,
					json: {
						...conversation,
						receipts: [route.request().postDataJSON().requestId],
					},
				});
			}
			return route.fulfill({ json: conversation });
		},
	);
	await page.goto(new URL(`/chat?c=${id}`, relayUrl).href);
	await page
		.getByRole("textbox", { name: "Message", exact: true })
		.fill("What is the total?");
	await page.getByRole("button", { name: "Send with excerpts" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"Review the PDF excerpts before sending.",
	);
	expect(submitted).toBeUndefined();
	await page.getByRole("button", { name: "Review PDF excerpts" }).click();
	const excerpt = page.getByRole("textbox", { name: "Receipt.pdf · Page 1" });
	await expect(excerpt).toHaveValue(source);
	await excerpt.evaluate((element) => {
		const textarea = element as HTMLTextAreaElement;
		const start = textarea.value.indexOf("123456789");
		textarea.setSelectionRange(start, start + 9);
	});
	await page.getByRole("button", { name: "Redact selection" }).click();
	await expect(excerpt).toHaveValue("Total $32. Account [redacted].");
	await page.getByRole("button", { name: "Send with excerpts" }).click();
	await expect
		.poll(() => submitted)
		.toMatchObject({
			text: "What is the total?",
			documentApproval: {
				reviewId,
				documents: [
					{
						id: fileId,
						pages: [{ page: 1, excerpt: "Total $32. Account [redacted]." }],
					},
				],
			},
		});
	expect(JSON.stringify(submitted)).not.toContain("123456789");
});
