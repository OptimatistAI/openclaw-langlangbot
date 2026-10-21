import assert from "node:assert/strict";
import test from "node:test";

import {
  createSingleFlight,
  createTurnLane,
  finalizeIdleTurn,
  isAgentTurnTerminalError,
  shouldReportTurnPhase,
  shouldStartAcceptedTurn,
} from "./turn-control.ts";

function httpError(status: number, errorCode: string): Error {
  return Object.assign(new Error(`sendMessage failed: ${status}`), {
    status,
    errorCode,
  });
}

test("overlapping idle calls send the final text before idle and only once", async () => {
  const order: string[] = [];
  let releaseSend: () => void = () => {};
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const lane = createTurnLane();
  let sentFinal = false;
  const finalize = createSingleFlight(async () => {
    await lane(async () => {
      if (!sentFinal) {
        sentFinal = true;
        order.push("send-start");
        await sendGate;
        order.push("send-done");
      }
      order.push("idle");
    });
  });

  const first = finalize();
  const second = finalize();
  await Promise.resolve();
  assert.deepEqual(order, ["send-start"]);
  releaseSend();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["send-start", "send-done", "idle"]);
});

test("a lane keeps idle behind an in-flight final send", async () => {
  const order: string[] = [];
  let releaseSend: () => void = () => {};
  const sendGate = new Promise<void>((resolve) => {
    releaseSend = resolve;
  });
  const lane = createTurnLane();
  const sending = lane(async () => {
    order.push("send-start");
    await sendGate;
    order.push("send-done");
  });
  const idle = lane(async () => {
    order.push("idle");
  });
  await Promise.resolve();
  assert.deepEqual(order, ["send-start"]);
  releaseSend();
  await Promise.all([sending, idle]);
  assert.deepEqual(order, ["send-start", "send-done", "idle"]);
});

test("structured 409 is idempotent and other failures stay real", async () => {
  const terminal = httpError(409, "agent_turn_terminal");
  const unavailable = httpError(503, "upstream_unavailable");
  assert.equal(isAgentTurnTerminalError(terminal), true);
  assert.equal(isAgentTurnTerminalError(unavailable), false);
  assert.equal(isAgentTurnTerminalError(new Error("sendMessage failed: 409")), false);

  const idle: string[] = [];
  const failures: string[] = [];
  const duplicates: string[] = [];
  await finalizeIdleTurn({
    sendFinal: async () => {
      throw terminal;
    },
    reportIdle: async () => {
      idle.push("idle");
    },
    onRealFailure: () => {
      failures.push("real");
    },
    onTerminalDuplicate: () => {
      duplicates.push("409");
    },
  });
  await finalizeIdleTurn({
    sendFinal: async () => {
      throw unavailable;
    },
    reportIdle: async () => {
      idle.push("idle");
    },
    onRealFailure: () => {
      failures.push("real");
    },
    onTerminalDuplicate: () => {
      duplicates.push("409");
    },
  });
  assert.deepEqual(idle, []);
  assert.deepEqual(duplicates, ["409"]);
  assert.deepEqual(failures, ["real"]);
});

test("turn phase posts once, then stays quiet after idle or failed", () => {
  assert.equal(shouldReportTurnPhase(undefined, { phase: "working" }), true);
  assert.equal(
    shouldReportTurnPhase({ phase: "working" }, { phase: "working" }),
    false,
  );
  assert.equal(
    shouldReportTurnPhase(
      { phase: "working", detail: "  " },
      { phase: "working" },
    ),
    false,
  );
  assert.equal(
    shouldReportTurnPhase(
      { phase: "tool", detail: "read" },
      { phase: "tool", detail: "write" },
    ),
    true,
  );
  assert.equal(
    shouldReportTurnPhase({ phase: "working" }, { phase: "failed", detail: "boom" }),
    true,
  );
  assert.equal(
    shouldReportTurnPhase({ phase: "working" }, { phase: "idle" }),
    true,
  );
  for (const phase of ["working", "tool", "thinking", "streaming", "idle", "failed"]) {
    assert.equal(
      shouldReportTurnPhase({ phase: "idle" }, { phase }),
      false,
      `idle blocks ${phase}`,
    );
    assert.equal(
      shouldReportTurnPhase({ phase: "failed", detail: "boom" }, { phase }),
      false,
      `failed blocks ${phase}`,
    );
  }
});

test("only the first accept starts a turn", () => {
  assert.equal(
    shouldStartAcceptedTurn({ accepted: true, duplicate: false }),
    true,
  );
  assert.equal(
    shouldStartAcceptedTurn({ accepted: false, duplicate: true }),
    false,
  );
});

test("attachment batch accept uses the whole seq set before dispatch", async () => {
  const accepted: string[][] = [];
  const dispatched: string[] = [];
  const acceptInbound = async (seqs: string[]) => {
    accepted.push(seqs);
    return { accepted: accepted.length === 1, duplicate: accepted.length > 1 };
  };
  const claim = async (messageId: string, seqs: string[]) => {
    const result = await acceptInbound(seqs);
    if (!shouldStartAcceptedTurn(result)) {
      return;
    }
    dispatched.push(messageId);
  };

  await claim("msg-1", ["1", "4", "5"]);
  await claim("msg-1", ["1", "4", "5"]);
  assert.deepEqual(dispatched, ["msg-1"]);
  assert.deepEqual(accepted, [
    ["1", "4", "5"],
    ["1", "4", "5"],
  ]);
});
