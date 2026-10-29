import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
// agent-runtime is the only path exporting this helper in 2026.5.7 through
// 2026.10.8; config-runtime was removed in 2026.10.
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";

type LanglangbotChannelConfig = {
  agentId?: string;
  accounts?: Record<string, { agentId?: string }>;
};

export function resolveLanglangbotAgentId(
  cfg: OpenClawConfig,
  account?: { accountId?: string; agentId?: string },
): string {
  const section = (cfg.channels as Record<string, unknown> | undefined)
    ?.langlangbot as LanglangbotChannelConfig | undefined;
  const accountId = account?.accountId ?? "default";
  const accountSection = section?.accounts?.[accountId];
  const configured =
    account?.agentId ??
    accountSection?.agentId ??
    section?.agentId;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return resolveDefaultAgentId(cfg);
}
