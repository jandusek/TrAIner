/**
 * Lap reconstruction tests. Run with: npm test
 *
 * laps.ts is TypeScript and targets the Workers runtime, so we bundle it with
 * esbuild and import the result rather than relying on a TS test runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  entryPoints: [join(here, "../src/laps.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { reconstructLaps } = await import(
  "data:text/javascript," + encodeURIComponent(bundle.outputFiles[0].text)
);

// Build a v2-ish workout from per-second (qty, gap-before) tuples.
function makeSwim(samples, { distanceKm, base = "2026-01-01 00:00:00 +0000" } = {}) {
  const start = Date.parse(base.replace(" ", "T").replace(" +0000", "Z")) / 1000;
  let t = start;
  const swimDistance = [];
  const swimStroke = [];
  samples.forEach(([qty, gapBefore = 1, strokes = 0.4], i) => {
    t += i === 0 ? 0 : gapBefore;
    const date = fmt(t);
    swimDistance.push({ date, qty, units: "m" });
    swimStroke.push({ date, qty: strokes, units: "count" });
  });
  return { distance: distanceKm != null ? { qty: distanceKm, units: "km" } : undefined, swimDistance, swimStroke };
}

function fmt(epoch) {
  const d = new Date(epoch * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

test("non-swim / missing pool length / no data → no laps", () => {
  assert.deepEqual(reconstructLaps({}, 50), []);
  assert.deepEqual(reconstructLaps(makeSwim([[1]]), null), []);
  assert.deepEqual(reconstructLaps({ swimDistance: [] }, 50), []);
});

test("continuous swim splits into pool-length laps", () => {
  // 100 m continuous at 1 m/s, 25 m pool → 4 laps, no rest.
  const w = makeSwim(Array.from({ length: 100 }, () => [1, 1, 0.4]), { distanceKm: 0.1 });
  const laps = reconstructLaps(w, 25);
  assert.equal(laps.length, 4);
  for (const lap of laps) {
    assert.ok(Math.abs(lap.distance_m - 25) < 1.5, `lap ~25m, got ${lap.distance_m}`);
    assert.equal(lap.rest_after_sec, 0);
    assert.equal(lap.reconstructed, 1);
  }
  assert.equal(laps[0].lap_num, 1);
  assert.equal(laps[3].lap_num, 4);
});

test("rest gaps segment laps and attribute rest_after", () => {
  // Two 25 m lengths with a 30 s wall rest between them.
  const len = () => Array.from({ length: 25 }, () => [1, 1, 0.4]);
  const first = len();
  const second = len();
  second[0] = [1, 30, 0.4]; // 30 s gap before the second length starts
  const w = makeSwim([...first, ...second], { distanceKm: 0.05 });
  const laps = reconstructLaps(w, 25);
  assert.equal(laps.length, 2);
  assert.equal(laps[0].rest_after_sec, 30, "rest attributed to the lap it follows");
  assert.equal(laps[1].rest_after_sec, 0, "last lap has no trailing rest");
});

test("deltas are scaled to the reported total", () => {
  // Reconstructed sum is 110 m but Apple says 100 m → scale to 100.
  const w = makeSwim(Array.from({ length: 110 }, () => [1, 1, 0.4]), { distanceKm: 0.1 });
  const laps = reconstructLaps(w, 25);
  const total = laps.reduce((a, l) => a + l.distance_m, 0);
  assert.ok(Math.abs(total - 100) < 0.5, `scaled total ~100, got ${total}`);
});

test("real swim fixture reconstructs to ~12×50m lengths", () => {
  const raw = JSON.parse(readFileSync(join(here, "fixtures/swim.json"), "utf8"));
  const laps = reconstructLaps(raw, 50);

  // 600 m / 50 m pool = 12 lengths; allow ±1 for boundary edge effects.
  assert.ok(laps.length >= 11 && laps.length <= 13, `~12 laps, got ${laps.length}`);

  // Scaled total matches Apple's reported 600 m closely.
  const total = laps.reduce((a, l) => a + l.distance_m, 0);
  assert.ok(Math.abs(total - 600) < 2, `total ~600m, got ${total.toFixed(1)}`);

  // Strokes sum near the reported 241.
  const strokes = laps.reduce((a, l) => a + l.strokes, 0);
  assert.ok(Math.abs(strokes - 241) < 5, `strokes ~241, got ${strokes.toFixed(1)}`);

  // This swimmer rests every length → most laps carry a rest_after.
  const withRest = laps.filter((l) => l.rest_after_sec > 0).length;
  assert.ok(withRest >= laps.length - 2, `most laps have rest, got ${withRest}/${laps.length}`);

  // Sanity on derived fields for full lengths. Lap 1 is exempt: the Watch needs
  // a few seconds to confirm swimming at session start, so the opening length is
  // a known short/fast artifact (flagged via notes.yaml at analysis time, not
  // "fixed" in the faithful laps table — see ARCHITECTURE.md known issues).
  for (const lap of laps) {
    assert.ok(lap.active_sec > 0);
    if (lap.lap_num > 1 && lap.distance_m >= 45) {
      assert.ok(lap.pace_per_50m > 30 && lap.pace_per_50m < 180, `pace sane, got ${lap.pace_per_50m}`);
      assert.ok(lap.swolf != null);
    }
    assert.ok(lap.avg_hr === null || (lap.avg_hr > 60 && lap.avg_hr < 200));
  }

  // Document the first-lap artifact rather than hide it: it should read faster
  // than the median lap.
  const median = [...laps.map((l) => l.pace_per_50m)].sort((a, b) => a - b)[Math.floor(laps.length / 2)];
  assert.ok(laps[0].pace_per_50m < median, "first lap is the known short/fast artifact");
});
