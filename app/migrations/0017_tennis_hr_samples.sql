-- Per-~5s HR for tennis, so the detail page can show a heart-rate-zones
-- breakdown and a line chart, same as swim/running. Same source field
-- (`heartRateData`) and same extraction function (extractHaeHrSamples)
-- already used for swim_hr_samples/running_hr_samples/cycling_samples's
-- watch-echo rows — tennis is HAE-only, same as swim.
--
-- Kept as its own table for the same reason swim_hr_samples/
-- running_hr_samples are: no second source to merge against, so the
-- (workout_id, t, source) shape cycling_samples needs doesn't apply here.
--
-- Derived data, same contract as `laps`/`swim_hr_samples`: safe to delete +
-- rebuild from R2 on re-ingest.
CREATE TABLE tennis_hr_samples (
  workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  t          INTEGER NOT NULL,
  hr         INTEGER NOT NULL,
  PRIMARY KEY (workout_id, t)
);
