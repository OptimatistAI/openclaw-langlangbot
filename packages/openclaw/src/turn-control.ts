/** Serialize outbound work for one turn so idle cannot pass an in-flight send. */
export function createTurnLane(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

/** One shared idle finalizer. Later callers reuse the same promise. */
export function createSingleFlight(
  run: () => Promise<void>,
): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= run().then(
      () => undefined,
      () => undefined,
    );
    return pending;
  };
}

export function isAgentTurnTerminalError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as { status?: unknown; errorCode?: unknown };
  return candidate.status === 409 && candidate.errorCode === "agent_turn_terminal";
}

/**
 * Start a model turn only for the first durable accept.
 * A duplicate claim, including one recorded before a crash, must not dispatch.
 */
export function shouldStartAcceptedTurn(result: {
  accepted: boolean;
  duplicate: boolean;
}): boolean {
  return result.accepted && !result.duplicate;
}

/**
 * Send or refresh the final output, then report idle.
 * A structured 409 `agent_turn_terminal` is an idempotent repeat.
 * Other failures are reported and never rejected to the host.
 */
export async function finalizeIdleTurn(input: {
  sendFinal?: () => Promise<void>;
  reportIdle: () => Promise<void>;
  onRealFailure: (err: unknown) => void;
  onTerminalDuplicate?: (err: unknown) => void;
}): Promise<void> {
  try {
    if (input.sendFinal) {
      await input.sendFinal();
    }
    await input.reportIdle();
  } catch (err) {
    if (isAgentTurnTerminalError(err)) {
      input.onTerminalDuplicate?.(err);
      return;
    }
    input.onRealFailure(err);
  }
}
