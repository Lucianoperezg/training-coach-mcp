-- Los primeros splits contaban el tiempo parado: se borran para recalcularlos con tiempo en movimiento
DELETE FROM activity_splits;
UPDATE activities SET splits_estado = NULL WHERE splits_estado IN ('ok', 'procesando', 'error');
