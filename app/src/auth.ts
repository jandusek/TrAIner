/**
 * Authentication for the two entry points.
 *
 *   UI / API  — Cloudflare Access. Access sits in front of these routes, runs the
 *               interactive SSO, and injects a signed JWT in the
 *               `Cf-Access-Jwt-Assertion` header. We *validate* that JWT here
 *               rather than trusting a plain header, so the worker can't be
 *               bypassed by hitting its *.workers.dev URL directly with a forged
 *               header. The validated `email` claim is the user identity.
 *
 *   Webhook    — Health Auto Export is a machine and can't do interactive SSO, so
 *               `/ingest` is NOT behind Access. Each user gets a random bearer
 *               token (stored in HAE's header config). We hash the presented
 *               token and look the user up by hash.
 */

// ---------------------------------------------------------------------------
// Ingest tokens (webhook path)
// ---------------------------------------------------------------------------

const TOKEN_PREFIX = "htk_"; // "health token"

/** Mint a fresh ingest token. Returned to the user once; only its hash is stored. */
export function mintIngestToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return TOKEN_PREFIX + base64url(bytes);
}

/** SHA-256 hex of a token. The DB stores this, never the token itself. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return hex(new Uint8Array(digest));
}

/** Pull the bearer token out of an Authorization header, or null. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const presented = header.replace(/^Bearer\s+/i, "").trim();
  return presented || null;
}

// ---------------------------------------------------------------------------
// Cloudflare Access (UI / API path)
// ---------------------------------------------------------------------------

export interface AccessIdentity {
  email: string;
  sub: string;
}

interface Jwk {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

// JWKS rarely rotates; cache the imported keys per team domain in module memory.
const jwksCache = new Map<string, { keys: Map<string, CryptoKey>; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

async function getAccessKeys(teamDomain: string, kid: string): Promise<CryptoKey | null> {
  const cached = jwksCache.get(teamDomain);
  const fresh = cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS;
  if (fresh && cached!.keys.has(kid)) return cached!.keys.get(kid)!;

  // Cache miss or unknown kid (possible key rotation) — refetch.
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access JWKS fetch failed: ${res.status}`);
  const { keys } = (await res.json()) as { keys: Jwk[] };

  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    imported.set(jwk.kid, key);
  }
  jwksCache.set(teamDomain, { keys: imported, fetchedAt: Date.now() });
  return imported.get(kid) ?? null;
}

/**
 * Verify the Access JWT from `Cf-Access-Jwt-Assertion`. Returns the identity on
 * success, or null if the header is missing or the token fails validation.
 *
 * `teamDomain` is the Access team URL (https://<team>.cloudflareaccess.com);
 * `aud` is the Application Audience tag from the Access application config.
 */
export async function verifyAccessJwt(
  req: Request,
  teamDomain: string,
  aud: string,
): Promise<AccessIdentity | null> {
  const token = req.headers.get("cf-access-jwt-assertion");
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { kid?: string; alg?: string };
  let claims: { aud?: string | string[]; iss?: string; email?: string; sub?: string; exp?: number; nbf?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));
    claims = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) return null;

  const key = await getAccessKeys(teamDomain, header.kid);
  if (!key) return null;

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64urlDecode(sigB64),
    signed,
  );
  if (!valid) return null;

  // Claim checks: audience, issuer, expiry.
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(aud) : claims.aud === aud;
  if (!audOk) return null;
  if (claims.iss !== teamDomain) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && claims.exp < now) return null;
  if (typeof claims.nbf === "number" && claims.nbf > now) return null;
  if (!claims.email || !claims.sub) return null;

  return { email: claims.email.toLowerCase(), sub: claims.sub };
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
