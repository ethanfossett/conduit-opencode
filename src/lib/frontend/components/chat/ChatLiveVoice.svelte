<script lang="ts">
	import { onDestroy } from "svelte";
	import type { ChatConversation } from "../../../chat/types.js";

	let { chat, requestId, disabled, onActivity, onTranscript, onInterrupt }: {
		chat: ChatConversation;
		requestId: string | null;
		disabled: boolean;
		onActivity: (active: boolean) => void;
		onTranscript: (text: string) => Promise<void>;
		onInterrupt: (requestId: string, played: number) => Promise<void>;
	} = $props();

	let status = $state<"idle" | "connecting" | "listening">("idle");
	let note = $state("");
	let transcript = $state("");
	let transcribing = $state(false);
	let hold = $state(false);
	let muted = $state(false);
	let peer: RTCPeerConnection | undefined;
	let channel: RTCDataChannel | undefined;
	let mic: MediaStream | undefined;
	let audio: AudioContext | undefined;
	let startup: ReturnType<typeof setTimeout> | undefined;
	let network: ReturnType<typeof setTimeout> | undefined;
	let keepalive: ReturnType<typeof setInterval> | undefined;
	let activity: ReturnType<typeof setInterval> | undefined;
	let duckTimer: ReturnType<typeof setTimeout> | undefined;
	let volume: GainNode | undefined;
	let epoch = 0;
	let rate = 24_000;
	let next = 0;
	let currentId: string | null = null;
	let interruptedId: string | null = null;
	let offset = 0;
	let pendingPhrases = 0;
	let lastReply = "";
	let played = 0;
	let outputFinished = false;
	let hearing = false;
	const sources = new Set<AudioBufferSourceNode>();

	function send(data: object) {
		if (channel?.readyState !== "open") return false;
		channel.send(JSON.stringify({ type: "conduit-voice", ...data }));
		return true;
	}

	function clearAudio() {
		for (const source of sources) {
			source.onended = null;
			try { source.stop(); } catch { /* Already stopped. */ }
			source.disconnect();
		}
		sources.clear();
		next = 0;
	}

	export async function interrupt() {
		const id = currentId ?? requestId;
		const heard = played;
		const truncated = lastReply.length > heard || !outputFinished;
		if (id) interruptedId = id;
		clearAudio();
		send({ kind: "flush" });
		hearing = false;
		restoreVolume();
		if (audio?.state === "suspended") void audio.resume().catch(() => {});
		if (id && truncated) await onInterrupt(id, heard);
	}

	function stop(message = "", commit = true) {
		if (status === "idle") return;
		if (commit && (currentId || requestId)) void interrupt().catch(() => {});
		epoch++;
		clearTimeout(startup);
		clearTimeout(network);
		clearInterval(keepalive);
		clearInterval(activity);
		clearTimeout(duckTimer);
		send({ kind: "close" });
		channel?.close();
		peer?.close();
		channel = undefined;
		peer = undefined;
		for (const track of mic?.getTracks() ?? []) track.stop();
		mic = undefined;
		clearAudio();
		if (audio) void audio.close().catch(() => {});
		audio = undefined;
		volume = undefined;
		status = "idle";
		hold = false;
		muted = false;
		transcribing = false;
		transcript = "";
		note = message;
		currentId = null;
		interruptedId = null;
		offset = played = pendingPhrases = 0;
		lastReply = "";
		outputFinished = false;
		hearing = false;
		onActivity(false);
	}

	function restoreVolume() {
		clearTimeout(duckTimer);
		if (audio && volume) volume.gain.setTargetAtTime(1, audio.currentTime, 0.025);
	}

	function monitorMicrophone(ctx: AudioContext, stream: MediaStream) {
		const input = ctx.createMediaStreamSource(stream);
		const meter = ctx.createAnalyser();
		meter.fftSize = 1024;
		const silent = ctx.createGain();
		silent.gain.value = 0;
		input.connect(meter).connect(silent).connect(ctx.destination);
		const samples = new Float32Array(meter.fftSize);
		let loud = 0;
		activity = setInterval(() => {
			if (ctx.state !== "running" || muted || !volume || next < ctx.currentTime || hearing) {
				loud = 0;
				return;
			}
			meter.getFloatTimeDomainData(samples);
			let energy = 0;
			for (const sample of samples) energy += sample * sample;
			loud = energy / samples.length > 0.00045 ? loud + 1 : 0;
			if (loud !== 2) return;
			// The speaker reacts first. Only the local speech detector and
			// transcript can actually cancel the turn or submit a correction.
			volume.gain.setTargetAtTime(0.12, ctx.currentTime, 0.012);
			clearTimeout(duckTimer);
			duckTimer = setTimeout(restoreVolume, 360);
		}, 30);
	}

	function play(pcm: string) {
		const ctx = audio;
		if (!ctx || pcm.length > 12_000) return;
		const bytes = Uint8Array.from(atob(pcm), (c) => c.charCodeAt(0));
		if (!bytes.length || bytes.length % 2) return;
		if (next - ctx.currentTime > 6) {
			stop("Audio fell behind. Reopen voice to continue.");
			return;
		}
		const data = new DataView(bytes.buffer);
		const buffer = ctx.createBuffer(1, bytes.length / 2, rate);
		const samples = buffer.getChannelData(0);
		for (let index = 0; index < samples.length; index++) samples[index] = data.getInt16(index * 2, true) / 32768;
		const player = ctx.createBufferSource();
		player.buffer = buffer;
		player.connect(volume ?? ctx.destination);
		if (next < ctx.currentTime) next = ctx.currentTime + 0.04;
		sources.add(player);
		player.onended = () => {
			sources.delete(player);
			player.disconnect();
		};
		player.start(next);
		next += buffer.duration;
	}

	function markWhenPlayed(end: number) {
		const ctx = audio;
		if (!ctx) return;
		if (next <= ctx.currentTime) {
			played = Math.max(played, end);
			return;
		}
		const marker = ctx.createBufferSource();
		marker.buffer = ctx.createBuffer(1, 1, rate);
		marker.connect(ctx.destination);
		sources.add(marker);
		marker.onended = () => {
			played = Math.max(played, end);
			sources.delete(marker);
			marker.disconnect();
		};
		marker.start(next);
	}

	function spokenText(raw: string) {
		return raw.replace(/\[(?:D\d+:p\d+|\d+)\]/g, "").replace(/[`*_#]/g, "").trim();
	}

	function feed(id: string, reply: string, complete: boolean) {
		if (id === interruptedId) return;
		if (currentId !== id) {
			clearAudio();
			currentId = id;
			offset = played = pendingPhrases = 0;
			lastReply = "";
			outputFinished = false;
		}
		lastReply = reply;
		while (offset < reply.length && pendingPhrases < 3) {
			const pending = reply.slice(offset);
			const boundary = /[.!?](?=\s)|\n/.exec(pending);
			let end = boundary && boundary.index < 350 ? boundary.index + 1 : 0;
			if (end < 14 && !complete && pending.length < 105) break;
			if (!end && pending.length > 320) {
				const space = pending.lastIndexOf(" ", 320);
				end = space > 0 ? space + 1 : 320;
			}
			if (!end && pending.length >= 105) {
				const comma = /[,;:](?=\s)/.exec(pending);
				if (comma && comma.index >= 45 && comma.index < 320) end = comma.index + 1;
			}
			if (!end && complete) end = pending.length;
			if (!end) break;
			const text = spokenText(pending.slice(0, end));
			if (text) {
				if (!send({ kind: "speak", id, end: offset + end, text })) break;
				pendingPhrases++;
			}
			offset += end;
		}
		outputFinished = complete;
	}

	$effect(() => {
		const id = requestId;
		const run = chat.turn;
		const last = chat.messages.at(-1);
		if (!id || status !== "listening") return;
		if (run?.id === id && run.status === "running") feed(id, run.reply ?? "", false);
		if (last?.voiceTurnId === id && !last.interrupted) feed(id, last.text, true);
		if (run?.id === id && run.status === "failed") {
			note = run.error ?? "The selected model could not answer.";
		}
	});

	async function incoming(event: MessageEvent) {
		if (typeof event.data !== "string") return;
		const data = JSON.parse(event.data);
		if (data.kind === "ready" && Number.isInteger(data.rate) && data.rate >= 8000 && data.rate <= 48000) {
			rate = data.rate;
			clearTimeout(startup);
			status = "listening";
		} else if (data.kind === "speech-start") {
			hearing = !!(currentId && (!outputFinished || pendingPhrases || offset < lastReply.length || sources.size));
			if (hearing) {
				clearTimeout(duckTimer);
				send({ kind: "pause-output", enabled: true });
				if (audio?.state === "running") void audio.suspend().catch(() => {});
			}
		} else if (data.kind === "transcribing") {
			transcribing = true;
		} else if (data.kind === "transcript" && typeof data.text === "string") {
			transcribing = false;
			const said = data.text.trim();
			const backchannel = /^(?:m+h+m+|mm[ -]?hmm|uh[ -]?huh|yeah|okay|ok|right|thanks|thank you)[.!?,]*$/i.test(said);
			if (!said || (hearing && backchannel)) {
				hearing = false;
				restoreVolume();
				send({ kind: "pause-output", enabled: false });
				if (audio?.state === "suspended") await audio.resume();
				return;
			}
			transcript = said;
			note = "";
			if (hearing || (currentId && !outputFinished && interruptedId !== currentId)) await interrupt();
			if (!/^(?:stop|wait|hold on|one second)[.!?]?$/i.test(said)) await onTranscript(said);
		} else if (data.kind === "audio" && data.id === currentId && data.id !== interruptedId && typeof data.pcm === "string") {
			play(data.pcm);
		} else if (data.kind === "audio-end" && data.id === currentId && data.id !== interruptedId && Number.isInteger(data.end)) {
			markWhenPlayed(data.end);
			pendingPhrases = Math.max(0, pendingPhrases - 1);
			feed(data.id, lastReply, outputFinished);
		} else if (data.kind === "transcript-error" || data.kind === "synthesis-error") {
			transcribing = false;
			if (data.kind === "synthesis-error" && data.id === currentId) {
				interruptedId = currentId;
				send({ kind: "flush" });
			}
			note = data.kind === "transcript-error" ? "Could not transcribe. Try again." : "Local speech synthesis paused.";
			restoreVolume();
			send({ kind: "pause-output", enabled: false });
			if (audio?.state === "suspended") void audio.resume().catch(() => {});
		}
	}

	async function start() {
		if (status !== "idle" || disabled) return;
		const run = ++epoch;
		status = "connecting";
		note = "";
		onActivity(true);
		try {
			const ctx = new AudioContext({ latencyHint: "interactive" });
			audio = ctx;
			volume = ctx.createGain();
			volume.connect(ctx.destination);
			await ctx.resume();
			if (run !== epoch) return;
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});
			if (run !== epoch) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			mic = stream;
			monitorMicrophone(ctx, stream);
			const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
			peer = pc;
			for (const track of stream.getAudioTracks()) pc.addTransceiver(track, { direction: "sendonly" });
			const dc = pc.createDataChannel("data");
			channel = dc;
			dc.onopen = () => {
				send({ kind: "hello" });
				keepalive = setInterval(() => {
					if (dc.readyState === "open") dc.send("ping");
				}, 1_000);
			};
			dc.onmessage = (event) => {
				if (run === epoch) void incoming(event).catch(() => {
					note = "Could not continue the voice turn. Try again.";
				});
			};
			pc.onconnectionstatechange = () => {
				if (run !== epoch) return;
				clearTimeout(network);
				if (pc.connectionState === "failed" || pc.connectionState === "closed") stop("Voice disconnected.");
				else if (pc.connectionState === "disconnected")
					network = setTimeout(() => stop("Voice disconnected."), 4_000);
			};
			dc.onclose = () => { if (run === epoch) stop("Voice disconnected."); };
			startup = setTimeout(() => stop("Could not connect to local voice."), 12_000);
			await pc.setLocalDescription(await pc.createOffer());
			await new Promise<void>((resolve) => {
				if (pc.iceGatheringState === "complete") return resolve();
				const ready = () => {
					if (pc.iceGatheringState !== "complete") return;
					clearTimeout(timer);
					pc.removeEventListener("icegatheringstatechange", ready);
					resolve();
				};
				const timer = setTimeout(() => {
					pc.removeEventListener("icegatheringstatechange", ready);
					resolve();
				}, 1_200);
				pc.addEventListener("icegatheringstatechange", ready);
			});
			if (run !== epoch) return;
			const response = await fetch(`/api/chat/${chat.id}/voice/offer`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-Conduit-Chat": "1" },
				body: JSON.stringify({ sdp: pc.localDescription?.sdp }),
			});
			if (!response.ok) {
				const error = await response.json().catch(() => null);
				throw new Error(error?.message ?? "Could not connect to local voice.");
			}
			const answer = await response.json();
			if (run === epoch) await pc.setRemoteDescription(answer);
		} catch (error) {
			if (run === epoch) stop(error instanceof Error ? error.message : "Could not start voice.");
		}
	}

	function toggleMute() {
		muted = !muted;
		for (const track of mic?.getAudioTracks() ?? []) track.enabled = !muted;
	}

	function toggleHold() {
		hold = !hold;
		send({ kind: "hold", enabled: hold });
	}

	function hidden() {
		if (document.hidden) stop("Voice paused when Chat went into the background.");
	}

	onDestroy(() => stop("", false));
</script>

<svelte:document onvisibilitychange={hidden} />
<svelte:window onpagehide={() => stop()} />

{#if status === "idle"}
	<button type="button" class="text-text-muted underline" {disabled} onclick={start}>Talk to Chat</button>
{:else}
	<button type="button" class="text-error underline" onclick={() => stop()}>End voice</button>
	{#if status === "listening"}
		<button type="button" class="text-text-muted underline" aria-pressed={muted} onclick={toggleMute}>{muted ? "Unmute mic" : "Mute mic"}</button>
		<button type="button" class="text-text-muted underline" aria-pressed={hold} onclick={toggleHold}>{hold ? "Let Chat respond" : "Let me finish"}</button>
	{/if}
	<span role="status" class="text-text-muted">{status === "connecting" ? "Connecting to local audio…" : muted ? "Mic muted" : transcribing ? "Transcribing…" : hold ? "Listening until you’re ready" : "Mic on"}</span>
{/if}
{#if transcript}<span class="basis-full break-words text-text-muted">Heard you say “{transcript}”</span>{/if}
{#if note}<span role="status" class="basis-full text-text-muted">{note}</span>{/if}
