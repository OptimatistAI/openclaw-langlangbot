export type ApprovalAction = {
  decision: string;
  label: string;
  style?: string;
};

/**
 * Wire/API approval kind — extensible string, not a closed union.
 *
 * Conventions:
 * - OpenClaw native: `openclaw.exec`, `openclaw.plugin`
 * - Gateway intent (Finance Gateway and future systems): manifest action id or
 *   `intent:<gateway>:<action>`; canonical payload in `metadata` (intent_id, intent_hash, …)
 */
export type ApprovalKind = string;

/** Built-in OpenClaw approval kinds (sidecar polls → exec/plugin.approval.resolve). */
export const OpenClawApprovalKind = {
  Exec: "openclaw.exec",
  Plugin: "openclaw.plugin",
} as const;

export type BuiltInOpenClawApprovalKind =
  (typeof OpenClawApprovalKind)[keyof typeof OpenClawApprovalKind];

/** Normalize legacy aliases from early Phase 2 drafts. */
export function normalizeApprovalKind(kind: string): ApprovalKind {
  const trimmed = kind.trim();
  switch (trimmed) {
    case "exec":
    case "openclaw_exec":
      return OpenClawApprovalKind.Exec;
    case "plugin":
    case "openclaw_plugin":
      return OpenClawApprovalKind.Plugin;
    default:
      return trimmed;
  }
}

export function isOpenClawApprovalKind(kind: string): boolean {
  const normalized = normalizeApprovalKind(kind);
  return (
    normalized === OpenClawApprovalKind.Exec ||
    normalized === OpenClawApprovalKind.Plugin
  );
}

export type OpenClawApprovalDecision = "allow-once" | "allow-always" | "deny";

export function isOpenClawApprovalDecision(
  value: string,
): value is OpenClawApprovalDecision {
  return (
    value === "allow-once" ||
    value === "allow-always" ||
    value === "deny"
  );
}

export type ApprovalPluginEvent =
  | {
      type: "approval_decided";
      approval_id: string;
      decision: string;
    }
  | {
      type: "approval_resolved";
      approval_id: string;
      decision?: string | null;
    };

export type RegisterPendingApprovalInput = {
  approvalId: string;
  kind: ApprovalKind;
  conversationId?: string;
  title: string;
  description?: string;
  actions?: ApprovalAction[];
  metadata?: Record<string, unknown>;
  expiresAt: string;
};

export type ApprovalDecisionPoll = {
  status: "pending" | "decided" | "resolved" | "expired";
  decision?: OpenClawApprovalDecision;
  decidedAt?: string;
};

export type PluginConnectionEndpoint = {
  transport: string;
  address: string;
  port: number;
};

export type ManagementRequestEvent = {
  request_id: string;
  account_id: string;
  runtime_name: string;
  conversation_id: string;
  operation: "status" | "models" | "set_model" | string;
  model?: string;
  created_at: string;
};

export type ManagementResultInput = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
};

export type AgentStatusQuery = {
  conversationId: string;
  sessionToken?: string;
  accountId?: string;
  runtimeName?: string;
};

export type PluginConnectionCurrentResponse =
  | {
      conversation_id: string;
      status: "observed";
      transport: string;
      remote_addr?: string | null;
      observed_at: string;
      matched_endpoint?: PluginConnectionEndpoint | null;
      published_endpoints: PluginConnectionEndpoint[];
    }
  | {
      conversation_id: string;
      status: "unknown";
      message: string;
      published_endpoints: PluginConnectionEndpoint[];
    }
  | {
      status: "error";
      message: string;
    };

export type AgentRuntimeStatusUpdate = {
  connected: boolean;
  agentRuntimeReady: boolean;
  runtimeName?: string;
  accountId?: string;
  reason?: string | null;
  lastDispatchError?: string | null;
};

export type InboundMessage = {
  conversationId: string;
  messageId: string;
  text: string;
  receivedAt: string;
  /** Base64 owner surface id attested by LangLangBot after ODA session.open. */
  ownerSurfaceId?: string;
};

export type InboundSubscriptionParams = {
  accountId?: string;
  agentSurfaceId?: string;
};

export type HealthStatus = {
  status: string;
  server_time?: string;
};

export type Unsubscribe = () => void;

import { assertHttpsBaseUrl } from "./endpoint-url.js";
import {
  createInsecureTlsFetch,
  createPinnedTlsFetch,
} from "./tls-pin.js";

export type LanglangbotSidecarOptions = {
  baseUrl: string;
  pluginToken?: string;
  /** Trust self-signed Agent cert (loopback OpenClaw plugin only). */
  insecureTls?: boolean;
  /** SPKI pin (`sha256/<hex>`) for Operator-style verification. */
  tlsFingerprint?: string;
  /** Dev only: allow `http://` base URLs. */
  allowInsecureHttp?: boolean;
  fetchImpl?: typeof fetch;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function createFetchImpl(opts: LanglangbotSidecarOptions): typeof fetch {
  const base = normalizeBaseUrl(opts.baseUrl);
  if (!opts.allowInsecureHttp && !base.startsWith("https://")) {
    if (base.startsWith("http://")) {
      throw new Error(
        "sidecar baseUrl must use https:// (set allowInsecureHttp for dev only)",
      );
    }
    assertHttpsBaseUrl(base);
  }

  if (opts.tlsFingerprint) {
    return createPinnedTlsFetch({
      tlsFingerprint: opts.tlsFingerprint,
      insecureTls: opts.insecureTls,
    });
  }
  if (opts.insecureTls) {
    return createInsecureTlsFetch();
  }
  return fetch;
}

function parseApprovalPluginEvent(raw: unknown): ApprovalPluginEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const event = raw as Record<string, unknown>;
  const type = event.type;
  if (type === "approval_decided") {
    const approvalId = event.approval_id;
    const decision = event.decision;
    if (typeof approvalId !== "string" || typeof decision !== "string") {
      return null;
    }
    return { type, approval_id: approvalId, decision };
  }
  if (type === "approval_resolved") {
    const approvalId = event.approval_id;
    if (typeof approvalId !== "string") {
      return null;
    }
    return {
      type,
      approval_id: approvalId,
      decision:
        event.decision == null ? undefined : String(event.decision),
    };
  }
  return null;
}

function startReconnectingSse(params: {
  connect: (signal: AbortSignal) => Promise<Response>;
  onData: (data: string) => void;
  onError?: (err: Error) => void;
  errorLabel: string;
}): Unsubscribe {
  const controller = new AbortController();
  void (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      try {
        const response = await params.connect(controller.signal);
        if (!response.ok) {
          throw new Error(`${params.errorLabel}: ${response.status}`);
        }
        attempt = 0;
        await consumeSse(
          response,
          (_eventName, data) => params.onData(data),
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        params.onError?.(error);
        attempt += 1;
        const delayMs = Math.min(30_000, 1_000 * attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  })();
  return () => controller.abort();
}

async function consumeSse(
  response: Response,
  onEvent: (eventName: string, data: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) {
    throw new Error("SSE response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      return;
    }
    const payload =
      dataLines.length === 1 ? dataLines[0] : dataLines.join("\n");
    onEvent(eventName, payload);
    eventName = "message";
    dataLines = [];
  };

  while (!signal?.aborted) {
    const { done, value } = await reader.read();
    if (done) {
      flush();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      if (line === "") {
        flush();
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
}

export class LanglangbotSidecar {
  readonly baseUrl: string;
  readonly pluginToken?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LanglangbotSidecarOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.pluginToken = opts.pluginToken;
    this.fetchImpl = opts.fetchImpl ?? createFetchImpl(opts);
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...extra,
    };
    if (this.pluginToken) {
      headers["x-langlangbot-plugin-token"] = this.pluginToken;
    }
    return headers;
  }

  async health(): Promise<HealthStatus> {
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`health check failed: ${response.status}`);
    }
    return (await response.json()) as HealthStatus;
  }

  subscribeInbound(
    onMessage: (evt: InboundMessage) => void,
    onError?: (err: Error) => void,
  ): Unsubscribe;
  subscribeInbound(
    params: InboundSubscriptionParams,
    onMessage: (evt: InboundMessage) => void,
    onError?: (err: Error) => void,
  ): Unsubscribe;
  subscribeInbound(
    paramsOrOnMessage:
      | InboundSubscriptionParams
      | ((evt: InboundMessage) => void),
    onMessageOrError?: ((evt: InboundMessage) => void) | ((err: Error) => void),
    onError?: (err: Error) => void,
  ): Unsubscribe {
    const params =
      typeof paramsOrOnMessage === "function" ? undefined : paramsOrOnMessage;
    const onMessage =
      typeof paramsOrOnMessage === "function"
        ? paramsOrOnMessage
        : (onMessageOrError as (evt: InboundMessage) => void);
    const errorHandler =
      typeof paramsOrOnMessage === "function"
        ? (onMessageOrError as ((err: Error) => void) | undefined)
        : onError;
    const query = new URLSearchParams();
    if (params?.accountId) {
      query.set("account_id", params.accountId);
    }
    if (params?.agentSurfaceId) {
      query.set("agent_surface_id", params.agentSurfaceId);
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return startReconnectingSse({
      errorLabel: "inbound SSE failed",
      onError: errorHandler,
      connect: (signal) =>
        this.fetchImpl(`${this.baseUrl}/v1/inbound/events${suffix}`, {
          headers: this.headers({ accept: "text/event-stream" }),
          signal,
        }),
      onData: (data) => {
        try {
          const parsed = JSON.parse(data) as {
            conversation_id?: string;
            message_id?: string;
            text?: string;
            received_at?: string;
            owner_surface_id?: string;
          };
          if (
            !parsed.conversation_id ||
            !parsed.message_id ||
            typeof parsed.text !== "string"
          ) {
            return;
          }
          onMessage({
            conversationId: parsed.conversation_id,
            messageId: parsed.message_id,
            text: parsed.text,
            receivedAt: parsed.received_at ?? new Date().toISOString(),
            ownerSurfaceId: parsed.owner_surface_id?.trim() || undefined,
          });
        } catch (err) {
          if (err instanceof SyntaxError) {
            return;
          }
          throw err;
        }
      },
    });
  }

  subscribeApprovalPluginEvents(
    onEvent: (evt: ApprovalPluginEvent) => void,
    onError?: (err: Error) => void,
  ): Unsubscribe {
    return startReconnectingSse({
      errorLabel: "approval plugin SSE failed",
      onError,
      connect: (signal) =>
        this.fetchImpl(`${this.baseUrl}/v1/approvals/plugin/events`, {
          headers: this.headers({ accept: "text/event-stream" }),
          signal,
        }),
      onData: (data) => {
        try {
          const parsed = parseApprovalPluginEvent(JSON.parse(data));
          if (parsed) {
            onEvent(parsed);
          }
        } catch (err) {
          if (err instanceof SyntaxError) {
            return;
          }
          throw err;
        }
      },
    });
  }

  async sendDelta(conversationId: string, text: string): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${conversationId}/outbound/delta`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ text }),
      },
    );
    if (!response.ok) {
      throw new Error(`sendDelta failed: ${response.status}`);
    }
  }

  async updateAgentRuntimeStatus(input: AgentRuntimeStatusUpdate): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/plugin/runtime/status`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        connected: input.connected,
        agent_runtime_ready: input.agentRuntimeReady,
        runtime_name: input.runtimeName,
        account_id: input.accountId,
        reason: input.reason,
        last_dispatch_error: input.lastDispatchError,
      }),
    });
    if (!response.ok) {
      throw new Error(`updateAgentRuntimeStatus failed: ${response.status}`);
    }
  }

  async registerApprovalPending(
    input: RegisterPendingApprovalInput,
  ): Promise<{ approval_id: string; status: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/approvals/pending`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        approval_id: input.approvalId,
        kind: normalizeApprovalKind(input.kind),
        conversation_id: input.conversationId,
        title: input.title,
        description: input.description,
        actions: input.actions,
        metadata: input.metadata ?? {},
        expires_at: input.expiresAt,
      }),
    });
    if (!response.ok) {
      throw new Error(`registerApprovalPending failed: ${response.status}`);
    }
    return (await response.json()) as { approval_id: string; status: string };
  }

  async getApprovalDecision(approvalId: string): Promise<ApprovalDecisionPoll> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      { headers: this.headers() },
    );
    if (!response.ok) {
      throw new Error(`getApprovalDecision failed: ${response.status}`);
    }
    const body = (await response.json()) as {
      status: ApprovalDecisionPoll["status"];
      decision?: OpenClawApprovalDecision;
      decided_at?: string;
    };
    return {
      status: body.status,
      decision: body.decision,
      decidedAt: body.decided_at,
    };
  }

  async markApprovalResolved(
    approvalId: string,
    decision?: OpenClawApprovalDecision,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/approvals/${encodeURIComponent(approvalId)}/resolved`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ decision }),
      },
    );
    if (!response.ok) {
      throw new Error(`markApprovalResolved failed: ${response.status}`);
    }
  }

  async getPluginConnectionCurrent(
    conversationId: string,
  ): Promise<PluginConnectionCurrentResponse> {
    const params = new URLSearchParams({ conversation_id: conversationId });
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/plugin/connection/current?${params}`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `getPluginConnectionCurrent failed: ${response.status}`,
      );
    }
    return response.json() as Promise<PluginConnectionCurrentResponse>;
  }

  async sendMessage(
    conversationId: string,
    text: string,
    messageId?: string,
  ): Promise<{ message_id: string }> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${conversationId}/outbound/message`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          text,
          message_id: messageId,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`sendMessage failed: ${response.status}`);
    }
    return (await response.json()) as { message_id: string };
  }

  subscribeManagementEvents(
    params: { accountId?: string } | undefined,
    onEvent: (evt: ManagementRequestEvent) => void,
    onError?: (err: Error) => void,
  ): Unsubscribe {
    const query = new URLSearchParams();
    if (params?.accountId) {
      query.set("account_id", params.accountId);
    }
    const suffix = query.size > 0 ? `?${query}` : "";
    return startReconnectingSse({
      errorLabel: "management SSE failed",
      onError,
      connect: (signal) =>
        this.fetchImpl(`${this.baseUrl}/v1/plugin/management/events${suffix}`, {
          headers: this.headers({ accept: "text/event-stream" }),
          signal,
        }),
      onData: (data) => {
        try {
          const parsed = JSON.parse(data) as ManagementRequestEvent;
          if (
            typeof parsed.request_id !== "string" ||
            typeof parsed.account_id !== "string" ||
            typeof parsed.runtime_name !== "string" ||
            typeof parsed.conversation_id !== "string" ||
            typeof parsed.operation !== "string"
          ) {
            return;
          }
          onEvent(parsed);
        } catch (err) {
          if (err instanceof SyntaxError) {
            return;
          }
          throw err;
        }
      },
    });
  }

  async postManagementResult(
    requestId: string,
    body: ManagementResultInput,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/plugin/management/${encodeURIComponent(requestId)}/result`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`postManagementResult failed: ${response.status}`);
    }
  }

  private sessionHeaders(sessionToken?: string): Record<string, string> {
    const headers = this.headers();
    if (sessionToken) {
      headers["x-langlangbot-session-token"] = sessionToken;
    }
    return headers;
  }

  async getAgentStatus(params: AgentStatusQuery): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      conversation_id: params.conversationId,
    });
    if (params.accountId) {
      query.set("account_id", params.accountId);
    }
    if (params.runtimeName) {
      query.set("runtime_name", params.runtimeName);
    }
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/agent/status?${query}`,
      {
        method: "GET",
        headers: this.sessionHeaders(params.sessionToken),
      },
    );
    if (!response.ok) {
      throw new Error(`getAgentStatus failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async listAgentModels(params: AgentStatusQuery): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({
      conversation_id: params.conversationId,
    });
    if (params.accountId) {
      query.set("account_id", params.accountId);
    }
    if (params.runtimeName) {
      query.set("runtime_name", params.runtimeName);
    }
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/agent/models?${query}`,
      {
        method: "GET",
        headers: this.sessionHeaders(params.sessionToken),
      },
    );
    if (!response.ok) {
      throw new Error(`listAgentModels failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }

  async setAgentModel(params: {
    conversationId: string;
    model: string;
    sessionToken?: string;
    accountId?: string;
    runtimeName?: string;
  }): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/agent/model`, {
      method: "POST",
      headers: this.sessionHeaders(params.sessionToken),
      body: JSON.stringify({
        conversation_id: params.conversationId,
        model: params.model,
        session_token: params.sessionToken,
        account_id: params.accountId,
        runtime_name: params.runtimeName,
      }),
    });
    if (!response.ok) {
      throw new Error(`setAgentModel failed: ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  }
}
