/**
 * Wahoo Cloud API client: OAuth token exchange/refresh, and fetching a
 * workout's FIT file once we hold a valid token for the athlete.
 *
 * Confirmed against https://cloud-api.wahooligan.com/ (2026-07-01):
 *   - Token endpoint takes params in the query string, not a JSON/form body.
 *   - Access tokens are short-lived (2h); refresh_token rotates on every use
 *     (the response includes a NEW refresh_token — the old one stops working).
 *   - Webhook payloads carry `webhook_token` as a JSON body field (not a
 *     header), and `user.id` — Wahoo's own numeric user id, not ours.
 */

const AUTHORIZE_URL = "https://api.wahooligan.com/oauth/authorize";
const TOKEN_URL = "https://api.wahooligan.com/oauth/token";
const API_BASE = "https://api.wahooligan.com/v1";

// Matches the scopes granted on the Wahoo developer app (see ARCHITECTURE.md).
// offline_data is load-bearing: without it there's no refresh_token, so sync
// dies after the first access-token expiry (2h).
const SCOPES = "email user_read workouts_read power_zones_read routes_read plans_read offline_data";

export interface WahooEnv {
  WAHOO_CLIENT_ID?: string;
  WAHOO_CLIENT_SECRET?: string;
}

interface WahooTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
}

export interface WahooUser {
  id: number;
  email: string;
}

export function isWahooConfigured(env: WahooEnv): env is Required<WahooEnv> {
  return Boolean(env.WAHOO_CLIENT_ID && env.WAHOO_CLIENT_SECRET);
}

export function buildAuthorizeUrl(env: Required<WahooEnv>, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: env.WAHOO_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_type: "code",
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function postToken(params: URLSearchParams): Promise<WahooTokenResponse> {
  const res = await fetch(`${TOKEN_URL}?${params.toString()}`, { method: "POST" });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Wahoo token endpoint ${res.status}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

export async function exchangeCode(
  env: Required<WahooEnv>,
  code: string,
  redirectUri: string,
): Promise<WahooTokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: env.WAHOO_CLIENT_ID,
      client_secret: env.WAHOO_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  );
}

export async function refreshAccessToken(
  env: Required<WahooEnv>,
  refreshToken: string,
): Promise<WahooTokenResponse> {
  return postToken(
    new URLSearchParams({
      client_id: env.WAHOO_CLIENT_ID,
      client_secret: env.WAHOO_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  );
}

/** Who does this access token belong to, on Wahoo's side? Needed once at link time. */
export async function fetchWahooUser(accessToken: string): Promise<WahooUser> {
  const res = await fetch(`${API_BASE}/user`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Wahoo /user ${res.status}`);
  return res.json();
}

export interface WahooWorkoutSummary {
  id: number;
  workout_summary?: { file?: { url?: string } | null } | null;
}

/** Fetch a single workout by id (includes workout_summary.file.url for the FIT download). */
export async function fetchWorkout(accessToken: string, workoutId: string | number): Promise<WahooWorkoutSummary> {
  const res = await fetch(`${API_BASE}/workouts/${workoutId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Wahoo /workouts/${workoutId} ${res.status}`);
  return res.json();
}

/** Download the FIT bytes from the signed URL returned in workout_summary.file.url. */
export async function downloadFit(fileUrl: string): Promise<ArrayBuffer> {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Wahoo FIT download ${res.status}`);
  return res.arrayBuffer();
}

// ---------------------------------------------------------------------------
// wahoo_tokens (D1)
// ---------------------------------------------------------------------------

export interface WahooTokenRow {
  user_id: string;
  wahoo_user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  created_at: number;
  updated_at: number;
}

/** Persist the tokens from an initial exchange or a refresh. Upserts on user_id. */
export async function saveWahooTokens(
  db: D1Database,
  userId: string,
  wahooUserId: number,
  tokens: WahooTokenResponse,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + tokens.expires_in;
  await db
    .prepare(
      `INSERT INTO wahoo_tokens (user_id, wahoo_user_id, access_token, refresh_token, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         wahoo_user_id = excluded.wahoo_user_id,
         access_token = excluded.access_token,
         refresh_token = excluded.refresh_token,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, String(wahooUserId), tokens.access_token, tokens.refresh_token, expiresAt, now, now)
    .run();
}

/** Resolve our internal user id from a webhook payload's Wahoo user id. */
export async function getUserIdByWahooUserId(db: D1Database, wahooUserId: number | string): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM wahoo_tokens WHERE wahoo_user_id = ?")
    .bind(String(wahooUserId))
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

// Refresh a bit before actual expiry to avoid racing a request against it.
const EXPIRY_SKEW_SEC = 120;

/**
 * A valid access token for this user, refreshing (and persisting the rotated
 * refresh_token) if the stored one is expired or close to it. Returns null if
 * the athlete hasn't linked Wahoo yet.
 */
export async function getValidAccessToken(
  db: D1Database,
  env: Required<WahooEnv>,
  userId: string,
): Promise<string | null> {
  const row = await db.prepare("SELECT * FROM wahoo_tokens WHERE user_id = ?").bind(userId).first<WahooTokenRow>();
  if (!row) return null;

  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at - EXPIRY_SKEW_SEC > now) return row.access_token;

  const refreshed = await refreshAccessToken(env, row.refresh_token);
  await saveWahooTokens(db, userId, Number(row.wahoo_user_id), refreshed);
  return refreshed.access_token;
}
