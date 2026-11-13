-- Estado compartido entre chats (herramienta estado). Cada fila es una versión completa:
-- el estado vigente es la última y el historial son las anteriores. Nunca se reescribe una fila.
CREATE TABLE IF NOT EXISTS estado_versiones (
    version     INTEGER PRIMARY KEY AUTOINCREMENT,
    creado      TEXT NOT NULL,           -- ISO UTC
    origen      TEXT,                    -- quién lo cambió (p. ej. el chat)
    motivo      TEXT,                    -- por qué, en una frase
    cambiados   TEXT NOT NULL,           -- JSON: campos que cambiaron en esta versión
    objetivo    TEXT NOT NULL DEFAULT '',
    plan        TEXT NOT NULL DEFAULT '',
    rutina      TEXT NOT NULL DEFAULT '',
    decisiones  TEXT NOT NULL DEFAULT '',
    reglas      TEXT NOT NULL DEFAULT ''
);
