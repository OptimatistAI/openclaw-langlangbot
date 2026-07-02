import type { LanglangbotSidecar } from "@optimatist/langlangbot-connector";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/index";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

import {
  conversationTarget,
  createLanglangbotSidecar,
  formatError,
  type LanglangbotAccount,
} from "./config.js";
import {
  openClawOwnerAllowFrom,
  resolveOwnerFrom,
  resolveVerifiedOwnerSurface,
} from "./owner-surface.js";
import { getLanglangbotRuntime } from "./runtime.js";
import {
  ensureLanglangbotSidecar,
  releaseLanglangbotSidecar,
} from "./sidecar-manager.js";
import { startManagementBridge } from "./management-bridge.js";
import { buildLanglangbotSessionKey } from "./session-key.js";
import {
  resolveOpenclawSessionStorePath,
  setOpenclawSessionStoreConfig,
} from "./session-store.js";

type InboundHandle = {
  conversationId: string;
  messageId: string;
  text: string;
  ownerSurfaceId?: string;
};

type AgentDispatchRuntime = {
  session: {
    resolveStorePath: (store: unknown, opts: { agentId: string }) => string;
    recordInboundSession: unknown;
  };
  reply: {
    finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
    dispatchReplyWithBufferedBlockDispatcher: (opts: unknown) => unknown;
  };
  turn: {
    run: (opts: unknown) => Promise<void>;
  };
};

type RuntimeReadiness =
  | { ready: true; runtime: AgentDispatchRuntime }
  | { ready: false; reason: string };

const AGENT_RUNTIME_NAME = "OpenClaw";
const AGENT_RUNTIME_NOT_READY_MESSAGE =
  "The agent runtime is not available yet. Configure a default agent/model in OpenClaw, then send your message again.";

export async function startLanglangbotGateway(
  ctx: ChannelGatewayContext<LanglangbotAccount>,
): Promise<void> {
  const account = ctx.account;
  const { startedByPlugin } = await ensureLanglangbotSidecar(account, ctx.log);

  const sidecar = createLanglangbotSidecar(account);

  ctx.log?.info?.(
    `[langlangbot:${account.accountId}] connected to LangLangBot at ${account.sidecarUrl}${
      startedByPlugin ? " (started by OpenClaw)" : ""
    }`,
  );
  setOpenclawSessionStoreConfig(ctx.cfg.session?.store);
  await reportAgentRuntimeStatus(sidecar, ctx, runtimeReadiness(ctx));

  let approvalNativeLease: { dispose: () => void } | null = null;
  if (ctx.channelRuntime) {
    approvalNativeLease = ctx.channelRuntime.runtimeContexts.register({
      channelId: "langlangbot",
      accountId: account.accountId,
      capability: "approval.native",
      context: { account },
      abortSignal: ctx.abortSignal,
    });
  } else {
    ctx.log?.warn?.(
      `[langlangbot:${account.accountId}] No channelRuntime — approval.native disabled`,
    );
  }

  const unsubscribeManagement = startManagementBridge({
    sidecar,
    account,
    log: ctx.log,
  });

  const unsubscribe = sidecar.subscribeInbound(
    { accountId: account.accountId, agentSurfaceId: account.surfaceId },
    (evt) => {
      void handleInbound(
        {
          conversationId: evt.conversationId,
          messageId: evt.messageId,
          text: evt.text,
          ownerSurfaceId: evt.ownerSurfaceId,
        },
        ctx,
        sidecar,
      ).catch((err) => {
        void reportAgentRuntimeStatus(sidecar, ctx, {
          ready: false,
          reason: formatError(err),
        });
        ctx.log?.error?.(
          `[langlangbot:${account.accountId}] inbound dispatch failed: ${
            formatError(err)
          }`,
        );
      });
    },
    (err) => {
      ctx.log?.warn?.(
        `[langlangbot:${account.accountId}] inbound SSE error: ${err.message}`,
      );
    },
  );

  ctx.setStatus({
    ...ctx.getStatus(),
    running: true,
    connected: true,
    lastConnectedAt: Date.now(),
  });

  await new Promise<void>((resolve) => {
    const onAbort = () => {
      unsubscribe();
      unsubscribeManagement();
      approvalNativeLease?.dispose();
      void reportAgentRuntimeStatus(sidecar, ctx, {
        ready: false,
        reason: "channel gateway stopped",
      }, false);
      releaseLanglangbotSidecar(account, ctx.log);
      ctx.setStatus({
        ...ctx.getStatus(),
        running: false,
        connected: false,
      });
      resolve();
    };
    if (ctx.abortSignal.aborted) {
      onAbort();
      return;
    }
    ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

async function handleInbound(
  inbound: InboundHandle,
  ctx: ChannelGatewayContext<LanglangbotAccount>,
  sidecar: LanglangbotSidecar,
): Promise<void> {
  const readiness = runtimeReadiness(ctx);
  if (!readiness.ready) {
    await reportAgentRuntimeStatus(sidecar, ctx, readiness);
    await sendOperatorVisibleStatus(
      sidecar,
      inbound.conversationId,
      AGENT_RUNTIME_NOT_READY_MESSAGE,
    );
    return;
  }
  const runtime = readiness.runtime;
  const account = ctx.account;
  const cfg = ctx.cfg;
  const to = conversationTarget(inbound.conversationId);
  const verifiedSurfaceId = resolveVerifiedOwnerSurface({
    ownerSurfaceId: inbound.ownerSurfaceId,
  });
  const from = resolveOwnerFrom({
    ownerSurfaceId: inbound.ownerSurfaceId,
    conversationId: inbound.conversationId,
  });
  const ownerAllowFrom = verifiedSurfaceId
    ? [openClawOwnerAllowFrom(verifiedSurfaceId)]
    : undefined;
  const sessionKey = buildLanglangbotSessionKey({
    accountId: account.accountId,
    conversationId: inbound.conversationId,
  });

  try {
    const storePath = resolveOpenclawSessionStorePath(sessionKey);
    const ctxPayload = runtime.reply.finalizeInboundContext({
      Body: inbound.text,
      RawBody: inbound.text,
      BodyForAgent: inbound.text,
      CommandBody: inbound.text,
      From: from,
      To: to,
      SessionKey: sessionKey,
      AccountId: account.accountId,
      MessageSid: inbound.messageId,
      Provider: "langlangbot",
      Surface: "langlangbot",
      OriginatingChannel: "langlangbot",
      OriginatingTo: to,
      ChatType: "direct",
      ...(ownerAllowFrom ? { OwnerAllowFrom: ownerAllowFrom } : {}),
    });
    const streamState = { streamedText: "", sentFinal: false };

    await runtime.turn.run({
      channel: "langlangbot",
      accountId: account.accountId,
      raw: inbound,
      adapter: {
        ingest: () => ({
          id: inbound.messageId,
          rawText: inbound.text,
          textForAgent: inbound.text,
          textForCommands: inbound.text,
          raw: inbound,
        }),
        resolveTurn: () => ({
          channel: "langlangbot",
          accountId: account.accountId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: runtime.session.recordInboundSession,
          record: {
            onRecordError: (err: unknown) => {
              ctx.log?.error?.(
                `[langlangbot:${account.accountId}] session record failed: ${
                  formatError(err)
                }`,
              );
            },
          },
          runDispatch: () =>
            runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: ctxPayload,
              cfg,
              dispatcherOptions: {
                deliver: async (payload: ReplyPayload, info: { kind?: string }) => {
                  const text = (payload.text ?? "").trim();
                  if (!text) {
                    return;
                  }
                  const kind = info.kind ?? "final";
                  if (account.streaming && kind === "block") {
                    streamState.streamedText = text;
                    ctx.log?.debug?.(
                      `[langlangbot:${account.accountId}] outbound delta (${text.length} chars) → ${inbound.conversationId}`,
                    );
                    await sidecar.sendDelta(inbound.conversationId, text);
                    return;
                  }
                  // OpenClaw often emits only a final payload (no block chunks). The Operator
                  // app may expect assistant_delta frames when streaming is enabled.
                  if (account.streaming && !streamState.streamedText) {
                    ctx.log?.debug?.(
                      `[langlangbot:${account.accountId}] outbound delta (final, ${text.length} chars) → ${inbound.conversationId}`,
                    );
                    await sidecar.sendDelta(inbound.conversationId, text);
                  }
                  ctx.log?.info?.(
                    `[langlangbot:${account.accountId}] outbound message (${text.length} chars) → ${inbound.conversationId}`,
                  );
                  await sidecar.sendMessage(inbound.conversationId, text);
                  streamState.sentFinal = true;
                },
                onIdle: async () => {
                  if (
                    account.streaming &&
                    streamState.streamedText &&
                    !streamState.sentFinal
                  ) {
                    ctx.log?.info?.(
                      `[langlangbot:${account.accountId}] outbound message onIdle (${streamState.streamedText.length} chars) → ${inbound.conversationId}`,
                    );
                    await sidecar.sendMessage(
                      inbound.conversationId,
                      streamState.streamedText,
                    );
                    streamState.sentFinal = true;
                  }
                },
                onError: (err: unknown, info: { kind?: string }) => {
                  ctx.log?.error?.(
                    `[langlangbot:${account.accountId}] outbound ${info.kind ?? "reply"} failed: ${
                      formatError(err)
                    }`,
                  );
                },
              },
            }),
        }),
      },
    });
    await reportAgentRuntimeStatus(sidecar, ctx, readiness);
  } catch (err) {
    const message = formatError(err);
    await reportAgentRuntimeStatus(sidecar, ctx, {
      ready: false,
      reason: message,
    });
    await sendOperatorVisibleStatus(
      sidecar,
      inbound.conversationId,
      `The agent runtime failed to process the message: ${message}`,
    );
    throw err;
  }
}

function runtimeReadiness(
  ctx: ChannelGatewayContext<LanglangbotAccount>,
): RuntimeReadiness {
  let runtime: unknown = ctx.channelRuntime;
  if (!runtime) {
    try {
      runtime = getLanglangbotRuntime().channel;
    } catch (err) {
      return { ready: false, reason: formatError(err) };
    }
  }
  return inspectRuntime(runtime);
}

function inspectRuntime(runtime: unknown): RuntimeReadiness {
  const candidate = runtime as Partial<AgentDispatchRuntime> | null | undefined;
  if (!candidate) {
    return { ready: false, reason: "agent runtime is unavailable" };
  }
  if (typeof candidate.turn?.run !== "function") {
    return {
      ready: false,
      reason: "agent runtime is not ready (turn.run unavailable)",
    };
  }
  if (typeof candidate.reply?.finalizeInboundContext !== "function") {
    return {
      ready: false,
      reason: "agent runtime reply interface is not ready (finalizeInboundContext unavailable)",
    };
  }
  if (typeof candidate.reply?.dispatchReplyWithBufferedBlockDispatcher !== "function") {
    return {
      ready: false,
      reason: "agent runtime reply interface is not ready (dispatcher unavailable)",
    };
  }
  if (typeof candidate.session?.resolveStorePath !== "function") {
    return {
      ready: false,
      reason: "agent runtime session interface is not ready (resolveStorePath unavailable)",
    };
  }
  return { ready: true, runtime: candidate as AgentDispatchRuntime };
}

async function reportAgentRuntimeStatus(
  sidecar: LanglangbotSidecar,
  ctx: ChannelGatewayContext<LanglangbotAccount>,
  readiness: RuntimeReadiness,
  connected = true,
): Promise<void> {
  try {
    await sidecar.updateAgentRuntimeStatus({
      connected,
      agentRuntimeReady: readiness.ready,
      runtimeName: AGENT_RUNTIME_NAME,
      accountId: ctx.account.accountId,
      reason: readiness.ready ? null : readiness.reason,
      lastDispatchError: readiness.ready ? null : readiness.reason,
    });
  } catch (err) {
    ctx.log?.warn?.(
      `[langlangbot:${ctx.account.accountId}] agent runtime status update failed: ${
        formatError(err)
      }`,
    );
  }
}

async function sendOperatorVisibleStatus(
  sidecar: LanglangbotSidecar,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await sidecar.sendMessage(conversationId, text);
  } catch {
    // The caller still logs the dispatch failure. Avoid hiding the original cause.
  }
}
