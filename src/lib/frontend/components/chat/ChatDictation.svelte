<script lang="ts">
	import { onMount } from "svelte";
	import Icon from "../shared/Icon.svelte";

	let {
		disabled = false,
		onActivity,
		onCapture,
		onTranscript,
	}: {
		disabled?: boolean;
		onActivity: (active: boolean) => void;
		onCapture: () => void;
		onTranscript: (transcript: string) => boolean;
	} = $props();

	const MAX_AUDIO = 8 * 1024 * 1024;
	const MAX_DURATION = 60_000;
	type Phase = "idle" | "requesting" | "recording" | "transcribing" | "retry";
	let phase = $state<Phase>("idle");
	let status = $state("");
	let recorder: MediaRecorder | undefined;
	let stream: MediaStream | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let upload: AbortController | undefined;
	let audio: Blob | undefined;
	let generation = 0;

	function change(next: Phase) {
		phase = next;
		onActivity(next !== "idle" && next !== "retry");
	}

	function releaseMic() {
		clearTimeout(timer);
		timer = undefined;
		for (const track of stream?.getTracks() ?? []) track.stop();
		stream = undefined;
	}

	function interrupt() {
		if (phase === "requesting") {
			generation++;
			change("idle");
			status = "Microphone request interrupted.";
		} else if (phase === "recording") {
			finish();
		}
	}

	onMount(() => {
		const hidden = () => {
			if (document.hidden) interrupt();
		};
		document.addEventListener("visibilitychange", hidden);
		window.addEventListener("pagehide", interrupt);
		return () => {
			document.removeEventListener("visibilitychange", hidden);
			window.removeEventListener("pagehide", interrupt);
			generation++;
			upload?.abort();
			if (recorder && recorder.state !== "inactive") recorder.stop();
			releaseMic();
			onActivity(false);
		};
	});

	async function transcribe(blob: Blob, session: number) {
		change("transcribing");
		status = "";
		audio = blob;
		upload = new AbortController();
		try {
			const response = await fetch("/api/stt", {
				method: "POST",
				headers: {
					"Content-Type": blob.type,
					"X-Conduit-Local-Dictation": "1",
				},
				body: blob,
				signal: AbortSignal.any([upload.signal, AbortSignal.timeout(125_000)]),
			});
			if (response.status === 401) throw new Error("Sign in again to use dictation.");
			if (!response.ok) throw new Error("Local dictation is unavailable. You can retry this recording.");
			const { text } = await response.json() as { text?: string };
			if (session !== generation) return;
			const transcript = text?.trim();
			if (transcript && !onTranscript(transcript)) {
				throw new Error("The draft is full. Shorten it before retrying dictation.");
			}
			audio = undefined;
			change("idle");
			status = transcript ? "Transcript added to your draft." : "No speech detected.";
		} catch (err) {
			if (session !== generation) return;
			change("retry");
			status = err instanceof Error && err.name === "TypeError"
				? "Connection lost. You can retry this recording."
				: err instanceof Error ? err.message : "Could not transcribe the recording.";
		} finally {
			if (session === generation) upload = undefined;
		}
	}

	function finish() {
		const active = recorder;
		if (!active || active.state === "inactive") return;
		change("transcribing");
		active.stop();
		releaseMic();
	}

	async function start() {
		if (disabled || phase !== "idle") return;
		if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
			status = "Microphone recording is unavailable in this browser.";
			return;
		}
		onCapture();
		const session = ++generation;
		status = "";
		change("requesting");
		try {
			const input = await navigator.mediaDevices.getUserMedia({ audio: true });
			if (session !== generation || document.hidden) {
				for (const track of input.getTracks()) track.stop();
				if (session === generation) interrupt();
				return;
			}
			stream = input;
			const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
			const mimeType = candidates.find((type) => MediaRecorder.isTypeSupported(type));
			const current = new MediaRecorder(input, mimeType ? { mimeType } : undefined);
			const chunks: Blob[] = [];
			let size = 0;
			recorder = current;
			current.ondataavailable = ({ data }) => {
				if (session !== generation || !data.size) return;
				size += data.size;
				if (size <= MAX_AUDIO) chunks.push(data);
			};
			current.onerror = () => {
				if (session !== generation) return;
				generation++;
				recorder = undefined;
				releaseMic();
				change("idle");
				status = "Recording was interrupted. Try again.";
			};
			current.onstop = () => {
				if (session !== generation) return;
				recorder = undefined;
				releaseMic();
				if (size === 0 || size > MAX_AUDIO) {
					change("idle");
					status = size ? "Recording was too large. Try a shorter recording." : "No audio recorded.";
					return;
				}
				void transcribe(new Blob(chunks, { type: current.mimeType || chunks[0]?.type || "audio/webm" }), session);
			};
			for (const track of input.getTracks()) track.addEventListener("ended", finish, { once: true });
			current.start();
			timer = setTimeout(finish, MAX_DURATION);
			change("recording");
		} catch {
			if (session !== generation) return;
			recorder = undefined;
			releaseMic();
			change("idle");
			status = "Microphone unavailable. Check your browser’s microphone permission.";
		}
	}

	function discard() {
		audio = undefined;
		status = "";
		change("idle");
	}
</script>

<div class="flex flex-wrap items-center gap-2">
	{#if phase === "retry" && audio}
		<button type="button" class="underline" {disabled} onclick={() => audio && void transcribe(audio, generation)}>Retry dictation</button>
		<button type="button" class="underline" onclick={discard}>Discard recording</button>
	{:else}
		<button type="button" class="inline-flex min-h-8 items-center gap-1 rounded border border-border px-2 disabled:opacity-50"
			class:text-accent={phase === "recording"} aria-pressed={phase === "recording"} aria-busy={phase === "requesting" || phase === "transcribing"}
			disabled={disabled || phase === "requesting" || phase === "transcribing"} onclick={phase === "recording" ? finish : start}>
			<Icon name="mic" size={16} />
			{phase === "recording" ? "Stop dictation" : phase === "transcribing" ? "Transcribing…" : phase === "requesting" ? "Opening mic…" : "Dictate"}
		</button>
	{/if}
	{#if status}<span class="text-xs text-text-muted" role="status">{status}</span>{/if}
</div>
