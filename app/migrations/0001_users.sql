-- Multi-user registry.
--
-- One row per athlete. Two ways in:
--   * UI    — Cloudflare Access SSO, identified by `email`.
--   * Webhook — Health Auto Export, identified by a per-user bearer token
--               (only the SHA-256 hash is stored; the token is shown once at mint time).
--
-- Access is the gate for who may sign in at all (configured in the Cloudflare
-- dashboard), so users auto-provision on first authenticated UI visit.

CREATE TABLE users (
  id                TEXT PRIMARY KEY,            -- internal UUID, FK target for workouts/laps/etc.
  email             TEXT UNIQUE NOT NULL,        -- matches the Access identity
  ingest_token_hash TEXT UNIQUE,                 -- SHA-256 hex of the per-user webhook token (null until minted)
  created_at        INTEGER NOT NULL,            -- unix epoch seconds
  token_rotated_at  INTEGER                      -- when the ingest token was last (re)minted
);

-- Webhook auth path looks users up by token hash on every ingest.
CREATE INDEX idx_users_token ON users(ingest_token_hash);
