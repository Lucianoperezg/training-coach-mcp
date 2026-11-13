-- Fase 2: distancia real de cada split (el último km suele ser parcial)
ALTER TABLE activity_splits ADD COLUMN dist_m REAL;
