const FALLBACK_AGENT_ID = "main";

export function agentIdFromSessionKey(sessionKey: string): string {
  const match = /^agent:([^:]+)/.exec(sessionKey);
  return match?.[1] ?? FALLBACK_AGENT_ID;
}

export function buildLanglangbotSessionKey(params: {
  accountId: string;
  conversationId: string;
  agentId: string;
}): string {
  const to = `conversation:${params.conversationId}`;
  return `agent:${params.agentId}:langlangbot:${params.accountId}:direct:${to}`;
}
