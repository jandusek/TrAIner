-- Cross-source duplicate handling. A ride recorded on Wahoo can also land as
-- an HAE row if the ELEMNT app writes it into Apple Health and Health Auto
-- Export re-exports it — same physical ride, two independent `workouts` rows
-- (HAE and Wahoo each only dedup against themselves, via source_id).
--
-- Rather than deleting or merging, the weaker row is marked `superseded_by`
-- the stronger one and excluded from the main list (see /api/workouts in
-- index.ts) — the data stays queryable, just hidden from the everyday view.
-- Wahoo/FIT is always treated as canonical over an HAE echo when both exist
-- for the same user+sport+overlapping start_time (native laps, often power;
-- confirmed 2026-07-01 that an HAE echo of a Wahoo ride carries no additional
-- data — distance/avg_hr/max_hr/active_energy/temperature were all null).

ALTER TABLE workouts ADD COLUMN superseded_by TEXT REFERENCES workouts(id) ON DELETE SET NULL;

-- No new index needed for the overlap-detection query (user_id, sport,
-- start_time) — idx_workouts_user_sport_start from 0002_workouts.sql already
-- covers exactly those columns in that order.
