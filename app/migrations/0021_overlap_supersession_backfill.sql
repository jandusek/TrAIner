-- Backfill for the widened supersession rule (see store.ts OVERLAP_MIN_FRACTION).
--
-- 0009 matched an HAE row to a Wahoo ride by start-time proximity (±300s of the
-- ride's start). That only ever caught a Watch recording that began alongside the
-- ride, and structurally missed the case where ONE Wahoo ride spans SEVERAL Watch
-- workouts: leave the head unit running through a stop (a commute out and back)
-- and the Watch records a workout per leg while the Wahoo records one ride across
-- the lot. Leg 2 starts an hour into the Wahoo ride, so no tolerance value reaches
-- it — it stayed unsuperseded and double-counted its distance in the list view.
--
-- Ingest now matches on interval overlap instead (two cycling recordings that
-- overlap in time are the same ride — you can't ride two bikes at once). This
-- applies that same rule to rows already stored. Confirmed 2026-07-15: an 8.5km
-- Wahoo ride, 13:06-14:20, spanning Watch legs at 13:10-13:29 (superseded under
-- the old rule) and 14:05-14:24 (missed by it, fixed here).

-- 1. Supersede every HAE row that substantially overlaps a Wahoo ride, choosing
--    the best-overlapping ride when more than one is in reach (back-to-back rides
--    with the head unit stopped between legs).
--
--    ABS(start_time diff) > 3 skips the Wahoo/ELEMNT app's own HealthKit
--    write-back, which ingest DROPS rather than supersedes (see store.ts's
--    EXACT_START_TOLERANCE_SEC). Dropping means deleting R2 objects and writing a
--    tombstone, which SQL alone can't do — and any such row is already handled,
--    since that carve-out predates this migration and runs on every ingest.
WITH overlap AS (
  SELECT hae.id AS hae_id,
         wahoo.id AS wahoo_id,
         ROW_NUMBER() OVER (
           PARTITION BY hae.id
           ORDER BY MIN(wahoo.end_time, hae.end_time) - MAX(wahoo.start_time, hae.start_time) DESC
         ) AS rank
    FROM workouts hae
    JOIN workouts wahoo
      ON wahoo.user_id = hae.user_id
     AND wahoo.sport = hae.sport
     AND wahoo.source_id LIKE 'wahoo:%'
     AND wahoo.end_time > hae.start_time
     AND wahoo.start_time < hae.end_time
     AND ABS(wahoo.start_time - hae.start_time) > 3
     AND (MIN(wahoo.end_time, hae.end_time) - MAX(wahoo.start_time, hae.start_time))
           >= (hae.end_time - hae.start_time) * 0.5
   WHERE hae.source_id NOT LIKE 'wahoo:%'
     AND hae.superseded_by IS NULL
     AND hae.end_time > hae.start_time
)
UPDATE workouts
   SET superseded_by = (SELECT wahoo_id FROM overlap WHERE overlap.hae_id = workouts.id AND overlap.rank = 1)
 WHERE id IN (SELECT hae_id FROM overlap WHERE rank = 1);

-- 2. Re-key the newly-superseded rows' HR samples onto their canonical Wahoo row,
--    so power/cadence and HR share one workout_id (mirrors store.ts's
--    migrateCyclingSamples). Idempotent: rows already migrated by a previous
--    ingest leave nothing behind to move.
INSERT INTO cycling_samples (workout_id, t, source, power_w, cadence_rpm, hr)
SELECT hae.superseded_by, cs.t, cs.source, cs.power_w, cs.cadence_rpm, cs.hr
  FROM cycling_samples cs
  JOIN workouts hae ON hae.id = cs.workout_id
 WHERE hae.superseded_by IS NOT NULL
ON CONFLICT(workout_id, t, source) DO UPDATE SET
  power_w     = excluded.power_w,
  cadence_rpm = excluded.cadence_rpm,
  hr          = excluded.hr;

DELETE FROM cycling_samples
 WHERE workout_id IN (SELECT id FROM workouts WHERE superseded_by IS NOT NULL);

-- 3. Derive each Wahoo ride's avg/max HR from the Watch samples now sitting on it.
--
--    The read path used to borrow HR straight off the echo's summary row
--    (COALESCE(w.avg_hr, echo.avg_hr) in index.ts). With one echo per ride that
--    was exact; with several it has to pick one, and a single leg's average is not
--    the ride's. The migrated per-second samples span every leg, so they give the
--    real figure. Only fills a NULL avg_hr — a Wahoo row with its own HR had a
--    chest strap paired, which beats the Watch's wrist optical read.
UPDATE workouts
   SET avg_hr = COALESCE(avg_hr, (SELECT AVG(hr) FROM cycling_samples
                                   WHERE workout_id = workouts.id AND source = 'watch' AND hr IS NOT NULL)),
       max_hr = COALESCE(max_hr, (SELECT MAX(hr) FROM cycling_samples
                                   WHERE workout_id = workouts.id AND source = 'watch' AND hr IS NOT NULL))
 WHERE source_id LIKE 'wahoo:%'
   AND superseded_by IS NULL;
