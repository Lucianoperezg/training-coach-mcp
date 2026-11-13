-- Fase 1: columnas derivadas, fecha local, tablas del entrenador y vistas sin raw.
-- Solo añade cosas. Las columnas derivadas de raw son VIRTUAL: no hay que rellenarlas
-- y la lógica vive solo aquí.

-- --- activities: derivadas de raw (intervals.icu) ---------------------------
ALTER TABLE activities ADD COLUMN date TEXT GENERATED ALWAYS AS (substr(start_local, 1, 10)) VIRTUAL;
-- intervals.icu da la cadencia de carrera en ciclos/min (una pierna): x2 para pasos/min
ALTER TABLE activities ADD COLUMN cadence_spm REAL GENERATED ALWAYS AS (
  CASE WHEN sport IN ('Run', 'TrailRun', 'VirtualRun', 'Walk', 'Hike') THEN round(avg_cadence * 2, 1)
       ELSE round(avg_cadence, 1) END) VIRTUAL;
ALTER TABLE activities ADD COLUMN gap_ms REAL GENERATED ALWAYS AS (json_extract(raw, '$.gap')) VIRTUAL;
ALTER TABLE activities ADD COLUMN stride_m REAL GENERATED ALWAYS AS (json_extract(raw, '$.average_stride')) VIRTUAL;
ALTER TABLE activities ADD COLUMN elev_loss_m REAL GENERATED ALWAYS AS (json_extract(raw, '$.total_elevation_loss')) VIRTUAL;
ALTER TABLE activities ADD COLUMN trimp REAL GENERATED ALWAYS AS (json_extract(raw, '$.trimp')) VIRTUAL;
ALTER TABLE activities ADD COLUMN feel INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.feel')) VIRTUAL;
ALTER TABLE activities ADD COLUMN temp_avg REAL GENERATED ALWAYS AS (json_extract(raw, '$.average_temp')) VIRTUAL;
ALTER TABLE activities ADD COLUMN calories REAL GENERATED ALWAYS AS (json_extract(raw, '$.calories')) VIRTUAL;
ALTER TABLE activities ADD COLUMN decoupling REAL GENERATED ALWAYS AS (json_extract(raw, '$.decoupling')) VIRTUAL;
ALTER TABLE activities ADD COLUMN lthr_used REAL GENERATED ALWAYS AS (json_extract(raw, '$.lthr')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hr_z1_s INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.icu_hr_zone_times[0]')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hr_z2_s INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.icu_hr_zone_times[1]')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hr_z3_s INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.icu_hr_zone_times[2]')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hr_z4_s INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.icu_hr_zone_times[3]')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hr_z5_s INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.icu_hr_zone_times[4]')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hr_z6_s INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.icu_hr_zone_times[5]')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hr_z7_s INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.icu_hr_zone_times[6]')) VIRTUAL;
-- Metros por latido (con GAP). Solo carrera/caminata con distancia real: la cinta sin distancia queda en NULL
ALTER TABLE activities ADD COLUMN aerobic_eff REAL GENERATED ALWAYS AS (
  CASE WHEN sport IN ('Run', 'TrailRun', 'VirtualRun', 'Walk', 'Hike')
        AND distance_m >= 1000 AND avg_speed_ms >= 1.5 AND avg_hr > 0
       THEN round(coalesce(json_extract(raw, '$.gap'), avg_speed_ms) * 60.0 / avg_hr, 3) END) VIRTUAL;
-- Estado del cálculo de splits (fase 2): NULL/pendiente/ok/error
ALTER TABLE activities ADD COLUMN splits_estado TEXT;

CREATE INDEX IF NOT EXISTS idx_act_date ON activities(date);
CREATE INDEX IF NOT EXISTS idx_act_sport_date ON activities(sport, date);

-- --- gimnasio: fecha local (Hevy guarda UTC; se calcula al sincronizar con TZ) ---
ALTER TABLE gym_workouts ADD COLUMN date TEXT;
CREATE INDEX IF NOT EXISTS idx_gym_date ON gym_workouts(date);
CREATE INDEX IF NOT EXISTS idx_sets_template ON gym_sets(template_id);
-- Reimporta Hevy en el siguiente cron para rellenar la fecha local (es idempotente)
DELETE FROM sync_state WHERE key IN ('hevy_since', 'hevy_page', 'hevy_backfill_started');

-- --- tablas del entrenador (se usan a partir de la fase 2) ------------------
CREATE TABLE IF NOT EXISTS activity_splits (
    activity_id  TEXT NOT NULL,
    km           INTEGER NOT NULL,
    pace_s       REAL,
    gap_s        REAL,
    hr           REAL,
    cadence_spm  REAL,
    elev_m       REAL,
    PRIMARY KEY (activity_id, km)
);

CREATE TABLE IF NOT EXISTS exercise_templates (
    id                 TEXT PRIMARY KEY,
    title              TEXT,
    primary_muscle     TEXT,
    secondary_muscles  TEXT,
    equipment          TEXT
);

CREATE TABLE IF NOT EXISTS notas (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha     TEXT NOT NULL,
    tipo      TEXT,
    texto     TEXT NOT NULL,
    estado    TEXT NOT NULL DEFAULT 'abierta',
    revisada  TEXT
);

CREATE TABLE IF NOT EXISTS alertas_vistas (
    clave  TEXT PRIMARY KEY,
    fecha  TEXT NOT NULL
);

-- --- vistas sin raw (consulta_sql las usará en exclusiva en la fase 4) ------
CREATE VIEW IF NOT EXISTS v_activities AS
SELECT id, date, start_local, sport, name, distance_m, moving_s, elapsed_s, elev_gain_m, elev_loss_m,
       avg_hr, max_hr, cadence_spm, avg_speed_ms, gap_ms, stride_m, avg_watts, training_load, intensity,
       trimp, feel, temp_avg, calories, decoupling, lthr_used, aerobic_eff,
       hr_z1_s, hr_z2_s, hr_z3_s, hr_z4_s, hr_z5_s, hr_z6_s, hr_z7_s
FROM activities;

-- Una fila por serie. metrica: cómo se mide el ejercicio (peso, reps con peso corporal o tiempo)
CREATE VIEW IF NOT EXISTS v_gym AS
SELECT s.workout_id, w.date, w.start_time, w.title AS workout, s.template_id, s.exercise,
       s.exercise_index, s.set_index, s.set_type, s.weight_kg, s.reps, s.duration_s, s.distance_m, s.rpe,
       CASE WHEN s.weight_kg > 0 THEN 'peso' WHEN s.duration_s > 0 THEN 'tiempo' WHEN s.reps > 0 THEN 'reps' END AS metrica,
       CASE WHEN s.weight_kg > 0 AND s.reps > 0 THEN round(s.weight_kg * (1 + s.reps / 30.0), 1) END AS e1rm
FROM gym_sets s JOIN gym_workouts w ON w.id = s.workout_id;
