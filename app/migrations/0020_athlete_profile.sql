-- Athlete profile: freeform markdown bio (age, VO2max/HR zones, active sports,
-- equipment, anything else Claude should know about the athlete). Same
-- ownership shape as `notes` — athlete-authored via the Settings UI,
-- Claude-read via MCP (`get_athlete_profile`), never written by Claude. One
-- row per user; replaces on save rather than versioning, same as `notes`.
--
-- Previously this lived as hardcoded prose in CLAUDE.md, which meant a
-- second athlete on the same deployment saw the first athlete's profile (and
-- meant real personal data — age, VO2max, a training diagnosis — sat in a
-- version-controlled file). Moving it here makes it per-user and keeps the
-- repo generic.
CREATE TABLE athlete_profile (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profile_md TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
