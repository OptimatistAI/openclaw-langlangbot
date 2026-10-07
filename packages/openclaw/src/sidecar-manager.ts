import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createLanglangbotSidecar,
  formatError,
  type LanglangbotAccount,
  type SidecarLog,
} from "./config.js";
import { DEFAULT_SIDECAR_PORT } from "./defaults.js";
import {
  overlaySidecarEnv,
  parseSidecarEnvFile,
  shouldTakeOverExternalSidecar,
} from "./sidecar-env.js";

type ManagedEntry = {
  child: ChildProcess;
  bind: string;
  refCount: number;
  account: LanglangbotAccount;
};

type ExternalWatch = {
  refCount: number;
  account: LanglangbotAccount;
  log?: SidecarLog;
  timer?: ReturnType<typeof setInterval>;
  inFlight?: Promise<void>;
};

const managedByUrl = new Map<string, ManagedEntry>();
const startInFlight = new Map<string, Promise<void>>();
const externalWatchByUrl = new Map<string, ExternalWatch>();
export const EXTERNAL_HEALTH_WATCH_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveSidecarPort(parsed: URL): string {
  return parsed.port || (parsed.protocol === "https:" ? "443" : DEFAULT_SIDECAR_PORT);
}

export function parseSidecarBind(sidecarUrl: string): string {
  const parsed = new URL(sidecarUrl);
  const host = parsed.hostname || "127.0.0.1";
  return `${host}:${resolveSidecarPort(parsed)}`;
}

export function defaultSidecarBind(sidecarUrl: string): string {
  return `0.0.0.0:${resolveSidecarPort(new URL(sidecarUrl))}`;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadEnvFile(filePath: string): Promise<Record<string, string>> {
  return parseSidecarEnvFile(await readFile(filePath, "utf8"));
}

async function resolveLanglangbotBinary(explicit?: string): Promise<string> {
  if (explicit?.trim()) {
    const binary = explicit.trim();
    if (!(await fileExists(binary))) {
      throw new Error(`langlangbot binary not found: ${binary}`);
    }
    return binary;
  }

  const fromEnv = process.env.LANGLANGBOT_BINARY?.trim();
  if (fromEnv && (await fileExists(fromEnv))) {
    return fromEnv;
  }

  const candidates = [
    "/usr/local/bin/langlangbot",
    `${homedir()}/.local/bin/langlangbot`,
    `${homedir()}/.cargo/bin/langlangbot`,
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  const pluginRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
  );
  const release = path.join(pluginRoot, "target", "release", "langlangbot");
  const debug = path.join(pluginRoot, "target", "debug", "langlangbot");
  if (await fileExists(release)) {
    return release;
  }
  if (await fileExists(debug)) {
    return debug;
  }

  throw new Error(
    "langlangbot binary not found. Install via https://optimatist.ai/langlangbot/install.sh, set channels.langlangbot.sidecarBinary, or set LANGLANGBOT_BINARY.",
  );
}

async function buildChildEnv(account: LanglangbotAccount): Promise<NodeJS.ProcessEnv> {
  // Rebuild on every spawn. ~/.langlangbot/env is the persistent source and
  // must overwrite a stale LANGLANGBOT_SURFACE_ID inherited from the plugin.
  let env: NodeJS.ProcessEnv = { ...process.env };
  env.LANGLANGBOT_BIND ||= defaultSidecarBind(account.sidecarUrl);
  if (account.pluginToken) {
    env.LANGLANGBOT_PLUGIN_TOKEN = account.pluginToken;
  }

  const defaultEnvPath = path.join(homedir(), ".langlangbot", "env");
  const explicitEnvPath = account.sidecarEnvPath?.trim();
  const envPath =
    explicitEnvPath || ((await fileExists(defaultEnvPath)) ? defaultEnvPath : undefined);
  if (envPath) {
    env = overlaySidecarEnv(env, await loadEnvFile(envPath));
  }

  return env;
}

async function waitForHealth(
  account: LanglangbotAccount,
  timeoutMs: number,
): Promise<void> {
  const sidecar = createLanglangbotSidecar(account);
  const deadline = Date.now() + timeoutMs;
  let lastError = "unknown";
  while (Date.now() < deadline) {
    try {
      await sidecar.health();
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      await sleep(400);
    }
  }
  throw new Error(
    `LangLangBot did not become healthy at ${account.sidecarUrl} within ${timeoutMs}ms: ${lastError}`,
  );
}

async function isSidecarHealthy(account: LanglangbotAccount): Promise<boolean> {
  const sidecar = createLanglangbotSidecar(account);
  try {
    await sidecar.health();
    return true;
  } catch {
    return false;
  }
}

async function restartManagedSidecarAfterExit(
  account: LanglangbotAccount,
  refCount: number,
  log?: SidecarLog,
): Promise<void> {
  if (refCount <= 0) {
    return;
  }
  await sleep(400);
  if (managedByUrl.has(account.sidecarUrl)) {
    return;
  }
  if (await isSidecarHealthy(account)) {
    return;
  }
  try {
    log?.info?.("[langlangbot] restarting managed sidecar after exit");
    await startManagedSidecar(account, log);
    const entry = managedByUrl.get(account.sidecarUrl);
    if (entry) {
      entry.refCount = refCount;
    }
  } catch (err) {
    log?.warn?.(
      `[langlangbot] restart after exit failed: ${formatError(err)}`,
    );
  }
}

function pipeChildLogs(child: ChildProcess, log?: SidecarLog, prefix = "langlangbot"): void {
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      log?.info?.(`[${prefix}] ${text}`);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      log?.warn?.(`[${prefix}] ${text}`);
    }
  });
}

function retainExternalWatch(account: LanglangbotAccount, log?: SidecarLog): void {
  const existing = externalWatchByUrl.get(account.sidecarUrl);
  if (existing) {
    existing.refCount += 1;
    existing.account = account;
    existing.log = log;
    return;
  }
  const entry: ExternalWatch = { refCount: 1, account, log };
  externalWatchByUrl.set(account.sidecarUrl, entry);
  startExternalHealthWatch(entry);
}

function startExternalHealthWatch(entry: ExternalWatch): void {
  if (entry.timer) {
    return;
  }
  entry.timer = setInterval(() => {
    if (entry.inFlight) {
      return;
    }
    entry.inFlight = maybeTakeOverExternalSidecar(entry).finally(() => {
      entry.inFlight = undefined;
    });
  }, EXTERNAL_HEALTH_WATCH_MS);
}

async function maybeTakeOverExternalSidecar(entry: ExternalWatch): Promise<void> {
  const url = entry.account.sidecarUrl;
  const healthy = await isSidecarHealthy(entry.account);
  if (
    !shouldTakeOverExternalSidecar({
      refCount: entry.refCount,
      hasManagedChild: managedByUrl.has(url),
      healthy,
    })
  ) {
    return;
  }
  try {
    entry.log?.info?.("[langlangbot] external sidecar left; supervisor taking over");
    await startManagedSidecar(entry.account, entry.log);
    const managed = managedByUrl.get(url);
    if (managed) {
      managed.refCount = entry.refCount;
    }
    stopExternalWatch(url);
  } catch (err) {
    entry.log?.warn?.(
      `[langlangbot] supervisor takeover after external reload failed: ${formatError(err)}`,
    );
  }
}

function stopExternalWatch(url: string): void {
  const entry = externalWatchByUrl.get(url);
  if (!entry) {
    return;
  }
  if (entry.timer) {
    clearInterval(entry.timer);
  }
  externalWatchByUrl.delete(url);
}

function releaseExternalWatch(account: LanglangbotAccount): void {
  const entry = externalWatchByUrl.get(account.sidecarUrl);
  if (!entry) {
    return;
  }
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    return;
  }
  stopExternalWatch(account.sidecarUrl);
}

/**
 * Ensure LangLangBot is listening at account.sidecarUrl.
 * When autoStartSidecar is true (default), spawns the binary if /health is down.
 */
export async function ensureLanglangbotSidecar(
  account: LanglangbotAccount,
  log?: SidecarLog,
): Promise<{ startedByPlugin: boolean }> {
  if (await isSidecarHealthy(account)) {
    const managed = managedByUrl.get(account.sidecarUrl);
    if (managed) {
      managed.refCount += 1;
    } else {
      retainExternalWatch(account, log);
    }
    return { startedByPlugin: false };
  }

  if (!account.autoStartSidecar) {
    throw new Error(
      `LangLangBot is not reachable at ${account.sidecarUrl}. Start it manually or set channels.langlangbot.autoStartSidecar to true.`,
    );
  }

  const urlKey = account.sidecarUrl;
  const existing = managedByUrl.get(urlKey);
  if (existing) {
    existing.refCount += 1;
    await waitForHealth(account, 15_000);
    return { startedByPlugin: true };
  }

  let inflight = startInFlight.get(urlKey);
  if (!inflight) {
    inflight = startManagedSidecar(account, log);
    startInFlight.set(urlKey, inflight);
  }
  try {
    await inflight;
  } finally {
    if (startInFlight.get(urlKey) === inflight) {
      startInFlight.delete(urlKey);
    }
  }

  const entry = managedByUrl.get(urlKey);
  if (entry) {
    entry.refCount += 1;
  }

  return { startedByPlugin: true };
}

async function startManagedSidecar(
  account: LanglangbotAccount,
  log?: SidecarLog,
): Promise<void> {
  const urlKey = account.sidecarUrl;
  if (managedByUrl.has(urlKey)) {
    return;
  }

  const binary = await resolveLanglangbotBinary(account.sidecarBinary);
  const env = await buildChildEnv(account);
  const bind = env.LANGLANGBOT_BIND ?? defaultSidecarBind(account.sidecarUrl);

  log?.info?.(`[langlangbot] starting ${binary} (LANGLANGBOT_BIND=${bind})`);

  const child = spawn(binary, [], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  if (!child.pid) {
    throw new Error("failed to spawn langlangbot process");
  }

  pipeChildLogs(child, log);

  child.on("exit", (code, signal) => {
    const entry = managedByUrl.get(urlKey);
    managedByUrl.delete(urlKey);
    if (code !== 0 && code !== null) {
      log?.warn?.(
        `[langlangbot] process exited code=${code} signal=${signal ?? ""}`,
      );
    } else {
      log?.info?.(
        `[langlangbot] managed process exited code=${code ?? "null"} signal=${signal ?? ""}`,
      );
    }
    if (entry) {
      void restartManagedSidecarAfterExit(entry.account, entry.refCount, log);
    }
  });

  managedByUrl.set(urlKey, { child, bind, refCount: 0, account });

  await waitForHealth(account, account.sidecarStartTimeoutMs);
  log?.info?.(`[langlangbot] healthy at ${account.sidecarUrl}`);
}

/** Stop a LangLangBot process started by this plugin when the last gateway account releases it. */
export function releaseLanglangbotSidecar(
  account: LanglangbotAccount,
  log?: SidecarLog,
): void {
  releaseExternalWatch(account);
  const entry = managedByUrl.get(account.sidecarUrl);
  if (!entry) {
    return;
  }
  entry.refCount -= 1;
  if (entry.refCount > 0) {
    return;
  }
  managedByUrl.delete(account.sidecarUrl);
  log?.info?.(`[langlangbot] stopping managed process (bind ${entry.bind})`);
  try {
    entry.child.kill("SIGTERM");
  } catch (err) {
    log?.warn?.(`[langlangbot] failed to stop process: ${formatError(err)}`);
  }
}
