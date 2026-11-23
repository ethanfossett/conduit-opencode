import { ChatError } from "./errors.js";

export function loopbackPort(value: string | undefined) {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1024 && port <= 65535
		? port
		: undefined;
}

export function voiceWorkerPort() {
	return loopbackPort(process.env["CONDUIT_CHAT_VOICE_PORT"]);
}

export async function offerVoice(sdp: string) {
	const port = voiceWorkerPort();
	if (!port) throw new ChatError(503, "Chat voice is unavailable.");
	const response = await fetch(`http://127.0.0.1:${port}/offer`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ type: "offer", sdp }),
		redirect: "error",
		signal: AbortSignal.timeout(6_000),
	}).catch(() => undefined);
	if (response?.status === 409)
		throw new ChatError(409, "Another voice session is active.");
	if (!response?.ok)
		throw new ChatError(503, "Could not connect to local voice.");
	return response.json();
}
