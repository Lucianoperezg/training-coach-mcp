-- Rutinas de Hevy. Se guarda la respuesta completa en raw y v_rutinas la despliega en SQL: una fila por rutina y sincronización
-- ligera. Una rutina que ya no está en Hevy no se borra: se marca con borrada_en y deja de salir en la vista.
CREATE TABLE IF NOT EXISTS rutinas (
    id          TEXT PRIMARY KEY,
    title       TEXT,
    folder_id   INTEGER,
    updated_at  TEXT,                  -- el de Hevy
    raw         TEXT NOT NULL,         -- la rutina tal como la da Hevy
    synced_at   TEXT,
    borrada_en  TEXT                   -- ISO UTC; NULL = vigente
);

CREATE TABLE IF NOT EXISTS rutina_carpetas (
    id     INTEGER PRIMARY KEY,
    title  TEXT,
    orden  INTEGER
);

-- Copia completa de una rutina justo antes de que el MCP la cambie: es lo que permite restaurarla.
CREATE TABLE IF NOT EXISTS rutina_copias (
    copia_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    routine_id  TEXT NOT NULL,
    title       TEXT,
    raw         TEXT NOT NULL,
    motivo      TEXT NOT NULL,         -- modificar · restaurar
    plan_id     TEXT,
    creado      TEXT NOT NULL          -- ISO UTC
);
CREATE INDEX IF NOT EXISTS idx_rutina_copias_rutina ON rutina_copias(routine_id);

-- Planes de programar_rutinas pendientes de confirmar. Tabla propia: un plan de rutinas no debe poder confirmarse con
-- programar_entrenos, ni al revés.
CREATE TABLE IF NOT EXISTS planes_rutinas (
    plan_id          TEXT PRIMARY KEY,
    creado           TEXT NOT NULL,     -- ISO UTC
    estado           TEXT NOT NULL,     -- pendiente · aplicando · hecho · parcial · fallido
    aplicando_desde  TEXT,              -- ISO UTC; evita aplicar el mismo plan dos veces a la vez
    payload          TEXT NOT NULL,     -- operaciones exactas que se mostraron al atleta
    resultado        TEXT               -- resultado por operación del último intento
);

-- Una fila por serie (o por ejercicio, si no tiene series). Solo rutinas vigentes.
CREATE VIEW IF NOT EXISTS v_rutinas AS
SELECT r.id AS routine_id, r.title AS rutina, c.title AS carpeta, r.folder_id,
       json_extract(r.raw, '$.notes') AS notas_rutina, r.updated_at,
       COALESCE(json_extract(e.value, '$.index'), e.key) AS exercise_index,
       json_extract(e.value, '$.title') AS exercise,
       json_extract(e.value, '$.exercise_template_id') AS template_id,
       json_extract(e.value, '$.superset_id') AS superset_id,
       json_extract(e.value, '$.rest_seconds') AS rest_s,
       json_extract(e.value, '$.notes') AS exercise_notes,
       COALESCE(json_extract(s.value, '$.index'), s.key) AS set_index,
       json_extract(s.value, '$.type') AS set_type,
       json_extract(s.value, '$.weight_kg') AS weight_kg,
       json_extract(s.value, '$.reps') AS reps,
       json_extract(s.value, '$.rep_range.start') AS rep_min,
       json_extract(s.value, '$.rep_range.end') AS rep_max,
       json_extract(s.value, '$.duration_seconds') AS duration_s,
       json_extract(s.value, '$.distance_meters') AS distance_m,
       json_extract(s.value, '$.custom_metric') AS custom_metric
FROM rutinas r
JOIN json_each(r.raw, '$.exercises') e
LEFT JOIN json_each(e.value, '$.sets') s
LEFT JOIN rutina_carpetas c ON c.id = r.folder_id
WHERE r.borrada_en IS NULL;

CREATE VIEW IF NOT EXISTS v_rutinas_copias AS
SELECT copia_id, routine_id, title AS rutina, motivo, plan_id, creado,
       json_extract(raw, '$.updated_at') AS updated_at, json_array_length(raw, '$.exercises') AS ejercicios
FROM rutina_copias;
