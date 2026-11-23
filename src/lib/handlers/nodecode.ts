import { OpenCodeApiError } from "../errors.js";
import {
	NODECODE_MODEL_ID,
	NODECODE_PROVIDER_ID,
	type NodecodeStatus,
	nodecodeModel,
} from "../nodecode.js";
import type { PayloadMap } from "./payloads.js";
import type { HandlerDeps } from "./types.js";

export async function handleNodecode(
	deps: HandlerDeps,
	clientId: string,
	{ action, requestId, key }: PayloadMap["nodecode_setup"],
): Promise<void> {
	let serverVersion: string | undefined;
	const reply = (status: NodecodeStatus, message?: string) => {
		deps.wsHandler.sendTo(clientId, {
			type: "nodecode_status",
			requestId,
			status,
			...(serverVersion && { serverVersion }),
			...(message && { message }),
		});
	};

	async function replyUnavailable() {
		if (await deps.client.hasConfiguredProvider(NODECODE_PROVIDER_ID)) {
			reply(
				"unsupported",
				"NodeCode is configured but has no available integration in this project. Reload OpenCode’s configuration and check the project’s provider settings. OpenCode 2.3.2 supports this flow.",
			);
		} else {
			reply("needs_config");
		}
	}

	let saved = false;
	try {
		const [integrations, serverInfo] = await Promise.all([
			deps.client.listIntegrations(),
			action === "status"
				? deps.client.getServerInfo().catch(() => undefined)
				: undefined,
		]);
		serverVersion = serverInfo?.version;
		// Some servers expose configured integrations in the scoped catalog
		// before the individual integration route returns the same entry.
		const integration = integrations.find(
			(entry) => entry.id === NODECODE_PROVIDER_ID,
		);
		if (action === "connect") {
			const trimmedKey = key?.trim();
			if (!trimmedKey || !/^sk-nc-[A-Za-z0-9_-]+$/.test(trimmedKey)) {
				reply(
					"error",
					"Enter a regular NodeCode API key starting with sk-nc-.",
				);
				return;
			}
			if (!integration?.methods.some((method) => method.type === "key")) {
				await replyUnavailable();
				return;
			}
			await deps.client.integrationConnectKey(NODECODE_PROVIDER_ID, {
				key: trimmedKey,
			});
			saved = true;
		}

		const hasConnection =
			saved ||
			integration?.connections.some(
				(connection) => connection.active !== false,
			);
		// Some OpenCode versions list configured models before a key is connected.
		if (
			integration?.methods.some((method) => method.type === "key") &&
			!hasConnection
		) {
			reply("needs_key");
			return;
		}

		const { providers, connected } = await deps.client.listProviders();
		const available =
			connected.includes(NODECODE_PROVIDER_ID) &&
			providers.some(
				(p) =>
					p.id === NODECODE_PROVIDER_ID &&
					p.models?.some((model) => model.id === NODECODE_MODEL_ID),
			);

		if (available) {
			if (action === "test") {
				const text = await deps.client.generateText(
					nodecodeModel,
					"Reply with OK.",
				);
				if (!text.trim()) {
					reply("error", "NodeCode returned an empty reply. Try again.");
					return;
				}
				reply("test_passed");
				return;
			}
			reply("model_available");
			return;
		}

		if (hasConnection) {
			reply("key_saved");
		} else if (integration) {
			reply("needs_key");
		} else {
			await replyUnavailable();
		}
	} catch (err) {
		// Upstream error bodies can contain credentials or inference content.
		// Present only fixed messages and a numeric HTTP status.
		const code =
			err instanceof OpenCodeApiError ? err.responseStatus : undefined;
		if (saved) {
			reply(
				"key_saved",
				"OpenCode saved the key. Refresh to check whether the model is available.",
			);
		} else if (action === "test") {
			reply(
				"error",
				code === 402
					? "NodeCode account credit is required."
					: code === 401 || code === 403
						? "NodeCode rejected the request. Check your regular API key and account access."
						: code === 429
							? "NodeCode rate limited the test. Try again shortly."
							: "OpenCode could not complete the NodeCode test. Check the server and try again.",
			);
		} else {
			reply(
				"error",
				action === "connect"
					? "OpenCode could not save the key. Refresh to check your connection before retrying."
					: "Could not check NodeCode on this OpenCode server. Refresh to try again.",
			);
		}
	}
}
