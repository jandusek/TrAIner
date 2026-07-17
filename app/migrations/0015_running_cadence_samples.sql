-- Derived per-interval cadence for runs, so the detail page can chart cadence
-- across the session (see CLAUDE.md's running section and parse.ts's
-- extractHaeStepCountSamples). HAE has no per-second running cadence stream —
-- `stepCadence` is a single session-average QuantityData — so this is
-- reconstructed from the `stepCount` interval array the same way laps.ts
-- reconstructs swim laps from cumulative distance: steps in an interval,
-- divided by that interval's duration.
--
-- Unverified against real data: no run has been ingested yet (see route.ts's
-- same caveat on the GPS track). Confirm the derivation once the first real
-- run lands.
--
-- Derived data, same contract as `swim_hr_samples`/`cycling_samples`: safe to
-- delete + rebuild from R2 on re-ingest.
CREATE TABLE running_cadence_samples (
  workout_id  TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  t           INTEGER NOT NULL,
  cadence_spm INTEGER NOT NULL,
  PRIMARY KEY (workout_id, t)
);
