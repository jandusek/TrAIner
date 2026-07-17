/**
 * /api/last debug-snapshot tests. Run with: npm test
 *
 * last-payload.ts is TypeScript; bundle with esbuild and import the result,
 * same pattern as fit.test.mjs. These cover the rule that matters: a KV failure
 * here must never propagate, because R2 — not KV — is the raw archive of
 * record, and an ingest that parsed fine must not be lost to a debug write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  entryPoints: [join(here, "../src/last-payload.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { putLastPayload, LAST_PAYLOAD_MAX_BYTES } = await import(
  "data:text/javascript," + encodeURIComponent(bundle.outputFiles[0].text)
);

const USER = { id: "u1", email: "athlete@example.com" };
const AT = "2026-07-15T21:59:51Z";

/** Fake KV. `limit` mimics KV's 413 on oversized values. */
function fakeKV({ limit = Infinity, alwaysThrow = false } = {}) {
  const puts = [];
  return {
    puts,
    store: {
      async put(key, value) {
        puts.push({ key, value });
        if (alwaysThrow) throw new Error("KV PUT failed: 500 Internal Error");
        if (value.length > limit) {
          throw new Error(`KV PUT failed: 413 Value length of ${value.length} exceeds limit of ${limit}.`);
        }
      },
    },
  };
}

test("a normal payload is stored whole, with its meta", async () => {
  const kv = fakeKV();
  await putLastPayload(kv.store, USER, '{"workouts":[1]}', AT);

  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, "last:u1");
  const stored = JSON.parse(kv.puts[0].value);
  assert.deepEqual(stored.payload, { workouts: [1] });
  assert.equal(stored.meta.receivedAt, AT);
  assert.equal(stored.meta.user.email, "athlete@example.com");
  assert.equal(stored.meta.payload_omitted, undefined);
});

test("a payload over the cap is skipped, keeping meta that explains why", async () => {
  const kv = fakeKV();
  // 31MB, the size that broke the real 2026-07-15 ingest.
  const raw = `"${"x".repeat(31_000_000)}"`;
  await putLastPayload(kv.store, USER, raw, AT);

  assert.equal(kv.puts.length, 1);
  const stored = JSON.parse(kv.puts[0].value);
  assert.equal(stored.payload, undefined);
  assert.equal(stored.meta.bytes, raw.length);
  assert.match(stored.meta.payload_omitted, /over the \d+-byte snapshot cap/);
  // The point of the cap: nothing near a multi-MB value reaches KV.
  assert.ok(kv.puts[0].value.length < 1000);
});

test("the cap is what bounds the write, well short of KV's own 413", async () => {
  // Just over the cap but far under KV's 25 MiB limit — a value KV would have
  // happily taken. We skip it anyway; that's the traffic saving.
  const kv = fakeKV({ limit: 25 * 1024 * 1024 });
  const raw = `"${"x".repeat(LAST_PAYLOAD_MAX_BYTES)}"`;
  await putLastPayload(kv.store, USER, raw, AT);

  const stored = JSON.parse(kv.puts[0].value);
  assert.equal(stored.payload, undefined);
});

test("a payload just under the cap is still stored whole", async () => {
  const kv = fakeKV({ limit: 25 * 1024 * 1024 });
  const body = "x".repeat(LAST_PAYLOAD_MAX_BYTES - 2); // + 2 quotes = exactly the cap
  await putLastPayload(kv.store, USER, `"${body}"`, AT);

  const stored = JSON.parse(kv.puts[0].value);
  assert.equal(stored.payload, body);
  assert.equal(stored.meta.payload_omitted, undefined);
});

test("a totally dead KV never throws — the ingest must survive it", async () => {
  const kv = fakeKV({ alwaysThrow: true });
  await assert.doesNotReject(() => putLastPayload(kv.store, USER, '{"a":1}', AT));
});
