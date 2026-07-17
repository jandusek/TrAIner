-- Per-~5s HR for runs, so the detail page can chart heart rate alongside
-- cadence (see detail.client.js's cross-chart hover sync — the two are
-- meant to be read together). Same source field (`heartRateData`) and same
-- extraction function (extractHaeHrSamples) already used for swim_hr_samples
-- and cycling_samples's watch-echo rows — running is the third and last HAE
-- sport that carries this stream but didn't have a table for it yet.
--
-- Kept as its own table for the same reason swim_hr_samples is: no second
-- source to merge against, so the (workout_id, t, source) shape
-- cycling_samples needs doesn't apply here.
--
-- Derived data, same contract as `laps`/`running_cadence_samples`: safe to
-- delete + rebuild from R2 on re-ingest.
CREATE TABLE running_hr_samples (
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  t          INTEGER NOT NULL,
  hr         INTEGER NOT NULL,
  PRIMARY KEY (workout_id, t)
);
