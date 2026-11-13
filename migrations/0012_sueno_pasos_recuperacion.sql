-- Sueño, pasos, recuperación de FC y polarización, leídos de lo que ya está guardado en raw (intervals.icu).
-- Solo añade. Son VIRTUAL: no hay que rellenarlas ni se descarga nada. NULL = intervals no lo da ese día o actividad.

-- --- wellness ---------------------------------------------------------------
-- Puntuación de sueño del reloj. Va ligada a sleep_quality: a menor calidad (número), mejor puntuación
ALTER TABLE wellness ADD COLUMN sleep_score REAL GENERATED ALWAYS AS (json_extract(raw, '$.sleepScore')) VIRTUAL;
ALTER TABLE wellness ADD COLUMN sleep_quality INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.sleepQuality')) VIRTUAL;
ALTER TABLE wellness ADD COLUMN avg_sleeping_hr REAL GENERATED ALWAYS AS (json_extract(raw, '$.avgSleepingHR')) VIRTUAL;
ALTER TABLE wellness ADD COLUMN steps INTEGER GENERATED ALWAYS AS (json_extract(raw, '$.steps')) VIRTUAL;

-- --- activities -------------------------------------------------------------
-- Recuperación de FC de intervals (icu_hrr): caída en una ventana de 60 s. No sale en todas las actividades
ALTER TABLE activities ADD COLUMN hrr_start_bpm REAL GENERATED ALWAYS AS (json_extract(raw, '$.icu_hrr.start_bpm')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hrr_end_bpm REAL GENERATED ALWAYS AS (json_extract(raw, '$.icu_hrr.end_bpm')) VIRTUAL;
ALTER TABLE activities ADD COLUMN hrr_bpm REAL GENERATED ALWAYS AS (json_extract(raw, '$.icu_hrr.hrr')) VIRTUAL;
ALTER TABLE activities ADD COLUMN polarization_index REAL GENERATED ALWAYS AS (json_extract(raw, '$.polarization_index')) VIRTUAL;

-- Mismas vistas con las columnas nuevas al final (una vista no guarda datos)
DROP VIEW IF EXISTS v_wellness;
CREATE VIEW v_wellness AS
SELECT date, ctl, atl, ctl - atl AS tsb, ramp_rate, resting_hr, hrv, round(sleep_s / 3600.0, 2) AS sleep_h, weight,
       sleep_score, sleep_quality, avg_sleeping_hr, steps
FROM wellness;

DROP VIEW IF EXISTS v_activities;
CREATE VIEW v_activities AS
SELECT id, date, start_local, sport, name, distance_m, moving_s, elapsed_s, elev_gain_m, elev_loss_m,
       avg_hr, max_hr, cadence_spm, avg_speed_ms, gap_ms, stride_m, avg_watts, training_load, intensity,
       trimp, feel, temp_avg, calories, decoupling, lthr_used, aerobic_eff,
       hr_z1_s, hr_z2_s, hr_z3_s, hr_z4_s, hr_z5_s, hr_z6_s, hr_z7_s,
       fc_media, fc_marcha, eficiencia,
       fc_z1_s, fc_z2_s, fc_z3_s, fc_z4_s, fc_z5_s, fc_z6_s, fc_z7_s,
       hrr_start_bpm, hrr_end_bpm, hrr_bpm, polarization_index
FROM activities;
