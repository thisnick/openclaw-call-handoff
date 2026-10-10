# openclaw-call-handoff

OpenClaw plugin that hands a live realtime voice call to a real person. The
voice agent asks the other party to hold, the person's phone rings with the
reason, and when they answer they are connected and the agent leaves the call.

Works with the stock `@openclaw/voice-call` plugin (Twilio, realtime mode); it
does not modify it.

## How it works

1. The voice agent consults your agent, which calls `transfer_call_to_human`.
2. The plugin rings the person from your Twilio number (answering-machine
   detection on by default) with TwiML that says the reason and joins a private
   conference.
3. When they are in the conference, the plugin redirects the other party into
   the same conference ("Nick is joining now."). That ends voice-call's realtime
   stream, so the agent is off the call, and the plugin reports the call as
   completed to voice-call so it does not hang it up.
4. If nobody joins (no answer, busy, voicemail), the agent is told through
   `voicecall.speak` and the call continues.

## Install

Download the `.tgz` from the latest release, then:

```bash
openclaw plugins install ./openclaw-call-handoff-<version>.tgz --force --accept-capabilities
```

## Configure

```json5
plugins: { entries: { "call-handoff": { enabled: true, config: {
  twilio: { authToken: { source: "store", provider: "default", id: "<entry>" } }, // accountSid defaults to voice-call's
  gateway: { url: "ws://127.0.0.1:18789", token: { source: "store", provider: "default", id: "<entry>" } },
  humans: {
    nick: { name: "Nick", number: "+15550001111", description: "the account owner" },
  },
  defaultHuman: "nick",
  // fromNumber, voice-call webhook URLs default from voice-call's config
} } } }
```

voice-call's `realtime.toolPolicy` must let consults use the tool (`owner`),
and its `realtime.instructions` should say when to ask for a person.

Options: `ringTimeoutSec` (25), `machineDetection` (true),
`calleeAnnouncement` ("{humanName} is joining now."), `humanPrompt`
("Call from {callee} about: {reason}. Connecting you now."),
`maxAttemptsPerCall` (2), `pollIntervalMs` (1000).

## Requirements

- OpenClaw 2026.9.8 or newer with `@openclaw/voice-call` in realtime mode (Twilio).
- A hand-off uses two simultaneous Twilio calls.
