import assert from "node:assert/strict";
import test from "node:test";

import { OWN_RUNTIME_KIND, shouldEngageSidecar } from "./pairing-gate.ts";

test("unpaired sidecars keep the legacy engaged behavior", () => {
  for (const paired of [null, undefined, "", "   "]) {
    assert.deepEqual(shouldEngageSidecar(paired), { engage: true });
  }
});

test("matching paired kind engages, case-insensitively", () => {
  assert.deepEqual(shouldEngageSidecar("openclaw"), { engage: true });
  assert.deepEqual(shouldEngageSidecar("OpenClaw"), { engage: true });
  assert.deepEqual(shouldEngageSidecar("  openclaw "), { engage: true });
  assert.equal(OWN_RUNTIME_KIND, "openclaw");
});

test("explicit own kind decides the match (gateway passes AGENT_RUNTIME_KIND)", () => {
  // The gateway passes AGENT_RUNTIME_KIND explicitly instead of relying on
  // the default; the canonical constant must behave identically.
  assert.deepEqual(shouldEngageSidecar("openclaw", "openclaw"), {
    engage: true,
  });
  assert.deepEqual(shouldEngageSidecar("Hermes", "hermes"), { engage: true });
  assert.deepEqual(shouldEngageSidecar(null, "openclaw"), { engage: true });

  const mismatch = shouldEngageSidecar("hermes", "openclaw");
  assert.equal(mismatch.engage, false);
  if (!mismatch.engage) {
    assert.match(mismatch.reason, /paired with hermes/);
    assert.match(mismatch.reason, /--runtime openclaw/);
  }
});

test("mismatched paired kind idles the channel with a re-pair hint", () => {
  const decision = shouldEngageSidecar("hermes");
  assert.equal(decision.engage, false);
  if (!decision.engage) {
    assert.match(decision.reason, /paired with hermes/);
    assert.match(decision.reason, /--runtime openclaw/);
  }
});
