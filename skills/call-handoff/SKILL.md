---
name: call-handoff
description: "Hand a live phone call over to a real person (transfer_call_to_human)."
metadata:
  {
    "openclaw":
      {
        "emoji": "🤝",
        "skillKey": "call-handoff",
        "requires": { "config": ["plugins.entries.call-handoff.enabled"] },
      },
  }
---

# Call hand-off

Use `transfer_call_to_human` during a live voice call (usually from a voice
consult) when the other party insists on speaking to a real person, or when a
decision needs that person.

- `reason`: one short sentence the person hears first, e.g. "Bella Napoli only
  has 8:15 on Friday and wants to confirm."
- `human`: id of a configured person; omit it for the default.
- The tool only appears during voice-call consults (`toolVisibility: "always"`
  shows it everywhere).
- The tool returns at once. Their phone rings; if they answer, they are
  connected and the voice agent leaves the call. If they don't, the voice agent
  gets a notice and should offer to take a message.
- Before using it, the voice agent should tell the other party it is bringing
  that person on and ask them to hold.
- Only configured people can be called.
