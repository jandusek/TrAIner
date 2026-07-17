-- Workout summaries (one row per workout).
--
-- This is the first slice of the workout schema from ARCHITECTURE.md: session
-- summary only. Laps, hr_samples, and hr_recovery come in later migrations once
-- lap reconstruction lands. D1 is a derived cache — the raw HAE workout JSON in
-- R2 (raw/{source_id}.json) is the source of truth and can repopulate this table.
--
-- Dedup: `source_id` is the HealthKit workout UUID (workout.id in the v2 export).
-- HealthKit samples are immutable, so re-sending the same workout carries the
-- same UUID. Ingest upserts with ON CONFLICT(source_id), making re-sends and
-- backfills idempotent.

CREATE TABLE workouts (
  id              TEXT PRIMARY KEY,            -- our internal UUID (stable across re-ingest)
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id       TEXT UNIQUE NOT NULL,        -- HealthKit workout UUID (dedup key)

  start_time      INTEGER NOT NULL,            -- unix epoch seconds, UTC
  end_time        INTEGER NOT NULL,            -- unix epoch seconds, UTC
  tz_offset       TEXT,                        -- original offset, e.g. '+0800'

  sport           TEXT NOT NULL,               -- normalized: 'swimming' | 'cycling' | 'tennis' | 'other'
  sub_type        TEXT,                        -- raw HAE workout name, e.g. 'Pool Swim'
  is_indoor       INTEGER,                     -- 0 / 1 / NULL

  duration_sec    INTEGER,                     -- total elapsed
  distance_m      REAL,                        -- meters
  pool_length_m   REAL,                        -- swim only, meters
  avg_hr          REAL,
  max_hr          INTEGER,
  total_strokes   INTEGER,                     -- swim only
  active_energy   REAL,                        -- kcal
  temperature_c   REAL,                        -- conditions if recorded
  humidity_pct    REAL,

  raw_r2_key      TEXT NOT NULL,               -- pointer to raw JSON in R2
  parser_version  TEXT NOT NULL,               -- bump to find rows needing reprocess
  ingested_at     INTEGER NOT NULL             -- unix epoch seconds
);

CREATE INDEX idx_workouts_user_start ON workouts(user_id, start_time);
CREATE INDEX idx_workouts_user_sport_start ON workouts(user_id, sport, start_time);
