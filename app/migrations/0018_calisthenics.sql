-- Calisthenics (pull-ups, push-ups): self-reported strength sets, autoregulated
-- by RIR rather than a fixed rep table. No device/ingest path — this is the
-- first sport that's 100% manually logged from the UI (see CLAUDE.md's
-- "Adding new sports" and app/ARCHITECTURE.md for why: no wearable can
-- rep-count bodyweight movements or read strength-set effort from HR).
--
-- A calisthenics session is a normal `workouts` row (sport='calisthenics',
-- sub_type='pullup'|'pushup') so it falls through the existing list/detail
-- API, home page, and session_evals/session_focus machinery for free. This
-- table holds only what's specific to a strength set: reps and RIR per set.
--
-- The autoregulation engine (app/src/calisthenics.ts) is a pure function
-- over this history — no separate "current prescription" table. Recomputing
-- from a handful of recent rows is cheap at this scale, and avoids a cached
-- value drifting from what the history actually says.
CREATE TABLE calisthenics_sets (
  workout_id  TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  set_num     INTEGER NOT NULL,
  reps        INTEGER NOT NULL,
  rir         INTEGER,               -- reps in reserve, self-reported; NULL means "to failure" (is_amrap)
  is_amrap    INTEGER NOT NULL DEFAULT 0,  -- 1 = top-set AMRAP retest (~0-1 RIR), used to recalibrate best-ever
  PRIMARY KEY (workout_id, set_num)
);
