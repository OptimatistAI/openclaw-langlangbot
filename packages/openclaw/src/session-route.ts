import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
} from "openclaw/plugin-sdk/channel-core";
import type { ChannelOutboundSessionRouteParams } from "openclaw/plugin-sdk/channel-core";

import {
  conversationTarget,
  parseConversationTarget,
  resolveLanglangbotAccount,
} from "./config.js";
import { resolveOwnerFrom } from "./owner-surface.js";
import {
  isConversationUuid,
  resolveLanglangbotSessionConversationId,
} from "./session-conversation.js";

export function looksLikeLanglangbotDeliveryTarget(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("conversation:") || isConversationUuid(trimmed);
}

export function normalizeLanglangbotDeliveryTarget(raw?: string | null): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }
  const withoutChannel = stripChannelTargetPrefix(trimmed, "langlangbot").trim();
  const conversationId =
    parseConversationTarget(withoutChannel) ??
    (isConversationUuid(withoutChannel) ? withoutChannel.toLowerCase() : null);
  if (!conversationId) {
    return null;
  }
  return conversationTarget(conversationId);
}

export function resolveLanglangbotConversationIdFromRouteParams(
  params: Pick<ChannelOutboundSessionRouteParams, "target" | "currentSessionKey">,
): string | null {
  const fromTarget = normalizeLanglangbotDeliveryTarget(params.target);
  if (fromTarget) {
    return parseConversationTarget(fromTarget);
  }
  return resolveLanglangbotSessionConversationId(params.currentSessionKey);
}

export function resolveLanglangbotOutboundSessionRoute(
  params: ChannelOutboundSessionRouteParams,
): ReturnType<typeof buildChannelOutboundSessionRoute> | null {
  const conversationId = resolveLanglangbotConversationIdFromRouteParams(params);
  if (!conversationId) {
    return null;
  }
  const to = conversationTarget(conversationId);
  const account = resolveLanglangbotAccount(params.cfg, params.accountId);
  const accountId = account.accountId;
  const from = resolveOwnerFrom({
    conversationId,
  });

  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "langlangbot",
    accountId,
    peer: {
      kind: "direct",
      id: to,
    },
    chatType: "direct",
    from,
    to,
  });
}
