/**
 * HAE summary-parsing tests, focused on the running cadence derivation. Run
 * with: npm test.
 *
 * Like route.test.mjs, parse.ts targets the Workers runtime, so we bundle it
 * with esbuild and import the result rather than running TS directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  entryPoints: [join(here, "../src/parse.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { extractHaeStepCountSamples, parseWorkoutSummary } = await import(
  "data:text/javascript," + encodeURIComponent(bundle.outputFiles[0].text)
);

test("extractHaeStepCountSamples derives spm from step deltas between samples", () => {
  const w = {
    stepCount: [
      { date: "2026-01-01 07:00:00 +0000", qty: 90 }, // no prior interval — dropped
      { date: "2026-01-01 07:01:00 +0000", qty: 180 }, // 180 steps / 1 min = 180 spm
      { date: "2026-01-01 07:01:30 +0000", qty: 90 }, // 90 steps / 0.5 min = 180 spm
    ],
  };
  const samples = extractHaeStepCountSamples(w);
  assert.equal(samples.length, 2);
  assert.deepEqual(
    samples.map((s) => s.cadence_spm),
    [180, 180],
  );
});

test("extractHaeStepCountSamples returns [] when there is no stepCount array", () => {
  assert.deepEqual(extractHaeStepCountSamples({}), []);
});

test("extractHaeStepCountSamples skips malformed entries and zero/negative intervals", () => {
  const w = {
    stepCount: [
      { date: "2026-01-01 07:00:00 +0000", qty: 90 },
      { qty: 100 }, // missing date
      { date: "2026-01-01 07:00:00 +0000", qty: 100 }, // same instant as prior — zero interval
      { date: "2026-01-01 07:02:00 +0000", qty: 240 }, // 240 / 2 min = 120 spm
    ],
  };
  const samples = extractHaeStepCountSamples(w);
  assert.deepEqual(
    samples.map((s) => s.cadence_spm),
    [120],
  );
});

test("parseWorkoutSummary sets avg_cadence_rpm from stepCadence for running only", () => {
  const base = {
    id: "abc",
    start: "2026-01-01 07:00:00 +0000",
    end: "2026-01-01 07:30:00 +0000",
    stepCadence: { qty: 172.4, units: "spm" },
  };
  const run = parseWorkoutSummary({ ...base, name: "Outdoor Run" });
  assert.equal(run.sport, "running");
  assert.equal(run.avg_cadence_rpm, 172);

  const swim = parseWorkoutSummary({ ...base, name: "Pool Swim" });
  assert.equal(swim.sport, "swimming");
  assert.equal(swim.avg_cadence_rpm, null);
});
