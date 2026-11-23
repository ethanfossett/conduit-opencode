<script lang="ts">
	import { onMount, tick } from "svelte";
	import ChatFilesPanel from "../components/chat/ChatFilesPanel.svelte";
	import { type DraftPdf, pdfSelections } from "../utils/chat-file-drafts.js";
	import ChatDuplex from "../components/chat/ChatDuplex.svelte";
	import ChatDictation from "../components/chat/ChatDictation.svelte";
	import { createChatSpeech } from "../utils/chat-speech.svelte.js";
	import type { ChatAttachment, ChatContextChange, ChatContextEntry, ChatReasoning, ChatDocumentCitation, ChatDocumentReview, ChatConversation, ChatSearchResult, ChatSummary, ChatTurnRequest } from "../../chat/types.js";
	import { clearAcceptedDraft, draftKey, loadDraft, saveDraft } from "../utils/drafts.js";
	import { renderMarkdown } from "../utils/markdown.js";
	import { stageChatHandoff } from "../stores/chat-handoff.svelte.js";
	import type { ProjectsListResponse } from "../../shared-types.js";
	import { navigate } from "../stores/router.svelte.js";

	class ChatApiError extends Error {
		readonly status: number;
		constructor(status: number, message: string) {
			super(message);
			this.status = status;
		}
	}
	let contextEnabled = $state(false);
	let showContext = $state(false);
	let contextPreview = $state<{ draft: string; entries: ChatContextEntry[] } | null>(null);
	let duplexEnabled = $state(false);
	let voiceActive = $state(false);
	let reasoningEnabled = $state(false);
	let reasoning = $state<ChatReasoning | "">("");
	let turnsEnabled = $state(false);
	let inboxQuery = $state("");
	let appliedInboxQuery = $state("");
	let showArchived = $state(false);
	let showManage = $state(false);
	let titleDraft = $state("");
	let editFrom = $state<number | null>(null);
	let previousDraft: {
		text: string;
		attachments: ChatAttachment[];
		pdfs: DraftPdf[];
		showSearch: boolean;
		searchQuery: string;
		searchResult: ChatSearchResult | null;
		includeSources: boolean;
	} | null = null;
	let refreshingId: string | null = null;
	let offline = $state(false);
	let feedback = $state("");
	let dictationActive = $state(false);
	const speech = createChatSpeech();
	let conversations = $state<ChatSummary[]>([]);
	let chat = $state<ChatConversation | null>(null);
	let text = $state("");
	let attachments = $state<ChatAttachment[]>([]);
	let filesEnabled = $state(false);
	let ocrEnabled = $state(false);
	let pdfDraft = $state<DraftPdf[]>([]);
	let filesOpen = $state(false);
	let filesBusy = $state(false);
	let pdfPreview = $state<ChatDocumentCitation>();
	let pdfReview = $state<ChatDocumentReview | null>(null);
	let enabled = $state(false);
	let handoffText = $state("");
	let handoffProject = $state("");
	let handoffProjects = $state<{ slug: string; title: string }[]>([]);
	let showHandoff = $state(false);
	let searchEnabled = $state(false);
	let showSearch = $state(false);
	let searchQuery = $state("");
	let searchResult = $state<ChatSearchResult | null>(null);
	let includeSources = $state(false);
	let loading = $state(true);
	let busy = $state(false);
	let error = $state("");
	let scroll: HTMLElement;
	let confirmDelete = $state(false);
	const chatMarkdown = {
		ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "blockquote", "br", "pre", "code", "strong", "em", "del", "ol", "ul", "li", "table", "thead", "tbody", "tr", "td", "th", "div", "hr"],
		ALLOWED_ATTR: ["start"],
		ALLOW_DATA_ATTR: false,
		ALLOW_ARIA_ATTR: false,
	};
	const sending = $derived(chat?.turn?.status === "running");
	const lastPrompt = $derived(chat?.messages.map(({ role }) => role).lastIndexOf("user") ?? -1);
	const visibleMessages = $derived(sending && chat?.turn?.replaceFrom !== undefined
		? chat.messages.slice(0, chat.turn.replaceFrom) : chat?.messages ?? []);
	const visibleInbox = $derived(conversations.filter((item) =>
		appliedInboxQuery || !!item.archived === showArchived));
	const storageKey = $derived(chat && !chat.temporary ? draftKey("conversation", chat.id) : null);

	async function api<T>(path = "", method = "GET", data?: unknown): Promise<T> {
		const response = await fetch(`/api/chat${path}`, {
			method,
			headers: { "Content-Type": "application/json", "X-Conduit-Chat": "1" },
			...(data !== undefined && { body: JSON.stringify(data) }),
		});
		if (response.status === 401) {
			navigate("/auth");
			throw new Error("Sign in again to open Chat.");
		}
		const result = await response.json();
		if (!response.ok) throw new ChatApiError(response.status, result.message ?? "Chat is unavailable.");
		return result as T;
	}

	async function refresh(query = appliedInboxQuery) {
		const result = await api<{enabled: boolean; searchEnabled: boolean; turnsEnabled?: boolean; filesEnabled?: boolean; ocrEnabled?: boolean; contextEnabled?: boolean; reasoningEnabled?: boolean; duplexEnabled?: boolean; conversations: ChatSummary[]}>(query ? `?q=${encodeURIComponent(query)}` : "");
		enabled = result.enabled;
		searchEnabled = result.searchEnabled;
		contextEnabled = result.contextEnabled ?? false;
		duplexEnabled = result.duplexEnabled ?? false;
		reasoningEnabled = result.reasoningEnabled ?? false;
		turnsEnabled = result.turnsEnabled ?? false;
		filesEnabled = result.filesEnabled ?? false;
		ocrEnabled = result.ocrEnabled ?? false;
		conversations = result.conversations;
		appliedInboxQuery = query;
	}

	function changeContext(index: number, change: ChatContextChange) {
		const current = chat;
		if (!current || busy || sending) return;
		void run(async () => {
			chat = await api<ChatConversation>(`/${current.id}/context`, "POST", { index, change, revision: current.updatedAt });
			contextPreview = null;
		});
	}

	function previewContext() {
		const id = chat?.id;
		if (!id || !text.trim()) return;
		const draft = text.trim();
		void run(async () => {
			const entries = await api<ChatContextEntry[]>(`/${id}/context/preview`, "POST", {
				draft, ...(editFrom !== null && { editFrom }),
			});
			if (chat?.id === id) contextPreview = { draft, entries };
		});
	}

	function jumpToMessage(index: number) {
		const source = document.getElementById(`chat-source-${index}`);
		source?.scrollIntoView({ block: "center" });
		source?.focus({ preventScroll: true });
	}

	function searchInbox(event: SubmitEvent) {
		event.preventDefault();
		void run(() => refresh(inboxQuery.trim()));
	}

	function clearInboxSearch() {
		inboxQuery = "";
		void run(() => refresh(""));
	}

	function updateMetadata(changes: { title?: string; pinned?: boolean; archived?: boolean }) {
		const id = chat?.id;
		if (!id || sending) return;
		void run(async () => {
			chat = await api<ChatConversation>(`/${id}/metadata`, "POST", changes);
			titleDraft = chat.title;
			if (changes.archived !== undefined) showArchived = changes.archived;
			await refresh();
		});
	}

	function branch(through: number) {
		const id = chat?.id;
		if (!id || sending) return;
		void run(async () => {
			display(await api<ChatConversation>("", "POST", { branch: { id, through } }));
			inboxQuery = "";
			showArchived = false;
			await refresh("");
		});
	}

	function exportChat() {
		if (!chat) return;
		const { title, messages } = chat;
		const url = URL.createObjectURL(new Blob([JSON.stringify({ title, messages }, null, 2)], { type: "application/json" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = `${title.replace(/[^\p{L}\p{N} ._-]/gu, "_").slice(0, 80) || "chat"}.json`;
		document.body.append(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 500);
	}

	async function copy(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			feedback = "Copied";
		} catch {
			feedback = "Could not copy this text.";
		}
	}

	function pdfKey(id: string) {
		return `${draftKey("conversation", id)}:pdfs`;
	}

	function readPdfDraft(conversation: ChatConversation | null): DraftPdf[] {
		if (!conversation || conversation.temporary) return [];
		try {
			const value = JSON.parse(loadDraft(pdfKey(conversation.id)) || "[]");
			return Array.isArray(value) ? value : [];
		} catch { return []; }
	}

	function setPdfDraft(value: DraftPdf[]) {
		pdfDraft = value;
		pdfReview = null;
		if (chat && !chat.temporary && editFrom === null) {
			saveDraft(pdfKey(chat.id), value.length ? JSON.stringify(value) : "");
		}
	}

	function openFiles(page?: ChatDocumentCitation) {
		pdfPreview = page;
		filesOpen = true;
	}

	function reviewPdfs() {
		const id = chat?.id;
		if (!id || !text.trim()) return;
		void run(async () => {
			pdfReview = await api<ChatDocumentReview>(
				`/${id}/file-review`, "POST", { prompt: text, files: pdfSelections(pdfDraft) },
			);
		});
	}

	function removeReviewedPage(id: string, page: number) {
		if (!pdfReview) return;
		pdfReview.documents = pdfReview.documents
			.map((document) => document.id === id
				? { ...document, pages: document.pages.filter((excerpt) => excerpt.page !== page) }
				: document)
			.filter((document) => document.pages.length);
	}

	function redactSelection(id: string, page: number) {
		const excerpt = pdfReview?.documents.find((item) => item.id === id)
			?.pages.find((item) => item.page === page);
		const editor = document.getElementById(`pdf-excerpt-${id}-${page}`);
		if (!excerpt || !(editor instanceof HTMLTextAreaElement)) return;
		const { selectionStart, selectionEnd } = editor;
		if (selectionStart === selectionEnd) {
			error = "Select the text you want to redact first.";
			return;
		}
		error = "";
		excerpt.excerpt = `${excerpt.excerpt.slice(0, selectionStart)}[redacted]${excerpt.excerpt.slice(selectionEnd)}`;
	}

	function pendingKey(id: string) {
		return `${draftKey("conversation", id)}:submitted`;
	}

	function readPending(conversation: ChatConversation): { requestId: string; text: string; pdfSnapshot?: string; reasoning?: ChatReasoning } | null {
		if (conversation.temporary) return null;
		try {
			return JSON.parse(loadDraft(pendingKey(conversation.id)) || "null");
		} catch {
			return null;
		}
	}

	function acknowledge(conversation: ChatConversation) {
		const pending = readPending(conversation);
		if (!pending || !conversation.receipts?.includes(pending.requestId)) return;
		const key = draftKey("conversation", conversation.id);
		clearAcceptedDraft(key, pending.text);
		if (pending.pdfSnapshot !== undefined && loadDraft(pdfKey(conversation.id)) === pending.pdfSnapshot) setPdfDraft([]);
		saveDraft(pendingKey(conversation.id), "");
		if (editFrom === null && text === pending.text) text = "";
	}

	async function reconcile(id: string, incremental = false) {
		if (refreshingId || busy || !turnsEnabled || chat?.id !== id) return;
		refreshingId = id;
		const original = chat;
		try {
			const following = !scroll || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
			const wasRunning = original.turn?.status === "running";
			if (incremental && original.turn) {
				const { running } = await api<{ running: { id: string; reply?: string } | null }>(`/${id}/turns`);
				if (chat !== original) return;
				if (running && running.id === original.turn.id) {
					if (running.reply !== original.turn.reply) {
						if (running.reply) original.turn.reply = running.reply;
						if (following) await scrollToLatest();
					}
					offline = false;
					return;
				}
			}
			const updated = await api<ChatConversation>(`/${id}`);
			if (chat !== original) return;
			acknowledge(updated);
			chat = updated;
			offline = false;
			if (following && (wasRunning || updated.turn?.status === "running")) await scrollToLatest();
			if (wasRunning && updated.turn?.status !== "running" && !updated.temporary) await refresh();
		} catch {
			if (chat?.id === id) offline = true;
		} finally {
			refreshingId = null;
		}
	}

	$effect(() => {
		const id = chat?.turn?.status === "running" ? chat.id : undefined;
		if (!id) return;
		const timer = setInterval(() => {
			if (!document.hidden) void reconcile(id, true);
		}, 500);
		return () => clearInterval(timer);
	});

	function display(conversation: ChatConversation | null) {
		speech.stop();
		chat = conversation;
		showManage = false;
		showContext = false;
		contextPreview = null;
		reasoning = "";
		titleDraft = conversation?.title ?? "";
		editFrom = null;
		previousDraft = null;
		pdfDraft = readPdfDraft(conversation);
		pdfReview = null;
		filesOpen = false;
		pdfPreview = undefined;
		offline = false;
		feedback = "";
		text = conversation && !conversation.temporary ? loadDraft(draftKey("conversation", conversation.id)) : "";
		if (conversation) acknowledge(conversation);
		attachments = [];
		confirmDelete = false;
		resetSearch();
		closeHandoff();
		const url = new URL(window.location.href);
		if (conversation && !conversation.temporary) url.searchParams.set("c", conversation.id);
		else url.searchParams.delete("c");
		window.history.replaceState(null, "", url);
		void scrollToLatest();
	}

	async function scrollToLatest() {
		await tick();
		scroll?.scrollTo({ top: scroll.scrollHeight });
	}

	async function run(action: () => Promise<void>) {
		if (busy) return;
		busy = true;
		error = "";
		try {
			await action();
		} catch (err) {
			error = err instanceof Error ? err.message : "Chat is unavailable.";
		} finally {
			busy = false;
		}
	}

	onMount(() => {
		const unmountSpeech = speech.mount();
		void run(async () => {
			try {
				await refresh();
				const id = new URL(location.href).searchParams.get("c");
				if (id && conversations.some((item) => item.id === id)) display(await api<ChatConversation>(`/${id}`));
			} finally {
				loading = false;
			}
		});
		const recover = () => {
			if (chat && !document.hidden) void reconcile(chat.id);
		};
		window.addEventListener("online", recover);
		window.addEventListener("pageshow", recover);
		document.addEventListener("visibilitychange", recover);
		return () => {
			unmountSpeech();
			window.removeEventListener("online", recover);
			window.removeEventListener("pageshow", recover);
			document.removeEventListener("visibilitychange", recover);
		};
	});

	function create(temporary: boolean) {
		void run(async () => {
			display(await api<ChatConversation>("", "POST", { temporary }));
			inboxQuery = "";
			showArchived = false;
			await refresh("");
		});
	}

	function select(id: string) {
		void run(async () => display(await api<ChatConversation>(`/${id}`)));
	}

	async function attach(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = "";
		await run(async () => {
			if (files.length + attachments.length > 4 || files.some((file) => file.size > 16_000)) {
				throw new Error("Attach up to four text files of 16 KB each.");
			}
			const selected = await Promise.all(files.map(async (file) => ({ name: file.name, text: await file.text() })));
			if (selected.some((file) => file.text.includes("\0"))) throw new Error("Choose plain-text attachments.");
			attachments = [...attachments, ...selected];
		});
	}

	function resetSearch() {
		showSearch = false;
		searchQuery = "";
		searchResult = null;
		includeSources = false;
	}

	function search(event: SubmitEvent) {
		event.preventDefault();
		const conversation = chat;
		const query = searchQuery.trim();
		if (!conversation || !query) return;
		void run(async () => {
			includeSources = false;
			searchResult = null;
			searchResult = await api<ChatSearchResult>(`/${conversation.id}/search`, "POST", { query });
		});
	}

	function readSource(index: number) {
		const conversation = chat;
		const result = searchResult;
		if (!conversation || !result) return;
		void run(async () => {
			searchResult = await api<ChatSearchResult>(`/${conversation.id}/search/read`, "POST", {
				searchId: result.id,
				index,
			});
			includeSources = false;
		});
	}

	function prepareHandoff(excerpt: string) {
		void run(async () => {
			const response = await fetch("/api/projects");
			if (!response.ok) throw new Error("Could not load Code projects.");
			const { projects } = await response.json() as ProjectsListResponse;
			handoffProjects = projects
				.filter(({ status }) => status === "ready")
				.map(({ slug, title }) => ({ slug, title }));
			handoffProject = handoffProjects.length === 1 ? handoffProjects[0]?.slug ?? "" : "";
			handoffText = excerpt.slice(0, 12_000);
			showHandoff = true;
		});
	}

	function closeHandoff() {
		showHandoff = false;
		handoffText = "";
		handoffProject = "";
		handoffProjects = [];
	}

	function openCode(event: SubmitEvent) {
		event.preventDefault();
		const reviewed = handoffText.trim();
		if (!reviewed || !handoffProjects.some(({ slug }) => slug === handoffProject)) return;
		stageChatHandoff(handoffProject, reviewed);
		navigate(`/p/${encodeURIComponent(handoffProject)}/`);
	}

	function beginEdit(index: number) {
		const message = chat?.messages[index];
		if (!message || index !== lastPrompt || sending) return;
		previousDraft = { text, attachments, pdfs: pdfDraft, showSearch, searchQuery, searchResult, includeSources };
		editFrom = index;
		text = message.text;
		pdfDraft = [];
		pdfReview = null;
		resetSearch();
		attachments = [];
		document.getElementById("chat-message")?.focus();
	}

	function endEdit() {
		if (editFrom === null || !previousDraft) return;
		editFrom = null;
		({ text, attachments, pdfs: pdfDraft, showSearch, searchQuery, searchResult, includeSources } = previousDraft);
		pdfReview = null;
		previousDraft = null;
	}

	function runTurn(request: Omit<ChatTurnRequest, "requestId">, submitted?: string) {
		const conversation = chat;
		if (!conversation || sending || dictationActive || voiceActive) return;
		speech.stop();
		const pending = readPending(conversation);
		const pdfSnapshot = conversation.temporary ? "" : loadDraft(pdfKey(conversation.id));
		const requestId = submitted !== undefined && pending?.text === submitted && pending.reasoning === request.reasoning && (pending.pdfSnapshot ?? "") === pdfSnapshot
			? pending.requestId : crypto.randomUUID();
		void run(async () => {
			if (submitted !== undefined && !conversation.temporary) {
				saveDraft(pendingKey(conversation.id), JSON.stringify({ requestId, text: submitted, pdfSnapshot, reasoning: request.reasoning }));
			}
			try {
				chat = await api<ChatConversation>(`/${conversation.id}/turns`, "POST", { requestId, ...request });
			} catch (err) {
				if (err instanceof ChatApiError && err.status < 500 && err.status !== 409 && submitted !== undefined && !conversation.temporary) {
					saveDraft(pendingKey(conversation.id), "");
				}
				throw err;
			}
			acknowledge(chat);
			contextPreview = null;
			if (editFrom !== null) {
				endEdit();
			} else if (submitted !== undefined) {
				text = "";
				attachments = [];
				setPdfDraft([]);
				resetSearch();
			}
			await scrollToLatest();
			if (!chat.turn && !chat.temporary) await refresh();
		}).finally(() => {
			if (chat?.id === conversation.id) void reconcile(conversation.id);
		});
	}

	function stop() {
		const current = chat;
		if (!current?.turn || !sending) return;
		void run(async () => {
			chat = await api<ChatConversation>(`/${current.id}/turns/stop`, "POST", { requestId: current.turn?.id });
			if (!chat.temporary) await refresh();
		});
	}

	function appendDictation(id: string, transcript: string) {
		if (chat?.id !== id) return false;
		const separator = text && !/\s$/.test(text) ? " " : "";
		const updated = `${text}${separator}${transcript}`;
		if (updated.length > 24_000) return false;
		text = updated;
		pdfReview = null;
		if (storageKey && editFrom === null) saveDraft(storageKey, text);
		return true;
	}

	function send(event: SubmitEvent) {
		event.preventDefault();
		const conversation = chat;
		const prompt = text.trim();
		if (!conversation || !prompt || busy || sending || showHandoff || dictationActive || voiceActive || filesBusy) return;
		let documentApproval: ChatTurnRequest["documentApproval"];
		if (pdfDraft.length) {
			if (!pdfReview) {
				error = "Review the PDF excerpts before sending.";
				return;
			}
			const documents = pdfReview.documents.map(({ id, pages }) => ({
				id,
				pages: pages.filter(({ excerpt }) => excerpt.trim()).map(({ page, excerpt }) => ({ page, excerpt })),
			})).filter(({ pages }) => pages.length);
			if (!documents.length) {
				error = "Keep an excerpt in the review or detach the PDFs before sending.";
				return;
			}
			documentApproval = { reviewId: pdfReview.reviewId, documents };
		}
		const submission = {
			...(documentApproval && { documentApproval }),
			text: prompt,
			...(attachments.length ? { attachments } : {}),
			...(includeSources && searchResult && { searchId: searchResult.id }),
		};
		if (turnsEnabled) {
			runTurn({
				...submission,
				...(reasoningEnabled && reasoning && { reasoning }),
				...(editFrom !== null && { editFrom }),
			}, editFrom === null ? text : undefined);
			return;
		}
		const submitted = text;
		const draft = storageKey;
		void run(async () => {
			const result = await api<ChatConversation>(`/${conversation.id}`, "POST", submission);
			chat = result;
			if (draft) clearAcceptedDraft(draft, submitted);
			text = "";
			attachments = [];
			resetSearch();
			if (!result.temporary) await refresh();
			await scrollToLatest();
		});
	}

</script>

<div class="flex h-dvh min-h-0 flex-col bg-bg text-text">
	<header class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
		<nav aria-label="Conduit modes" class="flex items-center gap-4 text-sm">
			<span aria-current="page" class="font-semibold">Chat</span>
			<a href="/" class="text-text-muted hover:text-text">Code</a>
		</nav>
		<div class="flex items-center gap-3">
			{#if filesEnabled && !chat?.temporary}
				<button type="button" class="rounded border border-border px-3 py-1 text-sm" disabled={busy || sending} onclick={() => openFiles()}>Files</button>
			{/if}
			{#if enabled}<span class="text-xs text-text-muted">NodeCode · Cyber v1</span>{/if}
		</div>
	</header>
	{#if loading}
		<p class="m-6 text-text-muted">Opening Chat…</p>
	{:else if !enabled}
		<main class="m-6 max-w-xl">
			<h1 class="mb-2 text-xl font-semibold">Chat</h1>
			<p class="text-text-muted">{error || "Chat needs a dedicated OpenCode instance. See the setup guide in the repository."}</p>
		</main>
	{:else}
		<div class="flex min-h-0 flex-1 flex-col md:flex-row">
			<aside class="flex max-h-40 flex-col gap-3 overflow-auto border-b border-border p-3 md:max-h-none md:w-64 md:border-r md:border-b-0">
				<div class="flex flex-wrap gap-3 text-sm">
					<button type="button" class="rounded-lg bg-accent px-3 py-2 text-bg disabled:opacity-50" disabled={busy} onclick={() => create(false)}>New chat</button>
					<button type="button" class="rounded-lg border border-border px-3 py-2 disabled:opacity-50" disabled={busy} onclick={() => create(true)}>Temporary chat</button>
				</div>
				{#if turnsEnabled}
					<form class="flex gap-1" aria-label="Search saved chats" onsubmit={searchInbox}>
						<input type="search" aria-label="Search chat history" placeholder="Search chats" maxlength="240" bind:value={inboxQuery} class="min-w-0 flex-1 rounded border border-border bg-bg-surface px-2 py-1 text-base" />
						<button type="submit" class="rounded border border-border px-2 text-xs" disabled={busy}>Search</button>
					</form>
					{#if appliedInboxQuery}
						<button type="button" class="self-start text-xs underline" disabled={busy} onclick={clearInboxSearch}>Clear search</button>
					{:else}
						<button type="button" class="self-start text-xs underline" onclick={() => (showArchived = !showArchived)}>{showArchived ? "Show inbox" : "Show archive"}</button>
					{/if}
				{/if}
				<ul class="space-y-1" aria-label="Conversations">
					{#if appliedInboxQuery && visibleInbox.length === 0}<li class="text-xs text-text-muted">No matching conversations.</li>{/if}
					{#each visibleInbox as summary (summary.id)}
						<li><button type="button" class="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-bg-alt" class:bg-bg-alt={chat?.id === summary.id} disabled={busy} onclick={() => select(summary.id)}>{summary.pinned ? "📌 " : ""}{summary.title}</button></li>
					{/each}
				</ul>
			</aside>
			<main class="flex min-h-0 min-w-0 flex-1 flex-col">
				{#if chat}
					<div class="flex flex-wrap justify-between gap-2 border-b border-border px-4 py-2 text-xs text-text-muted">
						<span>{chat.temporary ? "Temporary · erased on relay restart or after 1 hour idle" : chat.title}</span>
						{#if contextEnabled}
							<button type="button" class="underline" aria-expanded={showContext} onclick={() => (showContext = !showContext)}>Context</button>
						{/if}
						{#if turnsEnabled && !chat.temporary}
							<button type="button" class="underline" disabled={busy || sending} aria-expanded={showManage} onclick={() => {
								titleDraft = chat?.title ?? "";
								showManage = !showManage;
							}}>Manage chat</button>
						{/if}
						{#if confirmDelete}
							<button type="button" class="text-error underline" disabled={busy} onclick={() => void run(async () => {
								if (!chat) return;
								await api(`/${chat.id}`, "DELETE");
								if (storageKey) saveDraft(storageKey, "");
								if (!chat.temporary) saveDraft(pdfKey(chat.id), "");
								display(null);
								await refresh();
							})}>Confirm delete</button>
							<button type="button" class="underline" onclick={() => (confirmDelete = false)}>Cancel</button>
						{:else}
							<button type="button" class="underline" disabled={busy || sending} onclick={() => (confirmDelete = true)}>Delete chat</button>
						{/if}
					</div>
					{#if showManage && turnsEnabled && !chat.temporary}
						<div class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
							<form class="flex flex-1 gap-2" onsubmit={(event) => {
								event.preventDefault();
								updateMetadata({ title: titleDraft });
							}}>
								<input aria-label="Conversation title" class="min-w-0 flex-1 rounded border border-border bg-bg-surface px-2 py-1 text-base" maxlength="120" bind:value={titleDraft} disabled={busy || sending} />
								<button type="submit" class="underline" disabled={busy || sending || !titleDraft.trim()}>Rename</button>
							</form>
							<button type="button" class="underline" disabled={busy || sending} onclick={() => updateMetadata({ pinned: !chat?.pinned })}>{chat.pinned ? "Unpin" : "Pin"}</button>
							<button type="button" class="underline" disabled={busy || sending} onclick={() => updateMetadata({ archived: !chat?.archived })}>{chat.archived ? "Restore" : "Archive"}</button>
							<button type="button" class="underline" onclick={exportChat}>Export JSON</button>
						</div>
					{/if}
					{#if showContext && contextEnabled}
						<section aria-label="Conversation context" class="max-h-[30dvh] space-y-3 overflow-auto border-b border-border px-4 py-3 text-xs">
							<p class="text-text-muted">Conduit recalls relevant messages in this chat. Pin a message to carry it forward, or exclude it from future replies. Excluding a prompt also omits its immediate reply.</p>
							<button type="button" class="underline disabled:opacity-50" disabled={busy || sending || !text.trim()} onclick={previewContext}>Preview context for draft</button>
							{#if contextPreview?.draft === text.trim()}
								<p class="text-text-muted">This previews conversation history. Approved attachments may change how much history fits.</p>
								{#if contextPreview.entries.length}
									<ul class="space-y-1">
										{#each contextPreview.entries as entry (entry.index)}
											<li><button type="button" class="text-left underline" onclick={() => jumpToMessage(entry.index)}>{entry.kind} · {entry.text.slice(0, 180)}</button></li>
										{/each}
									</ul>
								{:else}
									<p>No earlier messages selected.</p>
								{/if}
							{/if}
							{#if chat.pinnedContext?.length}
								<h2 class="font-medium">Pinned for future replies</h2>
								<ul class="space-y-1">
									{#each chat.pinnedContext as index (index)}
										<li><button type="button" class="underline" onclick={() => jumpToMessage(index)}>{chat.messages[index]?.text.slice(0, 100)}</button></li>
									{/each}
								</ul>
							{/if}
							{#if chat.lastContext?.entries.length}
								<h2 class="font-medium">Used for the last reply</h2>
								<ul class="space-y-1">
									{#each chat.lastContext.entries as { index, kind } (index)}
										<li><button type="button" class="text-left underline" onclick={() => jumpToMessage(index)}>{kind} · {chat.messages[index]?.text.slice(0, 100)}</button></li>
									{/each}
								</ul>
							{:else}
								<p class="text-text-muted">No earlier messages were used for the last reply.</p>
							{/if}
							{#if chat.excludedContext?.length}
								<h2 class="font-medium">Excluded from future replies</h2>
								<ul class="space-y-1">
									{#each chat.excludedContext as index (index)}
										<li class="flex flex-wrap gap-2">
											<button type="button" class="underline" onclick={() => jumpToMessage(index)}>{chat.messages[index]?.text.slice(0, 100)}</button>
											<button type="button" class="underline" disabled={busy || sending} onclick={() => changeContext(index, "restore")}>Restore to context</button>
										</li>
									{/each}
								</ul>
							{/if}
						</section>
					{/if}
					<div bind:this={scroll} class="min-h-0 flex-1 overflow-auto px-4 py-5" role="log" aria-label="Messages">
						<div class="mx-auto max-w-2xl space-y-5">
							{#each visibleMessages as message, index}
								<div id={`chat-source-${index}`} tabindex="-1" class="break-words rounded-xl px-4 py-3 text-sm" class:bg-bg-alt={message.role === "user"}>
									<span class="mb-1 block text-xs font-medium text-text-muted">{message.role === "user" ? "You" : "Cyber v1"}</span>
									{#if message.role === "assistant"}
										<div class="md-content overflow-x-auto text-sm leading-relaxed">{@html renderMarkdown(message.text, chatMarkdown)}</div>
									{:else}
										<p class="whitespace-pre-wrap">{message.text}</p>
									{/if}
									{#each message.attachments ?? [] as file}
										<span class="mt-1 block text-xs text-text-muted">Attachment · {file.name}</span>
									{/each}
									{#if filesEnabled}
										{#each message.documents ?? [] as file}
											<button type="button" class="mt-2 me-2 rounded border border-border px-2 py-1 text-xs underline" onclick={() =>
												openFiles({ id: file.id, name: file.name, page: file.pages[0]?.page ?? 1, excerpt: "" })}>{file.name}</button>
										{/each}
										{#each message.fileCitations ?? [] as citation}
											<button type="button" class="mt-2 me-2 rounded border border-border px-2 py-1 text-xs underline" onclick={() =>
												openFiles(citation)}>{citation.name} · p. {citation.page}</button>
										{/each}
									{/if}
									{#if message.sourceContext}
										<ol class="mt-2 space-y-1 text-xs text-text-muted" aria-label="Web sources">
											{#each message.sourceContext.sources as source, index}
												<li>[{index + 1}] <a class="underline" href={source.url} target="_blank" rel="noreferrer noopener">{source.title || new URL(source.url).hostname}</a></li>
											{/each}
										</ol>
									{/if}
									<div class="mt-2 flex flex-wrap gap-3 text-xs text-text-muted">
										<button type="button" class="underline" onclick={() => copy(message.text)}>Copy</button>
										{#if contextEnabled && showContext && index >= (chat.contextStart ?? 0) && !message.documents?.length && !message.attachments?.length && !message.sourceContext && !message.fileCitations?.length && !(message.role === "assistant" && (chat.messages[index - 1]?.documents?.length || chat.messages[index - 1]?.attachments?.length || chat.messages[index - 1]?.sourceContext))}
											{#if chat.excludedContext?.includes(index)}
												<button type="button" class="underline" disabled={busy || sending} onclick={() => changeContext(index, "restore")}>Restore to context</button>
											{:else}
												<button type="button" class="underline" disabled={busy || sending} onclick={() => changeContext(index, chat?.pinnedContext?.includes(index) ? "unpin" : "pin")}>{chat.pinnedContext?.includes(index) ? "Unpin from context" : "Pin to context"}</button>
												<button type="button" class="underline" disabled={busy || sending} onclick={() => changeContext(index, "exclude")}>Exclude from context</button>
											{/if}
										{/if}
										<button type="button" class="underline" disabled={busy || sending} onclick={() => prepareHandoff(message.text)}>Continue in Code</button>
										{#if turnsEnabled && index === lastPrompt && message.role === "user"}
											<button type="button" class="underline" disabled={busy || sending || editFrom !== null || dictationActive} onclick={() => beginEdit(index)}>Edit prompt</button>
										{/if}
										{#if message.role === "assistant" && speech.state.available}
											{#if speech.state.index === index}
												<button type="button" class="underline" onclick={speech.togglePause}>{speech.state.paused ? "Resume playback" : "Pause playback"}</button>
												<button type="button" class="underline" onclick={speech.stop}>Stop playback</button>
											{:else}
												<button type="button" class="underline" disabled={dictationActive || voiceActive} onclick={() =>
													speech.play(index, renderMarkdown(message.text, chatMarkdown))}>Read aloud</button>
											{/if}
										{/if}
										{#if turnsEnabled && message.role === "assistant"}
											{#if index === visibleMessages.length - 1 && lastPrompt >= (chat.contextStart ?? 0)}
												<button type="button" class="underline" disabled={busy || sending || editFrom !== null || dictationActive} onclick={() => runTurn({ regenerate: true })}>Regenerate</button>
											{/if}
											{#if !chat.temporary}
												<button type="button" class="underline" disabled={busy || sending} onclick={() => branch(index + 1)}>Branch from reply</button>
											{/if}
										{/if}
									</div>
								</div>
							{/each}
							{#if chat.turn}
								<div class="rounded-xl bg-bg-alt px-4 py-3 text-sm">
									<span class="mb-1 block text-xs font-medium text-text-muted">{chat.turn.replaceFrom === undefined ? "You" : "Revised turn"}</span>
									<p class="whitespace-pre-wrap break-words">{chat.turn.prompt.text}</p>
								</div>
								<div class="space-y-2 px-4 py-3 text-sm">
									{#if chat.turn.reply}<div class="md-content overflow-x-auto leading-relaxed">{@html renderMarkdown(chat.turn.reply, chatMarkdown)}</div>{/if}
									{#if sending}
										<span class="text-text-muted">{offline ? "Reconnecting…" : chat.turn.prompt.reasoning === "high" && !chat.turn.reply ? "Thinking…" : "Cyber v1 is replying…"}</span>
										<button type="button" class="ms-2 underline" disabled={busy} onclick={stop}>Stop</button>
									{:else}
										<span>{chat.turn.error ?? "Reply stopped."}</span>
										<button type="button" class="ms-2 underline" disabled={busy || editFrom !== null} onclick={() => runTurn({ retry: true })}>Retry reply</button>
									{/if}
								</div>
							{:else if busy}<p class="text-sm text-text-muted">Working…</p>{/if}
						</div>
					</div>
					{#if showHandoff}
						<form class="mx-auto max-h-[40dvh] w-full max-w-2xl space-y-2 overflow-auto border-t border-border p-4 text-sm" aria-label="Continue in Code" onsubmit={openCode}>
							<label class="block font-medium" for="handoff-excerpt">Review text for Code</label>
							<p class="text-xs text-text-muted">Only the text below becomes a saved Code draft. You decide when to send it.</p>
							<textarea id="handoff-excerpt" rows="3" maxlength="12000" bind:value={handoffText} class="w-full rounded border border-border bg-bg-surface p-2 text-base"></textarea>
							<div class="flex flex-wrap items-center gap-2">
								<label for="handoff-project" class="sr-only">Code project</label>
								<select id="handoff-project" bind:value={handoffProject} class="min-w-0 rounded border border-border bg-bg-surface p-2 text-base">
									<option value="">{handoffProjects.length ? "Choose Code project" : "No ready Code projects"}</option>
									{#each handoffProjects as project (project.slug)}
										<option value={project.slug}>{project.title || project.slug}</option>
									{/each}
								</select>
								<button type="submit" class="rounded bg-accent px-3 py-2 text-bg disabled:opacity-50" disabled={!handoffText.trim() || !handoffProject}>Open Code project</button>
								<button type="button" class="underline" onclick={closeHandoff}>Cancel</button>
							</div>
						</form>
					{:else if showSearch}
						<section class="mx-auto max-h-[35dvh] w-full max-w-2xl space-y-3 overflow-auto border-t border-border p-4 text-sm" aria-label="Private web search">
							<form class="space-y-2" onsubmit={search}>
								<label class="block font-medium" for="search-query">Review your web query</label>
								<p class="text-xs text-text-muted">The search provider receives this query through Mullvad. Search starts when you select Run search.</p>
								<div class="flex flex-wrap gap-2">
									<input id="search-query" class="min-w-0 flex-1 rounded border border-border bg-bg-surface p-2 text-base" bind:value={searchQuery} maxlength="400" disabled={busy} oninput={() => {
										searchResult = null;
										includeSources = false;
									}} />
									<button type="submit" class="rounded bg-accent px-3 py-2 text-bg disabled:opacity-50" disabled={busy || !searchQuery.trim()}>Run search</button>
									<button type="button" disabled={busy} class="underline" onclick={resetSearch}>Close</button>
								</div>
							</form>
							{#if searchResult}
								{#if searchResult.sources.length === 0}
									<p class="text-text-muted">No sources found for this query.</p>
								{:else}
									<ol class="space-y-3">
										{#each searchResult.sources as source, index}
											<li>
												<p class="font-medium">[{index + 1}] {source.title || new URL(source.url).hostname}</p>
												<p class="text-xs text-text-muted">{new URL(source.url).hostname}</p>
												<p class="break-words">{source.snippet}</p>
												{#if source.excerpt}
													<details><summary class="cursor-pointer underline">Page excerpt</summary><p class="break-words">{source.excerpt}</p></details>
												{:else}
													<button type="button" class="text-xs underline" disabled={busy} onclick={() => readSource(index)}>Read excerpt through Mullvad</button>
												{/if}
											</li>
										{/each}
									</ol>
									<label class="flex items-start gap-2">
										<input type="checkbox" bind:checked={includeSources} disabled={busy} />
										<span>Send these sources and excerpts to NodeCode with my next message</span>
									</label>
								{/if}
							{/if}
						</section>
					{/if}
					<form class="mx-auto w-full max-w-2xl space-y-2 p-4" onsubmit={send}>
						{#if editFrom !== null}
							<p class="flex justify-between text-xs text-text-muted">Editing the latest prompt{#if chat.messages[editFrom]?.documents?.length} · Add and review a PDF to include it again{/if} <button type="button" class="underline" disabled={dictationActive} onclick={endEdit}>Cancel edit</button></p>
						{/if}
						<label class="sr-only" for="chat-message">Message</label>
						<textarea id="chat-message" placeholder="Message Cyber v1" maxlength="24000" rows="3" disabled={busy || sending} bind:value={text} oninput={(event) => {
							pdfReview = null;
							if (storageKey && editFrom === null) saveDraft(storageKey, event.currentTarget.value);
						}} class="w-full resize-y rounded-xl border border-border bg-bg-surface p-3 text-base"></textarea>
						{#if attachments.length}
							<ul class="flex flex-wrap gap-2 text-xs" aria-label="Attachments">
								{#each attachments as file, index}
									<li class="rounded bg-bg-alt px-2 py-1">{file.name} <button type="button" class="underline" disabled={busy} onclick={() => (attachments = attachments.filter((_, i) => i !== index))}>Remove</button></li>
								{/each}
							</ul>
						{/if}
						{#if pdfDraft.length}
							<div class="max-h-36 space-y-2 overflow-auto text-xs" aria-label="PDF attachments">
								{#each pdfDraft as item (item.file.id)}
									<div class="flex flex-wrap items-center gap-2 rounded bg-bg-alt p-2">
										<button type="button" class="min-w-0 flex-1 break-words text-left underline" onclick={() =>
											openFiles({ id: item.file.id, name: item.file.name, page: 1, excerpt: "" })}>{item.file.name}</button>
										<input aria-label={`Pages for ${item.file.name}`} placeholder="Auto pages" maxlength="64" disabled={busy || sending}
											class="w-28 rounded border border-border bg-bg p-1 text-sm" value={item.pageInput} oninput={(event) => {
												setPdfDraft(pdfDraft.map((entry) => entry.file.id === item.file.id ? { ...entry, pageInput: event.currentTarget.value } : entry));
											}} />
										<button type="button" class="underline" disabled={busy || sending} onclick={() =>
											setPdfDraft(pdfDraft.filter((entry) => entry.file.id !== item.file.id))}>Detach</button>
									</div>
								{/each}
								<button type="button" class="underline" disabled={busy || sending || !text.trim()} onclick={reviewPdfs}>Review PDF excerpts</button>
							</div>
						{/if}
						{#if pdfReview}
							<section class="max-h-[32dvh] space-y-3 overflow-auto rounded border border-border bg-bg-surface p-3 text-sm" aria-label="PDF excerpts for NodeCode">
								<div class="flex justify-between gap-3">
									<h2 class="font-medium">PDF excerpts for NodeCode</h2>
									<button type="button" class="underline" disabled={busy || sending} onclick={() => (pdfReview = null)}>Close review</button>
								</div>
								<p class="text-xs text-text-muted">Sending includes the text shown below and its page numbers. Trim an excerpt or select text and tap Redact selection.</p>
								{#each pdfReview.documents as file (file.id)}
									{#each file.pages as excerpt (excerpt.page)}
										<div class="space-y-1 border-t border-border pt-2">
											<label for={`pdf-excerpt-${file.id}-${excerpt.page}`} class="block font-medium">{file.name} · Page {excerpt.page}</label>
											<textarea id={`pdf-excerpt-${file.id}-${excerpt.page}`} rows="4" maxlength="2400" spellcheck={false} autocomplete="off" autocapitalize="off" disabled={busy || sending}
												bind:value={excerpt.excerpt} class="w-full rounded border border-border bg-bg p-2 text-base"></textarea>
											<div class="flex flex-wrap gap-3 text-xs">
												<button type="button" class="underline" disabled={busy || sending} onclick={() => redactSelection(file.id, excerpt.page)}>Redact selection</button>
												<button type="button" class="underline" disabled={busy || sending} onclick={() => removeReviewedPage(file.id, excerpt.page)}>Remove page</button>
											</div>
										</div>
									{/each}
								{:else}
									<p>All pages were removed. Review again or detach the PDFs.</p>
								{/each}
							</section>
						{/if}
						<div class="flex flex-wrap items-center justify-between gap-2 text-sm">
							{#if filesEnabled}
								<button type="button" class="rounded border border-border px-2 py-1" disabled={busy || sending} onclick={() => openFiles()}>+ PDF</button>
							{/if}
							<label class="cursor-pointer text-text-muted underline">Attach text files<input type="file" accept="text/*,.md,.json,.csv,.log" multiple disabled={busy} onchange={attach} class="sr-only" /></label>
							{#each [chat.id] as dictationChatId (dictationChatId)}
								<ChatDictation disabled={busy || sending || showHandoff || voiceActive}
									onCapture={speech.stop}
									onActivity={(active) => (dictationActive = active)}
									onTranscript={(transcript) => appendDictation(dictationChatId, transcript)} />
							{/each}
							{#if searchEnabled}
								<button type="button" class="text-text-muted underline" disabled={busy} aria-expanded={showSearch} onclick={() => {
									if (showSearch) resetSearch();
									else showSearch = true;
								}}>Web search</button>
							{/if}
							{#if duplexEnabled}
								{#key chat.id}
									<ChatDuplex chatId={chat.id} disabled={busy || sending || dictationActive}
										onActivity={(active) => { voiceActive = active; if (active) speech.stop(); }} />
								{/key}
							{/if}
							{#if reasoningEnabled}
								<label class="sr-only" for="chat-reasoning">Reasoning effort</label>
								<select id="chat-reasoning" bind:value={reasoning} disabled={busy || sending} class="rounded border border-border bg-bg-surface px-2 py-1 text-sm">
									<option value="">Default</option>
									<option value="low">Fast</option>
									<option value="high">Think deeper</option>
								</select>
							{/if}
							<button type="submit" disabled={busy || sending || showHandoff || dictationActive || voiceActive || filesBusy || !text.trim()} class="rounded-lg bg-accent px-4 py-2 text-bg disabled:opacity-50">{pdfDraft.length ? "Send with excerpts" : editFrom === null ? "Send" : "Send edit"}</button>
						</div>
						<p class="text-xs text-text-muted">{pdfDraft.length ? "PDFs are stored on Conduit. Sending includes text excerpts from the selected pages." : "NodeCode receives the message, selected conversation context, and any text you attach."}</p>
					</form>
				{:else}
					<div class="grid flex-1 place-content-center p-6 text-center">
						<h1 class="text-xl font-semibold">What can I help with?</h1>
						<p class="mt-2 text-sm text-text-muted">Start a conversation or pick one from your inbox.</p>
					</div>
				{/if}
				<span class="sr-only" role="status">{feedback}</span>
				{#if speech.state.error}<p class="px-4 pb-3 text-sm text-error" role="alert">{speech.state.error}</p>{/if}
				{#if error}<p class="px-4 pb-3 text-sm text-error" role="alert">{error}</p>{/if}
			</main>
		</div>
	{/if}
</div>

{#if filesOpen}
	<ChatFilesPanel chatId={chat?.id} temporary={chat?.temporary ?? false} {ocrEnabled} selected={pdfDraft} initialPage={pdfPreview}
		onChange={setPdfDraft} onClose={() => (filesOpen = false)} onBusy={(active) => (filesBusy = active)}
		onDeleted={() => { if (chat) void reconcile(chat.id); }} />
{/if}
