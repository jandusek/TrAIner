-- Two Claude-authored, athlete-read surfaces, written via the MCP server at the
-- end of an analysis chat and surfaced read-only in the UI.
--
-- This is the first place the MCP layer *writes* to D1 (it was read-only until
-- now). Kept deliberately scoped: both tables are owned by Claude's output, never
-- touched by ingest/reprocess, so they live in their own tables (like `notes`)
-- and survive re-ingest untouched (workout_id is stable across ON CONFLICT).
--
-- Division of labour:
--   notes          — athlete writes (UI Tiptap editor), Claude reads (MCP)
--   session_evals  — Claude writes (MCP), athlete reads (UI)        ← this file
--   session_focus  — Claude writes (MCP), athlete reads (UI)        ← this file

-- Claude's evaluation of one workout. One row per workout, upserted (latest
-- chat's assessment wins), mirroring the `notes` one-per-workout shape.
-- content_md is markdown — what Claude naturally emits and what the UI renders.
CREATE TABLE session_evals (
  workout_id  TEXT PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_md  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_session_evals_user ON session_evals(user_id);

-- Forward-looking training focus, per sport. Append-with-supersede: the current
-- focus for (user, sport) is the row with superseded_at IS NULL. Setting a new
-- focus stamps superseded_at on the prior current row, so the table is also a
-- history of how focus evolved (the 4-8 week trend lens, not a single snapshot).
CREATE TABLE session_focus (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport             TEXT NOT NULL,
  items_json        TEXT NOT NULL,             -- JSON array of focus-bullet strings
  set_by_workout_id TEXT REFERENCES workouts(id) ON DELETE SET NULL,
  created_at        INTEGER NOT NULL,
  superseded_at     INTEGER                    -- NULL = current
);
-- Partial index over just the live rows: fast "current focus for this sport".
CREATE INDEX idx_focus_current ON session_focus(user_id, sport) WHERE superseded_at IS NULL;
CREATE INDEX idx_focus_history ON session_focus(user_id, sport, created_at);
