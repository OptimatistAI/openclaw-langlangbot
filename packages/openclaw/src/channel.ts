import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  MARKDOWN_CAPABLE,
  MARKDOWN_TABLE_MODE,
  OPERATOR_FORMATTING_HINTS,
} from "./channel-capabilities.js";
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
    // Operator renders GitHub-flavoured markdown natively (tables, fenced code,
    // nested lists, blockquotes, links), so OpenClaw should keep markdown in
    // tool results and outbound formatting decisions instead of flattening it.
    markdownCapable: MARKDOWN_CAPABLE,
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
      const result = await sidecar.sendMessage(
        conversationId,
        text ?? "",
        undefined,
        undefined,
        true,
      );
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
        true,
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
    // Tables survive to the client as markdown tables; never downgrade them to
    // bullets or code blocks for this channel.
    defaultMarkdownTableMode: MARKDOWN_TABLE_MODE,
    normalizeTarget: (raw) => raw.trim(),
    targetResolver: {
      looksLikeId: looksLikeLanglangbotDeliveryTarget,
      hint: "Use conversation:<uuid> targets from the LangLangBot sidecar.",
    },
    resolveOutboundSessionRoute: resolveLanglangbotOutboundSessionRoute,
  },
  agentPrompt: {
    // The only channel hook OpenClaw renders on every inbound message: it lands
    // in the trusted-metadata block as response_format. The other hook,
    // messageToolHints, is only read when the `message` tool exists, which this
    // direct channel does not get outside message-tool delivery modes, so the
    // delivery/cron/attachment guidance lives in the langlangbot-channel skill
    // instead of in dead prompt code.
    inboundFormattingHints: () => OPERATOR_FORMATTING_HINTS,
  },
};
