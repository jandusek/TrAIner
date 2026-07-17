-- GPS route track for outdoor workouts (cycling, running).
--
-- Populated from two sources, both normalized to plain WGS84 lat/lon degrees
-- (see src/route.ts):
--   * Wahoo FIT `recordMesgs` — positionLat/positionLong in semicircles,
--     converted to degrees on ingest. The canonical track for cycling.
--   * HAE workout `route[]` — Apple Watch GPS for runs (and cycling watch
--     echoes, which supersession hides in favor of the Wahoo copy).
--
-- Swims and tennis have no route; indoor rides/runs simply produce zero rows.
--
-- Route points are derived data, same contract as `laps`: ingest deletes a
-- workout's points and rewrites them, so reprocessing after a parser change is
-- just a re-ingest from the R2 archive. Stored thinned to a generous cap on
-- ingest (STORE_MAX_ROUTE_POINTS in store.ts) so a single ride stays bounded;
-- the API thins further for display (see /api/route in index.ts). The raw R2
-- archive keeps every original sample if full fidelity is ever needed.
--
-- No separate index: the PRIMARY KEY (workout_id, seq) already covers the only
-- access pattern (fetch one workout's points in order), same reasoning as the
-- redundant-index note in 0009_supersession.sql.
CREATE TABLE route_points (
  workout_id   TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,          -- 0-based order along the track
  ts           INTEGER,                   -- unix epoch seconds, UTC (null if source omits)
  lat          REAL NOT NULL,             -- WGS84 degrees, [-90, 90]
  lon          REAL NOT NULL,             -- WGS84 degrees, [-180, 180]
  elevation_m  REAL,                      -- meters above sea level, if recorded
  PRIMARY KEY (workout_id, seq)
);
