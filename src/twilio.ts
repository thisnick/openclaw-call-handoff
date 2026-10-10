// Minimal Twilio REST client (form-encoded, basic auth). apiBaseUrl is
// configurable so tests can point it at a local fake.

export type TwilioCall = {
  sid: string;
  status: string;
  from: string;
  to: string;
  answered_by?: string | null;
};

export type TwilioParticipant = { call_sid: string };

export class TwilioClient {
  constructor(
    private readonly opts: {
      accountSid: string;
      authToken: string;
      apiBaseUrl: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  private get base(): string {
    return `${this.opts.apiBaseUrl.replace(/\/$/, "")}/2010-04-01/Accounts/${this.opts.accountSid}`;
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const auth = Buffer.from(`${this.opts.accountSid}:${this.opts.authToken}`).toString("base64");
    const res = await (this.opts.fetchImpl ?? fetch)(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${auth}`,
        ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(params ? { body: new URLSearchParams(params).toString() } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Twilio ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  createCall(params: {
    to: string;
    from: string;
    twiml: string;
    timeoutSec: number;
    machineDetection: boolean;
  }): Promise<TwilioCall> {
    return this.request<TwilioCall>("POST", "/Calls.json", {
      To: params.to,
      From: params.from,
      Twiml: params.twiml,
      Timeout: String(params.timeoutSec),
      ...(params.machineDetection ? { MachineDetection: "Enable" } : {}),
    });
  }

  getCall(sid: string): Promise<TwilioCall> {
    return this.request<TwilioCall>("GET", `/Calls/${sid}.json`);
  }

  /** Replace the TwiML of a live call. */
  async redirectCall(sid: string, twiml: string): Promise<void> {
    await this.request("POST", `/Calls/${sid}.json`, { Twiml: twiml });
  }

  /** Stop a call: cancel while it rings, otherwise hang it up. */
  async endCall(sid: string, ringing: boolean): Promise<void> {
    if (ringing) {
      try {
        await this.request("POST", `/Calls/${sid}.json`, { Status: "canceled" });
        return;
      } catch {
        // already answered; fall through
      }
    }
    await this.request("POST", `/Calls/${sid}.json`, { Status: "completed" });
  }

  async listParticipants(conferenceName: string): Promise<TwilioParticipant[]> {
    const confs = await this.request<{ conferences?: Array<{ sid: string }> }>(
      "GET",
      `/Conferences.json?${new URLSearchParams({ FriendlyName: conferenceName, Status: "in-progress" })}`,
    );
    const conf = confs.conferences?.[0];
    if (!conf) return [];
    const parts = await this.request<{ participants?: TwilioParticipant[] }>(
      "GET",
      `/Conferences/${conf.sid}/Participants.json`,
    );
    return parts.participants ?? [];
  }
}
