-- Rest taken before each set, self-timed by the logger UI (see
-- calisthenics.client.js's rest countdown). NULL for a session's first set
-- (no prior set to rest from) and for anything logged before this column
-- existed. Lets the workout detail page and any future analysis show actual
-- rest alongside reps/RIR, not just the prescribed target.
ALTER TABLE calisthenics_sets ADD COLUMN rest_before_sec INTEGER;
