/**
 * Read-only data access for the MCP tools. Every query is scoped to a single
 * user (resolved from the Access OIDC email), mirroring the multi-user model of
 * the ingest/UI worker — the MCP server reads the same D1 database.
 */

export interface UserRow {
  id: string;
  email: string;
}

export async function getUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<UserRow>();
}

/** Freeform athlete bio — age, VO2max/HR zones, active sports, equipment,
 * etc. Athlete-authored via the Settings UI; read-only from here. */
export async function getAthleteProfile(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT profile_md FROM athlete_profile WHERE user_id = ?")
    .bind(userId)
    .first<{ profile_md: string }>();
  return row?.profile_md ?? null;
}

export interface WorkoutSummaryRow {
  source_id: string;
  sport: string;
  sub_type: string | null;
  start_time: number;
  end_time: number;
  tz_offset: string | null;
  is_indoor: number | null;
  duration_sec: number | null;
  /**
   * Moving time (FIT totalTimerTime) — excludes auto-paused stretches, unlike
   * duration_sec's wall clock. Wahoo rides only; NULL elsewhere. Use
   * COALESCE(moving_sec, duration_sec) as any pace/speed denominator.
   * See app/migrations/0023_moving_time.sql.
   */
  moving_sec: number | null;
  distance_m: number | null;
  pool_length_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  total_strokes: number | null;
  active_energy: number | null;
  // Cycling power (Wahoo-only — null unless a power meter recorded the ride).
  avg_power_w: number | null;
  max_power_w: number | null;
  normalized_power_w: number | null;
  intensity_factor: number | null;
  training_stress_score: number | null;
  avg_cadence_rpm: number | null;
  elevation_gain_m: number | null;
}

// A Wahoo cycling row carries no HR (no chest strap paired — power/cadence
// come from Wahoo instead) but a same-ride Apple Watch echo usually does; that
// echo is hidden by supersession (see the ingest worker's
// migrations/0009_supersession.sql), so HR is merged in here rather than lost.
// Mirrors the same COALESCE done in the UI worker's /api/workout and
// /api/workouts (src/index.ts there).
//
// The echo side is aggregated to one row per canonical id, NOT plain-joined: a
// Wahoo ride can have SEVERAL superseded echoes, since leaving the head unit
// running through a stop makes the Watch record a workout per leg while the
// Wahoo records one ride (see the ingest worker's OVERLAP_MIN_FRACTION and
// ECHO_AGGREGATE_SQL). A plain `echo.superseded_by = w.id` fans out into one
// result row per echo — it returned the 2026-07-15 ride twice and pushed a real
// workout off the end of the LIMIT.
//
// avg_hr here is a fallback that only applies to rows the ingest worker hasn't
// derived HR onto yet; it wins the COALESCE from w.avg_hr, which is computed
// from the merged per-second samples across every leg.
const WORKOUT_COLS = `w.source_id, w.sport, w.sub_type, w.start_time, w.end_time, w.tz_offset, w.is_indoor,
                w.duration_sec, w.moving_sec, w.distance_m, w.pool_length_m,
                COALESCE(w.avg_hr, echo.avg_hr) AS avg_hr,
                COALESCE(w.max_hr, echo.max_hr) AS max_hr,
                w.total_strokes, w.active_energy,
                w.avg_power_w, w.max_power_w, w.normalized_power_w, w.intensity_factor,
                w.training_stress_score, w.avg_cadence_rpm, w.elevation_gain_m`;
const WORKOUT_JOIN = `FROM workouts w
                LEFT JOIN (
                  SELECT superseded_by AS canonical_id, AVG(avg_hr) AS avg_hr, MAX(max_hr) AS max_hr
                    FROM workouts WHERE superseded_by IS NOT NULL GROUP BY superseded_by
                ) echo ON echo.canonical_id = w.id`;

export async function getRecentWorkouts(
  db: D1Database,
  userId: string,
  sport: string | undefined,
  limit: number,
): Promise<WorkoutSummaryRow[]> {
  const q = sport
    ? db
        .prepare(
          `SELECT ${WORKOUT_COLS} ${WORKOUT_JOIN} WHERE w.user_id = ? AND w.sport = ? AND w.superseded_by IS NULL ORDER BY w.start_time DESC LIMIT ?`,
        )
        .bind(userId, sport, limit)
    : db
        .prepare(
          `SELECT ${WORKOUT_COLS} ${WORKOUT_JOIN} WHERE w.user_id = ? AND w.superseded_by IS NULL ORDER BY w.start_time DESC LIMIT ?`,
        )
        .bind(userId, limit);
  const rows = await q.all<WorkoutSummaryRow>();
  return rows.results ?? [];
}

export interface LapRow {
  lap_num: number;
  active_sec: number;
  rest_after_sec: number | null;
  distance_m: number | null;
  strokes: number | null;
  pace_per_50m: number | null;
  swolf: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  equipment?: string[];
}

export interface CalisthenicsSetRow {
  set_num: number;
  reps: number;
  rir: number | null; // null = AMRAP (to failure)
  is_amrap: boolean;
  rest_before_sec: number | null;
}

export interface WorkoutDetail {
  workout: (WorkoutSummaryRow & { id: string }) | null;
  laps: LapRow[];
  sets: CalisthenicsSetRow[];
  note: { content_html: string | null; updated_at: number } | null;
}

export async function getWorkoutDetail(
  db: D1Database,
  userId: string,
  sourceId: string,
): Promise<WorkoutDetail> {
  const workout = await db
    .prepare(`SELECT w.id, ${WORKOUT_COLS} ${WORKOUT_JOIN} WHERE w.user_id = ? AND w.source_id = ?`)
    .bind(userId, sourceId)
    .first<WorkoutSummaryRow & { id: string }>();
  if (!workout) return { workout: null, laps: [], sets: [], note: null };

  const sets =
    workout.sport === "calisthenics"
      ? (
          await db
            .prepare(
              `SELECT set_num, reps, rir, is_amrap, rest_before_sec FROM calisthenics_sets
                WHERE workout_id = ? ORDER BY set_num`,
            )
            .bind(workout.id)
            .all<{ set_num: number; reps: number; rir: number | null; is_amrap: number; rest_before_sec: number | null }>()
        ).results ?? []
      : [];

  const laps = await db
    .prepare(
      `SELECT lap_num, active_sec, rest_after_sec, distance_m, strokes, pace_per_50m, swolf, avg_hr, max_hr
         FROM laps WHERE workout_id = ? ORDER BY lap_num`,
    )
    .bind(workout.id)
    .all<LapRow>();
  const equip = await db
    .prepare("SELECT lap_num, equipment FROM lap_equipment WHERE workout_id = ?")
    .bind(workout.id)
    .all<{ lap_num: number; equipment: string }>();
  const byLap = new Map<number, string[]>();
  for (const e of equip.results ?? []) {
    const arr = byLap.get(e.lap_num) ?? [];
    arr.push(e.equipment);
    byLap.set(e.lap_num, arr);
  }
  const laprows = (laps.results ?? []).map((l) => ({ ...l, equipment: byLap.get(l.lap_num) ?? [] }));

  const note = await db
    .prepare("SELECT content_html, updated_at FROM notes WHERE workout_id = ?")
    .bind(workout.id)
    .first<{ content_html: string | null; updated_at: number }>();

  const setsOut: CalisthenicsSetRow[] = sets.map((s) => ({ ...s, is_amrap: Boolean(s.is_amrap) }));

  return { workout, laps: laprows, sets: setsOut, note: note ?? null };
}

/** Resolve a user's workout UUID from its source_id. Scopes every write below. */
export async function resolveWorkoutId(
  db: D1Database,
  userId: string,
  sourceId: string,
): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM workouts WHERE user_id = ? AND source_id = ?")
    .bind(userId, sourceId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export interface SessionEval {
  content_md: string;
  created_at: number;
  updated_at: number;
}

export async function getSessionEval(
  db: D1Database,
  workoutId: string,
): Promise<SessionEval | null> {
  return db
    .prepare("SELECT content_md, created_at, updated_at FROM session_evals WHERE workout_id = ?")
    .bind(workoutId)
    .first<SessionEval>();
}

/** Upsert Claude's evaluation of a workout (latest chat wins). */
export async function setSessionEval(
  db: D1Database,
  userId: string,
  workoutId: string,
  contentMd: string,
): Promise<{ updated_at: number }> {
  const now = Math.floor(Date.now() / 1000);
  // generated_by = 'claude': this path is only reached from the MCP tool, i.e.
  // Claude-in-chat. The in-app button writes the Workers AI model id instead
  // (app/src/evaluate.ts); the UI byline names the author from this column.
  await db
    .prepare(
      `INSERT INTO session_evals (workout_id, user_id, content_md, generated_by, created_at, updated_at)
       VALUES (?, ?, ?, 'claude', ?, ?)
       ON CONFLICT(workout_id) DO UPDATE SET
         content_md   = excluded.content_md,
         generated_by = excluded.generated_by,
         updated_at   = excluded.updated_at`,
    )
    .bind(workoutId, userId, contentMd, now, now)
    .run();
  return { updated_at: now };
}

export interface FocusRow {
  items: string[];
  set_by_source_id: string | null;
  created_at: number;
}

/** The live focus for a sport: the un-superseded row, newest first. */
export async function getCurrentFocus(
  db: D1Database,
  userId: string,
  sport: string,
): Promise<FocusRow | null> {
  const row = await db
    .prepare(
      `SELECT f.items_json, f.created_at, w.source_id AS set_by_source_id
         FROM session_focus f
         LEFT JOIN workouts w ON f.set_by_workout_id = w.id
        WHERE f.user_id = ? AND f.sport = ? AND f.superseded_at IS NULL
        ORDER BY f.created_at DESC LIMIT 1`,
    )
    .bind(userId, sport)
    .first<{ items_json: string; created_at: number; set_by_source_id: string | null }>();
  if (!row) return null;
  return { items: safeItems(row.items_json), set_by_source_id: row.set_by_source_id, created_at: row.created_at };
}

function safeItems(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Set the next-session focus for a sport. Supersedes the prior current row(s)
 * and inserts a new one, so there's only ever one live focus per (user, sport)
 * and a full history behind it. `setByWorkoutId` ties it to the session that
 * prompted it (nullable).
 */
export async function setNextFocus(
  db: D1Database,
  userId: string,
  sport: string,
  items: string[],
  setByWorkoutId: string | null,
): Promise<{ created_at: number }> {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .prepare(
        `UPDATE session_focus SET superseded_at = ?
          WHERE user_id = ? AND sport = ? AND superseded_at IS NULL`,
      )
      .bind(now, userId, sport),
    db
      .prepare(
        `INSERT INTO session_focus (id, user_id, sport, items_json, set_by_workout_id, created_at, superseded_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(crypto.randomUUID(), userId, sport, JSON.stringify(items), setByWorkoutId, now),
  ]);
  return { created_at: now };
}

export interface PersonalBests {
  sport: string;
  workouts_counted: number;
  bests: Record<string, unknown>;
}

export async function listPersonalBests(
  db: D1Database,
  userId: string,
  sport: string,
): Promise<PersonalBests> {
  const count = await db
    .prepare("SELECT count(*) AS n FROM workouts WHERE user_id = ? AND sport = ?")
    .bind(userId, sport)
    .first<{ n: number }>();
  const bests: Record<string, unknown> = {};

  // Distance + duration bests apply to every sport.
  const longest = await db
    .prepare(
      `SELECT source_id, start_time, distance_m, duration_sec FROM workouts
        WHERE user_id = ? AND sport = ? AND distance_m IS NOT NULL ORDER BY distance_m DESC LIMIT 1`,
    )
    .bind(userId, sport)
    .first();
  if (longest) bests.longest_distance = longest;

  if (sport === "swimming") {
    // Fastest full-length 50 m (exclude lap 1 — the known short/fast artifact).
    const fastest = await db
      .prepare(
        `SELECT l.pace_per_50m, l.swolf, w.source_id, w.start_time
           FROM laps l JOIN workouts w ON l.workout_id = w.id
          WHERE w.user_id = ? AND w.sport = 'swimming' AND l.lap_num > 1
            AND l.distance_m >= 45 AND l.pace_per_50m IS NOT NULL
          ORDER BY l.pace_per_50m ASC LIMIT 1`,
      )
      .bind(userId)
      .first();
    if (fastest) bests.fastest_50m = fastest;
  } else {
    // Fastest average speed (m/s) for distance sports.
    //
    // Denominator is moving time where the device reports it. Dividing by
    // duration_sec's wall clock counts time spent stopped at lights (or waiting
    // out rain) as time spent riding, which doesn't just add noise — it
    // disqualifies exactly the rides most likely to be a personal best, since a
    // long ride has more opportunity to stop. The 2026-07-15 ride scored 9.7 km/h
    // that way against a real moving average of 21.6 km/h.
    //
    // ⚠ This ranking can MIX CLOCKS, and `speed_basis` exists so a reader sees it
    // rather than trusting a bogus winner. Only FIT/Wahoo rows carry moving_sec.
    // HAE rows fall back to duration_sec, and — contrary to what Apple's
    // HKWorkout.duration docs imply — that is NOT paused-time-excluded in practice:
    // on 6 of 8 HAE cycling rides here duration_sec equals end_time - start_time
    // exactly, i.e. the athlete never hit pause and it is plain wall clock. So an
    // HAE row's speed is understated by however long it sat at lights, while a
    // Wahoo row's is honest, and the Wahoo row wins on measurement rather than
    // merit. Deriving moving time for HAE rows from their GPS was tried and
    // rejected: validated against the four Wahoo rides (which have both GPS and a
    // true totalTimerTime), a speed-threshold reconstruction undershot by 2.4-17%
    // with the error varying too much per-ride for any threshold to calibrate —
    // ~3s point spacing loses too much to dropouts. Absent a real fix, surface the
    // basis and let the caller discount cross-basis comparisons.
    const fastest = await db
      .prepare(
        `SELECT source_id, start_time, distance_m, duration_sec, moving_sec,
                (distance_m / COALESCE(moving_sec, duration_sec)) AS avg_mps,
                CASE WHEN moving_sec IS NOT NULL THEN 'moving' ELSE 'elapsed' END AS speed_basis
           FROM workouts
          WHERE user_id = ? AND sport = ? AND distance_m IS NOT NULL
            AND COALESCE(moving_sec, duration_sec) > 0
          ORDER BY avg_mps DESC LIMIT 1`,
      )
      .bind(userId, sport)
      .first();
    if (fastest) {
      bests.fastest_avg_speed = fastest;
      // Name the hazard at the point of use: a 'moving' winner is only a real PB
      // if it beats the elapsed-basis rides by more than their stopped time.
      if (fastest.speed_basis === "moving") {
        const rival = await db
          .prepare(
            `SELECT COUNT(*) AS n FROM workouts
              WHERE user_id = ? AND sport = ? AND distance_m IS NOT NULL
                AND moving_sec IS NULL AND duration_sec > 0`,
          )
          .bind(userId, sport)
          .first<{ n: number }>();
        if (rival && rival.n > 0) {
          bests.fastest_avg_speed_caveat =
            `Ranked against ${rival.n} older ride(s) whose speed is computed over elapsed time ` +
            `(no moving_sec — GPS-only, device never paused), so those are understated by however ` +
            `long they sat stopped. This winner may be an artifact of measurement, not fitness.`;
        }
      }
    }
  }

  return { sport, workouts_counted: count?.n ?? 0, bests };
}
