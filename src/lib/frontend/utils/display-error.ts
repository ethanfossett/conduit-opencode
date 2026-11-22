/** Keep a bounded, device-local diagnostic without copying chat or draft state. */
export function recordDisplayError(error: unknown): void {
	console.error("[conduit] Display error", error);
	try {
		const detail = error instanceof Error ? error : new Error(String(error));
		localStorage.setItem(
			"conduit.last-display-error.v1",
			JSON.stringify({
				at: new Date().toISOString(),
				message: detail.message.slice(0, 500),
				stack: detail.stack?.slice(0, 2000),
				path: window.location.pathname,
			}),
		);
	} catch {
		// Recovery must still work when device storage is unavailable.
	}
}
