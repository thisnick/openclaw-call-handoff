import crypto from "node:crypto";
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "openclaw/plugin-sdk/gateway-runtime";

// Everything this plugin needs from the stock voice-call plugin: its gateway
// methods (operator WebSocket, like OpenClaw's Google Meet plugin) and its
// signed Twilio webhook.

export type VoiceCallStatus = {
  callId: string;
  providerCallId?: string;
  provider?: string;
  direction?: string;
  state?: string;
};

export type VoiceCallApi = {
  activeCalls(): Promise<VoiceCallStatus[]>;
  speak(callId: string, message: string): Promise<void>;
  /** Tell voice-call the carrier call is over so it closes its record without hanging up. */
  reportCompleted(params: { callId: string; callSid: string; from: string; to: string }): Promise<void>;
};

/** Twilio's request signature: base64(HMAC-SHA1(url + sorted key/value pairs)). */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const material = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  return crypto.createHmac("sha1", authToken).update(material).digest("base64");
}

async function gatewayRequest(
  gateway: { url: string; token?: string },
  method: string,
  params: unknown,
  timeoutMs = 10_000,
): Promise<unknown> {
  let client: InstanceType<typeof GatewayClient> | undefined;
  const abort = new AbortController();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        abort.abort();
        reject(new Error("gateway connect timeout"));
      }, timeoutMs);
      client = new GatewayClient({
        url: gateway.url,
        token: gateway.token,
        requestTimeoutMs: timeoutMs,
        clientName: "cli",
        clientDisplayName: "Call hand-off plugin",
        scopes: ["operator.write"],
        onHelloOk: () => {
          clearTimeout(timer);
          resolve();
        },
        onConnectError: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      void startGatewayClientWhenEventLoopReady(client, { timeoutMs, signal: abort.signal });
    });
    return await client!.request(method, params, { timeoutMs });
  } finally {
    await client?.stopAndWait().catch(() => {});
  }
}

export function createVoiceCallApi(params: {
  gateway: { url: string; token?: string };
  webhookUrl: string;
  signedWebhookUrl: string;
  accountSid: string;
  authToken: string;
  fetchImpl?: typeof fetch;
}): VoiceCallApi {
  return {
    async activeCalls() {
      const res = (await gatewayRequest(params.gateway, "voicecall.status", {})) as {
        calls?: VoiceCallStatus[];
      };
      return res.calls ?? [];
    },
    async speak(callId, message) {
      await gatewayRequest(params.gateway, "voicecall.speak", { callId, message });
    },
    async reportCompleted({ callId, callSid, from, to }) {
      const query = `?${new URLSearchParams({ callId, type: "status" })}`;
      const body: Record<string, string> = {
        AccountSid: params.accountSid,
        CallSid: callSid,
        CallStatus: "completed",
        Direction: "outbound-api",
        From: from,
        To: to,
      };
      const res = await (params.fetchImpl ?? fetch)(params.webhookUrl + query, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Twilio-Signature": twilioSignature(params.authToken, params.signedWebhookUrl + query, body),
        },
        body: new URLSearchParams(body).toString(),
      });
      if (!res.ok) {
        throw new Error(`voice-call rejected the completed status: HTTP ${res.status}`);
      }
    },
  };
}
