/**
 * Splits por km a partir de los streams de intervals.icu. Se calculan una vez y se guardan.
 * splits_estado: NULL = sin calcular · procesando · ok · error · na (no aplica) · reintentoN:fecha (ver abajo).
 * "procesando" se escribe ANTES de pedir los streams: si la ejecución muere por CPU,
 * la actividad no se reintenta en bucle (se trata igual que error).
 * Un fallo pasajero (error de red o de intervals, respuesta rara) no es definitivo: "reintentoN:fecha" guarda cuántos
 * fallos lleva y a partir de cuándo se puede volver a pedir. Sí son definitivos un 404 y unos streams sin datos.
 */
import { IntervalsClient } from "./clients";
import { type Env, nowIso } from "./env";
import { A_PIE, type Row, rows } from "./format";

export interface Split { km: number; dist_m: number; pace_s: number; hr: number | null; cadence_spm: number | null; elev_m: number }

const STREAMS = ["time", "distance", "heartrate", "cadence", "altitude"];
export const MIN_SPEED_HUECO = 0.5; // m/s: un hueco sin distancia que avanza menos que esto es una pausa
const r1 = (v: number) => Math.round(v * 10) / 10;
const ESPERAS_REINTENTO_H = [1, 6, 24]; // tras cada fallo pasajero; agotadas, pasa a error

/** Condición SQL (un parámetro: ahora) de las actividades a las que les toca calcularse. */
export const SPLITS_POR_CALCULAR_SQL = `(splits_estado IS NULL OR (splits_estado LIKE 'reintento%'
  AND substr(splits_estado, instr(splits_estado, ':') + 1) <= ?))`;

const leerReintento = (estado: unknown) => {
  const m = /^reintento(\d+):(.+)$/.exec(String(estado ?? ""));
  return m ? { fallos: Number(m[1]), desde: m[2] } : null;
};

/** FC de la actividad sin las pausas del reloj. zonas_s: segundos en Z1-Z7, null si no hay límites. */
export interface FcEnMarcha { fc: number; zonas_s: number[] | null }

/** Límites de zona de la actividad (icu_hr_zones): de la base llegan como texto JSON. */
export function leerLimites(v: unknown): number[] | null {
  try {
    const l = typeof v === "string" ? JSON.parse(v) : v;
    return Array.isArray(l) && l.length && l.every((x) => typeof x === "number") ? l : null;
  } catch { return null; }
}

/** Índice de zona como intervals: cada límite es la FC más alta de su zona; por encima del último, la última. */
export function zonaFc(h: number, limites: number[]): number {
  const z = limites.findIndex((l) => h <= l);
  return z < 0 ? limites.length - 1 : z;
}

/** ¿Tiene sentido calcular splits? Solo deportes a pie con distancia real. */
export const splitsAplican = (a: Row) => A_PIE.includes(a.sport) && (a.distance_m ?? 0) >= 1000;

export const computeSplits = (streams: any[], cadenceX2: boolean): Split[] => analizarStreams(streams, cadenceX2).splits;

/**
 * Parciales y FC de toda la actividad con la misma regla de qué es movimiento. La FC se pondera por
 * tiempo (a veces las muestras van cada 2 s) y con el reloj en pausa no cuenta.
 * Origen: streams time, distance, heartrate, cadence y altitude de intervals. Ventana: una actividad.
 * Parcial de cada km (el tramo se cierra en la primera muestra que llega al siguiente km entero):
 * - pace_s = segundos en movimiento / km del tramo.
 * - hr = media simple de las muestras en movimiento con FC > 0, sin ponderar por tiempo.
 * - cadence_spm = media simple de las muestras en movimiento con cadencia > 0; x2 si cadenceX2.
 * - elev_m = suma de las subidas de altitud en movimiento.
 * - El último tramo solo se guarda si mide al menos 200 m.
 * Toda la actividad: fc = suma(FC x segundos) / segundos; zonas_s = segundos de cada muestra en su zona.
 */
export function analizarStreams(streams: any[], cadenceX2: boolean, limites: number[] | null = null): { splits: Split[]; fcMarcha: FcEnMarcha | null } {
  const get = (t: string): any[] => streams.find((s) => s?.type === t)?.data ?? [];
  const time = get("time"), dist = get("distance"), hr = get("heartrate"), cad = get("cadence"), alt = get("altitude");
  const out: Split[] = [];
  // Con el reloj en pausa la distancia viene null (la FC y el tiempo siguen). La actividad puede
  // empezar o acabar así: los límites son la primera y la última muestra con distancia.
  let first = 0, end = Math.min(time.length, dist.length);
  while (first < end && dist[first] == null) first++;
  while (end > first && dist[end - 1] == null) end--;
  if (end - first < 2) return { splits: out, fcMarcha: null };
  const zonas: number[] | null = limites ? new Array(7).fill(0) : null;
  let fcSum = 0, fcT = 0;
  // Dentro de una muestra con distancia nunca se está parado: la distancia va en metros enteros y a
  // saltos, y hay segundos sin avance en plena carrera. Un hueco sin distancia no siempre es una pausa
  // (a veces se pierde la señal corriendo): se decide al cerrarlo, según lo que avanzó durante el hueco.
  let start = first, prev = first, next = (Math.floor(dist[first] / 1000) + 1) * 1000, km = 1, moving = 0, hrSum = 0, hrN = 0, cadSum = 0, cadN = 0, gain = 0;
  for (let i = first + 1; i < end; i++) {
    if (dist[i] == null) continue;
    const dt = time[i] - time[prev], hueco = i - prev > 1;
    if (dt > 0 && (!hueco || (dist[i] - dist[prev]) / dt >= MIN_SPEED_HUECO)) {
      moving += dt;
      for (let j = prev + 1; j <= i; j++) {
        const h = hr[j], c = cad[j], a = alt[j], a0 = alt[j - 1];
        if (typeof h === "number" && h > 0) {
          hrSum += h; hrN++;
          const pasos = time[j] - time[j - 1];
          fcSum += h * pasos; fcT += pasos;
          if (zonas) zonas[Math.min(zonaFc(h, limites!), 6)] += pasos;
        }
        if (typeof c === "number" && c > 0) { cadSum += c; cadN++; }
        if (typeof a === "number" && typeof a0 === "number" && a > a0) gain += a - a0;
      }
    }
    prev = i;
    const last = i === end - 1;
    if (dist[i] >= next || last) {
      const d = dist[i] - dist[start], t = moving;
      // El último tramo solo cuenta si tiene al menos 200 m
      if (d > 0 && t > 0 && (dist[i] >= next || d >= 200)) {
        out.push({
          km, dist_m: Math.round(d), pace_s: Math.round(t / (d / 1000)),
          hr: hrN ? Math.round(hrSum / hrN) : null,
          cadence_spm: cadN ? Math.round((cadSum / cadN) * (cadenceX2 ? 2 : 1)) : null,
          elev_m: Math.round(gain),
        });
      }
      start = i; next = (Math.floor(dist[i] / 1000) + 1) * 1000; km++;
      moving = hrSum = hrN = cadSum = cadN = gain = 0;
    }
  }
  return { splits: out, fcMarcha: fcT > 0 ? { fc: r1(fcSum / fcT), zonas_s: zonas } : null };
}

/**
 * Deriva cardiaca (%) entre la primera y la segunda mitad, con los km completos:
 * cuánto empeora la relación velocidad/FC. Solo orientativa en rodajes a ritmo estable.
 * Fórmula: (ef. primera mitad / ef. segunda mitad - 1) x 100; ef. = media por km de (1000 / pace_s) / hr.
 * Positiva = peor al final. Con un número impar de km, el de más va a la segunda mitad.
 * Umbrales: km de al menos 900 m con FC, y al menos 4; si no, null.
 * Origen: los parciales de una actividad (ritmo real, no GAP: las cuestas la alteran).
 */
export function deriva(splits: Split[]): number | null {
  const full = splits.filter((s) => s.dist_m >= 900 && s.hr);
  if (full.length < 4) return null;
  const half = Math.floor(full.length / 2);
  const ef = (xs: Split[]) => xs.reduce((a, s) => a + 1000 / s.pace_s / s.hr!, 0) / xs.length;
  return r1((ef(full.slice(0, half)) / ef(full.slice(half)) - 1) * 100);
}

/** Calcula y guarda los splits y la FC en marcha de una actividad (a.zonas_fc = icu_hr_zones). Devuelve el estado final. */
export async function calcularSplits(env: Env, client: IntervalsClient, a: Row): Promise<string> {
  if (!splitsAplican(a)) {
    await env.DB.prepare("UPDATE activities SET splits_estado='na' WHERE id=?").bind(a.id).run();
    return "na";
  }
  const fallos = leerReintento(a.splits_estado)?.fallos ?? 0; // se lee antes de pisarlo con "procesando"
  await env.DB.prepare("UPDATE activities SET splits_estado='procesando' WHERE id=?").bind(a.id).run();
  try {
    // splitsAplican solo deja pasar deportes a pie, cuya cadencia viene en ciclos/min (x2)
    const { splits, fcMarcha } = analizarStreams(await client.streams(a.id, STREAMS), true, leerLimites(a.zonas_fc));
    const stmts: D1PreparedStatement[] = [env.DB.prepare("DELETE FROM activity_splits WHERE activity_id=?").bind(a.id)];
    for (const s of splits) {
      stmts.push(env.DB.prepare(
        `INSERT INTO activity_splits (activity_id, km, dist_m, pace_s, hr, cadence_spm, elev_m) VALUES (?,?,?,?,?,?,?)`,
      ).bind(a.id, s.km, s.dist_m, s.pace_s, s.hr, s.cadence_spm, s.elev_m));
    }
    const estado = splits.length ? "ok" : "error";
    const z = fcMarcha?.zonas_s ?? [];
    stmts.push(env.DB.prepare(
      `UPDATE activities SET fc_marcha=?, fc_marcha_z1_s=?, fc_marcha_z2_s=?, fc_marcha_z3_s=?, fc_marcha_z4_s=?,
         fc_marcha_z5_s=?, fc_marcha_z6_s=?, fc_marcha_z7_s=? WHERE id=?`,
    ).bind(fcMarcha?.fc ?? null, ...[0, 1, 2, 3, 4, 5, 6].map((i) => z[i] ?? null), a.id));
    stmts.push(env.DB.prepare("UPDATE activities SET splits_estado=? WHERE id=?").bind(estado, a.id));
    await env.DB.batch(stmts);
    return estado;
  } catch {
    const espera = ESPERAS_REINTENTO_H[fallos];
    const estado = espera === undefined ? "error"
      : `reintento${fallos + 1}:${new Date(Date.now() + espera * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
    await env.DB.prepare("UPDATE activities SET splits_estado=? WHERE id=?").bind(estado, a.id).run();
    return estado;
  }
}

/** Splits guardados (o los calcula si faltan y hay cliente). calculado: la fila leída antes ya no está al día. */
export async function obtenerSplits(env: Env, client: IntervalsClient | null, a: Row): Promise<{ estado: string; splits: Split[]; calculado: boolean }> {
  let estado: string = a.splits_estado ?? "";
  const reintento = leerReintento(estado);
  const calculado = !!client && (!estado || (!!reintento && reintento.desde <= nowIso()));
  if (calculado) estado = await calcularSplits(env, client!, a);
  // Mientras queden reintentos, para quien lee sigue pendiente
  if (estado !== "ok") return { estado: !estado || leerReintento(estado) ? "pendiente" : estado, splits: [], calculado };
  const s = await rows(env, "SELECT km, dist_m, pace_s, hr, cadence_spm, elev_m FROM activity_splits WHERE activity_id=? ORDER BY km", a.id);
  return { estado, splits: s as Split[], calculado };
}
