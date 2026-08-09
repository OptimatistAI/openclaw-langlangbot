import type {
  AgentTurnPhase,
  ContentPart,
  LanglangbotSidecar,
} from "@optimatist/langlangbot-connector";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/index";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";

import {
  runtimeNotReadyUserMessage,
  runtimeReadiness,
  type RuntimeReadiness,
} from "./channel-dispatch-runtime.js";
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
import { sendOutboundFiles } from "./outbound-media.js";
import { buildLanglangbotSessionKey } from "./session-key.js";
import {
  setOpenclawSessionStoreConfig,
  getOpenclawSessionStoreConfig,
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

const AGENT_RUNTIME_NAME = "OpenClaw";

/**
 * OpenClaw 6.10's buffered dispatcher installs a per-conversation foreground
 * reply fence. Overlapping inbound.run turns on the same conversation can
 * deadlock that fence (agent finishes + pendingFinalDelivery is set, but
 * deliver()/sendDelta never run). Serialize agent turns per conversation.
 */
function createConversationInboundQueue() {
  const tails = new Map<string, Promise<void>>();
  return (conversationId: string, task: () => Promise<void>): Promise<void> => {
    const prev = tails.get(conversationId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    tails.set(conversationId, settled);
    void settled.finally(() => {
      if (tails.get(conversationId) === settled) {
        tails.delete(conversationId);
      }
    });
    return next;
  };
}

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
  const enqueueInbound = createConversationInboundQueue();
  const messageKey = (conversationId: string, messageId: string) =>
    `${conversationId}:${messageId}`;
  const uploadKey = (conversationId: string, uploadId: string) =>
    `${conversationId}:${uploadId}`;
  const dispatchInbound = (inbound: InboundHandle): void => {
    void enqueueInbound(inbound.conversationId, () =>
      handleInbound(inbound, ctx, sidecar),
    ).catch(onInboundError);
  };

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
    dispatchInbound({
      conversationId: pending.conversationId,
      messageId: pending.messageId,
      text: formatTerminalAttachmentsText(pending.text, pending.parts),
      parts: pending.parts,
      pendingAckSeqs: pending.pendingAckSeqs,
      ownerSurfaceId: pending.ownerSurfaceId,
    });
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
    dispatchInbound({
      conversationId: evt.conversationId,
      messageId,
      text: formatTerminalAttachmentsText("", parts),
      parts,
      pendingAckSeqs: evt.seq ? [evt.seq] : [],
    });
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
        dispatchInbound({
          conversationId: evt.conversationId,
          messageId: evt.messageId,
          text: evt.text,
          parts: evt.parts,
          pendingAckSeqs: evt.seq ? [evt.seq] : [],
          ownerSurfaceId: evt.ownerSurfaceId,
        });
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
  const account = ctx.account;
  const turnTiming = {
    t0: performance.now(),
    firstOutboundLogged: false,
  };
  const timingElapsedMs = () => Math.round(performance.now() - turnTiming.t0);
  // Once failed, ignore a later onIdle so durable failed is not overwritten.
  let turnFailed = false;
  const reportPhase = (
    phase: AgentTurnPhase,
    detail?: string,
  ): void => {
    // Defensive: older bundled connectors omit reportTurnPhase; a sync TypeError
    // would bypass Promise.catch and crash the OpenClaw gateway process.
    if (typeof sidecar.reportTurnPhase !== "function") {
      ctx.log?.warn?.(
        `[langlangbot:${account.accountId}] reportTurnPhase unavailable; skip ${phase}`,
      );
      return;
    }
    if (phase === "failed") {
      turnFailed = true;
    } else if (phase === "idle" && turnFailed) {
      return;
    }
    void sidecar
      .reportTurnPhase(
        inbound.conversationId,
        inbound.messageId,
        phase,
        detail,
      )
      .catch((err: unknown) => {
        ctx.log?.debug?.(
          `[langlangbot:${account.accountId}] reportTurnPhase ${phase} failed: ${
            formatError(err)
          }`,
        );
      });
  };
  const markOutboundFirst = (assistantMessageId?: string | null) => {
    if (turnTiming.firstOutboundLogged) {
      return;
    }
    turnTiming.firstOutboundLogged = true;
    // Bound to this inbound message_id (not sidecar chat_timing).
    reportPhase("streaming");
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
    reportPhase("failed", readiness.reason);
    await sendOperatorVisibleStatus(
      sidecar,
      inbound.conversationId,
      runtimeNotReadyUserMessage(readiness.reason),
    );
    return;
  }
  const { runtime, runInbound } = readiness;
  const cfg = ctx.cfg;
  let lastThinkingMs = 0;
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
    agentId: account.agentId,
  });

  try {
    const storePath = runtime.session.resolveStorePath(getOpenclawSessionStoreConfig(), {
      agentId: account.agentId,
    });
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
    const streamState = {
      streamedText: "",
      sentFinal: false,
      reportedIdle: false,
      pendingMedia: [] as string[],
      sentMedia: new Set<string>(),
    };

    // OpenClaw strips `MEDIA:` directives / markdown images out of the reply
    // text and hands the paths back on the payload. Without this the attachment
    // is silently dropped and only the caption reaches Operator.
    const collectMedia = (payload: ReplyPayload): void => {
      const candidates = [
        ...(payload.mediaUrls ?? []),
        ...(payload.mediaUrl ? [payload.mediaUrl] : []),
      ];
      for (const candidate of candidates) {
        const localPath = candidate?.trim();
        if (!localPath || streamState.sentMedia.has(localPath)) {
          continue;
        }
        if (!streamState.pendingMedia.includes(localPath)) {
          streamState.pendingMedia.push(localPath);
        }
      }
    };

    /**
     * Delivers every pending attachment in one message, with `caption` as the
     * body. Returns null when there was nothing to send, in which case the
     * caller still owns the caption; otherwise the caption has been delivered
     * here (`messageId` is null only if that send itself failed).
     */
    const flushMedia = async (
      caption?: string,
    ): Promise<{ messageId: string | null } | null> => {
      const files: string[] = [];
      while (streamState.pendingMedia.length > 0) {
        const localPath = streamState.pendingMedia.shift();
        if (!localPath) {
          continue;
        }
        streamState.sentMedia.add(localPath);
        if (/^[a-z][a-z0-9+.-]*:\/\//i.test(localPath)) {
          ctx.log?.warn?.(
            `[langlangbot:${account.accountId}] skip remote media ${localPath}; only local paths under the media root can be sent`,
          );
          continue;
        }
        files.push(localPath);
      }
      if (files.length === 0) {
        return null;
      }
      try {
        const sent = await sendOutboundFiles(
          sidecar,
          inbound.conversationId,
          account.accountId,
          files,
          caption,
        );
        ctx.log?.info?.(
          `[langlangbot:${account.accountId}] outbound attachments ${
            sent.files.map((file) => file.filename).join(", ")
          } → ${inbound.conversationId}`,
        );
        return { messageId: sent.messageId };
      } catch (err) {
        const reason = formatError(err);
        const names = files.map((file) => file.split("/").pop() ?? file).join(", ");
        ctx.log?.error?.(
          `[langlangbot:${account.accountId}] outbound attachments ${names} failed: ${reason}`,
        );
        // Surface the failure; a silent drop looks like the agent ignored the
        // request. The sidecar rejects anything outside the media root. The
        // caption rides along so the explanation is not lost with the file.
        const notice = `Failed to send attachment ${names}: ${reason}`;
        const sent = await sidecar
          .sendMessage(
            inbound.conversationId,
            caption ? `${caption}\n\n${notice}` : notice,
          )
          .catch(() => undefined);
        return { messageId: sent?.message_id ?? null };
      }
    };

    logChatTiming(ctx.log, {
      phase: "plugin_dispatch",
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      elapsedMs: timingElapsedMs(),
    });
    // Emit before awaiting the model. onReplyStart is often late/missing on
    // no-tool turns, which left Operator with ~tens of seconds of blank wait.
    reportPhase("working");

    await runInbound({
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
              typingCallbacks: {
                // Idempotent refresh if the runtime signals reply start later.
                onReplyStart: async () => {
                  reportPhase("working");
                },
              },
              replyOptions: {
                // OpenClaw 6.10+/latest gates onToolStart behind tool-summary
                // visibility; Operator still needs agent_turn tool phases.
                allowToolLifecycleWhenProgressHidden: true,
                onToolStart: async (payload: {
                  name?: string;
                  toolName?: string;
                  tool_name?: string;
                }) => {
                  const name =
                    payload?.name ??
                    payload?.toolName ??
                    payload?.tool_name ??
                    "tool";
                  ctx.log?.info?.(
                    `[langlangbot:${account.accountId}] agent_turn tool=${name} → ${inbound.conversationId}`,
                  );
                  reportPhase("tool", String(name));
                },
                onReasoningStream: async () => {
                  const now = Date.now();
                  if (now - lastThinkingMs < 1000) {
                    return;
                  }
                  lastThinkingMs = now;
                  reportPhase("thinking");
                },
              },
              dispatcherOptions: {
                deliver: async (payload: ReplyPayload, info: { kind?: string }) => {
                  collectMedia(payload);
                  const text = (payload.text ?? "").trim();
                  const kind = info.kind ?? "final";
                  if (!text) {
                    if (kind !== "block") {
                      // A streaming turn delivers its text as deltas and can
                      // then hand us a final payload that is media-only. The
                      // deltas are not an assistant_message, so that text still
                      // has to ride along as the caption here -- otherwise
                      // onIdle sends it afterwards as its own bubble, next to
                      // the media card this branch exists to keep it with.
                      const pending = streamState.sentFinal
                        ? ""
                        : streamState.streamedText;
                      const flushed = await flushMedia(pending || undefined);
                      if (flushed) {
                        // Only now: a failed flush must leave onIdle free to
                        // deliver the text on its own.
                        streamState.sentFinal = true;
                        markOutboundFirst(flushed.messageId);
                        markOutboundFinal(flushed.messageId);
                      }
                    }
                    return;
                  }
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
                  // Claim the send before awaiting: onIdle can fire concurrently,
                  // which duplicated the final bubble.
                  streamState.sentFinal = true;
                  // When the turn produced attachments, the text is the caption
                  // of that same message: one bubble carrying the explanation
                  // and the media card together.
                  const flushed = await flushMedia(text);
                  if (flushed) {
                    markOutboundFirst(flushed.messageId);
                    markOutboundFinal(flushed.messageId);
                    return;
                  }
                  const sent = await sidecar.sendMessage(inbound.conversationId, text);
                  markOutboundFirst(sent.message_id);
                  markOutboundFinal(sent.message_id);
                },
                onIdle: async () => {
                  if (
                    account.streaming &&
                    streamState.streamedText &&
                    !streamState.sentFinal
                  ) {
                    // Claim the send before awaiting: onIdle can fire twice
                    // concurrently, which duplicated the final bubble.
                    streamState.sentFinal = true;
                    ctx.log?.info?.(
                      `[langlangbot:${account.accountId}] outbound message onIdle (${streamState.streamedText.length} chars) → ${inbound.conversationId}`,
                    );
                    const flushed = await flushMedia(streamState.streamedText);
                    if (flushed) {
                      markOutboundFirst(flushed.messageId);
                      markOutboundFinal(flushed.messageId);
                    } else {
                      const sent = await sidecar.sendMessage(
                        inbound.conversationId,
                        streamState.streamedText,
                      );
                      markOutboundFirst(sent.message_id);
                      markOutboundFinal(sent.message_id);
                    }
                  } else {
                    // Media-only turn, or attachments that arrived after the
                    // final text was already delivered. Still an outbound
                    // message, so it belongs on the turn's timing line.
                    const flushed = await flushMedia();
                    if (flushed) {
                      markOutboundFirst(flushed.messageId);
                      markOutboundFinal(flushed.messageId);
                    }
                  }
                  if (streamState.reportedIdle) {
                    return;
                  }
                  streamState.reportedIdle = true;
                  // Turn end for this inbound message (including NO_REPLY).
                  reportPhase("idle");
                },
                onError: (err: unknown, info: { kind?: string }) => {
                  ctx.log?.error?.(
                    `[langlangbot:${account.accountId}] outbound ${info.kind ?? "reply"} failed: ${
                      formatError(err)
                    }`,
                  );
                  reportPhase("failed", formatError(err));
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
    reportPhase("failed", message);
    await sendOperatorVisibleStatus(
      sidecar,
      inbound.conversationId,
      `The agent runtime failed to process the message: ${message}`,
    );
    throw err;
  }
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
