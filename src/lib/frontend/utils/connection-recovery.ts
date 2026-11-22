/** Mobile browsers suspend sockets without delivering close events. Reconnect on
 * return to the foreground, restored pages, or network return, then let the
 * normal server initialization reconcile durable session state. */
export function installConnectionRecovery(recover: () => void): () => void {
	if (typeof document === "undefined" || typeof window === "undefined")
		return () => {};
	let wasHidden = document.visibilityState === "hidden";
	const visibility = () => {
		if (document.visibilityState === "hidden") {
			wasHidden = true;
		} else if (wasHidden) {
			wasHidden = false;
			recover();
		}
	};
	const online = () => {
		if (document.visibilityState !== "hidden") recover();
	};
	const pageshow = (event: PageTransitionEvent) => {
		if (event.persisted) online();
	};
	document.addEventListener("visibilitychange", visibility);
	window.addEventListener("online", online);
	window.addEventListener("pageshow", pageshow);
	return () => {
		document.removeEventListener("visibilitychange", visibility);
		window.removeEventListener("online", online);
		window.removeEventListener("pageshow", pageshow);
	};
}
