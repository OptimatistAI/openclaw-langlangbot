export type ApprovalAction = {
  decision: string;
  label: string;
  style?: string;
};

/** Operator-visible agent turn phases (`agent_turn` SSE / outbound/turn). */
export type AgentTurnPhase =
  | "waiting_attachments"
  | "working"
  | "thinking"
  | "tool"
  | "streaming"
  | "idle"
  | "failed";

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

export type ConversationTranscriptMessage = {
  role: "user" | "assistant";
  message_id?: string | null;
  text: string;
  created_at: string;
};

export type ConversationTranscript = {
  conversation_id: string;
  since?: string | null;
  messages: ConversationTranscriptMessage[];
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
  /** Stable kind: `openclaw` | `hermes` | `unknown`. */
  kind?: string | null;
  hostVersion?: string | null;
  adapterVersion?: string | null;
  accountId?: string;
  reason?: string | null;
  lastDispatchError?: string | null;
};

export type InboundMessage = {
  conversationId: string;
  messageId: string;
  text: string;
  parts: ContentPart[];
  receivedAt: string;
  /**
   * SSE `id:` from `/v1/inbound/events`.
   * Pass the seq set to `acceptInbound` before starting a turn.
   */
  seq?: string;
  /** Base64 owner surface id attested by LangLangBot after ODA session.open. */
  ownerSurfaceId?: string;
};

export type InboundSubscriptionParams = {
  accountId?: string;
  agentSurfaceId?: string;
};

export type InboundHandler = {
  onMessage?: (evt: InboundMessage) => void;
  onAttachmentAvailable?: (evt: InboundAttachmentAvailable) => void;
  onAttachmentReady?: (evt: InboundAttachmentReady) => void;
  onAttachmentFailed?: (evt: InboundAttachmentFailed) => void;
};

function isInboundHandler(value: unknown): value is InboundHandler {
  return (
    !!value &&
    typeof value === "object" &&
    ("onMessage" in value ||
      "onAttachmentAvailable" in value ||
      "onAttachmentReady" in value ||
      "onAttachmentFailed" in value)
  );
}

export type HealthStatus = {
  status: string;
  server_time?: string;
  instance_id?: string;
  configured_surface_id?: string | null;
  /** Runtime kind recorded at pair time; null/absent means nothing paired yet. */
  paired_runtime_kind?: string | null;
  makway_enabled?: boolean;
};

export type Unsubscribe = () => void;

import {
  parseContentParts,
  type AttachmentKind,
  type ContentPart,
  type InboundAttachmentAvailable,
  type InboundAttachmentFailed,
  type InboundAttachmentReady,
  type RegisterOutboundAttachmentInput,
  type RegisterOutboundAttachmentResult,
} from "./media.js";
import { assertHttpsBaseUrl } from "./endpoint-url.js";
import {
  createInsecureTlsFetch,
  createPinnedTlsFetch,
} from "./tls-pin.js";

export type LanglangbotSidecarOptions = {
  baseUrl: string;
  pluginToken?: string;
  /**
   * Runtime kind this adapter identifies as, sent as
   * `x-langlangbot-runtime-kind` on every request. When the sidecar was
   * paired with a different runtime, inbound surfaces return 409.
   */
  runtimeKind?: string;
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

function inboundQuerySuffix(params?: {
  accountId?: string;
  agentSurfaceId?: string;
}): string {
  const query = new URLSearchParams();
  if (params?.accountId) {
    query.set("account_id", params.accountId);
  }
  if (params?.agentSurfaceId) {
    query.set("agent_surface_id", params.agentSurfaceId);
  }
  return query.size > 0 ? `?${query}` : "";
}

function accountQuerySuffix(accountId?: string): string {
  return inboundQuerySuffix(accountId ? { accountId } : undefined);
}

/** Permanent 409 reasons from the sidecar's runtime-exclusivity gate. */
export type RuntimeMismatchReason =
  | "runtime_mismatch"
  | "runtime_instance_mismatch"
  | "runtime_pid_required";

/**
 * Permanent sidecar rejection (HTTP 409): wrong kind, same-kind different
 * live PID, or kind without PID. Retrying cannot succeed — reconnect loops
 * must terminate instead of backing off forever.
 */
export class RuntimeMismatchError extends Error {
  /** The runtime kind the sidecar is paired with (`paired_runtime` body field). */
  readonly pairedRuntime: string;
  /** HTTP status the rejection arrived with (always 409 today). */
  readonly status: number;
  /** Distinguishes kind / instance / missing-PID permanent rejections. */
  readonly reason: RuntimeMismatchReason;
  /** Present for `runtime_instance_mismatch` when the sidecar reported it. */
  readonly activePid?: number;

  constructor(
    pairedRuntime: string,
    status = 409,
    reason: RuntimeMismatchReason = "runtime_mismatch",
    detail?: string,
    activePid?: number,
  ) {
    super(detail ?? defaultMismatchDetail(pairedRuntime, reason, activePid));
    this.name = "RuntimeMismatchError";
    this.pairedRuntime = pairedRuntime;
    this.status = status;
    this.reason = reason;
    this.activePid = activePid;
  }
}

function defaultMismatchDetail(
  pairedRuntime: string,
  reason: RuntimeMismatchReason,
  activePid?: number,
): string {
  if (reason === "runtime_instance_mismatch") {
    return typeof activePid === "number"
      ? `sidecar is already owned by another ${pairedRuntime} process (pid ${activePid}); stop that instance or wait for it to exit`
      : `sidecar is already owned by another ${pairedRuntime} process`;
  }
  if (reason === "runtime_pid_required") {
    return `sidecar requires X-Langlangbot-Runtime-Pid (paired with ${pairedRuntime})`;
  }
  return `sidecar is paired with ${pairedRuntime}; re-pair with --runtime ${pairedRuntime}`;
}

/** True when `err` is a permanent 409 runtime-exclusivity rejection. */
export function isRuntimeMismatch(err: unknown): err is RuntimeMismatchError {
  return err instanceof RuntimeMismatchError;
}

/** Parse a 409 body into the typed error when it is a permanent runtime rejection. */
async function parseRuntimeMismatch(
  response: Response,
): Promise<RuntimeMismatchError | undefined> {
  if (response.status !== 409) {
    return undefined;
  }
  let body: unknown;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const error = (body as { error?: unknown }).error;
  const pairedRuntimeRaw = (body as { paired_runtime?: unknown }).paired_runtime;
  const pairedRuntime =
    typeof pairedRuntimeRaw === "string" && pairedRuntimeRaw.trim()
      ? pairedRuntimeRaw.trim()
      : "another runtime";
  if (error === "runtime_mismatch") {
    return new RuntimeMismatchError(pairedRuntime, response.status, "runtime_mismatch");
  }
  if (error === "runtime_instance_mismatch") {
    const activePid = (body as { active_pid?: unknown }).active_pid;
    return new RuntimeMismatchError(
      pairedRuntime,
      response.status,
      "runtime_instance_mismatch",
      undefined,
      typeof activePid === "number" ? activePid : undefined,
    );
  }
  if (error === "runtime_pid_required") {
    return new RuntimeMismatchError(
      pairedRuntime,
      response.status,
      "runtime_pid_required",
    );
  }
  return undefined;
}

function startReconnectingSse(params: {
  connect: (signal: AbortSignal, lastEventId?: string) => Promise<Response>;
  onData: (data: string, eventId?: string) => void;
  onError?: (err: Error) => void;
  errorLabel: string;
}): Unsubscribe {
  const controller = new AbortController();
  const run = (async () => {
    let attempt = 0;
    let lastEventId: string | undefined;
    while (!controller.signal.aborted) {
      try {
        const response = await params.connect(controller.signal, lastEventId);
        if (!response.ok) {
          // A 409 runtime_mismatch is permanent: surface it to the caller and
          // stop instead of retrying (any other status keeps the backoff).
          const mismatch = await parseRuntimeMismatch(response);
          if (mismatch) {
            throw mismatch;
          }
          throw new Error(`${params.errorLabel}: ${response.status}`);
        }
        attempt = 0;
        await consumeSse(
          response,
          (_eventName, data, eventId) => {
            if (eventId) {
              lastEventId = eventId;
            }
            params.onData(data, eventId);
          },
          controller.signal,
        );
      } catch (err) {
        if (controller.signal.aborted) {
          return;
        }
        if (isRuntimeMismatch(err)) {
          // Permanent: rethrow unconditionally so callers see termination
          // (the loop must not retry, back off, or swallow it).
          params.onError?.(err);
          throw err;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        params.onError?.(error);
        attempt += 1;
        const delayMs = Math.min(30_000, 1_000 * attempt);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  })();
  // The loop rethrows permanent (runtime-mismatch) failures so callers can
  // await/inspect termination; the fire-and-forget subscription path must not
  // turn that into an unhandled rejection on top of the onError callback.
  run.catch(() => undefined);
  return () => controller.abort();
}

async function consumeSse(
  response: Response,
  onEvent: (eventName: string, data: string, eventId?: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) {
    throw new Error("SSE response has no body");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventId: string | undefined;
  let dataLines: string[] = [];

  const flush = () => {
    if (dataLines.length === 0) {
      eventId = undefined;
      return;
    }
    const payload =
      dataLines.length === 1 ? dataLines[0] : dataLines.join("\n");
    onEvent(eventName, payload, eventId);
    eventName = "message";
    eventId = undefined;
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
      } else if (line.startsWith("id:")) {
        eventId = line.slice(3).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      newlineIndex = buffer.indexOf("\n");
    }
  }
}

/** HTTP failure that keeps the status and parsed error body. */
export class SidecarRequestError extends Error {
  readonly status: number;
  readonly errorCode?: string;
  readonly body: unknown;

  constructor(operation: string, status: number, body: unknown) {
    super(`${operation} failed: ${status}`);
    this.name = "SidecarRequestError";
    this.status = status;
    this.body = body;
    if (body && typeof body === "object" && "error" in body) {
      const code = (body as { error?: unknown }).error;
      if (typeof code === "string" && code.trim()) {
        this.errorCode = code;
      }
    }
  }
}

async function sidecarRequestError(
  operation: string,
  response: Response,
): Promise<SidecarRequestError> {
  let body: unknown;
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  return new SidecarRequestError(operation, response.status, body);
}

export class LanglangbotSidecar {
  readonly baseUrl: string;
  readonly pluginToken?: string;
  readonly runtimeKind?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LanglangbotSidecarOptions) {
    this.baseUrl = normalizeBaseUrl(opts.baseUrl);
    this.pluginToken = opts.pluginToken;
    this.runtimeKind = opts.runtimeKind?.trim() || undefined;
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
    if (this.runtimeKind) {
      headers["x-langlangbot-runtime-kind"] = this.runtimeKind;
    }
    // Same-kind instance exclusivity: the sidecar records the first live PID
    // and 409s any other process of the paired kind.
    if (typeof process !== "undefined" && typeof process.pid === "number" && process.pid > 0) {
      headers["x-langlangbot-runtime-pid"] = String(process.pid);
    }
    return headers;
  }

  async health(): Promise<HealthStatus> {
    // Deliberately sends no auth / runtime-kind headers: /health is the
    // unauthenticated pairing-gate probe both plugins rely on before engaging.
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`health check failed: ${response.status}`);
    }
    return (await response.json()) as HealthStatus;
  }

  subscribeInbound(
    handler: InboundHandler | ((evt: InboundMessage) => void),
    onError?: (err: Error) => void,
  ): Unsubscribe;
  subscribeInbound(
    params: InboundSubscriptionParams,
    handler: InboundHandler | ((evt: InboundMessage) => void),
    onError?: (err: Error) => void,
  ): Unsubscribe;
  subscribeInbound(
    paramsOrOnMessage:
      | InboundSubscriptionParams
      | InboundHandler
      | ((evt: InboundMessage) => void),
    onMessageOrError?:
      | InboundHandler
      | ((evt: InboundMessage) => void)
      | ((err: Error) => void),
    onError?: (err: Error) => void,
  ): Unsubscribe {
    const hasParams =
      typeof paramsOrOnMessage !== "function" &&
      !isInboundHandler(paramsOrOnMessage);
    const params = hasParams ? paramsOrOnMessage : undefined;
    const handler = hasParams ? onMessageOrError : paramsOrOnMessage;
    const callbacks: InboundHandler = isInboundHandler(handler)
      ? handler
      : typeof handler === "function"
        ? { onMessage: handler as (evt: InboundMessage) => void }
        : {};
    const errorHandler =
      hasParams
        ? onError
        : typeof onMessageOrError === "function"
        ? (onMessageOrError as ((err: Error) => void) | undefined)
        : onError;
    const suffix = inboundQuerySuffix(params);
    return startReconnectingSse({
      errorLabel: "inbound SSE failed",
      onError: errorHandler,
      connect: (signal, lastEventId) =>
        this.fetchImpl(`${this.baseUrl}/v1/inbound/events${suffix}`, {
          headers: this.headers({
            accept: "text/event-stream",
            ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          }),
          signal,
        }),
      onData: (data, eventId) => {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (
            parsed.conversation_id &&
            parsed.message_id &&
            typeof parsed.text === "string" &&
            parsed.received_at
          ) {
            callbacks.onMessage?.({
              conversationId: String(parsed.conversation_id),
              messageId: String(parsed.message_id),
              text: String(parsed.text),
              parts: parseContentParts(parsed.parts),
              receivedAt: String(parsed.received_at),
              seq: eventId?.trim() || undefined,
              ownerSurfaceId:
                typeof parsed.owner_surface_id === "string"
                  ? parsed.owner_surface_id.trim() || undefined
                  : undefined,
            });
            return;
          }
          if (parsed.upload_id && parsed.attachment_id && parsed.conversation_id) {
            callbacks.onAttachmentReady?.({
              conversationId: String(parsed.conversation_id),
              messageId:
                parsed.message_id == null
                  ? undefined
                  : String(parsed.message_id),
              uploadId: String(parsed.upload_id),
              attachmentId: String(parsed.attachment_id),
              filename: String(parsed.filename ?? "attachment"),
              mime: String(parsed.mime ?? "application/octet-stream"),
              kind: String(parsed.kind ?? "file") as AttachmentKind,
              size: Number(parsed.size ?? 0),
              downloadUrl: String(parsed.download_url ?? ""),
              localPath:
                parsed.local_path == null
                  ? undefined
                  : String(parsed.local_path),
              readyAt: String(parsed.ready_at ?? new Date().toISOString()),
              seq: eventId?.trim() || undefined,
            });
            return;
          }
          if (
            parsed.upload_id &&
            parsed.conversation_id &&
            typeof parsed.reason === "string" &&
            parsed.attachment_id == null &&
            parsed.bytes_available == null
          ) {
            callbacks.onAttachmentFailed?.({
              conversationId: String(parsed.conversation_id),
              messageId:
                parsed.message_id == null
                  ? undefined
                  : String(parsed.message_id),
              uploadId: String(parsed.upload_id),
              filename: String(parsed.filename ?? "attachment"),
              mime: String(parsed.mime ?? "application/octet-stream"),
              kind: String(parsed.kind ?? "file") as AttachmentKind,
              size: Number(parsed.size ?? 0),
              reason: String(parsed.reason),
              failedAt: String(parsed.failed_at ?? new Date().toISOString()),
              seq: eventId?.trim() || undefined,
            });
            return;
          }
          if (
            parsed.upload_id &&
            parsed.conversation_id &&
            parsed.bytes_available != null &&
            parsed.local_path
          ) {
            callbacks.onAttachmentAvailable?.({
              conversationId: String(parsed.conversation_id),
              messageId:
                parsed.message_id == null
                  ? undefined
                  : String(parsed.message_id),
              uploadId: String(parsed.upload_id),
              filename: String(parsed.filename ?? "attachment"),
              mime: String(parsed.mime ?? "application/octet-stream"),
              kind: String(parsed.kind ?? "file") as AttachmentKind,
              bytesAvailable: Number(parsed.bytes_available ?? 0),
              size: Number(parsed.size ?? 0),
              localPath: String(parsed.local_path),
              streamable: Boolean(parsed.streamable),
              final: Boolean(parsed.final),
              updatedAt: String(parsed.updated_at ?? new Date().toISOString()),
              seq: eventId?.trim() || undefined,
            });
            return;
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

  /**
   * Claim one inbound message before starting a model turn.
   *
   * `accepted` is the first claim. `duplicate` means the sidecar already
   * owns the message, including after a crash between accept and the model
   * run — that message is not replayed, and the user sends it again.
   * Named seqs are deleted either way. Inbound `Last-Event-ID` is not an
   * inbound claim.
   */
  async acceptInbound(input: {
    conversationId: string;
    messageId: string;
    seqs: string[];
    accountId?: string;
  }): Promise<{ accepted: boolean; duplicate: boolean }> {
    const suffix = accountQuerySuffix(input.accountId);
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/inbound/accept${suffix}`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          conversation_id: input.conversationId,
          message_id: input.messageId,
          seqs: input.seqs,
        }),
      },
    );
    if (!response.ok) {
      throw await sidecarRequestError("acceptInbound", response);
    }
    const body = (await response.json()) as {
      accepted?: boolean;
      duplicate?: boolean;
    };
    return {
      accepted: body.accepted === true,
      duplicate: body.duplicate === true,
    };
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
      throw await sidecarRequestError("sendDelta", response);
    }
  }

  /** Report an agent turn phase for Operator conversation SSE (`agent_turn`). */
  async reportTurnPhase(
    conversationId: string,
    messageId: string,
    phase: AgentTurnPhase,
    detail?: string,
  ): Promise<void> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${conversationId}/outbound/turn`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          message_id: messageId,
          phase,
          ...(detail !== undefined ? { detail } : {}),
        }),
      },
    );
    if (!response.ok) {
      throw await sidecarRequestError("reportTurnPhase", response);
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
        kind: input.kind ?? undefined,
        host_version: input.hostVersion ?? undefined,
        adapter_version: input.adapterVersion ?? undefined,
        account_id: input.accountId,
        reason: input.reason,
        last_dispatch_error: input.lastDispatchError,
      }),
    });
    if (!response.ok) {
      // errorCode/status let callers detect the 409 runtime_mismatch verdict.
      throw await sidecarRequestError("updateAgentRuntimeStatus", response);
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
      throw await sidecarRequestError("registerApprovalPending", response);
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

  async listConversationTranscript(
    conversationId: string,
    opts?: { limit?: number; since?: string; maxAgeHours?: number },
  ): Promise<ConversationTranscript> {
    const params = new URLSearchParams();
    if (opts?.limit != null) {
      params.set("limit", String(opts.limit));
    }
    if (opts?.since) {
      params.set("since", opts.since);
    }
    if (opts?.maxAgeHours != null) {
      params.set("max_age_hours", String(opts.maxAgeHours));
    }
    const query = params.toString();
    const suffix = query ? `?${query}` : "";
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/transcript${suffix}`,
      {
        method: "GET",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      throw await sidecarRequestError("listConversationTranscript", response);
    }
    return (await response.json()) as ConversationTranscript;
  }

  async sendMessage(
    conversationId: string,
    text: string,
    messageId?: string,
    parts?: ContentPart[],
    proactive?: boolean,
  ): Promise<{ message_id: string }> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${conversationId}/outbound/message`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          text,
          message_id: messageId,
          parts: parts ?? [],
          ...(proactive ? { proactive: true } : {}),
        }),
      },
    );
    if (!response.ok) {
      throw await sidecarRequestError("sendMessage", response);
    }
    return (await response.json()) as { message_id: string };
  }

  subscribeManagementEvents(
    params: { accountId?: string } | undefined,
    onEvent: (evt: ManagementRequestEvent) => void,
    onError?: (err: Error) => void,
  ): Unsubscribe {
    const suffix = accountQuerySuffix(params?.accountId);
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
      const err = await sidecarRequestError("postManagementResult", response);
      // Older sidecars 404 after timeout; current ones return 200 accepted:false.
      if (err.status === 404 && err.errorCode === "request_not_found") {
        return;
      }
      throw err;
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

  async registerOutboundAttachment(
    conversationId: string,
    input: RegisterOutboundAttachmentInput,
    accountId = "default",
  ): Promise<RegisterOutboundAttachmentResult> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${conversationId}/outbound/attachments`,
      {
        method: "POST",
        headers: {
          ...this.headers(),
          "x-langlangbot-account-id": accountId,
        },
        body: JSON.stringify({
          local_path: input.localPath,
          filename: input.filename,
          mime: input.mime,
          sha256: input.sha256,
          status: input.status,
        }),
      },
    );
    if (!response.ok) {
      // The sidecar explains itself in the body (attachment_too_large,
      // content_mismatch with a reason, the offending path vs its media root).
      // A bare status code turns all of that into the same mystery 500.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `registerOutboundAttachment failed: ${response.status}${detail ? ` ${detail}` : ""}`,
      );
    }
    return (await response.json()) as RegisterOutboundAttachmentResult;
  }

  async markOutboundAttachmentReady(
    conversationId: string,
    attachmentId: string,
  ): Promise<{ attachment_id: string; status: string; download_url: string }> {
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/conversations/${conversationId}/outbound/attachments/${attachmentId}/ready`,
      {
        method: "POST",
        headers: this.headers(),
      },
    );
    if (!response.ok) {
      throw new Error(`markOutboundAttachmentReady failed: ${response.status}`);
    }
    return (await response.json()) as {
      attachment_id: string;
      status: string;
      download_url: string;
    };
  }
}
