-- Registro de los eventos del calendario que ha creado el MCP: es lo que autoriza a modificarlos o borrarlos.
-- El id lo da intervals.icu al crear, así que no depende de que external_id vuelva tal cual.
CREATE TABLE IF NOT EXISTS eventos_mcp (
    event_id     INTEGER PRIMARY KEY,
    external_id  TEXT,
    plan_id      TEXT,
    creado       TEXT NOT NULL,         -- ISO UTC
    modificado   TEXT,
    borrado      TEXT
);
CREATE INDEX IF NOT EXISTS idx_eventos_mcp_plan ON eventos_mcp(plan_id);
