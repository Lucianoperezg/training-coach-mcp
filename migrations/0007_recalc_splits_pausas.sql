-- Los parciales daban por parados segundos sin avance en plena carrera (la distancia va en metros
-- enteros): se borran para recalcularlos contando como parado solo el reloj en pausa
DELETE FROM activity_splits;
UPDATE activities SET splits_estado = NULL WHERE splits_estado IN ('ok', 'procesando', 'error');
