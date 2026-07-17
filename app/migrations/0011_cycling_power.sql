-- Cycling power/cadence metrics and time-series samples, sourced from the
-- Wahoo FIT session (see src/fit.ts). NULL for non-cycling workouts and for
-- any cycling row with no paired power meter (there is currently no HR strap
-- either — see 0002_workouts.sql's avg_hr/max_hr, which stay the HR source).
--
-- Zone-time fields are seconds-in-zone arrays as JSON (FIT's timeInPowerZone
-- is a fixed-length array of 7 buckets: zone 0 = below zone 1, then zones 1-6
-- depending on the athlete's configured zone count). Stored as JSON rather
-- than unpacked columns since the zone count/boundaries are a device setting
-- that could change, and the UI only needs to iterate them, never filter by a
-- specific zone in SQL.
ALTER TABLE workouts ADD COLUMN avg_power_w INTEGER;
ALTER TABLE workouts ADD COLUMN max_power_w INTEGER;
ALTER TABLE workouts ADD COLUMN normalized_power_w INTEGER;
ALTER TABLE workouts ADD COLUMN intensity_factor REAL;
ALTER TABLE workouts ADD COLUMN training_stress_score REAL;
ALTER TABLE workouts ADD COLUMN threshold_power_w INTEGER;   -- FTP configured on the head unit at ride time
ALTER TABLE workouts ADD COLUMN work_kj REAL;
ALTER TABLE workouts ADD COLUMN avg_cadence_rpm INTEGER;
ALTER TABLE workouts ADD COLUMN max_cadence_rpm INTEGER;
ALTER TABLE workouts ADD COLUMN elevation_gain_m REAL;
ALTER TABLE workouts ADD COLUMN power_zone_secs_json TEXT;    -- seconds per zone bucket, index = zone number

-- Per-second power/cadence/HR, for the power+HR-zone overlay chart and
-- aerobic-decoupling calculations. Power/cadence come from the Wahoo FIT
-- `recordMesgs` (1 Hz when a meter is paired); HR comes from the Apple Watch
-- echo's `heartRateData` (see src/parse.ts) since the Wahoo has no chest
-- strap paired — same cross-source merge reasoning as supersession
-- (0009_supersession.sql), except here the two sources' *columns* combine
-- into one row instead of one row winning outright.
--
-- Sparse by construction: HR samples land roughly every 5s (Watch optical
-- sensor cadence) while power/cadence are ~1 Hz, so most rows have hr NULL.
-- One row per second where at least one metric was recorded, not a dense
-- one-row-per-second grid — the chart layer forward-fills gaps as needed.
--
-- Derived data, same contract as `laps`/`route_points`: ingest deletes and
-- rewrites, so a parser change just needs a re-ingest from the R2 archive.
CREATE TABLE cycling_samples (
  workout_id   TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  t            INTEGER NOT NULL,      -- unix epoch seconds, UTC
  power_w      INTEGER,
  cadence_rpm  INTEGER,
  hr           INTEGER,
  PRIMARY KEY (workout_id, t)
);
