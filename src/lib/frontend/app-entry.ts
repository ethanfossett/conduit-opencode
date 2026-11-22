import { mount } from "svelte";
import App from "./App.svelte";
import { initTheme } from "./stores/theme.svelte.js";
import { initSWNavigationListener } from "./stores/ws-notifications.js";
import { recordDisplayError } from "./utils/display-error.js";

const target = document.getElementById("app");
if (!target) throw new Error("Missing #app mount point");

// Initialize theme before mount to avoid flash of unstyled content.
// The inline script in index.html applies cached vars instantly; this
// loads the full theme list from the server and reconciles state.
// Cached theme variables are already applied by index.html. Network theme
// loading must not block mounting the composer and connection controls.
mount(App, { target });
document.getElementById("boot-screen")?.remove();
void initTheme().catch(recordDisplayError);
window.addEventListener("error", (event) => {
	if (event.error) recordDisplayError(event.error);
});
window.addEventListener("unhandledrejection", (event) =>
	recordDisplayError(event.reason),
);
initSWNavigationListener();

// Offline navigation works independently of notification permission. Never
// request push permission or reload the current page during worker updates.
if (
	"serviceWorker" in navigator &&
	window.isSecureContext &&
	!import.meta.env.DEV
) {
	void navigator.serviceWorker
		.register("/sw.js", { scope: "/", updateViaCache: "none" })
		.catch((error: unknown) => {
			console.warn("[pwa] Service worker registration failed:", error);
		});
}
