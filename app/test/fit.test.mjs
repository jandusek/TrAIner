/**
 * Wahoo FIT parsing tests. Run with: npm test
 *
 * fit.ts is TypeScript and targets the Workers runtime, so we bundle it with
 * esbuild and import the result rather than relying on a TS test runner
 * (same approach as laps.test.mjs). The fixture is a real Wahoo ELEMNT
 * recording (see migrations/0011_cycling_power.sql) — power meter paired, no
 * HR strap, confirmed against a manual @garmin/fitsdk decode during
 * development (avg power 102W, NP 169W, IF 0.79, TSS 13.2, 7 configured
 * power zones, 789 per-second records).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  entryPoints: [join(here, "../src/fit.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "node", // @garmin/fitsdk is pure JS (ArrayBuffer/DataView) but is an npm package — resolve it normally
});
const { parseFitWorkout } = await import(
  "data:text/javascript," + encodeURIComponent(bundle.outputFiles[0].text)
);

const fitBuf = readFileSync(join(here, "fixtures/wahoo-ride.fit"));
const arrayBuffer = fitBuf.buffer.slice(fitBuf.byteOffset, fitBuf.byteOffset + fitBuf.byteLength);

test("real Wahoo FIT: summary carries power/cadence, not HR (no strap paired)", () => {
  const { summary } = parseFitWorkout("wahoo:test", arrayBuffer);
  assert.equal(summary.sport, "cycling");
  assert.equal(summary.avg_hr, null);
  assert.equal(summary.max_hr, null);
  assert.equal(summary.avg_power_w, 102);
  assert.equal(summary.max_power_w, 378);
  assert.equal(summary.normalized_power_w, 169);
  assert.ok(Math.abs(summary.intensity_factor - 0.794) < 0.01);
  assert.ok(Math.abs(summary.training_stress_score - 13.2) < 0.1);
  assert.equal(summary.threshold_power_w, 213);
  assert.ok(Math.abs(summary.work_kj - 80.7) < 0.5, `work_kj ~80.7, got ${summary.work_kj}`);
  assert.equal(summary.avg_cadence_rpm, 58);
  // Active-energy/work agreement is the whole point of the kcal investigation:
  // Wahoo's totalCalories and totalWork(kJ) should read the same number.
  assert.ok(Math.abs(summary.active_energy - summary.work_kj) < 1);
});

test("real Wahoo FIT: power zones pair timeInPowerZone with configured wattage boundaries", () => {
  const { summary } = parseFitWorkout("wahoo:test", arrayBuffer);
  const zones = JSON.parse(summary.power_zone_secs_json);
  assert.equal(zones.length, 7);
  assert.deepEqual(zones[0], { zone: 1, secs: 454.923, low: 0, high: 117 });
  assert.deepEqual(zones[1].low, 117);
  assert.deepEqual(zones[1].high, 149);
  // Contiguous: each zone's low is the previous zone's high.
  for (let i = 1; i < zones.length; i++) assert.equal(zones[i].low, zones[i - 1].high);
  // Zone seconds sum to *moving* time (FIT's totalTimerTime), which excludes
  // auto-pause — so it's <= duration_sec (totalElapsedTime), not equal to it.
  // Now that moving_sec carries totalTimerTime, assert against it directly
  // rather than settling for the loose <= duration_sec bound.
  const totalSecs = zones.reduce((a, z) => a + z.secs, 0);
  assert.ok(totalSecs > 0 && totalSecs <= summary.duration_sec, `0 < zone seconds <= duration, got ${totalSecs}`);
  // Close to moving_sec but not an exact partition of it — the head unit drops a
  // few seconds of zone accounting per ride (773.3 vs 789 here, ~2%). The point
  // of the assertion is which clock it tracks: it lands within 2% of timer time
  // and nowhere near the 1031s wall clock.
  assert.ok(
    Math.abs(totalSecs - summary.moving_sec) / summary.moving_sec < 0.02,
    `zone seconds (${totalSecs}) should track moving_sec (${summary.moving_sec}), not duration_sec (${summary.duration_sec})`,
  );
});

test("real Wahoo FIT: moving_sec is timer time, distinct from elapsed duration_sec", () => {
  const { summary, samples } = parseFitWorkout("wahoo:test", arrayBuffer);
  // The fixture is the 2026-07-01 lunch commute: 17 minutes wall clock, of which
  // ~4 sat stopped at traffic lights. Before moving_sec existed, every derived
  // pace divided by the 1031 and reported 14.5 km/h for a ride actually done at
  // 19.0 km/h — see migrations/0023_moving_time.sql.
  assert.equal(summary.duration_sec, 1031); // totalElapsedTime — wall clock
  assert.equal(summary.moving_sec, 789); // totalTimerTime — excludes auto-pause
  assert.ok(summary.moving_sec < summary.duration_sec);
  // The head unit writes no record while paused, so 1Hz records ≈ timer time.
  // This is the same identity backfillWahooHrFromSamples relies on to decide
  // which Watch HR samples were recorded while actually riding.
  assert.equal(samples.length, summary.moving_sec);
  const movingKmh = (summary.distance_m / summary.moving_sec) * 3.6;
  const elapsedKmh = (summary.distance_m / summary.duration_sec) * 3.6;
  assert.ok(Math.abs(movingKmh - 19.0) < 0.1, `moving speed ~19.0 km/h, got ${movingKmh.toFixed(1)}`);
  assert.ok(Math.abs(elapsedKmh - 14.5) < 0.1, `elapsed speed ~14.5 km/h, got ${elapsedKmh.toFixed(1)}`);
});

test("real Wahoo FIT: per-second samples cover the ride at ~1Hz with no HR", () => {
  const { samples } = parseFitWorkout("wahoo:test", arrayBuffer);
  assert.equal(samples.length, 789);
  assert.ok(samples.every((s) => s.power_w != null));
  assert.ok(samples.every((s) => s.cadence_rpm != null));
  assert.ok(samples.every((s) => Number.isFinite(s.t)));
  // Monotonically increasing timestamps, ~1s apart.
  for (let i = 1; i < samples.length; i++) assert.ok(samples[i].t >= samples[i - 1].t);
});

test("real Wahoo FIT: per-second samples carry speed in m/s, minus GPS dropouts", () => {
  const { samples } = parseFitWorkout("wahoo:test", arrayBuffer);
  const withSpeed = samples.filter((s) => s.speed_ms != null);

  // Speed is NOT universally present. This ride's `deviceInfoMesgs` lists
  // every sensor the head unit had paired — GPS, barometer, temperature,
  // accelerometer, a Garmin radar, gear shifting and a Quarq power meter —
  // with no `bikeSpeed`/`bikeSpeedCadence` entry, so speed here comes from
  // GPS and dies with the fix. The record data agrees exactly: 122 of 789
  // records have no speed, and all 122 also have no positionLat/Long. They
  // fall in three contiguous runs (the first 52 s before lock, then two
  // blocks in the closing minutes), and all 122 still carry power AND
  // cadence — which is why extractFitSamples must not drop a record for
  // missing speed alone.
  //
  // This is a fact about THIS ride, not about the bike: pairing a wheel
  // speed sensor would add it to deviceInfoMesgs and keep speed alive
  // through GPS dropouts. Re-check the device list before assuming a newer
  // ride behaves the same way.
  assert.equal(samples.length, 789);
  assert.equal(withSpeed.length, 667);

  for (const s of withSpeed) assert.ok(s.speed_ms >= 0 && s.speed_ms < 30, `implausible speed ${s.speed_ms}`);

  // Scale check — that these are m/s, not km/h and not a raw unscaled field.
  // Deliberately NOT compared against the session's own avgSpeed (5.278 m/s):
  // the trace's mean over recorded seconds runs meaningfully higher (~6.07)
  // because the dropped seconds are disproportionately the slow ones — the
  // rolling start and the end-of-ride crawl are where the fix is weakest.
  // That divergence is the same measurement-method gap 0023_moving_time.sql
  // documents, so assert the band, not the equality.
  const mean = withSpeed.reduce((a, s) => a + s.speed_ms, 0) / withSpeed.length;
  assert.ok(mean > 4 && mean < 9, `mean ${mean} m/s is outside a plausible commute band`);
});

test("real Wahoo FIT: route points carry real lat/lon (GPS-fixed outdoor ride)", () => {
  const { route } = parseFitWorkout("wahoo:test", arrayBuffer);
  assert.ok(route.length > 0);
  for (const p of route) {
    assert.ok(p.lat > -90 && p.lat < 90);
    assert.ok(p.lon > -180 && p.lon < 180);
  }
});
