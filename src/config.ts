// Plugin config: plugins.entries.call-handoff.config. Secret fields arrive
// resolved by OpenClaw (configContracts.secretInputs), so they are strings here.

export type Human = { name: string; number: string; description?: string };

export type CallHandoffConfig = {
  twilio: { accountSid: string; authToken: string; apiBaseUrl: string };
  /** Number the human is called from (the OpenClaw Twilio number). */
  fromNumber: string;
  /** Operator WebSocket used for voicecall.status / voicecall.speak. */
  gateway: { url: string; token?: string };
  /** Where the voice-call plugin listens (loopback). */
  voiceWebhookUrl: string;
  /** URL voice-call verifies Twilio signatures against (its publicUrl); defaults from voice-call config. */
  voiceWebhookSignedUrl?: string;
  humans: Record<string, Human>;
  defaultHuman?: string;
  ringTimeoutSec: number;
  machineDetection: boolean;
  calleeAnnouncement: string;
  humanPrompt: string;
  maxAttemptsPerCall: number;
  pollIntervalMs: number;
};

const E164 = /^\+[1-9]\d{1,14}$/;
const HUMAN_ID = /^[a-z][a-z0-9_-]{0,31}$/;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

/** Validate raw plugin config. Returns errors instead of throwing so the plugin can report them. */
export function parseConfig(
  raw: unknown,
  voiceCallConfig?: Record<string, unknown>,
): { config?: CallHandoffConfig; errors: string[] } {
  const errors: string[] = [];
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const twilio = (input.twilio ?? {}) as Record<string, unknown>;
  const gateway = (input.gateway ?? {}) as Record<string, unknown>;
  const voiceTwilio = (voiceCallConfig?.twilio ?? {}) as Record<string, unknown>;

  const accountSid = str(twilio.accountSid) ?? str(voiceTwilio.accountSid);
  const authToken = str(twilio.authToken);
  const fromNumber = str(input.fromNumber) ?? str(voiceCallConfig?.fromNumber);
  if (!accountSid) errors.push("twilio.accountSid is required");
  if (!authToken) errors.push("twilio.authToken is required");
  if (!fromNumber || !E164.test(fromNumber)) errors.push("fromNumber must be an E.164 number");

  const humans: Record<string, Human> = {};
  const rawHumans = (input.humans ?? {}) as Record<string, unknown>;
  for (const [id, value] of Object.entries(rawHumans)) {
    const h = (value ?? {}) as Record<string, unknown>;
    const name = str(h.name);
    const number = str(h.number);
    if (!HUMAN_ID.test(id)) {
      errors.push(`humans.${id}: id must be a short lowercase slug`);
      continue;
    }
    if (!name || !number || !E164.test(number)) {
      errors.push(`humans.${id}: needs a name and an E.164 number`);
      continue;
    }
    humans[id] = { name, number, ...(str(h.description) ? { description: str(h.description) } : {}) };
  }
  if (Object.keys(humans).length === 0) errors.push("humans needs at least one entry");
  const defaultHuman = str(input.defaultHuman);
  if (defaultHuman && !humans[defaultHuman]) errors.push(`defaultHuman "${defaultHuman}" is not in humans`);

  const voicePublicUrl = str(voiceCallConfig?.publicUrl);
  if (errors.length > 0) return { errors };
  return {
    errors,
    config: {
      twilio: {
        accountSid: accountSid as string,
        authToken: authToken as string,
        apiBaseUrl: str(twilio.apiBaseUrl) ?? "https://api.twilio.com",
      },
      fromNumber: fromNumber as string,
      gateway: { url: str(gateway.url) ?? "ws://127.0.0.1:18789", token: str(gateway.token) },
      voiceWebhookUrl: str(input.voiceWebhookUrl) ?? "http://127.0.0.1:3334/voice/webhook",
      voiceWebhookSignedUrl: str(input.voiceWebhookSignedUrl) ?? voicePublicUrl,
      humans,
      ...(defaultHuman ? { defaultHuman } : {}),
      ringTimeoutSec: num(input.ringTimeoutSec, 25, 10, 120),
      machineDetection: input.machineDetection !== false,
      calleeAnnouncement: str(input.calleeAnnouncement) ?? "{humanName} is joining now.",
      humanPrompt:
        str(input.humanPrompt) ?? "Call from {callee} about: {reason}. Connecting you now.",
      maxAttemptsPerCall: num(input.maxAttemptsPerCall, 2, 1, 5),
      pollIntervalMs: num(input.pollIntervalMs, 1000, 250, 5000),
    },
  };
}
