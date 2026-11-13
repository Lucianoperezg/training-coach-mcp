-- FC media y tiempo por zona sin las pausas del reloj, calculados con los streams (src/splits.ts).
-- Solo añade: avg_hr, hr_z*_s y aerobic_eff siguen siendo los valores de intervals, con pausas.

-- Calculados por el MCP. NULL = sin cálculo (gimnasio, sin FC o pendiente). La sincronización no los pisa.
ALTER TABLE activities ADD COLUMN fc_marcha REAL;
ALTER TABLE activities ADD COLUMN fc_marcha_z1_s INTEGER;
ALTER TABLE activities ADD COLUMN fc_marcha_z2_s INTEGER;
ALTER TABLE activities ADD COLUMN fc_marcha_z3_s INTEGER;
ALTER TABLE activities ADD COLUMN fc_marcha_z4_s INTEGER;
ALTER TABLE activities ADD COLUMN fc_marcha_z5_s INTEGER;
ALTER TABLE activities ADD COLUMN fc_marcha_z6_s INTEGER;
ALTER TABLE activities ADD COLUMN fc_marcha_z7_s INTEGER;

-- Valores que se usan: el cálculo si existe y, si no, el de intervals. Las zonas se toman todas de la misma fuente.
ALTER TABLE activities ADD COLUMN fc_media REAL GENERATED ALWAYS AS (COALESCE(fc_marcha, avg_hr)) VIRTUAL;
ALTER TABLE activities ADD COLUMN fc_z1_s INTEGER GENERATED ALWAYS AS (CASE WHEN fc_marcha_z1_s IS NOT NULL THEN fc_marcha_z1_s ELSE hr_z1_s END) VIRTUAL;
ALTER TABLE activities ADD COLUMN fc_z2_s INTEGER GENERATED ALWAYS AS (CASE WHEN fc_marcha_z1_s IS NOT NULL THEN fc_marcha_z2_s ELSE hr_z2_s END) VIRTUAL;
ALTER TABLE activities ADD COLUMN fc_z3_s INTEGER GENERATED ALWAYS AS (CASE WHEN fc_marcha_z1_s IS NOT NULL THEN fc_marcha_z3_s ELSE hr_z3_s END) VIRTUAL;
ALTER TABLE activities ADD COLUMN fc_z4_s INTEGER GENERATED ALWAYS AS (CASE WHEN fc_marcha_z1_s IS NOT NULL THEN fc_marcha_z4_s ELSE hr_z4_s END) VIRTUAL;
ALTER TABLE activities ADD COLUMN fc_z5_s INTEGER GENERATED ALWAYS AS (CASE WHEN fc_marcha_z1_s IS NOT NULL THEN fc_marcha_z5_s ELSE hr_z5_s END) VIRTUAL;
ALTER TABLE activities ADD COLUMN fc_z6_s INTEGER GENERATED ALWAYS AS (CASE WHEN fc_marcha_z1_s IS NOT NULL THEN fc_marcha_z6_s ELSE hr_z6_s END) VIRTUAL;
ALTER TABLE activities ADD COLUMN fc_z7_s INTEGER GENERATED ALWAYS AS (CASE WHEN fc_marcha_z1_s IS NOT NULL THEN fc_marcha_z7_s ELSE hr_z7_s END) VIRTUAL;
-- Igual que aerobic_eff, pero con fc_media
ALTER TABLE activities ADD COLUMN eficiencia REAL GENERATED ALWAYS AS (
  CASE WHEN sport IN ('Run', 'TrailRun', 'VirtualRun', 'Walk', 'Hike')
        AND distance_m >= 1000 AND avg_speed_ms >= 1.5 AND fc_media > 0
       THEN round(coalesce(json_extract(raw, '$.gap'), avg_speed_ms) * 60.0 / fc_media, 3) END) VIRTUAL;

-- Misma vista con las columnas nuevas al final (una vista no guarda datos)
DROP VIEW IF EXISTS v_activities;
CREATE VIEW v_activities AS
SELECT id, date, start_local, sport, name, distance_m, moving_s, elapsed_s, elev_gain_m, elev_loss_m,
       avg_hr, max_hr, cadence_spm, avg_speed_ms, gap_ms, stride_m, avg_watts, training_load, intensity,
       trimp, feel, temp_avg, calories, decoupling, lthr_used, aerobic_eff,
       hr_z1_s, hr_z2_s, hr_z3_s, hr_z4_s, hr_z5_s, hr_z6_s, hr_z7_s,
       fc_media, fc_marcha, eficiencia,
       fc_z1_s, fc_z2_s, fc_z3_s, fc_z4_s, fc_z5_s, fc_z6_s, fc_z7_s
FROM activities;

-- Vuelve a poner en cola las actividades a pie (una cada 15 minutos). Los parciales guardados ya son
-- correctos: no se borran, y cada actividad los sustituye al recalcularse.
UPDATE activities SET splits_estado = NULL WHERE splits_estado IN ('ok', 'procesando', 'error');
