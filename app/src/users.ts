/**
 * User registry backed by D1. A "handful of users" scale — no roles, no orgs,
 * just identity (email) plus a per-user webhook token.
 */

import { hashToken, mintIngestToken } from "./auth";

export interface User {
  id: string;
  email: string;
  display_name: string | null;
  ingest_token_hash: string | null;
  created_at: number;
  token_rotated_at: number | null;
}

/** Look up a user by Access email, creating the row on first sign-in. */
export async function getOrCreateUserByEmail(db: D1Database, email: string): Promise<User> {
  const normalized = email.toLowerCase();
  const existing = await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(normalized)
    .first<User>();
  if (existing) return existing;

  const user: User = {
    id: crypto.randomUUID(),
    email: normalized,
    display_name: null,
    ingest_token_hash: null,
    created_at: Math.floor(Date.now() / 1000),
    token_rotated_at: null,
  };
  // ON CONFLICT guards the race where two requests create the same email at once.
  await db
    .prepare(
      "INSERT INTO users (id, email, ingest_token_hash, created_at, token_rotated_at) " +
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING",
    )
    .bind(user.id, user.email, null, user.created_at, null)
    .run();

  // Re-read in case the conflicting insert won.
  return (await db.prepare("SELECT * FROM users WHERE email = ?").bind(normalized).first<User>())!;
}

/** Resolve the user behind an ingest token (webhook auth), or null. */
export async function getUserByIngestToken(db: D1Database, token: string): Promise<User | null> {
  const h = await hashToken(token);
  return db.prepare("SELECT * FROM users WHERE ingest_token_hash = ?").bind(h).first<User>();
}

/**
 * Mint (or rotate) a user's ingest token. Returns the plaintext token — this is
 * the ONLY time it's available; only the hash is persisted.
 */
export async function rotateIngestToken(db: D1Database, userId: string): Promise<string> {
  const token = mintIngestToken();
  const h = await hashToken(token);
  await db
    .prepare("UPDATE users SET ingest_token_hash = ?, token_rotated_at = ? WHERE id = ?")
    .bind(h, Math.floor(Date.now() / 1000), userId)
    .run();
  return token;
}
