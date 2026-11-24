import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createServer } from "node:http";
import { createServer as createAudioServer } from "node:net";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";

const { CONDUIT_PERSONAPLEX_ROOT: root, CONDUIT_PERSONAPLEX_PORT: portValue } =
	process.env;
const port = Number(portValue);
const pipes = process.env.RUNTIME_DIRECTORY;
if (
	!root ||
	!pipes ||
	!Number.isSafeInteger(port) ||
	port < 1024 ||
	port > 65535
)
	throw new Error(
		"Set the PersonaPlex root, runtime directory, and loopback port.",
	);

const build = join(root, "moshi-bin-linux-x64-v0.8.0-beta", "personaplex");
const shim = join(root, "pipe-audio.so");
const models = join(root, "models");
accessSync(build, constants.X_OK);
accessSync(shim, constants.R_OK);
for (const library of [
	"libcudart.so.12",
	"libcublas.so.12",
	"libcublasLt.so.12",
])
	accessSync(join(root, "cuda12", library), constants.R_OK);
for (const path of [
	"moshi-common/mimi-e351c8d8-125.gguf",
	"moshi-common/tokenizer_spm_32k_3.model",
	"personaplex-7b-v1-q4_k-GGUF/model-q4_k.gguf",
	"personaplex-7b-v1-q4_k-GGUF/personaplex-config.json",
	"personaplex-7b-v1-q4_k-GGUF/voices/NATF2.gguf",
])
	accessSync(join(models, "Codes4Fun", path), constants.R_OK);

const frameBytes = 1920 * 4;
const server = createServer((req, res) => {
	res.writeHead(req.url === "/health" ? 204 : 404).end();
});
let receiveAudio;
const audioServer = createAudioServer((audio) => {
	if (!receiveAudio) {
		audio.destroy();
		return;
	}
	receiveAudio(audio);
});
let nativeProcess;
const wss = new WebSocketServer({
	noServer: true,
	maxPayload: 16 * 1024,
	perMessageDeflate: false,
});
server.on("upgrade", (req, socket, head) => {
	const url = URL.parse(req.url ?? "", "http://localhost");
	if (
		url?.pathname !== "/v1/realtime" ||
		url.searchParams.get("duplex") !== "1" ||
		wss.clients.size ||
		nativeProcess
	) {
		socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
});

wss.on("connection", (ws) => {
	let child;
	let ready = false;
	let output = Buffer.alloc(0);
	let startup = "";
	const fail = () => {
		child?.kill("SIGKILL");
		ws.close(1011, "Local speech runtime unavailable");
	};
	const startupTimer = setTimeout(fail, 20_000).unref();
	let sessionTimer;
	const send = (data) => {
		if (ws.readyState !== WebSocket.OPEN) return;
		if (ws.bufferedAmount >= 64 * 1024) fail();
		else ws.send(JSON.stringify(data));
	};
	ws.on("error", () => ws.terminate());
	let playback;
	ws.on("close", () => {
		clearTimeout(startupTimer);
		clearTimeout(sessionTimer);
		receiveAudio = undefined;
		playback?.destroy();
		child?.kill("SIGKILL");
	});
	receiveAudio = (audio) => {
		if (!child || playback) {
			audio.destroy();
			return;
		}
		playback = audio;
		audio.on("error", fail);
		audio.on("data", (chunk) => {
			if (!ready) return;
			output = Buffer.concat([output, chunk]);
			while (output.length >= frameBytes) {
				const pcm = Buffer.alloc(frameBytes / 2);
				for (let i = 0; i < frameBytes; i += 4) {
					const sample = output.readFloatLE(i);
					const scaled = Number.isFinite(sample) ? sample * 32767 : 0;
					pcm.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i / 2);
				}
				output = output.subarray(frameBytes);
				send({
					type: "response.output_audio.delta",
					sample_rate_hz: 24000,
					delta: pcm.toString("base64"),
				});
			}
		});
	};

	ws.on("message", (data, binary) => {
		if (binary) return fail();
		try {
			const event = JSON.parse(data.toString());
			if (!child && event.type === "session.update") {
				const instructions = event.session?.instructions;
				if (
					typeof instructions !== "string" ||
					instructions.length > 1500 ||
					instructions.includes("\0")
				)
					return fail();
				child = spawn(
					"/usr/bin/bwrap",
					[
						"--unshare-all",
						"--die-with-parent",
						"--new-session",
						"--clearenv",
						"--setenv",
						"HOME",
						"/tmp",
						"--setenv",
						"LD_PRELOAD",
						"/runtime/pipe-audio.so",
						"--setenv",
						"LD_LIBRARY_PATH",
						"/runtime/cuda12:/runtime/moshi-bin-linux-x64-v0.8.0-beta",
						"--ro-bind",
						"/usr",
						"/usr",
						"--symlink",
						"usr/lib",
						"/lib",
						"--symlink",
						"usr/lib64",
						"/lib64",
						"--ro-bind-try",
						"/etc/ld.so.cache",
						"/etc/ld.so.cache",
						"--dev",
						"/dev",
						"--dev-bind",
						"/dev/nvidia0",
						"/dev/nvidia0",
						"--dev-bind",
						"/dev/nvidiactl",
						"/dev/nvidiactl",
						"--dev-bind-try",
						"/dev/nvidia-uvm",
						"/dev/nvidia-uvm",
						"--dev-bind-try",
						"/dev/nvidia-uvm-tools",
						"/dev/nvidia-uvm-tools",
						"--ro-bind",
						"/sys",
						"/sys",
						"--proc",
						"/proc",
						"--tmpfs",
						"/tmp",
						"--ro-bind",
						root,
						"/runtime",
						"--ro-bind",
						pipes,
						"/pipes",
						"--chdir",
						"/tmp",
						"--",
						"/runtime/moshi-bin-linux-x64-v0.8.0-beta/personaplex",
						"-d",
						"CUDA0",
						"-r",
						"/runtime/models",
						"-v",
						"NATF2",
						"-p",
						"CONDUIT_PROMPT_FROM_PIPE",
						"-c",
						"3000",
					],
					{ stdio: ["pipe", "pipe", "ignore"] },
				);
				nativeProcess = child;
				child.once("close", () => {
					nativeProcess = undefined;
				});
				child.on("error", fail);
				child.on("exit", fail);
				child.stdin.on("error", fail);
				const prompt = Buffer.from(instructions, "utf8");
				const size = Buffer.alloc(2);
				size.writeUInt16LE(prompt.length);
				child.stdin.write(Buffer.concat([size, prompt]));
				child.stdout.on("data", (chunk) => {
					if (ready) return;
					startup = (startup + chunk.toString()).slice(-8192);
					if (!/(?:^|\n)ready\r?\n/.test(startup)) return;
					startup = "";
					ready = true;
					clearTimeout(startupTimer);
					sessionTimer = setTimeout(fail, 235_000).unref();
					send({ type: "session.created" });
				});
				return;
			}
			if (
				!ready ||
				event.type !== "input_audio_buffer.append" ||
				typeof event.audio !== "string" ||
				event.audio.length !== (frameBytes / 3) * 4
			)
				return fail();
			const frame = Buffer.from(event.audio, "base64");
			if (
				frame.length !== frameBytes ||
				child.stdin.writableLength > frameBytes * 8
			)
				return fail();
			child.stdin.write(frame);
		} catch {
			fail();
		}
	});
});

audioServer.listen(join(pipes, "voice.sock"), () =>
	server.listen(port, "127.0.0.1"),
);
