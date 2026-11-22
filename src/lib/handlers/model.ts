// ─── Model Handlers ──────────────────────────────────────────────────────────

import { formatErrorDetail, RelayError } from "../errors.js";
import {
	loadRelaySettings,
	saveRelaySettings,
} from "../relay/relay-settings.js";
import type { PayloadMap } from "./payloads.js";
import { mergeProjectOverlay } from "./project-overlay.js";
import { resolveSession, resolveSessionForLog } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetModels(
	deps: HandlerDeps,
	clientId: string,
	_payload: PayloadMap["get_models"],
): Promise<void> {
	const providerResult = await deps.client.listProviders();
	const connectedSet = new Set(providerResult.connected);
	const providers = providerResult.providers
		.map((p) => ({
			id: p.id || p.name || "",
			name: p.name || p.id || "",
			configured: connectedSet.has(p.id) || connectedSet.has(p.name),
			models: (p.models ?? []).map((m) => ({
				id: m.id,
				name: m.name || m.id,
				provider: p.id || p.name || "",
				...(m.limit && { limit: m.limit }),
				...(m.variants &&
					Object.keys(m.variants).length > 0 && {
						variants: Object.keys(m.variants),
					}),
			})),
		}))
		.filter((p) => p.configured);
	deps.wsHandler.sendTo(clientId, { type: "model_list", providers });

	// Send model_info: prefer session's model, fall back to relay-side selection
	let sentModelInfo = false;
	const activeId = resolveSession(deps, clientId);
	if (activeId) {
		try {
			const session = await deps.client.getSession(activeId);
			if (session.modelID) {
				deps.wsHandler.sendTo(clientId, {
					type: "model_info",
					model: session.modelID,
					provider: session.providerID ?? "",
					sessionId: activeId,
				});
				sentModelInfo = true;
			}
		} catch (err) {
			deps.log.warn(
				`client=${clientId} session=${activeId ?? "?"} Failed to get session model info: ${formatErrorDetail(err)}`,
			);
			deps.wsHandler.sendTo(
				clientId,
				RelayError.fromCaught(
					err,
					"MODEL_ERROR",
					"Failed to get session model info",
				).toMessage(),
			);
		}
	}
	if (!sentModelInfo) {
		const fallbackModel = activeId
			? deps.overrides.getModel(activeId)
			: deps.overrides.defaultModel;
		if (fallbackModel) {
			deps.wsHandler.sendTo(clientId, {
				type: "model_info",
				model: fallbackModel.modelID,
				provider: fallbackModel.providerID,
				...(activeId ? { sessionId: activeId } : {}),
			});
		}
	}

	// Send variant_info for the current model so clients get refreshed state
	const currentVariant = activeId
		? deps.overrides.getVariant(activeId)
		: deps.overrides.defaultVariant;
	const activeModelForVariant = activeId
		? deps.overrides.getModel(activeId)
		: deps.overrides.defaultModel;
	// Fall back to the session's own model when there is no in-memory override,
	// otherwise we would send an empty variant list and the UI would lose options.
	let modelForVariant = activeModelForVariant;
	if (!modelForVariant && activeId) {
		try {
			const session = await deps.client.getSession(activeId);
			if (session.modelID) {
				modelForVariant = {
					providerID: session.providerID ?? "",
					modelID: session.modelID,
				};
			}
		} catch {
			// best effort
		}
	}
	let variantList: string[] = [];
	if (modelForVariant) {
		for (const p of providers) {
			const m = p.models.find((mod) => mod.id === modelForVariant.modelID);
			if (m?.variants) {
				variantList = m.variants;
				break;
			}
		}
	}
	deps.wsHandler.sendTo(clientId, {
		type: "variant_info",
		variant: currentVariant,
		variants: variantList,
		...(activeId ? { sessionId: activeId } : {}),
	});

	// Send the persisted subagent model selection so the UI can show it on load.
	const relaySettings = loadRelaySettings(deps.config.configDir);
	if (relaySettings.subagentModel) {
		const subSlash = relaySettings.subagentModel.indexOf("/");
		const defaultSpec = relaySettings.defaultModel ?? "";
		const defaultSlash = defaultSpec.indexOf("/");
		deps.wsHandler.sendTo(clientId, {
			type: "default_model_info",
			model: defaultSlash > 0 ? defaultSpec.slice(defaultSlash + 1) : "",
			provider: defaultSlash > 0 ? defaultSpec.slice(0, defaultSlash) : "",
			subagentModel: relaySettings.subagentModel.slice(subSlash + 1),
			subagentProvider: relaySettings.subagentModel.slice(0, subSlash),
			subagentVariant: relaySettings.subagentVariant ?? "",
		});
	}

	// Send variant locks for the active model so the UI can show them.
	if (modelForVariant) {
		sendVariantLockInfo(
			deps,
			clientId,
			modelForVariant.providerID,
			modelForVariant.modelID,
			activeId,
		);
	}
}

export async function handleSwitchModel(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["switch_model"],
): Promise<void> {
	const { modelId, providerId, sessionId: payloadSessionId } = payload;
	if (modelId && providerId) {
		const clientSession =
			payloadSessionId ?? deps.wsHandler.getClientSession(clientId);
		if (clientSession) {
			deps.overrides.setModel(clientSession, {
				providerID: providerId,
				modelID: modelId,
			});
			deps.wsHandler.sendTo(clientId, {
				type: "model_info",
				model: modelId,
				provider: providerId,
				sessionId: clientSession,
			});
			deps.wsHandler.sendToSession(clientSession, {
				type: "model_info",
				model: modelId,
				provider: providerId,
				sessionId: clientSession,
			});
		} else {
			// No session assigned — log a warning but don't write to the
			// global sentinel. Setting the global model would poison all
			// sessions (the exact bug that causes "model_not_supported"
			// errors across every session).
			deps.log.warn(
				`client=${clientId} switch_model with no session — ignoring`,
			);
			deps.wsHandler.sendTo(clientId, {
				type: "model_info",
				model: modelId,
				provider: providerId,
			});
		}
		deps.log.info(
			`client=${clientId} session=${resolveSessionForLog(deps, clientId)} Switched to: ${modelId} (${providerId})`,
		);

		// Restore persisted variant for the new model and send variant_info
		const modelKey = `${providerId}/${modelId}`;
		let availableVariants: string[] = [];
		try {
			const providerResult = await deps.client.listProviders();
			for (const p of providerResult.providers) {
				const m = (p.models ?? []).find((mod) => mod.id === modelId);
				if (m?.variants) {
					availableVariants = Object.keys(m.variants);
					break;
				}
			}
		} catch {
			// Silently ignore — variant info is best-effort
		}

		// Look up persisted variant, validate against available list.
		// A locked prime strength for this chat wins over the persisted preference.
		const settings = loadRelaySettings(deps.config.configDir);
		const lockedVariant = clientSession
			? settings.lockedPrimeVariants?.[clientSession]
			: undefined;
		const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
		const validVariant = lockedVariant
			? lockedVariant
			: persistedVariant && availableVariants.includes(persistedVariant)
				? persistedVariant
				: "";

		// Set variant for the session (skip if no session — matches model guard above)
		if (clientSession) {
			deps.overrides.setVariant(clientSession, validVariant);
			deps.wsHandler.sendTo(clientId, {
				type: "variant_info",
				variant: validVariant,
				variants: availableVariants,
				...(lockedVariant ? { locked: true } : {}),
				sessionId: clientSession,
			});
			deps.wsHandler.sendToSession(clientSession, {
				type: "variant_info",
				variant: validVariant,
				variants: availableVariants,
				...(lockedVariant ? { locked: true } : {}),
				sessionId: clientSession,
			});
		} else {
			deps.wsHandler.sendTo(clientId, {
				type: "variant_info",
				variant: validVariant,
				variants: availableVariants,
				...(lockedVariant ? { locked: true } : {}),
			});
		}
		// Refresh the lock indicators for the newly selected model.
		sendVariantLockInfo(deps, clientId, providerId, modelId, clientSession);
	}
}

export async function handleSetDefaultModel(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["set_default_model"],
): Promise<void> {
	const { provider, model } = payload;
	if (!provider || !model) return;

	const modelSpec = `${provider}/${model}`;
	const override = { providerID: provider, modelID: model };
	deps.overrides.setDefaultModel(override);
	saveRelaySettings({ defaultModel: modelSpec }, deps.config.configDir);

	// Also persist to the Conduit-managed project overlay so the setting
	// survives independently of the relay's own settings file.
	try {
		await mergeProjectOverlay(
			deps.config.projectDir,
			{ model: modelSpec },
			deps.log,
		);
	} catch {
		deps.log.warn("Failed to persist default model to OpenCode overlay");
	}

	deps.wsHandler.broadcast({ type: "model_info", model, provider });
	deps.wsHandler.broadcast({
		type: "default_model_info",
		model,
		provider,
	});
	deps.log.info(`client=${clientId} Set default: ${model} (${provider})`);

	// Send variant_info for the new default model
	try {
		const providerResult = await deps.client.listProviders();
		let availableVariants: string[] = [];
		for (const p of providerResult.providers) {
			const m = (p.models ?? []).find((mod) => mod.id === model);
			if (m?.variants) {
				availableVariants = Object.keys(m.variants);
				break;
			}
		}
		const settings = loadRelaySettings(deps.config.configDir);
		const modelKey = `${provider}/${model}`;
		const persistedVariant = settings.defaultVariants?.[modelKey] ?? "";
		const validVariant =
			persistedVariant && availableVariants.includes(persistedVariant)
				? persistedVariant
				: "";
		deps.overrides.defaultVariant = validVariant;
		deps.wsHandler.broadcast({
			type: "variant_info",
			variant: validVariant,
			variants: availableVariants,
		});
	} catch {
		// variant_info is best-effort
	}
}

/** Worker/subagent agents whose model is controlled by the Subagent model setting. */
const WORKER_AGENTS = [
	"explorer",
	"implementer",
	"ui-qa",
	"reviewer",
	"researcher",
	"continuity-editor",
	"copy-editor",
] as const;

/**
 * Set the model used by worker/subagent agents.
 *
 * OpenCode resolves subagent models from its config at process start and does not
 * hot-reload them, so the change is persisted to the project config
 * (opencode.json/opencode.jsonc via the fixup workaround) and takes effect after the
 * next OpenCode reload. The relay also remembers it for the UI.
 */
export async function handleSetSubagentModel(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["set_subagent_model"],
): Promise<void> {
	const { provider, model, variant } = payload;
	if (!provider || !model) return;

	const modelSpec = `${provider}/${model}`;
	const settingsBefore = loadRelaySettings(deps.config.configDir);
	// A locked subagent strength wins over the passed variant.
	const effectiveVariant =
		settingsBefore.lockedSubagentVariants?.[modelSpec] || variant;
	saveRelaySettings(
		{
			subagentModel: modelSpec,
			...(effectiveVariant !== undefined
				? { subagentVariant: effectiveVariant }
				: {}),
		},
		deps.config.configDir,
	);

	try {
		const agentPatch = Object.fromEntries(
			WORKER_AGENTS.map((name) => [
				name,
				{
					model: modelSpec,
					...(effectiveVariant ? { variant: effectiveVariant } : {}),
				},
			]),
		);
		await mergeProjectOverlay(
			deps.config.projectDir,
			{ agent: agentPatch },
			deps.log,
		);
	} catch {
		deps.log.warn("Failed to persist subagent model to OpenCode config");
	}

	const settings = loadRelaySettings(deps.config.configDir);
	const defaultSpec = settings.defaultModel ?? "";
	const slash = defaultSpec.indexOf("/");
	deps.wsHandler.broadcast({
		type: "default_model_info",
		model: slash > 0 ? defaultSpec.slice(slash + 1) : "",
		provider: slash > 0 ? defaultSpec.slice(0, slash) : "",
		subagentModel: model,
		subagentProvider: provider,
		subagentVariant: effectiveVariant ?? settings.subagentVariant ?? "",
	});
	deps.log.info(
		`client=${clientId} Set subagent model: ${modelSpec}${effectiveVariant ? `#${effectiveVariant}` : ""} (applies after OpenCode reload)`,
	);
}

/** Send the current variant locks to one client (prime = this chat, subagent = project). */
function sendVariantLockInfo(
	deps: HandlerDeps,
	clientId: string,
	provider: string,
	model: string,
	sessionId?: string,
): void {
	const settings = loadRelaySettings(deps.config.configDir);
	const modelKey = `${provider}/${model}`;
	deps.wsHandler.sendTo(clientId, {
		type: "variant_lock_info",
		provider,
		model,
		...(sessionId ? { sessionId } : {}),
		prime: sessionId ? settings.lockedPrimeVariants?.[sessionId] || null : null,
		subagent: settings.lockedSubagentVariants?.[modelKey] || null,
		modelDefault: settings.defaultVariants?.[modelKey] || null,
	});
}

/** Set/clear the model-level default strength (used for new chats). */
export async function handleSetModelDefault(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["set_model_default"],
): Promise<void> {
	const { provider, model, variant } = payload;
	if (!provider || !model) return;
	const modelKey = `${provider}/${model}`;
	saveRelaySettings(
		{ defaultVariants: { [modelKey]: variant ?? "" } },
		deps.config.configDir,
	);
	sendVariantLockInfo(deps, clientId, provider, model, payload.sessionId);
	deps.log.info(
		`client=${clientId} ${variant ? `Set model default strength ${variant}` : "Cleared model default strength"} for ${modelKey}`,
	);
}

export async function handleSetVariantLock(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["set_variant_lock"],
): Promise<void> {
	const { provider, model, scope, locked, variant } = payload;
	if (!provider || !model) return;
	const modelKey = `${provider}/${model}`;
	const sessionId = payload.sessionId ?? resolveSession(deps, clientId);
	const settings = loadRelaySettings(deps.config.configDir);
	const currentSubagent = settings.lockedSubagentVariants?.[modelKey];

	// Prime locks are per chat (keyed by session); subagent locks are per project
	// (OpenCode reads agent models at process start, so they cannot be per chat).
	// Removing a lock uses an empty-string sentinel so the merge keeps working.
	const primeValue =
		scope === "prime" ? (locked ? (variant ?? "") : "") : undefined;
	const subagentValue =
		scope === "subagent" ? (locked ? (variant ?? "") : "") : undefined;

	if (primeValue !== undefined && !sessionId) {
		deps.log.warn(
			`client=${clientId} set_variant_lock(prime) without a session — ignoring`,
		);
		return;
	}

	if (primeValue !== undefined || subagentValue !== undefined) {
		saveRelaySettings(
			{
				...(primeValue !== undefined && sessionId
					? { lockedPrimeVariants: { [sessionId]: primeValue } }
					: {}),
				...(subagentValue !== undefined
					? { lockedSubagentVariants: { [modelKey]: subagentValue } }
					: {}),
			},
			deps.config.configDir,
		);
	}

	// When locking the prime strength, apply it to this chat immediately.
	if (scope === "prime" && locked && variant !== undefined && sessionId) {
		deps.overrides.setVariant(sessionId, variant);
	}

	const primeNow = sessionId
		? (loadRelaySettings(deps.config.configDir).lockedPrimeVariants?.[
				sessionId
			] ?? null)
		: null;
	const subagentNow =
		scope === "subagent"
			? locked
				? (variant ?? "")
				: null
			: (currentSubagent ?? null);

	const lockMessage = {
		type: "variant_lock_info" as const,
		provider,
		model,
		...(sessionId ? { sessionId } : {}),
		prime: primeNow,
		subagent: subagentNow,
		modelDefault:
			loadRelaySettings(deps.config.configDir).defaultVariants?.[modelKey] ||
			null,
	};
	deps.wsHandler.sendTo(clientId, lockMessage);
	if (scope === "prime" && sessionId) {
		deps.wsHandler.sendToSession(sessionId, lockMessage);
	} else if (scope === "subagent") {
		// Project-wide setting: keep every open tab in sync.
		deps.wsHandler.broadcast(lockMessage);
	}
	deps.log.info(
		`client=${clientId} ${locked ? "Locked" : "Unlocked"} ${scope} strength for ${scope === "prime" ? `session ${sessionId}` : modelKey}`,
	);
}

export async function handleSwitchVariant(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["switch_variant"],
): Promise<void> {
	let { variant } = payload;
	const sessionId = payload.sessionId ?? resolveSession(deps, clientId);

	// Resolve active model — per-session override first, then the OpenCode
	// session's own model, then the global default.
	let activeModel = sessionId
		? deps.overrides.getModel(sessionId)
		: deps.overrides.defaultModel;
	if (!activeModel && sessionId) {
		try {
			const session = await deps.client.getSession(sessionId);
			if (session.modelID) {
				activeModel = {
					providerID: session.providerID ?? "",
					modelID: session.modelID,
				};
			}
		} catch {
			// Best effort — locks degrade to no-op when the model is unknown.
		}
	}

	// A locked prime strength (per chat) overrides whatever was requested.
	let locked = false;
	const settings = loadRelaySettings(deps.config.configDir);
	if (sessionId) {
		const lockedVariant = settings.lockedPrimeVariants?.[sessionId];
		if (lockedVariant) {
			locked = true;
			variant = lockedVariant;
		}
	}

	if (sessionId) {
		deps.overrides.setVariant(sessionId, variant);
		// Per-chat strength is independent: remember it for this session only.
		saveRelaySettings(
			{ sessionVariants: { [sessionId]: variant } },
			deps.config.configDir,
		);
	} else {
		// No session — set the global default variant so new sessions inherit it
		deps.overrides.defaultVariant = variant;
		// Model-level default is only updated from an explicit no-session change,
		// never as a side effect of one chat (that leaked across chats before).
		if (activeModel && !locked) {
			const modelKey = `${activeModel.providerID}/${activeModel.modelID}`;
			saveRelaySettings(
				{ defaultVariants: { [modelKey]: variant } },
				deps.config.configDir,
			);
		}
	}

	// Send variant_info to all clients viewing this session
	// so other tabs stay in sync
	let availableVariants: string[] = [];
	if (activeModel) {
		try {
			const providerResult = await deps.client.listProviders();
			for (const p of providerResult.providers) {
				const m = (p.models ?? []).find(
					(mod) => mod.id === activeModel.modelID,
				);
				if (m?.variants) {
					availableVariants = Object.keys(m.variants);
					break;
				}
			}
		} catch (err) {
			deps.log.warn(
				`Failed to fetch variant list: ${err instanceof Error ? err.message : err}`,
			);
		}
	}
	if (sessionId) {
		deps.wsHandler.sendTo(clientId, {
			type: "variant_info",
			variant,
			variants: availableVariants,
			...(locked ? { locked: true } : {}),
			sessionId,
		});
		deps.wsHandler.sendToSession(sessionId, {
			type: "variant_info",
			variant,
			variants: availableVariants,
			...(locked ? { locked: true } : {}),
			sessionId,
		});
	} else {
		deps.wsHandler.sendTo(clientId, {
			type: "variant_info",
			variant,
			variants: availableVariants,
			...(locked ? { locked: true } : {}),
		});
	}
	deps.log.info(
		`client=${clientId} session=${sessionId ?? "?"} Switched variant to: ${variant || "default"}${locked ? " (locked)" : ""}`,
	);
}
