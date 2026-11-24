const MAX_UTTERANCE = 650;

function speechText(html: string): string {
	const separated = html
		.replace(/<br\s*\/?\s*>/gi, " ")
		.replace(/<\/(?:p|li|div|pre|h[1-6]|blockquote|td|th|tr)>/gi, "$& ");
	return (
		new DOMParser()
			.parseFromString(separated, "text/html")
			.body.textContent?.replace(/\s+/g, " ")
			.trim() ?? ""
	);
}

export function createChatSpeech() {
	const state = $state({
		index: null as number | null,
		paused: false,
		available: false,
		error: "",
	});
	let utterance: SpeechSynthesisUtterance | undefined;
	let playback = 0;

	function stop() {
		playback++;
		state.index = null;
		state.paused = false;
		if (utterance) window.speechSynthesis.cancel();
		utterance = undefined;
	}

	function play(index: number, html: string) {
		if (!state.available) return;
		const synthesis = window.speechSynthesis;
		const local = synthesis
			.getVoices()
			.filter((voice) => voice.localService === true);
		const locale = (navigator.language || "en").toLowerCase();
		const voice =
			local.find((item) => item.lang.toLowerCase() === locale) ??
			local.find(
				(item) =>
					item.lang.toLowerCase().split("-")[0] === locale.split("-")[0],
			) ??
			local.find((item) => item.default) ??
			local[0];
		stop();
		state.error = "";
		if (!voice) {
			state.error = "No on-device voice is available.";
			return;
		}
		const text = speechText(html);
		if (!text) return;
		const current = playback;
		let offset = 0;
		state.index = index;
		const next = () => {
			if (current !== playback) return;
			if (offset >= text.length) {
				utterance = undefined;
				state.index = null;
				state.paused = false;
				return;
			}
			const end = Math.min(offset + MAX_UTTERANCE, text.length);
			const boundary = end === text.length ? end : text.lastIndexOf(" ", end);
			const cut = boundary > offset ? boundary : end;
			const chunk = text.slice(offset, cut);
			offset = text[cut] === " " ? cut + 1 : cut;
			const currentUtterance = new SpeechSynthesisUtterance(chunk);
			currentUtterance.voice = voice;
			currentUtterance.lang = voice.lang;
			currentUtterance.onend = next;
			currentUtterance.onerror = () => {
				if (current !== playback) return;
				stop();
				state.error = "Read-aloud stopped. Try playing the reply again.";
			};
			utterance = currentUtterance;
			synthesis.speak(currentUtterance);
		};
		next();
	}

	function togglePause() {
		if (state.index === null) return;
		if (state.paused) window.speechSynthesis.resume();
		else window.speechSynthesis.pause();
		state.paused = !state.paused;
	}

	function mount() {
		state.available =
			typeof window.speechSynthesis !== "undefined" &&
			typeof SpeechSynthesisUtterance !== "undefined";
		if (state.available) window.speechSynthesis.getVoices();
		window.addEventListener("pagehide", stop);
		return () => {
			window.removeEventListener("pagehide", stop);
			stop();
		};
	}

	return { state, play, stop, togglePause, mount };
}
