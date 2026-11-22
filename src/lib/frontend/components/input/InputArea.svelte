<!-- ─── Input Area ──────────────────────────────────────────────────────────── -->
<!-- Auto-expanding textarea with send/stop button, attach menu, agent/model pills. -->
<!-- Command menu triggered by "/" prefix. -->

<script lang="ts">
	import { onDestroy, untrack } from "svelte";
	import Icon from "../shared/Icon.svelte";
	import AgentSelector from "../model/AgentSelector.svelte";
	import AttachMenu from "./AttachMenu.svelte";
	// biome-ignore lint/style/useImportType: CommandMenu is used as a value for bind:this
	import CommandMenu from "./CommandMenu.svelte";
	import ContextBar from "./ContextBar.svelte";
	// biome-ignore lint/style/useImportType: FileMenu is used as a value for bind:this
	import FileMenu from "./FileMenu.svelte";
	import ModelSelector from "../model/ModelSelector.svelte";
	// biome-ignore lint/style/useImportType: SubagentBackBar is used as a value for bind:this
	import SubagentBackBar from "../chat/SubagentBackBar.svelte";
	import PastePreview from "../chat/PastePreview.svelte";
	import SkillMenu from "./SkillMenu.svelte";
	import { addUserMessage, inputSyncState, isProcessing } from "../../stores/chat.svelte.js";
	import {
		cancelInboxItem,
		getQueuedItems,
		setInboxDelivery,
	} from "../../stores/inbox.svelte.js";
	import { discoveryState, extractSlashQuery } from "../../stores/discovery.svelte.js";
	import { extractAtQuery, fileTreeState, filterFiles } from "../../stores/file-tree.svelte.js";
	import {
		filterReferences,
		findReferenceByMention,
		referenceMentionAttachment,
		referenceState,
	} from "../../stores/reference.svelte.js";
	import type { PendingAttachment, PromptFileAttachment, SkillInfo } from "../../types.js";
	import {
		detectMimeType,
		fetchFileContent,
		fetchDirectoryListing,
		isImageMime,
		MAX_ATTACHMENT_BYTES,
		readFileAsDataUrl,
		resizeImageIfNeeded,
	} from "./input-utils.js";
	import { clearAcceptedAttachmentDraft, loadAttachmentDraft, peekAttachmentDraft, saveAttachmentDraft } from "../../utils/attachment-drafts.js";
	import { clearAcceptedDraft, draftKey, loadDraft, saveDraft } from "../../utils/drafts.js";
	import { slugState } from "../../stores/router.svelte.js";
	import { sessionState } from "../../stores/session.svelte.js";
	import { showToast } from "../../stores/ui.svelte.js";
	import { uiState } from "../../stores/ui.svelte.js";
	import { hasUnconfirmedSubmission } from "../../utils/submission-identity.js";
	import { submissionState, submitPrompt } from "../../stores/submissions.svelte.js";
	import { wsSend } from "../../stores/ws.svelte.js";
	import { formatFileSize } from "../../utils/format.js";
	import { buildAttachedMessage, parseAtReferences } from "../../utils/file-attach.js";
	import type { FileAttachment } from "../../utils/file-attach.js";

	// ─── State ─────────────────────────────────────────────────────────────────

	let inputText = $state("");
	let textareaEl: HTMLTextAreaElement | undefined = $state();
	let attachMenuOpen = $state(false);
	let skillMenuOpen = $state(false);
	let pendingAttachments = $state<PendingAttachment[]>([]);
	let preparingSend = $state(false);
	let unconfirmedSend = $state(false);
	let commandMenuRef: CommandMenu | undefined = $state();
	let fileMenuRef: FileMenu | undefined = $state();
	let subagentBackBarRef: SubagentBackBar | undefined = $state();
	let cursorPos = $state(0);
	let isRecording = $state(false);
	let isTranscribing = $state(false);
	let mediaRecorder: MediaRecorder | null = null;
	let recordedChunks: Blob[] = [];

	// ─── Per-session input drafts ─────────────────────────────────────────────
	// Each session keeps its own unsent input text. Switching sessions saves the
	// current draft and restores the target session's draft (or empty string).

	let attachmentsLoading = $state(false);
	let attachmentsSaving = $state(false);
	let attachmentGeneration = 0;
	let attachmentWrite = 0;
	let destroyed = false;
	let previousDraftKey: string | null = null;
	let warnedStorage = false;

	function persistDraft(key: string, text: string) {
		if (!saveDraft(key, text) && !warnedStorage) {
			warnedStorage = true;
			showToast("Browser storage is unavailable. Keep this tab open to retain your draft.", { variant: "warn" });
		}
	}

	function warnAttachmentStorage() {
		if (warnedStorage) return;
		warnedStorage = true;
		showToast("Attachment storage is unavailable. Keep this tab open to retain your files.", { variant: "warn" });
	}

	function persistAttachments(key: string, attachments: PendingAttachment[]) {
		const write = ++attachmentWrite;
		attachmentsSaving = true;
		void saveAttachmentDraft(key, attachments).then((saved) => {
			if (!saved) warnAttachmentStorage();
		}).finally(() => {
			if (write === attachmentWrite) attachmentsSaving = false;
		});
	}

	onDestroy(() => {
		destroyed = true;
		attachmentGeneration++;
		if (previousDraftKey && !attachmentsLoading) persistAttachments(previousDraftKey, pendingAttachments);
		if (inputSyncTimer) clearTimeout(inputSyncTimer);
		if (previousDraftKey) persistDraft(previousDraftKey, inputText);
	});

	$effect(() => {
		const currentId = sessionState.currentId;
		const project = slugState.current ?? "standalone";
		const key = currentId ? draftKey(project, currentId) : null;
		untrack(() => {
			if (key !== previousDraftKey) {
				if (previousDraftKey) {
					persistDraft(previousDraftKey, inputText);
					if (!attachmentsLoading) persistAttachments(previousDraftKey, pendingAttachments);
				}
				inputText = key ? loadDraft(key) : "";
				const cached = key ? peekAttachmentDraft(key) : undefined;
				pendingAttachments = cached ?? [];
				previousDraftKey = key;
				const generation = ++attachmentGeneration;
				attachmentsLoading = !!key && !cached;
				if (key && !cached) {
					void loadAttachmentDraft(key).then((saved) => {
						if (!destroyed && generation === attachmentGeneration && key === previousDraftKey) pendingAttachments = saved;
					}).catch(() => warnAttachmentStorage()).finally(() => {
						if (!destroyed && generation === attachmentGeneration) attachmentsLoading = false;
					});
				}
				if (inputSyncTimer) {
					clearTimeout(inputSyncTimer);
					inputSyncTimer = null;
				}
				requestAnimationFrame(() => autoResize());
			}
		});
	});

	$effect(() => {
		const text = inputText;
		const id = sessionState.currentId;
		const project = slugState.current ?? "standalone";
		untrack(() => {
			if (id) persistDraft(draftKey(project, id), text);
		});
	});

	$effect(() => {
		const id = sessionState.currentId;
		const project = slugState.current ?? "standalone";
		const attachments = pendingAttachments;
		const loading = attachmentsLoading;
		untrack(() => {
			const key = id ? draftKey(project, id) : null;
			if (key && key === previousDraftKey && !loading) persistAttachments(key, attachments);
		});
	});

	$effect(() => {
		const id = sessionState.currentId;
		const scope = slugState.current ?? "standalone";
		const _revision = submissionState.revision;
		untrack(() => { unconfirmedSend = !!id && hasUnconfirmedSubmission(scope, id); });
	});

	// ─── Input sync (cross-tab) ───────────────────────────────────────────────

	/** Track which sync we last applied to avoid re-applying our own. */
	let lastSyncApplied = 0;

	/** Receive input sync from another tab viewing the same session. */
	$effect(() => {
		if (inputSyncState.lastUpdated > lastSyncApplied) {
			lastSyncApplied = inputSyncState.lastUpdated;
			// Never replace an unsent local draft with a reconnect snapshot or
			// another device's edits. The local author decides what to send.
			if (!inputText || inputText === inputSyncState.text) {
				inputText = inputSyncState.text;
			}
		}
	});

	/** Timer for debounced outgoing input sync. */
	let inputSyncTimer: ReturnType<typeof setTimeout> | null = null;

	// ─── Command menu state ────────────────────────────────────────────────────

	const slashQuery = $derived(extractSlashQuery(inputText, cursorPos));
	const commandMenuVisible = $derived(slashQuery !== null);
	const commandQuery = $derived(slashQuery?.query ?? "");

	// ─── File menu state ──────────────────────────────────────────────────────

	const atQuery = $derived(extractAtQuery(inputText, cursorPos));
	const fileMenuVisible = $derived(
		!commandMenuVisible && atQuery !== null,
	);
	const fileQuery = $derived(atQuery?.query ?? "");
	const filteredFiles = $derived(
		fileMenuVisible ? filterFiles(fileTreeState.entries, fileQuery) : [],
	);
	const filteredReferences = $derived(
		fileMenuVisible
			? filterReferences(referenceState.references, fileQuery).map((ref) => ({
					value: ref.name,
					label: ref.name,
					...(ref.description != null && { description: ref.description }),
				}))
			: [],
	);

	// ─── Derived ───────────────────────────────────────────────────────────────

	const canSend = $derived(!preparingSend && !attachmentsLoading && (inputText.trim().length > 0 || pendingAttachments.length > 0));
	const showContextMini = $derived(uiState.contextPercent > 0);
	const hasSystemPrompt = $derived(discoveryState.systemPrompt.trim().length > 0);
	const queuedItems = $derived(getQueuedItems());

	// ─── Auto-resize textarea ──────────────────────────────────────────────────

	function autoResize() {
		if (!textareaEl) return;
		textareaEl.style.height = "auto";
		textareaEl.style.height = `${Math.min(textareaEl.scrollHeight, 120)}px`;
	}

	// ─── Handlers ──────────────────────────────────────────────────────────────

	function handleInput() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
		autoResize();

		// Debounced outgoing input sync to other tabs
		if (inputSyncTimer) clearTimeout(inputSyncTimer);
		inputSyncTimer = setTimeout(() => {
			inputSyncTimer = null;
			wsSend({
				type: "input_sync",
				text: inputText,
				sessionId: sessionState.currentId ?? undefined,
			});
		}, 300);
	}

	function handleKeyup() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
	}

	function handleClick() {
		if (textareaEl) {
			cursorPos = textareaEl.selectionStart ?? 0;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		// Forward keyboard events to CommandMenu when visible
		if (commandMenuVisible && commandMenuRef) {
			const handled = commandMenuRef.handleKeydown(e);
			if (handled) return;
		}
		// Forward keyboard events to FileMenu when visible
		if (fileMenuVisible && fileMenuRef) {
			const handled = fileMenuRef.handleKeydown(e);
			if (handled) return;
		}
		if (commandMenuVisible && e.key === "Escape") {
			e.preventDefault();
			handleCommandClose();
			return;
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			sendMessage("steer");
		}
	}

	async function sendMessage(delivery?: "steer" | "queue") {
		if (preparingSend || attachmentsLoading) return;
		const originalText = inputText;
		const text = inputText.trim();
		const originalAttachments = [...pendingAttachments];
		const targetSession = sessionState.currentId;
		const targetProject = slugState.current;
		if ((!text && originalAttachments.length === 0) || !targetSession) return;

		// A leading slash command runs via the v2 command endpoint instead of
		// being sent as an ordinary chat message.
		const command = parseSlashCommand(text);
		if (command) {
			runSlashCommand(command.name, command.args, delivery);
			return;
		}

		preparingSend = true;
		try {
			// Parse @references. Server-side references are attached as file URIs
			// (v2 PromptInput.FileAttachment); project files are fetched and
			// inlined as XML exactly as before.
			const refs = parseAtReferences(text, [...fileTreeState.entries, ...referenceState.references.map((reference) => reference.name)]);
			let messageText = text;
			const attachments: PromptFileAttachment[] = [];

			if (refs.length > 0) {
				const fileAttachments: FileAttachment[] = [];
				let cursor = 0;

				for (const ref of refs) {
					const reference = findReferenceByMention(referenceState.references, ref);
					if (reference) {
						// Attach the reference itself; record where the @name token
						// sits so OpenCode can render the mention.
						const { attachment, nextIndex } = referenceMentionAttachment(
							reference,
							messageText,
							cursor,
						);
						attachments.push(attachment);
						cursor = nextIndex;
						continue;
					}
					try {
						if (ref.endsWith("/")) {
							// Directory: fetch listing
							const content = await fetchDirectoryListing(ref);
							fileAttachments.push({ path: ref, type: "directory", content });
						} else {
							// File: fetch content
							const result = await fetchFileContent(ref);
							if (result.binary) {
								fileAttachments.push({ path: ref, type: "binary" });
							} else {
								fileAttachments.push({
									path: ref,
									type: "file",
									content: result.content,
								});
							}
						}
					} catch {
						showToast(`Could not attach ${ref}. Your draft is retained.`, { variant: "warn" });
						return;
					}
				}

				if (fileAttachments.length > 0) {
					messageText = buildAttachedMessage(text, fileAttachments);
				}
			}

			// Pending images ride along in the legacy `images` field; arbitrary
			// files are sent as data: URI file attachments.
			const imageAttachments = originalAttachments.filter(
				(att) => att.kind === "image",
			);
			for (const attachment of originalAttachments) {
				if (attachment.kind === "image") continue;
				attachments.push({ uri: attachment.dataUrl, name: attachment.name });
			}

			// Collect image data URLs from pending images (legacy field).
			const imageUrls = imageAttachments.map((att) => att.dataUrl);
			const images = imageUrls.length > 0 ? imageUrls : undefined;

			// The user explicitly chooses delivery while a turn is running:
			//   "steer" → send now (interrupt/wake the running turn)
			//   "queue" → wait for the current turn to finish
			// Only an explicit queue records `sentDuringEpoch` (drives the "Queued"
			// shimmer); the server inbox is the authoritative queue.
			// File loading can yield while the user navigates or edits the composer.
			// Keep the original draft instead of submitting it to a different chat.
			if (targetSession !== sessionState.currentId || targetProject !== slugState.current || inputText !== originalText || originalAttachments.length !== pendingAttachments.length || originalAttachments.some((att, i) => att.id !== pendingAttachments[i]?.id)) {
				showToast("The chat or draft changed while preparing attachments. Review it and send again.", { variant: "warn" });
				return;
			}
			const submission = await submitPrompt({
				type: "message",
				sessionId: targetSession,
				text: messageText,
				...(images && { images }),
				...(attachments.length > 0 && { files: attachments }),
				...(delivery && { delivery }),
			}, targetProject ?? "standalone", () => targetSession === sessionState.currentId && targetProject === slugState.current && inputText === originalText && originalAttachments.length === pendingAttachments.length && originalAttachments.every((attachment, i) => attachment.id === pendingAttachments[i]?.id) && !destroyed);
			if (!submission) return;
			if (!submission.recovered) addUserMessage(messageText, images, delivery === "queue", originalAttachments.length ? originalAttachments : undefined, submission.requestId);
			if (!await submission.accepted) return;
			if (targetSession !== sessionState.currentId || targetProject !== slugState.current) {
				const acceptedKey = draftKey(targetProject ?? "standalone", targetSession);
				clearAcceptedDraft(acceptedKey, originalText);
				void clearAcceptedAttachmentDraft(acceptedKey, originalAttachments).catch(() => warnAttachmentStorage());
			}
			// Acceptance may arrive after a navigation or a new local edit. Never
			// clear another chat or edits made while awaiting the receipt.
			if (targetSession !== sessionState.currentId || targetProject !== slugState.current || inputText !== originalText || originalAttachments.length !== pendingAttachments.length || originalAttachments.some((att, i) => att.id !== pendingAttachments[i]?.id)) return;

			// Clear pending attachments
			pendingAttachments = [];

			inputText = "";
			cursorPos = 0;
			if (sessionState.currentId) {
				persistDraft(draftKey(slugState.current ?? "standalone", sessionState.currentId), "");
				persistAttachments(draftKey(slugState.current ?? "standalone", sessionState.currentId), []);
			}
			// Cancel any pending debounced input_sync (it would re-sync the old
			// draft text to the server after we just cleared it) and send an
			// immediate empty sync so the server-side draft store is cleared too.
			if (inputSyncTimer) {
				clearTimeout(inputSyncTimer);
				inputSyncTimer = null;
			}
			wsSend({ type: "input_sync", text: "", sessionId: sessionState.currentId ?? undefined });
			if (submission.recovered) wsSend({ type: "view_session", sessionId: targetSession });
			if (textareaEl) {
				textareaEl.style.height = "auto";
			}
		} finally {
			preparingSend = false;
		}

	}

	function handleStop() {
		wsSend({ type: "cancel" });
	}

	function handleSendClick() {
		// Default delivery matches OpenCode's own default ("steer").
		sendMessage("steer");
	}

	function handleQueueClick() {
		sendMessage("queue");
	}

	// ─── Skill activation ──────────────────────────────────────────────────────

	function toggleSkillMenu() {
		skillMenuOpen = !skillMenuOpen;
	}

	function handleSkillSelect(skill: SkillInfo) {
		skillMenuOpen = false;
		wsSend({
			type: "activate_skill",
			skillId: skill.id,
			sessionId: sessionState.currentId ?? undefined,
		});
	}

	// ─── Voice dictation (local whisper server) ────────────────────────────────
	// Records with MediaRecorder, posts to /api/stt (Conduit forwards to the local
	// whisper.cpp server) and appends the transcript to the draft. Never auto-sends.

	function scheduleInputSync() {
		if (inputSyncTimer) clearTimeout(inputSyncTimer);
		inputSyncTimer = setTimeout(() => {
			inputSyncTimer = null;
			wsSend({
				type: "input_sync",
				text: inputText,
				sessionId: sessionState.currentId ?? undefined,
			});
		}, 300);
	}

	async function toggleDictation() {
		if (isTranscribing) return;
		if (isRecording) {
			mediaRecorder?.stop();
			return;
		}
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
			const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
			const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
			mediaRecorder = recorder;
			recordedChunks = [];
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) recordedChunks.push(event.data);
			};
			recorder.onstop = async () => {
				for (const track of stream.getTracks()) track.stop();
				isRecording = false;
				const blob = new Blob(recordedChunks, { type: recorder.mimeType || "audio/webm" });
				recordedChunks = [];
				mediaRecorder = null;
				if (blob.size === 0) return;
				isTranscribing = true;
				try {
					const response = await fetch("/api/stt", {
						method: "POST",
						headers: { "Content-Type": blob.type },
						body: blob,
					});
					if (!response.ok)
						throw new Error(
							response.status === 503
								? "Dictation server offline — run scripts/stt-server.sh start"
								: `Dictation failed (${response.status})`,
						);
					const { text } = (await response.json()) as { text?: string };
					const transcript = (text ?? "").trim();
					if (transcript) {
						const separator = inputText.length > 0 && !/\s$/.test(inputText) ? " " : "";
						inputText = `${inputText}${separator}${transcript}`;
						cursorPos = inputText.length;
						requestAnimationFrame(() => {
							autoResize();
							textareaEl?.focus();
							textareaEl?.setSelectionRange(inputText.length, inputText.length);
						});
						scheduleInputSync();
					}
				} catch (error) {
					showToast(error instanceof Error ? error.message : "Dictation failed", { variant: "warn" });
				} finally {
					isTranscribing = false;
				}
			};
			recorder.start();
			isRecording = true;
		} catch {
			showToast("Microphone unavailable", { variant: "warn" });
		}
	}

	function toggleAttachMenu() {
		if (attachmentsLoading) return;
		attachMenuOpen = !attachMenuOpen;
	}

	function handleAttachCamera() {
		attachMenuOpen = false;
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.capture = "environment";
		fileInput.onchange = () => processSelectedFiles(fileInput.files);
		fileInput.click();
	}

	function handleAttachPhotos() {
		attachMenuOpen = false;
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.accept = "image/*";
		fileInput.multiple = true;
		fileInput.onchange = () => processSelectedFiles(fileInput.files);
		fileInput.click();
	}

	function handleAttachFiles() {
		attachMenuOpen = false;
		const fileInput = document.createElement("input");
		fileInput.type = "file";
		fileInput.multiple = true;
		fileInput.onchange = () => processSelectedFiles(fileInput.files);
		fileInput.click();
	}

	// ─── Attachment helpers ────────────────────────────────────────────────────

	/**
	 * Read selected files from a file input. Images are auto-resized if they
	 * exceed the API limit; arbitrary files are capped at the same 20 MiB limit
	 * OpenCode enforces, with a clear toast when a file is too large.
	 */
	async function processSelectedFiles(files: FileList | null) {
		if (!files || files.length === 0 || attachmentsLoading) return;
		const targetKey = previousDraftKey;
		const generation = attachmentGeneration;
		const stillCurrent = () => !destroyed && targetKey === previousDraftKey && generation === attachmentGeneration;
		for (const file of files) {
			const mime = detectMimeType(file);
			try {
				if (isImageMime(mime)) {
					const dataUrl = await readFileAsDataUrl(file);
					const { dataUrl: finalUrl, resized } =
						await resizeImageIfNeeded(dataUrl);
					if (!stillCurrent()) {
						showToast("The chat changed while reading the file. Select it again in the intended chat.", { variant: "warn" });
						return;
					}
					pendingAttachments = [...pendingAttachments, {
						id: crypto.randomUUID(),
						dataUrl: finalUrl,
						name: file.name || "image",
						size: file.size,
						mime,
						kind: "image",
					}];
					if (resized) {
						showToast(`"${file.name}" was resized to fit the 5 MB encoded size limit`, { variant: "warn" });
					}
				} else {
					if (file.size > MAX_ATTACHMENT_BYTES) {
						showToast(
							`"${file.name}" is too large (${formatFileSize(file.size)}). Attachments are limited to 20 MB.`,
							{ variant: "error" },
						);
						continue;
					}
					const dataUrl = await readFileAsDataUrl(file);
					if (!stillCurrent()) {
						showToast("The chat changed while reading the file. Select it again in the intended chat.", { variant: "warn" });
						return;
					}
					pendingAttachments = [...pendingAttachments, {
						id: crypto.randomUUID(),
						dataUrl,
						name: file.name || "file",
						size: file.size,
						mime,
						kind: "file",
					}];
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : "Attachment failed";
				showToast(msg, { variant: "error" });
			}
		}
	}

	function removePendingAttachment(id: string) {
		pendingAttachments = pendingAttachments.filter((att) => att.id !== id);
	}

	// ─── Command menu handlers ─────────────────────────────────────────────────

	/**
	 * Detect a leading slash command in the input. Returns the command name and
	 * its argument text, or null when the text is not a known command. The name
	 * is matched against the project's discovered command list.
	 */
	function parseSlashCommand(
		text: string,
	): { name: string; args: string } | null {
		const match = text.match(/^\/(\S+)\s*([\s\S]*)$/);
		if (!match) return null;
		const name = match[1] ?? "";
		if (!name) return null;
		const known = discoveryState.commands.some((c) => c.name === name);
		if (!known) return null;
		return { name, args: (match[2] ?? "").trim() };
	}

	/**
	 * Run a slash command through the relay (v2 POST /session/{id}/command).
	 * Adds the command to the timeline locally, clears the draft, and lets the
	 * server broadcast it to other tabs.
	 */
	async function runSlashCommand(
		name: string,
		args: string,
		delivery?: "steer" | "queue",
	) {
		if (!name || !sessionState.currentId || preparingSend || attachmentsLoading) return;
		if (pendingAttachments.length > 0) {
			showToast("Slash commands do not accept attachments. Remove them before running the command.", { variant: "warn" });
			return;
		}
		const display = `/${name}${args ? ` ${args}` : ""}`;
		const targetSession = sessionState.currentId;
		const targetProject = slugState.current;
		const originalText = inputText;
		preparingSend = true;
		try {
			const submission = await submitPrompt({
				type: "run_command",
				name,
				text: args,
				sessionId: sessionState.currentId ?? undefined,
				...(delivery && { delivery }),
			}, targetProject ?? "standalone", () => targetSession === sessionState.currentId && targetProject === slugState.current && inputText === originalText && !destroyed);
			if (!submission) return;
			if (!submission.recovered) addUserMessage(display, undefined, delivery === "queue", undefined, submission.requestId);
			if (!await submission.accepted) return;
			if (targetSession !== sessionState.currentId || targetProject !== slugState.current) {
				const acceptedKey = draftKey(targetProject ?? "standalone", targetSession);
				clearAcceptedDraft(acceptedKey, originalText);
			}
			if (targetSession !== sessionState.currentId || targetProject !== slugState.current || inputText !== originalText) return;

			inputText = "";
			cursorPos = 0;
			if (sessionState.currentId) {
				persistDraft(draftKey(slugState.current ?? "standalone", sessionState.currentId), "");
				persistAttachments(draftKey(slugState.current ?? "standalone", sessionState.currentId), []);
			}
			if (inputSyncTimer) {
				clearTimeout(inputSyncTimer);
				inputSyncTimer = null;
			}
			wsSend({
				type: "input_sync",
				text: "",
				sessionId: sessionState.currentId ?? undefined,
			});
			if (submission.recovered) wsSend({ type: "view_session", sessionId: targetSession });
			if (textareaEl) {
				textareaEl.style.height = "auto";
			}
		} finally {
			preparingSend = false;
		}

	}

	function handleCommandSelect(command: string) {
		// Selecting a command runs it immediately (v2 command endpoint) rather
		// than inserting literal "/name" text into the draft.
		const name = command.trim().replace(/^\//, "").split(/\s+/)[0] ?? "";
		if (!name) return;
		// Any text typed after the slash query becomes the command arguments.
		const args = slashQuery ? inputText.slice(slashQuery.end).trim() : "";
		runSlashCommand(name, args);
	}

	function handleCommandClose() {
		if (slashQuery) {
			const before = inputText.slice(0, slashQuery.start);
			const after = inputText.slice(slashQuery.end);
			inputText = before + after;
		} else {
			inputText = "";
		}
	}

	// ─── File menu handlers ───────────────────────────────────────────────────

	function handleFileSelect(path: string) {
		if (!atQuery || !textareaEl) return;

		// Replace @query with @path (with trailing space)
		const before = inputText.slice(0, atQuery.start);
		const after = inputText.slice(atQuery.end);
		const insertion = `@${path} `;
		inputText = before + insertion + after;

		// Move cursor to after the inserted path
		const newCursorPos = atQuery.start + insertion.length;
		requestAnimationFrame(() => {
			if (textareaEl) {
				textareaEl.focus();
				textareaEl.selectionStart = newCursorPos;
				textareaEl.selectionEnd = newCursorPos;
				cursorPos = newCursorPos;
			}
		});
	}

	function handleFileMenuClose() {
		// Remove the @ trigger character
		if (atQuery) {
			const before = inputText.slice(0, atQuery.start);
			const after = inputText.slice(atQuery.end);
			inputText = before + after;
		}
	}

	// Close attach / skill menus on outside click
	function handleDocumentClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (attachMenuOpen && !target.closest("#attach-wrap")) {
			attachMenuOpen = false;
		}
		if (skillMenuOpen && !target.closest("#skill-wrap")) {
			skillMenuOpen = false;
		}
	}

	// ─── Lifecycle ─────────────────────────────────────────────────────────────

	$effect(() => {
		document.addEventListener("click", handleDocumentClick);
		return () => document.removeEventListener("click", handleDocumentClick);
	});

	// Navigate to parent session on ESC — works regardless of focus
	$effect(() => {
		function handleGlobalEsc(e: KeyboardEvent) {
			if (
				e.key === "Escape" &&
				!inputText.trim() &&
				!commandMenuVisible &&
				!fileMenuVisible &&
				subagentBackBarRef
			) {
				const handled = subagentBackBarRef.triggerNavigateBack();
				if (handled) {
					e.preventDefault();
				}
			}
		}
		document.addEventListener("keydown", handleGlobalEsc);
		return () => document.removeEventListener("keydown", handleGlobalEsc);
	});
</script>

<!-- File Menu (above input when "@" is typed) -->
{#if fileMenuVisible}
	<div id="file-menu-wrap" class="relative w-full max-w-[760px] mx-auto px-4">
		<FileMenu
			bind:this={fileMenuRef}
			query={fileQuery}
			visible={fileMenuVisible}
			entries={filteredFiles}
			references={filteredReferences}
			onSelect={handleFileSelect}
			onClose={handleFileMenuClose}
			loading={fileTreeState.loading}
		/>
	</div>
{/if}

<!-- Command Menu (above input when "/" is typed) -->
{#if commandMenuVisible}
	<div id="command-menu" class="relative w-full max-w-[760px] mx-auto px-4">
		<CommandMenu
			bind:this={commandMenuRef}
			query={commandQuery}
			visible={commandMenuVisible}
			commands={discoveryState.commands}
			onSelect={handleCommandSelect}
			onClose={handleCommandClose}
		/>
	</div>
{/if}

<div
	id="input-area"
	class="shrink-0 py-2 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] pl-[max(1rem,env(safe-area-inset-left,0px))] pr-[max(1rem,env(safe-area-inset-right,0px))] max-md:py-1.5 max-md:pb-[calc(env(safe-area-inset-bottom,0px)+8px)] max-md:pl-[max(0.75rem,env(safe-area-inset-left,0px))] max-md:pr-[max(0.75rem,env(safe-area-inset-right,0px))]"
>
	<div id="input-wrapper" class="max-w-[760px] mx-auto relative">
		<!-- Subagent context bar (above input area) -->
		<SubagentBackBar bind:this={subagentBackBarRef} />

		<!-- Context usage bar (above input) -->
		{#if showContextMini}
			<ContextBar percent={uiState.contextPercent} />
		{/if}

		<!-- Queued messages (server inbox): cancel or send now -->
		{#if queuedItems.length > 0}
			<div
				id="queued-items"
				class="flex flex-wrap items-center gap-1.5 px-2 pb-1.5"
			>
				{#each queuedItems as item (item.id)}
					<div
						class="flex items-center gap-1.5 max-w-full bg-bg-alt border border-border rounded-full pl-2.5 pr-1 py-0.5"
						title={item.text}
					>
						<span class="text-text-muted text-xs font-mono shrink-0">Queued</span>
						<span class="text-text-secondary text-xs truncate max-w-[180px] max-md:max-w-[120px]">{item.text}</span>
						<button
							type="button"
							class="shrink-0 border-none bg-transparent text-text-muted cursor-pointer p-0.5 leading-none hover:text-text touch-manipulation"
							title="Send now"
							aria-label="Send now"
							onclick={() => setInboxDelivery(wsSend, item.id, "steer")}
						>
							<Icon name="zap" size={13} />
						</button>
						<button
							type="button"
							class="shrink-0 border-none bg-transparent text-text-muted cursor-pointer p-0.5 leading-none hover:text-text touch-manipulation"
							title="Cancel queued message"
							aria-label="Cancel queued message"
							onclick={() => cancelInboxItem(wsSend, item.id)}
						>
							<Icon name="x" size={13} />
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Processing indicator: animated bounce bar aligned with context mini bar -->
		{#if isProcessing()}
			<div class="flex items-center gap-2 pb-1.5 px-2">
				<div class="min-w-6"></div>
				<div
					class="flex-1 h-[3px] rounded-full overflow-hidden bg-bg-alt"
					style="--bounce-width: 0.3;"
				>
					<div
						class="h-full rounded-full bg-accent animate-bounce-bar"
						style="width: calc(var(--bounce-width) * 100%);"
					></div>
				</div>
			</div>
		{/if}

		<div
			id="input-row"
			class="flex flex-col bg-input-bg border border-border rounded-3xl py-1.5 px-1.5 transition-[border-color,box-shadow] duration-200 max-md:rounded-[20px] focus-within:border-text-dimmer focus-within:shadow-[0_0_0_1px_var(--color-border)]"
		>

			<!-- Textarea row -->
			<div class="flex items-start">
				<textarea
					id="input"
					rows="1"
					placeholder="Message OpenCode&hellip;"
					autocomplete="off"
					enterkeyhint="send"
					class="flex-1 min-w-0 bg-transparent border-none text-text text-base font-sans leading-[1.4] pt-2 pb-1 px-2.5 resize-none outline-none min-h-6 max-h-[120px] overflow-y-auto placeholder:text-text-muted"
					bind:value={inputText}
					bind:this={textareaEl}
					oninput={handleInput}
					onkeydown={handleKeydown}
					onkeyup={handleKeyup}
					onclick={handleClick}
				></textarea>
			</div>

						<!-- Pending attachment previews -->
			{#if pendingAttachments.length > 0}
				<PastePreview attachments={pendingAttachments} onRemove={removePendingAttachment} />
			{/if}
			{#if attachmentsLoading || attachmentsSaving}
				<p class="text-xs text-text-muted px-4 py-1" role="status">{attachmentsLoading ? "Restoring attachments…" : "Saving attachment draft…"}</p>
			{/if}

			{#if unconfirmedSend && !preparingSend}
				<p class="text-xs text-text-muted px-4 py-1" role="status">A previous send is unconfirmed. Check chat history before retrying. Nothing resends automatically.</p>
			{/if}

			<!-- Bottom row: attach + agent + model + send -->
			<div id="input-bottom" class="flex items-center justify-between gap-1 max-md:flex-wrap max-md:gap-y-1.5">
				<div
					id="input-bottom-left"
					class="flex items-center gap-1 min-w-0 flex-wrap"
				>
					<!-- Attach button + menu -->
					<AttachMenu open={attachMenuOpen} onToggle={toggleAttachMenu} onCamera={handleAttachCamera} onPhotos={handleAttachPhotos} onFiles={handleAttachFiles} />

					<!-- Agent selector -->
					<div id="agent-selector-wrap">
						<AgentSelector />
					</div>

				<!-- Model selector -->
				<ModelSelector />

				<!-- System prompt editor (per chat) -->
				<button
					id="system-prompt-btn"
					type="button"
					class="shrink-0 w-8 h-8 rounded-[10px] bg-transparent border cursor-pointer flex items-center justify-center transition-[background,color] duration-150 touch-manipulation active:opacity-70"
					class:border-accent={hasSystemPrompt}
					class:text-accent={hasSystemPrompt}
					class:border-border={!hasSystemPrompt}
					class:text-text-muted={!hasSystemPrompt}
					title={hasSystemPrompt ? "Edit system prompt" : "Set system prompt"}
					onclick={() =>
						window.dispatchEvent(new CustomEvent("systemprompt:open"))}
				>
					<Icon name="file-text" size={15} />
				</button>

				<!-- Skill picker (activate a skill in this chat) -->
				<SkillMenu
					open={skillMenuOpen}
					skills={discoveryState.skills}
					onToggle={toggleSkillMenu}
					onSelect={handleSkillSelect}
				/>

			</div>

				<div
					id="input-bottom-right"
					class="flex items-center gap-1 shrink-0"
				>
					<!-- Dictation (local whisper) -->
					<button
						id="mic"
						type="button"
						class="shrink-0 w-8 h-8 rounded-[10px] bg-transparent border cursor-pointer flex items-center justify-center transition-[background,color,opacity] duration-150 touch-manipulation active:opacity-70 disabled:opacity-40 disabled:cursor-default"
						class:border-accent={isRecording}
						class:text-accent={isRecording}
						class:bg-accent-bg={isRecording}
						class:animate-pulse={isRecording}
						class:border-border={!isRecording}
						class:text-text-muted={!isRecording}
						disabled={isTranscribing}
						title={isTranscribing ? "Transcribing…" : isRecording ? "Stop recording" : "Dictate"}
						aria-busy={isTranscribing}
						onclick={toggleDictation}
					>
						<Icon
						name={isTranscribing ? "loader" : "mic"}
						size={18}
						class={isTranscribing ? "animate-spin" : ""}
					/>
					</button>
					<!-- Queue button (only while a turn is running) -->
					{#if isProcessing()}
						<button
							id="queue"
							type="button"
							class="shrink-0 h-8 px-2.5 rounded-[10px] bg-transparent border border-border text-text-muted cursor-pointer flex items-center gap-1 transition-[background,color,opacity] duration-150 touch-manipulation hover:bg-bg-alt hover:text-text disabled:opacity-25 disabled:cursor-default active:not-disabled:opacity-70"
							disabled={!canSend}
							title="Queue message (wait for this turn)"
							onclick={handleQueueClick}
						>
							<Icon name="clock" size={15} />
							<span class="text-xs font-brand">Queue</span>
						</button>
					{/if}
					<!-- Send (steer) / Stop buttons -->
					<button
						id="send"
						type="button"
						class="send-btn shrink-0 w-8 h-8 rounded-[10px] border-none bg-brand-a text-white cursor-pointer flex items-center justify-center transition-[background,opacity] duration-150 touch-manipulation hover:not-disabled:opacity-90 disabled:opacity-25 disabled:cursor-default active:not-disabled:opacity-70"
						disabled={!canSend}
						title={isProcessing() ? "Send now — interrupts the running turn" : "Send message"}
						onclick={handleSendClick}
					>
						<Icon name="arrow-up" size={18} />
					</button>
					{#if isProcessing()}
						<button
							id="stop"
							type="button"
							class="shrink-0 w-8 h-8 rounded-[10px] bg-transparent border border-border text-text-muted cursor-pointer flex items-center justify-center transition-[background,color,opacity] duration-150 touch-manipulation hover:bg-bg-alt hover:text-text active:opacity-70"
							title="Stop generating"
							onclick={handleStop}
						>
							<Icon name="square" size={18} />
						</button>
					{/if}
				</div>
			</div>
		</div>
	</div>
</div>
