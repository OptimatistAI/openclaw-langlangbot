import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_RUNTIME_KIND = "openclaw";
export const AGENT_RUNTIME_NAME = "OpenClaw";

type PackageJson = {
  name?: string;
  version?: string;
  openclaw?: {
    build?: {
      openclawVersion?: string;
    };
  };
};

export type HostVersionIo = {
  argv1?: string | null;
  readPackageJson?: (path: string) => PackageJson | null;
  runCliVersion?: () => string | null;
  declaredBuildVersion?: () => string | null;
  globalPackagePaths?: string[];
};

function nonEmptyTrim(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function readPackageJsonSync(path: string): PackageJson | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw err;
    }
    return null;
  }
}

function pluginPackageJson(): PackageJson | null {
  const here = dirname(fileURLToPath(import.meta.url));
  return readPackageJsonSync(join(here, "..", "package.json"));
}

function resolveAdapterVersion(): string {
  return nonEmptyTrim(pluginPackageJson()?.version) ?? "unknown";
}

/** Parse `OpenClaw 2026.5.7 (eeef486)` / `2026.7.1-2`. */
export function parseOpenclawCliVersion(text: string): string | null {
  const match = text.match(/\b(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\b/);
  return match?.[1] ?? null;
}

function versionFromOpenclawPackage(pkg: PackageJson | null): string | null {
  return pkg?.name === "openclaw" ? nonEmptyTrim(pkg.version) : null;
}

function resolveExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function versionFromNearestOpenclawPackage(
  startPath: string,
  readPackage: (path: string) => PackageJson | null,
): string | null {
  let dir = dirname(resolveExistingPath(startPath));
  for (let i = 0; i < 10; i += 1) {
    const version = versionFromOpenclawPackage(readPackage(join(dir, "package.json")));
    if (version) {
      return version;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

const DEFAULT_GLOBAL_PACKAGE_PATHS = [
  "/usr/lib/node_modules/openclaw/package.json",
  "/usr/local/lib/node_modules/openclaw/package.json",
];

/**
 * Running OpenClaw process version.
 * argv install → `/usr/lib/node_modules/openclaw` → `openclaw --version` →
 * plugin `openclaw.build.openclawVersion` (build target, last resort).
 */
export function resolveHostVersion(io: HostVersionIo = {}): string | null {
  const readPackage = io.readPackageJson ?? readPackageJsonSync;
  const argv1 = io.argv1 === undefined ? process.argv[1] : io.argv1;
  if (argv1) {
    const fromArgv = versionFromNearestOpenclawPackage(argv1, readPackage);
    if (fromArgv) {
      return fromArgv;
    }
  }

  for (const pkgPath of io.globalPackagePaths ?? DEFAULT_GLOBAL_PACKAGE_PATHS) {
    const fromGlobal = versionFromOpenclawPackage(readPackage(pkgPath));
    if (fromGlobal) {
      return fromGlobal;
    }
  }

  let fromCli: string | null = null;
  if (io.runCliVersion) {
    fromCli = io.runCliVersion();
  } else {
    try {
      fromCli = parseOpenclawCliVersion(
        execFileSync("openclaw", ["--version"], {
          encoding: "utf8",
          timeout: 4000,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      fromCli = null;
    }
  }
  if (fromCli) {
    return fromCli;
  }

  if (io.declaredBuildVersion) {
    return io.declaredBuildVersion();
  }
  return nonEmptyTrim(pluginPackageJson()?.openclaw?.build?.openclawVersion);
}

const CACHED_ADAPTER_VERSION = resolveAdapterVersion();
let cachedHostVersion: string | null | undefined;

export function adapterVersion(): string {
  return CACHED_ADAPTER_VERSION;
}

export function hostVersion(): string | null {
  if (cachedHostVersion === undefined) {
    cachedHostVersion = resolveHostVersion();
  }
  return cachedHostVersion;
}
