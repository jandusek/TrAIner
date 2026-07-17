-- Wahoo Cloud API OAuth linkage. One row per athlete who has authorized the
-- Wahoo app. Populated by the /wahoo/oauth/callback token exchange; refreshed
-- in place whenever a webhook handler needs a token past its expiry.
--
-- wahoo_user_id is how incoming webhook events (which carry Wahoo's own user
-- id, not ours) get mapped back to a row in `users`.

CREATE TABLE wahoo_tokens (
  user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  wahoo_user_id TEXT UNIQUE NOT NULL,          -- Wahoo's numeric user id, stored as text
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,              -- unix epoch seconds
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Webhook auth path looks users up by Wahoo's user id on every event.
CREATE INDEX idx_wahoo_tokens_wahoo_user ON wahoo_tokens(wahoo_user_id);
