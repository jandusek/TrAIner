/**
 * GPS route extraction tests. Run with: npm test
 *
 * Like laps.test.mjs, route.ts targets the Workers runtime, so we bundle it
 * with esbuild and import the result rather than running TS directly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  entryPoints: [join(here, "../src/route.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { extractHaeRoute, downsampleRoute, isValidLatLon, SEMICIRCLE_TO_DEG } = await import(
  "data:text/javascript," + encodeURIComponent(bundle.outputFiles[0].text)
);

test("extractHaeRoute reads latitude/longitude/altitude and sequences points", () => {
  const w = {
    route: [
      { latitude: 1.3, longitude: 103.8, altitude: 15, timestamp: "2026-01-01 07:00:00 +0000" },
      { latitude: 1.301, longitude: 103.801, altitude: 16 },
    ],
  };
  const pts = extractHaeRoute(w);
  assert.equal(pts.length, 2);
  assert.deepEqual(
    pts.map((p) => [p.seq, p.lat, p.lon, p.elevation_m]),
    [
      [0, 1.3, 103.8, 15],
      [1, 1.301, 103.801, 16],
    ],
  );
  assert.equal(pts[0].ts, Math.round(Date.UTC(2026, 0, 1, 7, 0, 0) / 1000));
  assert.equal(pts[1].ts, null);
});

test("extractHaeRoute accepts lat/lng aliases and .locations wrapper", () => {
  const w = { route: { locations: [{ lat: 1.3, lng: 103.8 }] } };
  const pts = extractHaeRoute(w);
  assert.equal(pts.length, 1);
  assert.deepEqual([pts[0].lat, pts[0].lon], [1.3, 103.8]);
});

test("extractHaeRoute drops null-island and out-of-range fixes", () => {
  const w = {
    route: [
      { latitude: 0, longitude: 0 }, // pre-lock
      { latitude: 200, longitude: 10 }, // impossible
      { latitude: 1.3, longitude: 103.8 }, // good
    ],
  };
  const pts = extractHaeRoute(w);
  assert.equal(pts.length, 1);
  assert.equal(pts[0].seq, 0);
  assert.deepEqual([pts[0].lat, pts[0].lon], [1.3, 103.8]);
});

test("extractHaeRoute returns [] when there is no route", () => {
  assert.deepEqual(extractHaeRoute({}), []);
  assert.deepEqual(extractHaeRoute({ route: null }), []);
});

test("semicircle constant converts a known value", () => {
  // 2^31 semicircles == 180°.
  assert.ok(Math.abs(2 ** 31 * SEMICIRCLE_TO_DEG - 180) < 1e-9);
  assert.equal(isValidLatLon(1.3, 103.8), true);
  assert.equal(isValidLatLon(0, 0), false);
});

test("downsampleRoute caps length and preserves first + last", () => {
  const src = Array.from({ length: 1000 }, (_, i) => ({
    seq: i, ts: i, lat: i / 1000, lon: i / 1000, elevation_m: null,
  }));
  const out = downsampleRoute(src, 100);
  assert.ok(out.length <= 101, `expected ≤101, got ${out.length}`);
  assert.equal(out[0].lat, 0);
  assert.equal(out[out.length - 1].lat, 999 / 1000);
  // Re-sequenced 0..n.
  assert.deepEqual(out.map((p) => p.seq), out.map((_, i) => i));
});

test("downsampleRoute passes short tracks through unchanged (but re-sequenced)", () => {
  const src = [
    { seq: 5, ts: 0, lat: 1, lon: 1, elevation_m: null },
    { seq: 9, ts: 1, lat: 2, lon: 2, elevation_m: null },
  ];
  const out = downsampleRoute(src, 1200);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.seq), [0, 1]);
});
