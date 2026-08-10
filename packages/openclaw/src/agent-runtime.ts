import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { buildLanglangbotSessionKey } from "./session-key.js";
import { formatError, type LanglangbotAccount } from "./config.js";
import { loadOpenclawSessionEntry, readJsonFile } from "./session-store.js";

export type AgentModelChoice = {
  id: string;
  name: string;
  provider: string;
  context_window?: number | null;
  reasoning?: boolean;
  multimodal?: boolean;
};

export type AgentSessionStatus = {
  session_key: string;
  agent_id: string;
  model?: string | null;
  model_provider?: string | null;
  context_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  total_tokens?: number | null;
  context_window_tokens?: number | null;
  remaining_tokens?: number | null;
  total_tokens_fresh?: boolean | null;
  multimodal?: boolean | null;
  measurement: "session_store" | "unknown";
};

type GatewayModelRow = {
  id?: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
};

type SessionRow = {
  key?: string;
  model?: string | null;
  modelProvider?: string | null;
  modelOverride?: string | null;
  providerOverride?: string | null;
  contextTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  totalTokensFresh?: boolean | null;
};

type PrivateSessionEntry = SessionRow & {
  updatedAt?: number | null;
  modelOverrideSource?: string | null;
  liveModelSwitchPending?: boolean | null;
};

type SelectedModelRecord = {
  model: string;
  provider?: string | null;
  updatedAt: number;
  source: "langlangbot-plugin";
};

type SelectedModelState = {
  version: 1;
  sessions: Record<string, SelectedModelRecord>;
};

type SelectedModel = {
  model: string | null;
  provider: string | null;
};

type SessionsListResult = {
  sessions?: SessionRow[];
  defaults?: {
    model?: string | null;
    modelProvider?: string | null;
    contextTokens?: number | null;
  };
};

type SessionsPatchResult = {
  ok?: boolean;
  key?: string;
  resolved?: {
    model?: string;
    modelProvider?: string;
  };
};

async function callGateway<T = Record<string, unknown>>(
  method: string,
  params?: unknown,
  scopes: string[] = ["operator.read"],
): Promise<T> {
  const mod = await import("openclaw/plugin-sdk/agent-harness-runtime");
  return mod.callGatewayTool<T>(method, {}, params, { scopes });
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function contextWindowFromCatalog(
  modelCatalog: AgentModelChoice[],
  modelRef?: string | null,
  modelProvider?: string | null,
): number | null {
  if (!modelRef) {
    return null;
  }
  const match =
    modelCatalog.find((row) => row.id === modelRef && (!modelProvider || row.provider === modelProvider)) ??
    modelCatalog.find((row) => row.id === modelRef);
  // listAgentModels() maps Gateway contextWindow -> context_window on AgentModelChoice.
  return asNumber(match?.context_window);
}

function resolveContextWindow(
  session: SessionRow,
  modelCatalog: AgentModelChoice[],
  selected: SelectedModel,
): number | null {
  const catalogWindow = contextWindowFromCatalog(
    modelCatalog,
    selected.model,
    selected.provider,
  );
  // Operator Bar shows the selected model; its context window must follow models.list,
  // not stale sessions.list contextTokens from the previous run/model.
  if (catalogWindow != null && selected.model) {
    return catalogWindow;
  }
  return asNumber(session.contextTokens);
}

function computeRemaining(
  contextWindow: number | null,
  totalTokens: number | null,
): number | null {
  if (contextWindow == null || totalTokens == null) {
    return null;
  }
  return Math.max(0, contextWindow - totalTokens);
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function selectedModelStatePath(): string {
  return process.env.LANGLANGBOT_OPENCLAW_MODEL_STATE_PATH
    ?? join(homedir(), ".openclaw", "langlangbot-agent-runtime-model-state.json");
}

async function loadPrivateSessionEntry(sessionKey: string): Promise<PrivateSessionEntry | null> {
  return loadOpenclawSessionEntry<PrivateSessionEntry>(sessionKey);
}

async function loadSelectedModelState(): Promise<SelectedModelState> {
  const state = await readJsonFile<SelectedModelState>(selectedModelStatePath());
  if (state?.version === 1 && state.sessions && typeof state.sessions === "object") {
    return state;
  }
  return { version: 1, sessions: {} };
}

async function saveSelectedModelState(state: SelectedModelState): Promise<void> {
  const path = selectedModelStatePath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}
`, "utf8");
  await rename(tmp, path);
}

async function persistSelectedModel(
  sessionKey: string,
  selection: SelectedModel,
): Promise<void> {
  if (!selection.model) {
    return;
  }
  const state = await loadSelectedModelState();
  state.sessions[sessionKey] = {
    model: selection.model,
    provider: selection.provider,
    updatedAt: Date.now(),
    source: "langlangbot-plugin",
  };
  await saveSelectedModelState(state);
}

function modelSupportsImageInput(row?: Pick<GatewayModelRow, "input"> | Pick<AgentModelChoice, "multimodal"> | null): boolean {
  if (!row) {
    return false;
  }
  if ("multimodal" in row && row.multimodal === true) {
    return true;
  }
  return Array.isArray((row as GatewayModelRow).input) && (row as GatewayModelRow).input!.includes("image");
}

function isMultimodalModel(
  modelCatalog: AgentModelChoice[],
  model?: string | null,
  provider?: string | null,
): boolean {
  if (!model) {
    return false;
  }
  const entry =
    modelCatalog.find((row) => row.id === model && (!provider || row.provider === provider)) ??
    modelCatalog.find((row) => row.id === model);
  return entry?.multimodal === true;
}

function providerForModel(modelCatalog: GatewayModelRow[], model?: string | null): string | null {
  if (!model) {
    return null;
  }
  return cleanString(modelCatalog.find((row) => row.id === model)?.provider);
}

function resolveOverrideModel(entry?: Pick<PrivateSessionEntry, "modelOverride" | "providerOverride"> | null): SelectedModel | null {
  const model = cleanString(entry?.modelOverride);
  if (!model) {
    return null;
  }
  return { model, provider: cleanString(entry?.providerOverride) };
}

function resolveOfficialSessionListModel(params: {
  session: SessionRow | null;
  defaults: SessionsListResult["defaults"];
  modelCatalog: GatewayModelRow[];
}): SelectedModel {
  const rowModel = cleanString(params.session?.model);
  if (rowModel) {
    return {
      model: rowModel,
      provider: cleanString(params.session?.modelProvider) ?? providerForModel(params.modelCatalog, rowModel),
    };
  }

  const defaultModel = cleanString(params.defaults?.model);
  if (defaultModel) {
    return {
      model: defaultModel,
      provider: cleanString(params.defaults?.modelProvider) ?? providerForModel(params.modelCatalog, defaultModel),
    };
  }

  return { model: null, provider: null };
}

function selectionsMatch(left: SelectedModel, right: SelectedModel | null): boolean {
  if (!right?.model) {
    return true;
  }
  if (left.model !== right.model) {
    return false;
  }
  return !left.provider || !right.provider || left.provider === right.provider;
}

function resolveSelectedModel(params: {
  sessionKey: string;
  session: SessionRow | null;
  defaults: SessionsListResult["defaults"];
  modelCatalog: GatewayModelRow[];
  privateEntry: PrivateSessionEntry | null;
  pluginState: SelectedModelState;
}): SelectedModel {
  const officialSelection = resolveOfficialSessionListModel(params);
  const privateOverride = resolveOverrideModel(params.privateEntry);

  // Prefer the official OpenClaw Gateway projection whenever it agrees with the
  // selected-model evidence we can observe. Newer OpenClaw builds (see upstream
  // PR #27735 and later session-list fixes) make sessions.list represent the
  // model that would be used for the next run: override first, otherwise the
  // resolved default, not the historical last-run runtime model.
  if (privateOverride) {
    const selection = {
      model: privateOverride.model,
      provider: privateOverride.provider ?? providerForModel(params.modelCatalog, privateOverride.model),
    };
    return selectionsMatch(officialSelection, selection) ? officialSelection : selection;
  }

  // OpenClaw 2026.5.x clears override fields when switching back to the default
  // and may still leave sessions.list showing the stale last-run model. Treat a
  // live switch with no private override as selected default evidence.
  if (params.privateEntry?.liveModelSwitchPending === true) {
    const defaultModel = cleanString(params.defaults?.model);
    if (defaultModel) {
      const selection = {
        model: defaultModel,
        provider: cleanString(params.defaults?.modelProvider) ?? providerForModel(params.modelCatalog, defaultModel),
      };
      if (!selectionsMatch(officialSelection, selection)) {
        return selection;
      }
    }
  }

  // Compatibility note: OpenClaw 2026.5.x persists modelOverride/providerOverride
  // in ~/.openclaw/agents/<agent>/sessions/sessions.json but its Gateway
  // sessions.list row omits those fields, so plugins cannot see a freshly
  // selected non-default model. It can also show a stale last-run model after
  // switching back to the default (because default selection clears overrides).
  // langlangbot records successful set_model calls as a plugin-owned fallback;
  // use it only when it is not older than the OpenClaw session store and the
  // official sessions.list projection disagrees. Remove this compatibility
  // layer once the deployed OpenClaw exposes selected/effective model metadata
  // through sessions.list.
  const pluginSelection = params.pluginState.sessions[params.sessionKey];
  const storeUpdatedAt = asNumber(params.privateEntry?.updatedAt) ?? 0;
  if (pluginSelection && pluginSelection.updatedAt >= storeUpdatedAt) {
    const selection = {
      model: pluginSelection.model,
      provider: cleanString(pluginSelection.provider) ?? providerForModel(params.modelCatalog, pluginSelection.model),
    };
    if (!selectionsMatch(officialSelection, selection)) {
      return selection;
    }
  }

  return officialSelection;
}

export async function listAgentModels(
  scopes: string[] = ["operator.read"],
): Promise<{
  models: AgentModelChoice[];
  default_model?: string | null;
}> {
  const body = await callGateway<{ models?: GatewayModelRow[] }>("models.list", {}, scopes);
  const models = (body.models ?? [])
    .filter((row) => typeof row.id === "string" && typeof row.provider === "string")
    .map((row) => ({
      id: row.id!,
      name: typeof row.name === "string" ? row.name : row.id!,
      provider: row.provider!,
      context_window: asNumber(row.contextWindow),
      reasoning: row.reasoning === true,
      multimodal: modelSupportsImageInput(row),
    }));
  return { models };
}

async function loadSessionState(
  sessionKey: string,
  scopes: string[] = ["operator.read"],
): Promise<{
  session: SessionRow | null;
  defaults: SessionsListResult["defaults"];
}> {
  const list = await callGateway<SessionsListResult>(
    "sessions.list",
    {
      limit: 1,
      search: sessionKey,
    },
    scopes,
  );
  const exact = (list.sessions ?? []).find((row) => row.key === sessionKey) ?? null;
  return { session: exact, defaults: list.defaults };
}

export async function getAgentSessionStatus(params: {
  accountId: string;
  conversationId: string;
  agentId: string;
  scopes?: string[];
}): Promise<AgentSessionStatus> {
  const sessionKey = buildLanglangbotSessionKey(params);
  const scopes = params.scopes?.length ? params.scopes : ["operator.read"];
  const [{ models: modelCatalog }, sessionState, privateEntry, pluginState] = await Promise.all([
    listAgentModels(scopes),
    loadSessionState(sessionKey, scopes),
    loadPrivateSessionEntry(sessionKey),
    loadSelectedModelState(),
  ]);
  const { session, defaults } = sessionState;
  const selection = resolveSelectedModel({
    sessionKey,
    session,
    defaults,
    modelCatalog,
    privateEntry,
    pluginState,
  });
  const model = selection.model;
  const modelProvider = selection.provider;
  const totalTokens = asNumber(session?.totalTokens);
  const contextWindow = resolveContextWindow(
    session ?? {},
    modelCatalog,
    { model, provider: modelProvider },
  );

  return {
    session_key: sessionKey,
    agent_id: params.agentId,
    model,
    model_provider: modelProvider,
    context_tokens: asNumber(session?.contextTokens),
    input_tokens: asNumber(session?.inputTokens),
    output_tokens: asNumber(session?.outputTokens),
    total_tokens: totalTokens,
    context_window_tokens: contextWindow,
    remaining_tokens: computeRemaining(contextWindow, totalTokens),
    total_tokens_fresh:
      typeof session?.totalTokensFresh === "boolean"
        ? session.totalTokensFresh
        : null,
    multimodal: isMultimodalModel(modelCatalog, model, modelProvider),
    measurement: session ? "session_store" : "unknown",
  };
}

export async function setAgentSessionModel(params: {
  accountId: string;
  conversationId: string;
  agentId: string;
  model: string;
  scopes?: string[];
}): Promise<{
  session_key: string;
  model: string;
  model_provider?: string | null;
  scope: "session";
}> {
  const sessionKey = buildLanglangbotSessionKey(params);
  const requestedModel = params.model.trim();
  const [body, { models: modelCatalog }] = await Promise.all([
    callGateway<SessionsPatchResult>(
      "sessions.patch",
      {
        key: sessionKey,
        model: requestedModel,
      },
      params.scopes?.length ? params.scopes : ["operator.admin"],
    ),
    listAgentModels(),
  ]);
  const selectedModel = body.resolved?.model ?? requestedModel;
  const selectedProvider = body.resolved?.modelProvider ?? providerForModel(modelCatalog, selectedModel);
  await persistSelectedModel(sessionKey, { model: selectedModel, provider: selectedProvider });
  return {
    session_key: sessionKey,
    model: selectedModel,
    model_provider: selectedProvider,
    scope: "session",
  };
}

export type ManagementRequestPayload = {
  request_id: string;
  conversation_id: string;
  operation: string;
  scopes?: string[];
  model?: string;
};

export async function handleManagementRequest(
  payload: ManagementRequestPayload,
  account: LanglangbotAccount,
): Promise<Record<string, unknown>> {
  const conversationId = payload.conversation_id;
  switch (payload.operation) {
    case "status":
      return getAgentSessionStatus({
        accountId: account.accountId,
        conversationId,
        agentId: account.agentId,
        scopes: payload.scopes,
      });
    case "models":
      return listAgentModels(payload.scopes?.length ? payload.scopes : ["operator.read"]);
    case "set_model": {
      const model = payload.model?.trim();
      if (!model) {
        throw new Error("model is required for set_model");
      }
      return setAgentSessionModel({
        accountId: account.accountId,
        conversationId,
        agentId: account.agentId,
        model,
        scopes: payload.scopes,
      });
    }
    default:
      throw new Error(`unknown management operation: ${payload.operation}`);
  }
}

/**
 * FIXME(openclaw-upstream): Remove once OpenClaw fixes session_status context window
 * fallback (2e5 / 200k) and aligns token stats with sessions.list
 * (openclaw/openclaw#92760, openclaw/openclaw#70692).
 */
export function formatOperatorRuntimeStatusForAgent(
  status: AgentSessionStatus,
): Record<string, unknown> {
  const used =
    status.total_tokens != null
      ? status.total_tokens
      : status.input_tokens != null
        ? status.input_tokens
        : null;
  const window = status.context_window_tokens ?? null;
  const percent =
    used != null && window != null && window > 0
      ? Math.round((used / window) * 100)
      : null;

  return {
    session_key: status.session_key,
    model: status.model,
    model_provider: status.model_provider,
    context_used_tokens: used,
    context_window_tokens: window,
    context_usage_percent: percent,
    total_tokens: status.total_tokens,
    input_tokens: status.input_tokens,
    output_tokens: status.output_tokens,
    remaining_tokens: status.remaining_tokens,
    total_tokens_fresh: status.total_tokens_fresh,
    multimodal: status.multimodal,
    measurement: status.measurement,
    source: "session_store",
    operator_runtime_bar_aligned: true,
    guidance:
      "Use these values when answering Operator questions about context usage. " +
      "Do not cite session_status Context lines with /200k fallback.",
  };
}

export function managementErrorPayload(err: unknown): {
  code: string;
  message: string;
} {
  const message = formatError(err);
  if (message.includes("Gateway method")) {
    return {
      code: "runtime_unavailable",
      message,
    };
  }
  if (message.includes("invalid") || message.includes("required")) {
    return {
      code: "invalid_request",
      message,
    };
  }
  return {
    code: "openclaw_error",
    message,
  };
}
