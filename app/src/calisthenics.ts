/**
 * Autoregulated calisthenics prescription engine.
 *
 * Deterministic — no model call on this path. RIR bands, gap-based re-entry,
 * and the 60–70% floor are exact rules over stored history, same category as
 * pace/SWOLF derivation in parse.ts: computed in code, not left to per-session
 * judgment. The UI logs sets; this recomputes the next targets every time.
 *
 * Prescriptions are per-set: the last session's full shape (e.g. 23-23-20-18)
 * carries forward with each set progressed off its own logged RIR, so every
 * RIR the athlete enters drives the next session — not just the top set's.
 * AMRAP is deliberately NOT redundant with RIR: RIR is a cheap per-set
 * *estimate* of proximity to failure; the periodic AMRAP is a *measured*
 * ground truth that corrects drift in those estimates (and anchors the floor).
 *
 * See build brief context: pull-ups/push-ups only, self-reported reps + RIR
 * (no wearable can rep-count bodyweight movements or read strength-set effort
 * from HR — see app/ARCHITECTURE.md and CLAUDE.md).
 */

export type Movement = "pullup" | "pushup";
export const MOVEMENTS: Movement[] = ["pullup", "pushup"];
export function isMovement(v: unknown): v is Movement {
  return v === "pullup" || v === "pushup";
}

export interface SetLog {
  set_num: number;
  reps: number;
  rir: number | null; // null on an AMRAP set (to failure)
  is_amrap: boolean;
}

export interface SessionLog {
  workout_id: string;
  source_id: string;
  start_time: number; // unix epoch seconds
  sets: SetLog[];
}

export interface Prescription {
  movement: Movement;
  target_sets: number;
  target_reps: number; // top-set target (max of target_sequence) — kept for the roller default / done-card
  target_sequence: number[]; // per-set rep targets in set order — each set progressed off ITS OWN logged RIR
  last_sequence: number[] | null; // last session's reps in set order, for "last → today" display; null with no history
  rir_target: string; // human-readable band, e.g. "1-3"
  amrap_due: boolean; // suggest a top-set AMRAP retest this session
  floor_reps: number; // never prescribe below this — 60-70% of best-ever
  best_amrap_reps: number | null;
  gap_days: number | null; // null = no prior session
  note: string;
}

const AMRAP_INTERVAL_DAYS = 10; // "every 1-2 weeks" — recalibration cadence
const FLOOR_PCT = 0.65; // "never below ~60-70% of best-ever" — pick the middle
const GAP_REPEAT_MIN_DAYS = 3;
const GAP_REPEAT_MAX_DAYS = 4; // 3-4 days: repeat last session once before progressing
const GAP_EASE_MAX_DAYS = 13; // 5-13 days: ease re-entry
const GAP_SOFT_RESTART_DAYS = 14; // >=14 days: soft restart + force an AMRAP retest

// Prescribed taper: hit the top target while fresh, then back off as fatigue
// accumulates — the classic top-loaded session shape (e.g. 23-23-21-19)
// rather than grinding the same number on every set. Applied as a CAP on the
// RIR-progressed per-set targets: it pulls a flat sequence down into a taper,
// but never pushes a set above what its own RIR progression earned, so a
// history that already tapers steeper than this curve keeps its own shape.
const TAPER_FULL_SETS = 2; // first N sets get the full top target
const TAPER_STEP = 0.08; // each set after that caps ~8% lower than the last

const DEFAULT_TARGETS: Record<Movement, { sets: number; reps: number }> = {
  // Recon Ron / Hundred Push-ups starting-level heuristics, used only as a
  // bootstrap before any real history exists — see CLAUDE.md build brief.
  pullup: { sets: 5, reps: 5 },
  pushup: { sets: 4, reps: 10 },
};

const DAY_SECONDS = 86400;

export function computePrescription(
  movement: Movement,
  history: SessionLog[],
  nowSec: number,
): Prescription {
  const sorted = [...history].sort((a, b) => b.start_time - a.start_time);
  const last = sorted[0];
  const bestAmrap = maxAmrapReps(sorted);
  const floorFromBest = bestAmrap != null ? Math.ceil(bestAmrap * FLOOR_PCT) : null;

  if (!last || last.sets.length === 0) {
    const d = DEFAULT_TARGETS[movement];
    return {
      movement,
      target_sets: d.sets,
      target_reps: d.reps,
      target_sequence: applyTaper(Array(d.sets).fill(d.reps)),
      last_sequence: null,
      rir_target: "1-3",
      amrap_due: true,
      floor_reps: floorFromBest ?? d.reps,
      best_amrap_reps: bestAmrap,
      gap_days: null,
      note: "No history yet — starting baseline. Do a top-set AMRAP whenever ready to calibrate.",
    };
  }

  const gapDays = Math.floor((nowSec - last.start_time) / DAY_SECONDS);
  const lastAmrapSession = sorted.find((s) => s.sets.some((x) => x.is_amrap));
  const daysSinceAmrap = lastAmrapSession
    ? Math.floor((nowSec - lastAmrapSession.start_time) / DAY_SECONDS)
    : Infinity;

  // Set-by-set, in set order: the whole session shape (e.g. 23-23-20-18)
  // carries forward, not just the top set. Every logged RIR gets used —
  // each set's next target floats off that set's own self-report.
  const lastSets = [...last.sets].sort((a, b) => a.set_num - b.set_num);
  const lastSeq = lastSets.map((s) => s.reps);

  let sequence: number[];
  let note: string;

  if (gapDays <= GAP_REPEAT_MIN_DAYS - 1) {
    // Back-to-back or every-other-day cadence: progress each set off its own
    // self-reported RIR — the productive 1-3 RIR band self-calibrates.
    sequence = lastSets.map((s) => progressFromRir(s.reps, s.rir));
    note = `Each set progressed off its own logged RIR (last session: ${lastSeq.join("-")}).`;
  } else if (gapDays <= GAP_REPEAT_MAX_DAYS) {
    sequence = lastSeq.slice();
    note = `${gapDays}-day gap — repeating last session before progressing.`;
  } else if (gapDays <= GAP_EASE_MAX_DAYS) {
    sequence = lastSeq.map((r) => Math.max(1, Math.round(r * 0.85)));
    note = `${gapDays}-day gap — easing back in at ~85% of last session.`;
  } else {
    sequence = lastSeq.map((r) => Math.max(1, Math.round(r * 0.7)));
    note = `${gapDays}-day layoff — soft restart at ~70% of last session. AMRAP retest recommended to re-read where you're at.`;
  }

  sequence = applyTaper(sequence);

  const floor = floorFromBest;
  const seqTop = Math.max(...sequence);
  if (floor != null && seqTop < floor) {
    // Scale the whole session up so its top set lands on the floor,
    // preserving the set-to-set shape rather than flattening it.
    sequence = sequence.map((r) => Math.max(1, Math.round((r * floor) / seqTop)));
    note += ` Floor applied (${Math.round(FLOOR_PCT * 100)}% of best-ever ${bestAmrap}).`;
  }

  return {
    movement,
    target_sets: sequence.length,
    target_reps: Math.max(...sequence),
    target_sequence: sequence,
    last_sequence: lastSeq,
    rir_target: "1-3",
    amrap_due: daysSinceAmrap >= AMRAP_INTERVAL_DAYS || gapDays >= GAP_SOFT_RESTART_DAYS,
    floor_reps: floor ?? Math.max(...sequence),
    best_amrap_reps: bestAmrap,
    gap_days: gapDays,
    note,
  };
}

/** Cap each set at the top-loaded taper curve (see TAPER_* above). */
function applyTaper(sequence: number[]): number[] {
  const top = Math.max(...sequence);
  return sequence.map((r, i) => {
    if (i < TAPER_FULL_SETS) return r;
    const cap = Math.round(top * (1 - TAPER_STEP * (i - TAPER_FULL_SETS + 1)));
    return Math.max(1, Math.min(r, cap));
  });
}

function maxAmrapReps(history: SessionLog[]): number | null {
  let max: number | null = null;
  for (const s of history) {
    for (const x of s.sets) {
      if (x.is_amrap) max = max == null ? x.reps : Math.max(max, x.reps);
    }
  }
  return max;
}

/** The autoregulation core: a set's next target floats off its own self-reported RIR. */
function progressFromRir(reps: number, rir: number | null): number {
  if (rir == null) return reps; // an AMRAP set (or unreported RIR) — hold; amrap_due scheduling drives the real update
  if (rir <= 0) return reps; // already maxed out that set — don't push blind
  if (rir <= 3) return reps + 1; // the productive 1-3 RIR band
  return reps + 2; // rir > 3: under-challenged, correct with a bigger jump
}

// ---------------------------------------------------------------------------
// Per-session card stats: a single "effort" number for list views, plus the
// raw rep sequence. Deliberately self-referential rather than measured
// against an absolute rep count — the whole point (per the athlete's own
// framing) is a number that's reachable early at a low absolute rep count
// and stays meaningful as capability grows, rather than "% of 100 pushups".
// ---------------------------------------------------------------------------

export interface SessionCardStats {
  source_id: string;
  sequence: string; // "15-15-10-10", in set order
  top_reps: number; // raw top-set reps, for display
  effective_reps: number; // top-set reps adjusted by RIR — see effectiveReps()
  best_ever_prior: number | null; // best effective_reps across strictly-earlier sessions
  effort_pct: number | null; // round(100 * effective_reps / best_ever_prior); null with no prior session
}

/**
 * A set's reps "as if taken to failure": RIR literally means reps still left
 * in the tank, so reps+RIR estimates true capacity shown on that set — a
 * fairer capability readout than raw reps alone (15 reps @ RIR 4 shows less
 * than 15 @ RIR 0). An AMRAP set already *is* that number (rir treated as 0).
 * Self-correcting over time: AMRAP sets bypass the RIR self-report entirely,
 * so periodic retests true up any drift from chronically over/under-rating
 * RIR (see CLAUDE.md's autoregulation notes on why AMRAP exists at all).
 */
function effectiveReps(set: SetLog): number {
  return set.is_amrap ? set.reps : set.reps + (set.rir ?? 0);
}

/**
 * Per-session stats for a chronologically-ascending history of one movement.
 * `best_ever_prior` only looks at sessions strictly before the one being
 * scored, so a session is always judged against what was known going into
 * it — not a personal best it hasn't happened yet, and not a personal best
 * inflated by later improvement. That's what lets an early session reach a
 * high effort_pct without a big absolute rep count, and keeps the bar
 * honestly moving as real capability grows.
 */
export function summarizeSessions(historyAsc: SessionLog[]): SessionCardStats[] {
  const out: SessionCardStats[] = [];
  let bestSoFar: number | null = null;
  for (const session of historyAsc) {
    if (!session.sets.length) continue;
    const effective = Math.max(...session.sets.map(effectiveReps));
    const topReps = Math.max(...session.sets.map((s) => s.reps));
    out.push({
      source_id: session.source_id,
      sequence: session.sets.map((s) => s.reps).join("-"),
      top_reps: topReps,
      effective_reps: effective,
      best_ever_prior: bestSoFar,
      effort_pct: bestSoFar != null ? Math.round((100 * effective) / bestSoFar) : null,
    });
    bestSoFar = bestSoFar == null ? effective : Math.max(bestSoFar, effective);
  }
  return out;
}

// ---------------------------------------------------------------------------
// D1 history lookup. Kept alongside the pure engine (rather than store.ts,
// which is entirely about the HAE/Wahoo device-ingest pipeline) since this is
// domain-specific to calisthenics, not part of that pipeline.
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 30; // plenty for gap/AMRAP-scheduling logic; this is a personal log, not a big table

export async function getCalisthenicsHistory(
  db: D1Database,
  userId: string,
  movement: Movement,
  limit: number = HISTORY_LIMIT,
): Promise<SessionLog[]> {
  const workouts = await db
    .prepare(
      `SELECT id, source_id, start_time FROM workouts
        WHERE user_id = ? AND sport = 'calisthenics' AND sub_type = ?
        ORDER BY start_time DESC LIMIT ?`,
    )
    .bind(userId, movement, limit)
    .all<{ id: string; source_id: string; start_time: number }>();
  const rows = workouts.results ?? [];
  if (rows.length === 0) return [];

  const placeholders = rows.map(() => "?").join(",");
  const sets = await db
    .prepare(
      `SELECT workout_id, set_num, reps, rir, is_amrap FROM calisthenics_sets
        WHERE workout_id IN (${placeholders}) ORDER BY workout_id, set_num`,
    )
    .bind(...rows.map((r) => r.id))
    .all<{ workout_id: string; set_num: number; reps: number; rir: number | null; is_amrap: number }>();

  const byWorkout = new Map<string, SetLog[]>();
  for (const s of sets.results ?? []) {
    const arr = byWorkout.get(s.workout_id) ?? [];
    arr.push({ set_num: s.set_num, reps: s.reps, rir: s.rir, is_amrap: Boolean(s.is_amrap) });
    byWorkout.set(s.workout_id, arr);
  }

  return rows.map((r) => ({
    workout_id: r.id,
    source_id: r.source_id,
    start_time: r.start_time,
    sets: byWorkout.get(r.id) ?? [],
  }));
}

// Card-stats consumers (the workouts list, the detail page) want the athlete's
// full calisthenics history regardless of what's paginated on screen, since
// best_ever_prior must be computed over everything that came before, not just
// the current page. Comfortably above what a personal log will hit for a
// long while; revisit if this ever needs to page too.
export const CARD_STATS_HISTORY_LIMIT = 500;
