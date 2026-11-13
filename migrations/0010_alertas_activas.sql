-- Alertas que siguen activas: salen en cualquier chat hasta que se resuelven o caducan.
-- Sustituye a alertas_vistas, que se queda sin usar (las migraciones solo añaden).
CREATE TABLE IF NOT EXISTS alertas_activas (
    clave      TEXT PRIMARY KEY,
    motivo     TEXT NOT NULL,
    pregunta   TEXT NOT NULL,
    prioridad  INTEGER NOT NULL,
    creada     TEXT NOT NULL,           -- ISO UTC
    caduca     TEXT,                    -- ISO UTC; NULL en las de estado, que se recalculan en cada respuesta
    resuelta   TEXT                     -- ISO UTC; se marca con nota(resolver_alerta=clave)
);
CREATE INDEX IF NOT EXISTS idx_alertas_activas ON alertas_activas(resuelta, caduca);
