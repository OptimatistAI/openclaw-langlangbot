import assert from "node:assert/strict";
import test from "node:test";

// Import the built dist surface: Node's strip-types loader cannot resolve the
// package's internal `./x.js` -> `./x.ts` import graph from raw src.
import {
  LanglangbotSidecar,
  RuntimeMismatchError,
  isRuntimeMismatch,
  type LanglangbotSidecarOptions,
} from "../dist/index.js";

function captureFetch(): {
  fetchImpl: typeof fetch;
  last: () => Record<string, string> | undefined;
} {
  const calls: Record<string, Record<string, string>>[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    last: () => calls.at(-1),
  };
}

function baseOpts(over: Partial<LanglangbotSidecarOptions> = {}): LanglangbotSidecarOptions {
  return { baseUrl: "https://127.0.0.1:9528", ...over };
}

async function acceptOnce(sidecar: LanglangbotSidecar): Promise<Record<string, string>> {
  const capture = captureFetch();
  const probe = new LanglangbotSidecar({
    baseUrl: sidecar.baseUrl,
    pluginToken: sidecar.pluginToken,
    runtimeKind: sidecar.runtimeKind,
    fetchImpl: capture.fetchImpl,
    allowInsecureHttp: true,
  });
  await probe.acceptInbound({ conversationId: "c1", messageId: "m1", seqs: ["1"] });
  const headers = capture.last();
  assert.ok(headers, "acceptInbound must issue a request");
  return headers;
}

test("runtime kind header rides token-authenticated requests when configured", async () => {
  const plain = new LanglangbotSidecar(
    baseOpts({ pluginToken: "tok" }),
  );
  const plainHeaders = await acceptOnce(plain);
  assert.equal(plainHeaders["x-langlangbot-plugin-token"], "tok");
  assert.equal(plainHeaders["x-langlangbot-runtime-kind"], undefined);

  const kinded = new LanglangbotSidecar(
    baseOpts({ pluginToken: "tok", runtimeKind: "openclaw" }),
  );
  const kindedHeaders = await acceptOnce(kinded);
  assert.equal(kindedHeaders["x-langlangbot-plugin-token"], "tok");
  assert.equal(kindedHeaders["x-langlangbot-runtime-kind"], "openclaw");
  assert.equal(kindedHeaders["x-langlangbot-runtime-pid"], String(process.pid));
});

test("runtime kind header is absent for unset and blank values", async () => {
  const unset = new LanglangbotSidecar(baseOpts({}));
  assert.equal(unset.runtimeKind, undefined);
  assert.equal((await acceptOnce(unset))["x-langlangbot-runtime-kind"], undefined);

  const blank = new LanglangbotSidecar(baseOpts({ runtimeKind: "   " }));
  assert.equal(blank.runtimeKind, undefined);
  assert.equal((await acceptOnce(blank))["x-langlangbot-runtime-kind"], undefined);

  const hermes = new LanglangbotSidecar(baseOpts({ runtimeKind: "hermes" }));
  assert.equal(hermes.runtimeKind, "hermes");
  assert.equal(
    (await acceptOnce(hermes))["x-langlangbot-runtime-kind"],
    "hermes",
  );
});

/** SSE fetch stub returning the same scripted response for every connect. */
function sseFetch(
  respond: () => Response,
  calls: { count: number } = { count: 0 },
): typeof fetch {
  return (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.count += 1;
    if (init?.signal?.aborted) {
      throw new Error("aborted before send");
    }
    return respond();
  }) as unknown as typeof fetch;
}

const SSE_409_BODY = JSON.stringify({
  error: "runtime_mismatch",
  paired_runtime: "hermes",
  received_runtime: "openclaw",
});

test("SSE 409 runtime_mismatch terminates the loop with RuntimeMismatchError", async () => {
  const calls = { count: 0 };
  const sidecar = new LanglangbotSidecar(
    baseOpts({
      runtimeKind: "openclaw",
      fetchImpl: sseFetch(
        () =>
          new Response(SSE_409_BODY, {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        calls,
      ),
      allowInsecureHttp: true,
    }),
  );

  let seen: unknown;
  await assert.rejects(
    new Promise<void>((_resolve, reject) => {
      sidecar.subscribeInbound(
        () => {},
        (err) => {
          seen = err;
          reject(err);
        },
      );
    }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeMismatchError);
      assert.equal((err as RuntimeMismatchError).pairedRuntime, "hermes");
      return true;
    },
  );
  // Permanent: exactly one connect attempt, no retry/backoff.
  assert.equal(calls.count, 1);
  assert.ok(isRuntimeMismatch(seen), "onError saw the typed error");
});

test("SSE 500 keeps the transient retry behavior", async () => {
  const calls = { count: 0 };
  const sidecar = new LanglangbotSidecar(
    baseOpts({
      fetchImpl: sseFetch(() => new Response("boom", { status: 500 }), calls),
      allowInsecureHttp: true,
    }),
  );

  const unsub = sidecar.subscribeInbound(() => {});
  // First failure schedules the 1s backoff; before that fires, a second
  // attempt must already have happened only after ≥1 delay tick. Simply wait
  // long enough for ≥2 connect attempts, then unsubscribe.
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  unsub();
  assert.ok(calls.count >= 2, `expected retries, got ${calls.count} attempts`);
});


test("SSE 409 runtime_instance_mismatch terminates like kind mismatch", async () => {
  const calls = { count: 0 };
  const body = JSON.stringify({
    error: "runtime_instance_mismatch",
    paired_runtime: "openclaw",
    active_pid: 4242,
    received_pid: 9999,
  });
  const sidecar = new LanglangbotSidecar(
    baseOpts({
      runtimeKind: "openclaw",
      fetchImpl: sseFetch(
        () =>
          new Response(body, {
            status: 409,
            headers: { "content-type": "application/json" },
          }),
        calls,
      ),
      allowInsecureHttp: true,
    }),
  );

  let seen: unknown;
  await assert.rejects(
    new Promise<void>((_resolve, reject) => {
      sidecar.subscribeInbound(
        () => {},
        (err) => {
          seen = err;
          reject(err);
        },
      );
    }),
    (err: unknown) => {
      assert.ok(err instanceof RuntimeMismatchError);
      assert.equal((err as RuntimeMismatchError).reason, "runtime_instance_mismatch");
      assert.match((err as RuntimeMismatchError).message, /pid 4242/);
      return true;
    },
  );
  assert.equal(calls.count, 1);
  assert.ok(isRuntimeMismatch(seen));
});

test("isRuntimeMismatch classifies typed errors only", () => {
  assert.ok(isRuntimeMismatch(new RuntimeMismatchError("hermes")));
  assert.ok(!isRuntimeMismatch(new Error("plain")));
  assert.ok(!isRuntimeMismatch("runtime_mismatch"));
  assert.ok(!isRuntimeMismatch(null));

  const err = new RuntimeMismatchError("hermes");
  assert.equal(err.name, "RuntimeMismatchError");
  assert.equal(err.status, 409);
  assert.match(err.message, /paired with hermes/);
});
