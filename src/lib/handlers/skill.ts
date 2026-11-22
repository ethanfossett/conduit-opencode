// ─── Skill Handlers ──────────────────────────────────────────────────────────
// Discovery + activation for v2 skills:
//   GET  /api/skill                              → list registered skills
//   POST /api/experimental/session/{id}/skill    → activate a skill
// Activation appends a skill message and resumes execution, so it mirrors the
// processing bookkeeping used by handleMessage / handleRunCommand.

import { formatErrorDetail, RelayError } from "../errors.js";
import type { PayloadMap } from "./payloads.js";
import { resolveSession } from "./resolve-session.js";
import type { HandlerDeps } from "./types.js";

export async function handleGetSkills(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["get_skills"],
): Promise<void> {
	try {
		const skills = await deps.client.listSkills(
			payload.directory ?? deps.config.projectDir,
		);
		deps.wsHandler.sendTo(clientId, { type: "skill_list", skills });
	} catch (err) {
		deps.log.warn(
			`client=${clientId} Failed to list skills: ${formatErrorDetail(err)}`,
		);
		deps.wsHandler.sendTo(clientId, { type: "skill_list", skills: [] });
	}
}

export async function handleActivateSkill(
	deps: HandlerDeps,
	clientId: string,
	payload: PayloadMap["activate_skill"],
): Promise<void> {
	const sessionId = payload.sessionId ?? resolveSession(deps, clientId);
	if (!sessionId) {
		deps.wsHandler.sendTo(
			clientId,
			new RelayError(
				"No active session. Create or switch to a session first.",
				{ code: "NO_SESSION" },
			).toMessage(),
		);
		return;
	}
	const skillId = payload.skillId;
	if (!skillId) return;

	deps.log.info(`client=${clientId} session=${sessionId} → skill ${skillId}`);
	deps.sessionMgr.recordMessageActivity(sessionId);

	// A skill activation resumes execution server-side, so surface the same
	// "processing" affordances as a normal message send.
	deps.wsHandler.sendToSession(sessionId, {
		type: "status",
		status: "processing",
	});
	deps.overrides.startProcessingTimeout(sessionId, () => {
		deps.log.warn(
			`client=${clientId} session=${sessionId} Skill processing timeout (120s) — broadcasting done`,
		);
		deps.wsHandler.sendToSession(sessionId, {
			type: "done",
			code: 1,
		});
	});

	try {
		await deps.client.activateSkill(sessionId, skillId, {
			...(payload.resume !== undefined && { resume: payload.resume }),
		});
	} catch (err) {
		deps.log.warn(
			`client=${clientId} session=${sessionId} Failed to activate skill ${skillId}: ${formatErrorDetail(err)}`,
		);
		deps.overrides.clearProcessingTimeout(sessionId);
		deps.wsHandler.sendToSession(sessionId, { type: "done", code: 1 });
		deps.wsHandler.sendTo(
			clientId,
			RelayError.fromCaught(
				err,
				"SKILL_ACTIVATE_FAILED",
				"Failed to activate skill",
			).toMessage(),
		);
	}
}
