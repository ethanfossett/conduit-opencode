<script lang="ts">
	import { onMount, tick } from "svelte";
	import type { ChatAttachment, ChatConversation, ChatSearchResult } from "../../chat/types.js";
	import { clearAcceptedDraft, draftKey, loadDraft, saveDraft } from "../utils/drafts.js";
	import { renderMarkdown } from "../utils/markdown.js";
	import { stageChatHandoff } from "../stores/chat-handoff.svelte.js";
	import type { ProjectsListResponse } from "../../shared-types.js";
	import { navigate } from "../stores/router.svelte.js";

	type Summary = Pick<ChatConversation, "id" | "title" | "updatedAt">;
	let conversations = $state<Summary[]>([]);
	let chat = $state<ChatConversation | null>(null);
	let text = $state("");
	let attachments = $state<ChatAttachment[]>([]);
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
		if (!response.ok) throw new Error(result.message ?? "Chat is unavailable.");
		return result as T;
	}

	async function refresh() {
		const result = await api<{enabled: boolean; searchEnabled: boolean; conversations: Summary[]}>();
		enabled = result.enabled;
		searchEnabled = result.searchEnabled;
		conversations = result.conversations;
	}

	function display(conversation: ChatConversation | null) {
		chat = conversation;
		text = conversation && !conversation.temporary ? loadDraft(draftKey("conversation", conversation.id)) : "";
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
		void run(async () => {
			try {
				await refresh();
				const id = new URL(location.href).searchParams.get("c");
				if (id && conversations.some((item) => item.id === id)) display(await api<ChatConversation>(`/${id}`));
			} finally {
				loading = false;
			}
		});
	});

	function create(temporary: boolean) {
		void run(async () => {
			display(await api<ChatConversation>("", "POST", { temporary }));
			await refresh();
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

	function send(event: SubmitEvent) {
		event.preventDefault();
		const conversation = chat;
		const prompt = text.trim();
		if (!conversation || !prompt || busy || showHandoff) return;
		const submitted = text;
		const draft = storageKey;
		void run(async () => {
			const result = await api<ChatConversation>(`/${conversation.id}`, "POST", {
				text: prompt,
				...(attachments.length ? { attachments } : {}),
				...(includeSources && searchResult && { searchId: searchResult.id }),
			});
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
		{#if enabled}<span class="text-xs text-text-muted">NodeCode · Cyber v1</span>{/if}
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
				<ul class="space-y-1" aria-label="Conversations">
					{#each conversations as summary (summary.id)}
						<li><button type="button" class="w-full truncate rounded-md px-2 py-1 text-left text-sm hover:bg-bg-alt" class:bg-bg-alt={chat?.id === summary.id} disabled={busy} onclick={() => select(summary.id)}>{summary.title}</button></li>
					{/each}
				</ul>
			</aside>
			<main class="flex min-h-0 min-w-0 flex-1 flex-col">
				{#if chat}
					<div class="flex flex-wrap justify-between gap-2 border-b border-border px-4 py-2 text-xs text-text-muted">
						<span>{chat.temporary ? "Temporary · erased on relay restart or after 1 hour idle" : chat.title}</span>
						{#if confirmDelete}
							<button type="button" class="text-error underline" disabled={busy} onclick={() => void run(async () => {
								if (!chat) return;
								await api(`/${chat.id}`, "DELETE");
								if (storageKey) saveDraft(storageKey, "");
								display(null);
								await refresh();
							})}>Confirm delete</button>
							<button type="button" class="underline" onclick={() => (confirmDelete = false)}>Cancel</button>
						{:else}
							<button type="button" class="underline" disabled={busy} onclick={() => (confirmDelete = true)}>Delete chat</button>
						{/if}
					</div>
					<div bind:this={scroll} class="min-h-0 flex-1 overflow-auto px-4 py-5" role="log" aria-label="Messages">
						<div class="mx-auto max-w-2xl space-y-5">
							{#each chat.messages as message}
								<div class="break-words rounded-xl px-4 py-3 text-sm" class:bg-bg-alt={message.role === "user"}>
									<span class="mb-1 block text-xs font-medium text-text-muted">{message.role === "user" ? "You" : "Cyber v1"}</span>
									{#if message.role === "assistant"}
										<div class="md-content overflow-x-auto text-sm leading-relaxed">{@html renderMarkdown(message.text, chatMarkdown)}</div>
									{:else}
										<p class="whitespace-pre-wrap">{message.text}</p>
									{/if}
									{#each message.attachments ?? [] as file}
										<span class="mt-1 block text-xs text-text-muted">Attachment · {file.name}</span>
									{/each}
									{#if message.sourceContext}
										<ol class="mt-2 space-y-1 text-xs text-text-muted" aria-label="Web sources">
											{#each message.sourceContext.sources as source, index}
												<li>[{index + 1}] <a class="underline" href={source.url} target="_blank" rel="noreferrer noopener">{source.title || new URL(source.url).hostname}</a></li>
											{/each}
										</ol>
									{/if}
									<button type="button" class="mt-2 text-xs text-text-muted underline" disabled={busy} onclick={() => prepareHandoff(message.text)}>Continue in Code</button>
								</div>
							{/each}
							{#if busy}<p class="text-sm text-text-muted">Working…</p>{/if}
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
								<p class="text-xs text-text-muted">Brave Search receives this query through Mullvad. Search starts when you select Run search.</p>
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
						<label class="sr-only" for="chat-message">Message</label>
						<textarea id="chat-message" placeholder="Message Cyber v1" maxlength="24000" rows="3" disabled={busy} bind:value={text} oninput={(event) => {
							if (storageKey) saveDraft(storageKey, event.currentTarget.value);
						}} class="w-full resize-y rounded-xl border border-border bg-bg-surface p-3 text-base"></textarea>
						{#if attachments.length}
							<ul class="flex flex-wrap gap-2 text-xs" aria-label="Attachments">
								{#each attachments as file, index}
									<li class="rounded bg-bg-alt px-2 py-1">{file.name} <button type="button" class="underline" disabled={busy} onclick={() => (attachments = attachments.filter((_, i) => i !== index))}>Remove</button></li>
								{/each}
							</ul>
						{/if}
						<div class="flex items-center justify-between gap-2 text-sm">
							<label class="cursor-pointer text-text-muted underline">Attach text files<input type="file" accept="text/*,.md,.json,.csv,.log" multiple disabled={busy} onchange={attach} class="sr-only" /></label>
							{#if searchEnabled}
								<button type="button" class="text-text-muted underline" disabled={busy} aria-expanded={showSearch} onclick={() => {
									if (showSearch) resetSearch();
									else showSearch = true;
								}}>Web search</button>
							{/if}
							<button type="submit" disabled={busy || showHandoff || !text.trim()} class="rounded-lg bg-accent px-4 py-2 text-bg disabled:opacity-50">Send</button>
						</div>
						<p class="text-xs text-text-muted">NodeCode receives the message, recent context, and any files you attach.</p>
					</form>
				{:else}
					<div class="grid flex-1 place-content-center p-6 text-center">
						<h1 class="text-xl font-semibold">What can I help with?</h1>
						<p class="mt-2 text-sm text-text-muted">Start a conversation or pick one from your inbox.</p>
					</div>
				{/if}
				{#if error}<p class="px-4 pb-3 text-sm text-error" role="alert">{error}</p>{/if}
			</main>
		</div>
	{/if}
</div>
