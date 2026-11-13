-- Fase 4: vistas sin raw para consulta_sql (junto con v_activities y v_gym)
CREATE VIEW IF NOT EXISTS v_wellness AS
SELECT date, ctl, atl, ctl - atl AS tsb, ramp_rate, resting_hr, hrv, round(sleep_s / 3600.0, 2) AS sleep_h, weight
FROM wellness;

CREATE VIEW IF NOT EXISTS v_splits AS
SELECT s.activity_id, a.date, a.sport, s.km, s.dist_m, s.pace_s, s.hr, s.cadence_spm, s.elev_m
FROM activity_splits s JOIN activities a ON a.id = s.activity_id;
