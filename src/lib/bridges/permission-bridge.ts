// ─── Permission Bridge (Ticket 1.5) ─────────────────────────────────────────

import { isPermissionAskedEvent } from "../relay/opencode-events.js";
import type { PermissionId } from "../shared-types.js";
import type {
	FrontendDecision,
	OpenCodeDecision,
	OpenCodeEvent,
	PendingPermission,
} from "../types.js";

// ─── Decision Mapping ───────────────────────────────────────────────────────

const DECISION_MAP: Record<FrontendDecision, OpenCodeDecision> = {
	allow: "once",
	deny: "reject",
	allow_always: "always",
};

const REVERSE_DECISION_MAP: Record<OpenCodeDecision, FrontendDecision> = {
	once: "allow",
	reject: "deny",
	always: "allow_always",
};

/** Map frontend decision vocabulary → OpenCode vocabulary */
export function mapDecision(frontend: string): OpenCodeDecision | null {
	return DECISION_MAP[frontend as FrontendDecision] ?? null;
}

/** Map OpenCode decision vocabulary → frontend vocabulary */
export function mapDecisionReverse(opencode: string): FrontendDecision | null {
	return REVERSE_DECISION_MAP[opencode as OpenCodeDecision] ?? null;
}

// ─── Permission Bridge ──────────────────────────────────────────────────────

export interface PermissionBridgeOptions {
	timeoutMs?: number;
	now?: () => number;
}

export class PermissionBridge {
	private pending: Map<string, PendingPermission> = new Map();
	private readonly timeoutMs: number;
	private readonly now: () => number;

	constructor(options: PermissionBridgeOptions = {}) {
		this.timeoutMs = options.timeoutMs ?? 5 * 60_000; // 5 minutes
		this.now = options.now ?? Date.now;
	}

	/** Process an incoming permission.asked SSE event (v2 shape) */
	onPermissionRequest(event: OpenCodeEvent): PendingPermission | null {
		if (!isPermissionAskedEvent(event)) return null;
		const props = event.properties;

		if (!props.id || !props.action) return null;

		const entry: PendingPermission = {
			requestId: props.id as PermissionId,
			sessionId: props.sessionID ?? "",
			toolName: props.action,
			toolInput: {
				patterns: props.resources ?? [],
				metadata: props.metadata ?? {},
			},
			always: props.save ?? [],
			timestamp: this.now(),
		};

		this.pending.set(props.id, entry);
		return entry;
	}

	/** Process a user's permission decision from the browser */
	onPermissionResponse(
		requestId: string,
		decision: string,
	): { mapped: OpenCodeDecision; toolName: string } | null {
		const entry = this.pending.get(requestId);
		if (!entry) return null; // Already resolved or unknown — ignore duplicate

		const mapped = mapDecision(decision);
		if (!mapped) return null;

		this.pending.delete(requestId);
		return { mapped, toolName: entry.toolName };
	}

	/** Handle a permission.replied SSE event (resolved from CLI) */
	onPermissionReplied(requestId: string): boolean {
		return this.pending.delete(requestId);
	}

	/** Get all pending permissions (for replay on reconnect) */
	getPending(): PendingPermission[] {
		return Array.from(this.pending.values());
	}

	/** Check for timed-out permissions and return their IDs */
	checkTimeouts(): string[] {
		const now = this.now();
		const timedOut: string[] = [];

		for (const [id, entry] of this.pending) {
			if (now - entry.timestamp >= this.timeoutMs) {
				timedOut.push(id);
				this.pending.delete(id);
			}
		}

		return timedOut;
	}

	/** Recover pending permissions from the v2 REST API response */
	recoverPending(
		permissions: Array<{
			id: string;
			permission?: string;
			action?: string;
			sessionId?: string;
			sessionID?: string;
			patterns?: string[];
			resources?: string[];
			metadata?: Record<string, unknown>;
			always?: string[];
			save?: string[];
		}>,
	): PendingPermission[] {
		const recovered: PendingPermission[] = [];
		for (const p of permissions) {
			const entry: PendingPermission = {
				requestId: p.id as PermissionId,
				sessionId: p.sessionId ?? p.sessionID ?? "",
				toolName: p.permission ?? p.action ?? "",
				toolInput: {
					patterns: p.patterns ?? p.resources ?? [],
					metadata: p.metadata ?? {},
				},
				always: p.always ?? p.save ?? [],
				timestamp: this.now(),
			};
			this.pending.set(p.id, entry);
			recovered.push(entry);
		}
		return recovered;
	}

	/** Number of pending permissions */
	get size(): number {
		return this.pending.size;
	}
}
