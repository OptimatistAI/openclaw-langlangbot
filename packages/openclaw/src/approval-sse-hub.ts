import {
  isOpenClawApprovalDecision,
  isRuntimeMismatch,
  type ApprovalPluginEvent,
  type OpenClawApprovalDecision,
  type Unsubscribe,
} from "@optimatist/langlangbot-connector";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import {
  createLanglangbotSidecar,
  formatError,
  type LanglangbotAccount,
} from "./config.js";

type PendingWatcher = {
  approvalId: string;
  cfg: OpenClawConfig;
  onDone: () => void;
};

type HubState = {
  refCount: number;
  watchers: Map<string, PendingWatcher>;
  unsubscribe: Unsubscribe;
};

const hubsBySidecarUrl = new Map<string, HubState>();
const forwardingApprovalIds = new Set<string>();

async function forwardDecidedApproval(params: {
  watcher: PendingWatcher;
  decision: OpenClawApprovalDecision;
  account: LanglangbotAccount;
}): Promise<void> {
  const { watcher, decision, account } = params;
  if (forwardingApprovalIds.has(watcher.approvalId)) {
    return;
  }
  forwardingApprovalIds.add(watcher.approvalId);
  try {
    const sidecar = createLanglangbotSidecar(account);
    await resolveApprovalOverGateway({
      cfg: watcher.cfg,
      approvalId: watcher.approvalId,
      decision,
      clientDisplayName: "LangLangBot Approval Bridge",
    });
    await sidecar.markApprovalResolved(watcher.approvalId, decision);
  } finally {
    forwardingApprovalIds.delete(watcher.approvalId);
  }
}

function dispatchPluginEvent(
  account: LanglangbotAccount,
  evt: ApprovalPluginEvent,
): void {
  const hub = hubsBySidecarUrl.get(account.sidecarUrl);
  if (!hub) {
    return;
  }

  const watcher = hub.watchers.get(evt.approval_id);
  if (!watcher) {
    return;
  }

  if (evt.type === "approval_resolved") {
    hub.watchers.delete(evt.approval_id);
    watcher.onDone();
    return;
  }

  if (!isOpenClawApprovalDecision(evt.decision)) {
    return;
  }

  hub.watchers.delete(evt.approval_id);
  void forwardDecidedApproval({ watcher, decision: evt.decision, account }).finally(
    () => watcher.onDone(),
  );
}

function ensureHub(account: LanglangbotAccount): HubState {
  const key = account.sidecarUrl;
  const existing = hubsBySidecarUrl.get(key);
  if (existing) {
    return existing;
  }

  const sidecar = createLanglangbotSidecar(account);
  const watchers = new Map<string, PendingWatcher>();
  const unsubscribe = sidecar.subscribeApprovalPluginEvents(
    (evt) => dispatchPluginEvent(account, evt),
    (err) => {
      if (isRuntimeMismatch(err)) {
        // Permanent: reconnect already stopped. Soft-idle only — do not
        // escalate into the OpenClaw host.
        console.warn(
          `[langlangbot:approval] plugin SSE stopped (${key}): ${formatError(err)}`,
        );
        return;
      }
      console.warn(
        `[langlangbot:approval] plugin SSE error (${key}): ${formatError(err)}`,
      );
    },
  );

  const hub: HubState = { refCount: 0, watchers, unsubscribe };
  hubsBySidecarUrl.set(key, hub);
  return hub;
}

function maybeStopHub(key: string): void {
  const hub = hubsBySidecarUrl.get(key);
  if (!hub || hub.refCount > 0 || hub.watchers.size > 0) {
    return;
  }
  hub.unsubscribe();
  hubsBySidecarUrl.delete(key);
}

async function catchUpIfAlreadyDecided(params: {
  account: LanglangbotAccount;
  watcher: PendingWatcher;
}): Promise<void> {
  const sidecar = createLanglangbotSidecar(params.account);
  try {
    const poll = await sidecar.getApprovalDecision(params.watcher.approvalId);
    if (poll.status === "resolved" || poll.status === "expired") {
      params.watcher.onDone();
      return;
    }
    if (poll.status !== "decided" || !poll.decision) {
      return;
    }
    if (!isOpenClawApprovalDecision(poll.decision)) {
      return;
    }
    const key = params.account.sidecarUrl;
    const hub = hubsBySidecarUrl.get(key);
    if (!hub?.watchers.has(params.watcher.approvalId)) {
      return;
    }
    hub.watchers.delete(params.watcher.approvalId);
    await forwardDecidedApproval({
      watcher: params.watcher,
      decision: poll.decision,
      account: params.account,
    });
    params.watcher.onDone();
  } catch {
    // SSE will deliver the decision; ignore transient read errors.
  }
}

export function watchApprovalDecision(params: {
  cfg: OpenClawConfig;
  account: LanglangbotAccount;
  approvalId: string;
  expiresAtMs: number;
}): () => void {
  const key = params.account.sidecarUrl;
  const hub = ensureHub(params.account);
  hub.refCount += 1;

  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    hub.watchers.delete(params.approvalId);
    hub.refCount -= 1;
    maybeStopHub(key);
  };

  const watcher: PendingWatcher = {
    approvalId: params.approvalId,
    cfg: params.cfg,
    onDone: release,
  };
  hub.watchers.set(params.approvalId, watcher);

  void catchUpIfAlreadyDecided({ account: params.account, watcher });

  const expiryTimer = setTimeout(
    () => {
      hub.watchers.delete(params.approvalId);
      release();
    },
    Math.max(0, params.expiresAtMs - Date.now()),
  );
  expiryTimer.unref?.();

  return () => {
    clearTimeout(expiryTimer);
    release();
  };
}
