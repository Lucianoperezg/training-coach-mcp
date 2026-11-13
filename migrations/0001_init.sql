CREATE TABLE IF NOT EXISTS activities (
    id              TEXT PRIMARY KEY,
    start_local     TEXT,
    sport           TEXT,
    name            TEXT,
    distance_m      REAL,
    moving_s        INTEGER,
    elapsed_s       INTEGER,
    elev_gain_m     REAL,
    avg_hr          REAL,
    max_hr          REAL,
    avg_cadence     REAL,
    avg_speed_ms    REAL,
    avg_watts       REAL,
    training_load   REAL,
    intensity       REAL,
    raw             TEXT,
    synced_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_act_start ON activities(start_local);
CREATE INDEX IF NOT EXISTS idx_act_sport ON activities(sport);

CREATE TABLE IF NOT EXISTS wellness (
    date        TEXT PRIMARY KEY,
    ctl         REAL,
    atl         REAL,
    ramp_rate   REAL,
    resting_hr  REAL,
    hrv         REAL,
    sleep_s     REAL,
    weight      REAL,
    raw         TEXT
);

CREATE TABLE IF NOT EXISTS gym_workouts (
    id          TEXT PRIMARY KEY,
    title       TEXT,
    start_time  TEXT,
    end_time    TEXT,
    duration_s  INTEGER,
    raw         TEXT,
    updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_gym_start ON gym_workouts(start_time);

CREATE TABLE IF NOT EXISTS gym_sets (
    workout_id      TEXT NOT NULL,
    exercise_index  INTEGER NOT NULL,
    set_index       INTEGER NOT NULL,
    exercise        TEXT,
    template_id     TEXT,
    set_type        TEXT,
    weight_kg       REAL,
    reps            INTEGER,
    distance_m      REAL,
    duration_s      INTEGER,
    rpe             REAL,
    start_time      TEXT,
    PRIMARY KEY (workout_id, exercise_index, set_index)
);
CREATE INDEX IF NOT EXISTS idx_sets_ex ON gym_sets(exercise);

CREATE TABLE IF NOT EXISTS sync_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);
