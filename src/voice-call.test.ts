import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { createVoiceCallApi, twilioSignature } from "./voice-call.js";

describe("twilioSignature", () => {
  it("matches Twilio's algorithm: HMAC-SHA1 over URL plus sorted params", () => {
    const params = { CallSid: "CA1", AccountSid: "AC1", CallStatus: "completed" };
    const expected = crypto
      .createHmac("sha1", "secret")
      .update("https://x/voice/webhook?a=1AccountSidAC1CallSidCA1CallStatuscompleted")
      .digest("base64");
    expect(twilioSignature("secret", "https://x/voice/webhook?a=1", params)).toBe(expected);
  });
});

describe("reportCompleted", () => {
  it("posts to the loopback webhook, signed for voice-call's public URL", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const api = createVoiceCallApi({
      gateway: { url: "ws://unused" },
      webhookUrl: "http://127.0.0.1:3334/voice/webhook",
      signedWebhookUrl: "https://public.example/voice/webhook",
      accountSid: "AC1",
      authToken: "secret",
      fetchImpl: (async (url: string, init: RequestInit) => {
        requests.push({ url, init });
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });

    await api.reportCompleted({ callId: "call-1", callSid: "CA1", from: "+15550000000", to: "+15557654321" });

    const req = requests[0];
    expect(req?.url).toBe("http://127.0.0.1:3334/voice/webhook?callId=call-1&type=status");
    const body = Object.fromEntries(new URLSearchParams(String(req?.init.body)));
    expect(body).toMatchObject({ CallSid: "CA1", CallStatus: "completed", AccountSid: "AC1" });
    const headers = req?.init.headers as Record<string, string>;
    expect(headers["X-Twilio-Signature"]).toBe(
      twilioSignature("secret", "https://public.example/voice/webhook?callId=call-1&type=status", body),
    );
  });

  it("fails loudly when voice-call rejects it", async () => {
    const api = createVoiceCallApi({
      gateway: { url: "ws://unused" },
      webhookUrl: "http://127.0.0.1:3334/voice/webhook",
      signedWebhookUrl: "https://public.example/voice/webhook",
      accountSid: "AC1",
      authToken: "wrong",
      fetchImpl: (async () => new Response("Unauthorized", { status: 401 })) as unknown as typeof fetch,
    });
    await expect(
      api.reportCompleted({ callId: "c", callSid: "CA1", from: "+1", to: "+2" }),
    ).rejects.toThrow("HTTP 401");
  });
});
