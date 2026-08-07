/**
 * Training ingest worker — multi-user.
 *
 * Two entry points, two auth models (see auth.ts):
 *
 *   POST /ingest            webhook. Per-user bearer token (Health Auto Export).
 *                           NOT behind Cloudflare Access — HAE is a machine.
 *
 *   everything else         UI / API. Behind Cloudflare Access; the worker
 *                           validates the injected Access JWT and resolves the
 *                           email to a user (auto-creating on first sign-in).
 *
 * Storage: each ingested workout is written raw-first to R2 (source of truth)
 * and upserted into D1 as a summary row, keyed by the HealthKit UUID so re-sends
 * dedup. The last raw payload per user is also stashed in KV for quick eyeball /
 * debugging. Lap reconstruction + HR time series come next per ARCHITECTURE.md.
 */

import { bearerToken, verifyAccessJwt } from "./auth";
import { storeWorkouts, storeFitWorkout, deleteWorkout } from "./store";
import {
  CARD_STATS_HISTORY_LIMIT,
  computePrescription,
  getCalisthenicsHistory,
  isMovement,
  MOVEMENTS,
  summarizeSessions,
  type Movement,
  type SessionCardStats,
} from "./calisthenics";
import { ParseError } from "./parse";
import { ECHO_AGGREGATE_SQL } from "./sql";
import {
  gatherEvalContext,
  renderEvalPrompt,
  runEvaluation,
  persistEval,
  persistFocus,
  EVAL_MODEL,
} from "./evaluate";
import { putLastPayload, lastKey } from "./last-payload";
import { parseFitWorkout, FIT_PARSER_VERSION } from "./fit";
import {
  getOrCreateUserByEmail,
  getUserByIngestToken,
  rotateIngestToken,
  type User,
} from "./users";
import {
  buildAuthorizeUrl,
  downloadFit,
  exchangeCode,
  fetchWahooUser,
  fetchWorkout,
  getUserIdByWahooUserId,
  getValidAccessToken,
  isWahooConfigured,
  saveWahooTokens,
} from "./wahoo";
// Front end. Bundled as text modules (see wrangler.jsonc "rules") so the React
// apps stay readable source instead of escaped template-literal soup.
import UI_CSS from "./ui.css";
import HOME_CLIENT from "./home.client.js";
import DETAIL_CLIENT from "./detail.client.js";
import CALISTHENICS_CLIENT from "./calisthenics.client.js";
import SETTINGS_CLIENT from "./settings.client.js";
import APPLE_TOUCH_ICON from "../apple-touch-icon.png";

interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  LAST_PAYLOAD: KVNamespace;
  AI: Ai; // Workers AI — on-demand workout evaluation (see evaluate.ts).
  // Host-based routing (set as plain vars in wrangler.jsonc).
  INGEST_HOST: string; // webhook host, e.g. training-ingest.yourdomain.com
  APP_HOST: string; // UI/API host, e.g. training.yourdomain.com
  MCP_HOST: string; // MCP server host (separate worker), e.g. training-mcp.yourdomain.com
  // Cloudflare Access config (set as plain vars in wrangler.jsonc).
  ACCESS_TEAM_DOMAIN: string; // https://<team>.cloudflareaccess.com
  ACCESS_AUD: string; // Application Audience tag from the Access app
  // Local-dev-only escape hatch: `wrangler dev` has no Access in front of it, so
  // there's no JWT to validate. Set via `.dev.vars` (gitignored) to log in as a
  // given user without SSO. Never set via `wrangler secret put` in production.
  DEV_USER_EMAIL?: string;
  // Wahoo Cloud API (cycling). Secrets — `.dev.vars` locally, `wrangler secret
  // put` in prod. CLIENT_* are absent until the developer app is approved.
  WAHOO_WEBHOOK_TOKEN: string; // shared token Wahoo echoes on each webhook event
  WAHOO_CLIENT_ID?: string;
  WAHOO_CLIENT_SECRET?: string;
}

// Reuses the LAST_PAYLOAD KV (no dedicated namespace) for the short-lived
// OAuth CSRF state — a 10-minute TTL key, distinct prefix, nothing to do with
// "last payload" semantically but not worth a whole new binding for.
const wahooStateKey = (state: string) => `wahoo_state:${state}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Per-session rep sequence + effort % for every calisthenics workout across
 * the given movements, keyed by source_id. Always computed over the athlete's
 * *full* history for that movement (see CARD_STATS_HISTORY_LIMIT) regardless
 * of what's paginated on screen — best_ever_prior has to see everything that
 * came before a session to score it fairly, not just whatever page it's on.
 */
async function calisthenicsCardStats(
  db: D1Database,
  userId: string,
  movements: Movement[],
): Promise<Map<string, SessionCardStats>> {
  const out = new Map<string, SessionCardStats>();
  for (const m of movements) {
    const historyDesc = await getCalisthenicsHistory(db, userId, m, CARD_STATS_HISTORY_LIMIT);
    for (const s of summarizeSessions([...historyDesc].reverse())) out.set(s.source_id, s);
  }
  return out;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Route by Host. The webhook lives only on INGEST_HOST; everything else
    // (APP_HOST and any unknown host) falls through to the Access-gated app, so
    // the token path can never be reached on the wrong hostname.
    //
    // Local dev (`wrangler dev`) serves localhost → app side. To exercise the
    // webhook locally, override the Host header:
    //   curl -H 'Host: training-ingest.yourdomain.com' http://localhost:8787/ingest
    if (url.host === env.INGEST_HOST) {
      return ingestHost(req, env, url);
    }
    return appHost(req, env, url);
  },
} satisfies ExportedHandler<Env>;

/** training-ingest.yourdomain.com — machine webhook. Per-user token, NOT behind Access. */
async function ingestHost(req: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;

  if (pathname === "/health") {
    return json({ ok: true, host: "ingest", ts: new Date().toISOString() });
  }

  if (pathname === "/ingest" && req.method === "POST") {
    return handleIngest(req, env);
  }

  // Wahoo Cloud API (cycling). Both live on the webhook host — Wahoo's servers
  // can't pass Cloudflare Access. See ARCHITECTURE.md → Authentication → Wahoo.
  if (pathname === "/wahoo/oauth/callback" && req.method === "GET") {
    return handleWahooOAuthCallback(req, env, url);
  }
  if (pathname === "/wahoo/webhook") {
    return handleWahooWebhook(req, env);
  }

  // No UI/API surface on the webhook host.
  return json({ error: "not found", path: pathname }, 404);
}

/** training.yourdomain.com — UI/API for humans. Gated by Cloudflare Access. */
async function appHost(req: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;

  if (pathname === "/health") {
    return json({ ok: true, host: "app", ts: new Date().toISOString() });
  }

  // Home-screen icon for iOS "Add to Home Screen". Placed before the worker's own
  // JWT check (Cloudflare Access still gates the host at the edge, so this needs a
  // login session — fine in practice: Safari fetches it with the authenticated
  // session's cookies when the user adds an open page to their home screen). To
  // make it truly public, add an Access bypass policy for /apple-touch-icon*.
  // `-precomposed` is the legacy alias older iOS versions probe for.
  if (
    (pathname === "/apple-touch-icon.png" || pathname === "/apple-touch-icon-precomposed.png") &&
    req.method === "GET"
  ) {
    return new Response(APPLE_TOUCH_ICON, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=604800, immutable",
      },
    });
  }

  // Defense in depth: even with Access in front, validate the injected JWT so a
  // misconfigured Access app can't expose these routes.
  //
  // DEV_USER_EMAIL (local dev only, via .dev.vars) skips Access entirely and
  // logs in as that user directly — there's no Access session to validate
  // against when running `wrangler dev` locally.
  const identity = env.DEV_USER_EMAIL
    ? { email: env.DEV_USER_EMAIL.toLowerCase(), sub: "dev-local" }
    : await verifyAccessJwt(req, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  if (!identity) {
    return json({ error: "unauthorized", detail: "valid Cloudflare Access session required" }, 401);
  }
  const user = await getOrCreateUserByEmail(env.DB, identity.email);

  // Theme glow assets. Each theme's HDR gradient is a distinct Rec.2020 PQ
  // video; serving them here keeps four copies out of all three client
  // bundles. Content-hashed by theme name and immutable — they only change
  // when a theme's colours do.
  if (pathname.startsWith("/glow/") && req.method === "GET") {
    const key = pathname.slice(6).replace(/\.webm$/, "");
    const b64 = GLOW_WEBM[key];
    if (!b64) return new Response("Not found", { status: 404 });
    const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    return new Response(bin, {
      headers: {
        "content-type": "video/webm",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }

  if (pathname === "/" && req.method === "GET") {
    return htmlResponse(renderHome(user));
  }

  if (pathname.startsWith("/w/") && req.method === "GET") {
    const sourceId = decodeURIComponent(pathname.slice(3));
    return htmlResponse(renderDetail(sourceId));
  }

  if (pathname === "/calisthenics" && req.method === "GET") {
    return htmlResponse(renderCalisthenics());
  }

  if (pathname === "/settings" && req.method === "GET") {
    const profile = await env.DB.prepare("SELECT profile_md FROM athlete_profile WHERE user_id = ?")
      .bind(user.id)
      .first<{ profile_md: string }>();
    return htmlResponse(renderSettings(user, env.INGEST_HOST, env.MCP_HOST, profile?.profile_md ?? ""));
  }

  if (pathname === "/api/me" && req.method === "GET") {
    return json(publicUser(user));
  }

  if (pathname === "/api/token/rotate" && req.method === "POST") {
    const token = await rotateIngestToken(env.DB, user.id);
    // Returned exactly once; only the hash is persisted.
    return json({ token, ingest_url: `https://${env.INGEST_HOST}/ingest` });
  }

  // Save (upsert/replace) the athlete's profile — same shape as /api/notes,
  // but keyed by user rather than workout, and there's only ever one.
  if (pathname === "/api/profile" && req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as { profile_md?: string } | null;
    if (typeof body?.profile_md !== "string") {
      return json({ error: "bad_request", detail: "profile_md required" }, 400);
    }
    const updatedAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO athlete_profile (user_id, profile_md, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         profile_md = excluded.profile_md,
         updated_at = excluded.updated_at`,
    )
      .bind(user.id, body.profile_md, updatedAt)
      .run();
    return json({ ok: true, updated_at: updatedAt });
  }

  if (pathname === "/api/wahoo/status" && req.method === "GET") {
    const row = await env.DB.prepare("SELECT updated_at FROM wahoo_tokens WHERE user_id = ?")
      .bind(user.id)
      .first<{ updated_at: number }>();
    return json({ linked: Boolean(row), linked_at: row?.updated_at ?? null });
  }

  if (pathname === "/api/wahoo/authorize" && req.method === "GET") {
    if (!isWahooConfigured(env)) {
      return json({ error: "wahoo_not_configured" }, 501);
    }
    // Short-lived state ties the callback (on the OTHER host, un-gated by
    // Access) back to this authenticated user, and guards against CSRF —
    // without it, anyone who guesses the callback URL could link their own
    // Wahoo account to whichever user_id they choose.
    const state = crypto.randomUUID();
    await env.LAST_PAYLOAD.put(wahooStateKey(state), user.id, { expirationTtl: 600 });
    const redirectUri = `https://${env.INGEST_HOST}/wahoo/oauth/callback`;
    return Response.redirect(buildAuthorizeUrl(env, redirectUri, state), 302);
  }

  if (pathname === "/api/last" && req.method === "GET") {
    const stored = await env.LAST_PAYLOAD.get(lastKey(user.id));
    if (!stored) return json({ message: "No payload received yet." }, 404);
    return new Response(stored, {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // Current prescription + recent sets for both tracked movements, computed
  // fresh from history every call (see calisthenics.ts — deterministic, no
  // cached "next prescription" row to drift out of sync with reality).
  if (pathname === "/api/calisthenics/state" && req.method === "GET") {
    const nowSec = Math.floor(Date.now() / 1000);
    const out: Record<Movement, { prescription: unknown; recent: unknown[] }> = {} as any;
    for (const m of MOVEMENTS) {
      const history = await getCalisthenicsHistory(env.DB, user.id, m);
      out[m] = {
        prescription: computePrescription(m, history, nowSec),
        recent: history.slice(0, 8),
      };
    }
    return json(out);
  }

  // Log a completed (or in-progress) set of sets for one movement. Creates a
  // normal `workouts` row (sport='calisthenics') so it flows through the
  // existing list/detail/eval/focus machinery, plus its per-set reps/RIR.
  // Returns the freshly recomputed prescription for next time.
  if (pathname === "/api/calisthenics/log" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as
      | {
          movement?: string;
          sets?: { reps: number; rir: number | null; is_amrap?: boolean; rest_before_sec?: number | null }[];
          started_at?: number;
        }
      | null;
    if (!isMovement(body?.movement)) {
      return json({ error: "bad_request", detail: "movement must be pullup or pushup" }, 400);
    }
    if (!Array.isArray(body?.sets) || body.sets.length === 0) {
      return json({ error: "bad_request", detail: "sets[] required" }, 400);
    }
    const clean = body.sets
      .map((s, i) => ({
        set_num: i + 1,
        reps: Math.round(Number(s.reps)),
        is_amrap: Boolean(s.is_amrap),
        rir: s.is_amrap ? null : s.rir == null ? null : Math.round(Number(s.rir)),
        // Self-timed by the logger UI's rest countdown; null for set 1 (no
        // prior set to rest from) and whenever the client didn't send one.
        rest_before_sec: s.rest_before_sec == null ? null : Math.round(Number(s.rest_before_sec)),
      }))
      .filter((s) => Number.isFinite(s.reps) && s.reps > 0);
    if (clean.length === 0) return json({ error: "bad_request", detail: "no valid sets" }, 400);

    const nowSec = Math.floor(Date.now() / 1000);
    const startedAt = typeof body.started_at === "number" ? body.started_at : nowSec;
    const sourceId = `manual:calisthenics:${crypto.randomUUID()}`;
    const workoutId = crypto.randomUUID();

    await env.DB.batch([
      env.DB
        .prepare(
          `INSERT INTO workouts (id, user_id, source_id, start_time, end_time, tz_offset, sport, sub_type, duration_sec, raw_r2_key, parser_version, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, 'calisthenics', ?, ?, '', 'manual', ?)`,
        )
        // tz_offset hardcoded to the athlete's home base (Singapore) — same
        // reasoning as fit.ts's cycling default: there's no device-reported
        // offset for a manually logged set.
        .bind(workoutId, user.id, sourceId, startedAt, nowSec, "+0800", body.movement, nowSec - startedAt, nowSec),
      ...clean.map((s) =>
        env.DB
          .prepare(
            `INSERT INTO calisthenics_sets (workout_id, set_num, reps, rir, is_amrap, rest_before_sec) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(workoutId, s.set_num, s.reps, s.rir, s.is_amrap ? 1 : 0, s.rest_before_sec),
      ),
    ]);

    const history = await getCalisthenicsHistory(env.DB, user.id, body.movement);
    const prescription = computePrescription(body.movement, history, nowSec);
    return json({ ok: true, source_id: sourceId, prescription });
  }

  if (pathname === "/api/workouts" && req.method === "GET") {
    // Same HR merge as /api/workout (see the comment there) — a Wahoo ride's
    // own avg_hr/max_hr are null (no chest strap), so the list view would
    // otherwise show a blank HR column for every cycling row that has a
    // Watch echo.
    //
    // Pagination: ?limit (default 20, capped 100) + ?offset. Optional
    // ?sport narrows to one sport. `sports` in the response is always the
    // *unfiltered* per-sport tally (so filter pill counts don't disappear
    // when a filter is active); `total` is the filtered count the current
    // page's limit/offset are relative to.
    const sport = url.searchParams.get("sport");
    const rawLimit = Number(url.searchParams.get("limit"));
    const rawOffset = Number(url.searchParams.get("offset"));
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 100) : 20;
    const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0;
    const sportClause = sport ? "AND w.sport = ?" : "";
    const filterArgs = sport ? [user.id, sport] : [user.id];

    const [rows, totalRow, facets] = await env.DB.batch([
      env.DB
        .prepare(
          `SELECT w.source_id, w.sport, w.sub_type, w.start_time, w.end_time, w.tz_offset,
                  w.is_indoor, w.duration_sec, w.moving_sec, w.distance_m, w.pool_length_m,
                  COALESCE(w.avg_hr, echo.avg_hr) AS avg_hr,
                  COALESCE(w.max_hr, echo.max_hr) AS max_hr,
                  w.total_strokes, w.active_energy, w.avg_power_w, w.normalized_power_w,
                  w.parser_version, w.ingested_at,
                  EXISTS(SELECT 1 FROM notes n WHERE n.workout_id = w.id) AS has_note,
                  EXISTS(SELECT 1 FROM session_evals e WHERE e.workout_id = w.id) AS has_eval,
                  EXISTS(SELECT 1 FROM session_focus f
                          WHERE f.set_by_workout_id = w.id AND f.superseded_at IS NULL) AS sets_focus
             FROM workouts w
             LEFT JOIN (${ECHO_AGGREGATE_SQL}) echo ON echo.canonical_id = w.id
            WHERE w.user_id = ? AND w.superseded_by IS NULL ${sportClause}
             ORDER BY w.start_time DESC LIMIT ? OFFSET ?`,
        )
        .bind(...filterArgs, limit, offset),
      env.DB
        .prepare(
          `SELECT COUNT(*) AS c FROM workouts w WHERE w.user_id = ? AND w.superseded_by IS NULL ${sportClause}`,
        )
        .bind(...filterArgs),
      env.DB
        .prepare(
          `SELECT sport, COUNT(*) AS c FROM workouts WHERE user_id = ? AND superseded_by IS NULL GROUP BY sport`,
        )
        .bind(user.id),
    ]);

    const workoutRows = (rows.results ?? []) as { source_id: string; sport: string; sub_type: string | null }[];
    const calisMovements = [
      ...new Set(workoutRows.filter((r) => r.sport === "calisthenics").map((r) => r.sub_type)),
    ].filter(isMovement);
    const calisStats = calisMovements.length ? await calisthenicsCardStats(env.DB, user.id, calisMovements) : new Map();
    const workoutsOut = workoutRows.map((r) => {
      const stats = calisStats.get(r.source_id);
      return stats ? { ...r, calisthenics: stats } : r;
    });

    return json({
      count: workoutsOut.length,
      total: (totalRow.results?.[0] as { c: number } | undefined)?.c ?? 0,
      limit,
      offset,
      sports: facets.results ?? [],
      workouts: workoutsOut,
    });
  }

  // Single workout: summary + laps + notes. Backs the detail page.
  if (pathname === "/api/workout" && req.method === "GET") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    // LEFT JOIN pulls in the superseded Apple Watch echo(es), if any — a
    // Wahoo ride has no HR (no chest strap paired) but the Watch echo does,
    // so HR is merged from there onto the canonical Wahoo row below rather
    // than lost when supersession hides the echo (see migrations/0009,
    // 0011_cycling_power.sql, and ECHO_AGGREGATE_SQL above for why it's
    // aggregated). Wahoo's own active_energy is kept as the canonical figure
    // (power-derived, more accurate than the Watch's HR/motion estimate) —
    // the echo's estimate is surfaced separately as watch_active_energy for
    // reference, not blended in.
    const workout = await env.DB.prepare(
      `SELECT w.id, w.source_id, w.sport, w.sub_type, w.start_time, w.end_time, w.tz_offset, w.is_indoor,
              w.duration_sec, w.moving_sec, w.distance_m, w.pool_length_m,
              COALESCE(w.avg_hr, echo.avg_hr) AS avg_hr,
              COALESCE(w.max_hr, echo.max_hr) AS max_hr,
              w.total_strokes, w.active_energy, echo.active_energy AS watch_active_energy,
              w.temperature_c, w.humidity_pct,
              w.avg_power_w, w.max_power_w, w.normalized_power_w, w.intensity_factor,
              w.training_stress_score, w.threshold_power_w, w.work_kj,
              w.avg_cadence_rpm, w.max_cadence_rpm, w.elevation_gain_m, w.power_zone_secs_json,
              -- Only surface the echo badge when it actually contributed something
              -- (typically HR, since Wahoo has no chest strap) — a pure resubmission
              -- with every one of these fields null is a dupe worth hiding entirely,
              -- not worth a badge (see migrations/0009_supersession.sql).
              (echo.canonical_id IS NOT NULL AND (
                echo.avg_hr IS NOT NULL OR echo.max_hr IS NOT NULL OR
                echo.distance_m IS NOT NULL OR echo.active_energy IS NOT NULL OR
                echo.temperature_c IS NOT NULL
              )) AS has_watch_echo
         FROM workouts w
         LEFT JOIN (${ECHO_AGGREGATE_SQL}) echo ON echo.canonical_id = w.id
        WHERE w.user_id = ? AND w.source_id = ?`,
    )
      .bind(user.id, sourceId)
      .first<{ id: string; sport: string; sub_type: string | null; source_id: string; has_watch_echo: number }>();
    if (!workout) return json({ error: "not_found" }, 404);
    // Wahoo rows are always canonical when both exist (see migrations/0009_supersession.sql),
    // so a Wahoo-sourced row's superseded sibling is guaranteed to be the HAE
    // (Apple Watch) echo — no need to check the sibling's own source_id.
    const source = workout.source_id.startsWith("wahoo:") ? "wahoo" : "watch";
    const workoutWithSource = { ...workout, source, has_watch_echo: Boolean(workout.has_watch_echo) };
    const laps = await env.DB.prepare(
      `SELECT lap_num, active_sec, rest_after_sec, distance_m, strokes,
              pace_per_50m, swolf, avg_hr, max_hr
         FROM laps WHERE workout_id = ? ORDER BY lap_num`,
    )
      .bind(workout.id)
      .all<{ lap_num: number }>();
    const equip = await env.DB.prepare(
      "SELECT lap_num, equipment FROM lap_equipment WHERE workout_id = ?",
    )
      .bind(workout.id)
      .all<{ lap_num: number; equipment: string }>();
    // Attach equipment[] to each lap.
    const byLap = new Map<number, string[]>();
    for (const e of equip.results ?? []) {
      const arr = byLap.get(e.lap_num) ?? [];
      arr.push(e.equipment);
      byLap.set(e.lap_num, arr);
    }
    const lapsOut = (laps.results ?? []).map((l) => ({ ...l, equipment: byLap.get(l.lap_num) ?? [] }));
    // Calisthenics has no laps; its per-set reps/RIR/rest live in their own
    // table (see migrations/0018_calisthenics.sql). Only queried for that
    // sport — every other sport's row is just an empty array here.
    const sets =
      workout.sport === "calisthenics"
        ? (
            await env.DB
              .prepare(
                `SELECT set_num, reps, rir, is_amrap, rest_before_sec FROM calisthenics_sets
                  WHERE workout_id = ? ORDER BY set_num`,
              )
              .bind(workout.id)
              .all<{ set_num: number; reps: number; rir: number | null; is_amrap: number; rest_before_sec: number | null }>()
          ).results ?? []
        : [];
    // Same rep-sequence + effort-% stats as the list view (see
    // calisthenicsCardStats), just resolved for this one workout.
    const calisthenicsStats =
      isMovement(workout.sub_type) && workout.sport === "calisthenics"
        ? (await calisthenicsCardStats(env.DB, user.id, [workout.sub_type])).get(sourceId) ?? null
        : null;
    const note = await env.DB.prepare(
      "SELECT content_json, content_html, updated_at FROM notes WHERE workout_id = ?",
    )
      .bind(workout.id)
      .first();
    // Claude-authored, read-only in the UI (written via the MCP server).
    const evaluation = await env.DB.prepare(
      "SELECT content_md, generated_by, created_at, updated_at FROM session_evals WHERE workout_id = ?",
    )
      .bind(workout.id)
      .first();
    const focus = await env.DB.prepare(
      `SELECT f.items_json, f.created_at, w2.source_id AS set_by_source_id
         FROM session_focus f
         LEFT JOIN workouts w2 ON f.set_by_workout_id = w2.id
        WHERE f.user_id = ? AND f.sport = ? AND f.superseded_at IS NULL
        ORDER BY f.created_at DESC LIMIT 1`,
    )
      .bind(user.id, workout.sport)
      .first<{ items_json: string; created_at: number; set_by_source_id: string | null }>();
    let currentFocus: { items: string[]; created_at: number; set_by_source_id: string | null } | null = null;
    if (focus) {
      let items: string[] = [];
      try {
        const v = JSON.parse(focus.items_json);
        if (Array.isArray(v)) items = v.filter((x): x is string => typeof x === "string");
      } catch {
        /* ignore malformed */
      }
      currentFocus = { items, created_at: focus.created_at, set_by_source_id: focus.set_by_source_id };
    }
    return json({
      workout: workoutWithSource,
      laps: lapsOut,
      sets,
      calisthenics_stats: calisthenicsStats,
      note: note ?? null,
      eval: evaluation ?? null,
      current_focus: currentFocus,
    });
  }

  // Delete a workout. Removes its summary + laps/notes/route/samples (cascade,
  // see migrations/0013_deleted_workouts.sql) and raw R2 objects, and leaves a
  // tombstone so a future re-send of the same source_id (the athlete's own HAE
  // automation, a Wahoo backfill) is skipped instead of resurrecting it.
  if (pathname === "/api/workout" && req.method === "DELETE") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const body = (await req.json().catch(() => null)) as { reason?: string } | null;
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : null;
    const result = await deleteWorkout(env, user.id, sourceId, reason);
    if (!result) return json({ error: "not_found" }, 404);
    console.log("WORKOUT_DELETED", JSON.stringify({ user: user.email, source_id: sourceId, reason }));
    return json(result);
  }

  // Replace the full set of per-lap equipment tags for a workout.
  if (pathname === "/api/lap-equipment" && req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as
      | { source_id?: string; set?: { lap_num: number; equipment: string }[] }
      | null;
    if (!body?.source_id || !Array.isArray(body.set)) {
      return json({ error: "bad_request", detail: "source_id and set[] required" }, 400);
    }
    const allowed = new Set(["pull_buoy", "front_snorkel"]);
    const clean = body.set.filter(
      (s) => Number.isInteger(s.lap_num) && allowed.has(s.equipment),
    );
    const workout = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, body.source_id)
      .first<{ id: string }>();
    if (!workout) return json({ error: "not_found" }, 404);

    const stmts: D1PreparedStatement[] = [
      env.DB.prepare("DELETE FROM lap_equipment WHERE workout_id = ?").bind(workout.id),
      ...clean.map((s) =>
        env.DB
          .prepare("INSERT INTO lap_equipment (workout_id, lap_num, equipment) VALUES (?, ?, ?)")
          .bind(workout.id, s.lap_num, s.equipment),
      ),
    ];
    await env.DB.batch(stmts);
    return json({ ok: true, count: clean.length });
  }

  // Save (upsert) a workout's note.
  if (pathname === "/api/notes" && req.method === "PUT") {
    const body = (await req.json().catch(() => null)) as
      | { source_id?: string; content_json?: unknown; content_html?: string }
      | null;
    if (!body?.source_id) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const workout = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, body.source_id)
      .first<{ id: string }>();
    if (!workout) return json({ error: "not_found" }, 404);
    const updatedAt = Math.floor(Date.now() / 1000);
    await env.DB.prepare(
      `INSERT INTO notes (workout_id, user_id, content_json, content_html, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(workout_id) DO UPDATE SET
         content_json = excluded.content_json,
         content_html = excluded.content_html,
         updated_at   = excluded.updated_at`,
    )
      .bind(
        workout.id,
        user.id,
        body.content_json != null ? JSON.stringify(body.content_json) : null,
        body.content_html ?? null,
        updatedAt,
      )
      .run();
    return json({ ok: true, updated_at: updatedAt });
  }

  // Athlete-initiated AI evaluation of one workout. Gathers the workout, its
  // laps/notes/profile/focus and a cohort of comparable past sessions, renders
  // one prompt, and makes a single glm-5.2 call — no tool loop (see evaluate.ts).
  // Synchronous: the AI call is a subrequest, not CPU time, so awaiting it
  // doesn't threaten the CPU limit; the client shows a spinner meanwhile.
  //
  // `preview: true` returns the assembled prompt WITHOUT calling the model or
  // writing anything — for inspecting cohort selection cheaply.
  if (pathname === "/api/evaluate" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as
      | { source_id?: string; preview?: boolean; run_model?: boolean }
      | null;
    if (!body?.source_id) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const ctx = await gatherEvalContext(env.DB, user.id, body.source_id);
    if (!ctx) return json({ error: "not_found" }, 404);
    // Dry run: returns the assembled prompt and, when run_model is set, the
    // model's output too — but never persists. Used to inspect cohort selection
    // and eyeball output quality without clobbering a stored evaluation.
    if (body.preview) {
      const { system, user: userPrompt } = renderEvalPrompt(ctx);
      let result: Awaited<ReturnType<typeof runEvaluation>> | null = null;
      if (body.run_model) {
        try {
          result = await runEvaluation(env.AI, ctx);
        } catch (e) {
          return json({ error: "ai_failed", detail: e instanceof Error ? e.message : String(e) }, 502);
        }
      }
      return json({
        preview: true,
        cohort_size: ctx.members.length,
        has_aggregates: ctx.stats != null,
        system,
        user: userPrompt,
        content_md: result?.evaluationMd ?? null,
        next_focus_items: result?.nextFocus ?? null,
      });
    }
    let result: Awaited<ReturnType<typeof runEvaluation>>;
    try {
      result = await runEvaluation(env.AI, ctx);
    } catch (e) {
      return json({ error: "ai_failed", detail: e instanceof Error ? e.message : String(e) }, 502);
    }
    const { updated_at } = await persistEval(
      env.DB,
      user.id,
      ctx.workout.id,
      result.evaluationMd,
      EVAL_MODEL,
    );

    // Auto-write the evolved next-session focus on every generation, including
    // regenerates — so the Focus block always reflects the latest run (its "Set"
    // timestamp refreshes even when the model reproduced the same items, which
    // is the visible signal that regenerating updated it). A no-op skip was
    // tried and removed: because the prompt tells the model to evolve/keep the
    // current focus, it often returns it near-verbatim, and the skip then left
    // the Focus block looking frozen after the first generation.
    let nextFocus:
      | { items: string[]; created_at: number; set_by_source_id: string }
      | null = null;
    if (result.nextFocus.length) {
      const { created_at } = await persistFocus(
        env.DB,
        user.id,
        ctx.workout.sport,
        result.nextFocus,
        ctx.workout.id,
      );
      nextFocus = { items: result.nextFocus, created_at, set_by_source_id: ctx.workout.source_id };
    }

    return json({
      content_md: result.evaluationMd,
      updated_at,
      generated_by: EVAL_MODEL,
      next_focus: nextFocus,
      cohort_size: ctx.members.length,
      has_aggregates: ctx.stats != null,
    });
  }

  if (pathname === "/api/laps" && req.method === "GET") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    // Scope to the user's own workout, then fetch its laps.
    const w = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, sourceId)
      .first<{ id: string }>();
    if (!w) return json({ error: "not_found", detail: "workout not found" }, 404);
    const rows = await env.DB.prepare(
      `SELECT lap_num, start_time, active_sec, rest_after_sec, distance_m, strokes,
              pace_per_50m, pace_per_km, swolf, avg_hr, max_hr, stroke_type, reconstructed
         FROM laps WHERE workout_id = ? ORDER BY lap_num`,
    )
      .bind(w.id)
      .all();
    return json({ source_id: sourceId, count: rows.results?.length ?? 0, laps: rows.results ?? [] });
  }

  // Per-second power/cadence/HR for the power+HR-zone chart. Power/cadence
  // come from the Wahoo FIT; HR is merged in from the Apple Watch echo at
  // ingest time (see store.ts's migrateCyclingSamples) — both already land
  // under this workout's own id, so a plain lookup by source_id is enough,
  // no join needed here (contrast /api/workout's echo join for the summary
  // avg_hr/max_hr columns, which aren't touched by that migration).
  if (pathname === "/api/cycling-samples" && req.method === "GET") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const w = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, sourceId)
      .first<{ id: string }>();
    if (!w) return json({ error: "not_found", detail: "workout not found" }, 404);
    const rows = await env.DB.prepare(
      "SELECT t, power_w, cadence_rpm, hr FROM cycling_samples WHERE workout_id = ? ORDER BY t",
    )
      .bind(w.id)
      .all();
    return json({ source_id: sourceId, count: rows.results?.length ?? 0, samples: rows.results ?? [] });
  }

  // Per-second HR for swim's heart-rate-zones chart — same shape contract as
  // /api/cycling-samples's `samples` (array of { t, hr, ... }) so the client
  // can feed both into the same HeartZones component.
  if (pathname === "/api/swim-hr-samples" && req.method === "GET") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const w = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, sourceId)
      .first<{ id: string }>();
    if (!w) return json({ error: "not_found", detail: "workout not found" }, 404);
    const rows = await env.DB.prepare(
      "SELECT t, hr FROM swim_hr_samples WHERE workout_id = ? ORDER BY t",
    )
      .bind(w.id)
      .all();
    return json({ source_id: sourceId, count: rows.results?.length ?? 0, samples: rows.results ?? [] });
  }

  // Per-interval cadence for running's cadence chart — same shape contract as
  // the other samples endpoints (array of { t, ... }), see
  // store.ts's writeHaeRunningCadenceSamples / parse.ts's
  // extractHaeStepCountSamples for how these are derived.
  if (pathname === "/api/running-cadence-samples" && req.method === "GET") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const w = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, sourceId)
      .first<{ id: string }>();
    if (!w) return json({ error: "not_found", detail: "workout not found" }, 404);
    const rows = await env.DB.prepare(
      "SELECT t, cadence_spm FROM running_cadence_samples WHERE workout_id = ? ORDER BY t",
    )
      .bind(w.id)
      .all();
    return json({ source_id: sourceId, count: rows.results?.length ?? 0, samples: rows.results ?? [] });
  }

  // Per-~5s HR for running's heart-rate chart — sits alongside cadence with
  // cross-chart hover sync, see detail.client.js's "running" sync group.
  if (pathname === "/api/running-hr-samples" && req.method === "GET") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const w = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, sourceId)
      .first<{ id: string }>();
    if (!w) return json({ error: "not_found", detail: "workout not found" }, 404);
    const rows = await env.DB.prepare(
      "SELECT t, hr FROM running_hr_samples WHERE workout_id = ? ORDER BY t",
    )
      .bind(w.id)
      .all();
    return json({ source_id: sourceId, count: rows.results?.length ?? 0, samples: rows.results ?? [] });
  }

  // Per-~5s HR for tennis's heart-rate-zones + line chart — same shape
  // contract as /api/swim-hr-samples.
  if (pathname === "/api/tennis-hr-samples" && req.method === "GET") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const w = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, sourceId)
      .first<{ id: string }>();
    if (!w) return json({ error: "not_found", detail: "workout not found" }, 404);
    const rows = await env.DB.prepare(
      "SELECT t, hr FROM tennis_hr_samples WHERE workout_id = ? ORDER BY t",
    )
      .bind(w.id)
      .all();
    return json({ source_id: sourceId, count: rows.results?.length ?? 0, samples: rows.results ?? [] });
  }

  // GPS track for a workout's map (cycling/running). Thinned for display and
  // returned with precomputed bounds so the client can fit the view without a
  // second pass. Empty `points` for indoor/no-GPS sessions — the map just
  // doesn't render.
  if (pathname === "/api/route" && req.method === "GET") {
    const sourceId = url.searchParams.get("source_id");
    if (!sourceId) return json({ error: "bad_request", detail: "source_id required" }, 400);
    const w = await env.DB.prepare(
      "SELECT id FROM workouts WHERE user_id = ? AND source_id = ?",
    )
      .bind(user.id, sourceId)
      .first<{ id: string }>();
    if (!w) return json({ error: "not_found", detail: "workout not found" }, 404);
    const rows = await env.DB.prepare(
      "SELECT lat, lon, elevation_m FROM route_points WHERE workout_id = ? ORDER BY seq",
    )
      .bind(w.id)
      .all<{ lat: number; lon: number; elevation_m: number | null }>();
    const full = rows.results ?? [];
    // Compact [lat, lon, elevation?] tuples keep the payload small; bounds are
    // computed over the full track before thinning so the view is exact.
    let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
    for (const p of full) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    const bounds = full.length
      ? { min: [minLat, minLon], max: [maxLat, maxLon] }
      : null;
    const points = thinTuples(
      full.map((p) => [p.lat, p.lon, p.elevation_m] as [number, number, number | null]),
      DISPLAY_MAX_ROUTE_POINTS,
    );
    return json({ source_id: sourceId, count: points.length, total: full.length, bounds, points });
  }

  return json({ error: "not found", path: pathname }, 404);
}

// Display cap for the map polyline — far below the stored cap; the eye can't
// resolve more on a small map and it keeps the JSON light. Fixed-stride thin,
// always keeping first and last so start/end markers stay exact.
const DISPLAY_MAX_ROUTE_POINTS = 1200;

function thinTuples<T>(pts: T[], max: number): T[] {
  if (pts.length <= max) return pts;
  const stride = Math.ceil(pts.length / max);
  const out: T[] = [];
  for (let i = 0; i < pts.length; i += stride) out.push(pts[i]);
  const last = pts[pts.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

async function handleIngest(req: Request, env: Env): Promise<Response> {
  const token = bearerToken(req);
  if (!token) {
    return json({ error: "unauthorized", detail: "missing bearer token" }, 401);
  }
  const user = await getUserByIngestToken(env.DB, token);
  if (!user) {
    // Don't leak whether the token format was right — just reject.
    return json({ error: "unauthorized", detail: "unknown ingest token" }, 401);
  }

  const receivedAt = new Date().toISOString();
  const raw = await req.text();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return json({ error: "bad_request", detail: `invalid JSON: ${(e as Error).message}` }, 400);
  }

  // Keep the last raw payload in KV for quick eyeball / debugging. Splice the
  // already-parsed `raw` text straight in rather than re-serializing `parsed`
  // (JSON.stringify with pretty-printing is a second full traversal + a
  // second in-memory copy) — for a historical HAE backfill (many workouts,
  // per-second arrays) that duplicate work is enough on its own to trip
  // Cloudflare's CPU/memory resource limit (error 1102).
  //
  // Strictly a debug convenience: R2 is the archive of record (storeWorkouts
  // writes each workout's raw JSON there), so a failure here must never cost us
  // the actual ingest. A big HAE backfill can exceed KV's 25 MiB per-value cap;
  // when it does, store the meta alone so /api/last says why it's missing.
  await putLastPayload(env.LAST_PAYLOAD, user, raw, receivedAt);

  let result;
  try {
    result = await storeWorkouts(env, user, parsed);
  } catch (e) {
    if (e instanceof ParseError) {
      return json({ error: "bad_request", detail: e.message }, 400);
    }
    throw e;
  }

  console.log(
    "INGEST",
    JSON.stringify({
      receivedAt,
      user: user.email,
      bytes: raw.length,
      count: result.count,
      inserted: result.inserted.length,
      updated: result.updated.length,
      skipped_deleted: result.skipped_deleted.length,
      superseded: result.superseded,
      dropped_wahoo_echoes: result.dropped_wahoo_echoes.length,
      errors: result.errors.length,
    }),
  );

  return json({ ok: true, ...result });
}

/**
 * GET /wahoo/oauth/callback — one-time redirect target after the athlete
 * authorizes the app on Wahoo's site. Wahoo appends `?code=...&state=...` on
 * success, or `?error=...` if the athlete declines.
 *
 * `state` was minted and stashed (→ user_id, 10 min TTL) by
 * `/api/wahoo/authorize` on the APP host. Consuming it here is both the CSRF
 * guard and how we know *which* athlete just authorized, since Wahoo's
 * redirect can't carry an Access session onto this un-gated host.
 */
async function handleWahooOAuthCallback(req: Request, env: Env, url: URL): Promise<Response> {
  const error = url.searchParams.get("error");
  if (error) {
    return json({ error: "wahoo_authorization_denied", detail: error }, 400);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return json({ error: "bad_request", detail: "missing code or state" }, 400);
  }

  if (!isWahooConfigured(env)) {
    return json({ error: "wahoo_not_configured" }, 501);
  }

  const userId = await env.LAST_PAYLOAD.get(wahooStateKey(state));
  if (!userId) {
    return json({ error: "bad_request", detail: "unknown or expired state" }, 400);
  }
  await env.LAST_PAYLOAD.delete(wahooStateKey(state)); // single-use

  const redirectUri = `https://${env.INGEST_HOST}/wahoo/oauth/callback`;
  // Wrapped: any failure here (bad token response, transient network error,
  // unexpected D1 error) previously surfaced as an uncaught exception —
  // Cloudflare's generic "Error 1101" page with the real cause swallowed.
  // Catch it and return the actual message instead.
  try {
    const tokens = await exchangeCode(env, code, redirectUri);
    const wahooUser = await fetchWahooUser(tokens.access_token);
    await saveWahooTokens(env.DB, userId, wahooUser.id, tokens);

    console.log("WAHOO_OAUTH_LINKED", JSON.stringify({ userId, wahooUserId: wahooUser.id }));
    return htmlResponse(
      `<!doctype html><meta charset="utf-8"><title>Wahoo linked</title>` +
        `<p>Wahoo account linked. You can close this tab.</p>`,
    );
  } catch (e) {
    console.log("WAHOO_OAUTH_CALLBACK_ERROR", JSON.stringify({ userId, error: (e as Error).message }));
    return json({ error: "wahoo_oauth_failed", detail: (e as Error).message }, 502);
  }
}

/**
 * POST /wahoo/webhook — Wahoo's per-event notification (workout created,
 * updated, etc). Wahoo is configured with a shared WAHOO_WEBHOOK_TOKEN at
 * subscription time and echoes it as a JSON body field (not a header) on
 * every event; we check it before trusting the payload.
 *
 * Wahoo's dashboard also uses this endpoint to validate the webhook URL
 * (a lightweight probe) before saving the subscription, so GET must return
 * 2xx rather than 404/401 — hence the permissive GET handling below.
 *
 * Only `workout_summary` events are handled (needs the `offline_data` scope,
 * which the app has). On one, we resolve the athlete from `user.id`, pull the
 * FIT download URL via the Cloud API, and archive the raw bytes to R2 —
 * mirroring the raw-first pattern `storeWorkouts` uses for HAE (see store.ts).
 * FIT → D1 summary/lap parsing isn't wired yet (no FIT parser exists in this
 * codebase yet); the archived file is enough to backfill once one does.
 */
async function handleWahooWebhook(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") {
    // Dashboard/validation probe — just confirm the endpoint is alive.
    return json({ ok: true });
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  const raw = await req.text();
  let payload: any;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (e) {
    return json({ error: "bad_request", detail: `invalid JSON: ${(e as Error).message}` }, 400);
  }

  if (!payload || payload.webhook_token !== env.WAHOO_WEBHOOK_TOKEN) {
    return json({ error: "unauthorized", detail: "bad webhook_token" }, 401);
  }

  const receivedAt = new Date().toISOString();
  console.log(
    "WAHOO_WEBHOOK",
    JSON.stringify({ receivedAt, event_type: payload.event_type, wahoo_user_id: payload.user?.id }),
  );

  if (payload.event_type !== "workout_summary") {
    return json({ ok: true, skipped: payload.event_type });
  }

  const wahooUserId = payload.user?.id;
  if (wahooUserId === undefined) {
    return json({ ok: true, skipped: "missing user.id" });
  }
  const userId = await getUserIdByWahooUserId(env.DB, wahooUserId);
  if (!userId) {
    // Event for a Wahoo account we haven't linked (or a stale subscription).
    console.log("WAHOO_WEBHOOK_UNKNOWN_USER", JSON.stringify({ wahooUserId }));
    return json({ ok: true, skipped: "unknown wahoo user" });
  }

  // Field nesting per Wahoo's docs: workout_summary.workout.id. Fall back to
  // a couple of plausible alternates rather than hard-failing on drift.
  const workoutId =
    payload.workout_summary?.workout?.id ?? payload.workout?.id ?? payload.workout_summary?.id;
  if (workoutId === undefined) {
    console.log("WAHOO_WEBHOOK_NO_WORKOUT_ID", JSON.stringify(payload));
    return json({ ok: true, skipped: "no workout id in payload" });
  }

  if (!isWahooConfigured(env)) {
    return json({ error: "wahoo_not_configured" }, 501);
  }

  // Wrapped: same reasoning as the OAuth callback — token refresh, the Wahoo
  // API call, the FIT download, and the R2 writes can all fail, and an
  // uncaught throw here would've surfaced as a bare 1101 with the cause
  // swallowed. A clean non-2xx also matters more here than in the callback:
  // Wahoo retries failed webhook deliveries (30m/4h/24h/72h), so a real
  // error status is what gets us a free retry instead of silently dropping
  // the ride.
  try {
    const accessToken = await getValidAccessToken(env.DB, env, userId);
    if (!accessToken) {
      console.log("WAHOO_WEBHOOK_NOT_LINKED", JSON.stringify({ userId, workoutId }));
      return json({ ok: true, skipped: "no stored Wahoo token for user" });
    }

    const workout = await fetchWorkout(accessToken, workoutId);
    const fileUrl = workout.workout_summary?.file?.url;
    if (!fileUrl) {
      console.log("WAHOO_WEBHOOK_NO_FILE_URL", JSON.stringify({ userId, workoutId }));
      return json({ ok: true, skipped: "no FIT file url yet (Wahoo may still be processing)" });
    }

    const fit = await downloadFit(fileUrl);
    const key = `raw/wahoo/${userId}/${workoutId}.fit`;
    await env.RAW.put(key, fit);
    await env.RAW.put(
      `raw/wahoo/${userId}/${workoutId}.meta.json`,
      JSON.stringify({ receivedAt, userId, wahooWorkoutId: workoutId, bytes: fit.byteLength }, null, 2),
    );
    console.log("WAHOO_FIT_ARCHIVED", JSON.stringify({ userId, workoutId, bytes: fit.byteLength, key }));

    // `wahoo:` prefix keeps this distinct from HAE's HealthKit UUID source_ids
    // for the same athlete. It does NOT make it globally unique: Wahoo resolves
    // workout ids against the authenticated user's token and guarantees no
    // cross-account uniqueness, so two athletes could in principle both own
    // `wahoo:56519`. Dedup is keyed on (user_id, source_id) — see
    // migrations/0022_user_scoped_dedup.sql.
    const sourceId = `wahoo:${workoutId}`;
    const { summary, laps, route, samples } = parseFitWorkout(sourceId, fit);
    const stored = await storeFitWorkout(env, userId, summary, laps, route, samples, key, FIT_PARSER_VERSION);
    if (!stored) {
      // Athlete deleted this workout — see migrations/0013_deleted_workouts.sql.
      // The raw FIT above is (harmlessly) re-archived, but skip resurrecting the
      // D1 row so a repeated webhook delivery or Wahoo backfill can't bring it back.
      console.log("WAHOO_WORKOUT_SKIPPED_DELETED", JSON.stringify({ userId, wahooWorkoutId: workoutId, sourceId }));
      return json({ ok: true, archived: key, bytes: fit.byteLength, wahooWorkoutId: workoutId, skipped: "deleted" });
    }

    console.log("WAHOO_WORKOUT_STORED", JSON.stringify({ userId, wahooWorkoutId: workoutId, ...stored }));
    return json({ ok: true, archived: key, bytes: fit.byteLength, wahooWorkoutId: workoutId, ...stored });
  } catch (e) {
    console.log("WAHOO_WEBHOOK_ERROR", JSON.stringify({ userId, workoutId, error: (e as Error).message }));
    return json({ error: "wahoo_webhook_failed", detail: (e as Error).message }, 502);
  }
}

function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    has_ingest_token: user.ingest_token_hash !== null,
    created_at: user.created_at,
    token_rotated_at: user.token_rotated_at,
  };
}

function htmlResponse(html: string): Response {
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// Pinned ESM dependency graph for the buildless React front end. Import-map keeps
// a single React instance across htm, Phosphor icons and Tiptap (?external=react
// leaves their `react` specifier bare so it resolves here).
const GLOW_WEBM: Record<string, string> = {"illuminate": "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKfEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEvTbuMU6uEHFO7a1OsggKJ7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAj0AAAAAAABZUrmvUrgEAAAAAAABL14EBc8WIDj6E6pAmKkWcgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QHc1lA4JywgUC6gUCagQJVsJBVuoEQVbGBCVW7gQlVuYECElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjEuMTAwc3PZY8CLY8WIDj6E6pAmKkVnyKRFo4dFTkNPREVSRIeXTGF2YzYxLjMuMTAwIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QNHngQCjuYEAAICSSYNCWAH4AfsEHBIODCkAABhgAAAkc//+VPBRvvgxWIADvPP//0e81cO7m6f/+T19bVQwAKOTgQB9AJYAQJKcEEnAAAMgAABUcKOTgQD6AJYAQJKcEEsgAAMgAABUcKOTgQF3AJYAQJKcEEpAAAMgAABUcKOTgQH0AJYAQJKcEElAAAMgAABUcKOTgQJxAJYAQJKcEEggAAMgAABUcKOTgQLuAJYAQJKcEEegAAMgAABUcKOTgQNrAJYAQJKcEEcAAAMgAABUcBxTu2uRu4+zgQC3iveBAfGCAbLwgQM=", "sonar": "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKdEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEvTbuMU6uEHFO7a1OsggKH7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAj0AAAAAAABZUrmvUrgEAAAAAAABL14EBc8WIAK5MCZzp04ScgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QHc1lA4JywgUC6gUCagQJVsJBVuoEQVbGBCVW7gQlVuYECElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjEuMTAwc3PZY8CLY8WIAK5MCZzp04RnyKRFo4dFTkNPREVSRIeXTGF2YzYxLjMuMTAwIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QM/ngQCjt4EAAICSSYNCWAH4AfsEHBIODCkAABhgAAAlzf/8OOHRzfhiZEjNSrX///7dSJWDHz+h7ycSGACjk4EAfQCWAECSnBBJwAADIAAAVHCjk4EA+gCWAECSnBBLIAADIAAAVHCjk4EBdwCWAECSnBBKQAADIAAAVHCjk4EB9ACWAECSnBBJQAADIAAAVHCjk4ECcQCWAECSnBBIIAADIAAAVHCjk4EC7gCWAECSnBBHoAADIAAAVHCjk4EDawCWAECSnBBHAAADIAAAVHAcU7trkbuPs4EAt4r3gQHxggGy8IED", "ember": "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKnEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEvTbuMU6uEHFO7a1OsggKR7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAj0AAAAAAABZUrmvUrgEAAAAAAABL14EBc8WIBWdTDIbPmEicgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QHc1lA4JywgUC6gUCagQJVsJBVuoEQVbGBCVW7gQlVuYECElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjEuMTAwc3PZY8CLY8WIBWdTDIbPmEhnyKRFo4dFTkNPREVSRIeXTGF2YzYxLjMuMTAwIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QNnngQCjwYEAAICSSYNCWAH4AfsEHBIODCkAABhgAAAkc//80qV6mozm6/nqvlnh0dJgXDQIHt////5wllf///44ABp0LHYAo5OBAH0AlgBAkpwQScAAAyAAAFRwo5OBAPoAlgBAkpwQSyAAAyAAAFRwo5OBAXcAlgBAkpwQSkAAAyAAAFRwo5OBAfQAlgBAkpwQSUAAAyAAAFRwo5OBAnEAlgBAkpwQSCAAAyAAAFRwo5OBAu4AlgBAkpwQR6AAAyAAAFRwo5OBA2sAlgBAkpwQRwAAAyAAAFRwHFO7a5G7j7OBALeK94EB8YIBsvCBAw==", "neon": "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAKbEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEvTbuMU6uEHFO7a1OsggKF7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuMS4xMDBXQYxMYXZmNjEuMS4xMDBEiYhAj0AAAAAAABZUrmvUrgEAAAAAAABL14EBc8WIzIaKCAkq40+cgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QHc1lA4JywgUC6gUCagQJVsJBVuoEQVbGBCVW7gQlVuYECElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjEuMTAwc3PZY8CLY8WIzIaKCAkq409nyKRFo4dFTkNPREVSRIeXTGF2YzYxLjMuMTAwIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1QM3ngQCjtYEAAICSSYNCWAH4AfsEHBIODCkAABhgAAAkc/5A1o07zNUAIQP///7tKanEr///6AzJY+AAo5OBAH0AlgBAkpwQScAAAyAAAFRwo5OBAPoAlgBAkpwQSyAAAyAAAFRwo5OBAXcAlgBAkpwQSkAAAyAAAFRwo5OBAfQAlgBAkpwQSUAAAyAAAFRwo5OBAnEAlgBAkpwQSCAAAyAAAFRwo5OBAu4AlgBAkpwQR6AAAyAAAFRwo5OBA2sAlgBAkpwQRwAAAyAAAFRwHFO7a5G7j7OBALeK94EB8YIBsvCBAw=="};

const GLOW_VER: Record<string, string> = {"illuminate": "e27d0be3", "sonar": "01401df2", "ember": "6fc1cb0a", "neon": "c7b65c6b"};

const IMPORTMAP = JSON.stringify({
  imports: {
    react: "https://esm.sh/react@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client",
    "react/jsx-runtime": "https://esm.sh/react@18.3.1/jsx-runtime",
    "htm/react": "https://esm.sh/htm@3.1.1/react?external=react",
    "@phosphor-icons/react": "https://esm.sh/@phosphor-icons/react@2.1.7?external=react",
    "@tiptap/core": "https://esm.sh/@tiptap/core@2.10.0",
    "@tiptap/starter-kit": "https://esm.sh/@tiptap/starter-kit@2.10.0",
  },
});

// MapLibre GL is loaded as its UMD build via a classic <script> (→ window.maplibregl),
// not through the importmap. Its bundled tile-parsing web worker breaks when the
// library is served as an esm.sh module (worker + main thread get mismatched
// copies → "reading 'get'" crashes); the official UMD bundle ships a working
// worker. The classic script runs before the deferred module, so the global is
// ready by the time detail.client.js executes. Only on the detail page shell.
const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js";
const MAPLIBRE_CSS = "https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css";

// Highcharts for the interactive power/cadence/stroke-drift charts (tooltips,
// labeled axes, zoom) — same UMD-via-classic-script pattern as MapLibre above,
// so it's a plain `window.Highcharts` global by the time detail.client.js runs.
const HIGHCHARTS_JS = "https://code.highcharts.com/highcharts.js";

const FONTS =
  "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Hanken+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap";

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

// Full HTML shell shared by both pages. `boot` is page data injected as JSON;
// `client` is the inlined React module for the page.
function page(title: string, boot: unknown, client: string, headExtra = ""): string {
  const bootJson = JSON.stringify(boot).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg width='64' height='64' viewBox='0 0 64 64' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='64' y2='64' gradientUnits='userSpaceOnUse'%3E%3Cstop stop-color='%232fe0c0'/%3E%3Cstop offset='1' stop-color='%2314b89c'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='14' fill='url(%23g)'/%3E%3Cg transform='translate(9.6,10.65) scale(0.175)' fill='%2304211b'%3E%3Cpath d='M60,96v64a12,12,0,0,1-24,0V96a12,12,0,0,1,24,0ZM88,20A12,12,0,0,0,76,32V224a12,12,0,0,0,24,0V32A12,12,0,0,0,88,20Zm40,32a12,12,0,0,0-12,12V192a12,12,0,0,0,24,0V64A12,12,0,0,0,128,52Zm40,32a12,12,0,0,0-12,12v64a12,12,0,0,0,24,0V96A12,12,0,0,0,168,84Zm40-16a12,12,0,0,0-12,12v96a12,12,0,0,0,24,0V80A12,12,0,0,0,208,68Z'/%3E%3C/g%3E%3C/svg%3E" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-title" content="TrAIner" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="${FONTS}" />
${headExtra}
<script type="importmap">${IMPORTMAP}</script>
<script>window.__GLOW_VER=${JSON.stringify(GLOW_VER)};(function(){try{var t=localStorage.getItem("trainer.theme");if(t&&t!=="illuminate")document.documentElement.dataset.theme=t;}catch(e){}})();</script>
<style>${UI_CSS}</style>
</head>
<body>
<div class="glow" aria-hidden="true"></div>
<div id="root"></div>
<svg width="0" height="0" aria-hidden="true" style="position:absolute"><defs>
<linearGradient id="sportGrad" gradientUnits="userSpaceOnUse" x1="40" y1="32" x2="216" y2="224">
<stop offset="0" stop-color="#afffa9"/><stop offset="1" stop-color="#3fdcc9"/>
</linearGradient></defs></svg>
<script id="bootstrap" type="application/json">${bootJson}</script>
<script type="module">${client}</script>
</body>
</html>`;
}

function renderHome(user: User): string {
  return page("TrAIner — Logbook", {
    name: user.display_name || user.email,
  }, HOME_CLIENT);
}

function renderDetail(sourceId: string): string {
  return page(
    "Workout — TrAIner",
    { sourceId },
    DETAIL_CLIENT,
    `<link rel="stylesheet" href="${MAPLIBRE_CSS}" /><script src="${MAPLIBRE_JS}"></script><script src="${HIGHCHARTS_JS}"></script>`,
  );
}

function renderCalisthenics(): string {
  return page("Log — TrAIner", {}, CALISTHENICS_CLIENT);
}

function renderSettings(user: User, ingestHost: string, mcpHost: string, profileMd: string): string {
  return page("Settings — TrAIner", {
    ingestUrl: `https://${ingestHost}/ingest`,
    mcpUrl: `https://${mcpHost}/mcp`,
    hasToken: user.ingest_token_hash !== null,
    profileMd,
  }, SETTINGS_CLIENT);
}
