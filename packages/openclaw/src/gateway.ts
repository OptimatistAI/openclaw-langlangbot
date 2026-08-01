import type {
  ContentPart,
  LanglangbotSidecar,
} from "@optimatist/langlangbot-connector";
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
import {
  attachmentAvailablePart,
  attachmentFailedPart,
  attachmentReadyPart,
  formatInboundBody,
  formatTerminalAttachmentsText,
  pendingAttachmentParts,
  replaceAttachmentPart,
} from "./media.js";
import { buildLanglangbotSessionKey } from "./session-key.js";
import {
  resolveOpenclawSessionStorePath,
  setOpenclawSessionStoreConfig,
} from "./session-store.js";

type InboundHandle = {
  conversationId: string;
  messageId: string;
  text: string;
  /** Unacked inbound seqs (user_message + ready/failed); ack max after dispatch. */
  pendingAckSeqs: string[];
  parts: ContentPart[];
  ownerSurfaceId?: string;
};

function rememberAckSeq(handle: InboundHandle, seq?: string): void {
  const trimmed = seq?.trim();
  if (!trimmed || handle.pendingAckSeqs.includes(trimmed)) {
    return;
  }
  handle.pendingAckSeqs.push(trimmed);
}

/** Highest numeric seq for sidecar "ack up to cursor". */
function maxAckSeq(seqs: string[]): string | undefined {
  if (seqs.length === 0) {
    return undefined;
  }
  let best = seqs[0]!;
  let bestNum = Number(best);
  for (const seq of seqs.slice(1)) {
    const n = Number(seq);
    if (Number.isFinite(n) && (!Number.isFinite(bestNum) || n > bestNum)) {
      best = seq;
      bestNum = n;
    }
  }
  return best;
}

function chatTimingWall(): string {
  const d = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function logChatTiming(
  log: ChannelGatewayContext<LanglangbotAccount>["log"],
  opts: {
    phase: string;
    conversationId: string;
    messageId: string;
    assistantMessageId?: string | null;
    elapsedMs: number;
  },
): void {
  const assistant = (opts.assistantMessageId ?? "-").toLowerCase();
  log?.info?.(
    `[chat-timing] phase=${opts.phase} layer=plugin conversation=${opts.conversationId.toLowerCase()} message=${opts.messageId.toLowerCase()} assistant_message=${assistant} elapsed_ms=${opts.elapsedMs} wall=${chatTimingWall()}`,
  );
}

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
  const pendingAttachmentMessages = new Map<string, InboundHandle>();
  /** uploadId → message key, so ready/failed can find the pending message when multi-part. */
  const pendingByUploadId = new Map<string, string>();
  /** Dedup terminal upload events (reconnect replay). */
  const processedTerminalUploads = new Set<string>();
  /** Dedup the single batch agent turn per user message. */
  const dispatchedTerminalMessages = new Set<string>();
  const messageKey = (conversationId: string, messageId: string) =>
    `${conversationId}:${messageId}`;
  const uploadKey = (conversationId: string, uploadId: string) =>
    `${conversationId}:${uploadId}`;

  const resolvePendingKey = (
    conversationId: string,
    messageId: string | undefined,
    uploadId: string,
  ): string | undefined => {
    if (messageId) {
      const key = messageKey(conversationId, messageId);
      if (pendingAttachmentMessages.has(key)) {
        return key;
      }
    }
    return pendingByUploadId.get(uploadId);
  };

  const rememberPendingUploads = (key: string, parts: ContentPart[]) => {
    for (const part of parts) {
      if (part.type === "attachment" && part.upload_id) {
        pendingByUploadId.set(part.upload_id, key);
      }
    }
  };

  const clearPendingMessage = (key: string, pending: InboundHandle) => {
    pendingAttachmentMessages.delete(key);
    for (const part of pending.parts) {
      if (part.type === "attachment" && part.upload_id) {
        pendingByUploadId.delete(part.upload_id);
      }
    }
  };

  const ackInboundSeqs = (seqs: string[]) => {
    const cursor = maxAckSeq(seqs);
    if (!cursor) {
      return;
    }
    void sidecar
      .ackInbound({ cursor, accountId: account.accountId })
      .catch((err) => {
        ctx.log?.warn?.(
          `[langlangbot:${account.accountId}] inbound ack failed (seq=${cursor}): ${formatError(err)}`,
        );
      });
  };

  // One agent turn per message_id (OpenClaw MessageSid dedupe); wait for all parts.
  const maybeDispatchTerminalAttachments = (
    key: string,
    pending: InboundHandle,
  ): void => {
    if (pendingAttachmentParts(pending.parts)) {
      pendingAttachmentMessages.set(key, pending);
      return;
    }
    if (dispatchedTerminalMessages.has(key)) {
      clearPendingMessage(key, pending);
      ackInboundSeqs(pending.pendingAckSeqs);
      return;
    }
    dispatchedTerminalMessages.add(key);
    clearPendingMessage(key, pending);
    ctx.log?.info?.(
      `[langlangbot:${account.accountId}] dispatching inbound message ${pending.messageId} after all attachments reached a terminal state`,
    );
    void handleInbound(
      {
        conversationId: pending.conversationId,
        messageId: pending.messageId,
        text: formatTerminalAttachmentsText(pending.text, pending.parts),
        parts: pending.parts,
        pendingAckSeqs: pending.pendingAckSeqs,
        ownerSurfaceId: pending.ownerSurfaceId,
      },
      ctx,
      sidecar,
    ).catch(onInboundError);
  };

  const applyTerminalAttachment = (
    evt: {
      conversationId: string;
      messageId?: string;
      uploadId: string;
      seq?: string;
    },
    replacement: ContentPart,
  ): void => {
    const terminalKey = uploadKey(evt.conversationId, evt.uploadId);
    if (processedTerminalUploads.has(terminalKey)) {
      if (evt.seq) {
        ackInboundSeqs([evt.seq]);
      }
      return;
    }
    processedTerminalUploads.add(terminalKey);
    const key = resolvePendingKey(
      evt.conversationId,
      evt.messageId,
      evt.uploadId,
    );
    const pending = key ? pendingAttachmentMessages.get(key) : undefined;
    if (pending && key) {
      rememberAckSeq(pending, evt.seq);
      pending.parts = replaceAttachmentPart(
        pending.parts,
        evt.uploadId,
        replacement,
      );
      maybeDispatchTerminalAttachments(key, pending);
      return;
    }
    // Orphan terminal event (no delayed user_message handle): one-shot turn.
    const messageId = evt.messageId ?? evt.uploadId;
    const orphanKey = messageKey(evt.conversationId, messageId);
    if (dispatchedTerminalMessages.has(orphanKey)) {
      if (evt.seq) {
        ackInboundSeqs([evt.seq]);
      }
      return;
    }
    dispatchedTerminalMessages.add(orphanKey);
    const parts = [replacement];
    void handleInbound(
      {
        conversationId: evt.conversationId,
        messageId,
        text: formatTerminalAttachmentsText("", parts),
        parts,
        pendingAckSeqs: evt.seq ? [evt.seq] : [],
      },
      ctx,
      sidecar,
    ).catch(onInboundError);
  };

  const unsubscribe = sidecar.subscribeInbound(
    { accountId: account.accountId, agentSurfaceId: account.surfaceId },
    {
      onMessage: (evt) => {
        if (pendingAttachmentParts(evt.parts)) {
          const key = messageKey(evt.conversationId, evt.messageId);
          const handle: InboundHandle = {
            conversationId: evt.conversationId,
            messageId: evt.messageId,
            text: evt.text,
            parts: evt.parts,
            pendingAckSeqs: [],
            ownerSurfaceId: evt.ownerSurfaceId,
          };
          rememberAckSeq(handle, evt.seq);
          pendingAttachmentMessages.set(key, handle);
          rememberPendingUploads(key, evt.parts);
          ctx.log?.info?.(
            `[langlangbot:${account.accountId}] delaying inbound message ${evt.messageId} until attachments reach a terminal state`,
          );
          return;
        }
        void handleInbound(
          {
            conversationId: evt.conversationId,
            messageId: evt.messageId,
            text: evt.text,
            parts: evt.parts,
            pendingAckSeqs: evt.seq ? [evt.seq] : [],
            ownerSurfaceId: evt.ownerSurfaceId,
          },
          ctx,
          sidecar,
        ).catch(onInboundError);
      },
      onAttachmentAvailable: (evt) => {
        const key = resolvePendingKey(
          evt.conversationId,
          evt.messageId,
          evt.uploadId,
        );
        const pending = key ? pendingAttachmentMessages.get(key) : undefined;
        if (pending && key) {
          pending.parts = replaceAttachmentPart(
            pending.parts,
            evt.uploadId,
            attachmentAvailablePart(evt),
          );
          pendingAttachmentMessages.set(key, pending);
        }
        if (evt.seq) {
          ackInboundSeqs([evt.seq]);
        }
      },
      onAttachmentReady: (evt) => {
        applyTerminalAttachment(evt, attachmentReadyPart(evt));
      },
      onAttachmentFailed: (evt) => {
        applyTerminalAttachment(evt, attachmentFailedPart(evt));
      },
    },
    (err) => {
      ctx.log?.warn?.(
        `[langlangbot:${account.accountId}] inbound SSE error: ${err.message}`,
      );
    },
  );

  function onInboundError(err: unknown): void {
    void reportAgentRuntimeStatus(sidecar, ctx, {
      ready: false,
      reason: formatError(err),
    });
    ctx.log?.error?.(
      `[langlangbot:${account.accountId}] inbound dispatch failed: ${
        formatError(err)
      }`,
    );
  }

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
  const turnTiming = {
    t0: performance.now(),
    firstOutboundLogged: false,
  };
  const timingElapsedMs = () => Math.round(performance.now() - turnTiming.t0);
  const markOutboundFirst = (assistantMessageId?: string | null) => {
    if (turnTiming.firstOutboundLogged) {
      return;
    }
    turnTiming.firstOutboundLogged = true;
    logChatTiming(ctx.log, {
      phase: "plugin_outbound_first",
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      assistantMessageId,
      elapsedMs: timingElapsedMs(),
    });
  };
  const markOutboundFinal = (assistantMessageId?: string | null) => {
    logChatTiming(ctx.log, {
      phase: "plugin_outbound_final",
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      assistantMessageId,
      elapsedMs: timingElapsedMs(),
    });
  };

  logChatTiming(ctx.log, {
    phase: "plugin_inbound",
    conversationId: inbound.conversationId,
    messageId: inbound.messageId,
    elapsedMs: 0,
  });

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
    const body = formatInboundBody({
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      text: inbound.text,
      parts: inbound.parts,
      receivedAt: new Date().toISOString(),
      ownerSurfaceId: inbound.ownerSurfaceId,
    });
    const ctxPayload = runtime.reply.finalizeInboundContext({
      Body: body,
      RawBody: body,
      BodyForAgent: body,
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

    logChatTiming(ctx.log, {
      phase: "plugin_dispatch",
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      elapsedMs: timingElapsedMs(),
    });

    await runtime.turn.run({
      channel: "langlangbot",
      accountId: account.accountId,
      raw: inbound,
      adapter: {
        ingest: () => ({
          id: inbound.messageId,
          rawText: body,
          textForAgent: body,
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
                    markOutboundFirst(null);
                    await sidecar.sendDelta(inbound.conversationId, text);
                    return;
                  }
                  // OpenClaw often emits only a final payload (no block chunks). The Operator
                  // app may expect assistant_delta frames when streaming is enabled.
                  if (account.streaming && !streamState.streamedText) {
                    ctx.log?.debug?.(
                      `[langlangbot:${account.accountId}] outbound delta (final, ${text.length} chars) → ${inbound.conversationId}`,
                    );
                    markOutboundFirst(null);
                    await sidecar.sendDelta(inbound.conversationId, text);
                  }
                  ctx.log?.info?.(
                    `[langlangbot:${account.accountId}] outbound message (${text.length} chars) → ${inbound.conversationId}`,
                  );
                  const sent = await sidecar.sendMessage(inbound.conversationId, text);
                  streamState.sentFinal = true;
                  markOutboundFirst(sent.message_id);
                  markOutboundFinal(sent.message_id);
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
                    const sent = await sidecar.sendMessage(
                      inbound.conversationId,
                      streamState.streamedText,
                    );
                    streamState.sentFinal = true;
                    markOutboundFirst(sent.message_id);
                    markOutboundFinal(sent.message_id);
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
    const ackCursor = maxAckSeq(inbound.pendingAckSeqs);
    if (ackCursor) {
      try {
        await sidecar.ackInbound({
          cursor: ackCursor,
          accountId: account.accountId,
        });
      } catch (err) {
        ctx.log?.warn?.(
          `[langlangbot:${account.accountId}] inbound ack failed (seq=${ackCursor}): ${
            formatError(err)
          }`,
        );
      }
    }
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
