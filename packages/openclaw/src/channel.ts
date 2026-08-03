import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createLanglangbotSidecar,
  parseConversationTarget,
  resolveLanglangbotAccount,
  type LanglangbotAccount,
} from "./config.js";
import { sendPendingOutboundFile } from "./outbound-media.js";
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
      const filename = localPath.split("/").pop() ?? "attachment.bin";
      const sidecar = createLanglangbotSidecar(account);
      const result = await sendPendingOutboundFile(
        sidecar,
        conversationId,
        accountId,
        localPath,
        filename,
        undefined,
        text?.trim() || `Sending ${filename}...`,
      );
      return {
        channel: "langlangbot",
        messageId: result.attachmentId,
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
      "Pending inbound attachments: acknowledge intent, wait for attachment_ready before analyzing file contents.",
      "Outbound files must be exported to ~/.openclaw/media/langlangbot/outbound/ before sending to Operator.",
    ],
  },
};
