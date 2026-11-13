/**
 * Herramientas del entrenador: revisión post-actividad, estado del atleta, notas y alertas.
 * El servidor calcula (medias, comparaciones, deriva, alertas) y Claude interpreta.
 */
import type { Env } from "./env";
import { addDays, conHevy, getStates, nowIso, today } from "./env";
import {
  A_PIE, ACT_SELECT, feelExplicado, fmtActivity, hms, intervalsClient, mmss, pace, ritmoDe, round, type Row, rows, since, tabla, tiempoEnMarcha, zonasFc,
} from "./format";
import { planDelDia } from "./plan";
import { deriva, obtenerSplits } from "./splits";
import { Budget } from "./clients";
import { syncHevy, syncRecent } from "./sync";
import { VERSION } from "./version";

// Actividades que no cuentan para comparaciones ni para "la última": grabaciones de segundos o cortadas
// (menos de 120 s en moving_s, o a pie de 1 a 299 m). analisis.ts repite esta misma regla.
const NO_BASURA = "moving_s >= 120 AND NOT (sport IN ('Run','TrailRun','VirtualRun','Walk','Hike') AND COALESCE(distance_m,0) BETWEEN 1 AND 299)";
const CARRERA = "sport IN ('Run','TrailRun')";
// "Gimnasio de pierna": el título encaja con PIERNA_TITULO o algún ejercicio tiene un músculo principal de PIERNA_MUSCULO
// (primary_muscle de la plantilla de Hevy). La ventana la pone quien llama a gymReciente.
const PIERNA_TITULO = /lower|pierna|leg|squat|sentadilla|deadlift|peso muerto/i;
const PIERNA_MUSCULO = ["quadriceps", "hamstrings", "glutes", "calves", "adductors", "abductors"];
const MAX_ALERTAS = 2;
const MAX_OTRAS_NOTAS = 10; // notas abiertas que no son molestias; las molestias salen todas
const INTENSIDAD_DURA = 85; // intervals da la intensidad de 0 a 100

/** fecha: día de la actividad, para las que caducan por días. caduca: instante exacto, si ya se conoce. */
export interface Alerta { clave: string; motivo: string; pregunta_sugerida: string; prioridad: number; fecha?: string; caduca?: string }

// Alertas de una actividad: días que siguen activas contando desde el día de la actividad.
const DIAS_ALERTA: Record<string, number> = { feel: 2, deriva: 3, pierna48: 3, fc_alta: 5, cortada: 7 };
// Alertas de estado: se recalculan en cada respuesta, así que solo salen mientras se cumple la condición.
const TIPOS_ESTADO = ["carga", "fcreposo", "vfc", "nota"];
const tipoAlerta = (clave: string) => clave.split(":")[0];

const median = (xs: number[]) => {
  const s = xs.filter((x) => typeof x === "number").sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

/** Semana ISO (YYYY-Www) para las claves de alertas que se repiten. */
export function semanaIso(fecha: string): string {
  const d = new Date(fecha + "T00:00:00Z");
  const dia = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dia + 3);
  const primerJueves = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const semana = 1 + Math.round(((d.getTime() - primerJueves.getTime()) / 86400000 - 3 + ((primerJueves.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(semana).padStart(2, "0")}`;
}

/** Hasta cuándo sigue activa (ISO UTC). El día se cuenta entero; el corte es a medianoche UTC, no local. Las de estado no caducan por fecha. */
export function caducidad(a: Alerta): string | null {
  if (a.caduca) return a.caduca;
  const dias = DIAS_ALERTA[tipoAlerta(a.clave)];
  return dias != null && a.fecha ? `${addDays(a.fecha, dias + 1)}T00:00:00Z` : null;
}

/**
 * Qué alertas activas salen: las de estado solo si su condición se cumple ahora. Máximo MAX_ALERTAS, de mayor a
 * menor prioridad y, a igualdad, la más antigua. Las que no entran siguen activas para la siguiente respuesta.
 */
export function elegirAlertas(activas: Row[], vigentes: Set<string>) {
  return activas
    .filter((a) => !TIPOS_ESTADO.includes(tipoAlerta(a.clave)) || vigentes.has(a.clave))
    .sort((a, b) => b.prioridad - a.prioridad || String(a.creada).localeCompare(String(b.creada)) || String(a.clave).localeCompare(String(b.clave)))
    .slice(0, MAX_ALERTAS)
    .map((a) => ({ clave: a.clave as string, motivo: a.motivo as string, pregunta_sugerida: a.pregunta as string }));
}

/**
 * Guarda las alertas detectadas y devuelve las activas de cualquier chat (ver elegirAlertas).
 * Una alerta sale en todas las respuestas hasta que se resuelve con nota(resolver_alerta=clave) o caduca (DIAS_ALERTA).
 * Actualizar una alerta ya guardada nunca borra su resolución: una resuelta no vuelve; las de estado llevan
 * la semana ISO en la clave, así que si la condición sigue, vuelven la semana siguiente.
 * revisada: id de la actividad recién revisada; las alertas suyas que ya no se detectan dejan de aplicar.
 */
async function emitir(env: Env, cands: Alerta[], revisada?: string) {
  const ahora = nowIso();
  const escrituras = cands.map((a) => env.DB.prepare(`INSERT INTO alertas_activas (clave, motivo, pregunta, prioridad, creada, caduca)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(clave) DO UPDATE SET
      motivo = excluded.motivo, pregunta = excluded.pregunta, prioridad = excluded.prioridad, caduca = excluded.caduca`)
    .bind(a.clave, a.motivo, a.pregunta_sugerida, a.prioridad, ahora, caducidad(a)));
  if (revisada) {
    const detectadas = new Set(cands.map((c) => c.clave));
    const yaNo = Object.keys(DIAS_ALERTA).map((t) => `${t}:${revisada}`).filter((c) => !detectadas.has(c));
    escrituras.push(env.DB.prepare("UPDATE alertas_activas SET caduca = ? WHERE clave IN (SELECT value FROM json_each(?))")
      .bind(ahora, JSON.stringify(yaNo)));
  }
  if (escrituras.length) await env.DB.batch(escrituras);
  const activas = await rows(env, `SELECT clave, motivo, pregunta, prioridad, creada FROM alertas_activas
    WHERE resuelta IS NULL AND (caduca IS NULL OR caduca > ?)`, ahora);
  return elegirAlertas(activas, new Set(cands.map((c) => c.clave)));
}

// --- estado general (compartido por las dos herramientas) -------------------
/**
 * Carga de 7 y 28 días: suma de training_load de intervals, hoy incluido (c28 contiene también los últimos 7 días).
 * Suma todas las actividades, también gimnasio y grabaciones muy cortas: no aplica NO_BASURA.
 */
async function cargaSemanal(env: Env) {
  const [c] = await rows(env, `SELECT
      SUM(CASE WHEN date >= ? THEN training_load END) AS c7,
      SUM(training_load) AS c28
    FROM activities WHERE date >= ?`, since(env, 6), since(env, 27));
  return { c7: c?.c7 ?? 0, c28: c?.c28 ?? 0 };
}

/** Wellness de intervals de los últimos 28 días, hoy incluido, del más reciente al más antiguo. Sueño y pasos: migración 0012. */
async function bienestar(env: Env) {
  return rows(env, `SELECT date, resting_hr, hrv, sleep_s, ctl, atl, sleep_score, avg_sleeping_hr, steps FROM wellness
    WHERE date >= ? AND date <= ? ORDER BY date DESC`, since(env, 27), today(env.TZ));
}

/** Alertas que no dependen de una actividad concreta. */
function alertasEstado(env: Env, carga: { c7: number; c28: number }, well: Row[], notas: Row[]): Alerta[] {
  const out: Alerta[] = [];
  const semana = semanaIso(today(env.TZ));
  const media4 = carga.c28 / 4;
  // Carga alta: media semanal de 4 semanas (c28 / 4) de al menos 20 y c7 > 1,3 veces esa media
  if (media4 >= 20 && carga.c7 > media4 * 1.3) {
    out.push({
      clave: `carga:${semana}`, prioridad: 3,
      motivo: `Carga de los últimos 7 días (${Math.round(carga.c7)}) un ${Math.round((carga.c7 / media4 - 1) * 100)} % por encima de la media de 4 semanas (${Math.round(media4)}).`,
      pregunta_sugerida: "¿Cómo notas las piernas y el descanso esta semana?",
    });
  }
  // Medianas de 28 días; hacen falta al menos 10 valores
  const rhr = well.map((w) => w.resting_hr).filter((x) => x != null);
  const hrv = well.map((w) => w.hrv).filter((x) => x != null);
  const rhrMed = rhr.length >= 10 ? median(rhr) : null;
  const hrvMed = hrv.length >= 10 ? median(hrv) : null;
  // Los últimos días suelen venir vacíos hasta que el reloj sincroniza: se usan los 3 últimos valores de 6 días
  const recientes = well.filter((w) => w.date >= since(env, 5));
  const ult3 = recientes.filter((w) => w.resting_hr != null).slice(0, 3);
  // FC en reposo alta: esos 3 valores, todos >= mediana + 5 lpm. VFC baja: todos <= 80 % de la mediana; solo se mira si no saltó la FC
  if (rhrMed && ult3.length === 3 && ult3.every((w) => w.resting_hr >= rhrMed + 5)) {
    out.push({
      clave: `fcreposo:${semana}`, prioridad: 3,
      motivo: `FC en reposo alta 3 días seguidos (${ult3.map((w) => w.resting_hr).join(", ")}) frente a tu mediana de 4 semanas (${Math.round(rhrMed)}).`,
      pregunta_sugerida: "¿Estás durmiendo mal, con estrés o notas algún síntoma de catarro?",
    });
  } else {
    const h3 = recientes.filter((w) => w.hrv != null).slice(0, 3);
    if (hrvMed && h3.length === 3 && h3.every((w) => w.hrv <= hrvMed * 0.8)) {
      out.push({
        clave: `vfc:${semana}`, prioridad: 2,
        motivo: `VFC baja 3 días seguidos (${h3.map((w) => w.hrv).join(", ")}) frente a tu mediana (${Math.round(hrvMed)}).`,
        pregunta_sugerida: "¿Cómo has dormido y cómo te encuentras de energía?",
      });
    }
  }
  // Molestia sin revisar: nota abierta de tipo molestia cuya última revisión (o creación) fue hace 6 días o más
  for (const nt of notas) {
    const ref = nt.revisada ?? nt.fecha;
    if (nt.tipo === "molestia" && ref <= since(env, 6)) {
      out.push({
        clave: `nota:${nt.id}:${semana}`, prioridad: 2,
        motivo: `Molestia anotada el ${nt.fecha} sin revisar desde ${ref}: "${String(nt.texto).slice(0, 80)}".`,
        pregunta_sugerida: `¿Sigue la molestia o ya puedo cerrarla? (nota ${nt.id})`,
      });
    }
  }
  return out;
}

/** Entrenos de Hevy en las `horas` anteriores a antesDe (por defecto, ahora). pierna: ver PIERNA_TITULO y PIERNA_MUSCULO. */
async function gymReciente(env: Env, horas: number, antesDe?: string) {
  const ref = antesDe ?? new Date().toISOString();
  const ws = await rows(env, `SELECT w.id, w.title, w.date, w.start_time,
      ROUND((julianday(?) - julianday(w.start_time)) * 24, 1) AS horas_antes,
      (SELECT group_concat(DISTINCT t.primary_muscle) FROM gym_sets s JOIN exercise_templates t ON t.id = s.template_id
        WHERE s.workout_id = w.id) AS musculos
    FROM gym_workouts w
    WHERE julianday(w.start_time) BETWEEN julianday(?) - ? / 24.0 AND julianday(?)
    ORDER BY w.start_time DESC`, ref, ref, horas, ref);
  return ws.map((w) => ({
    id: w.id as string, fecha: w.date, titulo: w.title, horas_antes: w.horas_antes,
    pierna: PIERNA_TITULO.test(w.title ?? "") || String(w.musculos ?? "").split(",").some((m) => PIERNA_MUSCULO.includes(m)),
  }));
}

/**
 * Notas abiertas, de la más reciente a la más antigua: todas las de tipo molestia, porque de ellas dependen sus alertas,
 * y las MAX_OTRAS_NOTAS más recientes de los demás tipos. omitidas: aviso con cuántas de las demás se quedan fuera; null si ninguna.
 */
async function notasAbiertas(env: Env) {
  const todas = await rows(env, "SELECT id, fecha, tipo, texto, revisada FROM notas WHERE estado='abierta' ORDER BY fecha DESC, id DESC");
  let otras = 0;
  const notas = todas.filter((n) => n.tipo === "molestia" || ++otras <= MAX_OTRAS_NOTAS);
  const fuera = otras - MAX_OTRAS_NOTAS;
  const omitidas = fuera <= 0 ? null : fuera === 1
    ? "1 nota abierta más antigua, que no es una molestia, no se muestra."
    : `${fuera} notas abiertas más antiguas, que no son molestias, no se muestran.`;
  return { notas, omitidas };
}

/**
 * "Entreno duro": intensity de intervals >= INTENSIDAD_DURA, o al menos 600 s en Z4-Z7 (con zonasFc).
 * Ventana: una actividad. estadoAtleta repite esta regla en SQL para buscar el último.
 */
export const esDura = (a: Row) => (a.intensity ?? 0) >= INTENSIDAD_DURA ||
  zonasFc(a).slice(3).reduce((x, y) => x + y, 0) >= 600;

// --- revisar_actividad ------------------------------------------------------
export async function revisarActividad(env: Env, id?: string) {
  let sync: unknown = null;
  if (!id) {
    try { sync = await syncRecent(env); } catch (e: any) { sync = { error: String(e?.message ?? e) }; }
    // También los cambios de Hevy, para que un gimnasio recién hecho traiga sus ejercicios
    if (conHevy(env)) {
      try { await syncHevy(env, new Budget(7)); } catch { /* el cron lo recogerá */ }
    }
  }
  const leer = (filtro: string, ...params: unknown[]) => rows(env, `SELECT a.*, json_extract(a.raw,'$.start_date') AS start_utc,
      json_extract(a.raw,'$.icu_hr_zones') AS zonas_fc, json_extract(a.raw,'$.icu_rpe') AS rpe
    FROM activities a WHERE ${filtro} ORDER BY start_local DESC LIMIT 1`, ...params);
  const [leida] = await (id ? leer("id = ?", id) : leer(NO_BASURA));
  if (!leida) return { error: id ? `No existe la actividad ${id}.` : "No hay actividades." };

  const client = intervalsClient(env);
  const { estado: splitsEstado, splits, calculado } = await obtenerSplits(env, client, leida);
  // Si se acaba de calcular, la FC y las zonas sin pausas aún no estaban en la fila leída
  const a = (calculado ? (await leer("id = ?", leida.id))[0] : null) ?? leida;
  const der = deriva(splits);

  const base = fmtActivity({ ...a, hora: String(a.start_local ?? "").slice(11, 16) });
  const conRitmo = A_PIE.includes(a.sport) && (a.distance_m ?? 0) >= 500;
  // Eficiencia (eficiencia, migración 0008): COALESCE(gap, avg_speed_ms) x 60 / fc_media, en metros por latido.
  // Solo a pie, con al menos 1000 m, 1,5 m/s y FC. Ritmos: movimiento = 1000 / avg_speed_ms; total = elapsed_s / km.
  const actividad: Row = Object.fromEntries(Object.entries({
    ...base,
    ...feelExplicado(a.feel, env.WATCH),
    tiempo_total: hms(a.elapsed_s),
    ritmo_movimiento_min_km: conRitmo ? pace(a.avg_speed_ms) : null,
    ritmo_total_min_km: conRitmo ? ritmoDe(a.elapsed_s, a.distance_m) : null,
    eficiencia_m_lat: a.eficiencia, trimp: a.trimp != null ? Math.round(a.trimp) : null,
    temp_c: a.temp_avg != null ? Math.round(a.temp_avg) : null, rpe: a.rpe,
    deriva_fc_pct: der,
    // Recuperación de FC (icu_hrr, migración 0012): caída en la ventana de 60 s que da intervals; no sale en todas
    recuperacion_fc: a.hrr_bpm != null ? { inicio_lpm: a.hrr_start_bpm, fin_lpm: a.hrr_end_bpm, caida_lpm_60s: a.hrr_bpm } : null,
    // polarization_index de intervals, solo a pie y desde 500 m (en gimnasio no aporta). En estos datos, 0 cuando no hay tiempo en Z5 o más
    polarizacion: conRitmo ? a.polarization_index : null,
  }).filter(([, v]) => v != null));

  const zt = zonasFc(a);
  const ztot = zt.reduce((x, y) => x + y, 0);
  const zonas = ztot ? {
    pct_z1_z7: zt.map((z) => Math.round((100 * z) / ztot)),
    limites_fc: a.zonas_fc ? JSON.parse(a.zonas_fc) : null,
    lthr: a.lthr_used,
  } : null;

  // Comparación con actividades parecidas de las 8 semanas anteriores (56 días). Solo a pie y desde 300 m.
  // Grupo: anteriores del mismo deporte, quitando NO_BASURA, con 60-140 % de la distancia; si son menos de 3, todas las del deporte.
  // Medias simples de km, velocidad, FC (fc_media), cadencia y eficiencia. Diferencias con la media del grupo: FC en lpm,
  // eficiencia en % y ritmo en s/km (1000 / velocidad de esta actividad menos 1000 / velocidad media del grupo).
  let comparacion: Row | null = null;
  const cands: Alerta[] = [];
  if (A_PIE.includes(a.sport) && (a.distance_m ?? 0) >= 300) {
    const prev = await rows(env, `SELECT id, date, start_local, distance_m, avg_speed_ms, fc_media, cadence_spm, eficiencia
      FROM activities WHERE sport = ? AND ${NO_BASURA} AND id <> ?
        AND date BETWEEN date(?, '-56 days') AND ? ORDER BY start_local DESC`, a.sport, a.id, a.date, a.date);
    const antes = prev.filter((p) => p.start_local < a.start_local);
    // ¿Cortada? Mucho más corta de lo habitual, o varias del mismo deporte en menos de 1 h.
    // Umbrales: menos del 40 % de la mediana de las 8 anteriores, o inicios el mismo día separados 1 h como mucho.
    // Si lo está, su eficiencia no se compara (sale peor por definición).
    const medKm = median(antes.slice(0, 8).map((p) => p.distance_m));
    const seguidas = prev.filter((p) => p.date === a.date &&
      Math.abs(new Date(p.start_local + "Z").getTime() - new Date(a.start_local + "Z").getTime()) <= 3600_000);
    const cortada = Boolean((medKm && a.distance_m < medKm * 0.4) || seguidas.length);
    let grupo = antes.filter((p) => p.distance_m >= a.distance_m * 0.6 && p.distance_m <= a.distance_m * 1.4);
    let criterio = "distancia similar (±40 %)";
    if (grupo.length < 3) { grupo = antes; criterio = "todas las del mismo deporte"; }
    if (grupo.length) {
      const m = {
        km: avg(grupo.map((g) => g.distance_m / 1000)), v: avg(grupo.map((g) => g.avg_speed_ms)),
        fc: avg(grupo.map((g) => g.fc_media)), ppm: avg(grupo.map((g) => g.cadence_spm)), ef: avg(grupo.map((g) => g.eficiencia)),
      };
      comparacion = {
        n: grupo.length, criterio, ventana: "8 semanas",
        media: Object.fromEntries(Object.entries({
          km: m.km != null ? round(m.km, 1) : null, ritmo_min_km: pace(m.v), fc: m.fc != null ? Math.round(m.fc) : null,
          ppm: m.ppm != null ? Math.round(m.ppm) : null, eficiencia_m_lat: m.ef != null ? round(m.ef, 3) : null,
        }).filter(([, v]) => v != null)),
        diferencia: Object.fromEntries(Object.entries({
          ritmo_s_km: m.v && a.avg_speed_ms ? Math.round(1000 / a.avg_speed_ms - 1000 / m.v) : null,
          fc: m.fc != null && a.fc_media != null ? Math.round(a.fc_media - m.fc) : null,
          eficiencia_pct: m.ef && a.eficiencia ? round((a.eficiencia / m.ef - 1) * 100, 1) : null,
        }).filter(([, v]) => v != null)),
      };
      // FC alta para el ritmo: eficiencia por debajo del 92 % de la media, con al menos 3 en el grupo y sin estar cortada
      if (m.ef && a.eficiencia && grupo.length >= 3 && a.eficiencia < m.ef * 0.92 && !cortada) {
        cands.push({
          clave: `fc_alta:${a.id}`, prioridad: 2, fecha: a.date,
          motivo: `Eficiencia aeróbica un ${Math.round((1 - a.eficiencia / m.ef) * 100)} % peor que tu media reciente: FC alta para el ritmo.`,
          pregunta_sugerida: "¿Hacía calor, dormiste mal o venías cansado?",
        });
      }
    }
    if (cortada) {
      cands.push({
        clave: `cortada:${a.id}`, prioridad: 3, fecha: a.date,
        motivo: seguidas.length
          ? `Hay ${seguidas.length + 1} actividades de ${a.sport} seguidas el ${a.date}: puede que la grabación se cortara.`
          : `${round(a.distance_m / 1000, 1)} km frente a tu habitual de ${round(medKm! / 1000, 1)} km.`,
        pregunta_sugerida: "¿Se cortó la grabación o paraste por algo (molestia, cansancio)?",
      });
    }
    // Deriva alta: más de un 8 %
    if (der != null && der > 8) {
      cands.push({
        clave: `deriva:${a.id}`, prioridad: 1, fecha: a.date,
        motivo: `Deriva cardiaca del ${der} % entre la primera y la segunda mitad.`,
        pregunta_sugerida: "¿El ritmo fue constante o apretaste al final?",
      });
    }
  }
  // Sin sensaciones: ni feel ni RPE, en una actividad de 10 min o más (moving_s)
  if (a.feel == null && a.rpe == null && a.moving_s >= 600) {
    cands.push({
      clave: `feel:${a.id}`, prioridad: 1, fecha: a.date,
      motivo: "No registraste sensaciones en el reloj.",
      pregunta_sugerida: "¿Qué tal te sentiste? (puedes valorarlo en el reloj para que quede registrado)",
    });
  }

  // Gimnasio de pierna en las 48 h anteriores a una sesión dura (solo actividades a pie)
  const gym48 = a.start_utc ? await gymReciente(env, 48, a.start_utc) : [];
  if (A_PIE.includes(a.sport) && esDura(a)) {
    const pierna = gym48.find((g) => g.pierna);
    if (pierna) {
      cands.push({
        clave: `pierna48:${a.id}`, prioridad: 2, fecha: a.date,
        motivo: `Sesión exigente ${pierna.horas_antes} h después de un gimnasio de pierna ("${pierna.titulo}").`,
        pregunta_sugerida: "¿Notaste las piernas cargadas?",
      });
    }
  }

  // Si es una sesión de gimnasio del reloj, los ejercicios vienen de Hevy
  let gimnasio: Row | null = null;
  if (a.sport === "WeightTraining" && a.start_utc) {
    const [w] = await rows(env, `SELECT id, title FROM gym_workouts
      WHERE abs(julianday(start_time) - julianday(?)) < 0.0625 ORDER BY abs(julianday(start_time) - julianday(?)) LIMIT 1`,
    a.start_utc, a.start_utc);
    if (w) {
      const ej = await rows(env, `SELECT template_id, MAX(exercise) AS ejercicio,
          SUM(CASE WHEN COALESCE(set_type,'normal') != 'warmup' THEN 1 ELSE 0 END) AS series,
          MAX(weight_kg) AS peso_max, MAX(reps) AS reps_max, MAX(duration_s) AS seg_max
        FROM gym_sets WHERE workout_id = ? GROUP BY template_id ORDER BY MIN(exercise_index)`, w.id);
      gimnasio = { titulo: w.title, ejercicios: tabla(ej, ["ejercicio", "series", "peso_max", "reps_max", "seg_max"]) };
    }
  }

  // Plan frente a hecho: un fallo de intervals.icu no debe romper la revisión
  let plan: Row | null = null;
  try {
    const p = await planDelDia(env, a.date, a.sport);
    if (p) plan = { ...p, hecho: hms(tiempoEnMarcha(a)) };
  } catch { /* sin plan */ }

  const [f] = await rows(env, `SELECT date, ROUND(ctl,1) AS ctl, ROUND(atl,1) AS atl, ROUND(ctl-atl,1) AS tsb,
      resting_hr AS fc_reposo, hrv AS vfc, ROUND(sleep_s/3600.0,1) AS sueno_h,
      sleep_score AS sueno_puntuacion, avg_sleeping_hr AS fc_sueno
    FROM wellness WHERE date <= ? AND ctl IS NOT NULL ORDER BY date DESC LIMIT 1`, a.date);

  const [carga, well, { notas, omitidas }] = await Promise.all([cargaSemanal(env), bienestar(env), notasAbiertas(env)]);
  const alertas = await emitir(env, [...cands, ...alertasEstado(env, carga, well, notas)], a.id);

  return Object.fromEntries(Object.entries({
    actividad, zonas,
    splits: splits.length
      ? tabla(splits.map((s) => ({
        km: s.km, dist_m: s.dist_m < 950 ? s.dist_m : null, ritmo: mmss(s.pace_s), fc: s.hr, ppm: s.cadence_spm, desnivel_m: s.elev_m,
      })), ["km", "dist_m", "ritmo", "fc", "ppm", "desnivel_m"])
      : (A_PIE.includes(a.sport) ? splitsEstado : null),
    plan, comparacion, gimnasio,
    gym_48h_antes: gym48.length ? gym48.map(({ id, ...g }) => g) : null,
    forma_ese_dia: f ?? null,
    notas_abiertas: notas.length ? notas.map((n) => ({ id: n.id, fecha: n.fecha, tipo: n.tipo, texto: n.texto })) : null,
    notas_omitidas: omitidas,
    alertas,
    sync: sync && (sync as Row).error ? sync : undefined,
  }).filter(([, v]) => v != null && v !== undefined));
}

// --- estado_atleta ----------------------------------------------------------
export async function estadoAtleta(env: Env) {
  const hoy = today(env.TZ);
  const [carga, well, { notas, omitidas }] = await Promise.all([cargaSemanal(env), bienestar(env), notasAbiertas(env)]);
  const forma = well.find((w) => w.ctl != null);

  const porDeporte = await rows(env, `SELECT sport AS deporte,
      SUM(date >= ?) AS sesiones_7d, ROUND(SUM(CASE WHEN date >= ? THEN distance_m END)/1000.0,1) AS km_7d,
      ROUND(SUM(CASE WHEN date >= ? THEN training_load END)) AS carga_7d,
      COUNT(*) AS sesiones_28d, ROUND(SUM(distance_m)/1000.0,1) AS km_28d, ROUND(SUM(training_load)) AS carga_28d
    FROM activities WHERE date >= ? AND ${NO_BASURA} GROUP BY sport ORDER BY carga_28d DESC`,
  since(env, 6), since(env, 6), since(env, 6), since(env, 27));

  // Último entreno duro de los últimos 21 días, de cualquier deporte: misma regla que esDura
  const [duro] = await rows(env, `${ACT_SELECT.replace("FROM activities", ", intensity FROM activities")}
    WHERE date >= ? AND ${NO_BASURA} AND (intensity >= ${INTENSIDAD_DURA}
      OR COALESCE(fc_z4_s,0)+COALESCE(fc_z5_s,0)+COALESCE(fc_z6_s,0)+COALESCE(fc_z7_s,0) >= 600)
    ORDER BY start_local DESC LIMIT 1`, since(env, 21));

  const [ultCarrera] = await rows(env, `${ACT_SELECT} WHERE ${CARRERA} AND ${NO_BASURA} ORDER BY start_local DESC LIMIT 1`);
  const gym72 = await gymReciente(env, 72);

  // Recuperación: medianas de 28 días (con al menos 10 valores) y las 7 filas de wellness más recientes
  const rhr = well.map((w) => w.resting_hr).filter((x) => x != null);
  const hrv = well.map((w) => w.hrv).filter((x) => x != null);
  const ult7 = well.slice(0, 7);
  // Pasos: media de los 7 días anteriores a hoy, porque el de hoy aún no está completo. Sin datos, no sale
  const pasos = avg(well.filter((w) => w.date < hoy).slice(0, 7).map((w) => w.steps));

  // Umbrales en vivo de intervals.icu (carrera); si falla, los de la última carrera guardada
  let umbrales: Row | null = null;
  const client = intervalsClient(env);
  if (client) {
    try {
      const prof = await client.athleteProfile();
      const run = (prof?.sportSettings ?? []).find((s: Row) => (s.types ?? []).includes("Run"));
      if (run) {
        umbrales = {
          fuente: "intervals.icu (Run)", lthr: run.lthr, fc_max: run.max_hr, zonas_fc_limites: run.hr_zones,
          ritmo_umbral_min_km: run.threshold_pace ? pace(run.threshold_pace) : null,
          zonas_ritmo: run.pace_zones ?? null, fc_reposo_perfil: prof?.icu_resting_hr ?? null,
        };
      }
    } catch { /* se usa la última carrera */ }
  }
  if (!umbrales) {
    const [u] = await rows(env, `SELECT json_extract(raw,'$.lthr') AS lthr, json_extract(raw,'$.icu_hr_zones') AS z
      FROM activities WHERE ${CARRERA} ORDER BY start_local DESC LIMIT 1`);
    if (u) umbrales = { fuente: "última carrera", lthr: u.lthr, zonas_fc_limites: u.z ? JSON.parse(u.z) : null };
  }
  if (umbrales) umbrales = Object.fromEntries(Object.entries(umbrales).filter(([, v]) => v != null));

  const cands = alertasEstado(env, carga, well, notas);
  // Pierna reciente: gimnasio de pierna hace menos de 48 h, dentro de la ventana de 72 h. Caduca al cumplirse las 48 h,
  // y el texto lleva la fecha porque esta alerta puede volver a salir más tarde en otro chat
  const piernaReciente = gym72.find((g) => g.pierna && g.horas_antes != null && g.horas_antes < 48);
  if (piernaReciente) {
    cands.push({
      clave: `pierna_hoy:${piernaReciente.id}`, prioridad: 1,
      caduca: new Date(Date.now() + (48 - piernaReciente.horas_antes) * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      motivo: `Gimnasio de pierna el ${piernaReciente.fecha} ("${piernaReciente.titulo}"): mejor no hacer calidad hasta pasadas 48 h.`,
      pregunta_sugerida: "¿Cómo tienes las piernas hoy?",
    });
  }
  const alertas = await emitir(env, cands);

  // Ratio de carga = c7 / (c28 / 4). Los totales lo incluyen todo y por_deporte quita NO_BASURA: pueden no cuadrar
  return Object.fromEntries(Object.entries({
    version: VERSION,
    fecha: hoy,
    forma: forma ? { fecha: forma.date, ctl: round(forma.ctl), atl: round(forma.atl), tsb: round(forma.ctl - forma.atl) } : null,
    carga: {
      ultimos_7d: Math.round(carga.c7), media_semanal_4sem: Math.round(carga.c28 / 4),
      ratio: carga.c28 ? round(carga.c7 / (carga.c28 / 4), 2) : null,
      por_deporte: tabla(porDeporte, ["deporte", "sesiones_7d", "km_7d", "carga_7d", "sesiones_28d", "km_28d", "carga_28d"]),
    },
    recuperacion: {
      fc_reposo_7d: ult7.map((w) => w.resting_hr), fc_reposo_mediana_28d: rhr.length >= 10 ? median(rhr) : null,
      vfc_7d: ult7.map((w) => w.hrv), vfc_mediana_28d: hrv.length >= 10 ? median(hrv) : null,
      sueno_h_media_7d: (() => { const s = avg(ult7.map((w) => (w.sleep_s != null ? w.sleep_s / 3600 : null))); return s != null ? round(s) : null; })(),
      sueno_puntuacion_7d: ult7.map((w) => w.sleep_score), fc_sueno_7d: ult7.map((w) => w.avg_sleeping_hr),
      pasos_media_7d: pasos != null ? Math.round(pasos) : undefined,
      orden: "días más recientes primero",
    },
    ultima_carrera: ultCarrera ? fmtActivity(ultCarrera) : null,
    ultimo_entreno_duro: duro ? { ...fmtActivity(duro), dias_desde: Math.round((Date.parse(hoy) - Date.parse(duro.date)) / 86400000) } : null,
    gimnasio_72h: gym72.length ? gym72.map(({ id, ...g }) => g) : null,
    notas_abiertas: notas.length ? notas.map((n) => ({ id: n.id, fecha: n.fecha, tipo: n.tipo, texto: n.texto })) : null,
    notas_omitidas: omitidas,
    umbrales,
    sincronizacion: await saludSync(env),
    alertas,
  }).filter(([, v]) => v != null));
}

/** Última sincronización, errores de la última vuelta, fallos consecutivos por fuente y, mientras dure, la importación del histórico. */
async function saludSync(env: Env) {
  const st = await getStates(env, ["last_sync", "last_sync_result", "fallos_intervals", "fallos_hevy",
    "intervals_backfill_done", "intervals_cursor", "hevy_since"]);
  const historico = Object.fromEntries(Object.entries({
    reloj: st.intervals_backfill_done === "1" ? null : `importando (va por ${st.intervals_cursor ?? "el inicio"})`,
    hevy: !conHevy(env) ? "desactivado (falta HEVY_API_KEY)" : st.hevy_since ? null : "importando",
  }).filter(([, v]) => v != null));
  let res: Row = {};
  try { res = JSON.parse(st.last_sync_result ?? "{}"); } catch { /* sin resultado */ }
  const errores = Object.fromEntries(Object.entries(res)
    .filter(([, v]) => v && typeof v === "object" && (v as Row).error).map(([k, v]) => [k, String((v as Row).error).slice(0, 120)]));
  const fallos = { intervals: Number(st.fallos_intervals ?? 0), hevy: Number(st.fallos_hevy ?? 0) };
  return Object.fromEntries(Object.entries({
    ultima: st.last_sync ?? null,
    errores: Object.keys(errores).length ? errores : null,
    fallos_seguidos: fallos.intervals || fallos.hevy ? fallos : null,
    historico: Object.keys(historico).length ? historico : null,
  }).filter(([, v]) => v != null));
}

// --- nota -------------------------------------------------------------------
export async function nota(env: Env, args: { texto?: string; tipo?: string; cerrar?: number; revisada?: number; resolver_alerta?: string }) {
  const hoy = today(env.TZ);
  const hecho: string[] = [];
  if (args.texto) {
    await env.DB.prepare("INSERT INTO notas (fecha, tipo, texto) VALUES (?, ?, ?)").bind(hoy, args.tipo ?? "otro", args.texto).run();
    hecho.push("nota creada");
  }
  if (args.cerrar != null) {
    const r = await env.DB.prepare("UPDATE notas SET estado='cerrada', revisada=? WHERE id=?").bind(hoy, args.cerrar).run();
    hecho.push(r.meta.changes ? `nota ${args.cerrar} cerrada` : `no existe la nota ${args.cerrar}`);
  }
  if (args.revisada != null) {
    const r = await env.DB.prepare("UPDATE notas SET revisada=? WHERE id=?").bind(hoy, args.revisada).run();
    hecho.push(r.meta.changes ? `nota ${args.revisada} revisada hoy` : `no existe la nota ${args.revisada}`);
  }
  if (args.resolver_alerta) {
    const r = await env.DB.prepare("UPDATE alertas_activas SET resuelta=? WHERE clave=? AND resuelta IS NULL").bind(nowIso(), args.resolver_alerta).run();
    hecho.push(r.meta.changes ? `alerta ${args.resolver_alerta} resuelta` : `no hay ninguna alerta sin resolver con la clave ${args.resolver_alerta}`);
  }
  const { notas, omitidas } = await notasAbiertas(env);
  return { hecho, abiertas: tabla(notas, ["id", "fecha", "tipo", "texto", "revisada"]), omitidas: omitidas ?? undefined };
}
