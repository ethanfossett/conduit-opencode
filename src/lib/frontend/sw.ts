// ─── Service Worker ──────────────────────────────────────────────────────────
// Handles push notifications and provides a self-contained offline screen.

import type { PermissionId } from "../shared-types.js";

declare const self: ServiceWorkerGlobalScope;

// The offline screen is embedded in the worker and needs no network assets.
// Never cache authenticated HTML, API responses or conversation content.
const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#18181b"><title>Conduit — Offline</title>
<style>html{color-scheme:dark;background:#18181b;color:#fafafa;font:17px/1.6 system-ui}body{max-width:30rem;margin:15vh auto;padding:24px}h1{font-size:1.8rem}p{color:#d4d4d8}a{display:inline-block;background:#fafafa;color:#18181b;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:600}a:focus-visible{outline:3px solid #a78bfa;outline-offset:4px}</style>
<h1>Conduit is offline</h1><p>Reconnect to your network and make sure the Conduit server is available, then try again.</p>
<p>Text drafts saved on this device will be available when you reconnect.</p><a href="">Try again</a></html>`;

self.addEventListener("install", (event: ExtendableEvent) => {
	// No cached asset set to mix with existing clients. Activation never reloads
	// an open chat or interrupts its draft.
	event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event: ExtendableEvent) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys
						.filter((key) => key.startsWith("conduit-shell-"))
						.map((key) => caches.delete(key)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event: FetchEvent) => {
	const request = event.request;
	if (request.method !== "GET" || request.mode !== "navigate") return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;
	// Only application routes get HTML fallbacks, including authenticated deep links.
	if (
		!(
			url.pathname === "/" ||
			url.pathname === "/auth" ||
			url.pathname === "/chat" ||
			url.pathname === "/chat/" ||
			url.pathname === "/setup" ||
			/^\/p\/[^/]+(?:\/s\/[^/]+)?\/?$/.test(url.pathname)
		)
	)
		return;
	event.respondWith(
		fetch(request).catch(
			() =>
				new Response(OFFLINE_PAGE, {
					status: 503,
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Cache-Control": "no-store",
					},
				}),
		),
	);
});

// ─── Push: show notification ─────────────────────────────────────────────

interface PushPayload {
	type?: string;
	title?: string;
	body?: string;
	tag?: string;
	url?: string;
	requestId?: PermissionId;
	slug?: string;
	sessionId?: string;
}

self.addEventListener("push", (event: PushEvent) => {
	let data: PushPayload = {};
	try {
		data = event.data?.json() ?? {};
	} catch {
		return;
	}

	// Silent validation push — do not show notification
	if (data.type === "test") return;

	const options: NotificationOptions = {
		body: data.body ?? "",
		tag: data.tag ?? "conduit",
		data,
	};

	// Permission requests and errors need user interaction
	if (data.type === "permission_request") {
		options.requireInteraction = true;
		options.tag = `perm-${data.requestId ?? "unknown"}`;
	} else if (data.type === "error") {
		options.requireInteraction = true;
		options.tag = "opencode-error";
	} else if (data.type === "done") {
		options.tag = data.tag ?? "opencode-done";
	}

	// Always show the notification — no visibility suppression.
	// When push is enabled, browser Notification API alerts are already
	// suppressed client-side (_pushActive flag in ws-notifications.ts).
	// The SW is the sole notification path for push users, so it must
	// always display; otherwise there's a dead zone where neither
	// browser nor push notifications fire when the tab is visible.
	event.waitUntil(
		self.registration
			.showNotification(data.title ?? "Conduit", options)
			.catch((err: unknown) => {
				console.warn("[sw] Failed to show notification:", err);
			}),
	);
});

// ─── Notification click: focus or open relay ─────────────────────────────

/** Post a navigate_to_session message to a client. Swallows errors
 *  (client may have closed between matchAll and postMessage). */
function postNavigate(
	client: { postMessage(message: unknown): void },
	data: PushPayload,
	targetUrl: string,
): void {
	try {
		client.postMessage({
			type: "navigate_to_session",
			sessionId: data.sessionId,
			slug: data.slug,
			url: targetUrl,
		});
	} catch {
		// Client may have closed — non-fatal
	}
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
	const data: PushPayload = event.notification.data ?? {};
	event.notification.close();

	const baseUrl = new URL(self.registration.scope || "/", self.location.origin)
		.href;

	// Build target URL with session specificity when available
	let targetUrl: string;
	if (data.url) {
		try {
			const target = new URL(data.url, baseUrl);
			targetUrl =
				target.origin === self.location.origin ? target.href : baseUrl;
		} catch {
			targetUrl = baseUrl;
		}
	} else if (data.slug && data.sessionId) {
		targetUrl = `${baseUrl}p/${encodeURIComponent(data.slug)}/s/${encodeURIComponent(data.sessionId)}`;
	} else if (data.slug) {
		targetUrl = `${baseUrl}p/${encodeURIComponent(data.slug)}/`;
	} else {
		targetUrl = baseUrl;
	}

	const projectPrefix = data.slug
		? `${baseUrl}p/${encodeURIComponent(data.slug)}/`
		: null;

	event.waitUntil(
		self.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clientList) => {
				// Prefer a client already on the exact URL
				for (const client of clientList) {
					if (client.url === targetUrl) {
						return client.focus();
					}
				}
				// Client on the same project — tell it to navigate to the session
				if (projectPrefix && data.sessionId) {
					for (const client of clientList) {
						if (client.url.startsWith(projectPrefix)) {
							postNavigate(client, data, targetUrl);
							return client.focus();
						}
					}
				}
				// Fall back to any visible client — navigate it
				for (const client of clientList) {
					if (client.visibilityState !== "hidden") {
						postNavigate(client, data, targetUrl);
						return client.focus();
					}
				}
				// Fall back to any client
				if (clientList.length > 0) {
					postNavigate(clientList[0], data, targetUrl);
					return clientList[0].focus();
				}
				// Open a new window
				return self.clients.openWindow(targetUrl);
			}),
	);
});
