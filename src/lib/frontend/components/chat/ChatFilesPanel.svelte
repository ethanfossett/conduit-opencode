<script lang="ts">
	import { onMount } from "svelte";
	import type { ChatDocumentCitation, ChatFile } from "../../../chat/types.js";
	import type { DraftPdf } from "../../utils/chat-file-drafts.js";

	type View = { id: string; name: string; page: number; excerpt?: string };
	let {
		chatId,
		temporary,
		selected,
		initialPage,
		onChange,
		onClose,
		onBusy,
		onDeleted,
	}: {
		chatId?: string;
		temporary: boolean;
		selected: DraftPdf[];
		initialPage?: ChatDocumentCitation;
		onChange: (files: DraftPdf[]) => void;
		onClose: () => void;
		onBusy: (busy: boolean) => void;
		onDeleted: () => void;
	} = $props();

	let view = $state<View | null>(null);
	let files = $state<ChatFile[]>([]);
	let query = $state("");
	let allUploads = $state(false);
	let details = $state<ChatFile | null>(null);
	let uses = $state<{ id: string; title: string }[]>([]);
	let name = $state("");
	let confirmDelete = $state(false);
	let removeExcerpts = $state(true);
	let working = $state(false);
	let error = $state("");
	let notice = $state("");
	let progress = $state<number | null>(null);
	let dialog: HTMLDialogElement;
	let dropped = false;
	let upload: XMLHttpRequest | undefined;
	const uploadLimit = 10 * 1024 * 1024;
	const available = $derived(!!chatId && selected.length < 4);

	async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
		const response = await fetch(`/api/chat${path}`, {
			method,
			signal: AbortSignal.timeout(15_000),
			headers: { "X-Conduit-Chat": "1", ...(body !== undefined && { "Content-Type": "application/json" }) },
			...(body !== undefined && { body: JSON.stringify(body) }),
		});
		const data = await response.json();
		if (!response.ok) throw new Error(data.message ?? "The PDF request failed.");
		return data as T;
	}

	async function run(action: () => Promise<void>) {
		if (working) return;
		working = true;
		onBusy(true);
		error = "";
		notice = "";
		try { await action(); }
		catch (err) { if (!dropped) error = err instanceof Error ? err.message : "Could not load this file."; }
		finally {
			working = false;
			if (!dropped) onBusy(false);
		}
	}

	async function refresh() {
		if (temporary) return;
		const endpoint = chatId ? `/${chatId}/files` : "/files";
		const params = new URLSearchParams();
		if (query.trim()) params.set("q", query.trim());
		if (allUploads) params.set("scope", "all");
		const result = await request<{ files: ChatFile[] }>(endpoint + (params.size ? `?${params}` : ""));
		if (!dropped) files = result.files;
	}

	onMount(() => {
		dialog.showModal();
		if (initialPage) {
			const page = initialPage;
			void run(() => openPage(page.id, page.name, page.page, page.excerpt));
		} else void run(refresh);
		return () => {
			dropped = true;
			upload?.abort();
			onBusy(false);
		};
	});

	async function openPage(id: string, label: string, page = 1, excerpt?: string) {
		view = { id, name: label, page, excerpt };
		details = null;
		uses = [];
		confirmDelete = false;
		const value = await request<{ file: ChatFile; uses: { id: string; title: string }[] }>(`/files/${id}`);
		if (dropped) return;
		details = value.file;
		name = value.file.name;
		uses = value.uses;
	}

	function add(file: ChatFile) {
		if (dropped || !available || selected.some((item) => item.file.id === file.id)) return;
		onChange([...selected, { file, pageInput: "" }]);
		notice = `Added ${file.name} to the draft.`;
	}

	function uploadPdf(file: File) {
		const owner = chatId;
		if (!available || !owner) return;
		void run(async () => {
			if (!file.size || file.size > uploadLimit) throw new Error("Choose a PDF of up to 10 MB.");
			progress = 0;
			try {
				const stored = await new Promise<ChatFile>((resolve, reject) => {
					const xhr = new XMLHttpRequest();
					upload = xhr;
					xhr.open("POST", `/api/chat/${owner}/files?name=${encodeURIComponent(file.name)}`);
					xhr.responseType = "json";
					xhr.timeout = 60_000;
					xhr.setRequestHeader("Content-Type", "application/pdf");
					xhr.setRequestHeader("X-Conduit-Chat", "1");
					xhr.upload.onprogress = (event) => {
						if (event.lengthComputable) progress = Math.round(event.loaded * 100 / event.total);
					};
					xhr.onload = () => {
						if (xhr.status === 201 && xhr.response?.id) resolve(xhr.response as ChatFile);
						else reject(new Error(xhr.response?.message ?? "The PDF could not be uploaded."));
					};
					xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error("Upload interrupted. Try again."));
					xhr.send(file);
				});
				if (!dropped) {
					add(stored);
					files = [stored, ...files];
					if (!stored.textPages) notice = "PDF added for preview. Scanned pages need OCR before they can be used in an answer.";
				}
			} finally {
				progress = null;
				upload = undefined;
			}
		});
	}

	function picked(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (file) uploadPdf(file);
		input.value = "";
	}

	function update(changes: { name?: string; saved?: boolean }) {
		const file = details;
		if (!file) return;
		void run(async () => {
			const result = await request<{ file: ChatFile }>(`/files/${file.id}`, "POST", changes);
			details = result.file;
			name = result.file.name;
			if (view) view = { ...view, name };
			files = files.map((entry) => entry.id === file.id ? result.file : entry);
			if (selected.some((item) => item.file.id === file.id)) {
				onChange(selected.map((item) => item.file.id === file.id ? { ...item, file: result.file } : item));
			}
			notice = changes.saved === true ? "Saved to your library." : changes.saved === false ? "Removed from your library." : "Renamed.";
		});
	}

	function remove() {
		const id = details?.id;
		if (!id) return;
		void run(async () => {
			await request(`/files/${id}${removeExcerpts ? "?removeExcerpts=1" : ""}`, "DELETE");
			onDeleted();
			onChange(selected.filter(({ file }) => file.id !== id));
			files = files.filter((file) => file.id !== id);
			view = null;
			details = null;
			confirmDelete = false;
			notice = removeExcerpts ? "File and attached excerpts deleted." : "File deleted.";
		});
	}

	function turnPage(offset: number) {
		if (!view || !details) return;
		const page = view.page + offset;
		if (page >= 1 && page <= details.pages) view = { id: view.id, name: view.name, page };
	}
</script>

<dialog bind:this={dialog} oncancel={(event) => { event.preventDefault(); if (!working) onClose(); }}
	aria-labelledby="chat-files-title"
	class="fixed m-auto max-h-[90dvh] w-[calc(100%-1rem)] max-w-3xl overflow-auto rounded-xl border border-border bg-bg-surface p-4 text-text backdrop:bg-black/50">
	<header class="mb-4 flex items-center justify-between gap-4">
		<h2 id="chat-files-title" class="break-words text-lg font-semibold">{view ? view.name : "Files"}</h2>
		<button type="button" class="shrink-0 rounded border border-border px-3 py-2 text-sm" disabled={working} onclick={onClose}>Close</button>
	</header>
	{#if error}<p role="alert" class="mb-3 text-sm text-error">{error}</p>{/if}
	{#if notice}<p role="status" class="mb-3 text-sm text-text-muted">{notice}</p>{/if}
	{#if view}
		{#if details}
			<div class="mb-3 flex flex-wrap gap-3 text-sm">
				<button type="button" class="underline" onclick={() => { view = null; details = null; confirmDelete = false; void run(refresh); }}>Back to files</button>
				<a class="underline" href={`/api/chat/files/${view.id}/download`} download>Download</a>
				{#if available && (details.saved || (!allUploads && files.some((file) => file.id === details?.id)))}
					<button type="button" class="underline" onclick={() => details && add(details)}>Add to chat</button>
				{/if}
				{#if !details.temporary}
					<button type="button" class="underline" disabled={working} onclick={() => update({ saved: !details?.saved })}>{details.saved ? "Remove from library" : "Save to library"}</button>
				{/if}
			</div>
			<div class="mb-3 flex items-center justify-between gap-2 text-sm">
				<button type="button" class="rounded border border-border px-3 py-2 disabled:opacity-50" disabled={view.page <= 1} onclick={() => turnPage(-1)}>Previous page</button>
				<span>Page {view.page} of {details.pages}</span>
				<button type="button" class="rounded border border-border px-3 py-2 disabled:opacity-50" disabled={view.page >= details.pages} onclick={() => turnPage(1)}>Next page</button>
			</div>
			{#if view.excerpt}<blockquote class="mb-3 max-h-36 overflow-auto whitespace-pre-wrap rounded bg-bg-alt p-3 text-sm">{view.excerpt}</blockquote>{/if}
			{#key `${view.id}:${view.page}`}
				<img class="mx-auto block max-h-[60dvh] max-w-full rounded bg-white object-contain"
					src={`/api/chat/files/${view.id}/page/${view.page}`} alt={`Page ${view.page} preview`}
					onerror={() => (error = "Could not render this PDF page.")} />
			{/key}
			<section class="mt-4 space-y-2 border-t border-border pt-3 text-sm" aria-label="File management">
				{#if !details.temporary}
					<form class="flex gap-2" onsubmit={(event) => { event.preventDefault(); update({ name }); }}>
						<input aria-label="File name" maxlength="120" bind:value={name} class="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-base" />
						<button type="submit" class="underline" disabled={working || !name.trim()}>Rename</button>
					</form>
				{/if}
				{#if uses.length}
					<p class="text-text-muted">Used in {uses.map((chat) => chat.title).join(", ")}.</p>
				{/if}
				{#if confirmDelete}
					<p>Delete the original and its searchable text from Conduit?</p>
					<label class="flex items-start gap-2">
						<input type="checkbox" bind:checked={removeExcerpts} disabled={working} />
						<span>Remove attached excerpts and citations from conversations</span>
					</label>
					<p class="text-xs text-text-muted">Earlier messages may still quote the PDF. With excerpts removed, Conduit leaves those earlier messages out of future model requests.</p>
					<button type="button" class="me-3 text-error underline" disabled={working} onclick={remove}>Confirm file deletion</button>
					<button type="button" class="underline" onclick={() => (confirmDelete = false)}>Cancel</button>
				{:else}
					<button type="button" class="text-error underline" disabled={working} onclick={() => { removeExcerpts = true; confirmDelete = true; }}>Delete original</button>
				{/if}
			</section>
		{:else if working}<p role="status">Opening PDF…</p>{/if}
	{:else}
		{#if available}
			<div role="region" aria-label="Upload or drop a PDF" class="flex flex-wrap items-center gap-2 rounded border border-dashed border-border p-2"
				ondragover={(event) => event.preventDefault()} ondrop={(event) => {
					event.preventDefault();
					const file = event.dataTransfer?.files[0];
					if (file) uploadPdf(file);
				}}>
				<label class="inline-flex cursor-pointer rounded bg-accent px-4 py-2 text-sm text-bg">
					Upload PDF <input type="file" accept="application/pdf,.pdf" class="sr-only" onchange={picked} disabled={working} />
				</label>
				<span class="hidden text-sm text-text-muted sm:inline">or drop a PDF here</span>
			</div>
			{#if progress !== null}
				<p class="mt-2 text-sm" role="status">{progress === 100 ? "Reading PDF on your server…" : `Uploading ${progress}%`}</p>
			{/if}
		{/if}
		{#if !temporary}
			<form class="my-3 flex gap-2" aria-label="Search files" onsubmit={(event) => { event.preventDefault(); void run(refresh); }}>
				<input type="search" aria-label="Search library" placeholder="Search names and PDF text" bind:value={query}
					class="min-w-0 flex-1 rounded border border-border bg-bg p-2 text-base" />
				<button type="submit" class="rounded border border-border px-3 text-sm" disabled={working}>Search</button>
			</form>
			<button type="button" class="mb-3 text-sm underline" disabled={working} onclick={() => {
				allUploads = !allUploads;
				void run(refresh);
			}}>{allUploads ? "Show library and this chat" : "Show all uploads"}</button>
			{#if files.length}
				<ul class="divide-y divide-border" aria-label="Available files">
					{#each files as file (file.id)}
						<li class="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
							<button type="button" class="min-w-0 flex-1 break-words text-left underline" disabled={working} onclick={() => run(() => openPage(file.id, file.name))}>{file.name}</button>
							<span class="text-xs text-text-muted">{file.saved ? "Library" : allUploads ? "Chat upload" : "This chat"} · {file.pages} pages</span>
							{#if available && (!allUploads || file.saved)}
								<button type="button" class="rounded border border-border px-2 py-1" disabled={working || selected.some((item) => item.file.id === file.id)} onclick={() => add(file)}>Add to chat</button>
							{/if}
						</li>
					{/each}
				</ul>
			{:else if !working}<p class="text-sm text-text-muted">No files found.</p>{/if}
		{/if}
	{/if}
</dialog>
