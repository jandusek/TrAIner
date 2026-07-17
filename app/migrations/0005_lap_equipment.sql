-- Per-lap equipment tags (athlete-authored structured data).
--
-- Kept separate from the derived `laps` table, which is deleted and rebuilt on
-- every ingest — these tags must survive that. Keyed by (workout_id, lap_num).
--
-- One row per (lap, equipment) rather than boolean columns, so new equipment is
-- a config change in the worker, not a schema migration. Current values:
-- 'pull_buoy', 'front_snorkel'.
--
-- Caveat: tags bind to lap_num. If a future parser change alters lap boundaries
-- or count, tags may need revisiting — acceptable at personal scale.

CREATE TABLE lap_equipment (
  workout_id  TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  lap_num     INTEGER NOT NULL,
  equipment   TEXT NOT NULL,
  PRIMARY KEY (workout_id, lap_num, equipment)
);

CREATE INDEX idx_lap_equipment_workout ON lap_equipment(workout_id);
