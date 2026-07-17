-- Per-workout, human-authored notes (rich text from the Tiptap editor).
--
-- Kept in its own table, separate from the derived `workouts`/`laps` data, so
-- re-ingesting or reprocessing a workout never clobbers what the athlete wrote.
-- workout_id is the internal UUID, which is stable across re-ingest (ON CONFLICT
-- keeps it), so notes stay attached.
--
-- Both representations are stored: content_json is the editor's source of truth
-- (ProseMirror doc, used to reload the editor faithfully); content_html is for
-- cheap read-only rendering (list snippets, future MCP/text export).

CREATE TABLE notes (
  workout_id    TEXT PRIMARY KEY REFERENCES workouts(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content_json  TEXT,
  content_html  TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX idx_notes_user ON notes(user_id);
