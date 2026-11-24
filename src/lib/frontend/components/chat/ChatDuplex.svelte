<script lang="ts">
	import { onDestroy } from "svelte";

	let { chatId, disabled, onActivity }: {
		chatId: string;
		disabled: boolean;
		onActivity: (active: boolean) => void;
	} = $props();

	const rate = 24_000;
	let status = $state<"idle" | "connecting" | "listening">("idle");
	let note = $state("");
	let epoch = 0;
	let context: AudioContext | undefined;
	let microphone: MediaStream | undefined;
	let capture: AudioWorkletNode | undefined;
	let connection: WebSocket | undefined;
	let nextAudio = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	function stop(message = "") {
		epoch++;
		clearTimeout(timer);
		capture?.disconnect();
		capture?.port.close();
		capture = undefined;
		for (const track of microphone?.getTracks() ?? []) track.stop();
		microphone = undefined;
		if (connection && connection.readyState < WebSocket.CLOSING) connection.close();
		connection = undefined;
		if (context) void context.close().catch(() => {});
		context = undefined;
		nextAudio = 0;
		status = "idle";
		note = message;
		onActivity(false);
	}

	function play(audio: AudioContext, bytes: ArrayBuffer) {
		if (!bytes.byteLength || bytes.byteLength % 2) return;
		if (nextAudio - audio.currentTime > 1.5) {
			stop("Voice playback fell behind. Start a new session to retry.");
			return;
		}
		const view = new DataView(bytes);
		const buffer = audio.createBuffer(1, bytes.byteLength / 2, rate);
		const samples = buffer.getChannelData(0);
		for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
		const source = audio.createBufferSource();
		source.buffer = buffer;
		source.connect(audio.destination);
		if (nextAudio < audio.currentTime) nextAudio = audio.currentTime + 0.04;
		source.start(nextAudio);
		nextAudio += buffer.duration;
	}

	async function start() {
		if (disabled || status !== "idle") return;
		if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
			note = "Microphone access is unavailable in this browser.";
			return;
		}
		const run = ++epoch;
		status = "connecting";
		note = "";
		onActivity(true);
		try {
			const audio = new AudioContext({ sampleRate: rate, latencyHint: "interactive" });
			context = audio;
			await audio.resume();
			if (run !== epoch) return;
			if (audio.sampleRate !== rate || !audio.audioWorklet) throw new Error("Unsupported audio format");
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
			});
			if (run !== epoch) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			microphone = stream;
			for (const track of stream.getTracks()) {
				track.onended = () => { if (run === epoch) stop("Microphone disconnected."); };
			}
			await audio.audioWorklet.addModule(new URL("./duplex-capture.js", import.meta.url).href);
			if (run !== epoch) return;
			const source = audio.createMediaStreamSource(stream);
			const worklet = new AudioWorkletNode(audio, "conduit-duplex-capture");
			capture = worklet;
			const url = new URL(`/api/chat/${chatId}/duplex`, location.href);
			url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
			const socket = new WebSocket(url);
			connection = socket;
			socket.binaryType = "arraybuffer";
			timer = setTimeout(() => { if (run === epoch) stop("Local voice did not start."); }, 25_000);
			socket.onmessage = ({ data }) => {
				if (run !== epoch) return;
				if (data === "ready" && status === "connecting") {
					clearTimeout(timer);
					status = "listening";
					worklet.port.onmessage = ({ data: frame }) => {
						if (run !== epoch || socket.readyState !== WebSocket.OPEN) return;
						if (socket.bufferedAmount > 32_000) {
							stop("Voice connection fell behind. Start a new session to retry.");
							return;
						}
						socket.send(frame);
					};
					source.connect(worklet).connect(audio.destination);
				} else if (data instanceof ArrayBuffer && status === "listening") {
					play(audio, data);
				}
			};
			socket.onclose = ({ code }) => {
				if (run !== epoch) return;
				stop(code === 1000 ? "Voice session ended." : "Local voice disconnected or is unavailable.");
			};
		} catch {
			if (run === epoch) stop("Could not start local voice. Check microphone access and try again.");
		}
	}

	function visibility() {
		if (document.hidden && status !== "idle") stop("Voice stopped when Chat went into the background.");
	}

	onDestroy(() => { if (status !== "idle") stop(); });
</script>

<svelte:document onvisibilitychange={visibility} />
<svelte:window onpagehide={() => { if (status !== "idle") stop(); }} />

{#if status === "idle"}
	<button type="button" class="text-text-muted underline" {disabled} onclick={start}>Local voice</button>
{:else}
	<button type="button" class="text-error underline" onclick={() => stop()}>End voice</button>
	<span role="status" class="text-text-muted">{status === "connecting" ? "Connecting to local voice…" : "Mic on · You can interrupt"}</span>
{/if}
{#if note}<span role="status" class="text-text-muted">{note}</span>{/if}
