#!/usr/bin/env python3
"""Answer a call on an otacon fleet phone and let an OpenAI realtime model talk on it.

  OTACON_AUDIO_HOST=<otacon host> OPENAI_API_KEY=... uv run phone_agent.py \
      --phone <registry id> --host-id <host-local id> --persona business --log transcript.jsonl

Waits for the phone to ring, answers with `otacon call answer`, bridges the
phone's call audio websocket (PCM16 mono 16 kHz, one socket per phone, full
duplex) to an OpenAI realtime session (PCM16 mono 24 kHz), and logs what the
model heard and said. Exits when the call ends.
"""
# /// script
# dependencies = ["websockets", "numpy"]
# ///
import argparse
import asyncio
import base64
import json
import re
import os
import ssl
import subprocess
import time

import numpy as np
import websockets

PHONE_SR, MODEL_SR = 16000, 24000
FRAME_BYTES = 4096  # 2048 samples = 128 ms at 16 kHz

PERSONAS = {
    "business": (
        "You are the host at Bella Napoli, an Italian restaurant, answering the phone. "
        "Speak naturally and keep every reply to one or two short sentences. "
        "When you answer, say: 'Bella Napoli, how can I help you?' "
        "If the caller is an assistant or asks to book on someone's behalf, say you can only confirm "
        "bookings with the actual person and you need to speak with a real person. Insist politely. "
        "If you are asked to hold, say 'Sure' and wait silently. While on hold, answer any update from the "
        "assistant with just 'Sure'; it can take a minute. "
        "Only when you hear that Nick is joining now, say once: 'Hi, is this Nick?' "
        "Nick has joined only when someone says 'this is Nick'. Never confirm or say goodbye before that. "
        "When Nick speaks to you, greet him and confirm a table for two at 7:30 on Friday, "
        "then say goodbye. If you are told the person can't join, say Nick can call back to confirm, and say goodbye."
    ),
    "human": (
        "You are Nick. You just answered your phone. Say 'Hello?' once, then stay silent and listen. "
        "You will hear a short automated message about a call, then you will be connected to a restaurant. "
        "When the restaurant speaks, say: 'Hi, this is Nick. I'd like to confirm the table for two at 7:30 "
        "on Friday.' Keep replies short and natural, and say goodbye when they confirm."
    ),
}


def resample(pcm: bytes, src: int, dst: int) -> bytes:
    x = np.frombuffer(pcm, dtype=np.int16).astype(np.float32)
    if len(x) == 0:
        return b""
    n = int(round(len(x) * dst / src))
    y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    return np.clip(y, -32768, 32767).astype(np.int16).tobytes()


def otacon(phone: str, *args: str) -> str:
    out = subprocess.run(
        ["otacon", "--phone", phone, *args],
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "NODE_NO_WARNINGS": "1"},
    )
    return out.stdout


def call_state(phone: str) -> str:
    text = otacon(phone, "call", "status", "--json")
    try:
        return json.loads(text[text.index("{"):]).get("state", "unknown")
    except (ValueError, json.JSONDecodeError):
        return "unknown"


class Log:
    def __init__(self, path: str, tag: str):
        self.path, self.tag = path, tag

    def __call__(self, kind: str, text: str = "", **extra):
        entry = {"t": round(time.time(), 2), "who": self.tag, "kind": kind, "text": text, **extra}
        with open(self.path, "a") as f:
            f.write(json.dumps(entry) + "\n")
        print(f"[{self.tag}] {kind}: {text}", flush=True)


async def run(args):
    log = Log(args.log, args.persona)
    log("waiting", "for the phone to ring")
    deadline = time.time() + args.ring_timeout
    while call_state(args.phone) != "ringing":
        if time.time() > deadline:
            log("gave-up", "no incoming call")
            return
        await asyncio.sleep(1)
    otacon(args.phone, "call", "answer")
    log("answered")

    # otacon serves a self-signed certificate on its private network.
    ssl_ctx = ssl.create_default_context()
    ssl_ctx.check_hostname = False
    ssl_ctx.verify_mode = ssl.CERT_NONE
    phone_url = f"wss://{os.environ['OTACON_AUDIO_HOST']}:8080/phones/{args.host_id}/ws/audio/call"
    model_url = f"wss://api.openai.com/v1/realtime?model={args.model}"
    headers = {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"}

    async with websockets.connect(phone_url, ssl=ssl_ctx, max_size=None) as phone, \
            websockets.connect(model_url, additional_headers=headers, max_size=None) as model:
        log("phone-audio", await phone.recv())
        await model.send(json.dumps({
            "type": "session.update",
            "session": {
                "type": "realtime",
                "instructions": PERSONAS[args.persona],
                "output_modalities": ["audio"],
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": MODEL_SR},
                        "transcription": {"model": "gpt-4o-transcribe"},
                        "turn_detection": {"type": "server_vad", "silence_duration_ms": 500},
                    },
                    "output": {"format": {"type": "audio/pcm", "rate": MODEL_SR}, "voice": args.voice},
                },
            },
        }))
        await model.send(json.dumps({"type": "response.create"}))  # speak first (greeting / "Hello?")

        outbound = bytearray()
        done = asyncio.Event()
        # With --arm-goodbye-on, a goodbye only ends the call after that phrase was heard.
        armed = {"goodbye": not args.arm_goodbye_on}

        def hang_up(why: str = "after goodbye"):
            if not done.is_set():
                otacon(args.phone, "call", "hangup")
                log("hung-up", why)
                done.set()

        async def phone_to_model():
            async for msg in phone:
                if isinstance(msg, (bytes, bytearray)):
                    await model.send(json.dumps({
                        "type": "input_audio_buffer.append",
                        "audio": base64.b64encode(resample(bytes(msg), PHONE_SR, MODEL_SR)).decode(),
                    }))
            done.set()

        async def model_to_phone():
            async for raw in model:
                ev = json.loads(raw)
                t = ev.get("type", "")
                if t in ("response.output_audio.delta", "response.audio.delta"):
                    outbound.extend(resample(base64.b64decode(ev["delta"]), MODEL_SR, PHONE_SR))
                elif t == "input_audio_buffer.speech_started":
                    outbound.clear()  # caller talks over us: stop playback
                elif t == "conversation.item.input_audio_transcription.completed":
                    heard = ev.get("transcript", "").strip()
                    log("heard", heard)
                    if args.arm_goodbye_on and re.search(args.arm_goodbye_on, heard, re.I):
                        armed["goodbye"] = True
                elif t in ("response.output_audio_transcript.done", "response.audio_transcript.done"):
                    said = ev.get("transcript", "").strip()
                    log("said", said)
                    if args.hangup_on_goodbye and armed["goodbye"] and "goodbye" in said.lower():
                        asyncio.get_running_loop().call_later(4, hang_up)
                elif t == "error":
                    log("model-error", json.dumps(ev.get("error", {}))[:300])
            done.set()

        async def pace_to_phone():
            # Send in real time; the server fills gaps with silence.
            frame_s = FRAME_BYTES / 2 / PHONE_SR
            next_at = time.monotonic()
            while not done.is_set():
                if len(outbound) >= FRAME_BYTES:
                    chunk = bytes(outbound[:FRAME_BYTES])
                    del outbound[:FRAME_BYTES]
                    await phone.send(chunk)
                    next_at += frame_s
                    await asyncio.sleep(max(0, next_at - time.monotonic()))
                else:
                    next_at = time.monotonic()
                    await asyncio.sleep(0.02)

        async def watch_call():
            started = time.monotonic()
            while not done.is_set():
                await asyncio.sleep(2)
                if time.monotonic() - started > args.max_seconds:
                    hang_up("max call length reached")
                    return
                if call_state(args.phone) in ("idle", "unknown"):
                    log("call-ended")
                    done.set()

        tasks = [asyncio.create_task(c()) for c in (phone_to_model, model_to_phone, pace_to_phone, watch_call)]
        await done.wait()
        for task in tasks:
            task.cancel()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--phone", required=True)  # registry id, e.g. phone-2
    p.add_argument("--host-id", required=True)  # host-local id from the otacon host's GET /phones
    p.add_argument("--persona", choices=sorted(PERSONAS), required=True)
    p.add_argument("--log", required=True)
    p.add_argument("--model", default="gpt-realtime-2.1")
    p.add_argument("--voice", default="marin")
    p.add_argument("--ring-timeout", type=float, default=180)
    p.add_argument("--hangup-on-goodbye", action="store_true")
    p.add_argument("--arm-goodbye-on", help="regex; goodbye hang-up only after hearing it")
    p.add_argument("--max-seconds", type=float, default=240, help="hard cap: hang up after this long")
    asyncio.run(run(p.parse_args()))


if __name__ == "__main__":
    main()
