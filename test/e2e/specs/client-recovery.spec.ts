import type { WebSocketRoute } from "@playwright/test";
import { expect, test } from "../helpers/replay-fixture.js";
import { AppPage } from "../page-objects/app.page.js";

test.use({ recording: "chat-simple" });

test("text draft survives reload and an empty relay snapshot", async ({
	page,
	relayUrl,
}) => {
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.input.fill("An unsent draft that must survive restarting the app");
	await page.reload();
	await app.layout.waitFor();
	await app.connectOverlay.waitFor({ state: "hidden" });
	await expect(app.input).toHaveValue(
		"An unsent draft that must survive restarting the app",
	);
});

test("a disconnected submission keeps the draft and does not add a sent bubble", async ({
	page,
	relayUrl,
}) => {
	let socket: WebSocketRoute | undefined;
	let rejectReconnect = false;
	await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
		if (rejectReconnect) {
			route.close();
			return;
		}
		socket = route;
		route.connectToServer();
	});
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.input.fill("Retain this disconnected message");
	const before = await page.locator(".msg-user").count();
	rejectReconnect = true;
	socket?.close();
	await expect(page.locator("#reconnect-banner")).toBeVisible();
	await app.input.press("Enter");
	await expect(app.input).toHaveValue("Retain this disconnected message");
	await expect(page.locator(".msg-user")).toHaveCount(before);
	rejectReconnect = false;
	await page.evaluate(() => window.dispatchEvent(new Event("online")));
	await expect(page.locator("#reconnect-banner")).toBeHidden();
	await expect(app.input).toHaveValue("Retain this disconnected message");
});

test("clears the composer only after the relay acknowledges acceptance", async ({
	page,
	relayUrl,
}) => {
	const frames: unknown[] = [];
	page.on("websocket", (socket) =>
		socket.on("framereceived", ({ payload }) => {
			try {
				const data = JSON.parse(String(payload));
				if (
					[
						"status",
						"done",
						"session_list",
						"submission_result",
						"error",
					].includes(data.type)
				)
					frames.push(data);
			} catch {
				/* binary frame */
			}
		}),
	);
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.sendMessage("Acknowledge this prompt");
	await expect(app.input).toHaveValue("");
	await expect(
		page.locator(".msg-user").filter({ hasText: "Acknowledge this prompt" }),
	).toHaveCount(1);
	await expect(page.getByText("Sending…", { exact: true })).toHaveCount(0);
	// Observe a full status-poll cycle after the streamed result completes.
	await page.waitForTimeout(1_200);
	try {
		await expect(page.locator("#stop")).toBeHidden({ timeout: 10_000 });
	} finally {
		await test.info().attach("submission-lifecycle", {
			body: JSON.stringify(frames, null, 2),
			contentType: "application/json",
		});
	}
});

test("installs offline navigation without enabling notifications", async ({
	page,
	relayUrl,
	context,
}) => {
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await page.waitForFunction(() => !!navigator.serviceWorker.controller);
	await context.setOffline(true);
	try {
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(
			page.getByRole("heading", { name: "Conduit is offline" }),
		).toBeVisible();
		await expect(page.getByRole("link", { name: "Try again" })).toBeVisible();
	} finally {
		await context.setOffline(false);
	}
	await page.getByRole("link", { name: "Try again" }).click();
	await expect(app.input).toBeVisible();
});

test("upstream rejection keeps the editable draft and labels the failed bubble", async ({
	page,
	relayUrl,
}) => {
	await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
		const server = route.connectToServer();
		route.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "message")
				route.send(
					JSON.stringify({
						type: "submission_result",
						requestId: message.requestId,
						sessionId: message.sessionId,
						accepted: false,
					}),
				);
			else server.send(raw);
		});
	});
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.sendMessage("Keep this rejected draft editable");
	await expect(app.input).toHaveValue("Keep this rejected draft editable");
	await expect(
		page.getByText("Not accepted — draft retained", { exact: true }),
	).toBeVisible();
	await expect(app.sendBtn).toBeEnabled();
});

test("loads optional renderers only when code and a diagram arrive", async ({
	page,
	relayUrl,
	mockServer,
}) => {
	const requested: string[] = [];
	page.on("request", (request) => requested.push(request.url()));
	const app = new AppPage(page);
	await app.goto(relayUrl);
	expect(requested.some((url) => url.includes("mermaid.core-"))).toBe(false);
	const sessionID = new URL(page.url()).pathname.split("/s/")[1];
	expect(sessionID).toBeTruthy();
	mockServer.injectSSEEvents([
		{
			type: "session.text.delta",
			properties: {
				sessionID,
				assistantMessageID: "msg_renderers",
				ordinal: 0,
				delta:
					"```typescript\nconst answer = 42;\n```\n\n```mermaid\ngraph LR\n  Phone --> Conduit\n  Conduit --> OpenCode\n```",
			},
		},
		{ type: "session.idle", properties: { sessionID, outcome: "succeeded" } },
	]);
	await expect(page.locator(".mermaid-diagram svg")).toBeVisible();
	await expect(page.locator("code.language-typescript.hljs")).toBeVisible();
	expect(requested.some((url) => url.includes("mermaid.core-"))).toBe(true);
	await page.screenshot({
		path: `/tmp/conduit-stabilization/verified-${test.info().project.name}.png`,
		fullPage: true,
	});
});

test("a late acceptance clears only the submitted chat's saved draft", async ({
	page,
	relayUrl,
}) => {
	let heldReceipt: string | undefined;
	let browserSocket: WebSocketRoute | undefined;
	await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
		browserSocket = route;
		const server = route.connectToServer();
		server.onMessage((raw) => {
			if (JSON.parse(String(raw)).type === "submission_result")
				heldReceipt = String(raw);
			else route.send(raw);
		});
	});
	const app = new AppPage(page);
	await app.goto(relayUrl);
	const originalPath = new URL(page.url()).pathname;
	await app.sendMessage("Accepted while visiting another chat");
	await expect.poll(() => heldReceipt).toBeTruthy();
	const newSession = page
		.getByRole("button", { name: "New session", exact: true })
		.first();
	if ((page.viewportSize()?.width ?? 1440) < 769)
		await app.hamburgerBtn.click();
	await newSession.click();
	await expect.poll(() => new URL(page.url()).pathname).not.toBe(originalPath);
	await app.input.fill("A newer draft in the other chat");
	if (!heldReceipt || !browserSocket)
		throw new Error("Receipt was not captured");
	browserSocket.send(heldReceipt);
	await expect(app.input).toHaveValue("A newer draft in the other chat");
	const originalChat = page.locator(`a[href="${originalPath}"]`).first();
	if ((page.viewportSize()?.width ?? 1440) < 769)
		await app.hamburgerBtn.click();
	await originalChat.click();
	await expect(app.input).toHaveValue("");
});

async function attachDraftFile(
	page: import("@playwright/test").Page,
	name = "draft-notes.txt",
) {
	await page.locator("#attach-btn").click();
	const chooser = page.waitForEvent("filechooser");
	await page.locator("#attach-files").click();
	await (await chooser).setFiles({
		name,
		mimeType: "text/plain",
		buffer: Buffer.from("Important attachment draft"),
	});
	await expect(page.locator(".paste-file-chip")).toHaveCount(1);
	await expect(
		page.getByText("Saving attachment draft…", { exact: true }),
	).toBeHidden();
}

test("attachment drafts survive reload and explicit removal stays removed", async ({
	page,
	relayUrl,
}) => {
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await attachDraftFile(page);
	await app.input.fill("Keep these notes with this file");
	await page.reload();
	await app.layout.waitFor();
	await app.connectOverlay.waitFor({ state: "hidden" });
	await expect(page.locator(".paste-file-chip")).toHaveCount(1);
	await expect(page.locator(".paste-file-chip")).toContainText(
		"draft-notes.txt",
	);
	await expect(app.input).toHaveValue("Keep these notes with this file");
	await page.locator(".paste-file-chip button").click();
	await expect(
		page.getByText("Saving attachment draft…", { exact: true }),
	).toBeHidden();
	await page.reload();
	await app.layout.waitFor();
	await app.connectOverlay.waitFor({ state: "hidden" });
	await expect(
		page.getByText("Restoring attachments…", { exact: true }),
	).toBeHidden();
	await expect(page.locator(".paste-file-chip")).toHaveCount(0);
});

test("accepted attachments do not return after reopening the chat", async ({
	page,
	relayUrl,
}) => {
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await attachDraftFile(page, "accepted-notes.txt");
	await app.sendMessage("Accept the attached notes");
	await expect(app.input).toHaveValue("");
	await expect(page.locator(".paste-file-chip")).toHaveCount(0);
	await expect(
		page.getByText("Saving attachment draft…", { exact: true }),
	).toBeHidden();
	await page.reload();
	await app.layout.waitFor();
	await app.connectOverlay.waitFor({ state: "hidden" });
	await expect(
		page.getByText("Restoring attachments…", { exact: true }),
	).toBeHidden();
	await expect(page.locator(".paste-file-chip")).toHaveCount(0);
});

test("reload preserves an unconfirmed send ID and manual retry never executes twice", async ({
	page,
	relayUrl,
	mockServer,
}) => {
	const requestIds: string[] = [];
	let firstReceiptDropped = false;
	await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
		const server = route.connectToServer();
		route.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "message") requestIds.push(message.requestId);
			server.send(raw);
		});
		server.onMessage((raw) => {
			if (
				JSON.parse(String(raw)).type === "submission_result" &&
				!firstReceiptDropped
			) {
				firstReceiptDropped = true;
				return;
			}
			route.send(raw);
		});
	});
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await attachDraftFile(page, "recover-me.txt");
	await app.sendMessage("Recover this uncertain submission");
	await expect.poll(() => firstReceiptDropped).toBe(true);
	await page.reload();
	await app.layout.waitFor();
	await app.connectOverlay.waitFor({ state: "hidden" });
	await expect(page.locator(".paste-file-chip")).toHaveCount(1);
	await expect(page.getByText(/A previous send is unconfirmed/)).toBeVisible();
	await expect(app.input).toHaveValue("Recover this uncertain submission");
	expect(requestIds).toHaveLength(1);
	await app.sendBtn.click();
	await expect(app.input).toHaveValue("");
	expect(requestIds).toHaveLength(2);
	expect(requestIds[1]).toBe(requestIds[0]);
	expect(
		mockServer.diagnostics.filter((entry) => entry.event === "prompt"),
	).toHaveLength(1);
	await expect(
		page
			.locator(".msg-user")
			.filter({ hasText: "Recover this uncertain submission" }),
	).toHaveCount(1);
});

test("unavailable attachment storage warns without dropping the selected file", async ({
	page,
	relayUrl,
}) => {
	await page.addInitScript(() =>
		Object.defineProperty(window, "indexedDB", {
			get: () => {
				throw new Error("Storage blocked");
			},
		}),
	);
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await expect(
		page.getByText(/Attachment storage is unavailable/),
	).toBeVisible();
	await attachDraftFile(page, "memory-only.txt");
	await expect(page.locator(".paste-file-chip")).toContainText(
		"memory-only.txt",
	);
});

test("a failed restore cannot erase previously saved attachments", async ({
	page,
	relayUrl,
}) => {
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await attachDraftFile(page, "preserve-on-read-error.txt");
	const savedUrl = page.url();
	await page.addInitScript(() => {
		const original = IDBObjectStore.prototype.get;
		IDBObjectStore.prototype.get = function (key) {
			if (this.name === "attachments")
				throw new DOMException("Storage read failed");
			return original.call(this, key);
		};
	});
	await page.reload();
	await app.layout.waitFor();
	await app.connectOverlay.waitFor({ state: "hidden" });
	await expect(
		page.getByText(/Attachment storage is unavailable/),
	).toBeVisible();
	const freshPage = await page.context().newPage();
	try {
		await new AppPage(freshPage).goto(savedUrl);
		await expect(freshPage.locator(".paste-file-chip")).toHaveAttribute(
			"title",
			/preserve-on-read-error\.txt/,
		);
	} finally {
		await freshPage.close();
	}
});

test("pasted CSS sends literally without requesting nonexistent @media files", async ({
	page,
	relayUrl,
}) => {
	const reads: string[] = [];
	const submissions: string[] = [];
	await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
		const server = route.connectToServer();
		route.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "get_file_content") reads.push(message.path);
			if (message.type === "message") submissions.push(message.text);
			server.send(raw);
		});
	});
	const app = new AppPage(page);
	await app.goto(relayUrl);
	const css =
		"Fix @media/.loraRow/.advanced.\n```css\n@media (max-width: 600px) { .loraRow .advanced { display: none; } }\n@import url(theme.css);\n```";
	await app.sendMessage(css);
	await expect(app.input).toHaveValue("");
	expect(reads).toEqual([]);
	expect(submissions).toEqual([css]);
});

test("a real media-file mention still attaches its contents", async ({
	page,
	relayUrl,
}) => {
	const reads: string[] = [];
	const submissions: string[] = [];
	await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
		const server = route.connectToServer();
		route.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "get_file_content") {
				reads.push(message.path);
				route.send(
					JSON.stringify({
						type: "file_content",
						path: message.path,
						content: ".loraRow .advanced { display: none; }",
					}),
				);
			} else {
				if (message.type === "message") submissions.push(message.text);
				server.send(raw);
			}
		});
	});
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.sendMessage("Please review @media/styles.css");
	await expect(app.input).toHaveValue("");
	expect(reads).toEqual(["media/styles.css"]);
	expect(submissions[0]).toContain('<file path="media/styles.css">');
	expect(submissions[0]).toContain(".loraRow .advanced { display: none; }");
});

test("a conversation render failure keeps the draft and terminal usable", async ({
	page,
	relayUrl,
}) => {
	let socket: WebSocketRoute | undefined;
	await page.routeWebSocket(/\/ws(?:\?|$)/, (route) => {
		socket = route;
		route.connectToServer();
	});
	const app = new AppPage(page);
	await app.goto(relayUrl);
	await app.input.fill("Keep this draft through a display error");
	// Fault injection: an upstream tool argument violates the display schema.
	// It must not take down the composer, sidebar or terminal.
	socket?.send(
		JSON.stringify({ type: "tool_start", id: "bad-display", name: "Bash" }),
	);
	socket?.send(
		JSON.stringify({
			type: "tool_executing",
			id: "bad-display",
			input: { command: { length: 99 } },
		}),
	);
	await expect(
		page.getByText("Conversation display paused", { exact: true }),
	).toBeVisible();
	await expect(app.input).toHaveValue(
		"Keep this draft through a display error",
	);
	await expect
		.poll(() =>
			page.evaluate(() =>
				localStorage.getItem("conduit.last-display-error.v1"),
			),
		)
		.toContain("slice");
	await app.terminalToggleBtn.click();
	await expect(
		page.locator(".term-tab-content:not(.hidden) .xterm-screen"),
	).toBeVisible();
	await page.keyboard.type("RECOVERED_TERMINAL", { delay: 0 });
	await expect(
		page.locator(".term-tab-content:not(.hidden) .xterm-rows"),
	).toContainText("RECOVERED_TERMINAL");
});

test("theme requests cannot hold the app on a blank startup screen", async ({
	page,
	relayUrl,
}) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/api/themes", async (route) => {
		await pending;
		await route.abort();
	});
	try {
		await page.goto(relayUrl, { waitUntil: "domcontentloaded" });
		await expect(page.locator("#layout")).toBeVisible({ timeout: 4000 });
		await expect(page.locator("#boot-screen")).toHaveCount(0);
	} finally {
		release();
	}
});

test("a missing app bundle shows recovery instead of a white screen", async ({
	page,
	relayUrl,
}) => {
	await page.route(/\/assets\/index-[^/]+\.js$/, (route) => route.abort());
	await page.goto(relayUrl);
	await expect(
		page.getByText("Conduit could not open", { exact: true }),
	).toBeVisible();
	await expect(page.locator("#boot-reload")).toBeVisible();
});
