import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { formatError } from "./config.js";
import { tryGetLanglangbotRuntime } from "./runtime.js";
import { agentIdFromSessionKey } from "./session-key.js";

type AgentSessionRuntime = {
  session?: {
    resolveStorePath?: (store: unknown, opts: { agentId: string }) => string;
  };
};

type SessionStoreCacheEntry = {
  mtimeMs: number;
  store: Record<string, unknown>;
};

const sessionStoreCache = new Map<string, SessionStoreCacheEntry>();

let openclawSessionStoreConfig: unknown;

export function getOpenclawSessionStoreConfig(): unknown {
  return openclawSessionStoreConfig;
}

export function setOpenclawSessionStoreConfig(store: unknown): void {
  openclawSessionStoreConfig = store;
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new Error(`invalid JSON in ${path}: ${formatError(err)}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export function resolveOpenclawSessionStorePath(sessionKey: string): string {
  const agentId = agentIdFromSessionKey(sessionKey);
  const channel = tryGetLanglangbotRuntime()?.channel as AgentSessionRuntime | undefined;
  const resolveStorePath = channel?.session?.resolveStorePath;
  if (resolveStorePath) {
    return resolveStorePath(openclawSessionStoreConfig, { agentId });
  }
  return join(homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
}

async function loadSessionStore(storePath: string): Promise<Record<string, unknown>> {
  let fileStat: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    fileStat = await stat(storePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }

  const cached = sessionStoreCache.get(storePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs) {
    return cached.store;
  }

  const store = (await readJsonFile<Record<string, unknown>>(storePath)) ?? {};
  sessionStoreCache.set(storePath, { mtimeMs: fileStat.mtimeMs, store });
  return store;
}

export async function loadOpenclawSessionEntry<T extends Record<string, unknown>>(
  sessionKey: string,
): Promise<T | null> {
  const storePath = resolveOpenclawSessionStorePath(sessionKey);
  const store = await loadSessionStore(storePath);
  const entry = store[sessionKey];
  return entry && typeof entry === "object" ? (entry as T) : null;
}
