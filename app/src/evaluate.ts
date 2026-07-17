/**
 * On-demand workout evaluation via Workers AI (glm-5.2).
 *
 * Triggered by the athlete pressing "Generate evaluation" on the detail page
 * (POST /api/evaluate). Deliberately NOT an agentic / tool-calling loop: the
 * question is fixed ("evaluate this workout") and the app worker already holds
 * the D1 binding, so every input is gathered up front by direct query and
 * rendered into one prompt for a single AI.run() call. See ARCHITECTURE.md's
 * "MCP server" section for why the MCP tool surface exists for Claude-in-chat
 * but is the wrong shape for this in-app, single-purpose path.
 *
 * The one piece of real judgement here is the COHORT: which of the athlete's
 * own past sessions this one is fairly comparable to. A 5 km lunch run must not
 * be graded against a 50 km weekend ride. Cohort membership is a filtering
 * problem with a known rule, so it's SQL, not a model decision. And when the
 * cohort is too thin to support a trend claim (< MIN_COHORT_FOR_STATS), we
 * withhold the derived deltas and hand the model only the bare calendar of
 * prior sessions — a number in the prompt is an invitation to narrate a trend,
 * so we don't supply arithmetic we don't want the model leaning on.
 */
import { ECHO_AGGREGATE_SQL } from "./sql";

export const EVAL_MODEL = "@cf/zai-org/glm-5.2";

// Cohort selection knobs. The distance/speed bands are ratios around the target
// session's own values; a session qualifies only if it lands inside every band
// that applies to its sport.
const COHORT_LIMIT = 12; // most-recent N comparable sessions
const DIST_BAND_LO = 0.7;
const DIST_BAND_HI = 1.4;
const SPEED_BAND_LO = 0.7; // cycling only — separates stop-go commutes from efforts
const SPEED_BAND_HI = 1.4;
// Below this many comparators we don't trust any aggregate/trend, so the prompt
// gets a bare calendar instead of medians + ranking. CLAUDE.md: the unit of
// meaningful change is 4-8 weeks of trend, not two sessions.
const MIN_COHORT_FOR_STATS = 3;

// ── row shapes ──────────────────────────────────────────────────────────────

interface TargetRow {
  id: string;
  source_id: string;
  sport: string;
  sub_type: string | null;
  is_indoor: number | null;
  start_time: number;
  end_time: number;
  tz_offset: string | null;
  duration_sec: number | null;
  moving_sec: number | null;
  distance_m: number | null;
  pool_length_m: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  total_strokes: number | null;
  active_energy: number | null;
  avg_power_w: number | null;
  max_power_w: number | null;
  normalized_power_w: number | null;
  avg_cadence_rpm: number | null;
  elevation_gain_m: number | null;
  work_kj: number | null;
  training_stress_score: number | null;
}

interface LapRow {
  lap_num: number;
  active_sec: number | null;
  rest_after_sec: number | null;
  distance_m: number | null;
  strokes: number | null;
  pace_per_50m: number | null;
  swolf: number | null;
  avg_hr: number | null;
  equipment: string[];
}

interface CohortRow {
  source_id: string;
  start_time: number;
  tz_offset: string | null;
  distance_m: number | null;
  duration_sec: number | null;
  moving_sec: number | null;
  avg_hr: number | null;
  avg_power_w: number | null;
  total_strokes: number | null;
}

// A cohort member enriched with its computed primary metric.
interface CohortMember extends CohortRow {
  primary: number | null; // pace sec/km, or speed km/h, or null (sport w/o one)
}

interface CohortStats {
  n: number;
  fromDate: string;
  toDate: string;
  medianDistanceKm: number | null;
  medianPrimary: number | null;
  medianHr: number | null;
  // target's standing on the primary metric among the cohort
  betterThan: number | null; // count of members this session beats
  primaryLabel: string; // e.g. "pace", "speed"
}

export interface EvalContext {
  workout: TargetRow;
  laps: LapRow[];
  notesText: string | null;
  profileMd: string | null;
  focus: string[] | null;
  members: CohortMember[]; // most-recent first
  stats: CohortStats | null; // null when cohort too thin
}

// ── metric helpers ──────────────────────────────────────────────────────────

/** Timer time when the device split it out (Wahoo FIT), else wall clock. */
function elapsedSec(w: { moving_sec: number | null; duration_sec: number | null }): number | null {
  return w.moving_sec ?? w.duration_sec ?? null;
}

/** Running sub-types that get a pace primary metric. */
const RUN_LIKE = new Set(["Outdoor Run", "Indoor Run", "Outdoor Walk", "Indoor Walk"]);

type Primary = { label: string; value: (r: { distance_m: number | null; moving_sec: number | null; duration_sec: number | null }) => number | null; betterIsLower: boolean } | null;

/**
 * The single metric this session is ranked on within its cohort, by sport.
 * Swim/tennis/other get none: swim pace off elapsed time is polluted by wall
 * rest (CLAUDE.md), and the rest have no distance — those cohorts compare on
 * HR and volume only, with no ranking.
 */
function primaryFor(sport: string): Primary {
  if (sport === "cycling") {
    return {
      label: "speed",
      betterIsLower: false,
      value: (r) => {
        const t = elapsedSec(r);
        if (!r.distance_m || !t) return null;
        return r.distance_m / 1000 / (t / 3600); // km/h
      },
    };
  }
  if (sport === "running") {
    return {
      label: "pace",
      betterIsLower: true,
      value: (r) => {
        const t = elapsedSec(r);
        if (!r.distance_m || !t) return null;
        return t / (r.distance_m / 1000); // sec/km
      },
    };
  }
  return null;
}

function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function parseOffsetMin(off: string | null): number {
  if (!off) return 0;
  const m = off.match(/^([+-])(\d{2})(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10));
}

/** Local calendar date (YYYY-MM-DD) for an epoch, applying the stored offset. */
function localDate(epoch: number, off: string | null): string {
  const d = new Date((epoch + parseOffsetMin(off) * 60) * 1000);
  return d.toISOString().slice(0, 10);
}

// ── context gathering ───────────────────────────────────────────────────────

/**
 * Assemble everything the evaluation prompt needs for one workout, scoped to
 * the signed-in athlete. Returns null if the workout isn't theirs / doesn't
 * exist. The avg_hr/max_hr on both the target and cohort rows are merged from
 * the superseded Watch echo (a Wahoo ride has no strap of its own) so a ride's
 * HR isn't lost — same COALESCE the /api/workout read path uses.
 */
export async function gatherEvalContext(
  db: D1Database,
  userId: string,
  sourceId: string,
): Promise<EvalContext | null> {
  const workout = await db
    .prepare(
      `SELECT w.id, w.source_id, w.sport, w.sub_type, w.is_indoor, w.start_time, w.end_time, w.tz_offset,
              w.duration_sec, w.moving_sec, w.distance_m, w.pool_length_m,
              COALESCE(w.avg_hr, echo.avg_hr) AS avg_hr,
              COALESCE(w.max_hr, echo.max_hr) AS max_hr,
              w.total_strokes, w.active_energy,
              w.avg_power_w, w.max_power_w, w.normalized_power_w,
              w.avg_cadence_rpm, w.elevation_gain_m, w.work_kj, w.training_stress_score
         FROM workouts w
         LEFT JOIN (${ECHO_AGGREGATE_SQL}) echo ON echo.canonical_id = w.id
        WHERE w.user_id = ? AND w.source_id = ?`,
    )
    .bind(userId, sourceId)
    .first<TargetRow>();
  if (!workout) return null;

  const lapsRes = await db
    .prepare(
      `SELECT lap_num, active_sec, rest_after_sec, distance_m, strokes, pace_per_50m, swolf, avg_hr
         FROM laps WHERE workout_id = ? ORDER BY lap_num`,
    )
    .bind(workout.id)
    .all<Omit<LapRow, "equipment">>();
  const equipRes = await db
    .prepare("SELECT lap_num, equipment FROM lap_equipment WHERE workout_id = ?")
    .bind(workout.id)
    .all<{ lap_num: number; equipment: string }>();
  const byLap = new Map<number, string[]>();
  for (const e of equipRes.results ?? []) {
    const arr = byLap.get(e.lap_num) ?? [];
    arr.push(e.equipment);
    byLap.set(e.lap_num, arr);
  }
  const laps: LapRow[] = (lapsRes.results ?? []).map((l) => ({ ...l, equipment: byLap.get(l.lap_num) ?? [] }));

  const noteRow = await db
    .prepare("SELECT content_html FROM notes WHERE workout_id = ?")
    .bind(workout.id)
    .first<{ content_html: string | null }>();
  const notesText = htmlToText(noteRow?.content_html ?? null);

  const profRow = await db
    .prepare("SELECT profile_md FROM athlete_profile WHERE user_id = ?")
    .bind(userId)
    .first<{ profile_md: string | null }>();
  const profileMd = profRow?.profile_md?.trim() || null;

  const focusRow = await db
    .prepare(
      `SELECT items_json FROM session_focus
        WHERE user_id = ? AND sport = ? AND superseded_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId, workout.sport)
    .first<{ items_json: string }>();
  const focus = focusRow ? safeItems(focusRow.items_json) : null;

  const { members, stats } = await selectCohort(db, userId, workout);

  return { workout, laps, notesText, profileMd, focus, members, stats };
}

/**
 * Comparable past sessions: same sport, same sub_type, same indoor/outdoor,
 * not superseded, excluding the target itself; within a distance band (when the
 * sport has distance) and, for cycling, also within a speed band so a stop-go
 * commute isn't compared against a continuous effort of the same length.
 */
async function selectCohort(
  db: D1Database,
  userId: string,
  target: TargetRow,
): Promise<{ members: CohortMember[]; stats: CohortStats | null }> {
  const where: string[] = [
    "w.user_id = ?",
    "w.sport = ?",
    "w.superseded_by IS NULL",
    "w.id != ?",
    "IFNULL(w.sub_type,'') = IFNULL(?,'')",
    "IFNULL(w.is_indoor,0) = IFNULL(?,0)",
  ];
  const binds: unknown[] = [userId, target.sport, target.id, target.sub_type, target.is_indoor];

  if (target.distance_m && target.distance_m > 0) {
    where.push("w.distance_m BETWEEN ? AND ?");
    binds.push(target.distance_m * DIST_BAND_LO, target.distance_m * DIST_BAND_HI);
  }

  const prim = primaryFor(target.sport);
  const targetElapsed = elapsedSec(target);
  if (target.sport === "cycling" && target.distance_m && targetElapsed) {
    const targetSpeed = target.distance_m / 1000 / (targetElapsed / 3600);
    where.push(
      "(w.distance_m / CAST(COALESCE(w.moving_sec, w.duration_sec) AS REAL)) BETWEEN ? AND ?",
    );
    // band on m/s (same units on both sides); km/h vs m/s cancels in a ratio
    const targetMs = target.distance_m / targetElapsed;
    binds.push(targetMs * SPEED_BAND_LO, targetMs * SPEED_BAND_HI);
  }

  const rows = await db
    .prepare(
      `SELECT w.source_id, w.start_time, w.tz_offset, w.distance_m, w.duration_sec, w.moving_sec,
              COALESCE(w.avg_hr, echo.avg_hr) AS avg_hr, w.avg_power_w, w.total_strokes
         FROM workouts w
         LEFT JOIN (${ECHO_AGGREGATE_SQL}) echo ON echo.canonical_id = w.id
        WHERE ${where.join(" AND ")}
        ORDER BY w.start_time DESC
        LIMIT ?`,
    )
    .bind(...binds, COHORT_LIMIT)
    .all<CohortRow>();

  const members: CohortMember[] = (rows.results ?? []).map((r) => ({
    ...r,
    primary: prim ? prim.value(r) : null,
  }));

  if (members.length < MIN_COHORT_FOR_STATS) {
    return { members, stats: null };
  }

  const dates = members.map((m) => localDate(m.start_time, m.tz_offset)).sort();
  const distances = members.map((m) => m.distance_m).filter((x): x is number => x != null && x > 0);
  const hrs = members.map((m) => m.avg_hr).filter((x): x is number => x != null);
  const primaries = members.map((m) => m.primary).filter((x): x is number => x != null);

  let betterThan: number | null = null;
  if (prim) {
    const targetPrimary = prim.value(target);
    if (targetPrimary != null) {
      betterThan = members.filter((m) => {
        if (m.primary == null) return false;
        return prim.betterIsLower ? targetPrimary < m.primary : targetPrimary > m.primary;
      }).length;
    }
  }

  const stats: CohortStats = {
    n: members.length,
    fromDate: dates[0],
    toDate: dates[dates.length - 1],
    medianDistanceKm: distances.length ? round1(median(distances)! / 1000) : null,
    medianPrimary: primaries.length ? median(primaries) : null,
    medianHr: hrs.length ? Math.round(median(hrs)!) : null,
    betterThan,
    primaryLabel: prim?.label ?? "",
  };
  return { members, stats };
}

// ── prompt rendering ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an endurance-training analyst assessing ONE workout for the athlete who did it. You respond with a JSON object containing two fields, "evaluation_md" and "next_focus", described below. Output only that JSON object — no prose around it, no code fences.

"evaluation_md": a short, grounded evaluation written in the second person ("you"), 120-220 words, in markdown, with no top-level heading (the UI supplies one).

Cite only numbers that appear in the data below. Never state a specific pace, speed, heart rate, or distance for a past session unless it is explicitly listed — do not estimate or recall figures for sessions not shown. The comparison cohort is filtered to sessions of SIMILAR DISTANCE, not your whole training history, so never describe this session as your "longest", "furthest", or "fastest ever" — it is only comparable within its distance band.

Data-reliability rules for this pipeline:
- Apple Watch swim data is reliable in aggregate but noisy per lap. Prefer session aggregates; if you cite laps, note the trend (e.g. stroke-count drift), not single values. Lap 1 is unreliable (the Watch starts it late) — exclude it.
- The Watch mislabels glide-heavy freestyle (often with a pull buoy) as "Kickboard" and sometimes records zero strokes for a length; treat these as instrumentation noise. The athlete's notes OVERRIDE Watch stroke labels — trust the notes.
- Cycling speed here uses moving time when the head unit recorded it; Apple Watch rides have no moving time, so their speed reads slow by the time spent stopped. Don't compare a Watch ride's speed against a head-unit ride as equals.

Comparison discipline:
- When a cohort of comparable past sessions is provided WITH aggregate stats, compare against it: is this session stronger, weaker, or in line? A 2-second pace difference is noise; a several-second shift at similar HR sustained across sessions is real.
- When you are told the cohort is too small or too old, do NOT manufacture a trend. Evaluate the session on its own terms against the athlete's profile and focus, and say plainly there isn't yet a comparison basis.

"next_focus": 2-3 forward-looking bullet strings for the athlete's NEXT session in this sport. Each is ONE short line — a single sentence of roughly 8-16 words, second person ("you"), one actionable idea. Keep them terse and scannable: no preamble, no stacked clauses, no semicolons or dashes chaining multiple thoughts into one item, no parenthetical asides. If you can't say it in a short line, it's two items or it's cut.

CRITICAL — evolve the existing focus, do not replace it: the athlete's CURRENT focus for this sport is given in the data below. Treat it as your starting point, not a blank slate. Carry forward the items still relevant, revise the ones this session changes, and drop only the ones this session actually resolves — but if a current item is long or multi-part, COMPRESS it to a short line: keep its intent, not its length. Do not discard the current focus wholesale, and do not ignore it. Each item must be grounded in the current focus, this session, or the athlete's profile — never invented. If no current focus is given, propose a fresh set grounded in the profile and this session.`;

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s).padStart(2, "0")}s`;
}
function fmtPacePerKm(secPerKm: number | null): string {
  if (secPerKm == null) return "—";
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
function fmtPrimary(label: string, v: number | null): string {
  if (v == null) return "—";
  if (label === "pace") return fmtPacePerKm(v);
  if (label === "speed") return `${round1(v)} km/h`;
  return String(round1(v));
}

/** Render the system + user messages for the AI call. */
export function renderEvalPrompt(ctx: EvalContext): { system: string; user: string } {
  const w = ctx.workout;
  const L: string[] = [];
  const km = w.distance_m ? round1(w.distance_m / 1000) : null;
  const prim = primaryFor(w.sport);
  const targetPrimary = prim ? prim.value(w) : null;

  L.push("## Athlete profile");
  L.push(ctx.profileMd || "(not filled in)");
  L.push("");

  L.push(`## Current focus (${w.sport})`);
  L.push(ctx.focus && ctx.focus.length ? ctx.focus.map((f) => `- ${f}`).join("\n") : "(none set)");
  L.push("");

  L.push("## This session");
  L.push(`- Sport: ${w.sport}${w.sub_type ? ` (${w.sub_type})` : ""}${w.is_indoor ? ", indoor" : ""}`);
  L.push(`- Date: ${localDate(w.start_time, w.tz_offset)}`);
  if (km != null) L.push(`- Distance: ${km} km`);
  const elapsed = elapsedSec(w);
  if (w.moving_sec != null && w.duration_sec != null && w.moving_sec !== w.duration_sec) {
    L.push(`- Moving time: ${fmtDuration(w.moving_sec)} (elapsed ${fmtDuration(w.duration_sec)}, stopped ${fmtDuration(w.duration_sec - w.moving_sec)})`);
  } else {
    L.push(`- Duration: ${fmtDuration(elapsed)}`);
  }
  if (targetPrimary != null) L.push(`- ${cap(prim!.label)}: ${fmtPrimary(prim!.label, targetPrimary)}`);
  if (w.avg_hr != null) L.push(`- Avg HR: ${Math.round(w.avg_hr)} bpm${w.max_hr != null ? `, max ${w.max_hr}` : ""}`);
  if (w.avg_power_w != null) L.push(`- Power: avg ${Math.round(w.avg_power_w)} W${w.normalized_power_w != null ? `, NP ${Math.round(w.normalized_power_w)} W` : ""}${w.max_power_w != null ? `, max ${Math.round(w.max_power_w)} W` : ""}`);
  if (w.training_stress_score != null) L.push(`- TSS: ${Math.round(w.training_stress_score)}`);
  if (w.avg_cadence_rpm != null) L.push(`- Avg cadence: ${Math.round(w.avg_cadence_rpm)} rpm`);
  if (w.elevation_gain_m != null) L.push(`- Elevation gain: ${Math.round(w.elevation_gain_m)} m`);
  if (w.total_strokes != null) L.push(`- Total strokes: ${w.total_strokes}`);
  if (w.pool_length_m != null) L.push(`- Pool length: ${w.pool_length_m} m`);
  if (w.active_energy != null) L.push(`- Active energy: ${Math.round(w.active_energy)} kcal`);
  L.push("");

  if (ctx.notesText) {
    L.push("## Athlete's notes (authoritative — override Watch labels)");
    L.push(ctx.notesText);
    L.push("");
  }

  // Swim laps: stroke-count-per-50m drift is the single most informative view
  // (CLAUDE.md). Render it for swims; skip the lap dump for other sports where
  // the session aggregates above carry the signal.
  if (w.sport === "swimming" && ctx.laps.length) {
    L.push("## Laps (lap 1 unreliable — exclude from per-lap reads)");
    L.push("lap | dist | strokes | pace/50m | swolf | hr | equipment");
    for (const l of ctx.laps) {
      const pace = l.pace_per_50m != null ? `${Math.floor(l.pace_per_50m / 60)}:${String(Math.round(l.pace_per_50m % 60)).padStart(2, "0")}` : "—";
      L.push(
        `${l.lap_num} | ${l.distance_m ?? "—"}m | ${l.strokes ?? "—"} | ${pace} | ${l.swolf ?? "—"} | ${l.avg_hr != null ? Math.round(l.avg_hr) : "—"} | ${l.equipment.join("+") || "-"}`,
      );
    }
    L.push("");
  }

  // Cohort block: aggregates when we trust them, bare calendar when we don't.
  L.push("## Comparison cohort (your own past sessions)");
  if (ctx.stats) {
    const s = ctx.stats;
    L.push(`${s.n} comparable sessions, ${s.fromDate} to ${s.toDate}.`);
    if (s.medianDistanceKm != null) L.push(`- Median distance: ${s.medianDistanceKm} km`);
    if (s.medianPrimary != null) L.push(`- Median ${s.primaryLabel}: ${fmtPrimary(s.primaryLabel, s.medianPrimary)}`);
    if (s.medianHr != null) L.push(`- Median avg HR: ${s.medianHr} bpm`);
    if (s.betterThan != null) {
      L.push(`- This session's ${s.primaryLabel} beats ${s.betterThan} of ${s.n} of them.`);
    }
  } else if (ctx.members.length) {
    L.push(
      `Only ${ctx.members.length} comparable prior session(s) on record — too few for a trend. ` +
        `Do not infer a trajectory. Prior sessions (date · distance), for context only:`,
    );
    for (const m of ctx.members) {
      L.push(`- ${localDate(m.start_time, m.tz_offset)} · ${m.distance_m ? round1(m.distance_m / 1000) + " km" : "—"}`);
    }
  } else {
    L.push("No comparable prior sessions on record. Evaluate this one on its own terms; there is no comparison basis yet.");
  }

  return { system: SYSTEM_PROMPT, user: L.join("\n") };
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

// ── AI call + persistence ───────────────────────────────────────────────────

// Structured-output contract: the model returns this JSON object rather than
// raw markdown, so the forward-looking focus comes back as a validated string
// array instead of prose we'd have to parse. next_focus is bounded to 2-4 items
// (see the CRITICAL "evolve the existing focus" instruction in SYSTEM_PROMPT).
const EVAL_SCHEMA = {
  type: "object",
  properties: {
    evaluation_md: { type: "string" },
    next_focus: {
      type: "array",
      items: { type: "string", maxLength: 120 },
      minItems: 2,
      maxItems: 3,
    },
  },
  required: ["evaluation_md", "next_focus"],
};

export interface EvalResult {
  evaluationMd: string;
  nextFocus: string[];
}

/** Grab the first {...} block, so a model that wraps its JSON still parses. */
function extractJsonObject(s: string): string {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return a >= 0 && b > a ? s.slice(a, b + 1) : s;
}

/**
 * Coerce whatever Workers AI hands back into the parsed object. With
 * response_format the `.response` is usually the object already; some paths
 * return it as a JSON string, or nest it under choices[].message.content — and
 * a model that ignores response_format returns prose containing the JSON, which
 * extractJsonObject recovers.
 */
function parseStructured(out: unknown): { evaluation_md?: unknown; next_focus?: unknown } {
  let r: unknown = out;
  if (r && typeof r === "object") {
    const o = r as Record<string, unknown>;
    if ("response" in o) r = o.response;
    else if ("choices" in o) {
      const choices = o.choices as Array<{ message?: { content?: unknown } }> | undefined;
      r = choices?.[0]?.message?.content ?? r;
    }
  }
  if (typeof r === "string") r = JSON.parse(extractJsonObject(r));
  if (!r || typeof r !== "object") throw new Error("model output was not a JSON object");
  return r as Record<string, unknown>;
}

/**
 * Run the model for one assembled context, returning both the evaluation
 * markdown and the evolved next-session focus. Throws on AI error, unparseable
 * output, or an empty evaluation.
 */
export async function runEvaluation(ai: Ai, ctx: EvalContext): Promise<EvalResult> {
  const { system, user } = renderEvalPrompt(ctx);
  const out = await ai.run(EVAL_MODEL as keyof AiModels, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // glm-5.2 is a reasoning model: its hidden reasoning_content draws from the
    // same max_tokens budget as the visible answer, so this has to cover BOTH
    // the chain-of-thought and the JSON payload. Too low and the reasoning eats
    // the budget, truncating the JSON mid-string (parse then throws). Generous
    // headroom; the eval + focus themselves are only ~300 tokens.
    max_tokens: 3072,
    temperature: 0.2,
    response_format: { type: "json_schema", json_schema: EVAL_SCHEMA },
  } as never);
  const parsed = parseStructured(out);
  const evaluationMd = typeof parsed.evaluation_md === "string" ? parsed.evaluation_md.trim() : "";
  if (!evaluationMd) throw new Error("model returned an empty evaluation");
  const nextFocus = Array.isArray(parsed.next_focus)
    ? parsed.next_focus.map((s) => String(s).trim()).filter(Boolean).slice(0, 3)
    : [];
  return { evaluationMd, nextFocus };
}

/**
 * Upsert the evaluation into session_evals — the same table and one-per-workout
 * shape the MCP server's set_session_eval writes to (mcp/src/db.ts). A button
 * run and a Claude-in-chat run simply overwrite each other; there is no second
 * writer to coordinate with beyond that.
 */
export async function persistEval(
  db: D1Database,
  userId: string,
  workoutId: string,
  contentMd: string,
  generatedBy: string,
): Promise<{ updated_at: number }> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO session_evals (workout_id, user_id, content_md, generated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(workout_id) DO UPDATE SET
         content_md   = excluded.content_md,
         generated_by = excluded.generated_by,
         updated_at   = excluded.updated_at`,
    )
    .bind(workoutId, userId, contentMd, generatedBy, now, now)
    .run();
  return { updated_at: now };
}

/**
 * Set the next-session focus for a sport — the append-with-supersede write the
 * MCP server's set_next_focus uses (mcp/src/db.ts): stamp superseded_at on the
 * current live row(s) and insert a new live one, so there's only ever one live
 * focus per (user, sport) and a full history behind it. Attributed to the
 * workout the evaluation ran on, which lights up the UI's "from this session".
 */
export async function persistFocus(
  db: D1Database,
  userId: string,
  sport: string,
  items: string[],
  setByWorkoutId: string,
): Promise<{ created_at: number }> {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db
      .prepare(
        `UPDATE session_focus SET superseded_at = ?
          WHERE user_id = ? AND sport = ? AND superseded_at IS NULL`,
      )
      .bind(now, userId, sport),
    db
      .prepare(
        `INSERT INTO session_focus (id, user_id, sport, items_json, set_by_workout_id, created_at, superseded_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(crypto.randomUUID(), userId, sport, JSON.stringify(items), setByWorkoutId, now),
  ]);
  return { created_at: now };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function safeItems(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Flatten the notes' stored HTML to plain text for the prompt. The notes are
 * authored in a Tiptap/ProseMirror editor and stored as both JSON and HTML;
 * HTML is the easier faithful source to strip. Block-level tags become newlines
 * and list items get a bullet so structure survives roughly intact.
 */
function htmlToText(htmlStr: string | null): string | null {
  if (!htmlStr) return null;
  const withBreaks = htmlStr
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const text = withBreaks.replace(/<[^>]+>/g, "");
  const decoded = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
  return decoded.replace(/\n{3,}/g, "\n\n").replace(/[ \t]+\n/g, "\n").trim() || null;
}
