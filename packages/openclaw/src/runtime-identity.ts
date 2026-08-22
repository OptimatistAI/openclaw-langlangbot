import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_RUNTIME_KIND = "openclaw";
export const AGENT_RUNTIME_NAME = "OpenClaw";

type PackageJson = {
  version?: string;
  openclaw?: {
    build?: {
      openclawVersion?: string;
    };
  };
};

function readPackageJsonSync(path: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

function pluginPackageJson(): PackageJson | null {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/runtime-identity.js → ../package.json; src/ during tests → ../package.json
  return readPackageJsonSync(join(here, "..", "package.json"));
}

function resolveAdapterVersion(): string {
  const version = pluginPackageJson()?.version?.trim();
  return version && version.length > 0 ? version : "unknown";
}

function resolveHostVersion(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("openclaw/package.json");
    const version = readPackageJsonSync(pkgPath)?.version?.trim();
    if (version) {
      return version;
    }
  } catch {
    // openclaw may be external / not resolvable from the bundled plugin.
  }
  const fallback = pluginPackageJson()?.openclaw?.build?.openclawVersion?.trim();
  return fallback && fallback.length > 0 ? fallback : null;
}

// Versions are process-static; cache after first resolve (status is polled often).
const CACHED_ADAPTER_VERSION = resolveAdapterVersion();
const CACHED_HOST_VERSION = resolveHostVersion();

/** `@optimatist/langlangbot-openclaw` package version. */
export function adapterVersion(): string {
  return CACHED_ADAPTER_VERSION;
}

/**
 * Best-effort OpenClaw host version from the installed `openclaw` package,
 * falling back to the plugin's declared build target.
 */
export function hostVersion(): string | null {
  return CACHED_HOST_VERSION;
}
