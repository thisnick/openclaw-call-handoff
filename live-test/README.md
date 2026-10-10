# Live hand-off test

End-to-end test of the plugin with real phone calls and no person on either
end: two phones from an [otacon](https://github.com/thisnick) fleet each run an
OpenAI realtime model, one playing a restaurant ("business") and one playing
the person the call is handed to ("human"). Not run in CI.

```
OpenClaw voice-call ──call──▶ business phone (realtime "Bella Napoli" host)
        │ voice agent consults the agent → transfer_call_to_human
        ▼
call-handoff plugin ──call──▶ human phone (realtime "Nick")
        └─ both joined in a Twilio conference; the voice agent leaves the call
```

A run uses exactly two Twilio calls (both phones are outside Twilio), so it
works on accounts limited to two simultaneous calls.

## Requirements

- An OpenClaw gateway with `@openclaw/voice-call` (Twilio, realtime,
  `toolPolicy: "owner"`) and this plugin installed and configured.
- Two otacon fleet phones with SIMs and working call audio
  (`otacon call status`, and the host's `/phones/<host-id>/ws/audio/call`
  websocket: PCM16 mono 16 kHz, one full-duplex socket per phone).
- `uv`, `otacon` CLI (authenticated), and an OpenAI API key with realtime
  access.

## Before a run: point the plugin's default human at the human phone

The voice agent normally hands off to the plugin's default human. So no real
person gets called, temporarily make the default human's number the human
phone's number, then restart the gateway (the plugin's secrets only resolve at
start). Restore it and restart again afterwards.

## Run

```bash
cp .env.example ~/my-handoff-test.env    # fill in; keep it out of git
set -a; . ~/my-handoff-test.env; set +a
SCENARIO=answer   ./run.sh               # human phone answers
SCENARIO=noanswer ./run.sh               # human phone is left ringing
```

Use `OTACON_AUDIO_HOST`, not `OTACON_HOST`: the otacon CLI reads `OTACON_HOST`
as its server URL.

Each run writes `runs/<time>-<scenario>/` (transcripts and agent logs), prints
the conversation as both models heard and said it, and exits 0 on pass:

- `answer`: the business heard "… is joining now" and the human spoke to it.
- `noanswer`: the business was told the person can't join.

Check the gateway log too: `[call-handoff] ringing …`, `handed to …` (answer)
or `did not connect: …` (noanswer), and voice-call's
`Call finalized … endReason=completed` with no hang-up in between.

## Safety

- The script hangs up both phones when it ends, including on errors.
- Each phone agent hangs up at `MAX_SECONDS` (default 240) no matter what.
- The human agent (and the business agent in `noanswer`) hangs up a few seconds
  after it says goodbye; without this the two models can keep saying goodbye to
  each other.
- otacon allows one audio socket per phone; don't run two tests at once.
- Only call numbers you own. Never commit real numbers.
