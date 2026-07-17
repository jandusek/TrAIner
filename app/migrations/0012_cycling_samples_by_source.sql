-- Stop trying to merge Wahoo (power/cadence) and Apple Watch (HR) samples
-- into a shared row keyed by matching second. The two devices' clocks don't
-- agree closely enough for that to work cleanly — most rows ended up with
-- only one side populated anyway (see the COALESCE-on-conflict logic this
-- replaces, in the original 0011_cycling_power.sql). Instead each source
-- writes its own row: PRIMARY KEY gains a `source` column, so a Wahoo power
-- reading and a Watch HR reading at the same second are two distinct rows,
-- not one contended row. The chart/decoupling code already treats power and
-- HR as independent series filtered by non-null column — this is a pure
-- storage simplification, no query-shape change needed downstream.
--
-- Derived data, same contract as `laps`/`route_points`: safe to rebuild from
-- R2 on re-ingest. Recreated rather than ALTERed since SQLite can't add a
-- column to a PRIMARY KEY in place.
DROP TABLE cycling_samples;

CREATE TABLE cycling_samples (
  workout_id   TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  t            INTEGER NOT NULL,      -- unix epoch seconds, UTC (each device's own clock)
  source       TEXT NOT NULL,         -- 'wahoo' | 'watch'
  power_w      INTEGER,
  cadence_rpm  INTEGER,
  hr           INTEGER,
  PRIMARY KEY (workout_id, t, source)
);
