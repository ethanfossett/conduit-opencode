const PREFIX = "conduit.submission.v1:";
// Match the relay receipt retention. This does not extend server deduplication.
const TTL_MS = 10 * 60_000;
interface Identity {
	requestId: string;
	createdAt: number;
	scope?: string;
	sessionId?: string;
}
const memory = new Map<string, Identity>();
function valid(saved: Identity | undefined): saved is Identity {
	return (
		!!saved &&
		typeof saved.requestId === "string" &&
		Number.isFinite(saved.createdAt) &&
		Date.now() - saved.createdAt < TTL_MS &&
		saved.createdAt <= Date.now()
	);
}

export async function submissionFingerprint(
	scope: string,
	payload: Record<string, unknown>,
): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify({ scope, payload }));
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/** Store only a digest, random ID and timestamp; never duplicate prompts or files
 * into localStorage. IDs are recorded before a network write can occur. */
export function rememberSubmission(
	fingerprint: string,
	candidateId: string,
	context?: { scope: string; sessionId: string },
): { requestId: string; durable: boolean; recovered: boolean } {
	const key = PREFIX + fingerprint;
	let saved = memory.get(key);
	try {
		const raw = localStorage.getItem(key);
		if (raw) saved = JSON.parse(raw);
	} catch {
		/* Memory fallback keeps the composer usable. */
	}
	const recovered = valid(saved);
	if (!valid(saved))
		saved = { requestId: candidateId, createdAt: Date.now(), ...context };
	memory.set(key, saved);
	try {
		localStorage.setItem(key, JSON.stringify(saved));
		return { requestId: saved.requestId, durable: true, recovered };
	} catch {
		return { requestId: saved.requestId, durable: false, recovered };
	}
}

export function forgetSubmission(fingerprint: string): void {
	const key = PREFIX + fingerprint;
	memory.delete(key);
	try {
		localStorage.removeItem(key);
	} catch {
		/* Storage may be unavailable. */
	}
}

/** Scan only delivery metadata. Expired records are pruned on use. */
export function hasUnconfirmedSubmission(
	scope: string,
	sessionId: string,
): boolean {
	const records = new Map(memory);
	try {
		for (let index = localStorage.length - 1; index >= 0; index--) {
			const key = localStorage.key(index);
			if (!key?.startsWith(PREFIX)) continue;
			try {
				const saved = JSON.parse(
					localStorage.getItem(key) ?? "null",
				) as Identity;
				if (valid(saved)) records.set(key, saved);
				else localStorage.removeItem(key);
			} catch {
				localStorage.removeItem(key);
			}
		}
	} catch {
		/* Memory fallback. */
	}
	for (const [key, saved] of records) {
		if (!valid(saved)) {
			memory.delete(key);
			continue;
		}
		if (saved.scope === scope && saved.sessionId === sessionId) return true;
	}
	return false;
}
