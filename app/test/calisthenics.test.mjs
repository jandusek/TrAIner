/**
 * Autoregulation engine tests. Run with: npm test
 *
 * calisthenics.ts is TypeScript; bundle with esbuild and import the result,
 * same pattern as laps.test.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

const bundle = await build({
  entryPoints: [join(here, "../src/calisthenics.ts")],
  bundle: true,
  format: "esm",
  write: false,
  platform: "neutral",
});
const { computePrescription, summarizeSessions } = await import(
  "data:text/javascript," + encodeURIComponent(bundle.outputFiles[0].text)
);

const DAY = 86400;
const NOW = Date.parse("2026-07-04T00:00:00Z") / 1000;

function session(daysAgo, sets) {
  return { workout_id: `w${daysAgo}`, source_id: `s${daysAgo}`, start_time: NOW - daysAgo * DAY, sets };
}
function set(set_num, reps, rir, is_amrap = false) {
  return { set_num, reps, rir, is_amrap };
}

test("no history: bootstraps to the default baseline and flags an AMRAP due", () => {
  const p = computePrescription("pullup", [], NOW);
  assert.equal(p.target_sets, 5);
  assert.equal(p.target_reps, 5);
  assert.equal(p.amrap_due, true);
  assert.equal(p.gap_days, null);
});

test("same-day/next-day retrain: progresses one rep from a top set at RIR 1-3", () => {
  const history = [session(1, [set(1, 8, 2), set(2, 7, 1), set(3, 6, 1)])];
  const p = computePrescription("pullup", history, NOW);
  assert.equal(p.target_reps, 9); // top set was 8 reps @ RIR 2 -> +1
  assert.equal(p.gap_days, 1);
});

test("top set at RIR 0 holds rather than pushing blind", () => {
  const history = [session(1, [set(1, 8, 0)])];
  const p = computePrescription("pullup", history, NOW);
  assert.equal(p.target_reps, 8);
});

test("top set at RIR 4+ (too easy) corrects with a bigger jump", () => {
  const history = [session(1, [set(1, 8, 5)])];
  const p = computePrescription("pullup", history, NOW);
  assert.equal(p.target_reps, 10);
});

test("3-4 day gap: repeats the last top set instead of progressing", () => {
  const history = [session(4, [set(1, 8, 2)])];
  const p = computePrescription("pullup", history, NOW);
  assert.equal(p.target_reps, 8);
  assert.match(p.note, /repeating/);
});

test("5-13 day gap: eases back in around 85% of last top set", () => {
  const history = [session(10, [set(1, 10, 2)])];
  const p = computePrescription("pullup", history, NOW);
  assert.equal(p.target_reps, 9); // round(10*0.85) = 9 (>= floor since no amrap on record)
});

test("14+ day gap: soft restart around 70% and forces an AMRAP retest", () => {
  const history = [session(20, [set(1, 10, 2)])];
  const p = computePrescription("pullup", history, NOW);
  assert.equal(p.target_reps, 7); // round(10*0.7)
  assert.equal(p.amrap_due, true);
});

test("floor never lets the prescription drop below 65% of best-ever AMRAP", () => {
  // Best-ever AMRAP is 20; floor = ceil(20*0.65) = 13. A 30-day layoff off a
  // recent weak top set (5 reps) would otherwise soft-restart to 4 — the
  // floor should override that down to 13.
  const history = [
    session(200, [set(1, 20, 0, true)]), // historic AMRAP best
    session(30, [set(1, 5, 2)]),
  ];
  const p = computePrescription("pullup", history, NOW);
  assert.equal(p.best_amrap_reps, 20);
  assert.equal(p.floor_reps, 13);
  assert.equal(p.target_reps, 13);
  assert.match(p.note, /Floor applied/);
});

test("AMRAP due after 10+ days since the last AMRAP-flagged session, even with recent regular sessions", () => {
  const history = [
    session(1, [set(1, 8, 2)]),
    session(15, [set(1, 10, 0, true)]), // last AMRAP was 15 days ago
  ];
  const p = computePrescription("pullup", history, NOW);
  assert.equal(p.amrap_due, true);
});

test("push-ups use their own default baseline and target sets follow the last session's set count", () => {
  const bootstrap = computePrescription("pushup", [], NOW);
  assert.equal(bootstrap.target_sets, 4);
  assert.equal(bootstrap.target_reps, 10);

  const history = [session(1, [set(1, 12, 2), set(2, 10, 2), set(3, 9, 1), set(4, 8, 1), set(5, 8, 1)])];
  const p = computePrescription("pushup", history, NOW);
  assert.equal(p.target_sets, 5);
});

// ── per-set target sequence (every logged RIR drives its own set) ──────────

test("bootstrap prescription carries a flat per-set sequence", () => {
  const p = computePrescription("pullup", [], NOW);
  assert.deepEqual(p.target_sequence, [5, 5, 5, 5, 5]);
  assert.equal(p.last_sequence, null);
});

test("each set progresses off its own RIR, preserving the session shape", () => {
  // 12 @ RIR 2 (+1), 10 @ RIR 4 (under-challenged, +2), 8 @ RIR 0 (hold)
  const history = [session(1, [set(1, 12, 2), set(2, 10, 4), set(3, 8, 0)])];
  const p = computePrescription("pushup", history, NOW);
  assert.deepEqual(p.last_sequence, [12, 10, 8]);
  assert.deepEqual(p.target_sequence, [13, 12, 8]);
  assert.equal(p.target_sets, 3);
  assert.equal(p.target_reps, 13); // top of the sequence
});

test("an AMRAP set within the session holds its reps while the others progress", () => {
  const history = [session(1, [set(1, 15, null, true), set(2, 10, 2)])];
  const p = computePrescription("pushup", history, NOW);
  assert.deepEqual(p.target_sequence, [15, 11]);
});

test("gap easing scales the whole sequence, not just the top set", () => {
  const history = [session(10, [set(1, 20, 2), set(2, 16, 1), set(3, 12, 1)])];
  const p = computePrescription("pushup", history, NOW);
  assert.deepEqual(p.target_sequence, [17, 14, 10]); // each round(r * 0.85)
});

test("floor rescales the whole sequence up while preserving its shape", () => {
  const history = [
    session(200, [set(1, 20, 0, true)]), // best-ever AMRAP 20 -> floor 13
    session(30, [set(1, 5, 2), set(2, 4, 2), set(3, 3, 1)]),
  ];
  const p = computePrescription("pullup", history, NOW);
  // 30-day soft restart: [4, 3, 2]; top 4 < floor 13 -> scale by 13/4.
  assert.deepEqual(p.target_sequence, [13, 10, 7]);
  assert.equal(p.target_reps, 13);
  assert.match(p.note, /Floor applied/);
});

test("sequence follows set_num order regardless of stored row order", () => {
  const history = [session(1, [set(3, 8, 1), set(1, 12, 2), set(2, 10, 2)])];
  const p = computePrescription("pushup", history, NOW);
  assert.deepEqual(p.last_sequence, [12, 10, 8]);
  assert.deepEqual(p.target_sequence, [13, 11, 9]);
});

// ── summarizeSessions (per-session card stats: rep sequence + effort %) ────

test("summarizeSessions: first-ever session has no prior best, so no effort_pct", () => {
  const [first] = summarizeSessions([session(10, [set(1, 8, 2), set(2, 6, 1)])]);
  assert.equal(first.sequence, "8-6");
  assert.equal(first.top_reps, 8);
  assert.equal(first.effective_reps, 10); // 8 + rir 2
  assert.equal(first.best_ever_prior, null);
  assert.equal(first.effort_pct, null);
});

test("summarizeSessions: matching the prior best exactly scores 100%", () => {
  const history = [session(10, [set(1, 8, 2)]), session(5, [set(1, 10, 0)])];
  const [, second] = summarizeSessions(history);
  // first session's effective_reps = 8+2 = 10; second matches it at RIR 0.
  assert.equal(second.best_ever_prior, 10);
  assert.equal(second.effective_reps, 10);
  assert.equal(second.effort_pct, 100);
});

test("summarizeSessions: same rep count at a higher RIR scores below a session done closer to failure", () => {
  const history = [session(10, [set(1, 10, 0)])]; // sets the bar at effective 10
  const easy = summarizeSessions([...history, session(5, [set(1, 10, 4)])]); // same 10 reps, RIR 4
  const hard = summarizeSessions([...history, session(5, [set(1, 8, 0)])]); // fewer reps, but to failure
  assert.ok(easy[1].effort_pct > 100); // 14 effective vs bar of 10
  assert.ok(hard[1].effort_pct < 100); // 8 effective vs bar of 10
});

test("summarizeSessions: an AMRAP set uses raw reps, ignoring any rir field", () => {
  const [only] = summarizeSessions([session(1, [set(1, 12, 3, true)])]);
  assert.equal(only.effective_reps, 12);
});

test("summarizeSessions: best_ever_prior only ever looks backward, never at a later session's result", () => {
  const history = [
    session(10, [set(1, 5, 2)]), // effective 7 — modest first session
    session(5, [set(1, 20, 0, true)]), // a big AMRAP jump
  ];
  const [firstStats] = summarizeSessions(history);
  // The first session's score must not be judged against the later AMRAP.
  assert.equal(firstStats.best_ever_prior, null);
  assert.equal(firstStats.effort_pct, null);
});
