// ─── Notification Utilities ──────────────────────────────────────────────────
// Push subscription management and service worker registration.
// Pure functions — integrates with service worker.

/**
 * Full push subscription lifecycle: register SW, fetch VAPID key,
 * subscribe browser, and register with server.
 *
 * Uses the registration object directly — never touches
 * navigator.serviceWorker.ready which can hang indefinitely.
 * Lets actual browser errors propagate so callers see the real reason.
 */
export async function enablePushSubscription(): Promise<PushSubscriptionJSON> {
	if (!("serviceWorker" in navigator)) {
		throw new Error("Service workers are not supported in this browser.");
	}

	// Register directly — let the real browser error propagate
	const reg = await navigator.serviceWorker.register("/sw.js", {
		scope: "/",
	});

	// Wait for the SW to activate (pushManager.subscribe requires it).
	// Uses statechange events instead of navigator.serviceWorker.ready
	// which can hang indefinitely if activation fails.
	if (!reg.active) {
		await new Promise<void>((resolve, reject) => {
			const sw = reg.installing ?? reg.waiting;
			if (!sw) {
				reject(new Error("Service worker not found after registration."));
				return;
			}
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				clearTimeout(timer);
				sw.removeEventListener("statechange", onStateChange);
			};
			const onStateChange = (): void => {
				if (sw.state === "activated") {
					cleanup();
					resolve();
				} else if (sw.state === "redundant") {
					cleanup();
					reject(new Error("Service worker failed to activate."));
				}
			};
			sw.addEventListener("statechange", onStateChange);
			timer = setTimeout(() => {
				cleanup();
				reject(new Error("Service worker activation timed out."));
			}, 10_000);
			onStateChange();
		});
	}

	// Fetch VAPID public key from server
	const resp = await fetch("/api/push/vapid-key");
	if (!resp.ok) throw new Error("Failed to fetch VAPID key from server");
	const { publicKey } = (await resp.json()) as { publicKey: string };

	// Reuse a subscription made with the current VAPID key. Only rotate when
	// necessary; disabling a working endpoint on every retry creates gaps.
	const applicationServerKey = urlBase64ToUint8Array(publicKey);
	let subscription = await reg.pushManager.getSubscription();
	const existingKey = subscription?.options?.applicationServerKey;
	const matches =
		existingKey != null &&
		new Uint8Array(existingKey).length === applicationServerKey.length &&
		new Uint8Array(existingKey).every(
			(byte, index) => byte === applicationServerKey[index],
		);
	if (subscription && !matches) {
		await subscription.unsubscribe();
		subscription = null;
	}
	if (!subscription) {
		subscription = await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey,
		});
	}

	// Register subscription with server
	const registered = await fetch("/api/push/subscribe", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ subscription: subscription.toJSON() }),
	});

	if (!registered.ok) {
		throw new Error(
			"The server could not register notifications. Try enabling them again.",
		);
	}

	// Storage is a rotation hint, not a prerequisite for a valid subscription.
	try {
		localStorage.setItem("vapid-public-key", publicKey);
	} catch {
		// Private browsing and full storage must not invalidate working push.
	}

	return subscription.toJSON();
}

/**
 * Convert a base64url-encoded string (VAPID key) to a Uint8Array
 * for use with PushManager.subscribe().
 */
export function urlBase64ToUint8Array(
	base64String: string,
): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
	const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
	const rawData = atob(base64);
	const outputArray = new Uint8Array(rawData.length);
	for (let i = 0; i < rawData.length; i++) {
		outputArray[i] = rawData.charCodeAt(i);
	}
	return outputArray;
}
