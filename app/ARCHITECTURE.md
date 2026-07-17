# Architecture

End-to-end pipeline for ingesting workout data from Apple Health (via Health Auto Export), storing it on Cloudflare infrastructure, and exposing it to Claude for analysis.

Assumes Health Auto Export **Premium Lifetime** is purchased — the REST API automation is the linchpin and is Premium-only.

## Goals

1. **Zero manual friction per workout.** Swim ends → data lands in D1 without the athlete touching anything.
2. **Raw-first storage.** Original exports preserved forever; derived metrics are recomputable.
3. **Claude-native access.** Analysis happens via an MCP server, not a custom UI. Browser viz is optional and comes later.
4. **Small multi-user scale.** A handful of athletes, ~10–20 workouts/week each, multi-year retention. Cloudflare free/cheap tiers comfortably cover this. Per-user isolation matters (each user sees only their own data) but org/role machinery does not.

## High-level flow

```
┌─────────────────────┐
│  Apple Watch        │  workout ends
│  (swim, ride, ...)  │
└──────────┬──────────┘
           │ syncs to iPhone Health
           ▼
┌─────────────────────┐
│  iPhone Health      │
│  (HealthKit)        │
└──────────┬──────────┘
           │ background read (requires unlock)
           ▼
┌─────────────────────┐
│  Health Auto Export │  Premium REST automation
│  (HAE Premium)      │
└──────────┬──────────┘
           │ HTTPS POST (JSON)
           ▼
┌─────────────────────┐
│  Cloudflare Worker  │  /ingest
│  (TypeScript)       │  - auth (shared secret)
│                     │  - dedup
│                     │  - store raw to R2
│                     │  - parse → D1
└──────┬──────────────┘
       │              ┌────────────────┐
       ├─────────────►│  R2 bucket     │  raw JSON
       │              │  /raw/{id}.json│  audit trail
       │              └────────────────┘
       │
       ▼
┌─────────────────────┐
│  D1 database        │  structured, query-fast
│  workouts/laps/hr   │
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  MCP server         │  exposes semantic queries
│  (TypeScript)       │  to Claude
└──────────┬──────────┘
           │
           ▼
┌─────────────────────┐
│  Claude (chat,      │
│  Claude Code, etc.) │
└─────────────────────┘
```

## Components

### Health Auto Export (iPhone, Premium)

Configured to:
- Watch HealthKit for new workouts of type `Swimming`, `Cycling`, etc. (filterable).
- Export JSON at **per-second granularity** (per-minute is too coarse for swim-lap reconstruction).
- POST to the Worker's `/ingest` endpoint with a shared-secret bearer token in the `Authorization` header.

Operational notes:
- Background uploads only run while the iPhone is unlocked (HealthKit privacy guarantee — health data is encrypted while locked).
- Subject to iOS Background App Refresh throttling. Opening HAE once a week keeps it generous with background slots.
- HAE handles its own retry on transient failure. If the Worker is down, HAE will retry next opportunity. (Verify exact retry behavior — probably backoff + retry on next unlock.)

### Ingest Worker (`/ingest`)

Cloudflare Worker, TypeScript. Single endpoint, ~150 lines.

Responsibilities:
1. Authenticate the request (per-user bearer token; hash → `users` lookup). Multi-user — the token resolves which athlete owns the payload.
2. Use each workout's `id` (the HealthKit workout UUID, present in the v2 export) directly as `source_id`. HealthKit samples are immutable, so the UUID is stable across re-exports — no need to hash start/type/duration. A single POST carries `data.workouts[]` (a backfill = many workouts in one request), so iterate the array and dedup per-workout.
3. Store each raw workout to R2 at `raw/{source_id}.json` (+ `raw/{source_id}.meta.json`).
4. Parse the payload, compute derived metrics, write to D1.
5. Use `INSERT ... ON CONFLICT(user_id, source_id) DO UPDATE` so re-ingestion is idempotent — important when reprocessing after a parser bug fix, and what makes overlapping HAE backfills safe.
6. Return `200` quickly; do heavy work async if needed. HAE shouldn't be kept waiting.

> **Status (built):** auth, R2 raw-first archive, D1 `workouts` summary upsert, and **swim lap reconstruction** (src/laps.ts, with tests + a real-swim fixture; writes the `laps` table on ingest, idempotent) are implemented and verified end-to-end against a real 4-workout, 3-sport batch. A workouts UI is live, including a per-workout detail page with a Tiptap rich-text **notes** editor and **structured per-lap equipment tagging** (pull buoy / front snorkel) — both stored in their own tables (`notes`, `lap_equipment`) so re-ingest never clobbers athlete-authored data. Two hosts, one worker: `training-ingest.yourdomain.com` (webhook) and `training.yourdomain.com` (UI/API behind Cloudflare Access). Still TODO: `hr_samples` / `hr_recovery` ingestion and the MCP server (which should consume the equipment tags + notes alongside the derived metrics).

Additional endpoints to plan for:
- `POST /backfill` — manually trigger re-parse of an R2 object into D1 (for when the parser improves).
- `POST /ingest/replay` — re-run the parser across all R2 objects (for big algorithm changes).
- `GET /health` — basic liveness check.

### R2 (raw archive)

Object storage, one file per workout. Cheap ($0.015/GB/month), no egress fees within Cloudflare.

Layout:
```
raw/
  {source_id}.json              # original HAE payload
  {source_id}.meta.json         # ingest metadata: timestamps, parser version
```

Why this matters: when the parser improves (better lap reconstruction, new derived metric), re-running it across the R2 archive regenerates D1 without re-collecting data. The raw payload is the source of truth; D1 is a derived cache.

### D1 (structured store)

SQLite-compatible, ~10 GB free tier, plenty for personal use.

The `users` table (see `migrations/0001_users.sql`) is the root of the multi-user model; every workout is scoped to a `user_id`. `source_id` dedup is **per user** — two athletes can independently upload, so the dedup key is `(user_id, source_id)`, not `source_id` alone (see `migrations/0022_user_scoped_dedup.sql`). `workouts` additionally carries a legacy global `UNIQUE` on `source_id` from `0002_workouts.sql`; it is stricter than the dedup key and is documented under Design notes below.

```sql
-- Athletes (see migrations/0001_users.sql for the authoritative definition)
CREATE TABLE users (
  id                TEXT PRIMARY KEY,
  email             TEXT UNIQUE NOT NULL,       -- Cloudflare Access identity
  ingest_token_hash TEXT UNIQUE,                -- SHA-256 of the per-user webhook token
  created_at        INTEGER NOT NULL,
  token_rotated_at  INTEGER
);

-- Sessions
CREATE TABLE workouts (
  id              TEXT PRIMARY KEY,           -- generated UUID
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_id       TEXT UNIQUE NOT NULL,       -- HAE HealthKit UUID or `wahoo:{id}`; dedup key is (user_id, source_id) — the column UNIQUE is a stricter legacy constraint, see Design notes
  start_time      INTEGER NOT NULL,           -- unix epoch seconds, UTC
  end_time        INTEGER NOT NULL,
  timezone        TEXT,                       -- e.g. 'Asia/Singapore'
  sport           TEXT NOT NULL,              -- 'swimming', 'cycling', ...
  sub_type        TEXT,                       -- 'pool', 'open_water', 'road', ...
  duration_sec    INTEGER,                    -- total elapsed (incl. rest)
  active_sec      INTEGER,                    -- swim/ride time only
  distance_m      REAL,
  pool_length_m   REAL,                       -- swim only
  avg_hr          REAL,
  max_hr          INTEGER,
  total_strokes   INTEGER,                    -- swim only
  active_calories REAL,
  total_calories  REAL,
  temperature_c   REAL,                       -- conditions if recorded
  humidity_pct    REAL,
  raw_r2_key      TEXT NOT NULL,              -- pointer to raw JSON
  parser_version  TEXT NOT NULL,              -- so we know what to re-run
  ingested_at     INTEGER NOT NULL
);

-- Reconstructed laps (swim) or auto-laps (cycling)
CREATE TABLE laps (
  workout_id      TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  lap_num         INTEGER NOT NULL,
  start_time      INTEGER NOT NULL,
  active_sec      REAL NOT NULL,              -- swim time only, gaps excluded
  rest_after_sec  REAL,                       -- gap to next lap
  distance_m      REAL,
  strokes         REAL,                       -- swim only
  pace_per_50m    REAL,                       -- derived, swim
  pace_per_km     REAL,                       -- derived, cycling/running
  swolf           REAL,                       -- derived, swim
  avg_hr          REAL,
  max_hr          INTEGER,
  stroke_type     TEXT,                       -- 'freestyle', 'unknown', 'corrected:freestyle'
  reconstructed   INTEGER NOT NULL DEFAULT 0, -- 1 = inferred, 0 = native
  PRIMARY KEY (workout_id, lap_num)
);

-- HR time series
CREATE TABLE hr_samples (
  workout_id      TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  ts              INTEGER NOT NULL,           -- unix epoch
  bpm             INTEGER NOT NULL,
  PRIMARY KEY (workout_id, ts)
);

-- Post-workout HR for recovery tracking
CREATE TABLE hr_recovery (
  workout_id      TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  seconds_after   INTEGER NOT NULL,           -- 0, 30, 60, 120, ...
  bpm             INTEGER NOT NULL,
  PRIMARY KEY (workout_id, seconds_after)
);

-- GPS route track for outdoor cycling/running (see migrations/0010_route_points.sql)
CREATE TABLE route_points (
  workout_id      TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,           -- 0-based order along the track
  ts              INTEGER,                    -- unix epoch seconds, UTC (nullable)
  lat             REAL NOT NULL,              -- WGS84 degrees
  lon             REAL NOT NULL,              -- WGS84 degrees
  elevation_m     REAL,                       -- meters, if recorded
  PRIMARY KEY (workout_id, seq)
);

CREATE UNIQUE INDEX idx_workouts_user_source ON workouts(user_id, source_id);
CREATE INDEX idx_workouts_user_start ON workouts(user_id, start_time);
CREATE INDEX idx_workouts_user_sport_start ON workouts(user_id, sport, start_time);
```

Design notes:
- `(user_id, source_id)` is the dedup key; `id` is the local UUID. `source_id` alone isn't a safe key because two athletes' uploads are independent: HAE ids are HealthKit UUIDs (genuinely globally unique), but the `wahoo:{workout_id}` scheme (`src/index.ts`) is not — Wahoo resolves `GET /v1/workouts/:id` against the authenticated user's token and guarantees no cross-account uniqueness, and the ids are small integers. If they are per-account sequential, two athletes collide immediately rather than rarely, since both would own workout #1, #2, #3. Idempotent ingest is therefore `INSERT ... ON CONFLICT(user_id, source_id) DO UPDATE`, enforced by `idx_workouts_user_source` and by `deleted_workouts`' composite primary key.
- **Known residual:** `workouts.source_id` still carries `0002`'s global `UNIQUE`, so two athletes cannot yet *hold* the same `source_id` — the second one's ingest fails loudly instead. This is deliberate. Dropping a column constraint in SQLite requires a table rebuild, and `workouts` is the parent of 12 `ON DELETE CASCADE` children plus two `ON DELETE SET NULL` references (`session_focus.set_by_workout_id`, its own `superseded_by`), so `DROP TABLE workouts` deletes every child row. Verified against a local D1: a naive create/copy/drop/rename wiped `notes` (4 → 0), `session_evals` (9 → 0) and `laps` (93 → 0), and `PRAGMA foreign_keys = OFF` in a migration file does not prevent it (D1 also documents that `defer_foreign_keys` does not suppress `CASCADE`). Most children are R2-rebuildable, but `notes` and `session_evals` are athlete/Claude-authored and exist nowhere else. The global `UNIQUE` is strictly stricter than the dedup key — it can only reject a write, never corrupt one — so keeping it costs nothing until a second athlete with a linked Wahoo account actually appears. Lifting it is its own migration: stage every child table, rebuild, restore, and re-verify row counts.
- Every query is scoped by `user_id`, and `ON DELETE CASCADE` from `users` means deleting an athlete cleans up all their workouts, laps, and HR samples.
- `parser_version` is critical for the "reprocess everything" workflow. Bump it when the parser changes; you can then `SELECT * FROM workouts WHERE parser_version != 'current'` to find stale rows.
- `reconstructed` flag on laps distinguishes inferred boundaries from native ones (cycling FIT files give native laps; HAE swim JSON does not).
- `route_points` is derived data like `laps` — deleted and rewritten on every ingest, so a parser bump + replay from R2 backfills tracks. Points are extracted from two sources into one WGS84 shape (`src/route.ts`): Wahoo FIT `recordMesgs` (semicircles → degrees, the canonical cycling track) and the Apple Watch's HAE `route[]` (runs; also cycling watch-echoes, which supersession hides in favor of the Wahoo copy). Swims/tennis and indoor sessions produce zero rows. Stored thinned to a generous cap (`STORE_MAX_ROUTE_POINTS`); the `/api/route` endpoint thins again for display and precomputes bounds. The detail page renders it as a Leaflet + OSM map (dark-filtered tiles, accent polyline, start/finish markers) — gated to cycling/running, so swims never load Leaflet. **Note:** the HAE `route[]` shape is parsed defensively but unverified — no outdoor Apple Watch workout has landed yet; confirm against the first real run.
- HR samples will hit ~1800 rows per swim workout at per-second granularity. 200 workouts/year ≈ 360K rows. D1 is fine with this. If it ever balloons, downsample to per-5s after 1 year.

### MCP server

Separate Worker (or same Worker, different routes). Exposes semantic tools, not raw SQL.

Initial tool surface:

```
get_recent_workouts(sport?, limit=10)
  → [{ id, start_time, sport, distance_m, duration_sec, avg_hr, summary }]

get_workout_detail(workout_id)
  → { workout, laps[], hr_samples[], notes_yaml? }

compare_metric(metric, sport, from_date, to_date, group_by?)
  → time series of e.g. 'avg_pace_at_hr_band', 'stroke_count_drift'
  → group_by: 'session' | 'week' | 'month'

list_personal_bests(sport, distance_m)
  → fastest 100m, 500m, etc. across all sessions of that sport

stroke_count_drift(workout_id)
  → strokes/50m by lap, fatigue curve

hr_distribution(workout_id_or_range)
  → time spent in each HR zone

session_summary(workout_id)
  → human-readable summary, combining workout + notes.yaml if present

-- Athlete-authored, Claude-read (see "Write surfaces" below)
get_athlete_profile()
  → the signed-in athlete's freeform bio (age, VO2max/HR zones, sports,
    equipment, ...), or null if they haven't filled in Settings yet

-- Claude-authored, athlete-read (the two write tools; see "Write surfaces" below)
set_session_eval(source_id, evaluation_md)
  → upsert Claude's written assessment of one workout (markdown)
get_current_focus(sport)
  → the live, un-superseded forward-looking training focus for a sport
set_next_focus(sport, items[], set_by_source_id?)
  → set the next-session focus; supersedes the prior one, keeps history
```

Principles:
- **No raw SQL exposed.** Every tool is a typed query that returns clean structured data. Adding tools is cheap; constraining the surface protects against query mistakes.
- **Reads are side-effect-free; writes are confined to two athlete-facing surfaces.** The analysis/query tools never mutate. The *only* writes are `set_session_eval` and `set_next_focus` — Claude persisting its own output (a per-session evaluation and a forward-looking focus) at the end of an analysis chat. They write to dedicated tables (`session_evals`, `session_focus`), never to the derived `workouts`/`laps` data, so reprocessing can never clobber them and they can never corrupt the ingest pipeline. Every write is scoped to the Access-resolved `user_id`.
- **Return small payloads by default.** Full HR series only when explicitly requested.

### Write surfaces (per-surface ownership)

Four content surfaces, each with a clear owner, so authorship never collides:

| Surface | Table | Written by | Read by | Shape |
|---|---|---|---|---|
| Profile | `athlete_profile` | Athlete (Settings, plain textarea) | Claude (MCP `get_athlete_profile`) | Freeform markdown, one row per user (replace on save) |
| Notes | `notes` | Athlete (UI Tiptap editor) | Claude (MCP) | Rich text (ProseMirror JSON + HTML) |
| Evaluation | `session_evals` | Claude — MCP `set_session_eval` (chat) **or** the in-app "Generate evaluation" button (Workers AI, `src/evaluate.ts`) | Athlete (UI, read-only) | Markdown, one per workout (upsert); `generated_by` records the author — `'claude'` for the MCP path, the model id for the button — so the UI byline names it accurately |
| Focus | `session_focus` | Claude — MCP `set_next_focus` (chat) **or** the in-app evaluation (auto-written alongside the eval, `src/evaluate.ts`) | Athlete (UI, read-only) | JSON bullet list, per sport, append-with-supersede |

The UI detail page (`/w/{source_id}`) renders the focus, evaluation, and Notes: the focus as a callout under the stat grid, the evaluation as rendered markdown above Notes, and the editable Notes block. Evaluation and focus are read-only *content* in the UI by design — the athlete reads what Claude wrote; Claude reads what the athlete wrote — but the athlete can *trigger* an evaluation from the detail page: the "Generate evaluation" button calls `POST /api/evaluate`, which runs a single Workers AI (glm-5.2) call over the workout plus a cohort of the athlete's comparable past sessions and upserts the result into `session_evals` (see `src/evaluate.ts`; this is a second writer to that table alongside the MCP `set_session_eval`, using the identical one-per-workout upsert). Deliberately not an agentic/tool-calling loop — the question is fixed and the app worker already holds the D1 binding, so every input is gathered by direct query and rendered into one prompt. The cohort is chosen in SQL (same sport/sub-type, a distance band, plus a speed band for cycling); when fewer than three comparable sessions exist, the prompt withholds aggregate deltas and passes only a bare calendar so the model can't manufacture a trend from too little data. The same call also returns a structured, succinct `next_focus` (2–3 short bullets, via the model's JSON-schema/`response_format` structured output — *not* a tool loop, since there's nothing to execute), which the endpoint auto-writes to `session_focus` through the identical append-with-supersede path as the MCP `set_next_focus`. The model is given the sport's *current* focus and instructed to evolve it — compress and carry forward what's still relevant, revise what the session changed — rather than replace it blind. Every generation (including a regenerate) rewrites the focus, so the Focus block always reflects the latest run and its "Set" timestamp refreshes as visible feedback; an earlier no-op skip (suppress the write when the returned focus matched the current one) was removed because the evolve-don't-replace instruction makes the model reproduce the focus near-verbatim, which left the block looking frozen after the first generation. glm-5.2 is a reasoning model, so `max_tokens` must cover its hidden `reasoning_content` plus the JSON payload or the output truncates mid-parse. `session_focus` supersedes rather than overwrites, so `get_current_focus` returns the live row while the table retains the full history of how focus evolved. The profile is separate again — athlete-authored like Notes, but scoped to the athlete rather than a workout, and read by the analyzing agent at the start of an analysis (see `AGENTS.md`) rather than per-workout.

### Browser viz (deferred)

Static dashboard that reads from a `/api/*` endpoint on the Worker, served from Cloudflare Pages. Charts via Recharts or Plotly.

Defer this. Use the MCP server from Claude for a few weeks first — you'll learn which views you actually want before building any.

## Authentication

Multi-user, but small scale (a handful of athletes). Every workout row is scoped to a `user_id`. The two entry points have different clients and therefore different auth models.

### Why two models

The UI is hit by a **browser** — it can do interactive SSO. The webhook is hit by **Health Auto Export**, a machine that only sends a static `Authorization` header on a schedule — it can't complete an SSO redirect. So:

| Entry point | Client | Auth |
|---|---|---|
| UI / API (`/`, `/api/*`) | Browser | Cloudflare Access (SSO) → validated JWT |
| Webhook (`/ingest`) | Health Auto Export | Per-user bearer token |

### UI / API — Cloudflare Access

Cloudflare Access sits in front of the UI routes and runs the SSO (Google, GitHub, one-time-PIN email — configured in the Zero Trust dashboard). The Access **policy** is the gate for *who* may sign in; we don't maintain a separate allowlist.

Access injects a signed JWT in the `Cf-Access-Jwt-Assertion` header. The worker **validates** it (`verifyAccessJwt` in `src/auth.ts`) rather than trusting the header blindly — signature against the team JWKS (`/cdn-cgi/access/certs`, cached in memory), plus `aud` / `iss` / `exp` checks. This matters because the worker's `*.workers.dev` URL is reachable without going through Access; validating the JWT means a forged header can't bypass auth. The validated `email` claim is the user identity.

Users **auto-provision** on first authenticated visit (`getOrCreateUserByEmail`) — Access already vetted them, so there's no separate signup.

Config (in `wrangler.jsonc` `vars`, both safe to commit):
- `ACCESS_TEAM_DOMAIN` — `https://<team>.cloudflareaccess.com`
- `ACCESS_AUD` — the Application Audience tag from the Access application

### Webhook — per-user bearer token

Each user mints a token from the UI (`POST /api/token/rotate`). It's a random `htk_…` string; only its **SHA-256 hash** is stored in D1 (`users.ingest_token_hash`), and the plaintext is shown exactly once at mint time. On each `/ingest`, the worker hashes the presented bearer token and looks up the owning user (`getUserByIngestToken`). The token lives in HAE's automation header config; rotating it from the UI invalidates the old one.

This is deliberately *not* behind Access — service tokens (`CF-Access-Client-Id/Secret`) would also work but require HAE to send two custom headers, whereas a single `Authorization: Bearer` header is universally supported.

### Wahoo Cloud API (cycling)

Bike rides come from a Wahoo ELEMNT ROAM, recorded alongside the Apple Watch ride. The watch ride still arrives via HAE/`/ingest`; the Wahoo ride arrives via the Wahoo Cloud API, which gives the **native FIT** (real lap markers, power) — the canonical copy when both exist.

Unlike HAE, Wahoo is a third-party OAuth provider, not a header we control. Two surfaces, both on the **ingest host** (`training-ingest.yourdomain.com`) because Wahoo's servers can't pass Cloudflare Access:

| Route | Host | Purpose | Auth |
|---|---|---|---|
| `GET /api/wahoo/authorize` | app | Kick off the one-time OAuth grant | Cloudflare Access (browser, athlete already signed in) |
| `GET /wahoo/oauth/callback` | ingest | OAuth code → token exchange | `state` param (10-min KV entry minted by `/api/wahoo/authorize`, maps back to `user_id`) |
| `GET/POST /wahoo/webhook` | ingest | Per-ride event notification → fetch + archive FIT | JSON body field `webhook_token`, checked against `WAHOO_WEBHOOK_TOKEN` |

**Flow (implemented, `src/wahoo.ts` + `src/index.ts`):** athlete visits `/api/wahoo/authorize` (app host, signed in via Access) → worker mints a random `state`, stashes `state → user_id` in the `LAST_PAYLOAD` KV (10 min TTL, reused rather than a dedicated namespace — nothing to do with "last payload" semantically) → redirects to Wahoo's `/oauth/authorize`. Wahoo redirects back to `/wahoo/oauth/callback` (ingest host — Wahoo can't carry an Access session) with `?code&state`. The worker consumes the state (single-use), exchanges the code for an access + **refresh token** (`POST /oauth/token`, params in the query string per Wahoo's docs — not a JSON body), calls `GET /v1/user` to learn Wahoo's numeric user id, and upserts both into `wahoo_tokens` (migration `0008_wahoo_tokens.sql`).

Thereafter Wahoo POSTs `/wahoo/webhook` on `workout_summary` events. The worker: checks `webhook_token`, resolves `user.id` (Wahoo's id) → our `user_id` via `wahoo_tokens`, refreshes the access token if it's within 2 minutes of its 2-hour expiry (`getValidAccessToken`, refresh_token rotates on every use), fetches `GET /v1/workouts/:id` for the signed FIT download URL (`workout_summary.workout.id` in the webhook payload), downloads it, and archives the raw bytes to R2 at `raw/wahoo/{user_id}/{workout_id}.fit` — mirroring the raw-first pattern `storeWorkouts` uses for HAE.

**FIT → D1 parsing (`src/fit.ts`):** uses Garmin's official `@garmin/fitsdk` (zero runtime deps, `ArrayBuffer`/`DataView` only — confirmed decoding cleanly inside `workerd` with no `nodejs_compat` flag needed, against a real archived Wahoo ride). `parseFitWorkout` decodes the FIT's `sessionMesgs[0]` into the same `WorkoutSummary` shape `parse.ts` produces for HAE, and `lapMesgs` into the shared `Lap` shape (`laps.ts`) — but with `reconstructed: 0`, since FIT ships **native** lap boundaries rather than inferred ones like HAE's swim reconstruction. Swim-specific lap columns (strokes, swolf, pace_per_50m, stroke_type) are left `null` for cycling; the schema already anticipated this (see migrations/0003_laps.sql). `store.ts`'s `upsertWorkoutStatement` SQL is shared between the HAE and FIT paths; `storeFitWorkout` is the Wahoo-specific entry point, called inline from the webhook handler right after the R2 archive write. Dedup key is `(user_id, "wahoo:{workout_id}")` — the prefix keeps it distinct from the same athlete's HAE HealthKit UUIDs, but is *not* globally unique (Wahoo scopes workout ids to the authenticated account; see the D1 Design notes). FIT timestamps are UTC with no local offset in the payload — `tz_offset` defaults to the athlete's home base (`+0800`, Singapore, per the profile above) rather than `null`, since the UI's `fmtWhen` renders a `null` offset as raw UTC.

**Cross-source duplicate handling (`migrations/0009_supersession.sql`, `store.ts`):** the ELEMNT app can write a completed ride into Apple Health, and HAE then re-exports it — so the *same* physical ride can arrive twice: once via `/ingest` (HAE) and once via `/wahoo/webhook` (Wahoo FIT), as two independent `workouts` rows, since each path only dedups against its own source_id scheme. Confirmed 2026-07-01 on a real duplicate pair that the HAE echo carries **no data beyond** what the FIT already has (distance/avg_hr/max_hr/active_energy/temperature were all `null` on the HAE side) — so Wahoo is unconditionally treated as canonical when both exist. `workouts.superseded_by` (nullable self-FK) marks the loser; `/api/workouts` filters `WHERE superseded_by IS NULL` so the UI shows one row per ride, but nothing is deleted. Handles both arrival orders — `storeWorkouts` (HAE) checks for an existing Wahoo row and self-supersedes; `storeFitWorkout` (Wahoo) checks for existing HAE rows and supersedes them — since Wahoo's webhook typically fires near-instantly while HAE syncs on its own schedule, but the ordering isn't guaranteed.

**Detection: interval overlap, not start proximity.** Same `user_id` + `sport`, and the HAE row's interval overlaps the Wahoo row's by at least half the HAE row's own duration (`OVERLAP_MIN_FRACTION` in store.ts). The rule rests on physiology, not tolerance-tuning: two cycling recordings that overlap in time are the same ride, because the athlete can't be on two bikes at once.

This replaced a `start_time within 300s` rule (`OVERLAP_TOLERANCE_SEC`, migration 0009) that matched a Watch recording only if it *began* alongside the ride. That structurally missed the case where **one Wahoo ride spans several Watch workouts**: leave the head unit running through a stop (a commute out and back, a cafe stop) and the Watch records a workout per leg while the Wahoo records one ride across the lot. Leg 2 begins an hour into the Wahoo ride, so no tolerance value reaches it — it survived unsuperseded and double-counted its distance in the list view. Confirmed 2026-07-15: an 8.5km Wahoo ride (13:06–14:20) spanning Watch legs at 13:10–13:29 (caught by the old rule) and 14:05–14:24 (missed by it). Migration `0021_overlap_supersession_backfill.sql` applied the widened rule to rows already stored.

The half-overlap bar is deliberately loose. A split ride's legs overlap the Wahoo row nearly fully, but only nearly — whichever device is stopped first trims the tail (that 2026-07-15 return leg ran 4:42 past the Wahoo's end, leaving 76% overlap, which strict containment would have rejected). Anything above noise would do; there is no competing ride to confuse it with.

**Consequences for HR.** A Wahoo ride has no HR of its own (no chest strap), so HR is the one thing the Watch echo contributes. `migrateCyclingSamples` re-keys the echo's per-second samples onto the canonical Wahoo row, and since a ride can now hold *several* echoes, `backfillWahooHrFromSamples` derives the Wahoo row's `avg_hr`/`max_hr` from those merged samples — which span every leg — rather than the read path borrowing one echo's summary figure. It only fills a `NULL` `avg_hr`: a Wahoo row with its own HR had a strap paired, which beats the Watch's wrist optical read. The read path's echo join (`ECHO_AGGREGATE_SQL` in index.ts) aggregates the echoes to one row per canonical id, so a multi-echo ride can't fan out into duplicate list rows.

**Registered config** (Wahoo developer app, approved 2026-07-01):
- Redirect URI — `https://training-ingest.yourdomain.com/wahoo/oauth/callback`
- Webhook URI — `https://training-ingest.yourdomain.com/wahoo/webhook`
- Scopes — `email`, `user_read`, `workouts_read`, `power_zones_read`, `routes_read`, `plans_read`, `offline_data`. Load-bearing ones are **`workouts_read`** (the rides) and **`offline_data`** (refresh token for unattended sync); the rest are harmless reads. No `*_write` scopes — we never write back to Wahoo.

**Secrets** (never in `wrangler.jsonc` vars — they're in `.dev.vars` for local dev and `wrangler secret put` for prod):
- `WAHOO_WEBHOOK_TOKEN` — verification token registered with the webhook; Wahoo echoes it as a JSON body field so `/wahoo/webhook` can confirm authenticity before trusting a payload.
- `WAHOO_CLIENT_ID` / `WAHOO_CLIENT_SECRET` — OAuth app credentials.

### Setup checklist (Cloudflare dashboard)

This is the `app/`-only subset. For the full from-scratch setup — both workers, both Access applications, R2/KV, and the MCP connector — see the top-level [README.md](../README.md#setup-deploying-your-own-instance).

1. `wrangler d1 create training` → paste `database_id` into `wrangler.jsonc`.
2. `wrangler d1 migrations apply training` (and `--local` for dev).
3. Zero Trust → Access → Add an application (self-hosted) for this worker's UI hostname only (never the ingest hostname); set the identity providers and the policy (who's allowed). Copy the **Application Audience (AUD) tag** and team domain into `wrangler.jsonc` `vars`.
4. `wrangler deploy`. Sign in via the UI, generate an ingest token, paste it into Health Auto Export.
5. Wahoo (cycling): `wrangler secret put WAHOO_WEBHOOK_TOKEN` (and `WAHOO_CLIENT_ID` / `WAHOO_CLIENT_SECRET` once the app is approved). Local dev reads the same names from `.dev.vars`.

### MCP server

Built — see `../mcp/`. Auth is a separate Cloudflare Access application (**SaaS/OIDC** type, not self-hosted) with `workers-oauth-provider` brokering the OAuth dance; the authenticated email scopes every tool to that athlete's rows in the same D1 database. Full auth flow in `../mcp/src/access-handler.ts`; setup steps in the [README](../README.md#4-cloudflare-access--two-separate-applications).

## The lap reconstruction problem

The single hardest piece of this system. Worth its own section.

### What's available in HAE JSON

The export contains time-bucketed samples:
- `swimDistance[]`: `{ date, qty }` per second (when set to second granularity)
- `swimStroke[]`: `{ date, qty }` per second — strokes detected in that 1-second window
- `heartRateData[]`: HR samples, sparser than per-second

There are **no native lap markers**. The Apple Watch's "Auto Sets" view in the iPhone Fitness app does have native lap data (pool-end detection via accelerometer), but HAE's JSON export drops that structure.

### Reconstruction algorithm

```
1. Sort swimDistance samples by timestamp.
2. Accumulate cumulative distance.
3. Each time cumulative distance crosses an N×pool_length boundary, mark end of lap N.
4. For each lap, sum strokes within the lap's time range.
5. For each lap, average HR samples within the lap's time range.
6. Detect rest: gaps > 5 seconds between consecutive swimDistance timestamps
   = wall rest. Exclude from active_sec; attribute to rest_after_sec of the
   preceding lap.
```

### Known reconstruction errors

| Issue | Cause | Impact | Mitigation |
|---|---|---|---|
| Lap boundary off by ~2–5s | Cumulative distance crosses boundary slightly before or after the actual pool wall | Per-lap pace is approximate, aggregate pace is accurate | Treat per-lap pace as ±2s; aggregate over a session |
| Stroke count drops to 0 for a length | Watch's accelerometer missed strokes during a glide-heavy phase | SWOLF for that lap is meaningless | Flag laps with `strokes == 0 and distance > 0` as instrumentation noise |
| Watch labels stroke as `Kickboard` | Glide-heavy freestyle (often with pull buoy) doesn't match the freestyle accelerometer pattern | Stroke-type stats wrong | Override via `notes.yaml` `lap_corrections`; ignore stroke_type if not validated |
| First lap durations artificially short | Watch needs a few seconds to confirm swim activity at session start | First lap pace looks too fast | Flag `incomplete_laps` in `notes.yaml`; exclude from per-lap analysis |
| Total reconstructed distance > Apple's reported total | Edge effects in boundary detection | Off by ~1 lap occasionally | Trust Apple's `distance` field on the workout summary for totals; use reconstructed laps only for within-session analysis |

### What this means for the schema

- `laps.reconstructed = 1` flag on every inferred lap. Future cycling/FIT-based ingestion will set it to 0.
- `laps.stroke_type` stays as the Watch's raw label. Corrections from `notes.yaml` are applied at query time by the MCP server, not stored in the laps table. This keeps the laps table a faithful representation of the raw data; the corrections are applied logically by the analysis layer.
- Per-lap stroke count and SWOLF are stored but should be consumed with awareness of their noise.

### What's reliable vs noisy

Reliable from this pipeline:
- Session totals (distance, time, HR distribution, total strokes).
- HR time series (sampling is consistent).
- Rest-period detection (gap-based heuristic is robust).
- Stroke count drift across a session (the *trend* is real even if individual values are noisy).

Noisy:
- Individual lap stroke counts.
- Individual lap stroke type classification.
- Lap boundaries (±5s).

Designed-around:
- The MCP analysis tools should prefer aggregate queries over per-lap detail when answering high-level questions.
- Single-session anomalies should be flagged but not over-interpreted.

## Design decisions and tradeoffs

**Raw-first storage.** R2 keeps original payloads forever. Cheap, and means parser bugs are recoverable. Trade: slightly more code (storage step + reprocess endpoint) for much more robustness.

**D1 over Postgres/Turso.** Already in the Cloudflare ecosystem, free tier covers personal scale, zero ops. Trade: less mature than Postgres, but plenty for this.

**Derived metrics stored, not computed on read.** Pace, SWOLF, etc. live in the DB. Trade: have to recompute on schema change (via `parser_version` + reprocess), but reads are fast and MCP tools are simple.

**MCP server as the primary interface.** No browser UI until needed. Trade: requires Claude as the consumption layer; doesn't help if you want to glance at numbers without opening a chat. Acceptable for personal use; browser viz can come later if it earns its keep.

**HAE Premium over building native.** $25 lifetime vs. $99/year Apple Developer + weeks of Swift work. Trade: dependence on a third-party app's continued existence, but the data is in R2 — if HAE disappears, swap in HealthFit or a custom Swift app pointing at the same `/ingest` endpoint.

## Build order

1. **D1 schema + migration setup.** Get the structure right before any code depends on it. *(Done for `users`: `migrations/0001_users.sql`. Multi-user auth — Access for the UI, per-user tokens for `/ingest` — is wired in `src/auth.ts` + `src/users.ts`.)*
2. **Worker `/ingest`** that authenticates, stores raw to R2, and writes a minimal subset to D1 (workout summary only). Verify HAE → Worker → R2 → D1 round-trips end-to-end with a real swim. *Don't write the lap reconstruction yet.*
3. **Lap reconstruction** as a separate parser module with its own tests. Run against the R2 archive of a handful of stored workouts. Iterate until the output matches Apple Watch's auto-sets within tolerance.
4. **HR sample ingestion** into `hr_samples` table.
5. **MCP server skeleton** with `get_recent_workouts` and `get_workout_detail`. Wire to Claude Desktop. Validate from chat.
6. **Add analysis MCP tools** as needed: `stroke_count_drift`, `compare_metric`, `hr_distribution`. Drive these by real questions you want to ask, not speculation.
7. **`/backfill` and reprocess endpoints.** You'll want these the first time the parser changes.
9. **Browser viz** if and when the MCP-only workflow proves limiting.

## Open questions / TODOs

- **HAE retry semantics.** Confirm what HAE does when the Worker is unreachable. Probably retries on next unlock, but worth verifying with a deliberate Worker outage test.
- **HAE payload schema stability.** New iOS or HAE versions may change field names. Worth adding a `schema_version` heuristic to the parser to detect breaking changes.
- **Cycling FIT ingestion.** When the first ride is captured, the parser needs FIT-decoding logic. Schema is already extensible; just a new parser branch on `sport`.
- **Timezone handling.** Store epochs in UTC, keep `timezone` for display. Make sure HAE's date strings (e.g. `"2026-05-22 09:16:40 +0800"`) are parsed correctly into UTC epochs.
- **Backups.** R2 is durable but consider periodic D1 → R2 dumps as belt-and-braces protection against schema migrations gone wrong.
