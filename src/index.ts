import { Type } from "typebox";
import { ErrorCodes, errorShape } from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { parseConfig } from "./config.js";
import { HandoffController } from "./handoff.js";
import { TwilioClient } from "./twilio.js";
import { createVoiceCallApi } from "./voice-call.js";

const TOOL_NAME = "transfer_call_to_human";

export default definePluginEntry({
  id: "call-handoff",
  name: "Call Hand-off",
  description: "Hand a live voice call over to a configured human.",
  register(api) {
    const voiceCallConfig = (api.config?.plugins?.entries?.["voice-call"]?.config ?? undefined) as
      | Record<string, unknown>
      | undefined;
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

    api.registerTool({
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
      async execute(_toolCallId, params) {
        return jsonResult(await start((params ?? {}) as Record<string, unknown>));
      },
    });

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
