import { describe, expect, it } from "vitest";
import { isVoiceSession, parseConfig, voiceCallProblems } from "./config.js";
import { HandoffController, phoneForSpeech } from "./handoff.js";
import type { TwilioCall } from "./twilio.js";
import type { VoiceCallApi, VoiceCallStatus } from "./voice-call.js";

const BUSINESS_SID = "CA-business";

function makeConfig(overrides: Record<string, unknown> = {}) {
  const { config, errors } = parseConfig({
    twilio: { accountSid: "AC-test", authToken: "token" },
    fromNumber: "+15550000000",
    voiceWebhookSignedUrl: "https://example.com/voice/webhook",
    humans: {
      nick: { name: "Nick", number: "+15550001111", description: "the account owner" },
      jane: { name: "Jane", number: "+15550002222", description: "Nick's wife" },
    },
    defaultHuman: "nick",
    ...overrides,
  });
  if (!config) throw new Error(errors.join("; "));
  return config;
}

/** Fake Twilio: each human call follows a scripted list of states, one per poll. */
class FakeTwilio {
  readonly created: Array<{ to: string; from: string; twiml: string; machineDetection: boolean }> = [];
  readonly redirects: Array<{ sid: string; twiml: string }> = [];
  readonly ended: string[] = [];
  business: TwilioCall = { sid: BUSINESS_SID, status: "in-progress", from: "+15550000000", to: "+15557654321" };
  businessScript: string[] = [];
  humanScript: Array<Partial<TwilioCall>> = [];
  joined = false;
  redirectError?: Error;
  private humanStep = 0;
  private n = 0;

  async createCall(p: { to: string; from: string; twiml: string; machineDetection: boolean }) {
    this.created.push(p);
    this.n += 1;
    this.humanStep = 0;
    return { sid: `CA-human-${this.n}`, status: "queued", from: p.from, to: p.to };
  }

  async getCall(sid: string): Promise<TwilioCall> {
    if (sid === BUSINESS_SID) {
      const next = this.businessScript.shift();
      if (next) this.business = { ...this.business, status: next };
      return this.business;
    }
    const step = this.humanScript[Math.min(this.humanStep, this.humanScript.length - 1)] ?? {};
    this.humanStep += 1;
    if (step.status === "in-progress" && step.answered_by !== undefined && !String(step.answered_by).startsWith("machine")) {
      this.joined = true;
    }
    return { sid, status: "ringing", from: "+15550000000", to: "x", ...step };
  }

  async redirectCall(sid: string, twiml: string) {
    if (this.redirectError) throw this.redirectError;
    this.redirects.push({ sid, twiml });
  }

  async endCall(sid: string) {
    this.ended.push(sid);
  }

  async listParticipants() {
    return this.joined ? [{ call_sid: `CA-human-${this.n}` }] : [];
  }
}

function setup(opts: { calls?: VoiceCallStatus[]; config?: Record<string, unknown>; completedFails?: boolean } = {}) {
  const twilio = new FakeTwilio();
  const spoken: string[] = [];
  const completed: Array<{ callId: string; callSid: string }> = [];
  const voiceCall: VoiceCallApi = {
    activeCalls: async () =>
      opts.calls ?? [{ callId: "call-1", providerCallId: BUSINESS_SID, direction: "outbound", state: "active" }],
    speak: async (_callId, message) => {
      spoken.push(message);
    },
    reportCompleted: async (p) => {
      if (opts.completedFails) throw new Error("401");
      completed.push(p);
    },
  };
  let clock = 0;
  const controller = new HandoffController({
    config: makeConfig(opts.config),
    twilio,
    voiceCall,
    logger: { info: () => {}, warn: () => {} },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    makeId: () => "abc123",
  });
  return { twilio, controller, spoken, completed };
}

describe("HandoffController", () => {
  it("rings the default human with the reason and the business number spoken", async () => {
    const { twilio, controller } = setup();
    twilio.humanScript = [{ status: "ringing" }, { status: "no-answer" }];

    const result = await controller.start({ reason: "they only have 8:15" });
    await controller.settle();

    expect(result).toMatchObject({ ok: true, human: "nick" });
    expect(twilio.created[0]).toMatchObject({ to: "+15550001111", from: "+15550000000", machineDetection: true });
    expect(twilio.created[0]?.twiml).toContain("Call from 5 5 5, 7 6 5, 4 3 2 1 about: they only have 8:15.");
    expect(twilio.created[0]?.twiml).toContain("<Conference");
  });

  it("transfers when a person answers: redirect the business, report completed, never hang up", async () => {
    const { twilio, controller, completed, spoken } = setup();
    twilio.humanScript = [{ status: "ringing" }, { status: "in-progress", answered_by: "human" }];

    await controller.start({ human: "jane", reason: "confirm the time" });
    await controller.settle();

    expect(twilio.redirects).toHaveLength(1);
    expect(twilio.redirects[0]?.sid).toBe(BUSINESS_SID);
    expect(twilio.redirects[0]?.twiml).toContain("<Say>Jane is joining now.</Say>");
    expect(twilio.redirects[0]?.twiml).toContain(">oc-handoff-call-1-abc123</Conference>");
    expect(completed).toEqual([
      { callId: "call-1", callSid: BUSINESS_SID, from: "+15550000000", to: "+15557654321" },
    ]);
    expect(twilio.ended).toEqual([]);
    expect(spoken).toEqual([]);
    expect(await controller.start({ reason: "again" })).toMatchObject({ ok: false, error: expect.stringContaining("already handed off") });
  });

  it("speaks to each person in their own language and prompt", async () => {
    const { twilio, controller } = setup({
      config: {
        humans: {
          nick: { name: "Nick", number: "+15550001111" },
          mom: {
            name: "Xiaokun Yang",
            number: "+15550003333",
            description: "Nick's mom",
            language: "cmn-CN",
            voice: "Polly.Zhiyu-Neural",
            prompt: "{callee}打来的电话，事由：{reason}。正在为您接通。",
          },
        },
      },
    });
    twilio.humanScript = [{ status: "no-answer" }];
    expect(controller.describeHumans()).toContain("mom (Xiaokun Yang, Nick's mom, write reason in cmn-CN)");

    await controller.start({ human: "mom", reason: "确认周五晚上七点半的两人桌" });
    await controller.settle();

    const twiml = twilio.created[0]?.twiml ?? "";
    expect(twiml).toContain('<Say voice="Polly.Zhiyu-Neural" language="cmn-CN">');
    expect(twiml).toContain("打来的电话，事由：确认周五晚上七点半的两人桌。正在为您接通。");
  });

  it("waits for answering-machine detection before joining", async () => {
    const { twilio, controller } = setup();
    twilio.humanScript = [
      { status: "in-progress", answered_by: null },
      { status: "in-progress", answered_by: null },
      { status: "in-progress", answered_by: "human" },
    ];
    await controller.start({ reason: "x" });
    await controller.settle();
    expect(twilio.redirects).toHaveLength(1);
  });

  it("hangs up on voicemail and tells the voice agent; the business call is untouched", async () => {
    const { twilio, controller, spoken } = setup();
    twilio.humanScript = [{ status: "in-progress", answered_by: "machine_end_beep" }];
    await controller.start({ reason: "x" });
    await controller.settle();
    expect(twilio.ended).toEqual(["CA-human-1"]);
    expect(twilio.redirects).toHaveLength(0);
    expect(spoken[0]).toContain("Nick's voicemail picked up");
    expect(spoken[0]).toContain("jane (Jane, Nick's wife)");
  });

  it.each([
    ["no-answer", "Nick didn't pick up"],
    ["busy", "Nick is busy"],
    ["failed", "Nick couldn't be reached"],
  ])("reports a %s human leg to the voice agent", async (status, text) => {
    const { twilio, controller, spoken } = setup();
    twilio.humanScript = [{ status }];
    await controller.start({ reason: "x" });
    await controller.settle();
    expect(spoken[0]).toContain(text);
    expect(twilio.redirects).toHaveLength(0);
  });

  it("cancels the human's call when the business hangs up first, without a notice", async () => {
    const { twilio, controller, spoken } = setup();
    twilio.humanScript = [{ status: "ringing" }];
    twilio.businessScript = ["completed"];
    await controller.start({ reason: "x" });
    await controller.settle();
    expect(twilio.ended).toEqual(["CA-human-1"]);
    expect(spoken).toEqual([]);
  });

  it("gives up after the deadline", async () => {
    const { twilio, controller, spoken } = setup();
    twilio.humanScript = [{ status: "ringing" }];
    await controller.start({ reason: "x" });
    await controller.settle();
    expect(twilio.ended).toEqual(["CA-human-1"]);
    expect(spoken[0]).toContain("didn't pick up");
  });

  it("tells the voice agent and drops the human when the redirect fails", async () => {
    const { twilio, controller, spoken, completed } = setup();
    twilio.humanScript = [{ status: "in-progress", answered_by: "human" }];
    twilio.redirectError = new Error("twilio down");
    await controller.start({ reason: "x" });
    await controller.settle();
    expect(twilio.ended).toEqual(["CA-human-1"]);
    expect(completed).toEqual([]);
    expect(spoken[0]).toContain("answered but couldn't be connected");
  });

  it("limits attempts per call and refuses a second while one rings", async () => {
    const { twilio, controller } = setup({ config: { maxAttemptsPerCall: 1 } });
    twilio.humanScript = [{ status: "ringing" }];
    await controller.start({ reason: "x" });
    expect(await controller.start({ reason: "y" })).toMatchObject({ ok: false, error: expect.stringContaining("already being called") });
    await controller.settle();
    expect(await controller.start({ reason: "z" })).toMatchObject({ ok: false, error: expect.stringContaining("No hand-off attempts left") });
    expect(twilio.created).toHaveLength(1);
  });

  it("rejects unknown humans, ambiguous calls, and inbound calls", async () => {
    expect(await setup().controller.start({ human: "bob", reason: "x" })).toMatchObject({
      ok: false,
      error: expect.stringContaining('Unknown person "bob"'),
    });
    const two = setup({
      calls: [
        { callId: "a", providerCallId: "CA-a", direction: "outbound", state: "active" },
        { callId: "b", providerCallId: "CA-b", direction: "outbound", state: "active" },
      ],
    });
    expect(await two.controller.start({ reason: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("2 live calls") });
    const inbound = setup({
      calls: [{ callId: "c", providerCallId: BUSINESS_SID, direction: "inbound", state: "active" }],
    });
    expect(await inbound.controller.start({ reason: "x" })).toMatchObject({ ok: false, error: expect.stringContaining("only available") });
  });
});

describe("config", () => {
  it("requires credentials, humans and a known default", () => {
    expect(parseConfig({}).errors).toEqual(
      expect.arrayContaining([
        "twilio.accountSid is required",
        "twilio.authToken is required",
        "humans needs at least one entry",
      ]),
    );
    expect(
      parseConfig({
        twilio: { accountSid: "AC", authToken: "t" },
        fromNumber: "+15550000000",
        humans: { nick: { name: "Nick", number: "+15550001111" } },
        defaultHuman: "jane",
      }).errors,
    ).toEqual(['defaultHuman "jane" is not in humans']);
  });

  it("defaults the account, number and signed URL from voice-call's config", () => {
    const { config } = parseConfig(
      { twilio: { authToken: "t" }, humans: { nick: { name: "Nick", number: "+15550001111" } } },
      { twilio: { accountSid: "AC-vc" }, fromNumber: "+15550000000", publicUrl: "https://host/voice/webhook" },
    );
    expect(config).toMatchObject({
      twilio: { accountSid: "AC-vc" },
      fromNumber: "+15550000000",
      voiceWebhookSignedUrl: "https://host/voice/webhook",
      machineDetection: true,
    });
  });
});

describe("phoneForSpeech", () => {
  it("reads US numbers in groups", () => {
    expect(phoneForSpeech("+15551234567")).toBe("5 5 5, 1 2 3, 4 5 6 7");
  });
});

describe("voice-call readiness", () => {
  const ready = {
    enabled: true,
    config: { provider: "twilio", realtime: { enabled: true, toolPolicy: "owner" } },
  };

  it("accepts a realtime Twilio voice-call with owner consults", () => {
    expect(voiceCallProblems(ready)).toEqual([]);
  });

  it("explains each reason the hand-off cannot work", () => {
    expect(voiceCallProblems(undefined)).toEqual([expect.stringContaining("not configured")]);
    expect(voiceCallProblems({ ...ready, enabled: false })).toEqual(["the voice-call plugin is disabled"]);
    expect(voiceCallProblems({ config: { provider: "telnyx", realtime: { enabled: false } } })).toEqual([
      'voice-call provider must be "twilio"',
      "voice-call realtime.enabled must be true",
      expect.stringContaining('toolPolicy is "safe-read-only"'),
    ]);
    expect(
      voiceCallProblems({ config: { provider: "twilio", realtime: { enabled: true, toolPolicy: "safe-read-only" } } }),
    ).toEqual([expect.stringContaining('consults need "owner"')]);
  });
});

describe("isVoiceSession", () => {
  it("matches voice-call consult sessions only", () => {
    expect(isVoiceSession("agent:main:voice:+15551234567")).toBe(true);
    expect(isVoiceSession("agent:main:voice:call:abc")).toBe(true);
    expect(isVoiceSession("agent:main:whatsapp:direct:+15551234567")).toBe(false);
    expect(isVoiceSession("agent:main:main")).toBe(false);
    expect(isVoiceSession(undefined)).toBe(false);
  });
});
