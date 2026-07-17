-- Reconstructed swim laps (one row per length).
--
-- HAE's v2 export has no native lap markers, so these are inferred from the
-- per-second swimDistance/swimStroke arrays (see src/laps.ts). The schema
-- matches ARCHITECTURE.md; `reconstructed = 1` distinguishes inferred boundaries
-- from native ones (future cycling FIT laps will set it to 0).
--
-- Laps are derived data: ingest deletes a workout's laps and rewrites them, so
-- reprocessing after a parser change is just a re-ingest from the R2 archive.

CREATE TABLE laps (
  workout_id      TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  lap_num         INTEGER NOT NULL,
  start_time      INTEGER NOT NULL,           -- unix epoch seconds, UTC
  active_sec      REAL NOT NULL,              -- swim time only, rest excluded
  rest_after_sec  REAL,                       -- wall rest before the next lap
  distance_m      REAL,                       -- scaled to the workout's reported total
  strokes         REAL,                       -- summed from swimStroke over the lap window
  pace_per_50m    REAL,                       -- derived seconds per 50 m
  pace_per_km     REAL,                       -- derived seconds per km
  swolf           REAL,                       -- active_sec + strokes (full lengths only)
  avg_hr          REAL,
  max_hr          INTEGER,
  stroke_type     TEXT,                       -- raw Watch label if any; corrections applied at query time
  reconstructed   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workout_id, lap_num)
);

CREATE INDEX idx_laps_workout ON laps(workout_id, lap_num);
