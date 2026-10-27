import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Pin the wiring as text: gateway.ts pulls in the whole OpenClaw plugin
// runtime, and losing the hook is invisible to behavioural tests until a real
// sidecar restarts. The connector test covers hook invocation; the E2E check
// covers this wiring against a restarted sidecar.
const source = readFileSync(new URL("./gateway.ts", import.meta.url), "utf8");

test("inbound SSE reconnects re-report runtime status", () => {
  assert.match(
    source,
    /subscribeInbound\([\s\S]*?onReconnect:\s*\(\)\s*=>\s*\{\s*reportRuntimeStatusAfterReconnect\(\);/,
  );
});
