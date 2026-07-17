-- Make the dedup key `(user_id, source_id)`, as ARCHITECTURE.md has always
-- described it. Until now the code enforced a *global* dedup key: 0002's
-- `source_id TEXT UNIQUE` plus `ON CONFLICT(source_id)` in store.ts.
--
-- Why the doc was right and the code was wrong: every read path already treats
-- (user_id, source_id) as the identity — selectExistingSourceIds,
-- selectDeletedSourceIds and deleteWorkout all filter `WHERE user_id = ? AND
-- source_id = ?` (store.ts). Only the two ON CONFLICT targets and these
-- constraints were global, so the composite key isn't a new design, it's the
-- one the rest of the code already assumed.
--
-- Why it matters, concretely: HAE source_ids are HealthKit UUIDs and are
-- genuinely globally unique, so they were never the risk. The `wahoo:{id}`
-- prefix scheme (index.ts) is: Wahoo's Cloud API resolves `GET /v1/workouts/:id`
-- against the authenticated user's token and documents no cross-account
-- uniqueness guarantee, and its ids are small integers. If they are per-account
-- sequential, two athletes don't collide *rarely* — they collide immediately,
-- since both would own workout #1, #2, #3. The old behaviour on collision was
-- the worst kind: ON CONFLICT(source_id) DO UPDATE silently overwrote the first
-- athlete's row with the second athlete's ride, leaving user_id pointing at the
-- original owner. Loud failure beats silent cross-user corruption.

-- `deleted_workouts` gets the full fix: it's a leaf table (nothing has an FK to
-- it), so it can be rebuilt outright. Its PK was source_id alone, while its
-- only reader already scoped by user (`WHERE user_id = ? AND source_id IN ...`,
-- store.ts) — so athlete B deleting a source_id that athlete A also owned would
-- ON CONFLICT onto A's tombstone, updating A's row and never creating B's. B's
-- workout would then silently resurrect on the next HAE export or Wahoo backfill.
CREATE TABLE deleted_workouts_new (
  source_id   TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  sport       TEXT,
  sub_type    TEXT,
  start_time  INTEGER,
  reason      TEXT,
  deleted_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_id)
);

INSERT INTO deleted_workouts_new (source_id, user_id, sport, sub_type, start_time, reason, deleted_at)
  SELECT source_id, user_id, sport, sub_type, start_time, reason, deleted_at FROM deleted_workouts;

DROP TABLE deleted_workouts;
ALTER TABLE deleted_workouts_new RENAME TO deleted_workouts;
CREATE INDEX idx_deleted_workouts_user ON deleted_workouts(user_id);

-- `workouts` gets the composite index but KEEPS 0002's global UNIQUE on
-- source_id, which is deliberate — see the migration note below.
CREATE UNIQUE INDEX idx_workouts_user_source ON workouts(user_id, source_id);

-- Why the global UNIQUE on workouts.source_id survives this migration:
--
-- Dropping a column constraint in SQLite needs a table rebuild, and `workouts`
-- is the parent of 12 ON DELETE CASCADE children (laps, notes, session_evals,
-- lap_equipment, route_points, cycling_samples, {swim,running,tennis}_hr_samples,
-- running_cadence_samples, calisthenics_sets) plus two ON DELETE SET NULL
-- references (session_focus.set_by_workout_id and its own superseded_by).
-- `DROP TABLE workouts` therefore deletes every child row. This was verified
-- empirically against a local D1, not assumed: a naive create/copy/drop/rename
-- wiped notes (4 -> 0), session_evals (9 -> 0) and laps (93 -> 0). `PRAGMA
-- foreign_keys = OFF` in a migration file does NOT prevent it (D1 also documents
-- that `defer_foreign_keys` does not suppress CASCADE actions). Most children are
-- derived and rebuildable from R2, but `notes` and `session_evals` are
-- athlete/Claude-authored and exist nowhere else — an unrecoverable loss.
--
-- Keeping the global UNIQUE costs us nothing today. It is strictly *stricter*
-- than the composite key: it can only reject a write that the composite would
-- have allowed, never corrupt one. With the ON CONFLICT targets now switched to
-- (user_id, source_id), a genuine cross-athlete source_id collision surfaces as a
-- failed ingest (a loud 500 that Wahoo will retry) instead of one athlete's ride
-- silently overwriting another's. That is the whole integrity win, and it lands
-- without touching a byte of athlete-authored data.
--
-- The remaining rebuild is only needed to let two athletes *coexist* on the same
-- source_id, which requires a second athlete, with a linked Wahoo account, whose
-- workout ids overlap. If that day comes, do it as its own migration: stage every
-- child table into a temp copy, rebuild, restore the children, and re-verify each
-- table's row count before and after.
