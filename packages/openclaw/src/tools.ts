import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/core";

import {
  formatOperatorRuntimeStatusForAgent,
  getAgentSessionStatus,
} from "./agent-runtime.js";
import { resolveLanglangbotConversationIdFromRouteParams } from "./session-route.js";
import {
  createLanglangbotSidecar,
  isLanglangbotAccountReady,
  resolveLanglangbotAccount,
} from "./config.js";

const conversationIdParameters = {
  type: "object",
  properties: {
    conversation_id: {
      type: "string",
      description:
        "LangLangBot conversation id. Defaults to the active langlangbot session when omitted.",
    },
  },
} as const;

function resolveConversationId(
  ctx: { sessionKey?: string | null },
  params: Record<string, unknown>,
): string | undefined {
  return (
    resolveLanglangbotConversationIdFromRouteParams({
      target: readStringParam(params, "conversation_id") ?? undefined,
      currentSessionKey: ctx.sessionKey,
    }) ?? undefined
  );
}

function resolveLanglangbotToolContext(ctx: {
  config?: unknown;
  getRuntimeConfig?: () => unknown;
  agentAccountId?: string | null;
}) {
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.config;
  if (!cfg) {
    return null;
  }
  const accountId = ctx.agentAccountId ?? "default";
  const account = resolveLanglangbotAccount(cfg, accountId);
  if (!isLanglangbotAccountReady(account)) {
    return null;
  }
  return { account, accountId, sidecar: createLanglangbotSidecar(account) };
}

export function registerLanglangbotTools(api: OpenClawPluginApi): void {
  // OpenClaw matches cached plugin tools to factories by explicit names. Without
  // opts.names, every factory inherits the full contracts.tools list and execute
  // always hits the first factory — causing "plugin tool runtime missing" for later tools.
  api.registerTool(
    (ctx) => {
      const runtime = resolveLanglangbotToolContext(ctx);
      if (!runtime) {
        return null;
      }
      const { sidecar } = runtime;
      return {
        name: "langlangbot_connection_current",
        label: "LangLangBot connection",
        description:
          "Query how the Operator app is currently connected to LangLangBot (LAN or dedicated network). " +
          "Use when the user asks how they are connected.",
        parameters: conversationIdParameters,
        async execute(_toolCallId, params) {
          const conversationId = resolveConversationId(ctx, params);
          if (!conversationId) {
            return jsonResult({
              status: "error",
              message:
                "conversation_id is required when no active langlangbot session is available.",
            });
          }
          const output = await sidecar.getPluginConnectionCurrent(conversationId);
          return jsonResult(output);
        },
      };
    },
    { names: ["langlangbot_connection_current"] },
  );

  // FIXME(openclaw-upstream): Remove this tool once OpenClaw session_status reports correct
  // context window and token stats (openclaw/openclaw#92760, openclaw/openclaw#70692).
  api.registerTool(
    (ctx) => {
      const runtime = resolveLanglangbotToolContext(ctx);
      if (!runtime) {
        return null;
      }
      const { accountId, account } = runtime;
      return {
        name: "langlangbot_operator_runtime_status",
        label: "LangLang Operator runtime status",
        description:
          "Query context usage, model, and token stats aligned with the LangLang Operator app runtime bar. " +
          "Use when the user asks about context window, token usage, or current model from the app UI.",
        parameters: conversationIdParameters,
        async execute(_toolCallId, params) {
          const conversationId = resolveConversationId(ctx, params);
          if (!conversationId) {
            return jsonResult({
              status: "error",
              message:
                "conversation_id is required when no active langlangbot session is available.",
            });
          }
          try {
            const status = await getAgentSessionStatus({
              accountId,
              conversationId,
              agentId: account.agentId,
            });
            return jsonResult(formatOperatorRuntimeStatusForAgent(status));
          } catch (err) {
            return jsonResult({
              status: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
      };
    },
    { names: ["langlangbot_operator_runtime_status"] },
  );

  api.registerTool(
    (ctx) => {
      const runtime = resolveLanglangbotToolContext(ctx);
      if (!runtime) {
        return null;
      }
      const { sidecar } = runtime;
      return {
        name: "langlangbot_conversation_transcript",
        label: "LangLangBot conversation transcript",
        description:
          "Read earlier Operator chat for this conversation from LangLangBot. " +
          "Use when the user asks about topics older than the recent continuity seed, " +
          "or when the restored context is not enough. Do not call this for routine turns. " +
          "Pass since (RFC3339) or max_age_hours (default 24, max 168).",
        parameters: transcriptParameters,
        async execute(_toolCallId, params) {
          const conversationId = resolveConversationId(ctx, params);
          if (!conversationId) {
            return jsonResult({
              status: "error",
              message:
                "conversation_id is required when no active langlangbot session is available.",
            });
          }
          const since = readStringParam(params, "since") || undefined;
          const limit = clampTranscriptLimit(readNumberParam(params, "limit", { integer: true }));
          try {
            const body = await sidecar.listConversationTranscript(conversationId, {
              limit,
              since,
              maxAgeHours: since
                ? undefined
                : clampTranscriptHours(readNumberParam(params, "max_age_hours")),
            });
            return jsonResult(body);
          } catch (err) {
            return jsonResult({
              status: "error",
              message: err instanceof Error ? err.message : String(err),
            });
          }
        },
      };
    },
    { names: ["langlangbot_conversation_transcript"] },
  );
}

const transcriptParameters = {
  type: "object",
  properties: {
    ...conversationIdParameters.properties,
    since: {
      type: "string",
      description: "RFC3339 inclusive lower bound. Wins over max_age_hours.",
    },
    max_age_hours: {
      type: "number",
      description: "Hours ending now when since is omitted. Default 24, maximum 168.",
    },
    limit: {
      type: "number",
      description: "Maximum turns to return. Default 40, maximum 80.",
    },
  },
} as const;

const TRANSCRIPT_DEFAULT_HOURS = 24;
const TRANSCRIPT_MAX_HOURS = 168;
const TRANSCRIPT_DEFAULT_LIMIT = 40;
const TRANSCRIPT_MAX_LIMIT = 80;

function clampTranscriptHours(raw: number | undefined): number {
  if (raw == null) {
    return TRANSCRIPT_DEFAULT_HOURS;
  }
  return Math.min(TRANSCRIPT_MAX_HOURS, Math.max(1, raw));
}

function clampTranscriptLimit(raw: number | undefined): number {
  if (raw == null) {
    return TRANSCRIPT_DEFAULT_LIMIT;
  }
  return Math.min(TRANSCRIPT_MAX_LIMIT, Math.max(1, Math.floor(raw)));
}
