import { Type } from "typebox";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { isVoiceSession, parseConfig, voiceCallProblems } from "./config.js";
import { HandoffController } from "./handoff.js";
import { TwilioClient } from "./twilio.js";
import { createVoiceCallApi } from "./voice-call.js";

const TOOL_NAME = "transfer_call_to_human";

export default definePluginEntry({
  id: "call-handoff",
  name: "Call Hand-off",
  description: "Hand a live voice call over to a configured human.",
  register(api) {
    const voiceCallEntry = api.config?.plugins?.entries?.["voice-call"];
    const voiceCallConfig = (voiceCallEntry?.config ?? undefined) as Record<string, unknown> | undefined;
    // Without a usable voice-call there is nothing to hand off: offer no tool at all.
    const problems = voiceCallProblems(voiceCallEntry);
    if (problems.length > 0) {
      api.logger.warn(`[call-handoff] disabled: ${problems.join("; ")}`);
      return;
    }
    const { config, errors } = parseConfig(api.pluginConfig, voiceCallConfig);
    if (!config) {
      api.logger.warn(`[call-handoff] disabled: ${errors.join("; ")}`);
      return;
    }
    if (!config.voiceWebhookSignedUrl) {
      api.logger.warn(
        "[call-handoff] disabled: set voiceWebhookSignedUrl or voice-call's publicUrl (needed to sign the completed status)",
      );
      return;
    }

    const controller = new HandoffController({
      config,
      twilio: new TwilioClient(config.twilio),
      voiceCall: createVoiceCallApi({
        gateway: config.gateway,
        webhookUrl: config.voiceWebhookUrl,
        signedWebhookUrl: config.voiceWebhookSignedUrl,
        accountSid: config.twilio.accountSid,
        authToken: config.twilio.authToken,
      }),
      logger: api.logger,
    });

    const start = async (params: Record<string, unknown>) =>
      controller.start({
        human: typeof params.human === "string" ? params.human : undefined,
        reason: typeof params.reason === "string" ? params.reason : undefined,
        callId: typeof params.callId === "string" ? params.callId : undefined,
      });

    const tool = {
      name: TOOL_NAME,
      label: "Transfer call to a human",
      description:
        "Hand the live phone call over to a real person, e.g. when the other party insists on speaking to a human or a decision needs that person. " +
        "Their phone rings; when they answer they are connected and the voice agent leaves the call. Returns immediately. " +
        `People: ${controller.describeHumans()}. Omit human to use the default.`,
      parameters: Type.Object({
        human: Type.Optional(Type.String({ description: "Id of the person to bring in." })),
        reason: Type.String({
          description: "One short sentence the person hears first: who is calling and what they need.",
        }),
        callId: Type.Optional(
          Type.String({ description: "voice-call callId; only needed when several calls are live." }),
        ),
      }),
      async execute(_toolCallId: string, params: unknown) {
        return jsonResult(await start((params ?? {}) as Record<string, unknown>));
      },
    };
    // Voice-call consults run in agent:<id>:voice:* sessions; elsewhere there is no call to hand off.
    api.registerTool((ctx) =>
      config.toolVisibility === "always" || isVoiceSession(ctx.sessionKey) ? tool : null,
    );

    // Same entry point for operators and live tests: gateway call callhandoff.start.
    api.registerGatewayMethod(
      "callhandoff.start",
      async (options) => {
        const result = await start((options.params ?? {}) as Record<string, unknown>);
        if (result.ok) {
          options.respond(true, result);
        } else {
          options.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, result.error));
        }
      },
      { scope: "operator.write" },
    );

    api.registerService({
      id: "call-handoff",
      start: () => {
        api.logger.info(
          `[call-handoff] ready (${Object.keys(config.humans).join(", ")}; machine detection ${config.machineDetection ? "on" : "off"})`,
        );
      },
      stop: () => controller.close(),
    });
  },
});
