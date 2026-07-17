/**
 * Training MCP server.
 *
 * Auth: Cloudflare Access as the upstream OIDC IdP, brokered by
 * workers-oauth-provider (Access-for-SaaS pattern). The reference auth glue lives
 * in access-handler.ts + workers-oauth-utils.ts (copied verbatim from
 * cloudflare/ai/demos/remote-mcp-cf-access). The authenticated email arrives in
 * this.props.email and is resolved to the user's row, scoping every tool to that
 * athlete.
 *
 * Tools are read-only queries over the same D1 database the ingest/UI worker
 * writes. Streamable HTTP transport, mounted at /mcp.
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { handleAccessRequest } from "./access-handler";
import type { Props } from "./workers-oauth-utils";
import {
  getAthleteProfile,
  getCurrentFocus,
  getRecentWorkouts,
  getSessionEval,
  getUserByEmail,
  getWorkoutDetail,
  listPersonalBests,
  resolveWorkoutId,
  setNextFocus,
  setSessionEval,
  type LapRow,
  type UserRow,
} from "./db";

const SPORTS = ["swimming", "cycling", "tennis", "running", "calisthenics", "other"] as const;

function text(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

function fmtDur(s: number | null): string {
  if (s == null) return "—";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return m + ":" + String(sec).padStart(2, "0");
}

function localDate(epoch: number, offset: string | null): string {
  const offMin = offset ? (offset[0] === "-" ? -1 : 1) * (parseInt(offset.slice(1, 3)) * 60 + parseInt(offset.slice(3, 5))) : 0;
  return new Date((epoch + offMin * 60) * 1000).toISOString().replace("T", " ").slice(0, 16) + (offset ? " " + offset : "Z");
}

function stripHtml(html: string | null): string | null {
  if (!html) return null;
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
}

// Above this distance-per-stroke a full length is physically implausible for
// freestyle (efficient masters swimmers sit ~1.5–2.6 m/stroke; Apple counts
// single-arm strokes). A higher value means the Watch under-detected strokes
// on a glide-heavy length (or recorded zero) — treat those strokes as MISSING,
// not as a real low-stroke achievement (CLAUDE.md known instrumentation issue).
// The same test also catches the short-start artifact, whose force-scaled 50 m
// over a truncated stroke window yields an impossibly high m/stroke.
const MAX_PLAUSIBLE_M_PER_STROKE = 3.0;

/** True when a full length's recorded stroke count is too low to be real (sensor miss). */
function strokesUnderDetected(l: LapRow): boolean {
  if ((l.distance_m ?? 0) < 45) return false; // only judge full lengths
  const s = l.strokes ?? 0;
  if (s <= 0) return true; // zero-stroke length = definite miss
  return (l.distance_m as number) / s > MAX_PLAUSIBLE_M_PER_STROKE;
}

/**
 * Strokes/50m fatigue signature. Two things corrupt per-lap stroke counts and
 * both are handled by treating the affected lap as MISSING (excluded), never by
 * inventing a value:
 *   1. Lap 1 short-start artifact (Watch confirmation delay / a late-started
 *      workout) — excluded by convention.
 *   2. Stroke under-detection on glide-heavy lengths — flagged via m/stroke.
 * The `excluded` list makes every dropped lap visible so the athlete can see
 * exactly what was discounted (and override via notes if a value was real).
 */
function strokeDriftSeries(
  laps: LapRow[],
): { nums: number[]; laps: number[]; excluded: { lap: number; strokes: number | null; reason: string }[]; note: string } | null {
  const full = laps.filter((l) => (l.distance_m ?? 0) >= 45).sort((a, b) => a.lap_num - b.lap_num);
  const kept: { lap: number; strokes: number }[] = [];
  const excluded: { lap: number; strokes: number | null; reason: string }[] = [];
  for (const l of full) {
    if (l.lap_num === 1) {
      excluded.push({ lap: l.lap_num, strokes: l.strokes, reason: "lap 1 short-start artifact" });
    } else if (strokesUnderDetected(l)) {
      excluded.push({ lap: l.lap_num, strokes: l.strokes, reason: "strokes under-detected (implausibly few for 50m)" });
    } else if (l.strokes != null) {
      kept.push({ lap: l.lap_num, strokes: l.strokes });
    }
  }
  if (kept.length === 0) return null;
  const extra = excluded.filter((e) => e.reason.startsWith("strokes")).length;
  const note = extra > 0 ? `excludes lap 1 + ${extra} under-detected lap(s)` : "excludes lap 1";
  return { nums: kept.map((k) => k.strokes), laps: kept.map((k) => k.lap), excluded, note };
}

function strokeDriftSummary(
  laps: LapRow[],
): { first: number; last: number; min: number; max: number; excluded: { lap: number; strokes: number | null; reason: string }[]; note: string } | null {
  const series = strokeDriftSeries(laps);
  if (!series || series.nums.length === 0) return null;
  const { nums, excluded, note } = series;
  return { first: nums[0], last: nums[nums.length - 1], min: Math.min(...nums), max: Math.max(...nums), excluded, note };
}

export class TrainingMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({ name: "TrAIner", version: "1.0.0" });

  private async user(): Promise<UserRow | null> {
    return getUserByEmail(this.env.DB, this.props!.email);
  }

  /** Shared by get_workout_detail and get_last_workout — full detail for one workout. */
  private async workoutDetailResponse(u: UserRow, sourceId: string) {
    const d = await getWorkoutDetail(this.env.DB, u.id, sourceId);
    if (!d.workout) return null;
    const evaluation = await getSessionEval(this.env.DB, d.workout.id);
    const focus = await getCurrentFocus(this.env.DB, u.id, d.workout.sport);
    return {
      workout: { ...d.workout, when: localDate(d.workout.start_time, d.workout.tz_offset) },
      laps: d.laps,
      // Reps/RIR/rest per set — calisthenics only; a set with rir=null and
      // is_amrap=true was taken to true failure (the periodic recalibration
      // test, not a missing value).
      sets: d.workout.sport === "calisthenics" ? d.sets : undefined,
      stroke_drift_summary: d.workout.sport === "swimming" ? strokeDriftSummary(d.laps) : undefined,
      notes: stripHtml(d.note?.content_html ?? null), // athlete-authored
      evaluation: evaluation?.content_md ?? null, // Claude-authored (set_session_eval)
      current_focus: focus?.items ?? null, // forward-looking, per sport
    };
  }

  async init() {
    this.server.tool(
      "get_recent_workouts",
      "List the athlete's most recent workouts (summary only), newest first. Optionally filter by sport.",
      { sport: z.enum(SPORTS).optional(), limit: z.number().min(1).max(50).default(10) },
      async ({ sport, limit }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const rows = await getRecentWorkouts(this.env.DB, u.id, sport, limit);
        return text({
          count: rows.length,
          workouts: rows.map((w) => ({
            source_id: w.source_id,
            sport: w.sport,
            name: w.sub_type,
            when: localDate(w.start_time, w.tz_offset),
            duration: fmtDur(w.duration_sec),
            // Moving time, only when the device distinguishes it from wall clock.
            // Surfaced separately rather than folded into `duration` so an
            // analysis can see the gap — a large one means a stop-heavy ride, and
            // any pace figure must divide by this, not by duration.
            ...(w.moving_sec != null && w.moving_sec !== w.duration_sec
              ? { moving_duration: fmtDur(w.moving_sec) }
              : {}),
            distance_m: w.distance_m,
            avg_hr: w.avg_hr,
            max_hr: w.max_hr,
            ...(w.avg_power_w != null
              ? {
                  avg_power_w: w.avg_power_w,
                  normalized_power_w: w.normalized_power_w,
                  intensity_factor: w.intensity_factor,
                  training_stress_score: w.training_stress_score,
                }
              : {}),
          })),
        });
      },
    );

    this.server.tool(
      "get_workout_detail",
      "Full detail for one workout: summary, reconstructed laps (with per-lap equipment tags), stroke-drift summary (swim), and the athlete's notes. Use the source_id from get_recent_workouts.",
      { source_id: z.string() },
      async ({ source_id }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const resp = await this.workoutDetailResponse(u, source_id);
        if (!resp) return text({ message: "Workout not found", source_id });
        return text(resp);
      },
    );

    this.server.tool(
      "get_last_workout",
      "Full detail for the athlete's single most recent workout, optionally filtered by sport — combines get_recent_workouts + get_workout_detail into one call for the common 'pull the last swim/ride' case.",
      { sport: z.enum(SPORTS).optional() },
      async ({ sport }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const rows = await getRecentWorkouts(this.env.DB, u.id, sport, 1);
        if (!rows.length) return text({ message: "No workouts found" + (sport ? ` for ${sport}` : "") });
        return text(await this.workoutDetailResponse(u, rows[0].source_id));
      },
    );

    this.server.tool(
      "get_workout_history",
      "Full detail (metrics, laps, stroke-drift summary, notes) for the last N workouts of a sport in one call — for rolling-window trend comparison across sessions instead of chaining get_recent_workouts + get_workout_detail per session. Current focus is returned once, not per workout.",
      { sport: z.enum(SPORTS), limit: z.number().min(1).max(20).default(6) },
      async ({ sport, limit }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const rows = await getRecentWorkouts(this.env.DB, u.id, sport, limit);
        if (!rows.length) return text({ message: "No workouts found for " + sport });
        const focus = await getCurrentFocus(this.env.DB, u.id, sport);
        const workouts = await Promise.all(
          rows.map(async (r) => {
            const d = await getWorkoutDetail(this.env.DB, u.id, r.source_id);
            if (!d.workout) return null;
            const evaluation = await getSessionEval(this.env.DB, d.workout.id);
            return {
              workout: { ...d.workout, when: localDate(d.workout.start_time, d.workout.tz_offset) },
              laps: d.laps,
              sets: sport === "calisthenics" ? d.sets : undefined,
              stroke_drift_summary: sport === "swimming" ? strokeDriftSummary(d.laps) : undefined,
              notes: stripHtml(d.note?.content_html ?? null),
              evaluation: evaluation?.content_md ?? null,
            };
          }),
        );
        return text({ sport, count: workouts.length, current_focus: focus?.items ?? null, workouts: workouts.filter(Boolean) });
      },
    );

    this.server.tool(
      "stroke_count_drift",
      "Strokes per 50 m by lap for a swim — the fatigue signature. Steady = good; rising = breaking down. Per-lap values are raw; laps with implausibly few strokes (Watch under-detection / lap-1 short-start) are flagged and excluded from `summary` rather than trusted — see `summary.excluded`.",
      { source_id: z.string() },
      async ({ source_id }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const d = await getWorkoutDetail(this.env.DB, u.id, source_id);
        if (!d.workout) return text({ message: "Workout not found", source_id });
        if (d.workout.sport !== "swimming") return text({ message: "Not a swim", sport: d.workout.sport });
        const full = d.laps.filter((l) => (l.distance_m ?? 0) >= 45);
        const excludedByLap = new Map((strokeDriftSummary(d.laps)?.excluded ?? []).map((e) => [e.lap, e.reason]));
        const drift = full.map((l) => ({
          lap: l.lap_num,
          strokes: l.strokes,
          pace_per_50m: l.pace_per_50m,
          equipment: l.equipment,
          ...(excludedByLap.has(l.lap_num)
            ? { unreliable: true, note: `raw value excluded from trend — ${excludedByLap.get(l.lap_num)}` }
            : {}),
        }));
        return text({ source_id, per_lap: drift, summary: strokeDriftSummary(d.laps) });
      },
    );

    this.server.tool(
      "list_personal_bests",
      "Personal bests for a sport: longest distance, plus fastest 50 m (swimming) or fastest average speed (other sports).",
      { sport: z.enum(SPORTS) },
      async ({ sport }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        return text(await listPersonalBests(this.env.DB, u.id, sport));
      },
    );

    this.server.tool(
      "session_summary",
      "A human-readable summary of one workout, combining metrics, lap stroke-drift, rest, equipment usage, and the athlete's notes.",
      { source_id: z.string() },
      async ({ source_id }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const d = await getWorkoutDetail(this.env.DB, u.id, source_id);
        if (!d.workout) return text({ message: "Workout not found", source_id });
        const w = d.workout;
        const lines: string[] = [];
        lines.push(`${w.sub_type ?? w.sport} — ${localDate(w.start_time, w.tz_offset)}`);
        if (w.sport === "calisthenics") {
          lines.push(`Duration ${fmtDur(w.duration_sec)}.`);
        } else {
          const km = w.distance_m != null ? (w.distance_m / 1000).toFixed(2) + " km" : "—";
          lines.push(`Distance ${km}, duration ${fmtDur(w.duration_sec)}, avg HR ${w.avg_hr ? Math.round(w.avg_hr) : "—"}, max HR ${w.max_hr ?? "—"}.`);
          // Spell the two clocks out when they diverge, and do the division here
          // rather than leave a reader to reach for duration_sec by reflex: on a
          // stop-heavy ride that's the difference between 9.7 and 21.6 km/h.
          if (w.moving_sec != null && w.moving_sec !== w.duration_sec) {
            const pace =
              w.distance_m != null && w.moving_sec > 0
                ? `, avg moving speed ${((w.distance_m / w.moving_sec) * 3.6).toFixed(1)} km/h`
                : "";
            lines.push(
              `Moving time ${fmtDur(w.moving_sec)} of ${fmtDur(w.duration_sec)} elapsed (device auto-paused; avg power/cadence are over moving time, and avg HR is restricted to it)${pace}.`,
            );
          }
        }
        if (w.sport === "calisthenics" && d.sets.length) {
          const perSet = d.sets
            .map((s) => `${s.reps}${s.is_amrap ? " (AMRAP)" : s.rir != null ? ` @RIR${s.rir}` : ""}`)
            .join(", ");
          lines.push(`${d.sets.length} sets: ${perSet}.`);
          const rests = d.sets.map((s) => s.rest_before_sec).filter((r): r is number => r != null);
          if (rests.length) lines.push(`Rest between sets ~${fmtDur(rests.reduce((a, b) => a + b, 0) / rests.length)} avg.`);
        }
        if (w.sport === "cycling" && w.avg_power_w != null) {
          const ef = w.avg_hr ? (w.normalized_power_w ?? w.avg_power_w) / w.avg_hr : null;
          lines.push(
            `Power: avg ${w.avg_power_w}W, NP ${w.normalized_power_w ?? "—"}W, IF ${w.intensity_factor?.toFixed(2) ?? "—"}, TSS ${w.training_stress_score?.toFixed(1) ?? "—"}` +
              `${w.avg_cadence_rpm != null ? `, cadence ${w.avg_cadence_rpm}rpm` : ""}` +
              `${w.elevation_gain_m != null ? `, elevation +${Math.round(w.elevation_gain_m)}m` : ""}` +
              `${ef != null ? `. Efficiency factor (NP/HR) ${ef.toFixed(2)}` : ""}.`,
          );
        }
        if (w.sport === "swimming" && d.laps.length) {
          const full = d.laps.filter((l) => (l.distance_m ?? 0) >= 45);
          const series = strokeDriftSeries(d.laps);
          const sNums = series?.nums ?? [];
          const rest = d.laps.reduce((a, l) => a + (l.rest_after_sec ?? 0), 0);
          lines.push(`${full.length} full lengths; strokes/50m ${sNums.length ? `${sNums[0]}→${sNums[sNums.length - 1]} (min ${Math.min(...sNums)}, max ${Math.max(...sNums)})` : "n/a"}.`);
          lines.push(`Total wall rest ~${fmtDur(rest)}.`);
          const buoy = d.laps.filter((l) => l.equipment?.includes("pull_buoy")).map((l) => l.lap_num);
          const snorkel = d.laps.filter((l) => l.equipment?.includes("front_snorkel")).map((l) => l.lap_num);
          if (buoy.length) lines.push(`Pull buoy: laps ${buoy.join(", ")}.`);
          if (snorkel.length) lines.push(`Front snorkel: laps ${snorkel.join(", ")}.`);
        }
        const notes = stripHtml(d.note?.content_html ?? null);
        if (notes) lines.push(`Notes: ${notes}`);
        const focus = await getCurrentFocus(this.env.DB, u.id, w.sport);
        if (focus?.items.length) lines.push(`Current ${w.sport} focus:\n- ${focus.items.join("\n- ")}`);
        const evaluation = await getSessionEval(this.env.DB, w.id);
        if (evaluation) lines.push(`\nEvaluation:\n${evaluation.content_md}`);
        return text(lines.join("\n"));
      },
    );

    this.server.tool(
      "set_session_eval",
      "Save (upsert) Claude's evaluation of one workout — the written assessment from an analysis chat. Markdown. The athlete reads this in the UI. One per workout; re-running replaces it.",
      { source_id: z.string(), evaluation_md: z.string().min(1) },
      async ({ source_id, evaluation_md }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const workoutId = await resolveWorkoutId(this.env.DB, u.id, source_id);
        if (!workoutId) return text({ message: "Workout not found", source_id });
        const { updated_at } = await setSessionEval(this.env.DB, u.id, workoutId, evaluation_md);
        return text({ ok: true, source_id, updated_at });
      },
    );

    this.server.tool(
      "get_athlete_profile",
      "The athlete's freeform bio — age, VO2max/HR zones, active sports, equipment, anything else they've noted about themselves. Athlete-authored via the Settings UI; read this at the start of an analysis, before get_current_focus. Returns null if they haven't filled it in yet — in that case, ask them or offer to draft one from the conversation for them to paste in.",
      {},
      async () => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const profile = await getAthleteProfile(this.env.DB, u.id);
        return text({ profile_md: profile, message: profile ? undefined : "No profile set yet — see Settings." });
      },
    );

    this.server.tool(
      "get_current_focus",
      "The athlete's current forward-looking training focus for a sport (the live, un-superseded focus). Read this at the start of an analysis to know what they're working on.",
      { sport: z.enum(SPORTS) },
      async ({ sport }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        const focus = await getCurrentFocus(this.env.DB, u.id, sport);
        if (!focus) return text({ sport, focus: null, message: "No focus set yet." });
        return text({
          sport,
          items: focus.items,
          set_at: localDate(focus.created_at, null),
          set_by_session: focus.set_by_source_id,
        });
      },
    );

    this.server.tool(
      "set_next_focus",
      "Set the athlete's next-session training focus for a sport (a short list of things to work on). Supersedes the prior focus and keeps history. Optionally tie it to the session that prompted it via set_by_source_id.",
      {
        sport: z.enum(SPORTS),
        items: z.array(z.string().min(1)).min(1).max(8),
        set_by_source_id: z.string().optional(),
      },
      async ({ sport, items, set_by_source_id }) => {
        const u = await this.user();
        if (!u) return text({ message: "No data for " + this.props!.email });
        let setBy: string | null = null;
        if (set_by_source_id) {
          setBy = await resolveWorkoutId(this.env.DB, u.id, set_by_source_id);
          if (!setBy) return text({ message: "Workout not found", source_id: set_by_source_id });
        }
        const { created_at } = await setNextFocus(this.env.DB, u.id, sport, items, setBy);
        return text({ ok: true, sport, items, set_at: localDate(created_at, null) });
      },
    );
  }
}

// Public liveness check, then delegate everything else to the Access OAuth flow.
function defaultHandler(req: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
  if (new URL(req.url).pathname === "/health") {
    return new Response(JSON.stringify({ ok: true, service: "training-mcp" }), {
      headers: { "content-type": "application/json" },
    });
  }
  return handleAccessRequest(req, env as Env & { OAUTH_PROVIDER: any }, ctx);
}

export default new OAuthProvider({
  apiHandler: TrainingMCP.serve("/mcp") as any,
  apiRoute: "/mcp",
  authorizeEndpoint: "/authorize",
  clientRegistrationEndpoint: "/register",
  defaultHandler: { fetch: defaultHandler } as any,
  tokenEndpoint: "/token",
});
