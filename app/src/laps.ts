/**
 * Swim lap reconstruction from a Health Auto Export v2 workout.
 *
 * HAE drops Apple's native pool-end markers, so we infer laps from the
 * per-second `swimDistance` deltas. Two effects from the real data drive the
 * algorithm (see ARCHITECTURE.md → lap reconstruction):
 *
 *   1. Reconstructed distance overcounts (~+9% vs Apple's reported total). We
 *      trust Apple's total and scale every delta by reportedTotal / sumOfDeltas,
 *      so a 50 m length reads ~50 m, not ~55 m.
 *
 *   2. Wall rests show up as >5 s gaps between consecutive samples. They segment
 *      the swim into active blocks and are attributed as rest_after to the lap
 *      they follow.
 *
 * Within each active block we split into pool-length laps by scaled cumulative
 * distance. For a swimmer who rests every length each block is one lap; for
 * continuous swimming a block splits into multiple 50 m laps.
 *
 * Per-second sampling (~1 Hz) lets us approximate a lap's active seconds by its
 * sample count, which avoids fragile dt summation.
 */

import { parseHaeDate, type HaeWorkout } from "./parse";

const REST_GAP_SEC = 5; // gap larger than this between samples = wall rest
const PARTIAL_LAP_FRACTION = 0.5; // a final fragment >= this fraction of a length counts as a lap

export interface Lap {
  lap_num: number;
  start_time: number;
  active_sec: number;
  // Nullable: swim-specific fields don't apply to FIT-derived (e.g. cycling)
  // laps (see fit.ts). HAE's own reconstruction always supplies concrete
  // numbers here, so widening to `| null` doesn't change its behavior.
  rest_after_sec: number | null;
  distance_m: number | null;
  strokes: number | null;
  pace_per_50m: number | null;
  pace_per_km: number | null;
  swolf: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  stroke_type: string | null;
  reconstructed: 0 | 1; // 1 = inferred (HAE swim reconstruction), 0 = native FIT lap marker
}

interface Sample {
  t: number; // epoch seconds
  d: number; // scaled distance delta, meters
}

interface HrSample {
  t: number;
  avg: number;
  max: number;
}

/**
 * Reconstruct laps for a swim workout. Returns [] for non-swims, missing pool
 * length, or absent swimDistance data (caller decides what that means).
 */
export function reconstructLaps(w: HaeWorkout, poolLengthM: number | null): Lap[] {
  if (!poolLengthM || poolLengthM <= 0) return [];
  const rawDist = asSamples(w.swimDistance);
  if (rawDist.length === 0) return [];

  // Scale deltas so the reconstructed total matches Apple's reported distance.
  const reported = reportedMeters(w);
  const rawSum = rawDist.reduce((a, s) => a + s.d, 0);
  const scale = reported && rawSum > 0 ? reported / rawSum : 1;
  const samples: Sample[] = rawDist.map((s) => ({ t: s.t, d: s.d * scale }));

  const strokes = asSamples(w.swimStroke); // {t, d=stroke count in that second}
  const hr = asHrSamples(w.heartRateData);

  // 1. Segment into active blocks separated by rest gaps.
  const blocks: { samples: Sample[]; restAfter: number }[] = [];
  let current: Sample[] = [];
  for (let i = 0; i < samples.length; i++) {
    current.push(samples[i]);
    const next = samples[i + 1];
    const gap = next ? next.t - samples[i].t : 0;
    if (!next || gap > REST_GAP_SEC) {
      blocks.push({ samples: current, restAfter: next ? gap : 0 });
      current = [];
    }
  }

  // 2. Split each block into pool-length laps by scaled cumulative distance.
  const laps: Lap[] = [];
  for (const block of blocks) {
    const blockLaps = splitBlock(block.samples, poolLengthM);
    blockLaps.forEach((seg, idx) => {
      const isLastOfBlock = idx === blockLaps.length - 1;
      laps.push(
        buildLap(laps.length + 1, seg, poolLengthM, isLastOfBlock ? block.restAfter : 0, strokes, hr),
      );
    });
  }
  return laps;
}

/** Split one active block's samples into segments of ~poolLength meters. */
function splitBlock(samples: Sample[], poolLengthM: number): Sample[][] {
  const segments: Sample[][] = [];
  let seg: Sample[] = [];
  let cum = 0;
  for (const s of samples) {
    seg.push(s);
    cum += s.d;
    if (cum >= poolLengthM) {
      segments.push(seg);
      seg = [];
      cum -= poolLengthM; // carry remainder into the next length
    }
  }
  // Trailing fragment: keep as a lap only if it's a meaningful fraction of a length.
  if (seg.length > 0) {
    const segDist = seg.reduce((a, s) => a + s.d, 0);
    if (segDist >= poolLengthM * PARTIAL_LAP_FRACTION || segments.length === 0) {
      segments.push(seg);
    } else if (segments.length > 0) {
      // Tiny tail (gliding into the wall): fold it into the previous length.
      segments[segments.length - 1].push(...seg);
    }
  }
  return segments;
}

function buildLap(
  lapNum: number,
  seg: Sample[],
  poolLengthM: number,
  restAfter: number,
  strokes: Sample[],
  hr: HrSample[],
): Lap {
  const startT = seg[0].t;
  const endT = seg[seg.length - 1].t;
  const distance = round(seg.reduce((a, s) => a + s.d, 0), 2);
  // ~1 Hz sampling → one sample ≈ one active second.
  const activeSec = seg.length;
  const lapStrokes = round(sumInWindow(strokes, startT, endT), 1);
  const { avg, max } = hrInWindow(hr, startT, endT);

  const isFull = distance >= poolLengthM * 0.9;
  const pacePer50 = distance > 0 ? round(activeSec * (50 / distance), 1) : null;
  const pacePerKm = distance > 0 ? round(activeSec * (1000 / distance), 1) : null;
  const swolf = isFull ? round(activeSec + lapStrokes, 1) : null;

  return {
    lap_num: lapNum,
    start_time: startT,
    active_sec: activeSec,
    rest_after_sec: round(restAfter, 1),
    distance_m: distance,
    strokes: lapStrokes,
    pace_per_50m: pacePer50,
    pace_per_km: pacePerKm,
    swolf,
    avg_hr: avg,
    max_hr: max,
    stroke_type: null, // no native classification in HAE v2; notes.yaml corrects at query time
    reconstructed: 1,
  };
}

// --- sample extraction -----------------------------------------------------

/** The workout's reported total distance in meters (for delta scaling), or null. */
function reportedMeters(w: HaeWorkout): number | null {
  const d = w.distance;
  if (!d || typeof d.qty !== "number") return null;
  switch ((d.units ?? "").toLowerCase()) {
    case "km":
      return d.qty * 1000;
    case "mi":
      return d.qty * 1609.344;
    default:
      return d.qty;
  }
}

function asSamples(arr: unknown): Sample[] {
  if (!Array.isArray(arr)) return [];
  const out: Sample[] = [];
  for (const s of arr) {
    if (s && typeof s.date === "string" && typeof s.qty === "number") {
      out.push({ t: parseHaeDate(s.date).epoch, d: s.qty });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function asHrSamples(arr: unknown): HrSample[] {
  if (!Array.isArray(arr)) return [];
  const out: HrSample[] = [];
  for (const s of arr) {
    if (s && typeof s.date === "string" && typeof s.Avg === "number") {
      out.push({ t: parseHaeDate(s.date).epoch, avg: s.Avg, max: typeof s.Max === "number" ? s.Max : s.Avg });
    }
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function sumInWindow(samples: Sample[], startT: number, endT: number): number {
  let sum = 0;
  for (const s of samples) {
    if (s.t >= startT && s.t <= endT) sum += s.d;
  }
  return sum;
}

function hrInWindow(hr: HrSample[], startT: number, endT: number): { avg: number | null; max: number | null } {
  const inWin = hr.filter((s) => s.t >= startT && s.t <= endT);
  if (inWin.length === 0) return { avg: null, max: null };
  const avg = inWin.reduce((a, s) => a + s.avg, 0) / inWin.length;
  const max = inWin.reduce((a, s) => Math.max(a, s.max), 0);
  return { avg: round(avg, 1), max };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
