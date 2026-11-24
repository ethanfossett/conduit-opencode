"""Self-hosted Conduit voice media worker. Chat generation stays in the relay."""

import asyncio
import base64
import contextlib
import io
import ipaddress
import os
import time
import wave
from collections import deque
from importlib.metadata import version

import aioice.ice
import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI, HTTPException
from loguru import logger
from pipecat.audio.turn.base_turn_analyzer import EndOfTurnState
from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import (
    InputAudioRawFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.audio.vad_processor import VADProcessor
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pocket_tts import TTSModel

RATE = 16_000
MAX_AUDIO = RATE * 2 * 32
TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")
TAILNET_V6 = ipaddress.ip_network("fd7a:115c:a1e0::/48")
STT_PORT = int(os.environ.get("CONDUIT_CHAT_STT_PORT", "8178"))
if not 1024 <= STT_PORT <= 65535:
    raise RuntimeError("Invalid loopback speech recognition port.")
WHISPER = f"http://127.0.0.1:{STT_PORT}/inference"
app = FastAPI()
current = None
offer_lock = asyncio.Lock()
model = None
voice = None


def safe_offer(sdp):
    # Use only Tailnet peers explicitly advertised by the browser. Its ICE
    # agent can also discover a peer-reflexive candidate on the Tailnet.
    lines = []
    for line in sdp.splitlines():
        if line.startswith("a=candidate:"):
            fields = line.split()
            if len(fields) < 8 or fields[2].lower() != "udp" or fields[7] != "host":
                continue
            try:
                address = ipaddress.ip_address(fields[4])
            except ValueError:
                continue
            if not (address in TAILNET_V4 or address in TAILNET_V6 or address.is_loopback):
                continue
        lines.append(line)
    return "\r\n".join(lines) + "\r\n"


def wav(samples):
    output = io.BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        stream.writeframes(samples)
    return output.getvalue()


class VoiceInput(FrameProcessor):
    def __init__(self, send):
        super().__init__()
        self.send = send
        self.pre_roll = deque(maxlen=34)
        self.audio = None
        self.speaking = False
        self.last_stop = 0.0
        self.held = False
        self.capture_enabled = True
        self.capture_epoch = 0
        self.committing = False
        self.commit_requested = False
        self.partial_text = []
        self.pending = None
        self.transcribing = None
        self.smart = LocalSmartTurnAnalyzerV3()
        self.smart.set_sample_rate(RATE)
        self.http = httpx.AsyncClient(timeout=15, trust_env=False)

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if not self.capture_enabled:
            await self.push_frame(frame, direction)
            return
        if isinstance(frame, VADUserStartedSpeakingFrame):
            self.speaking = True
            self.commit_requested = False
            if self.pending:
                self.pending.cancel()
            if self.audio is None:
                self.audio = bytearray(b"".join(self.pre_roll))
            self.send({"kind": "speech-start"})
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            self.speaking = False
            self.last_stop = time.monotonic()
            if self.audio is not None and not self.held:
                self.pending = asyncio.create_task(self.finish_when_ready())
        elif isinstance(frame, InputAudioRawFrame):
            self.pre_roll.append(frame.audio)
            if self.speaking and self.audio is None:
                self.audio = bytearray()
            if self.audio is not None:
                self.audio.extend(frame.audio[:MAX_AUDIO - len(self.audio)])
                if len(self.audio) >= MAX_AUDIO:
                    self.commit()
        await self.push_frame(frame, direction)

    def set_capture(self, enabled):
        if self.capture_enabled == enabled:
            return
        self.capture_enabled = enabled
        if not enabled:
            self.capture_epoch += 1
            self.audio = None
            self.speaking = False
            self.commit_requested = False
            self.partial_text.clear()
            self.pre_roll.clear()
            if self.pending:
                self.pending.cancel()

    async def finish_when_ready(self):
        self.smart.clear()
        self.smart.append_audio(bytes(self.audio[-RATE * 2 * 8:]), True)
        state, _ = await self.smart.analyze_end_of_turn()
        if state != EndOfTurnState.COMPLETE:
            await asyncio.sleep(0.95)
        if not self.speaking and not self.held:
            self.commit()

    def commit(self):
        if self.audio is None:
            return
        if self.committing:
            self.commit_requested = True
            return
        samples = bytes(self.audio[:MAX_AUDIO])
        self.audio = None
        self.pre_roll.clear()
        self.committing = True
        self.send({"kind": "transcribing"})
        self.transcribing = asyncio.create_task(self.transcribe(samples, self.capture_epoch))

    async def transcribe(self, samples, epoch):
        try:
            signal = np.frombuffer(samples, dtype="<i2").astype(np.float32) / 32768
            length = len(signal) // 320 * 320
            voiced = np.sum(np.mean(signal[:length].reshape(-1, 320) ** 2, axis=1) > 0.000025)
            if voiced < 7:
                if self.audio is None and not self.speaking:
                    self.send({"kind": "transcript", "text": " ".join(self.partial_text)})
                    self.partial_text.clear()
                return
            response = await self.http.post(
                WHISPER, files={"file": ("turn.wav", wav(samples), "audio/wav")},
                data={
                    "response_format": "verbose_json", "language": "en",
                    "temperature": "0", "no_speech_thold": "0.5",
                },
            )
            response.raise_for_status()
            if epoch != self.capture_epoch:
                return
            text = " ".join(
                segment.get("text", "").strip() for segment in response.json().get("segments", [])
                if segment.get("no_speech_prob", 1) < 0.5 and segment.get("avg_logprob", -2) > -1
            ).strip()
            if not any(c.isalnum() for c in text) or (text.startswith("[") and text.endswith("]")):
                text = ""
            if text:
                self.partial_text.append(text)
            # Reserve a short window for a resumed phrase even when CUDA
            # completes transcription very quickly.
            await asyncio.sleep(max(0, self.last_stop + 0.26 - time.monotonic()))
            # If speech resumed before transcription caught up, maintain one
            # input turn and wait for the resumed segment to settle.
            if epoch == self.capture_epoch and self.audio is None and not self.speaking:
                text = " ".join(self.partial_text)
                self.partial_text.clear()
                self.send({"kind": "transcript", "text": text[:24_000]})
        except (ValueError, httpx.HTTPError):
            if epoch == self.capture_epoch:
                self.send({"kind": "transcript-error"})
        finally:
            self.committing = False
            if self.commit_requested:
                self.commit_requested = False
                self.commit()

    async def close(self):
        self.audio = None
        self.partial_text.clear()
        self.pre_roll.clear()
        for task in (self.pending, self.transcribing):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
        await self.http.aclose()


def next_audio(generator):
    chunk = next(generator, None)
    if chunk is None:
        return None
    return (chunk.detach().cpu().numpy().clip(-1, 1) * 32767).astype("<i2").tobytes()


class Session:
    def __init__(self):
        self.connection = SmallWebRTCConnection(ice_servers=[])
        self.input = VoiceInput(self.connection.send_app_message)
        self.queue = asyncio.Queue(maxsize=16)
        self.generation = None
        self.output_allowed = asyncio.Event()
        self.output_allowed.set()
        self.output = None
        self.task = None
        self.ready = asyncio.Event()

    async def run(self):
        global current
        transport = SmallWebRTCTransport(self.connection, TransportParams(
            audio_in_enabled=True, audio_in_sample_rate=RATE, audio_out_enabled=False,
        ))
        vad = VADProcessor(vad_analyzer=SileroVADAnalyzer(params=VADParams(
            start_secs=0.10, stop_secs=0.42, min_volume=0.2,
        )))
        self.task = PipelineTask(Pipeline([transport.input(), vad, self.input]), params=PipelineParams(
            audio_in_sample_rate=RATE, enable_metrics=False,
        ), enable_rtvi=False)

        @transport.event_handler("on_client_disconnected")
        async def on_disconnected(_, _client):
            await self.task.cancel()

        @transport.event_handler("on_app_message")
        async def on_message(_, message, _client):
            if not isinstance(message, dict) or message.get("type") != "conduit-voice":
                return
            kind = message.get("kind")
            if kind == "hello":
                self.ready.set()
                self.connection.send_app_message({"kind": "ready", "rate": model.sample_rate})
            elif kind == "close":
                await self.task.cancel()
            elif kind == "hold":
                self.input.held = message.get("enabled") is True
                if not self.input.held and not self.input.speaking:
                    self.input.commit()
            elif kind == "capture":
                self.input.set_capture(message.get("enabled") is True)
            elif kind == "commit":
                self.input.commit()
            elif kind == "flush":
                self.generation = None
                self.clear_output()
                self.output_allowed.set()
            elif kind == "pause-output":
                if message.get("enabled") is True:
                    self.output_allowed.clear()
                else:
                    self.output_allowed.set()
            elif kind == "speak":
                generation, end, text = message.get("id"), message.get("end"), message.get("text")
                if (
                    not isinstance(generation, str) or len(generation) > 40
                    or type(end) is not int or not 0 < end <= 64_000
                    or not isinstance(text, str) or not 0 < len(text) <= 420
                ):
                    return
                if self.generation != generation:
                    self.clear_output()
                    self.generation = generation
                if self.queue.full():
                    self.connection.send_app_message({"kind": "synthesis-error", "id": generation})
                    return
                self.queue.put_nowait((generation, end, text))

        async def close_unconnected():
            try:
                await asyncio.wait_for(self.ready.wait(), timeout=12)
            except asyncio.TimeoutError:
                await self.task.cancel()

        handshake = asyncio.create_task(close_unconnected())
        self.output = asyncio.create_task(self.synthesize())
        try:
            await asyncio.wait_for(PipelineRunner(handle_sigint=False).run(self.task), timeout=900)
        finally:
            handshake.cancel()
            self.output.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.output
            await self.input.close()
            try:
                await self.connection.disconnect()
            finally:
                current = None

    def clear_output(self):
        while not self.queue.empty():
            self.queue.get_nowait()

    async def synthesize(self):
        while True:
            valid_id, end, text = await self.queue.get()
            try:
                generator = model.generate_audio_stream(voice, text)
                deadline = time.monotonic()
                while self.generation == valid_id:
                    data = await asyncio.to_thread(next_audio, generator)
                    if self.generation != valid_id:
                        break
                    if data is None:
                        self.connection.send_app_message({"kind": "audio-end", "id": valid_id, "end": end})
                        break
                    for offset in range(0, len(data), 2400):
                        await self.output_allowed.wait()
                        if self.generation != valid_id:
                            break
                        chunk = data[offset:offset + 2400]
                        self.connection.send_app_message({
                            "kind": "audio", "id": valid_id,
                            "pcm": base64.b64encode(chunk).decode("ascii"),
                        })
                        deadline = max(deadline, time.monotonic() - 0.05)
                        deadline += len(chunk) / (2 * model.sample_rate)
                        await asyncio.sleep(max(0, deadline - time.monotonic()))
            except (ValueError, RuntimeError, TypeError) as error:
                print("TTS error:", type(error).__name__, flush=True)
                if self.generation == valid_id:
                    self.connection.send_app_message({"kind": "synthesis-error", "id": valid_id})


@app.get("/health", status_code=204)
async def health():
    if model is None:
        raise HTTPException(503)


@app.post("/offer")
async def offer(payload: dict):
    global current
    sdp = payload.get("sdp")
    if payload.get("type") != "offer" or not isinstance(sdp, str) or len(sdp) > 24_000:
        raise HTTPException(400)
    async with offer_lock:
        if current is not None:
            raise HTTPException(409)
        session = Session()
        try:
            await asyncio.wait_for(session.connection.initialize(safe_offer(sdp), "offer"), timeout=4)
        except (ValueError, asyncio.TimeoutError):
            await session.input.close()
            await session.connection.disconnect()
            raise HTTPException(400) from None
        current = session
        asyncio.create_task(session.run())
        return session.connection.get_answer()


if __name__ == "__main__":
    # Pin the published ICE candidate to this host's Tailnet interface.
    address = ipaddress.ip_address(os.environ["CONDUIT_VOICE_MEDIA_IP"])
    if not (address in TAILNET_V4 or address in TAILNET_V6 or address.is_loopback):
        raise RuntimeError("Voice requires a Tailnet or loopback media address.")
    aioice.ice.get_host_addresses = lambda *_args, **_kwargs: [str(address)]
    if version("pipecat-ai") != "1.17.0":
        raise RuntimeError("Install the supported Pipecat version.")
    logger.remove()
    import torch
    torch.set_num_threads(3)
    model = TTSModel.load_model()
    voice = model.get_state_for_audio_prompt(os.environ.get("CONDUIT_VOICE_NAME", "marius"))
    next_audio(model.generate_audio_stream(voice, "Ready."))
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ["CONDUIT_CHAT_VOICE_PORT"]),
                access_log=False, log_level="warning")
