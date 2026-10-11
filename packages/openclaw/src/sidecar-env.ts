export function parseSidecarEnvFile(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function overlaySidecarEnv(
  env: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const [key, value] of Object.entries(fileEnv)) {
    next[key] = value;
  }
  return next;
}

export function shouldTakeOverExternalSidecar(opts: {
  refCount: number;
  hasManagedChild: boolean;
  healthy: boolean;
}): boolean {
  return opts.refCount > 0 && !opts.hasManagedChild && !opts.healthy;
}
