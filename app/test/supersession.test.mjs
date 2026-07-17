/**
 * Cross-source supersession matching tests. Run with: npm test
 *
 * Covers the rule that decides whether an HAE (Apple Watch) row is the same
 * physical ride as a Wahoo one — see store.ts's OVERLAP_MIN_FRACTION. The
 * surrounding functions need a live D1, so this exercises the pure predicate.
 *
 * Like route.test.mjs, store.ts targets the Workers runtime, so we bundle it
 * with esbuild and import the result rather than running TS directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  entryPoints: [join(here, "../src/store.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { overlapSec, overlapsEnough } = await import(
  "data:text/javascript," + encodeURIComponent(bundle.outputFiles[0].text)
);

const iv = (start_time, end_time) => ({ start_time, end_time });

// The ride that motivated the rule: one Wahoo ride spanning two Watch legs with
// a 36-minute stop between them (2026-07-15, verified against production).
const RIDE = iv(1784091972, 1784096410); // 13:06:12 - 14:20:10
const LEG_OUT = iv(1784092233, 1784093390); // 13:10:33 - 13:29:50, fully inside
const LEG_BACK = iv(1784095506, 1784096692); // 14:05:06 - 14:24:52, overruns the end

test("overlapSec counts only the shared seconds", () => {
  assert.equal(overlapSec(LEG_OUT, RIDE), LEG_OUT.end_time - LEG_OUT.start_time); // contained
  assert.equal(overlapSec(LEG_BACK, RIDE), RIDE.end_time - LEG_BACK.start_time); // clipped at the ride's end
  assert.equal(overlapSec(iv(0, 10), iv(20, 30)), 0);
});

test("overlapSec is symmetric", () => {
  assert.equal(overlapSec(LEG_BACK, RIDE), overlapSec(RIDE, LEG_BACK));
});

test("a Watch leg fully inside the ride is the same ride", () => {
  assert.equal(overlapsEnough(LEG_OUT, RIDE), true);
});

test("a Watch leg that outlives the ride is still the same ride", () => {
  // The head unit was saved 4:42 before the Watch was stopped, leaving 76%
  // overlap — the case strict containment would wrongly reject.
  assert.equal(overlapsEnough(LEG_BACK, RIDE), true);
  assert.ok(overlapSec(LEG_BACK, RIDE) / (LEG_BACK.end_time - LEG_BACK.start_time) < 0.8);
});

test("the leg that start-proximity missed starts long after the ride does", () => {
  // Why the old ±300s-of-start rule could never catch it: regression guard on
  // the reason this rule exists at all.
  assert.ok(LEG_BACK.start_time - RIDE.start_time > 300);
  assert.equal(overlapsEnough(LEG_BACK, RIDE), true);
});

test("a separate ride that merely touches the window is not the same ride", () => {
  // Ends 2 minutes into a 74-minute ride: 120s of a 1200s recording = 10%.
  const before = iv(RIDE.start_time - 1080, RIDE.start_time + 120);
  assert.equal(overlapsEnough(before, RIDE), false);
});

test("a non-overlapping ride is never the same ride", () => {
  const after = iv(RIDE.end_time + 60, RIDE.end_time + 1200);
  assert.equal(overlapsEnough(after, RIDE), false);
  assert.equal(overlapSec(after, RIDE), 0);
});

test("exactly half overlapping counts as the same ride", () => {
  // Boundary: the threshold is >=, so a leg split evenly across the ride's end
  // is kept rather than dropped.
  const half = iv(RIDE.end_time - 600, RIDE.end_time + 600);
  assert.equal(overlapsEnough(half, RIDE), true);
});

test("a zero-length row needs only to intersect", () => {
  // Guards the divide-by-zero path: duration 0 can't clear a fractional bar.
  const instant = iv(RIDE.start_time + 100, RIDE.start_time + 100);
  assert.equal(overlapsEnough(instant, RIDE), false); // half-open: no shared seconds
  assert.equal(overlapsEnough(iv(RIDE.end_time, RIDE.end_time), RIDE), false);
});
