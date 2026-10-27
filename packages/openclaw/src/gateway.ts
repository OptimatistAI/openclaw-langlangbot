import {
  isRuntimeMismatch,
  type AgentTurnPhase,
  type ContentPart,
  type HealthStatus,
  type LanglangbotSidecar,
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
import { shouldEngageSidecar } from "./pairing-gate.js";
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
import {
  AGENT_RUNTIME_KIND,
  AGENT_RUNTIME_NAME,
  adapterVersion,
  hostVersion,
} from "./runtime-identity.js";
import {
  createSingleFlight,
  createTurnLane,
  finalizeIdleTurn,
  isAgentTurnTerminalError,
  shouldReportTurnPhase,
  shouldStartAcceptedTurn,
  type TurnPhaseSnapshot,
} from "./turn-control.js";
import { buildLanglangbotSessionKey } from "./session-key.js";
import {
  appendStreamedBlock,
  blockSeparator,
  isMarkdownSafeTail,
} from "./stream-text.js";

/**
 * Stop holding a half-written delta once it grows past this: a long fenced
 * block or table should still stream instead of appearing all at once.
 */
const DELTA_HOLD_MAX_CHARS = 600;
import {
  AUTO_HISTORY_MAX_AGE_MS,
  AUTO_HISTORY_MESSAGE_LIMIT,
  planSessionHistoryRestore,
  sessionFileNeedsRestore,
} from "./session-hydrate.js";
import {
  setOpenclawSessionStoreConfig,
  getOpenclawSessionStoreConfig,
  loadOpenclawSessionEntry,
} from "./session-store.js";

type InboundHandle = {
  conversationId: string;
  messageId: string;
  text: string;
  /** Seqs deleted by the durable `/v1/inbound/accept` claim. */
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

/** Cheap timeout-protected /health probe so a hung sidecar can't stall start. */
async function probeSidecarHealth(
  account: LanglangbotAccount,
  timeoutMs = 3_000,
): Promise<HealthStatus> {
  const sidecar = createLanglangbotSidecar(account);
  const probe = sidecar.health();
  // Race the probe against a timer so a sidecar that accepts the connection
  // but never answers cannot stall channel start (Node <18 compat: manual
  // timer instead of AbortSignal.timeout).
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`health probe timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
  return Promise.race([probe, timeout]);
}

type PairingGateDecision = { engage: true } | { engage: false; reason: string };

/** Probe /health and decide engagement; unreachable sidecars keep legacy. */
async function probePairingGate(
  ctx: ChannelGatewayContext<LanglangbotAccount>,
  probe = createLanglangbotSidecar(ctx.account),
): Promise<PairingGateDecision> {
  try {
    const health = await probe.health();
    return shouldEngageSidecar(
      health.paired_runtime_kind,
      AGENT_RUNTIME_KIND,
    );
  } catch (err) {
    ctx.log?.debug?.(
      `[langlangbot:${ctx.account.accountId}] pairing probe unreachable; continuing (${formatError(err)})`,
    );
    return { engage: true };
  }
}

/**
 * Hold the gateway in the idle state: set status, log once, then either
 * self-heal (periodic re-probe flips back to engage after a re-pair) or wait
 * for abort. `selfHeal` polls /health every 45s; a single timer, cleared on
 * abort, never leaks.
 */
async function idleUntilRepairedOrAbort(
  ctx: ChannelGatewayContext<LanglangbotAccount>,
  reason?: string,
  opts: { selfHeal?: boolean } = {},
): Promise<void> {
  const account = ctx.account;
  const message = reason ?? "sidecar paired with another runtime";
  ctx.log?.warn?.(`[langlangbot:${account.accountId}] ${message}`);
  ctx.setStatus({
    ...ctx.getStatus(),
    running: false,
    connected: false,
    lastError: message,
  });
  // Hold the promise until the gateway is asked to stop (or, with selfHeal,
  // until a re-probe says the sidecar now belongs to us), like a normal
  // started-but-idle account, so the plugin host does not restart-loop us.
  await new Promise<void>((resolve) => {
    let selfHealTimer: ReturnType<typeof setInterval> | undefined;
    const onAbort = () => {
      if (selfHealTimer) {
        clearInterval(selfHealTimer);
      }
      resolve();
    };
    if (opts.selfHeal) {
      // Cheap periodic re-probe: a later re-pair must wake the idle channel
      // (the abort signal alone never fires on a re-pair).
      selfHealTimer = setInterval(() => {
        void probePairingGate(ctx).then((decision) => {
          if (decision.engage) {
            if (selfHealTimer) {
              clearInterval(selfHealTimer);
              selfHealTimer = undefined;
            }
            ctx.log?.info?.(
              `[langlangbot:${account.accountId}] sidecar re-paired to ${AGENT_RUNTIME_KIND}; resuming gateway`,
            );
            ctx.abortSignal.removeEventListener("abort", onAbort);
            resolve();
          }
        });
      }, 45_000);
      if (typeof selfHealTimer.unref === "function") {
        selfHealTimer.unref();
      }
    }
    if (ctx.abortSignal.aborted) {
      onAbort();
      return;
    }
    ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function startLanglangbotGateway(
  ctx: ChannelGatewayContext<LanglangbotAccount>,
): Promise<void> {
  const account = ctx.account;

  // Pairing-time exclusivity: a sidecar paired with another runtime keeps its
  // inbound stream; this channel idles instead of stealing it. One cheap
  // health probe decides; unreachable sidecars keep the legacy behavior.
  const pairingGate = await probePairingGate(ctx);
  if (!pairingGate.engage) {
    await idleUntilRepairedOrAbort(ctx, pairingGate.reason);
    return;
  }

  const { startedByPlugin } = await ensureLanglangbotSidecar(account, ctx.log);
  // Cold-start fix: ensureLanglangbotSidecar may have just spawned the sidecar;
  // its paired kind is only knowable now. Re-probe once and idle when the
  // (possibly freshly started) sidecar is paired with another runtime.
  let postStartHealth: HealthStatus | undefined;
  try {
    postStartHealth = await probeSidecarHealth(account);
  } catch (err) {
    ctx.log?.debug?.(
      `[langlangbot:${account.accountId}] post-start pairing probe failed; continuing (${formatError(err)})`,
    );
  }
  if (postStartHealth) {
    const postStartGate = shouldEngageSidecar(
      postStartHealth.paired_runtime_kind,
      AGENT_RUNTIME_KIND,
    );
    if (!postStartGate.engage) {
      await idleUntilRepairedOrAbort(ctx, postStartGate.reason, {
        selfHeal: true,
      });
      return;
    }
  }

  const sidecar = createLanglangbotSidecar(account);
  // The sidecar replaces the whole status record on every PUT, so keep the
  // last dispatch failure here until a turn succeeds; otherwise an unrelated
  // SSE reconnect would erase it without any successful turn.
  const dispatchState: { lastError: string | null } = { lastError: null };

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
  /** Last phase posted per conversation message. Survives a re-entered turn. */
  const reportedTurnPhases = new Map<string, TurnPhaseSnapshot>();
  const enqueueInbound = createConversationInboundQueue();
  const messageKey = (conversationId: string, messageId: string) =>
    `${conversationId}:${messageId}`;
  const uploadKey = (conversationId: string, uploadId: string) =>
    `${conversationId}:${uploadId}`;
  const dropReplaySeqs = (inbound: {
    conversationId: string;
    messageId: string;
    pendingAckSeqs: string[];
  }) => {
    if (!inbound.messageId || inbound.pendingAckSeqs.length === 0) {
      return;
    }
    void enqueueInbound(inbound.conversationId, async () => {
      await sidecar.acceptInbound({
        conversationId: inbound.conversationId,
        messageId: inbound.messageId,
        seqs: inbound.pendingAckSeqs,
        accountId: account.accountId,
      });
    }).catch((err) => {
      ctx.log?.warn?.(
        `[langlangbot:${account.accountId}] inbound accept failed for ${inbound.messageId}: ${formatError(err)}`,
      );
    });
  };

  const dispatchInbound = (inbound: InboundHandle): void => {
    const key = messageKey(inbound.conversationId, inbound.messageId);
    if (dispatchedTerminalMessages.has(key)) {
      dropReplaySeqs(inbound);
      return;
    }
    dispatchedTerminalMessages.add(key);
    void enqueueInbound(inbound.conversationId, async () => {
      // Accept is the only inbound claim. On any accept failure (including a
      // 404 from a sidecar without the endpoint) fail closed: do not dispatch;
      // the message stays queued and replays on reconnect.
      let claim;
      try {
        claim = await sidecar.acceptInbound({
          conversationId: inbound.conversationId,
          messageId: inbound.messageId,
          seqs: inbound.pendingAckSeqs,
          accountId: account.accountId,
        });
      } catch (err) {
        dispatchedTerminalMessages.delete(key);
        ctx.log?.warn?.(
          `[langlangbot:${account.accountId}] inbound accept failed for ${inbound.messageId}: ${formatError(err)}`,
        );
        return;
      }
      if (!shouldStartAcceptedTurn(claim)) {
        ctx.log?.info?.(
          `[langlangbot:${account.accountId}] skip duplicate inbound ${inbound.messageId}`,
        );
        return;
      }
      await handleInbound(
        inbound,
        ctx,
        sidecar,
        reportedTurnPhases,
        messageKey(inbound.conversationId, inbound.messageId),
        dispatchState,
      );
    }).catch((err) => {
      dispatchedTerminalMessages.delete(key);
      onInboundError(err);
    });
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

  // One agent turn per message_id (OpenClaw MessageSid dedupe); wait for all parts.
  const maybeDispatchTerminalAttachments = (
    key: string,
    pending: InboundHandle,
  ): void => {
    if (pendingAttachmentParts(pending.parts)) {
      pendingAttachmentMessages.set(key, pending);
      return;
    }
    clearPendingMessage(key, pending);
    if (dispatchedTerminalMessages.has(key)) {
      dropReplaySeqs(pending);
      return;
    }
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
      const messageId = evt.messageId;
      if (
        messageId &&
        evt.seq &&
        dispatchedTerminalMessages.has(messageKey(evt.conversationId, messageId))
      ) {
        dropReplaySeqs({
          conversationId: evt.conversationId,
          messageId,
          pendingAckSeqs: [evt.seq],
        });
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
        dropReplaySeqs({
          conversationId: evt.conversationId,
          messageId,
          pendingAckSeqs: [evt.seq],
        });
      }
      return;
    }
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
      // The sidecar keeps runtime status in process memory. startChannelGateway
      // reports it once, but a sidecar restart (upgrade, crash recovery) only
      // reconnects this SSE loop, so re-report here or Operator keeps showing
      // the runtime as offline while chat works.
      onReconnect: () => {
        reportRuntimeStatusAfterReconnect();
      },
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
          if (pending) {
            rememberAckSeq(pending, evt.seq);
          } else if (
            evt.messageId &&
            dispatchedTerminalMessages.has(
              messageKey(evt.conversationId, evt.messageId),
            )
          ) {
            dropReplaySeqs({
              conversationId: evt.conversationId,
              messageId: evt.messageId,
              pendingAckSeqs: [evt.seq],
            });
          }
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
      if (isRuntimeMismatch(err)) {
        // Re-paired under us: the sidecar 409s every subscription. Stop this
        // subscription's reconnect loop cleanly and flip the channel into the
        // idle state with the re-pair hint (the idle wait's self-heal probe
        // resumes the gateway after a matching re-pair).
        unsubscribe();
        unsubscribeManagement();
        void idleUntilRepairedOrAbort(
          ctx,
          `sidecar re-paired with ${err.pairedRuntime}; the openclaw channel stopped its subscription (${err.message})`,
          { selfHeal: true },
        ).then(() => {
          // Reached only on abort; run the same teardown as a normal stop.
          releaseLanglangbotSidecar(account, ctx.log);
          ctx.setStatus({
            ...ctx.getStatus(),
            running: false,
            connected: false,
          });
        });
        return;
      }
      ctx.log?.warn?.(
        `[langlangbot:${account.accountId}] inbound SSE error: ${err.message}`,
      );
    },
  );

  function onInboundError(err: unknown): void {
    dispatchState.lastError = formatError(err);
    void reportAgentRuntimeStatus(sidecar, ctx, {
      ready: false,
      reason: dispatchState.lastError,
    });
    ctx.log?.error?.(
      `[langlangbot:${account.accountId}] inbound dispatch failed: ${
        formatError(err)
      }`,
    );
  }

  function reportRuntimeStatusAfterReconnect(): void {
    void (async () => {
      // The reconnect can beat the sidecar's readiness. Retry once so a
      // transient PUT failure does not leave Operator offline until the next
      // inbound turn.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (ctx.abortSignal.aborted) {
          return;
        }
        const readiness = runtimeReadiness(ctx);
        const reported = await reportAgentRuntimeStatus(
          sidecar,
          ctx,
          readiness,
          true,
          readiness.ready ? dispatchState.lastError : readiness.reason,
        );
        if (reported) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    })();
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

/**
 * When the OpenClaw session for this conversation has no user/assistant turns,
 * prepend sidecar history to the inbound text. A missing file or a failed
 * transcript read leaves the original text in place.
 */
async function restoreEmptySessionHistory(params: {
  sessionKey: string;
  conversationId: string;
  messageId: string;
  text: string;
  sidecar: LanglangbotSidecar;
  accountId: string;
  log: ChannelGatewayContext<LanglangbotAccount>["log"];
}): Promise<{ text: string; restoredTurns: number }> {
  const unchanged = { text: params.text, restoredTurns: 0 };
  if (params.text.trimStart().startsWith("/")) {
    return unchanged;
  }
  const skip = (err: unknown) => {
    params.log?.warn?.(
      `[langlangbot:${params.accountId}] session history restore skipped: ${formatError(err)}`,
    );
    return unchanged;
  };
  let messages;
  try {
    const entry = await loadOpenclawSessionEntry<{ sessionFile?: unknown }>(params.sessionKey);
    const sessionFile = typeof entry?.sessionFile === "string" ? entry.sessionFile : "";
    if (sessionFile && !(await sessionFileNeedsRestore(sessionFile))) {
      return unchanged;
    }
    messages = (
      await params.sidecar.listConversationTranscript(params.conversationId, {
        limit: AUTO_HISTORY_MESSAGE_LIMIT,
        maxAgeHours: AUTO_HISTORY_MAX_AGE_MS / 3_600_000,
      })
    ).messages;
  } catch (err) {
    return skip(err);
  }
  const planned = planSessionHistoryRestore({
    turns: messages,
    currentMessageId: params.messageId,
    currentText: params.text,
  });
  if (planned.restoredTurns > 0) {
    params.log?.info?.(
      `[langlangbot:${params.accountId}] restored ${planned.restoredTurns} transcript turns into empty session ${params.sessionKey}`,
    );
  }
  return planned;
}

async function handleInbound(
  inbound: InboundHandle,
  ctx: ChannelGatewayContext<LanglangbotAccount>,
  sidecar: LanglangbotSidecar,
  reportedTurnPhases: Map<string, TurnPhaseSnapshot>,
  phaseKey: string,
  dispatchState: { lastError: string | null },
): Promise<void> {
  const account = ctx.account;
  const turnTiming = {
    t0: performance.now(),
    firstOutboundLogged: false,
  };
  const timingElapsedMs = () => Math.round(performance.now() - turnTiming.t0);
  const commitTurnPhase = (
    phase: AgentTurnPhase,
    detail?: string,
  ): boolean => {
    const next = { phase, detail };
    if (!shouldReportTurnPhase(reportedTurnPhases.get(phaseKey), next)) {
      return false;
    }
    reportedTurnPhases.set(phaseKey, next);
    return true;
  };
  const restoreCommittedPhase = (
    phase: AgentTurnPhase,
    previous: TurnPhaseSnapshot | undefined,
  ) => {
    const current = reportedTurnPhases.get(phaseKey);
    if (current?.phase !== phase) {
      return;
    }
    if (previous) {
      reportedTurnPhases.set(phaseKey, previous);
    } else {
      reportedTurnPhases.delete(phaseKey);
    }
  };
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
    const previous = reportedTurnPhases.get(phaseKey);
    if (!commitTurnPhase(phase, detail)) {
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
        if (!isAgentTurnTerminalError(err)) {
          restoreCommittedPhase(phase, previous);
        }
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
    dispatchState.lastError = readiness.reason;
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
    const restored = await restoreEmptySessionHistory({
      sessionKey,
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      text: inbound.text,
      sidecar,
      log: ctx.log,
      accountId: account.accountId,
    });
    const body = formatInboundBody({
      conversationId: inbound.conversationId,
      messageId: inbound.messageId,
      text: restored.text,
      parts: inbound.parts,
      receivedAt: new Date().toISOString(),
      ownerSurfaceId: inbound.ownerSurfaceId,
    });
    const ctxPayload = runtime.reply.finalizeInboundContext({
      Body: body,
      RawBody: body,
      BodyForAgent: body,
      // OpenClaw stores CommandBody in the session transcript. When we restored
      // history, keep that block in the stored user turn so the next message
      // still sees it. Slash commands skip restore and stay on the raw text.
      CommandBody: restored.restoredTurns > 0 ? body : inbound.text,
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
      // Text already accepted from OpenClaw but not yet shown to the client:
      // holding it back keeps a table, list or fenced block from rendering
      // half-written while the rest of it is still on the way.
      pendingDelta: "",
      sentFinal: false,
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
          runDispatch: () => {
            const lane = createTurnLane();
            const finalizeIdle = createSingleFlight(() =>
              lane(() =>
                finalizeIdleTurn({
                  sendFinal: async () => {
                    if (streamState.pendingDelta) {
                      const chunk = streamState.pendingDelta;
                      streamState.pendingDelta = "";
                      ctx.log?.debug?.(
                        `[langlangbot:${account.accountId}] outbound delta (final, ${chunk.length} chars) → ${inbound.conversationId}`,
                      );
                      markOutboundFirst(null);
                      await sidecar
                        .sendDelta(inbound.conversationId, chunk)
                        .catch(() => undefined);
                    }
                    if (
                      account.streaming &&
                      streamState.streamedText &&
                      !streamState.sentFinal
                    ) {
                      streamState.sentFinal = true;
                      ctx.log?.info?.(
                        `[langlangbot:${account.accountId}] outbound message onIdle (${streamState.streamedText.length} chars) → ${inbound.conversationId}`,
                      );
                      const flushed = await flushMedia(streamState.streamedText);
                      if (flushed) {
                        markOutboundFirst(flushed.messageId);
                        markOutboundFinal(flushed.messageId);
                        return;
                      }
                      const sent = await sidecar.sendMessage(
                        inbound.conversationId,
                        streamState.streamedText,
                      );
                      markOutboundFirst(sent.message_id);
                      markOutboundFinal(sent.message_id);
                      return;
                    }
                    const flushed = await flushMedia();
                    if (flushed) {
                      markOutboundFirst(flushed.messageId);
                      markOutboundFinal(flushed.messageId);
                    }
                  },
                  reportIdle: async () => {
                    if (typeof sidecar.reportTurnPhase !== "function") {
                      reportPhase("idle");
                      return;
                    }
                    const previous = reportedTurnPhases.get(phaseKey);
                    if (!commitTurnPhase("idle")) {
                      return;
                    }
                    try {
                      await sidecar.reportTurnPhase(
                        inbound.conversationId,
                        inbound.messageId,
                        "idle",
                      );
                    } catch (err) {
                      // 409 means the sidecar already closed the turn. Any other
                      // failure leaves the ledger where it was so `failed` can
                      // still be reported.
                      if (!isAgentTurnTerminalError(err)) {
                        restoreCommittedPhase("idle", previous);
                      }
                      throw err;
                    }
                  },
                  onRealFailure: (err) => {
                    ctx.log?.error?.(
                      `[langlangbot:${account.accountId}] outbound idle failed: ${formatError(err)}`,
                    );
                    reportPhase("failed", formatError(err));
                  },
                  onTerminalDuplicate: () => {
                    ctx.log?.info?.(
                      `[langlangbot:${account.accountId}] outbound already terminal for ${inbound.messageId}`,
                    );
                  },
                }),
              ),
            );
            return runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
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
                deliver: (payload: ReplyPayload, info: { kind?: string }) =>
                  lane(async () => {
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
                    // A reply can arrive as several blocks; keep them all.
                    // Overwriting here dropped every earlier block from the
                    // message onIdle finally delivers.
                    const separator = blockSeparator(
                      streamState.streamedText,
                      text,
                    );
                    ctx.log?.info?.(
                      `[langlangbot:${account.accountId}] stream block ${text.length} chars sep=${JSON.stringify(separator)} prevTail=${JSON.stringify(streamState.streamedText.slice(-14))} → ${inbound.conversationId}`,
                    );
                    streamState.streamedText = appendStreamedBlock(
                      streamState.streamedText,
                      text,
                    );
                    streamState.pendingDelta = appendStreamedBlock(
                      streamState.pendingDelta,
                      text,
                    );
                    const ready =
                      isMarkdownSafeTail(streamState.pendingDelta) ||
                      streamState.pendingDelta.length >= DELTA_HOLD_MAX_CHARS;
                    if (!ready) {
                      ctx.log?.debug?.(
                        `[langlangbot:${account.accountId}] outbound delta held (${streamState.pendingDelta.length} chars) → ${inbound.conversationId}`,
                      );
                      markOutboundFirst(null);
                      return;
                    }
                    const chunk = streamState.pendingDelta;
                    streamState.pendingDelta = "";
                    ctx.log?.debug?.(
                      `[langlangbot:${account.accountId}] outbound delta (${chunk.length} chars) → ${inbound.conversationId}`,
                    );
                    markOutboundFirst(null);
                    await sidecar.sendDelta(inbound.conversationId, chunk);
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
                }),
                onIdle: () => finalizeIdle(),
                onError: (err: unknown, info: { kind?: string }) => {
                  if (isAgentTurnTerminalError(err)) {
                    ctx.log?.info?.(
                      `[langlangbot:${account.accountId}] outbound already terminal for ${inbound.messageId}`,
                    );
                    return;
                  }
                  ctx.log?.error?.(
                    `[langlangbot:${account.accountId}] outbound ${info.kind ?? "reply"} failed: ${
                      formatError(err)
                    }`,
                  );
                  reportPhase("failed", formatError(err));
                },
              },
            });
          },
        }),
      },
    });
    dispatchState.lastError = null;
    await reportAgentRuntimeStatus(sidecar, ctx, readiness);
  } catch (err) {
    const message = formatError(err);
    dispatchState.lastError = message;
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
  lastDispatchError: string | null = readiness.ready ? null : readiness.reason,
): Promise<boolean> {
  try {
    await sidecar.updateAgentRuntimeStatus({
      connected,
      agentRuntimeReady: readiness.ready,
      runtimeName: AGENT_RUNTIME_NAME,
      kind: AGENT_RUNTIME_KIND,
      hostVersion: hostVersion(),
      adapterVersion: adapterVersion(),
      accountId: ctx.account.accountId,
      reason: readiness.ready ? null : readiness.reason,
      lastDispatchError,
    });
    return true;
  } catch (err) {
    ctx.log?.warn?.(
      `[langlangbot:${ctx.account.accountId}] agent runtime status update failed: ${
        formatError(err)
      }`,
    );
    return false;
  }
}

async function sendOperatorVisibleStatus(
  sidecar: LanglangbotSidecar,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await sidecar.sendMessage(conversationId, text, undefined, undefined, true);
  } catch {
    // The caller still logs the dispatch failure. Avoid hiding the original cause.
  }
}
