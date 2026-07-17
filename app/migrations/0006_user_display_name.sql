-- Human-facing display name, shown in the UI instead of the raw Access email.
-- Nullable: auto-provisioned users start without one and fall back to email.
ALTER TABLE users ADD COLUMN display_name TEXT;

-- display_name is set per-user via a manual `wrangler d1 execute` UPDATE
-- after provisioning, rather than seeded here, to keep real emails/names
-- out of version-controlled migrations.
