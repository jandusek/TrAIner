/**
 * SQL fragments shared across route handlers.
 *
 * The superseded Apple Watch echo(es) behind each canonical workout, rolled up
 * to one row per canonical id — join it as `ON echo.canonical_id = w.id`.
 *
 * A Wahoo ride can have SEVERAL superseded echoes: leave the head unit running
 * through a stop and the Watch records a workout per leg while the Wahoo records
 * one ride (see store.ts's OVERLAP_MIN_FRACTION). Aggregating keeps this a 1:1
 * join — a plain `echo.superseded_by = w.id` would fan out into one list row per
 * echo — and, unlike picking a single echo, describes the whole ride: energy
 * sums across the legs and max_hr is the max over them.
 *
 * avg_hr here is an unweighted mean of the legs' own averages, which is only
 * approximate when legs differ in length. It's a fallback: supersession derives
 * a Wahoo row's real avg_hr from the migrated per-second samples, which span
 * every leg (see backfillWahooHrFromSamples), and w.avg_hr wins the COALESCE.
 */
export const ECHO_AGGREGATE_SQL = `
  SELECT superseded_by AS canonical_id,
         AVG(avg_hr)         AS avg_hr,
         MAX(max_hr)         AS max_hr,
         SUM(active_energy)  AS active_energy,
         MAX(distance_m)     AS distance_m,
         MAX(temperature_c)  AS temperature_c
    FROM workouts
   WHERE superseded_by IS NOT NULL
   GROUP BY superseded_by
`;
