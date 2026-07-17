# Training Data Analysis

This repo is a personal training data pipeline: workouts flow from fitness devices through a Cloudflare Worker/D1 pipeline (see [app/ARCHITECTURE.md](app/ARCHITECTURE.md)), stored per-athlete and surfaced two ways — in the app's own UI and to Claude via the `trainer` MCP server. The goal either way is the same: analyze workouts, track trends across weeks, and suggest training adjustments.

This file is the **agent-facing guide** — what this repo is, how to pull an athlete's own context before analyzing, and how to persist your output back through the app. It deliberately holds no athlete-specific data: the deployment is multi-user (see `app/ARCHITECTURE.md`'s multi-user model), so anything specific to one athlete — age, VO2max, HR zones, active sports, equipment, current training focus — lives in the app (Settings page / D1), fetched per-athlete via MCP, not hardcoded here. That keeps this file correct for whichever athlete is signed in, and keeps real personal data out of version control.

## Two ways a workout gets evaluated

There are **two evaluators** writing to the same `session_evals` / `session_focus` tables, and they're meant for different jobs:

- **Workers AI (GLM 5.2), in-app** — the "Generate evaluation" button on the workout detail page runs Cloudflare Workers AI in the Worker itself (see `app/src/evaluate.ts`). This is the **quick, self-serve path**: one tap, a fast per-workout eval and an updated forward focus, no conversation. It's what the athlete reaches for to get a read on a session without leaving the app. Cheap, immediate, cohort-aware — but a single-shot model call, not a discussion.
- **Claude, via MCP (this guide)** — you're the **deeper path**: longer, back-and-forth analysis of a *specific* workout or sport, cross-session trend digging, "why did this happen / what should I change" conversations. Reach for the full playbook below, look across a rolling window, and reason about tradeoffs the button can't. When the athlete wants to actually *talk through* their training, that's you.

The two share a write surface (see "Shared write surface" under the playbook), so an eval or focus you read may have been authored by the button, not you. Don't treat a stored eval as your own prior reasoning, and don't feel obliged to preserve the button's phrasing — overwrite it with your fuller analysis when the athlete has engaged you for one.

## Getting athlete context

Before analyzing a workout, pull the *signed-in athlete's own* context via MCP — don't assume anything about who they are from this file:

1. **`get_athlete_profile()`** — bio: age, VO2max/HR zones, active sports, equipment, anything else they've noted. Athlete-authored via Settings → Athlete profile.
2. **`get_current_focus(sport)`** — the live forward-looking focus for that sport, if one's been set.
3. **`get_recent_workouts` / `get_workout_detail` / `get_workout_history`** — the actual workout data.

If `get_athlete_profile()` comes back empty (a new athlete hasn't filled in Settings yet): ask them for the basics conversationally, and offer to draft a `profile_md` block for them to paste into Settings — don't invent one, and don't fall back to assumptions from a prior conversation or another athlete.

## What we actually monitor

Apple Watch swim data is **reliable in aggregate, noisy per-lap.** Analysis priorities reflect that.

### Reliable, prioritize these
- **Avg pace at HR band** — pace when HR sits in a given band (ask the athlete's profile for their zones). Comparable across sessions, captures real fitness/efficiency change.
- **Stroke count drift within a session** — strokes per 50m at start vs end. The fatigue signature. A session where strokes hold steady = good. A session where they drift +30% = breaking down.
- **Active vs rest time ratio** — how much of the session was actually swimming vs hanging at the wall.
- **Sustained swim time** — longest continuous active block without rest.
- **HR recovery** — bpm drop in first 60s after stopping. Tracks aerobic fitness directly.
- **Session-aggregate SWOLF** — average across all real freestyle laps.
- **Active swim distance per session** — for volume tracking.

### Less reliable, treat as approximate
- Per-lap stroke counts (Watch misses strokes on glide-heavy lengths).
- Per-lap stroke classification (see `Known instrumentation issues`).
- Individual SWOLF values for a single lap.
- Lap boundaries derived from HAE JSON (off by ~±5s vs Watch's native pool-end detection).

## Known instrumentation issues

These are device/pipeline quirks — true for any athlete on this deployment, not personal data.

### Apple Watch swim tracking
- **Mis-classifies stroke types.** Long-glide freestyle (especially with a pull buoy) gets labeled as `Kickboard`. The classifier reads wrist accelerometer rhythm, not actual stroke. If the athlete's profile or a workout's notes says they don't use a kickboard, treat any `Kickboard` label as wrong. Flag corrections in the workout's notes (UI) so Claude can account for them when reading `stroke_type`.
- **Occasionally records zero strokes** for a length with non-zero distance. Likely a glide after push-off where rhythmic arm motion didn't register. Treat as missing data, not as a real low-stroke achievement.
- **First lap is often short.** Watch needs a few seconds to confirm swimming after the workout starts; the first length's recorded duration is often artificially fast. Treat lap 1 as unreliable in per-lap stats (see `stroke_count_drift`'s note-excludes-lap-1 convention).

### HAE export specifics
- Export at **per-second granularity** (HAE setting). Per-minute is too coarse — laps are ~60s, so a single bucket spans more than a length.
- HAE export does **not** include Apple's native lap markers. Reconstruct laps from the `swimDistance` array by accumulating distance until each 50m boundary is crossed.
- Rest detection: gaps >5s between consecutive `swimDistance` timestamps indicate wall rest. Sum active seconds excluding gaps; treat the gap as `rest_after` for the preceding lap.
- Active time is what matters for pace; the Watch's "avg pace" field includes rest and is misleading.

### Cycling (placeholder, refine when real data lands)
- FIT files include native lap markers — use them directly, no reconstruction needed.
- Power data (W/kg) is the gold standard if a meter is present; HR-only is workable but noisier.

### Running
- No lap markers for this sport (HAE has none for running/walking).
- HAE has no native per-second (or even per-lap) running cadence stream. `stepCadence` is a single session-average QuantityData (steps/min) — that's the only cadence Apple hands over directly, and it populates the workout's `avg_cadence_rpm`.
- The cadence-over-time chart on the detail page is *derived*: reconstructed from HAE's `stepCount` interval array by treating each entry as the step count since the previous one and dividing by the elapsed time (`app/src/parse.ts`'s `extractHaeStepCountSamples`). Treat it as approximate, the same way reconstructed swim laps are — a proxy for per-interval cadence, not a direct device reading.
- GPS route comes from HAE's `route[]`, same mechanism as cycling's outdoor track.
- Walk cadence in particular has read implausibly low in early data — cross-check against another source before trusting it for a given athlete.
- For short, urgent efforts (e.g. a dash to catch a bus), HR can spike into a high zone briefly — check duration/context before reading a high HR as a fitness concern.

## Analysis playbook (the deep path)

This is your lane, not the button's — reach for it when the athlete has engaged you to actually dig into a workout or sport. When a new workout arrives:

1. **Get the athlete's own context first** — `get_athlete_profile()`, `get_current_focus(sport)` — see "Getting athlete context" above.
2. **Pull the workout via MCP** (`get_workout_detail` / `get_workout_history`) — this already merges derived metrics, reconstructed laps, equipment tags, and the athlete's notes. Notes override Watch classifications.
3. **Compute session aggregates first**: total active time, total distance, avg pace, HR distribution by zone, stroke count distribution, longest sustained block.
4. **Reconstruct laps** from `swimDistance` cumulative (50m boundary crossings). Subtract inter-sample gaps >5s as rest, not active time. (Done by the ingest pipeline, not per-analysis — see `app/src/laps.ts`.)
5. **Apply any corrections noted in the workout's notes** before stroke-type analysis. Exclude lap 1 from per-lap stats.
6. **Plot stroke-count-per-50m across the session.** Drift = fatigue signature. This is the most informative single chart.
7. **Compare to a rolling window** of recent sessions on the same metric set. Surface trends, not snapshots.
8. **Distinguish real change from noise.** A 2-second pace change session-over-session is noise; a 5-second improvement at the same HR across 4 weeks is real.
9. **Persist the takeaways via the MCP** so the athlete can revisit them in the UI (the primary place these live):
   - At the **end**, call `set_session_eval(source_id, evaluation_md)` to save your written assessment of that workout (markdown; one per workout, replaces on re-run), and `set_next_focus(sport, items[], set_by_source_id)` to update the forward-looking focus. Both render on the workout detail page (`/w/{source_id}`); focus is per-sport and supersedes the prior focus while keeping history. Notes and the athlete profile are athlete-authored — don't write them from the MCP.

> **Shared write surface — evals and focus have a second author.** As covered in "Two ways a workout gets evaluated" above, the in-app "Generate evaluation" button (Workers AI / GLM 5.2, `app/src/evaluate.ts`) writes the *same* `session_evals` / `session_focus` tables you write via MCP. Consequences when analyzing:
> - An existing eval you read may have been authored by **GLM (the button)**, not you — the `generated_by` column records which (`'claude'` for the MCP path, the model id for the button), and the UI byline names it. Your `set_session_eval` overwrites whatever was there (one row per workout); their button overwrites yours on the next press. Don't treat a stored eval as your own prior reasoning.
> - Likewise `get_current_focus` may return a focus the **button** set (evolved from the prior focus by GLM), not one you wrote. It's still the live focus — build on it — just don't assume you authored it.
> - The button's cohort logic (same sport/sub-type, distance band, cycling speed band; degrades to no-trend below 3 comparators) lives in `app/src/evaluate.ts` if you want to mirror or critique how it picks comparables.

Don't over-interpret single sessions. The unit of meaningful change is 4–8 weeks of trend, not last Tuesday vs today.

## Adding new sports

When adding a sport:
1. Add it to the `SPORTS` enum in `mcp/src/index.ts` (and anywhere else the worker enumerates sports).
2. Document the data source format in this file (under a new section or extend `Known instrumentation issues`) — where the raw data comes from (HAE, FIT, manual entry) and how it's parsed. This section is generic/pipeline-level, not athlete-specific.
3. List reliable vs noisy metrics for that sport.
4. Extend the D1 schema via a new migration (`app/migrations/`) for any sport-specific fields, following the pattern in `app/ARCHITECTURE.md`. The athlete profile itself is freeform text, so a new sport rarely needs a schema change there — the athlete just mentions it in their profile/Settings.
