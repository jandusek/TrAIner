/**
 * Persist a Health Auto Export payload: raw-first to R2, derived summary to D1.
 *
 * For each workout in the batch:
 *   1. Write the raw workout JSON to R2 at raw/{source_id}.json (+ .meta.json).
 *      R2 is the source of truth; re-running the parser over it repopulates D1.
 *   2. Upsert a summary row into D1 keyed by source_id (HealthKit UUID), so
 *      re-sends and overlapping backfills are idempotent.
 */

import {
  extractWorkouts,
  parseWorkoutSummary,
  extractHaeHrSamples,
  extractHaeStepCountSamples,
  ParseError,
  PARSER_VERSION,
  type HaeWorkout,
  type WorkoutSummary,
} from "./parse";
import { reconstructLaps, type Lap } from "./laps";
import { downsampleRoute, extractHaeRoute, type RoutePoint } from "./route";
import type { PowerCadenceSample } from "./fit";
import type { User } from "./users";

export interface IngestResult {
  count: number;
  inserted: string[]; // source_ids new to this user
  updated: string[]; // source_ids that already existed (replaced)
  skipped_deleted: string[]; // source_ids tombstoned by a prior delete — not re-inserted
  laps: number; // total reconstructed laps written across the batch
  superseded: number; // HAE rows in this batch marked superseded by an existing Wahoo row
  dropped_wahoo_echoes: string[]; // HAE rows dropped as the Wahoo/ELEMNT app's own HealthKit echo
  errors: { index: number; source_id?: string; error: string }[];
  parser_version: string;
}

interface StoreEnv {
  DB: D1Database;
  RAW: R2Bucket;
}

const rawKey = (sourceId: string) => `raw/${sourceId}.json`;
const metaKey = (sourceId: string) => `raw/${sourceId}.meta.json`;

export async function storeWorkouts(
  env: StoreEnv,
  user: User,
  payload: unknown,
): Promise<IngestResult> {
  const workouts = extractWorkouts(payload); // throws ParseError on bad shape

  const ingestedAt = Math.floor(Date.now() / 1000);
  const result: IngestResult = {
    count: workouts.length,
    inserted: [],
    updated: [],
    skipped_deleted: [],
    laps: 0,
    superseded: 0,
    dropped_wahoo_echoes: [],
    errors: [],
    parser_version: PARSER_VERSION,
  };

  // Parse first; collect per-workout errors without aborting the whole batch.
  const parsedAll: { summary: WorkoutSummary; raw: HaeWorkout }[] = [];
  workouts.forEach((w, index) => {
    try {
      parsedAll.push({ summary: parseWorkoutSummary(w), raw: w });
    } catch (e) {
      result.errors.push({
        index,
        source_id: typeof w?.id === "string" ? w.id : undefined,
        error: e instanceof ParseError ? e.message : String(e),
      });
    }
  });

  if (parsedAll.length === 0) return result;

  // Drop anything the athlete has already deleted — see migrations/0013_deleted_workouts.sql.
  // Without this, the athlete's own automation re-sending an HAE export would just
  // re-insert a workout they explicitly removed (source_id is the upsert key).
  const deletedIds = await selectDeletedSourceIds(
    env.DB,
    user.id,
    parsedAll.map((p) => p.summary.source_id),
  );
  const parsed = parsedAll.filter((p) => !deletedIds.has(p.summary.source_id));
  result.skipped_deleted = parsedAll
    .filter((p) => deletedIds.has(p.summary.source_id))
    .map((p) => p.summary.source_id);

  if (parsed.length === 0) return result;

  // Classify insert vs update by checking which source_ids this user already has.
  const sourceIds = parsed.map((p) => p.summary.source_id);
  const existing = await selectExistingSourceIds(env.DB, user.id, sourceIds);

  // Raw-first: write every raw workout + meta to R2 before touching D1, so D1
  // never references an R2 key that isn't there.
  await Promise.all(
    parsed.flatMap(({ summary, raw }) => [
      env.RAW.put(rawKey(summary.source_id), JSON.stringify(raw), {
        httpMetadata: { contentType: "application/json" },
      }),
      env.RAW.put(
        metaKey(summary.source_id),
        JSON.stringify({
          source_id: summary.source_id,
          user_id: user.id,
          parser_version: PARSER_VERSION,
          ingested_at: ingestedAt,
        }),
        { httpMetadata: { contentType: "application/json" } },
      ),
    ]),
  );

  // Upsert summaries. id is generated only on insert; ON CONFLICT keeps the
  // existing id/user_id and refreshes the derived fields.
  const stmts = parsed.map(({ summary }) =>
    upsertWorkoutStatement(env.DB, user.id, summary, rawKey(summary.source_id), PARSER_VERSION, ingestedAt),
  );
  await env.DB.batch(stmts);

  const existingSet = new Set(existing);
  for (const id of sourceIds) {
    (existingSet.has(id) ? result.updated : result.inserted).push(id);
  }

  // Reconstruct + write swim laps. Needs the workout's internal id, which
  // ON CONFLICT may have kept from a prior ingest, so resolve it post-upsert.
  result.laps = await writeLaps(env.DB, user.id, parsed);

  // Extract + write the GPS track for outdoor cycling/running (empty for swims,
  // tennis, and indoor sessions). Also needs the post-upsert internal id.
  await writeHaeRoutes(env.DB, user.id, parsed);

  // Merge in HR samples for cycling — the Wahoo has no chest strap, so HR only
  // ever comes from this (Apple Watch) side. See writeCyclingSamples.
  await writeHaeHrSamples(env.DB, user.id, parsed);

  // Keep the raw per-second HR stream for swims too, for the heart-rate-zones
  // chart on the detail page. See writeHaeSwimHrSamples.
  await writeHaeSwimHrSamples(env.DB, user.id, parsed);

  // Derive + write the per-interval cadence stream for runs, for the cadence
  // chart on the detail page. See writeHaeRunningCadenceSamples.
  await writeHaeRunningCadenceSamples(env.DB, user.id, parsed);

  // Keep the raw HR stream for runs too, so its chart can sit alongside
  // cadence with cross-chart hover sync. See writeHaeRunningHrSamples.
  await writeHaeRunningHrSamples(env.DB, user.id, parsed);

  // Keep the raw per-second HR stream for tennis too, for the same
  // heart-rate-zones + line chart as swim. See writeHaeTennisHrSamples.
  await writeHaeTennisHrSamples(env.DB, user.id, parsed);

  // If a Wahoo ride for the same user/sport/time already exists, this HAE row
  // is very likely an echo of it (ELEMNT app writing into Apple Health, HAE
  // re-exporting from there) — see migrations/0009_supersession.sql for why
  // Wahoo always wins. Re-checked on every ingest, not just first insert:
  // harmless if already marked, and covers the case where HAE synced before
  // the Wahoo webhook fired.
  const idBySource = await selectIdsBySource(env.DB, user.id, sourceIds);
  const dropped = new Set<string>();
  for (const { summary } of parsed) {
    const workoutId = idBySource.get(summary.source_id);
    if (!workoutId) continue;
    const outcome = await supersedeSelfIfWahooOverlapExists(
      env,
      user.id,
      workoutId,
      summary.source_id,
      summary.sport,
      summary.sub_type,
      summary.start_time,
      summary.end_time,
      rawKey(summary.source_id),
    );
    if (outcome === "superseded") result.superseded++;
    if (outcome === "dropped") {
      dropped.add(summary.source_id);
      result.dropped_wahoo_echoes.push(summary.source_id);
    }
  }
  // A dropped row was recorded as inserted/updated above, before we knew it
  // was a redundant echo — it no longer exists, so pull it back out of both.
  if (dropped.size > 0) {
    result.inserted = result.inserted.filter((id) => !dropped.has(id));
    result.updated = result.updated.filter((id) => !dropped.has(id));
  }

  return result;
}

// Two cycling recordings that overlap in time are the same ride: the athlete
// can't be on two bikes at once. So supersession matches on genuine interval
// overlap rather than start-time proximity — the fraction of the HAE row's own
// duration that falls inside the Wahoo row's interval.
//
// Start-proximity (the previous rule, ±300s of the Wahoo row's start) only ever
// caught a Watch recording that began alongside the ride. It structurally missed
// the case where one Wahoo ride spans SEVERAL Watch workouts — leave the head
// unit running through a stop (a commute out and back, a cafe stop) and the
// Watch records a workout per leg, while the Wahoo records one ride across the
// lot. Leg 2 starts an hour into the Wahoo ride, so no tolerance value can
// reach it, and it survived as a duplicate that double-counted the distance.
// Confirmed 2026-07-15: an 8.5km Wahoo ride (13:06-14:20) spanning Watch legs at
// 13:10-13:29 and 14:05-14:24; the first was superseded, the second was not.
//
// Half is a deliberately loose bar. The legs of a split ride overlap the Wahoo
// row nearly fully, but only nearly: whichever device is stopped first trims the
// tail (the 2026-07-15 return leg ran 4:42 past the Wahoo's end — the head unit
// was saved before the Watch — leaving 76% overlap). Anything above noise would
// do; there is no competing ride to confuse it with.
const OVERLAP_MIN_FRACTION = 0.5;

// Among the overlapping rows, a HAE row whose start_time lands THIS close to
// the Wahoo row's own start_time isn't a second independently-started
// recording (two separate devices, started by hand, essentially never land
// on the same UTC second) — it's the Wahoo/ELEMNT app's own write-back of
// that exact ride into Apple Health. Confirmed 2026-07-02: two such rides
// each had both a genuine Watch echo (start_time off by tens of seconds) AND
// an ELEMNT echo (start_time matching the Wahoo row to the second), and the
// list view's one-echo-per-ride join fanned out over the pair. That pairing
// used to only ever see one echo — see migrations/0009_supersession.sql's
// "no additional data" note — so it never needed to distinguish the two.
const EXACT_START_TOLERANCE_SEC = 3;

export interface Interval {
  start_time: number;
  end_time: number;
}

/** Seconds of `a` that fall inside `b`. Zero when they don't intersect. */
export const overlapSec = (a: Interval, b: Interval) =>
  Math.max(0, Math.min(a.end_time, b.end_time) - Math.max(a.start_time, b.start_time));

/** Does `hae` overlap `wahoo` by enough of its own duration to be the same ride? */
export function overlapsEnough(hae: Interval, wahoo: Interval): boolean {
  const haeDuration = hae.end_time - hae.start_time;
  if (haeDuration <= 0) return overlapSec(hae, wahoo) > 0;
  return overlapSec(hae, wahoo) >= haeDuration * OVERLAP_MIN_FRACTION;
}

/**
 * Called from the HAE path after upserting a workout: if a Wahoo-sourced
 * workout already exists for the same user/sport whose interval this row
 * substantially overlaps, either drop this (HAE) row outright (Wahoo/ELEMNT's
 * own echo — see EXACT_START_TOLERANCE_SEC) or mark it superseded by the Wahoo
 * row (a genuine separate Watch recording, kept around to backfill HR).
 *
 * Picks the best-overlapping Wahoo row rather than an arbitrary one: back-to-back
 * rides (head unit stopped and restarted between legs) put two Wahoo candidates
 * in reach, and this row belongs to whichever it shares more time with.
 */
async function supersedeSelfIfWahooOverlapExists(
  env: StoreEnv,
  userId: string,
  haeWorkoutId: string,
  haeSourceId: string,
  sport: string,
  subType: string | null,
  startTime: number,
  endTime: number,
  rawR2Key: string,
): Promise<"superseded" | "dropped" | "none"> {
  const candidates = await env.DB
    .prepare(
      `SELECT id, start_time, end_time FROM workouts
       WHERE user_id = ? AND sport = ? AND source_id LIKE 'wahoo:%'
         AND end_time > ? AND start_time < ?`,
    )
    .bind(userId, sport, startTime, endTime)
    .all<{ id: string; start_time: number; end_time: number }>();

  const self = { start_time: startTime, end_time: endTime };
  const row = (candidates.results ?? [])
    .filter((c) => overlapsEnough(self, c))
    .sort((a, b) => overlapSec(self, b) - overlapSec(self, a))[0];
  if (!row) return "none";

  if (Math.abs(row.start_time - startTime) <= EXACT_START_TOLERANCE_SEC) {
    await dropWahooAppEcho(env, userId, haeWorkoutId, haeSourceId, sport, subType, startTime, rawR2Key);
    return "dropped";
  }
  await env.DB.prepare("UPDATE workouts SET superseded_by = ? WHERE id = ?").bind(row.id, haeWorkoutId).run();
  // This HAE row is where writeHaeHrSamples just wrote HR (it ran before
  // supersession is known) — move those samples onto the surviving Wahoo row
  // so they end up on the same (workout_id, t) as its power/cadence.
  await migrateCyclingSamples(env.DB, haeWorkoutId, row.id);
  await backfillWahooHrFromSamples(env.DB, row.id);
  return "superseded";
}

/**
 * Called from the Wahoo path after upserting a workout: for every (unsuperseded)
 * HAE-sourced workout for the same user/sport that this ride's interval
 * substantially overlaps, either drop it outright (Wahoo/ELEMNT's own echo) or
 * mark it superseded by this Wahoo one (a genuine Watch recording) — covers the
 * more common ordering, since Wahoo's webhook fires near-instantly while HAE
 * syncs on its own schedule.
 *
 * Handles ALL overlapping rows, not just the first: one Wahoo ride routinely
 * spans several Watch workouts (see OVERLAP_MIN_FRACTION), and it can hold both
 * a genuine Watch echo and an ELEMNT echo at once, which want opposite
 * treatments. Returns the ids of the rows marked superseded (excluding any
 * dropped as echoes).
 */
async function supersedeOverlappingHaeRows(
  env: StoreEnv,
  userId: string,
  wahooWorkoutId: string,
  sport: string,
  startTime: number,
  endTime: number,
): Promise<string[]> {
  const candidates = await env.DB
    .prepare(
      `SELECT id, source_id, sub_type, start_time, end_time, raw_r2_key FROM workouts
       WHERE user_id = ? AND sport = ? AND source_id NOT LIKE 'wahoo:%'
         AND end_time > ? AND start_time < ? AND superseded_by IS NULL`,
    )
    .bind(userId, sport, startTime, endTime)
    .all<{
      id: string;
      source_id: string;
      sub_type: string | null;
      start_time: number;
      end_time: number;
      raw_r2_key: string;
    }>();

  const wahoo = { start_time: startTime, end_time: endTime };
  const superseded: string[] = [];
  for (const row of candidates.results ?? []) {
    if (!overlapsEnough(row, wahoo)) continue;
    if (Math.abs(row.start_time - startTime) <= EXACT_START_TOLERANCE_SEC) {
      await dropWahooAppEcho(env, userId, row.id, row.source_id, sport, row.sub_type, row.start_time, row.raw_r2_key);
      continue;
    }
    await env.DB.prepare("UPDATE workouts SET superseded_by = ? WHERE id = ?").bind(wahooWorkoutId, row.id).run();
    // The HAE row being superseded may already hold HR samples (written by an
    // earlier HAE ingest, before this Wahoo row existed) — move them onto the
    // Wahoo row so the chart can find both series under one workout_id.
    await migrateCyclingSamples(env.DB, row.id, wahooWorkoutId);
    superseded.push(row.id);
  }
  if (superseded.length > 0) await backfillWahooHrFromSamples(env.DB, wahooWorkoutId);
  return superseded;
}

/**
 * Clock-skew tolerance when deciding whether a Watch HR sample falls inside a
 * stretch the head unit was recording. The two devices keep their own clocks and
 * don't agree to the second (see 0012_cycling_samples_by_source.sql), so "was
 * the Wahoo recording at this instant" has to be a window, not an equality.
 *
 * The exact value barely matters: auto-paused blocks last minutes, so only the
 * handful of samples at each pause boundary are ambiguous. Sweeping the rain-stop
 * ride (wahoo:476320810) from ±1s to ±20s moves its moving-time average across
 * 119.7 → 118.5 bpm — noise next to the 11 bpm error this whole function fixes.
 */
const WAHOO_CLOCK_SKEW_SEC = 5;

/**
 * Derive a Wahoo row's avg/max HR from the Watch samples migrated onto it.
 *
 * The read path used to borrow HR straight off the superseded echo's summary
 * row (COALESCE(w.avg_hr, echo.avg_hr) in index.ts). With one echo per ride that
 * was exact. Once a ride can have several — see OVERLAP_MIN_FRACTION — the
 * echo join has to pick one, and reporting a single leg's average as the whole
 * ride's would be silently wrong. The migrated per-second samples span every
 * leg, so recomputing from them is both correct and independent of how many
 * echoes there are.
 *
 * avg_hr is restricted to seconds the head unit was actually recording. The Wahoo
 * auto-pauses and the Watch does not, so the Watch's stream keeps logging a
 * resting rider — at a red light, or waiting out rain — and averaging all of it
 * reports a heart rate the athlete never rode at. On wahoo:476320810 (30 km, a
 * long rain wait mid-ride) that dragged avg_hr to 108.5 against a true riding
 * average of 119.5. Intersecting with the Wahoo's own samples is what defines
 * "moving" here: the head unit simply writes no record while paused, so the
 * presence of a Wahoo sample near a given second IS the moving signal, and it
 * puts avg_hr on the same timer-time base as avg_power_w/avg_cadence_rpm
 * (see migrations/0023_moving_time.sql on the four-clock mess this untangles).
 *
 * max_hr deliberately stays over every sample. An average needs a consistent
 * denominator; a peak doesn't. HR lags effort by 10-20s, so the true maximum of a
 * hard effort routinely lands in the seconds just after the rider stops pedaling —
 * excluding stopped time would throw that peak away for no gain.
 *
 * Only fills a NULL avg_hr: a Wahoo row with its own HR was recorded with a
 * chest strap paired, which beats the Watch's wrist optical read — don't clobber
 * it. Idempotent, so re-running on every ingest is safe; the same recomputation
 * backs migrations/0021's and 0023's backfills.
 */
export async function backfillWahooHrFromSamples(db: D1Database, wahooWorkoutId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE workouts SET
         avg_hr = COALESCE(avg_hr, (
           SELECT AVG(w.hr) FROM cycling_samples w
            WHERE w.workout_id = ? AND w.source = 'watch' AND w.hr IS NOT NULL
              AND EXISTS (SELECT 1 FROM cycling_samples p
                           WHERE p.workout_id = ? AND p.source = 'wahoo'
                             AND p.t BETWEEN w.t - ? AND w.t + ?)
         )),
         max_hr = COALESCE(max_hr, (SELECT MAX(hr) FROM cycling_samples
                                     WHERE workout_id = ? AND source = 'watch' AND hr IS NOT NULL))
       WHERE id = ?`,
    )
    .bind(
      wahooWorkoutId,
      wahooWorkoutId,
      WAHOO_CLOCK_SKEW_SEC,
      WAHOO_CLOCK_SKEW_SEC,
      wahooWorkoutId,
      wahooWorkoutId,
    )
    .run();
}

/**
 * Drop a HAE row identified as the Wahoo/ELEMNT app's own HealthKit
 * write-back (see EXACT_START_TOLERANCE_SEC) rather than a genuine second
 * recording: delete its raw R2 objects and `workouts` row (children cascade
 * — see migrations/0013_deleted_workouts.sql) and tombstone its source_id so
 * a future re-sync (HAE re-exporting, a backfill) doesn't resurrect it.
 * Mirrors deleteWorkout()'s effect, minus the R2-key-suffix guessing that
 * function needs for Wahoo's own raw layout — this is always an HAE row.
 */
async function dropWahooAppEcho(
  env: StoreEnv,
  userId: string,
  workoutId: string,
  sourceId: string,
  sport: string,
  subType: string | null,
  startTime: number,
  rawR2Key: string,
): Promise<void> {
  const metaR2Key = rawR2Key.replace(/\.[^./]+$/, ".meta.json");
  await env.RAW.delete([rawR2Key, metaR2Key]);
  const deletedAt = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workouts WHERE id = ?").bind(workoutId),
    env.DB
      .prepare(
        `INSERT INTO deleted_workouts (source_id, user_id, sport, sub_type, start_time, reason, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_id) DO UPDATE SET
           reason     = excluded.reason,
           deleted_at = excluded.deleted_at`,
      )
      .bind(
        sourceId,
        userId,
        sport,
        subType,
        startTime,
        "Auto-dropped: Wahoo/ELEMNT app's own HealthKit echo of a directly-ingested Wahoo ride " +
          "(start_time matched the Wahoo row to the second) — no data beyond the canonical wahoo: row",
        deletedAt,
      ),
  ]);
}

/**
 * Move `cycling_samples` rows from a just-superseded workout onto its
 * canonical sibling. Each row already carries its own `source`, so this is a
 * plain re-key, not a column-wise merge — Wahoo and Watch rows never
 * contend for the same primary key (see migrations/0012_cycling_samples_by_source.sql
 * for why: the two devices' clocks don't agree closely enough to usefully
 * merge column-wise on matching seconds anyway). Idempotent: a no-op once
 * `fromWorkoutId` has no rows left, which happens after the first successful
 * migration and on every subsequent re-ingest.
 */
async function migrateCyclingSamples(db: D1Database, fromWorkoutId: string, toWorkoutId: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cycling_samples (workout_id, t, source, power_w, cadence_rpm, hr)
       SELECT ?, t, source, power_w, cadence_rpm, hr FROM cycling_samples WHERE workout_id = ?
       ON CONFLICT(workout_id, t, source) DO UPDATE SET
         power_w     = excluded.power_w,
         cadence_rpm = excluded.cadence_rpm,
         hr          = excluded.hr`,
    )
    .bind(toWorkoutId, fromWorkoutId)
    .run();
  await db.prepare("DELETE FROM cycling_samples WHERE workout_id = ?").bind(fromWorkoutId).run();
}

/**
 * Rebuild laps for every swim in the batch. Laps are derived data: delete the
 * workout's existing laps and reinsert, so re-ingest is idempotent and a parser
 * change just needs a re-ingest from R2.
 */
async function writeLaps(
  db: D1Database,
  userId: string,
  parsed: { summary: WorkoutSummary; raw: HaeWorkout }[],
): Promise<number> {
  const swims = parsed.filter((p) => p.summary.sport === "swimming");
  if (swims.length === 0) return 0;

  const idBySource = await selectIdsBySource(
    db,
    userId,
    swims.map((s) => s.summary.source_id),
  );

  const stmts: D1PreparedStatement[] = [];
  let total = 0;
  for (const { summary, raw } of swims) {
    const workoutId = idBySource.get(summary.source_id);
    if (!workoutId) continue;
    const laps = reconstructLaps(raw, summary.pool_length_m);
    stmts.push(db.prepare("DELETE FROM laps WHERE workout_id = ?").bind(workoutId));
    for (const lap of laps) {
      stmts.push(lapInsert(db, workoutId, lap));
      total++;
    }
  }
  if (stmts.length > 0) await db.batch(stmts);
  return total;
}

// Sports that can carry a GPS track. Skipping the rest avoids a needless
// delete-route round-trip for every pool swim and tennis session.
const ROUTE_SPORTS = new Set(["cycling", "running"]);

// Upper bound on stored points per workout. A 1 Hz FIT track of a ~2 h ride is
// ~7 k samples; thinning to this keeps D1 writes bounded while leaving far more
// fidelity than the display ever needs. The raw R2 archive still has every
// original sample. SQLite's 100-variable statement limit (D1) caps a multi-row
// insert at 16 rows (16 × 6 cols = 96), so writes chunk accordingly.
const STORE_MAX_ROUTE_POINTS = 4000;
const ROUTE_COLS = 6;
const ROUTE_ROWS_PER_INSERT = Math.floor(100 / ROUTE_COLS); // 16
const ROUTE_INSERTS_PER_BATCH = 20; // ≤ 320 rows per D1 transaction

/**
 * Extract + write GPS tracks for every route-bearing workout in an HAE batch.
 * Idempotent like laps: a workout's points are deleted and rewritten, so
 * re-ingest (or a parser bump + replay from R2) just refreshes the track.
 */
async function writeHaeRoutes(
  db: D1Database,
  userId: string,
  parsed: { summary: WorkoutSummary; raw: HaeWorkout }[],
): Promise<void> {
  const routed = parsed.filter((p) => ROUTE_SPORTS.has(p.summary.sport));
  if (routed.length === 0) return;

  const idBySource = await selectIdsBySource(
    db,
    userId,
    routed.map((p) => p.summary.source_id),
  );
  for (const { summary, raw } of routed) {
    const workoutId = idBySource.get(summary.source_id);
    if (!workoutId) continue;
    await writeRoute(db, workoutId, extractHaeRoute(raw));
  }
}

/**
 * Merge Apple Watch HR samples into `cycling_samples` for every cycling
 * workout in an HAE batch. Cycling-only: swims/tennis/running don't have a
 * Wahoo power counterpart to merge against, and get no benefit from this table.
 */
async function writeHaeHrSamples(
  db: D1Database,
  userId: string,
  parsed: { summary: WorkoutSummary; raw: HaeWorkout }[],
): Promise<void> {
  const rides = parsed.filter((p) => p.summary.sport === "cycling");
  if (rides.length === 0) return;

  const idBySource = await selectIdsBySource(
    db,
    userId,
    rides.map((p) => p.summary.source_id),
  );
  for (const { summary, raw } of rides) {
    const workoutId = idBySource.get(summary.source_id);
    if (!workoutId) continue;
    const samples = extractHaeHrSamples(raw).map((s) => ({ t: s.t, power_w: null, cadence_rpm: null, hr: s.hr }));
    await writeCyclingSamples(db, workoutId, "watch", samples);
  }
}

/**
 * Write the raw per-second HR stream for every swim in an HAE batch, into
 * `swim_hr_samples` (see migrations/0014_swim_hr_samples.sql). Same source
 * field (`heartRateData`) laps.ts already reads for per-lap avg_hr/max_hr —
 * this just keeps the stream itself for the session-level zones chart.
 */
async function writeHaeSwimHrSamples(
  db: D1Database,
  userId: string,
  parsed: { summary: WorkoutSummary; raw: HaeWorkout }[],
): Promise<void> {
  const swims = parsed.filter((p) => p.summary.sport === "swimming");
  if (swims.length === 0) return;

  const idBySource = await selectIdsBySource(
    db,
    userId,
    swims.map((p) => p.summary.source_id),
  );
  for (const { summary, raw } of swims) {
    const workoutId = idBySource.get(summary.source_id);
    if (!workoutId) continue;
    await writeSwimHrSamples(db, workoutId, extractHaeHrSamples(raw));
  }
}

/**
 * Derive + write the per-interval cadence stream for every run in an HAE
 * batch, into `running_cadence_samples` (see
 * migrations/0015_running_cadence_samples.sql). Running-only: it's the one
 * sport where HAE is the sole source and has no native per-second cadence
 * field to read directly — see extractHaeStepCountSamples's derivation.
 */
async function writeHaeRunningCadenceSamples(
  db: D1Database,
  userId: string,
  parsed: { summary: WorkoutSummary; raw: HaeWorkout }[],
): Promise<void> {
  const runs = parsed.filter((p) => p.summary.sport === "running");
  if (runs.length === 0) return;

  const idBySource = await selectIdsBySource(
    db,
    userId,
    runs.map((p) => p.summary.source_id),
  );
  for (const { summary, raw } of runs) {
    const workoutId = idBySource.get(summary.source_id);
    if (!workoutId) continue;
    await writeRunningCadenceSamples(db, workoutId, extractHaeStepCountSamples(raw));
  }
}

// 3 cols/row (workout_id, t, cadence_spm) — same shape/limit reasoning as
// writeSwimHrSamples.
const RUNNING_SAMPLE_ROWS_PER_INSERT = 16;
const RUNNING_SAMPLE_INSERTS_PER_BATCH = 20; // ≤ 320 rows per D1 transaction

/**
 * Upsert per-interval running cadence samples. Derived data, same re-ingest
 * contract as `swim_hr_samples`/`cycling_samples`: a re-run just overwrites
 * via ON CONFLICT (see writeCyclingSamples for the equivalent
 * shrink-on-reingest caveat).
 */
async function writeRunningCadenceSamples(
  db: D1Database,
  workoutId: string,
  samples: { t: number; cadence_spm: number }[],
): Promise<number> {
  if (samples.length === 0) return 0;
  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < samples.length; i += RUNNING_SAMPLE_ROWS_PER_INSERT) {
    inserts.push(runningCadenceSampleInsert(db, workoutId, samples.slice(i, i + RUNNING_SAMPLE_ROWS_PER_INSERT)));
  }
  for (let i = 0; i < inserts.length; i += RUNNING_SAMPLE_INSERTS_PER_BATCH) {
    await db.batch(inserts.slice(i, i + RUNNING_SAMPLE_INSERTS_PER_BATCH));
  }
  return samples.length;
}

function runningCadenceSampleInsert(
  db: D1Database,
  workoutId: string,
  chunk: { t: number; cadence_spm: number }[],
): D1PreparedStatement {
  const values = chunk.map(() => "(?,?,?)").join(",");
  const binds: (string | number)[] = [];
  for (const s of chunk) binds.push(workoutId, s.t, s.cadence_spm);
  return db
    .prepare(
      `INSERT INTO running_cadence_samples (workout_id, t, cadence_spm) VALUES ${values}
       ON CONFLICT(workout_id, t) DO UPDATE SET cadence_spm = excluded.cadence_spm`,
    )
    .bind(...binds);
}

/**
 * Write the raw HR stream for every run in an HAE batch, into
 * `running_hr_samples` (see migrations/0016_running_hr_samples.sql). Same
 * source field (`heartRateData`) and extraction function as
 * writeHaeSwimHrSamples — running just didn't have a table for it yet.
 */
async function writeHaeRunningHrSamples(
  db: D1Database,
  userId: string,
  parsed: { summary: WorkoutSummary; raw: HaeWorkout }[],
): Promise<void> {
  const runs = parsed.filter((p) => p.summary.sport === "running");
  if (runs.length === 0) return;

  const idBySource = await selectIdsBySource(
    db,
    userId,
    runs.map((p) => p.summary.source_id),
  );
  for (const { summary, raw } of runs) {
    const workoutId = idBySource.get(summary.source_id);
    if (!workoutId) continue;
    await writeRunningHrSamples(db, workoutId, extractHaeHrSamples(raw));
  }
}

/**
 * Upsert per-~5s running HR samples. Same shape/limits and re-ingest
 * contract as writeSwimHrSamples.
 */
async function writeRunningHrSamples(db: D1Database, workoutId: string, samples: { t: number; hr: number }[]): Promise<number> {
  if (samples.length === 0) return 0;
  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < samples.length; i += SWIM_SAMPLE_ROWS_PER_INSERT) {
    inserts.push(runningHrSampleInsert(db, workoutId, samples.slice(i, i + SWIM_SAMPLE_ROWS_PER_INSERT)));
  }
  for (let i = 0; i < inserts.length; i += SWIM_SAMPLE_INSERTS_PER_BATCH) {
    await db.batch(inserts.slice(i, i + SWIM_SAMPLE_INSERTS_PER_BATCH));
  }
  return samples.length;
}

function runningHrSampleInsert(db: D1Database, workoutId: string, chunk: { t: number; hr: number }[]): D1PreparedStatement {
  const values = chunk.map(() => "(?,?,?)").join(",");
  const binds: (string | number)[] = [];
  for (const s of chunk) binds.push(workoutId, s.t, s.hr);
  return db
    .prepare(`INSERT INTO running_hr_samples (workout_id, t, hr) VALUES ${values} ON CONFLICT(workout_id, t) DO UPDATE SET hr = excluded.hr`)
    .bind(...binds);
}

/**
 * Write the raw HR stream for every tennis session in an HAE batch, into
 * `tennis_hr_samples` (see migrations/0017_tennis_hr_samples.sql). Same
 * source field (`heartRateData`) and extraction function as
 * writeHaeSwimHrSamples — tennis is HAE-only, same as swim.
 */
async function writeHaeTennisHrSamples(
  db: D1Database,
  userId: string,
  parsed: { summary: WorkoutSummary; raw: HaeWorkout }[],
): Promise<void> {
  const matches = parsed.filter((p) => p.summary.sport === "tennis");
  if (matches.length === 0) return;

  const idBySource = await selectIdsBySource(
    db,
    userId,
    matches.map((p) => p.summary.source_id),
  );
  for (const { summary, raw } of matches) {
    const workoutId = idBySource.get(summary.source_id);
    if (!workoutId) continue;
    await writeTennisHrSamples(db, workoutId, extractHaeHrSamples(raw));
  }
}

/**
 * Upsert per-~5s tennis HR samples. Same shape/limits and re-ingest contract
 * as writeSwimHrSamples.
 */
async function writeTennisHrSamples(db: D1Database, workoutId: string, samples: { t: number; hr: number }[]): Promise<number> {
  if (samples.length === 0) return 0;
  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < samples.length; i += SWIM_SAMPLE_ROWS_PER_INSERT) {
    inserts.push(tennisHrSampleInsert(db, workoutId, samples.slice(i, i + SWIM_SAMPLE_ROWS_PER_INSERT)));
  }
  for (let i = 0; i < inserts.length; i += SWIM_SAMPLE_INSERTS_PER_BATCH) {
    await db.batch(inserts.slice(i, i + SWIM_SAMPLE_INSERTS_PER_BATCH));
  }
  return samples.length;
}

function tennisHrSampleInsert(db: D1Database, workoutId: string, chunk: { t: number; hr: number }[]): D1PreparedStatement {
  const values = chunk.map(() => "(?,?,?)").join(",");
  const binds: (string | number)[] = [];
  for (const s of chunk) binds.push(workoutId, s.t, s.hr);
  return db
    .prepare(`INSERT INTO tennis_hr_samples (workout_id, t, hr) VALUES ${values} ON CONFLICT(workout_id, t) DO UPDATE SET hr = excluded.hr`)
    .bind(...binds);
}

// 3 cols/row (workout_id, t, hr) — SQLite's 100-variable limit allows far
// more than 16 rows/insert here, but capping at the same 16 keeps this in
// line with writeCyclingSamples rather than tuning a second constant.
const SWIM_SAMPLE_ROWS_PER_INSERT = 16;
const SWIM_SAMPLE_INSERTS_PER_BATCH = 20; // ≤ 320 rows per D1 transaction

/**
 * Upsert per-second swim HR samples. Derived data, same re-ingest contract as
 * `laps`/`cycling_samples`: a re-run just overwrites via ON CONFLICT (see
 * writeCyclingSamples for the equivalent shrink-on-reingest caveat).
 */
async function writeSwimHrSamples(db: D1Database, workoutId: string, samples: { t: number; hr: number }[]): Promise<number> {
  if (samples.length === 0) return 0;
  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < samples.length; i += SWIM_SAMPLE_ROWS_PER_INSERT) {
    inserts.push(swimHrSampleInsert(db, workoutId, samples.slice(i, i + SWIM_SAMPLE_ROWS_PER_INSERT)));
  }
  for (let i = 0; i < inserts.length; i += SWIM_SAMPLE_INSERTS_PER_BATCH) {
    await db.batch(inserts.slice(i, i + SWIM_SAMPLE_INSERTS_PER_BATCH));
  }
  return samples.length;
}

function swimHrSampleInsert(db: D1Database, workoutId: string, chunk: { t: number; hr: number }[]): D1PreparedStatement {
  const values = chunk.map(() => "(?,?,?)").join(",");
  const binds: (string | number)[] = [];
  for (const s of chunk) binds.push(workoutId, s.t, s.hr);
  return db
    .prepare(`INSERT INTO swim_hr_samples (workout_id, t, hr) VALUES ${values} ON CONFLICT(workout_id, t) DO UPDATE SET hr = excluded.hr`)
    .bind(...binds);
}

// SQLite's 100-variable limit / 6 cols per row caps a multi-row insert at 16
// rows; batched further to keep each D1 transaction modest.
const SAMPLE_COLS = 6; // workout_id, t, source, power_w, cadence_rpm, hr
const SAMPLE_ROWS_PER_INSERT = Math.floor(100 / SAMPLE_COLS); // 16
const SAMPLE_INSERTS_PER_BATCH = 20; // ≤ 320 rows per D1 transaction

/**
 * Upsert per-second cycling samples for one source ('wahoo' power/cadence or
 * 'watch' HR — see migrations/0012_cycling_samples_by_source.sql). No
 * cross-source merging: each source's rows are keyed by their own
 * (workout_id, t, source), so a Wahoo row and a Watch row at the same second
 * simply coexist rather than contending for one shared row. Re-ingesting from
 * the same source replaces its own prior values via ON CONFLICT.
 *
 * Known simplification: if a re-ingest shrinks a source's sample set (e.g. a
 * parser fix drops spurious points), the old extra rows aren't cleaned up —
 * acceptable at this project's personal, single-athlete scale.
 */
async function writeCyclingSamples(
  db: D1Database,
  workoutId: string,
  source: "wahoo" | "watch",
  samples: { t: number; power_w: number | null; cadence_rpm: number | null; hr: number | null }[],
): Promise<number> {
  if (samples.length === 0) return 0;
  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < samples.length; i += SAMPLE_ROWS_PER_INSERT) {
    inserts.push(cyclingSampleInsert(db, workoutId, source, samples.slice(i, i + SAMPLE_ROWS_PER_INSERT)));
  }
  for (let i = 0; i < inserts.length; i += SAMPLE_INSERTS_PER_BATCH) {
    await db.batch(inserts.slice(i, i + SAMPLE_INSERTS_PER_BATCH));
  }
  return samples.length;
}

function cyclingSampleInsert(
  db: D1Database,
  workoutId: string,
  source: "wahoo" | "watch",
  chunk: { t: number; power_w: number | null; cadence_rpm: number | null; hr: number | null }[],
): D1PreparedStatement {
  const values = chunk.map(() => "(?,?,?,?,?,?)").join(",");
  const binds: (string | number | null)[] = [];
  for (const s of chunk) binds.push(workoutId, s.t, source, s.power_w, s.cadence_rpm, s.hr);
  return db
    .prepare(
      `INSERT INTO cycling_samples (workout_id, t, source, power_w, cadence_rpm, hr) VALUES ${values}
       ON CONFLICT(workout_id, t, source) DO UPDATE SET
         power_w     = excluded.power_w,
         cadence_rpm = excluded.cadence_rpm,
         hr          = excluded.hr`,
    )
    .bind(...binds);
}

/**
 * Replace a workout's stored route with `points` (thinned to the cap). Shared
 * by the HAE and Wahoo/FIT paths. Always issues the DELETE — even for an empty
 * track — so an indoor re-ingest clears any stale points. Inserts are chunked
 * under SQLite's per-statement variable limit and grouped into small batches.
 */
export async function writeRoute(
  db: D1Database,
  workoutId: string,
  points: RoutePoint[],
): Promise<number> {
  const del = db.prepare("DELETE FROM route_points WHERE workout_id = ?").bind(workoutId);
  const thinned = downsampleRoute(points, STORE_MAX_ROUTE_POINTS);
  if (thinned.length === 0) {
    await db.batch([del]);
    return 0;
  }

  const inserts: D1PreparedStatement[] = [];
  for (let i = 0; i < thinned.length; i += ROUTE_ROWS_PER_INSERT) {
    inserts.push(routeInsert(db, workoutId, thinned.slice(i, i + ROUTE_ROWS_PER_INSERT)));
  }

  // First batch carries the DELETE so the rewrite is atomic; remaining insert
  // chunks follow. (D1 batches are per-transaction, not cross-batch atomic, but
  // a re-ingest is idempotent so a partial failure self-heals on retry.)
  await db.batch([del, ...inserts.slice(0, ROUTE_INSERTS_PER_BATCH - 1)]);
  for (let i = ROUTE_INSERTS_PER_BATCH - 1; i < inserts.length; i += ROUTE_INSERTS_PER_BATCH) {
    await db.batch(inserts.slice(i, i + ROUTE_INSERTS_PER_BATCH));
  }
  return thinned.length;
}

/** One multi-row INSERT for a chunk of ≤16 route points. */
function routeInsert(db: D1Database, workoutId: string, chunk: RoutePoint[]): D1PreparedStatement {
  const values = chunk.map(() => "(?,?,?,?,?,?)").join(",");
  const binds: (string | number | null)[] = [];
  for (const p of chunk) {
    binds.push(workoutId, p.seq, p.ts, p.lat, p.lon, p.elevation_m);
  }
  return db
    .prepare(
      `INSERT INTO route_points (workout_id, seq, ts, lat, lon, elevation_m) VALUES ${values}`,
    )
    .bind(...binds);
}

async function selectIdsBySource(
  db: D1Database,
  userId: string,
  sourceIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (sourceIds.length === 0) return map;
  const placeholders = sourceIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT id, source_id FROM workouts WHERE user_id = ? AND source_id IN (${placeholders})`,
    )
    .bind(userId, ...sourceIds)
    .all<{ id: string; source_id: string }>();
  for (const r of rows.results ?? []) map.set(r.source_id, r.id);
  return map;
}

function lapInsert(db: D1Database, workoutId: string, lap: Lap): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO laps (
         workout_id, lap_num, start_time, active_sec, rest_after_sec, distance_m,
         strokes, pace_per_50m, pace_per_km, swolf, avg_hr, max_hr, stroke_type, reconstructed
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      workoutId,
      lap.lap_num,
      lap.start_time,
      lap.active_sec,
      lap.rest_after_sec,
      lap.distance_m,
      lap.strokes,
      lap.pace_per_50m,
      lap.pace_per_km,
      lap.swolf,
      lap.avg_hr,
      lap.max_hr,
      lap.stroke_type,
      lap.reconstructed,
    );
}

/** source_ids among the given set that are tombstoned (see migrations/0013_deleted_workouts.sql). */
async function selectDeletedSourceIds(
  db: D1Database,
  userId: string,
  sourceIds: string[],
): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();
  const placeholders = sourceIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT source_id FROM deleted_workouts WHERE user_id = ? AND source_id IN (${placeholders})`,
    )
    .bind(userId, ...sourceIds)
    .all<{ source_id: string }>();
  return new Set((rows.results ?? []).map((r) => r.source_id));
}

export interface DeleteResult {
  ok: boolean;
  source_id: string;
}

/**
 * Delete one workout: removes its `workouts` row (children cascade — see
 * migrations/0013_deleted_workouts.sql for the FK list), removes its raw R2
 * objects, and records a tombstone so a future re-ingest of the same
 * source_id (the athlete's own automation re-sending an export, a Wahoo
 * backfill) is silently skipped rather than resurrecting it.
 */
export async function deleteWorkout(
  env: StoreEnv,
  userId: string,
  sourceId: string,
  reason: string | null,
): Promise<DeleteResult | null> {
  const workout = await env.DB.prepare(
    "SELECT id, sport, sub_type, start_time, raw_r2_key FROM workouts WHERE user_id = ? AND source_id = ?",
  )
    .bind(userId, sourceId)
    .first<{ id: string; sport: string; sub_type: string | null; start_time: number; raw_r2_key: string }>();
  if (!workout) return null;

  // Uses the stored raw_r2_key rather than rawKey(sourceId) — that helper only
  // covers the HAE layout (raw/{source_id}.json); Wahoo rides are archived at
  // raw/wahoo/{userId}/{workoutId}.fit (see index.ts's handleWahooWebhook).
  // Both layouts pair their raw file with a sibling *.meta.json, so swapping
  // the extension derives it generically either way.
  const metaR2Key = workout.raw_r2_key.replace(/\.[^./]+$/, ".meta.json");
  await env.RAW.delete([workout.raw_r2_key, metaR2Key]);

  const deletedAt = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM workouts WHERE id = ?").bind(workout.id),
    env.DB
      .prepare(
        `INSERT INTO deleted_workouts (source_id, user_id, sport, sub_type, start_time, reason, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, source_id) DO UPDATE SET
           reason     = excluded.reason,
           deleted_at = excluded.deleted_at`,
      )
      .bind(sourceId, userId, workout.sport, workout.sub_type, workout.start_time, reason, deletedAt),
  ]);

  return { ok: true, source_id: sourceId };
}

async function selectExistingSourceIds(
  db: D1Database,
  userId: string,
  sourceIds: string[],
): Promise<string[]> {
  if (sourceIds.length === 0) return [];
  const placeholders = sourceIds.map(() => "?").join(",");
  const rows = await db
    .prepare(
      `SELECT source_id FROM workouts WHERE user_id = ? AND source_id IN (${placeholders})`,
    )
    .bind(userId, ...sourceIds)
    .all<{ source_id: string }>();
  return (rows.results ?? []).map((r) => r.source_id);
}

/** Shared by the HAE path (below) and the Wahoo FIT path (see storeFitWorkout). */
export function upsertWorkoutStatement(
  db: D1Database,
  userId: string,
  s: WorkoutSummary,
  rawR2Key: string,
  parserVersion: string,
  ingestedAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO workouts (
         id, user_id, source_id, start_time, end_time, tz_offset, sport, sub_type,
         is_indoor, duration_sec, moving_sec, distance_m, pool_length_m, avg_hr, max_hr,
         total_strokes, active_energy, temperature_c, humidity_pct,
         avg_power_w, max_power_w, normalized_power_w, intensity_factor,
         training_stress_score, threshold_power_w, work_kj, avg_cadence_rpm,
         max_cadence_rpm, elevation_gain_m, power_zone_secs_json,
         raw_r2_key, parser_version, ingested_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, source_id) DO UPDATE SET
         start_time             = excluded.start_time,
         end_time               = excluded.end_time,
         tz_offset               = excluded.tz_offset,
         sport                  = excluded.sport,
         sub_type               = excluded.sub_type,
         is_indoor              = excluded.is_indoor,
         duration_sec           = excluded.duration_sec,
         moving_sec             = excluded.moving_sec,
         distance_m             = excluded.distance_m,
         pool_length_m          = excluded.pool_length_m,
         avg_hr                 = excluded.avg_hr,
         max_hr                 = excluded.max_hr,
         total_strokes          = excluded.total_strokes,
         active_energy          = excluded.active_energy,
         temperature_c          = excluded.temperature_c,
         humidity_pct           = excluded.humidity_pct,
         avg_power_w            = excluded.avg_power_w,
         max_power_w            = excluded.max_power_w,
         normalized_power_w     = excluded.normalized_power_w,
         intensity_factor       = excluded.intensity_factor,
         training_stress_score  = excluded.training_stress_score,
         threshold_power_w      = excluded.threshold_power_w,
         work_kj                = excluded.work_kj,
         avg_cadence_rpm        = excluded.avg_cadence_rpm,
         max_cadence_rpm        = excluded.max_cadence_rpm,
         elevation_gain_m       = excluded.elevation_gain_m,
         power_zone_secs_json   = excluded.power_zone_secs_json,
         raw_r2_key             = excluded.raw_r2_key,
         parser_version         = excluded.parser_version,
         ingested_at            = excluded.ingested_at`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      s.source_id,
      s.start_time,
      s.end_time,
      s.tz_offset,
      s.sport,
      s.sub_type,
      s.is_indoor,
      s.duration_sec,
      s.moving_sec,
      s.distance_m,
      s.pool_length_m,
      s.avg_hr,
      s.max_hr,
      s.total_strokes,
      s.active_energy,
      s.temperature_c,
      s.humidity_pct,
      s.avg_power_w,
      s.max_power_w,
      s.normalized_power_w,
      s.intensity_factor,
      s.training_stress_score,
      s.threshold_power_w,
      s.work_kj,
      s.avg_cadence_rpm,
      s.max_cadence_rpm,
      s.elevation_gain_m,
      s.power_zone_secs_json,
      rawR2Key,
      parserVersion,
      ingestedAt,
    );
}

/**
 * Store one Wahoo-derived workout (summary + native FIT laps). Mirrors
 * storeWorkouts' upsert-then-resolve-id-then-write-laps shape, but takes an
 * already-parsed summary/laps (see fit.ts) instead of a raw HAE payload, and
 * always writes exactly one workout rather than batching HAE's array.
 */
export async function storeFitWorkout(
  env: StoreEnv,
  userId: string,
  summary: WorkoutSummary,
  laps: Lap[],
  route: RoutePoint[],
  samples: PowerCadenceSample[],
  rawR2Key: string,
  parserVersion: string,
): Promise<{
  workoutId: string;
  inserted: boolean;
  skippedDeleted: boolean;
  lapsWritten: number;
  routeWritten: number;
  samplesWritten: number;
  supersededHaeWorkoutIds: string[];
} | null> {
  // Tombstoned — see migrations/0013_deleted_workouts.sql and the matching
  // check in storeWorkouts. Wahoo re-delivers webhooks and backfills replay
  // old workouts, so this must be checked on every call, not just first insert.
  const deleted = await selectDeletedSourceIds(env.DB, userId, [summary.source_id]);
  if (deleted.has(summary.source_id)) return null;

  const ingestedAt = Math.floor(Date.now() / 1000);
  const existing = await selectExistingSourceIds(env.DB, userId, [summary.source_id]);

  await env.DB.batch([upsertWorkoutStatement(env.DB, userId, summary, rawR2Key, parserVersion, ingestedAt)]);

  const idMap = await selectIdsBySource(env.DB, userId, [summary.source_id]);
  const workoutId = idMap.get(summary.source_id);
  if (!workoutId) throw new Error(`upsert succeeded but workout ${summary.source_id} not found afterward`);

  const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM laps WHERE workout_id = ?").bind(workoutId)];
  for (const lap of laps) stmts.push(lapInsert(env.DB, workoutId, lap));
  await env.DB.batch(stmts);

  const routeWritten = await writeRoute(env.DB, workoutId, route);

  const samplesWritten = await writeCyclingSamples(
    env.DB,
    workoutId,
    "wahoo",
    samples.map((s) => ({ t: s.t, power_w: s.power_w, cadence_rpm: s.cadence_rpm, hr: null })),
  );

  const supersededHaeWorkoutIds = await supersedeOverlappingHaeRows(
    env,
    userId,
    workoutId,
    summary.sport,
    summary.start_time,
    summary.end_time,
  );

  return {
    workoutId,
    inserted: existing.length === 0,
    skippedDeleted: false,
    lapsWritten: laps.length,
    routeWritten,
    samplesWritten,
    supersededHaeWorkoutIds,
  };
}
