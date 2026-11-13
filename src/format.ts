/**
 * Utilidades comunes de consulta y formato de las herramientas MCP.
 */
import { IntervalsClient } from "./clients";
import { addDays, type Env, today } from "./env";

export type Row = Record<string, any>;

export async function rows(env: Env, sql: string, ...params: unknown[]): Promise<Row[]> {
  const { results } = await env.DB.prepare(sql).bind(...params).all<Row>();
  return results ?? [];
}

export const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
export const round = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
export const since = (env: Env, days: number) => addDays(today(env.TZ), -days);

/** Tabla compacta: nombres de columna una sola vez y filas como arrays. Omite las columnas vacías. */
export function tabla(rs: Row[], cols: string[]) {
  const used = cols.filter((c) => rs.some((r) => r[c] != null));
  return { columnas: used, filas: rs.map((r) => used.map((c) => r[c] ?? null)) };
}

export function hms(s: number | null | undefined): string | null {
  if (s == null) return null;
  s = Math.round(s);
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** "m:ss" a partir de segundos. */
export function mmss(secs: number | null | undefined): string | null {
  if (secs == null || !Number.isFinite(secs)) return null;
  const s = Math.round(secs);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// Por debajo de esta velocidad (m/s) el dato no es creíble: no se muestra ritmo ni se calcula tiempo con ella
const VELOCIDAD_MIN = 0.5;

/** Ritmo "m:ss" (min/km) a partir de m/s. */
export function pace(speed: number | null | undefined): string | null {
  if (!speed || speed < VELOCIDAD_MIN) return null;
  return mmss(1000 / speed);
}

/** Ritmo "m:ss" (min/km) a partir de un tiempo en segundos y una distancia en metros. */
export function ritmoDe(segundos: number | null | undefined, metros: number | null | undefined): string | null {
  return segundos && metros ? mmss(segundos / (metros / 1000)) : null;
}

const FEEL_ETIQUETAS: Record<number, string> = { 1: "muy bien", 2: "bien", 3: "normal", 4: "mal", 5: "muy mal" };

/** ¿El reloj es un Suunto? Se configura con WATCH en [vars] de wrangler.toml. */
export const esSuunto = (watch?: string | null) => (watch ?? "").trim().toLowerCase() === "suunto";

/**
 * Escala del feel. intervals.icu: 1 = muy bien … 5 = muy mal. Suunto la guarda al revés (1 = Poor … 5 = Excellent)
 * e intervals la invierte al importar, así que solo con WATCH=suunto se explica el valor que se ve en el reloj.
 */
export const escalaFeel = (watch?: string | null, { conFuente = true } = {}) =>
  `${conFuente ? "en intervals " : ""}1 = muy bien y 5 = muy mal${esSuunto(watch) ? "; valor en el reloj = 6 − feel" : ""}`;

/** Explica el feel de intervals.icu (1-5). Sin un valor válido no añade nada. feel_reloj solo con WATCH=suunto. */
export function feelExplicado(feel: number | null | undefined, watch?: string | null): Row {
  const etiqueta = feel != null ? FEEL_ETIQUETAS[feel] : undefined;
  if (!etiqueta) return {};
  return esSuunto(watch)
    ? { feel_etiqueta: etiqueta, feel_reloj: 6 - feel!, feel_escala: escalaFeel(watch) }
    : { feel_etiqueta: etiqueta, feel_escala: escalaFeel(watch) };
}

// Deportes a pie: cadencia x2 (ya aplicado en cadence_spm) y ritmo en min/km
// Cadencia (cadence_spm, migración 0002): a pie, avg_cadence x 2 (intervals la da por pierna); en el resto, avg_cadence.
// Origen: average_cadence de intervals. Ventana: una actividad. Redondeada a 1 decimal.
export const A_PIE = ["Run", "TrailRun", "VirtualRun", "Walk", "Hike"];

// Dónde es fiable distancia / velocidad: a pie y con GPS. La cinta tiene velocidad falsa (0,24 m/s para 5,6 km)
// y en la elíptica la velocidad incluye las pausas.
const SPORTS_TIEMPO_POR_VELOCIDAD = A_PIE.filter((s) => s !== "VirtualRun");

/**
 * Tiempo en marcha en segundos. moving_s de intervals a veces incluye las pausas, así que se usa
 * distancia / velocidad media cuando es fiable; si no (gimnasio, cinta...), moving_s.
 * TIEMPO_SQL es la misma regla para las consultas: si cambia una, debe cambiar la otra.
 */
export function tiempoEnMarcha(r: Row): number | null {
  return SPORTS_TIEMPO_POR_VELOCIDAD.includes(r.sport) && r.distance_m > 0 && r.avg_speed_ms >= VELOCIDAD_MIN
    ? r.distance_m / r.avg_speed_ms
    : r.moving_s ?? null;
}

export const TIEMPO_SQL = `(CASE WHEN sport IN (${SPORTS_TIEMPO_POR_VELOCIDAD.map((s) => `'${s}'`).join(",")})
    AND distance_m > 0 AND avg_speed_ms >= ${VELOCIDAD_MIN} THEN distance_m / avg_speed_ms ELSE moving_s END)`;

export const ACT_SELECT = `SELECT id, date, substr(start_local,12,5) AS hora, sport, name, distance_m, moving_s,
    avg_speed_ms, gap_ms, fc_media, max_hr, cadence_spm, elev_gain_m, training_load, feel,
    fc_z1_s, fc_z2_s, fc_z3_s, fc_z4_s, fc_z5_s, fc_z6_s, fc_z7_s
  FROM activities`;

/**
 * Segundos en Z1-Z7: sin pausas si ya están calculados y, si no, los de intervals (migración 0008).
 * Se toman las 7 zonas de la misma fuente: fc_marcha_z*_s (src/splits.ts) o hr_z*_s (icu_hr_zone_times).
 */
export const zonasFc = (r: Row): number[] => [1, 2, 3, 4, 5, 6, 7].map((n) => r[`fc_z${n}_s`] ?? 0);

/**
 * Resumen de una actividad. Ventana: esa actividad. Ritmos solo a pie y desde 500 m.
 * - ritmo_min_km = 1000 / avg_speed_ms (average_speed de intervals); gap_min_km = 1000 / gap_ms (gap de intervals).
 * - tiempo: ver tiempoEnMarcha.
 * - fc = fc_media (migración 0008): COALESCE(fc_marcha, avg_hr), es decir, sin pausas si está calculada.
 * - z1_2_pct = 100 x (Z1 + Z2) / (Z1 a Z7), con zonasFc.
 */
export function fmtActivity(r: Row): Row {
  const zonas = zonasFc(r);
  const total = zonas.reduce((a, b) => a + b, 0);
  const aPie = A_PIE.includes(r.sport) && (r.distance_m ?? 0) >= 500;
  return {
    id: r.id, fecha: r.date, hora: r.hora, deporte: r.sport, nombre: r.name,
    km: r.distance_m ? round(r.distance_m / 1000, 2) : null,
    tiempo: hms(tiempoEnMarcha(r)),
    ritmo_min_km: aPie ? pace(r.avg_speed_ms) : null,
    gap_min_km: aPie ? pace(r.gap_ms) : null,
    fc: r.fc_media != null ? Math.round(r.fc_media) : null,
    fc_max: r.max_hr != null ? Math.round(r.max_hr) : null,
    ppm: r.cadence_spm != null ? Math.round(r.cadence_spm) : null,
    desnivel_m: r.elev_gain_m ? Math.round(r.elev_gain_m) : null,
    carga: r.training_load != null ? Math.round(r.training_load) : null,
    z1_2_pct: total ? Math.round((100 * (zonas[0] + zonas[1])) / total) : null,
    feel: r.feel,
  };
}

// Fecha local del entreno de gimnasio (la UTC solo mientras Hevy se reimporta tras la migración 0002)
export const GYM_FECHA = "COALESCE(w.date, substr(w.start_time,1,10))";

export function intervalsClient(env: Env): IntervalsClient | null {
  return env.INTERVALS_API_KEY ? new IntervalsClient(env) : null;
}
