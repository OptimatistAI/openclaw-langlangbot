import { LanglangbotSidecar } from "@optimatist/langlangbot-connector";
import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";

import { resolveLanglangbotAgentId } from "./agent-id.js";
import { DEFAULT_SIDECAR_URL } from "./defaults.js";

export type LanglangbotAccount = {
  accountId: string;
  enabled: boolean;
  sidecarUrl: string;
  /** When true (default), OpenClaw spawns langlangbot if sidecarUrl is not healthy. */
  autoStartSidecar: boolean;
  /** Optional path to langlangbot binary; else LANGLANGBOT_BINARY or PATH / workspace target. */
  sidecarBinary?: string;
  /** Optional env file (KEY=VALUE) merged into the child process; default ~/.langlangbot/env if present. */
  sidecarEnvPath?: string;
  /** Max ms to wait for /health after spawn. */
  sidecarStartTimeoutMs: number;
  /** Trust self-signed TLS for loopback sidecarUrl (default true for 127.0.0.1). */
  sidecarInsecureTls: boolean;
  pluginToken?: string;
  surfaceId?: string;
  /** OpenClaw agent id for session keys and provider auth (defaults to gateway default agent). */
  agentId: string;
  streaming: boolean;
};

export function resolveLanglangbotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): LanglangbotAccount {
  const id = accountId ?? "default";
  const section = (cfg.channels as Record<string, unknown> | undefined)?.langlangbot as
    | Record<string, unknown>
    | undefined;
  const accounts = section?.accounts as Record<string, Record<string, unknown>> | undefined;
  const accountSection = accounts?.[id] ?? section ?? {};
  const sidecarUrl =
    (typeof accountSection.sidecarUrl === "string" && accountSection.sidecarUrl) ||
    (typeof section?.sidecarUrl === "string" && section.sidecarUrl) ||
    DEFAULT_SIDECAR_URL;
  const pluginToken =
    (typeof accountSection.pluginToken === "string" && accountSection.pluginToken) ||
    (typeof section?.pluginToken === "string" ? section.pluginToken : undefined);
  const surfaceId =
    (typeof accountSection.surfaceId === "string" && accountSection.surfaceId) ||
    (typeof section?.surfaceId === "string" ? section.surfaceId : undefined);
  const streaming =
    typeof accountSection.streaming === "boolean"
      ? accountSection.streaming
      : typeof section?.streaming === "boolean"
        ? section.streaming
        : true;
  const autoStartSidecar =
    typeof accountSection.autoStartSidecar === "boolean"
      ? accountSection.autoStartSidecar
      : typeof section?.autoStartSidecar === "boolean"
        ? section.autoStartSidecar
        : true;
  const sidecarBinary =
    (typeof accountSection.sidecarBinary === "string" && accountSection.sidecarBinary) ||
    (typeof section?.sidecarBinary === "string" ? section.sidecarBinary : undefined);
  const sidecarEnvPath =
    (typeof accountSection.sidecarEnvPath === "string" && accountSection.sidecarEnvPath) ||
    (typeof section?.sidecarEnvPath === "string" ? section.sidecarEnvPath : undefined);
  const sidecarStartTimeoutMs =
    typeof accountSection.sidecarStartTimeoutMs === "number"
      ? accountSection.sidecarStartTimeoutMs
      : typeof section?.sidecarStartTimeoutMs === "number"
        ? section.sidecarStartTimeoutMs
        : 30_000;
  const sidecarInsecureTls =
    typeof accountSection.sidecarInsecureTls === "boolean"
      ? accountSection.sidecarInsecureTls
      : typeof section?.sidecarInsecureTls === "boolean"
        ? section.sidecarInsecureTls
        : sidecarUrl.includes("127.0.0.1") || sidecarUrl.includes("localhost");
  const enabled =
    typeof accountSection.enabled === "boolean"
      ? accountSection.enabled
      : typeof section?.enabled === "boolean"
        ? section.enabled
        : true;

  return {
    accountId: id,
    enabled,
    sidecarUrl,
    autoStartSidecar,
    sidecarBinary,
    sidecarEnvPath,
    sidecarStartTimeoutMs,
    sidecarInsecureTls,
    pluginToken,
    surfaceId,
    agentId: resolveLanglangbotAgentId(cfg, { accountId: id }),
    streaming,
  };
}

export function isLanglangbotAccountReady(account: LanglangbotAccount): boolean {
  return account.enabled && Boolean(account.sidecarUrl);
}

export function createLanglangbotSidecar(account: LanglangbotAccount): LanglangbotSidecar {
  return new LanglangbotSidecar({
    baseUrl: account.sidecarUrl,
    pluginToken: account.pluginToken,
    insecureTls: account.sidecarInsecureTls,
  });
}

export type SidecarLog = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};

export function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function conversationTarget(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function parseConversationTarget(to: string): string | null {
  const prefix = "conversation:";
  if (!to.startsWith(prefix)) {
    return null;
  }
  return to.slice(prefix.length);
}
