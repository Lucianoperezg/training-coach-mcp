-- Fase 3: planes de entrenos pendientes de confirmar (programar_entrenos en dos pasos)
CREATE TABLE IF NOT EXISTS planes (
    plan_id    TEXT PRIMARY KEY,
    creado     TEXT NOT NULL,           -- ISO UTC
    estado     TEXT NOT NULL,           -- pendiente · parcial · hecho
    payload    TEXT NOT NULL,           -- entrenos exactos que se mostraron al atleta
    resultado  TEXT                     -- resultado por entreno del último intento
);
