// Ambient Env for the MCP worker. The copied reference files (access-handler.ts,
// workers-oauth-utils.ts) reference a global `Env`, so we declare it here rather
// than relying on `wrangler types` generation.
declare global {
  interface Env {
    // Bindings (wrangler.jsonc)
    DB: D1Database; // shared training database (read-only use here)
    OAUTH_KV: KVNamespace; // OAuth grants/tokens + auth state
    MCP_OBJECT: DurableObjectNamespace; // McpAgent session storage

    // Cloudflare Access (OIDC) — vars are safe to commit; URLs embed the client id.
    ACCESS_CLIENT_ID: string;
    ACCESS_AUTHORIZATION_URL: string;
    ACCESS_TOKEN_URL: string;
    ACCESS_JWKS_URL: string;

    // Secrets (wrangler secret put)
    ACCESS_CLIENT_SECRET: string;
    COOKIE_ENCRYPTION_KEY: string;
  }
}

export {};
