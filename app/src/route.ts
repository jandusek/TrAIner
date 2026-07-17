/**
 * GPS route extraction, normalized across both data sources into a single
 * WGS84-degrees shape (see migrations/0010_route_points.sql). The FIT side
 * lives in fit.ts (it already owns the @garmin/fitsdk decode); this module owns
 * the HAE side plus the pieces both sources share (semicircle conversion, point
 * validation, downsampling).
 *
 * Only cycling and running carry a route — swims and tennis produce none, and
 * indoor sessions simply yield zero points.
 */

import type { HaeWorkout } from "./parse";

export interface RoutePoint {
  seq: number; // 0-based order along the track
  ts: number | null; // unix epoch seconds, UTC — null if the source omits it
  lat: number; // WGS84 degrees
  lon: number; // WGS84 degrees
  elevation_m: number | null;
}

// FIT stores lat/long as signed 32-bit "semicircles"; degrees = semicircles *
// (180 / 2^31). Exported so fit.ts converts identically.
export const SEMICIRCLE_TO_DEG = 180 / 2 ** 31;

/**
 * True for a usable point: finite, within valid WGS84 bounds, and not the
 * null-island (0,0) fix that GPS devices emit before a satellite lock. Runs
 * and rides near the actual Gulf of Guinea don't happen for this athlete
 * (Singapore, ~1.3°N 103.8°E), so dropping exact 0/0 is safe.
 */
export function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/**
 * Pull a GPS track out of a raw HAE workout object.
 *
 * NOTE: unverified against real outdoor HAE data — no run has been ingested yet
 * (see CLAUDE.md; only pool swims so far, which have no route). Health Auto
 * Export attaches route samples under the workout's `route` array; the exact
 * key casing has drifted across HAE versions, so this reads defensively:
 * `route` may be the array directly or wrap it under `.locations`/`.points`,
 * and each sample's fields are matched by a few known aliases. Revisit and
 * tighten once a real run lands and the concrete shape is confirmed.
 */
export function extractHaeRoute(w: HaeWorkout): RoutePoint[] {
  const raw = (w as Record<string, unknown>).route;
  const samples = asPointArray(raw);
  if (!samples) return [];

  const out: RoutePoint[] = [];
  for (const s of samples) {
    if (!s || typeof s !== "object") continue;
    const p = s as Record<string, unknown>;
    const lat = num(p.latitude ?? p.lat);
    const lon = num(p.longitude ?? p.lon ?? p.lng);
    if (lat == null || lon == null || !isValidLatLon(lat, lon)) continue;
    out.push({
      seq: out.length,
      ts: haeTimestamp(p.timestamp ?? p.date ?? p.time),
      lat,
      lon,
      elevation_m: num(p.altitude ?? p.elevation ?? p.ele),
    });
  }
  return out;
}

function asPointArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.locations)) return o.locations;
    if (Array.isArray(o.points)) return o.points;
  }
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "number" || typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  if (v && typeof v === "object" && "qty" in (v as object)) {
    const q = (v as { qty?: unknown }).qty;
    return typeof q === "number" && Number.isFinite(q) ? q : null;
  }
  return null;
}

// Route timestamps may arrive as an HAE date string, an ISO string, or an epoch
// (seconds or milliseconds). Best-effort — a missing/unparseable value is fine,
// the track renders on lat/lon alone.
function haeTimestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  }
  if (typeof v === "string") {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      const [, y, mo, d, h, mi, se] = m;
      return Math.round(Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) / 1000);
    }
    const t = Date.parse(v);
    if (Number.isFinite(t)) return Math.round(t / 1000);
  }
  return null;
}

/**
 * Uniformly thin a track to at most `max` points, always keeping the first and
 * last (so the start/end markers and overall extent stay exact). A simple
 * fixed-stride decimation — good enough for a display polyline and predictable,
 * unlike Douglas-Peucker's variable output. Re-sequences `seq` 0..n on the way
 * out so the result is self-consistent.
 */
export function downsampleRoute(points: RoutePoint[], max: number): RoutePoint[] {
  if (points.length <= max || max <= 2) {
    return max <= 2 && points.length > 2
      ? [points[0], points[points.length - 1]].map((p, i) => ({ ...p, seq: i }))
      : points.map((p, i) => ({ ...p, seq: i }));
  }
  const stride = Math.ceil(points.length / max);
  const out: RoutePoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out.map((p, i) => ({ ...p, seq: i }));
}
