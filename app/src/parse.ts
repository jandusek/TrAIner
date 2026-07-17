/**
 * Parse a Health Auto Export v2 workout object into a flat summary row.
 *
 * Scope: session-level summary only (ARCHITECTURE.md build step 2). Lap
 * reconstruction and HR time series come later and read from the raw R2 archive,
 * so this stays deliberately small. Bump PARSER_VERSION whenever the output
 * shape or any derivation changes — that's the signal to reprocess R2 into D1.
 */

// Bump on any change to derived output. 2026-07-02: ingest now also extracts a
// GPS route (see route.ts / store.ts) and, for cycling, HR samples (see
// extractHaeHrSamples below), so a re-ingest from R2 backfills both. 2026-07-03:
// running workouts now get avg_cadence_rpm (from HAE's stepCadence) and a
// derived per-interval cadence stream (extractHaeStepCountSamples below).
export const PARSER_VERSION = "summary-2026-07-03";

/** A single workout as it appears in `data.workouts[]` of a v2 export. */
export interface HaeWorkout {
  id?: string;
  name?: string;
  start?: string;
  end?: string;
  duration?: number;
  isIndoor?: boolean;
  distance?: QtyUnits;
  lapLength?: QtyUnits;
  avgHeartRate?: QtyUnits;
  maxHeartRate?: QtyUnits;
  activeEnergyBurned?: QtyUnits;
  temperature?: QtyUnits;
  humidity?: QtyUnits;
  totalSwimmingStrokeCount?: number | QtyUnits;
  stepCadence?: QtyUnits;
  [k: string]: unknown;
}

interface QtyUnits {
  qty?: number;
  units?: string;
}

export interface WorkoutSummary {
  source_id: string;
  start_time: number;
  end_time: number;
  tz_offset: string | null;
  sport: string;
  sub_type: string | null;
  is_indoor: number | null;
  duration_sec: number | null;
  /**
   * Moving time — FIT `totalTimerTime`, which excludes auto-paused time, as
   * opposed to `duration_sec`'s wall clock. NULL on the HAE path: Apple's
   * HKWorkout.duration already excludes paused time and exposes no separate
   * elapsed figure, so there are not two clocks to tell apart there.
   * Analysis code wanting a pace denominator should use
   * COALESCE(moving_sec, duration_sec). See migrations/0023_moving_time.sql.
   */
  moving_sec: number | null;
  distance_m: number | null;
  pool_length_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  total_strokes: number | null;
  active_energy: number | null;
  temperature_c: number | null;
  humidity_pct: number | null;
  // Cycling power/cadence — populated from a Wahoo FIT session (fit.ts),
  // always null on the HAE path (see migrations/0011_cycling_power.sql).
  avg_power_w: number | null;
  max_power_w: number | null;
  normalized_power_w: number | null;
  intensity_factor: number | null;
  training_stress_score: number | null;
  threshold_power_w: number | null;
  work_kj: number | null;
  avg_cadence_rpm: number | null;
  max_cadence_rpm: number | null;
  elevation_gain_m: number | null;
  power_zone_secs_json: string | null;
}

/** One HR reading from HAE's `heartRateData` time series. */
export interface HrSample {
  t: number; // unix epoch seconds, UTC
  hr: number;
}

export class ParseError extends Error {}

/** Top-level shape guard: pull the workouts array out of a v2 payload. */
export function extractWorkouts(payload: unknown): HaeWorkout[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    typeof (payload as any).data !== "object" ||
    (payload as any).data === null ||
    !Array.isArray((payload as any).data.workouts)
  ) {
    throw new ParseError(
      "payload is not a Health Auto Export v2 export (expected { data: { workouts: [...] } })",
    );
  }
  return (payload as any).data.workouts as HaeWorkout[];
}

export function parseWorkoutSummary(w: HaeWorkout): WorkoutSummary {
  if (!w.id) throw new ParseError("workout is missing `id` (HealthKit UUID) — cannot dedup");
  if (!w.start || !w.end) throw new ParseError(`workout ${w.id} missing start/end`);

  const start = parseHaeDate(w.start);
  const end = parseHaeDate(w.end);
  const sport = normalizeSport(w.name);

  return {
    source_id: w.id,
    start_time: start.epoch,
    end_time: end.epoch,
    tz_offset: start.offset,
    sport,
    // Cycling is exclusively outdoor for this athlete (see CLAUDE.md), so
    // HAE's "Outdoor Cycling" label is a redundant qualifier — drop it and
    // let the UI fall back to the plain sport name, matching how Wahoo's own
    // FIT-derived rows already render (fit.ts leaves sub_type null there
    // too). Other sports keep their sub_type — e.g. "Pool Swim" is
    // informative, not redundant.
    sub_type: sport === "cycling" ? null : (w.name ?? null),
    is_indoor: typeof w.isIndoor === "boolean" ? (w.isIndoor ? 1 : 0) : null,
    duration_sec: w.duration != null ? Math.round(w.duration) : null,
    moving_sec: null, // Wahoo/FIT-only — see the field's doc comment on WorkoutSummary
    distance_m: toMeters(w.distance),
    pool_length_m: poolLengthMeters(w.lapLength),
    avg_hr: qty(w.avgHeartRate),
    max_hr: intQty(w.maxHeartRate),
    total_strokes: intQty(w.totalSwimmingStrokeCount),
    active_energy: qty(w.activeEnergyBurned),
    temperature_c: qty(w.temperature),
    humidity_pct: qty(w.humidity),
    // Power/cadence are Wahoo-only fields (see fit.ts) — an HAE row never
    // carries them, even for a cycling workout with a Wahoo echo merged into
    // HealthKit (see ARCHITECTURE.md on cyclingPower/cyclingCadence: the raw
    // FIT is the source of truth for those, not the HealthKit merge).
    avg_power_w: null,
    max_power_w: null,
    normalized_power_w: null,
    intensity_factor: null,
    training_stress_score: null,
    threshold_power_w: null,
    work_kj: null,
    // Running is the one sport where this column comes from HAE itself
    // (`stepCadence`, a session-average QuantityData in steps/min) rather than
    // a Wahoo FIT — there's no bike computer involved. Every other sport
    // leaves it null.
    avg_cadence_rpm: sport === "running" ? intQty(w.stepCadence) : null,
    max_cadence_rpm: null,
    elevation_gain_m: null,
    power_zone_secs_json: null,
  };
}

/**
 * Pull the athlete's HR time series out of a raw HAE workout object, for
 * workouts where HR is the *only* thing this source should contribute (i.e.
 * cycling, where a Wahoo FIT supplies everything else — see store.ts's
 * writeCyclingSamples). HAE's `heartRateData` samples run ~5s apart (Watch
 * optical sensor cadence), each carrying Min/Avg/Max over that window; Avg is
 * the representative reading for that timestamp.
 */
export function extractHaeHrSamples(w: HaeWorkout): HrSample[] {
  const raw = (w as Record<string, unknown>).heartRateData;
  if (!Array.isArray(raw)) return [];
  const out: HrSample[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const dateStr = typeof e.date === "string" ? e.date : undefined;
    const hr = typeof e.Avg === "number" ? e.Avg : typeof e.avg === "number" ? e.avg : undefined;
    if (!dateStr || hr === undefined) continue;
    try {
      out.push({ t: parseHaeDate(dateStr).epoch, hr: Math.round(hr) });
    } catch {
      // Skip malformed entries rather than aborting the whole workout.
    }
  }
  return out;
}

/** One derived cadence reading for a running workout — see extractHaeStepCountSamples. */
export interface CadenceSample {
  t: number; // unix epoch seconds, UTC — end of the interval this reading covers
  cadence_spm: number;
}

/**
 * Derive an approximate per-interval running cadence stream from HAE's
 * `stepCount` array. There's no native per-second (or even per-lap) cadence
 * stream for running in HAE — `stepCadence` is a single session-average
 * QuantityData — so this reconstructs a chartable series the same way laps.ts
 * reconstructs swim laps from cumulative distance: each `stepCount` entry is
 * treated as the step count *since the previous entry* (matching how HAE's
 * other interval arrays, e.g. `activeEnergy`, report incremental buckets
 * rather than a running total), and cadence for that interval is steps ÷
 * minutes elapsed since the prior sample. The first sample has no prior
 * interval to measure against and is dropped, same as an unmeasurable first
 * swim lap.
 *
 * Unverified: no real running export has landed yet to confirm stepCount's
 * delta-vs-cumulative semantics (see route.ts's identical caveat on the GPS
 * track). Revisit once the first real run is ingested.
 */
export function extractHaeStepCountSamples(w: HaeWorkout): CadenceSample[] {
  const raw = (w as Record<string, unknown>).stepCount;
  if (!Array.isArray(raw)) return [];
  const out: CadenceSample[] = [];
  let prevEpoch: number | null = null;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const dateStr = typeof e.date === "string" ? e.date : undefined;
    const steps = typeof e.qty === "number" ? e.qty : undefined;
    if (!dateStr || steps === undefined) continue;
    let epoch: number;
    try {
      epoch = parseHaeDate(dateStr).epoch;
    } catch {
      continue; // Skip malformed entries rather than aborting the whole workout.
    }
    if (prevEpoch != null) {
      const minutes = (epoch - prevEpoch) / 60;
      if (minutes > 0) out.push({ t: epoch, cadence_spm: Math.round(steps / minutes) });
    }
    prevEpoch = epoch;
  }
  return out;
}

// --- field helpers ---------------------------------------------------------

function qty(v: number | QtyUnits | undefined): number | null {
  if (typeof v === "number") return v;
  if (v && typeof v.qty === "number") return v.qty;
  return null;
}

function intQty(v: number | QtyUnits | undefined): number | null {
  const n = qty(v);
  return n == null ? null : Math.round(n);
}

/** Convert a {qty, units} distance to meters. */
function toMeters(v: QtyUnits | undefined): number | null {
  if (!v || typeof v.qty !== "number") return null;
  switch ((v.units ?? "").toLowerCase()) {
    case "km":
      return v.qty * 1000;
    case "mi":
      return v.qty * 1609.344;
    case "m":
    case "":
      return v.qty;
    default:
      return v.qty; // unknown unit — store the number, flag later if needed
  }
}

/**
 * Pool length, in meters, working around HAE's `lapLength` quirk: it reports a
 * 50 m pool as { qty: 0.05, units: "m" } — the value is really kilometers,
 * mislabeled as meters. Any plausible pool length expressed "in meters" would be
 * >= 5, so a sub-5 value is taken as km and scaled up.
 */
function poolLengthMeters(v: QtyUnits | undefined): number | null {
  const m = toMeters(v);
  if (m == null) return null;
  return m < 5 ? m * 1000 : m;
}

/** Map HAE's display name to a normalized sport. */
export function normalizeSport(name: string | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.includes("swim")) return "swimming";
  if (n.includes("cycl") || n.includes("bike") || n.includes("ride")) return "cycling";
  if (n.includes("tennis")) return "tennis";
  if (n.includes("run") || n.includes("walk")) return "running";
  return "other";
}

/**
 * Parse a HAE date string ("2026-06-29 10:44:35 +0800") into a UTC epoch
 * (seconds) plus the original offset, without relying on Date's lenient parsing
 * of non-ISO strings (which varies by engine).
 */
export function parseHaeDate(s: string): { epoch: number; offset: string | null } {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?/);
  if (!m) throw new ParseError(`unrecognized date format: ${JSON.stringify(s)}`);
  const [, y, mo, d, h, mi, se, off] = m;
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se);
  let offsetSec = 0;
  if (off) {
    const sign = off[0] === "-" ? -1 : 1;
    offsetSec = sign * (parseInt(off.slice(1, 3), 10) * 3600 + parseInt(off.slice(3, 5), 10) * 60);
  }
  return { epoch: Math.round(utcMs / 1000) - offsetSec, offset: off ?? null };
}
