-- Tombstones for deleted workouts.
--
-- Deleting a workout removes its `workouts` row (children cascade — laps,
-- notes, route_points, cycling_samples, lap_equipment, session_evals — see
-- their ON DELETE CASCADE FKs) and its raw R2 objects. But source_id is the
-- dedup key ingest upserts on (see migrations/0002_workouts.sql), so without
-- a separate record of "this one was deleted on purpose", the athlete's own
-- automation (HAE export re-running, a Wahoo backfill) would just re-insert
-- it on the next sync. This table is that record: ingest checks it before
-- upserting and skips any source_id found here (see store.ts).
--
-- Kept forever, never cascade-deleted with the user — a tombstone for a
-- since-deleted user is harmless dead weight, not worth a migration to prune.
CREATE TABLE deleted_workouts (
  source_id   TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  sport       TEXT,                  -- snapshot for the athlete's own reference; not re-validated on re-ingest
  sub_type    TEXT,
  start_time  INTEGER,
  reason      TEXT,                  -- optional free-text note on why it was deleted
  deleted_at  INTEGER NOT NULL
);
CREATE INDEX idx_deleted_workouts_user ON deleted_workouts(user_id);
