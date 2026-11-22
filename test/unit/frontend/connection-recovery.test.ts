import { afterEach, expect, it, vi } from "vitest";
import { installConnectionRecovery } from "../../../src/lib/frontend/utils/connection-recovery.js";

afterEach(() => vi.unstubAllGlobals());
it("recovers foreground, network and restored-page sessions and cleans up", () => {
	const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
	const win = new EventTarget();
	vi.stubGlobal("document", doc);
	vi.stubGlobal("window", win);
	const recover = vi.fn();
	const cleanup = installConnectionRecovery(recover);
	doc.dispatchEvent(new Event("visibilitychange"));
	expect(recover).not.toHaveBeenCalled();
	doc.visibilityState = "hidden";
	doc.dispatchEvent(new Event("visibilitychange"));
	win.dispatchEvent(new Event("online"));
	expect(recover).not.toHaveBeenCalled();
	doc.visibilityState = "visible";
	doc.dispatchEvent(new Event("visibilitychange"));
	win.dispatchEvent(new Event("online"));
	win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
	expect(recover).toHaveBeenCalledTimes(3);
	cleanup();
	win.dispatchEvent(new Event("online"));
	expect(recover).toHaveBeenCalledTimes(3);
});
