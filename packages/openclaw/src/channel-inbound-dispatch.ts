export type AgentDispatchRuntime = {
  session: {
    resolveStorePath: (store: unknown, opts: { agentId: string }) => string;
    recordInboundSession: unknown;
  };
  reply: {
    finalizeInboundContext: (ctx: Record<string, unknown>) => Record<string, unknown>;
    dispatchReplyWithBufferedBlockDispatcher: (opts: unknown) => unknown;
  };
};

export type RuntimeReadiness =
  | { ready: true; runtime: AgentDispatchRuntime; runInbound: InboundRunFn }
  | { ready: false; reason: string };

type InboundRunFn = (opts: unknown) => Promise<void>;

type RuntimeNamespaces = {
  inbound?: { run?: unknown };
  turn?: { run?: unknown };
};

export function resolveInboundRun(runtime: unknown): InboundRunFn | null {
  const candidate = runtime as RuntimeNamespaces | null | undefined;
  if (!candidate) {
    return null;
  }
  const inboundRun = candidate.inbound?.run;
  if (typeof inboundRun === "function") {
    return inboundRun.bind(candidate.inbound) as InboundRunFn;
  }
  const turnRun = candidate.turn?.run;
  if (typeof turnRun === "function") {
    return turnRun.bind(candidate.turn) as InboundRunFn;
  }
  return null;
}

export function inspectRuntime(runtime: unknown): RuntimeReadiness {
  const candidate = runtime as Partial<AgentDispatchRuntime> | null | undefined;
  if (!candidate) {
    return { ready: false, reason: "agent runtime is unavailable" };
  }
  const runInbound = resolveInboundRun(candidate);
  if (!runInbound) {
    return {
      ready: false,
      reason: "agent runtime is not ready (inbound.run and turn.run unavailable)",
    };
  }
  if (typeof candidate.reply?.finalizeInboundContext !== "function") {
    return {
      ready: false,
      reason: "agent runtime reply interface is not ready (finalizeInboundContext unavailable)",
    };
  }
  if (typeof candidate.reply?.dispatchReplyWithBufferedBlockDispatcher !== "function") {
    return {
      ready: false,
      reason: "agent runtime reply interface is not ready (dispatcher unavailable)",
    };
  }
  if (typeof candidate.session?.resolveStorePath !== "function") {
    return {
      ready: false,
      reason: "agent runtime session interface is not ready (resolveStorePath unavailable)",
    };
  }
  return { ready: true, runtime: candidate as AgentDispatchRuntime, runInbound };
}

export function resolveDispatchRuntimeFromSources(
  injected: unknown,
  plugin: unknown,
): unknown {
  if (resolveInboundRun(injected)) {
    return injected;
  }
  if (resolveInboundRun(plugin)) {
    return plugin;
  }
  return injected ?? plugin;
}

const RUNTIME_NOT_READY_MESSAGES: Record<string, string> = {
  "agent runtime is unavailable":
    "LangLangBot is connected, but the OpenClaw agent runtime is not available yet. " +
    "Restart the gateway and try again.",
  "agent runtime is not ready (inbound.run and turn.run unavailable)":
    "LangLangBot cannot reach the OpenClaw agent runtime on this gateway version. " +
    "Update @optimatist/langlangbot-openclaw to the latest release, then run " +
    "`openclaw gateway restart`.",
  "agent runtime reply interface is not ready (finalizeInboundContext unavailable)":
    "LangLangBot cannot dispatch replies because the OpenClaw reply runtime is unavailable. " +
    "Restart the gateway and verify your OpenClaw installation.",
  "agent runtime reply interface is not ready (dispatcher unavailable)":
    "LangLangBot cannot dispatch replies because the OpenClaw reply runtime is unavailable. " +
    "Restart the gateway and verify your OpenClaw installation.",
  "agent runtime session interface is not ready (resolveStorePath unavailable)":
    "LangLangBot cannot access the OpenClaw session store runtime. " +
    "Restart the gateway and verify your OpenClaw installation.",
};

export function runtimeNotReadyUserMessage(reason: string): string {
  return (
    RUNTIME_NOT_READY_MESSAGES[reason] ??
    "LangLangBot is connected, but the OpenClaw agent runtime is not ready yet. " +
      "Restart the gateway and try again."
  );
}
