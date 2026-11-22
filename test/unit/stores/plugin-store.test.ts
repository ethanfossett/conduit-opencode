// ─── Plugin store ────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkPlugins,
	clearPluginState,
	handlePluginList,
	handlePluginUpdated,
	outdatedTargets,
	pluginOutdated,
	pluginSourceLabel,
	pluginState,
	pluginStateLabel,
	pluginTarget,
	pluginUpdating,
	requestPlugins,
	updatePlugins,
} from "../../../src/lib/frontend/stores/plugin.svelte.js";
import type { PluginInfo } from "../../../src/lib/shared-types.js";

const PACKAGE_PLUGIN: PluginInfo = {
	id: "opencode.example",
	source: {
		type: "package",
		target: "example-plugin",
		version: "1.0.0",
		outdated: true,
	},
	state: { status: "active" },
};

const BUILTIN_PLUGIN: PluginInfo = {
	id: "opencode.builtin",
	source: { type: "builtin" },
	state: { status: "active" },
};

const FAILED_PLUGIN: PluginInfo = {
	id: "opencode.broken",
	source: { type: "local", path: "/tmp/broken.js" },
	state: { status: "failed", error: "boom" },
};

beforeEach(() => {
	clearPluginState();
});

describe("handlers and helpers", () => {
	it("stores the plugin list and marks it loaded", () => {
		handlePluginList({
			type: "plugin_list",
			plugins: [PACKAGE_PLUGIN, BUILTIN_PLUGIN],
		});
		expect(pluginState.plugins).toHaveLength(2);
		expect(pluginState.loaded).toBe(true);
	});

	it("labels sources and states", () => {
		expect(pluginSourceLabel(BUILTIN_PLUGIN)).toBe("Built-in");
		expect(pluginSourceLabel(PACKAGE_PLUGIN)).toBe("Package · v1.0.0");
		expect(pluginSourceLabel(FAILED_PLUGIN)).toBe("Local · /tmp/broken.js");
		expect(pluginStateLabel(FAILED_PLUGIN)).toBe("Failed");
	});

	it("identifies outdated package plugins", () => {
		expect(pluginOutdated(PACKAGE_PLUGIN)).toBe(true);
		expect(pluginOutdated(BUILTIN_PLUGIN)).toBe(false);
		expect(outdatedTargets([PACKAGE_PLUGIN, BUILTIN_PLUGIN])).toEqual([
			"example-plugin",
		]);
		expect(pluginTarget(PACKAGE_PLUGIN)).toBe("example-plugin");
		expect(pluginTarget(BUILTIN_PLUGIN)).toBeUndefined();
	});

	it("tracks in-flight updates and clears them on the refreshed list", () => {
		pluginState.updating = ["example-plugin"];
		expect(pluginUpdating(PACKAGE_PLUGIN)).toBe(true);
		// Refreshed list has updating=false → tracking is dropped.
		handlePluginList({
			type: "plugin_list",
			plugins: [{ ...PACKAGE_PLUGIN, source: { ...PACKAGE_PLUGIN.source } }],
		});
		expect(pluginState.updating).toEqual([]);
		expect(
			pluginUpdating({
				...PACKAGE_PLUGIN,
				source: { ...PACKAGE_PLUGIN.source },
			}),
		).toBe(false);
	});

	it("plugin_updated clears tracking for the reported targets", () => {
		pluginState.updating = ["a", "b"];
		handlePluginUpdated({ type: "plugin_updated", targets: ["a"], ok: true });
		expect(pluginState.updating).toEqual(["b"]);
	});
});

describe("actions", () => {
	it("requestPlugins sends list_plugins and clears checking", () => {
		const send = vi.fn();
		pluginState.checking = true;
		requestPlugins(send);
		expect(send).toHaveBeenCalledWith({ type: "list_plugins" });
		expect(pluginState.checking).toBe(false);
	});

	it("checkPlugins sets the busy flag and includes the target", () => {
		const send = vi.fn();
		checkPlugins(send, "example-plugin");
		expect(pluginState.checking).toBe(true);
		expect(send).toHaveBeenCalledWith({
			type: "check_plugins",
			target: "example-plugin",
		});
	});

	it("updatePlugins dedupes targets and tracks them", () => {
		const send = vi.fn();
		updatePlugins(send, ["a", "a", "b"]);
		expect(send).toHaveBeenCalledWith({
			type: "update_plugins",
			targets: ["a", "b"],
		});
		expect(pluginState.updating).toEqual(["a", "b"]);
	});

	it("updatePlugins ignores an empty list", () => {
		const send = vi.fn();
		updatePlugins(send, []);
		expect(send).not.toHaveBeenCalled();
	});
});
