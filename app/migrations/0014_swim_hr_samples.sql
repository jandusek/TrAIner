-- Per-second HR for swims, so the detail page can show the same
-- heart-rate-zones chart cycling already gets (see detail.client.js's
-- HeartZones — it's sport-agnostic, keyed on { t, hr } samples).
--
-- The source data already exists: laps.ts reads w.heartRateData off the raw
-- HAE workout to compute each lap's avg_hr/max_hr, but only keeps the
-- per-lap aggregate. This table keeps the raw ~5s-cadence stream too, mirroring
-- cycling_samples but without power_w/cadence_rpm (swims have no power meter
-- and no second source to merge — no 'source' column needed).
--
-- Kept as its own table rather than reusing cycling_samples: that table's
-- name and (workout_id, t, source) key exist specifically for the Wahoo/Watch
-- merge (see 0012_cycling_samples_by_source.sql), which doesn't apply here.
--
-- Derived data, same contract as `laps`: safe to delete + rebuild from R2 on
-- re-ingest.
CREATE TABLE swim_hr_samples (
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  t          INTEGER NOT NULL,
  hr         INTEGER NOT NULL,
  PRIMARY KEY (workout_id, t)
);
