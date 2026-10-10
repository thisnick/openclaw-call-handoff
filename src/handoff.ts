import type { CallHandoffConfig, Human } from "./config.js";
import type { TwilioCall, TwilioClient } from "./twilio.js";
import type { VoiceCallApi, VoiceCallStatus } from "./voice-call.js";

// One hand-off: ring a configured human; when they answer (and answering-machine
// detection says it's a person) and they are in the conference, move the other
// party into the same conference. That redirect ends voice-call's realtime
// stream, which takes the voice agent off the call; reporting the call as
// completed to voice-call stops it from hanging the call up afterwards.

const RINGING = new Set(["queued", "initiated", "ringing"]);
const ENDED = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);
const LIVE_VOICE_STATES = new Set(["initiated", "ringing", "answered", "active", "speaking", "listening"]);

type Logger = { info(msg: string): void; warn(msg: string): void };

type Attempt = {
  callId: string;
  businessSid: string;
  business: TwilioCall;
  humanId: string;
  human: Human;
  humanSid: string;
  conference: string;
  deadline: number;
};

export type StartResult =
  | { ok: true; human: string; message: string }
  | { ok: false; error: string };

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? "") : match,
  );
}

/** "+15551234567" -> "5 5 5, 1 2 3, 4 5 6 7" so text-to-speech reads digits. */
export function phoneForSpeech(number: string): string {
  const digits = number.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const spaced = (part: string) => part.split("").join(" ");
  return national.length === 10
    ? `${spaced(national.slice(0, 3))}, ${spaced(national.slice(3, 6))}, ${spaced(national.slice(6))}`
    : spaced(national);
}

function conferenceDial(name: string): string {
  return `<Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="">${escapeXml(name)}</Conference></Dial>`;
}

export function humanLegTwiml(prompt: string, conference: string): string {
  return `<Response><Say>${escapeXml(prompt)}</Say>${conferenceDial(conference)}</Response>`;
}

export function businessJoinTwiml(announcement: string, conference: string): string {
  return `<Response><Say>${escapeXml(announcement)}</Say>${conferenceDial(conference)}</Response>`;
}

export class HandoffController {
  private readonly active = new Map<string, Attempt>();
  private readonly attemptsUsed = new Map<string, number>();
  private readonly transferred = new Set<string>();
  private readonly running = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly deps: {
      config: CallHandoffConfig;
      twilio: Pick<TwilioClient, "createCall" | "getCall" | "redirectCall" | "endCall" | "listParticipants">;
      voiceCall: VoiceCallApi;
      logger: Logger;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
      makeId?: () => string;
    },
  ) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms));
  }

  private describe(id: string): string {
    const h = this.deps.config.humans[id];
    return h?.description ? `${id} (${h.name}, ${h.description})` : `${id} (${h?.name ?? id})`;
  }

  /** Text for the tool description: who can be brought in. */
  describeHumans(): string {
    return Object.keys(this.deps.config.humans).map((id) => this.describe(id)).join("; ");
  }

  private async resolveCall(callId?: string): Promise<VoiceCallStatus | string> {
    const calls = (await this.deps.voiceCall.activeCalls()).filter(
      (c) => c.providerCallId && LIVE_VOICE_STATES.has(c.state ?? "active"),
    );
    if (callId) {
      return calls.find((c) => c.callId === callId) ?? `No live call with id ${callId}.`;
    }
    if (calls.length === 1) {
      return calls[0] as VoiceCallStatus;
    }
    return calls.length === 0
      ? "There is no live call to hand off."
      : `There are ${calls.length} live calls; pass callId to choose one.`;
  }

  /** Tool entry point. Returns at once; the hand-off continues in the background. */
  async start(args: { human?: string; reason?: string; callId?: string }): Promise<StartResult> {
    if (this.closed) return { ok: false, error: "The call hand-off service is stopping." };
    const { config } = this.deps;
    const requested = args.human?.trim().toLowerCase();
    const ids = Object.keys(config.humans);
    const humanId =
      requested || config.defaultHuman || (ids.length === 1 ? ids[0] : undefined);
    if (!humanId || !config.humans[humanId]) {
      return {
        ok: false,
        error: `${requested ? `Unknown person "${requested}". ` : "Say who to bring in. "}Options: ${this.describeHumans()}.`,
      };
    }
    const human = config.humans[humanId] as Human;

    const call = await this.resolveCall(args.callId);
    if (typeof call === "string") return { ok: false, error: call };
    if (call.direction && call.direction !== "outbound") {
      return { ok: false, error: "Hand-off is only available on calls OpenClaw placed." };
    }
    const callId = call.callId;
    if (this.transferred.has(callId)) return { ok: false, error: "This call was already handed off." };
    if (this.active.has(callId)) {
      return { ok: false, error: "Someone is already being called for this call. Wait for the outcome." };
    }
    const used = this.attemptsUsed.get(callId) ?? 0;
    if (used >= config.maxAttemptsPerCall) {
      return { ok: false, error: "No hand-off attempts left on this call. Offer to take a message." };
    }

    const businessSid = call.providerCallId as string;
    let business: TwilioCall;
    try {
      business = await this.deps.twilio.getCall(businessSid);
    } catch (err) {
      return { ok: false, error: `Could not look up the call: ${String(err)}` };
    }
    const reason = (args.reason?.trim() || "they need to speak with you").slice(0, 200);
    const conference = `oc-handoff-${callId}-${this.deps.makeId?.() ?? Math.random().toString(36).slice(2, 8)}`;
    const prompt = fillTemplate(config.humanPrompt, {
      callee: phoneForSpeech(business.to),
      reason,
      humanName: human.name,
    });

    let humanCall: TwilioCall;
    try {
      humanCall = await this.deps.twilio.createCall({
        to: human.number,
        from: config.fromNumber,
        twiml: humanLegTwiml(prompt, conference),
        timeoutSec: config.ringTimeoutSec,
        machineDetection: config.machineDetection,
      });
    } catch (err) {
      this.attemptsUsed.set(callId, used + 1);
      this.deps.logger.warn(`[call-handoff] could not call ${humanId}: ${String(err)}`);
      return { ok: false, error: `${human.name} could not be reached. ${this.nextStep(callId)}` };
    }
    this.attemptsUsed.set(callId, used + 1);

    const attempt: Attempt = {
      callId,
      businessSid,
      business,
      humanId,
      human,
      humanSid: humanCall.sid,
      conference,
      // ring time + machine detection + the prompt, with margin
      deadline: this.now() + (config.ringTimeoutSec + (config.machineDetection ? 35 : 15) + 20) * 1000,
    };
    this.active.set(callId, attempt);
    this.deps.logger.info(`[call-handoff] ringing ${humanId} for call ${callId} (${humanCall.sid})`);
    const run = this.watch(attempt).finally(() => {
      this.active.delete(callId);
      this.running.delete(run);
    });
    this.running.add(run);

    return {
      ok: true,
      human: humanId,
      message: `Calling ${human.name} now. Keep the other party company and ask them to hold. If ${human.name} picks up, they are connected and you leave the call automatically; if not, you will get a notice.`,
    };
  }

  /** Wait for the in-flight hand-offs (tests and shutdown). */
  async settle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running]);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.settle();
  }

  private async watch(a: Attempt): Promise<void> {
    const { twilio, config } = this.deps;
    try {
      for (;;) {
        await this.sleep(config.pollIntervalMs);
        if (this.closed) {
          await twilio.endCall(a.humanSid, true).catch(() => {});
          return;
        }
        const business = await twilio.getCall(a.businessSid);
        if (ENDED.has(business.status)) {
          this.deps.logger.info(`[call-handoff] call ${a.callId} ended while ${a.humanId} was being called`);
          await twilio.endCall(a.humanSid, true).catch(() => {});
          return;
        }
        const human = await twilio.getCall(a.humanSid);
        if (ENDED.has(human.status)) {
          const why =
            human.status === "busy"
              ? `${a.human.name} is busy`
              : human.status === "no-answer" || human.status === "canceled" || human.status === "completed"
                ? `${a.human.name} didn't pick up`
                : `${a.human.name} couldn't be reached`;
          await this.fail(a, why);
          return;
        }
        const answeredBy = human.answered_by ?? "";
        if (answeredBy.startsWith("machine") || answeredBy === "fax") {
          await twilio.endCall(a.humanSid, false).catch(() => {});
          await this.fail(a, `${a.human.name}'s voicemail picked up`);
          return;
        }
        if (human.status === "in-progress" && (!config.machineDetection || answeredBy)) {
          const participants = await twilio.listParticipants(a.conference);
          if (participants.some((p) => p.call_sid === a.humanSid)) {
            await this.transfer(a);
            return;
          }
        }
        if (this.now() > a.deadline) {
          await twilio.endCall(a.humanSid, RINGING.has(human.status)).catch(() => {});
          await this.fail(a, `${a.human.name} didn't pick up`);
          return;
        }
      }
    } catch (err) {
      this.deps.logger.warn(`[call-handoff] hand-off for call ${a.callId} failed: ${String(err)}`);
      await twilio.endCall(a.humanSid, true).catch(() => {});
      await this.fail(a, `${a.human.name} couldn't be connected`);
    }
  }

  private async transfer(a: Attempt): Promise<void> {
    const announcement = fillTemplate(this.deps.config.calleeAnnouncement, { humanName: a.human.name });
    try {
      await this.deps.twilio.redirectCall(a.businessSid, businessJoinTwiml(announcement, a.conference));
    } catch (err) {
      this.deps.logger.warn(`[call-handoff] redirect failed for call ${a.callId}: ${String(err)}`);
      await this.deps.twilio.endCall(a.humanSid, false).catch(() => {});
      await this.fail(a, `${a.human.name} answered but couldn't be connected`);
      return;
    }
    // The redirect ended voice-call's realtime stream. Report the call completed
    // before voice-call's ~2 s stream-loss grace would hang it up.
    this.transferred.add(a.callId);
    try {
      await this.deps.voiceCall.reportCompleted({
        callId: a.callId,
        callSid: a.businessSid,
        from: a.business.from,
        to: a.business.to,
      });
      this.deps.logger.info(`[call-handoff] call ${a.callId} handed to ${a.humanId}`);
    } catch (err) {
      this.deps.logger.warn(
        `[call-handoff] call ${a.callId} handed to ${a.humanId}, but voice-call did not accept the completed status (it may hang up): ${String(err)}`,
      );
    }
  }

  private nextStep(callId: string): string {
    const left = this.deps.config.maxAttemptsPerCall - (this.attemptsUsed.get(callId) ?? 0);
    return left > 0
      ? `You may try someone else (${this.describeHumans()}) if it makes sense; otherwise offer to take a message.`
      : "Offer to take a message.";
  }

  private async fail(a: Attempt, why: string): Promise<void> {
    this.deps.logger.info(`[call-handoff] hand-off for call ${a.callId} did not connect: ${why}`);
    const notice = `[System notice, not from the caller] ${why}. Tell the other party ${a.human.name} can't join right now. ${this.nextStep(a.callId)}`;
    try {
      await this.deps.voiceCall.speak(a.callId, notice);
    } catch (err) {
      this.deps.logger.warn(`[call-handoff] could not notify the voice agent: ${String(err)}`);
    }
  }
}
