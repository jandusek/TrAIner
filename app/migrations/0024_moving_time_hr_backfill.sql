-- Recompute every Wahoo ride's avg_hr over moving time only.
--
-- Fixes the derivation introduced by 0021's step 3, which this supersedes. That
-- step averaged every Watch HR sample sitting on a Wahoo row. The Wahoo
-- auto-pauses and the Watch does not, so the Watch keeps logging a rider who is
-- standing at a red light or waiting out rain, and folding those beats into the
-- average reports a heart rate the athlete never rode at. The error scales with
-- how long the ride sat stopped, so it hits precisely the long rides whose
-- aerobic numbers matter most:
--
--   wahoo:476320810   30 km, 1h24 riding inside a 3h09 wall clock (rain wait)
--                     avg_hr 108.5 → 119.5 — an 11 bpm error, a whole HR zone
--
-- "Moving" is defined by intersecting with the head unit's own samples: it writes
-- no record while paused, so a Wahoo sample near a given second IS the signal that
-- the rider was riding. WAHOO_CLOCK_SKEW_SEC (±5s, mirroring store.ts) absorbs the
-- two devices' clock disagreement (0012_cycling_samples_by_source.sql). The exact
-- tolerance barely matters — paused blocks last minutes, so only samples at each
-- boundary are ambiguous, and sweeping ±1s→±20s moves the ride above by 119.7→118.5.
--
-- max_hr is deliberately left alone, over all samples. An average needs a
-- consistent denominator; a peak does not. HR lags effort by 10-20s, so a hard
-- effort's true maximum often lands just after the rider stops pedaling.
--
-- Two guards, both load-bearing:
--
--  * The outer COALESCE(..., avg_hr) means a ride whose Watch samples somehow fail
--    to intersect the Wahoo's keeps its old value instead of being blanked.
--  * The WHERE only touches rows whose avg_hr still exactly equals the
--    unrestricted Watch average — i.e. rows 0021 derived. A Wahoo row carrying its
--    own HR had a chest strap paired, which beats the wrist optical read and must
--    never be clobbered; testing the value rather than the mere presence of Watch
--    samples matters because a strap ride can have a Watch echo too, and the
--    likelihood of a strap average landing within 1e-6 of the Watch's is nil.
--    This also makes the migration idempotent: once rewritten to the moving-time
--    figure, a row no longer matches and a re-run is a no-op.
--
-- Companion to 0023_moving_time.sql, which adds moving_sec. That column is
-- populated from FIT totalTimerTime by src/fit.ts on ingest, and cannot be
-- derived in SQL — rows ingested before 0023 were backfilled out-of-band by
-- re-reading their archived FIT from R2 (deliberately not scripted here: the
-- statements would have to name individual rides, and per-athlete data stays out
-- of version control per CLAUDE.md). Sample counts are NOT a usable proxy for
-- timer time: a 21s power-meter dropout left wahoo:476193484 with 1745 samples
-- against a true 1766s.
UPDATE workouts
   SET avg_hr = COALESCE(
     (SELECT AVG(w.hr)
        FROM cycling_samples w
       WHERE w.workout_id = workouts.id
         AND w.source = 'watch'
         AND w.hr IS NOT NULL
         AND EXISTS (SELECT 1
                       FROM cycling_samples p
                      WHERE p.workout_id = workouts.id
                        AND p.source = 'wahoo'
                        AND p.t BETWEEN w.t - 5 AND w.t + 5)),
     avg_hr
   )
 WHERE source_id LIKE 'wahoo:%'
   AND superseded_by IS NULL
   AND avg_hr IS NOT NULL
   -- Fingerprint of a value 0021 derived: still exactly the unrestricted Watch
   -- average. Anything else is a chest-strap reading (or already fixed) — leave it.
   AND ABS(avg_hr - (SELECT AVG(hr) FROM cycling_samples
                      WHERE workout_id = workouts.id AND source = 'watch' AND hr IS NOT NULL)) < 1e-6;
