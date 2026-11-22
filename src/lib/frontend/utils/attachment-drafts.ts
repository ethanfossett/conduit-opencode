import type { PendingAttachment } from "../types.js";

const memory = new Map<string, PendingAttachment[]>();
const unreadable = new Set<string>();
let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
	if (typeof indexedDB === "undefined")
		return Promise.reject(new Error("IndexedDB unavailable"));
	database ??= new Promise<IDBDatabase>((resolve, reject) => {
		const request = indexedDB.open("conduit-drafts", 1);
		let abandoned = false;
		const timer = setTimeout(() => {
			abandoned = true;
			reject(new Error("Draft storage timed out"));
		}, 3_000);
		request.onupgradeneeded = () =>
			request.result.createObjectStore("attachments");
		request.onerror = () => {
			clearTimeout(timer);
			reject(request.error);
		};
		request.onblocked = () => {
			abandoned = true;
			clearTimeout(timer);
			reject(new Error("Draft storage is blocked"));
		};
		request.onsuccess = () => {
			clearTimeout(timer);
			const db = request.result;
			if (abandoned) {
				db.close();
				return;
			}
			db.onversionchange = () => {
				db.close();
				database = undefined;
			};
			resolve(db);
		};
	}).catch((error: unknown) => {
		database = undefined;
		throw error;
	});
	return database;
}

/** Strip Svelte proxies before IndexedDB structured-clones the data. */
function snapshot(
	attachments: readonly PendingAttachment[],
): PendingAttachment[] {
	return attachments.map(({ id, name, size, mime, kind, dataUrl }) => ({
		id,
		name,
		size,
		mime,
		kind,
		dataUrl,
	}));
}

export function peekAttachmentDraft(
	key: string,
): PendingAttachment[] | undefined {
	const saved = memory.get(key);
	return saved && snapshot(saved);
}

export async function loadAttachmentDraft(
	key: string,
): Promise<PendingAttachment[]> {
	const cached = peekAttachmentDraft(key);
	if (cached) return cached;
	let saved: PendingAttachment[];
	try {
		const db = await openDatabase();
		saved = await new Promise<PendingAttachment[]>((resolve, reject) => {
			const request = db
				.transaction("attachments")
				.objectStore("attachments")
				.get(key);
			request.onsuccess = () => resolve(request.result ?? []);
			request.onerror = () => reject(request.error);
		});
	} catch (error) {
		// A failed restore must never turn into an empty write that destroys
		// a previously saved draft. Keep this key memory-only until reload.
		unreadable.add(key);
		throw error;
	}

	// A user edit may have happened while the disk read was pending.
	if (!memory.has(key)) memory.set(key, snapshot(saved));
	return peekAttachmentDraft(key) ?? [];
}

/** False means memory-only retention: callers must tell the user before reload. */
export async function saveAttachmentDraft(
	key: string,
	attachments: readonly PendingAttachment[],
): Promise<boolean> {
	const saved = snapshot(attachments);
	memory.set(key, saved);
	if (unreadable.has(key)) return false;
	try {
		const db = await openDatabase();
		await new Promise<void>((resolve, reject) => {
			const transaction = db.transaction("attachments", "readwrite");
			const store = transaction.objectStore("attachments");
			if (saved.length) store.put(saved, key);
			else store.delete(key);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
			transaction.onabort = () => reject(transaction.error);
		});
		return true;
	} catch {
		return false;
	}
}

export async function clearAcceptedAttachmentDraft(
	key: string,
	submitted: readonly PendingAttachment[],
): Promise<void> {
	const current = await loadAttachmentDraft(key);
	if (
		current.length === submitted.length &&
		current.every((item, index) => item.id === submitted[index]?.id)
	)
		await saveAttachmentDraft(key, []);
}
