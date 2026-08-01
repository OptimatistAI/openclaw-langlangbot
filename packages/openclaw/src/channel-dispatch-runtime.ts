import { getLanglangbotRuntime, tryGetLanglangbotRuntime } from "./runtime.js";
import {
  inspectRuntime,
  resolveInboundRun,
  type RuntimeReadiness,
} from "./channel-inbound-dispatch.js";

export { runtimeNotReadyUserMessage, type RuntimeReadiness } from "./channel-inbound-dispatch.js";

function pluginChannelRuntime(): unknown {
  try {
    return getLanglangbotRuntime().channel;
  } catch {
    return tryGetLanglangbotRuntime()?.channel;
  }
}

export function resolveDispatchRuntime(ctx: {
  channelRuntime?: unknown;
}): unknown {
  const injected = ctx.channelRuntime;
  if (resolveInboundRun(injected)) {
    return injected;
  }
  const plugin = pluginChannelRuntime();
  return resolveInboundRun(plugin) ? plugin : (injected ?? plugin);
}

export function runtimeReadiness(ctx: {
  channelRuntime?: unknown;
}): RuntimeReadiness {
  return inspectRuntime(resolveDispatchRuntime(ctx));
}
