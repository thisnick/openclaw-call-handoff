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
    mom: {
      name: "Mom", number: "+15550002222", description: "Nick's mom",
      // optional per person: what they hear, in their language
      language: "cmn-CN", voice: "Polly.Zhiyu-Neural",
      prompt: "{callee}打来的电话，事由：{reason}。正在为您接通。",
    },
  },
  defaultHuman: "nick",
  // fromNumber, voice-call webhook URLs default from voice-call's config
} } } }
```

**Restart the gateway after installing or changing this plugin's config.** Its
secret references (Twilio and gateway tokens) are resolved at gateway start; a
hot reload re-registers the plugin without them and it switches itself off
(`[call-handoff] disabled: twilio.authToken is required`).

voice-call's `realtime.toolPolicy` must let consults use the tool (`owner`),
and its `realtime.instructions` should say when to ask for a person.

Per person, `language` and `voice` set the Twilio `<Say>` language and voice of
what they hear, and `prompt` overrides `humanPrompt`; the tool description tells
the agent to write the `reason` in that language.

Options: `ringTimeoutSec` (25), `machineDetection` (true),
`calleeAnnouncement` ("{humanName} is joining now."), `humanPrompt`
("Call from {callee} about: {reason}. Connecting you now."),
`maxAttemptsPerCall` (2), `pollIntervalMs` (1000), `toolVisibility`
(`voice-sessions`: the tool appears only in voice-call consults; `always`).

The plugin declares `requiresPlugins: ["voice-call"]` and stays inactive (with
one log line saying why) unless voice-call is enabled with `provider: "twilio"`,
`realtime.enabled: true` and `realtime.toolPolicy: "owner"`.

## Requirements

- OpenClaw 2026.9.8 or newer with `@openclaw/voice-call` in realtime mode (Twilio).
- A hand-off uses two simultaneous Twilio calls.
