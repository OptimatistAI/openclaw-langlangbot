import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createLanglangbotSidecar,
  parseConversationTarget,
  resolveLanglangbotAccount,
  type LanglangbotAccount,
} from "./config.js";
import { outboundExportDir, sendOutboundFiles } from "./outbound-media.js";
import { getLanglangbotApprovalCapability } from "./approval-capability.js";
import { startLanglangbotGateway } from "./gateway.js";
import {
  looksLikeLanglangbotDeliveryTarget,
  normalizeLanglangbotDeliveryTarget,
  resolveLanglangbotOutboundSessionRoute,
} from "./session-route.js";

export const langlangbotPlugin: ChannelPlugin<LanglangbotAccount> = {
  id: "langlangbot",
  meta: {
    id: "langlangbot",
    label: "LangLangBot",
    selectionLabel: "LangLangBot",
    detailLabel: "LangLangBot",
    docsPath: "/channels/langlangbot",
    docsLabel: "langlangbot",
    blurb: "Connect OpenClaw to LangLangBot for Operator chat, streaming replies, and exec/plugin approvals.",
    systemImage: "message.fill",
  },
  capabilities: {
    chatTypes: ["direct"],
    blockStreaming: false,
    media: true,
  },
  approvalCapability: getLanglangbotApprovalCapability(),
  config: {
    listAccountIds: () => ["default"],
    defaultAccountId: () => "default",
    resolveAccount: resolveLanglangbotAccount,
    inspectAccount(cfg, accountId) {
      const account = resolveLanglangbotAccount(cfg, accountId);
      return {
        accountId: account.accountId,
        enabled: account.enabled,
        configured: Boolean(account.sidecarUrl),
      };
    },
    isConfigured: (account) => Boolean(account.sidecarUrl),
  },
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
  },
  security: {
    resolveDmPolicy: () => ({
      policy: "open",
      allowFromPath: "channels.langlangbot.allowFrom",
      approveHint: "Approve the Operator in your LangLang app settings.",
    }),
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to, mode }) => {
      const normalized = normalizeLanglangbotDeliveryTarget(to);
      if (normalized) {
        return { ok: true, to: normalized };
      }
      if (mode === "implicit" && !to?.trim()) {
        return {
          ok: false,
          error: new Error(
            "langlangbot: delivery target required (conversation:<uuid> or active langlangbot session)",
          ),
        };
      }
      return {
        ok: false,
        error: new Error(`langlangbot: invalid target ${to ?? "(empty)"}`),
      };
    },
    sendText: async ({ to, text, cfg, accountId }) => {
      const account = resolveLanglangbotAccount(cfg, accountId);
      const normalized = normalizeLanglangbotDeliveryTarget(to);
      const conversationId = parseConversationTarget(normalized ?? to);
      if (!conversationId) {
        throw new Error(`langlangbot: invalid target ${to}`);
      }
      const sidecar = createLanglangbotSidecar(account);
      const result = await sidecar.sendMessage(conversationId, text ?? "");
      return {
        channel: "langlangbot",
        messageId: result.message_id,
      };
    },
    sendMedia: async ({ to, text, mediaUrl, cfg, accountId }) => {
      const account = resolveLanglangbotAccount(cfg, accountId);
      const normalized = normalizeLanglangbotDeliveryTarget(to);
      const conversationId = parseConversationTarget(normalized ?? to);
      if (!conversationId) {
        throw new Error(`langlangbot: invalid target ${to}`);
      }
      const localPath = mediaUrl?.trim();
      if (!localPath) {
        throw new Error("langlangbot: mediaUrl (absolute local path) is required");
      }
      const sidecar = createLanglangbotSidecar(account);
      const result = await sendOutboundFiles(
        sidecar,
        conversationId,
        account.accountId,
        [localPath],
        // The tool's own text, if any. No fallback caption: the filename
        // already travels on the attachment part.
        text?.trim() || undefined,
      );
      return {
        channel: "langlangbot",
        messageId: result.messageId,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      await startLanglangbotGateway(ctx);
    },
  },
  messaging: {
    normalizeTarget: (raw) => raw.trim(),
    targetResolver: {
      looksLikeId: looksLikeLanglangbotDeliveryTarget,
      hint: "Use conversation:<uuid> targets from the LangLangBot sidecar.",
    },
    resolveOutboundSessionRoute: resolveLanglangbotOutboundSessionRoute,
  },
  agentPrompt: {
    messageToolHints: () => [
      "LangLangBot delivery target is conversation:<uuid> from the active session key.",
      "Operator chat sets OwnerAllowFrom from ODA-attested owner_surface_id; cron tool is usually available without commands.ownerAllowFrom.",
      "For Operator reminders via cron: payload.kind agentTurn, sessionTarget isolated, delivery { mode: announce } only (never channel without to). See langlangbot-channel skill.",
      "For Operator context/model questions (app runtime bar), call langlangbot_operator_runtime_status instead of session_status.",
      "Operator only renders your reply text; tool results and reasoning never reach the app. Restate any tool output the user asked for, and never answer NO_REPLY to an explicit user request.",
      "Pending inbound attachments: acknowledge intent, wait for attachment_ready before analyzing file contents.",
      `Outbound files must be written to ${outboundExportDir()}/ (create it if missing) before sending to Operator.`,
    ],
  },
};
