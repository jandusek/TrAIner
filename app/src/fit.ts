/**
 * Parse a Wahoo FIT file into the same WorkoutSummary/Lap shapes the HAE path
 * (parse.ts / laps.ts) produces, so store.ts's upsert logic and the D1 schema
 * are shared across both sources.
 *
 * Confirmed against a real Wahoo ride: @garmin/fitsdk (zero deps, ArrayBuffer/
 * DataView only) decodes cleanly inside workerd — see the commit that added
 * this file for the manual verification.
 *
 * Unlike HAE's reconstructed swim laps, FIT ships native lap boundaries
 * (`lapMesgs`), so these are exact, not inferred — `reconstructed: 0`. Swim-
 * specific columns (strokes, swolf, pace_per_50m, stroke_type) don't apply to
 * cycling and are left null; the `laps` schema already anticipated this
 * (see migrations/0003_laps.sql).
 */

import {
  Decoder,
  Stream,
  Utils,
  type SessionMesg,
  type LapMesg,
  type RecordMesg,
  type PowerZoneMesg,
  type Types,
} from "@garmin/fitsdk";
import { PARSER_VERSION as HAE_PARSER_VERSION, normalizeSport, type WorkoutSummary } from "./parse";
import type { Lap } from "./laps";
import { SEMICIRCLE_TO_DEG, isValidLatLon, type RoutePoint } from "./route";

// Bump when the parsed output shape changes (power/cadence + per-second
// samples added here), so a re-ingest from R2 repopulates D1 — same signal as
// parse.ts's PARSER_VERSION.
export const FIT_PARSER_VERSION = "fit-2026-07-02c";

/** One second of power/cadence from a Wahoo FIT `recordMesgs` entry. */
export interface PowerCadenceSample {
  t: number; // unix epoch seconds, UTC
  power_w: number | null;
  cadence_rpm: number | null;
}

// FIT timestamps are UTC and Wahoo doesn't send the athlete's local offset, so
// the display-time UI (fmtWhen in home.client.js) would otherwise render raw
// UTC as if it were local. Default to the athlete's home base (see CLAUDE.md —
// Singapore) rather than leaving tz_offset null; revisit if training abroad
// becomes routine enough to need per-ride offsets.
const HOME_TZ_OFFSET = "+0800";

export class FitParseError extends Error {}

// DateTime is `number | Date | "min"` — decoder.read() defaults
// convertDateTimesToDates to true (we don't override it), so real dates arrive
// as JS Date instances at runtime. "min" is a documented edge case (device
// uptime, not a real timestamp, for values < 0x10000000) with no absolute
// epoch to convert to — treated as missing rather than guessed at. A raw
// number is converted via the SDK's own logic rather than assumed away.
function toEpochSeconds(v: Types.DateTime | undefined): number | undefined {
  if (v instanceof Date) return Math.round(v.getTime() / 1000);
  if (typeof v === "number") return Math.round(Utils.convertDateTimeToDate(v).getTime() / 1000);
  return undefined;
}

// Sport/SubSport are `number | string` (numeric fallback for values outside
// the SDK's known enum) — normalize to a plain string for our own mapping.
function toSportString(v: Types.Sport | Types.SubSport | undefined): string | undefined {
  return v === undefined ? undefined : String(v);
}

/** Parse a FIT ArrayBuffer into a workout summary + native laps. Throws FitParseError on bad input. */
export function parseFitWorkout(
  sourceId: string,
  buf: ArrayBuffer,
): { summary: WorkoutSummary; laps: Lap[]; route: RoutePoint[]; samples: PowerCadenceSample[] } {
  const stream = Stream.fromArrayBuffer(buf);
  const decoder = new Decoder(stream);
  const { messages, errors } = decoder.read();

  if (errors && errors.length > 0) {
    throw new FitParseError(`FIT decode errors: ${errors.join("; ")}`);
  }

  const session: SessionMesg | undefined = messages.sessionMesgs?.[0];
  const startEpoch = session && toEpochSeconds(session.startTime);
  if (!session || startEpoch === undefined) {
    throw new FitParseError("FIT file has no session message (or missing startTime)");
  }

  const endEpoch = toEpochSeconds(session.timestamp) ?? startEpoch + Math.round(session.totalElapsedTime ?? 0);

  const subSport = toSportString(session.subSport);
  const summary: WorkoutSummary = {
    source_id: sourceId,
    start_time: startEpoch,
    end_time: endEpoch,
    tz_offset: HOME_TZ_OFFSET,
    sport: normalizeSport(toSportString(session.sport)),
    sub_type: subSport && subSport !== "generic" ? subSport : null,
    is_indoor: subSport?.toLowerCase().includes("indoor") ? 1 : null,
    // Two distinct clocks, both reported by FIT (see migrations/0023_moving_time.sql):
    // totalElapsedTime is wall clock, totalTimerTime excludes auto-paused time.
    // The session's own averages (avgPower/avgCadence below) are computed over
    // timer time, so duration_sec alone can't be used as their denominator.
    duration_sec: session.totalElapsedTime != null ? Math.round(session.totalElapsedTime) : null,
    moving_sec: session.totalTimerTime != null ? Math.round(session.totalTimerTime) : null,
    distance_m: session.totalDistance ?? null, // FIT distance fields are meters
    pool_length_m: null, // N/A — cycling
    avg_hr: session.avgHeartRate ?? null, // null unless a chest strap is ever paired
    max_hr: session.maxHeartRate ?? null,
    total_strokes: null, // N/A — cycling
    active_energy: session.totalCalories ?? null, // FIT calories are kcal; see totalWork below — same figure
    temperature_c: session.avgTemperature ?? null,
    humidity_pct: null, // not present in FIT session messages
    avg_power_w: session.avgPower ?? null,
    max_power_w: session.maxPower ?? null,
    normalized_power_w: session.normalizedPower ?? null,
    intensity_factor: session.intensityFactor ?? null,
    training_stress_score: session.trainingStressScore ?? null,
    threshold_power_w: session.thresholdPower ?? null,
    work_kj: session.totalWork != null ? session.totalWork / 1000 : null, // FIT work is joules
    avg_cadence_rpm: session.avgCadence ?? null,
    max_cadence_rpm: session.maxCadence ?? null,
    elevation_gain_m: session.totalAscent ?? null,
    power_zone_secs_json: buildPowerZoneJson(session.timeInPowerZone, messages.powerZoneMesgs),
  };

  const laps: Lap[] = (messages.lapMesgs ?? []).map((lap: LapMesg, i: number) => ({
    lap_num: i + 1,
    start_time: toEpochSeconds(lap.startTime) ?? startEpoch,
    active_sec: lap.totalElapsedTime ?? 0,
    rest_after_sec: null,
    distance_m: lap.totalDistance ?? null,
    strokes: null,
    pace_per_50m: null,
    pace_per_km: null,
    swolf: null,
    avg_hr: lap.avgHeartRate ?? null,
    max_hr: lap.maxHeartRate ?? null,
    stroke_type: null,
    reconstructed: 0, // native FIT lap markers, not inferred
  }));

  const route = extractFitRoute(messages.recordMesgs ?? []);
  const samples = extractFitSamples(messages.recordMesgs ?? []);

  return { summary, laps, route, samples };
}

/**
 * Per-second power/cadence from FIT `recordMesgs`, for the power+HR-zone
 * overlay chart and decoupling calc (see migrations/0011_cycling_power.sql).
 * Records with neither field (e.g. a brief sensor dropout) are skipped rather
 * than stored as an all-null row.
 */
function extractFitSamples(records: RecordMesg[]): PowerCadenceSample[] {
  const out: PowerCadenceSample[] = [];
  for (const r of records) {
    if (r.power == null && r.cadence == null) continue;
    const t = toEpochSeconds(r.timestamp);
    if (t === undefined) continue;
    out.push({ t, power_w: r.power ?? null, cadence_rpm: r.cadence ?? null });
  }
  return out;
}

/**
 * Pair `timeInPowerZone` (seconds spent in each zone, index-aligned with
 * `powerZoneMesgs`) with the device's configured zone boundaries (watts).
 * FIT's convention: zone N's watts range is (zone N-1's highValue, zone N's
 * highValue] — zone 1 starts at 0. `timeInPowerZone` is a fixed-length
 * padded array (unused trailing zones read as 0 seconds), so this only keeps
 * entries that have a matching configured zone. Falls back to null if the
 * device didn't report zone config at all.
 */
function buildPowerZoneJson(
  timeInZone: number[] | undefined,
  zoneMesgs: PowerZoneMesg[] | undefined,
): string | null {
  if (!Array.isArray(timeInZone) || !Array.isArray(zoneMesgs) || zoneMesgs.length === 0) return null;
  const zones = zoneMesgs.map((z, i) => ({
    zone: i + 1,
    secs: timeInZone[i] ?? 0,
    low: i === 0 ? 0 : (zoneMesgs[i - 1]?.highValue ?? null),
    high: z.highValue ?? null,
  }));
  return JSON.stringify(zones);
}

/**
 * Build the GPS track from FIT `recordMesgs`. positionLat/positionLong are
 * signed-32-bit semicircles (converted to degrees); altitude/enhancedAltitude
 * are already meters via the SDK's scale/offset. Records without a position fix
 * (indoor rides, or pre-lock samples) are skipped, so an indoor ride yields an
 * empty track rather than a bogus point.
 */
function extractFitRoute(records: RecordMesg[]): RoutePoint[] {
  const out: RoutePoint[] = [];
  for (const r of records) {
    if (r.positionLat == null || r.positionLong == null) continue;
    const lat = r.positionLat * SEMICIRCLE_TO_DEG;
    const lon = r.positionLong * SEMICIRCLE_TO_DEG;
    if (!isValidLatLon(lat, lon)) continue;
    out.push({
      seq: out.length,
      ts: toEpochSeconds(r.timestamp) ?? null,
      lat,
      lon,
      elevation_m: r.enhancedAltitude ?? r.altitude ?? null,
    });
  }
  return out;
}

// Re-exported so callers can tell HAE-derived and FIT-derived rows apart if
// ever needed (both currently share the same `workouts.parser_version` column).
export { HAE_PARSER_VERSION };
