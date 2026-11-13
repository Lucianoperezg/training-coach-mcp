/**
 * Análisis por semanas: historial (volumen, zonas, gimnasio por músculo) y progreso (tendencia con pendiente).
 * Las semanas van de lunes a domingo; "semana" es la fecha del lunes.
 * En progreso solo cuentan semanas completas: la semana en curso no lo está (tampoco el domingo, hasta medianoche local),
 * y la ventana suele empezar a mitad de la semana más antigua, que se descarta.
 */
import type { Env } from "./env";
import { addDays, today } from "./env";
import { GYM_FECHA, mmss, round, type Row, rows, tabla, TIEMPO_SQL } from "./format";

const SEMANA = (col: string) => `date(${col}, 'weekday 0', '-6 days')`;
// Misma regla que en coach.ts: fuera lo de menos de 120 s en moving_s y lo que va a pie de 1 a 299 m
const NO_BASURA = "moving_s >= 120 AND NOT (sport IN ('Run','TrailRun','VirtualRun','Walk','Hike') AND COALESCE(distance_m,0) BETWEEN 1 AND 299)";
const CARRERA = "sport IN ('Run','TrailRun') AND distance_m >= 1000";
const MIN_SEMANAS_TENDENCIA = 4; // semanas completas con dato
const NOTA_EN_CURSO = "incompleta: no cuenta en la tendencia ni en la pendiente";

const desdeSemanas = (env: Env, semanas: number) => addDays(today(env.TZ), -(semanas * 7 + 6));

/** Lunes de la semana de una fecha YYYY-MM-DD. */
const lunesDe = (fecha: string) => addDays(fecha, -((new Date(fecha + "T00:00:00Z").getUTCDay() + 6) % 7));

/**
 * Separa las filas semanales en semanas completas y semana en curso (según la fecha local de hoy).
 * Una semana cuyo lunes queda antes de desde solo entra en parte y se descarta. Con desdeSemanas(n) quedan
 * exactamente las n semanas terminadas más recientes, sea el día que sea.
 */
function separarSemanas(env: Env, filas: Row[], desde: string) {
  const lunes = lunesDe(today(env.TZ));
  return { completas: filas.filter((x) => x.semana >= desde && x.semana < lunes), enCurso: filas.find((x) => x.semana === lunes) };
}

// --- historial --------------------------------------------------------------
export async function historial(env: Env, semanas: number) {
  const desde = desdeSemanas(env, semanas);
  const cardio = await rows(env, `SELECT ${SEMANA("date")} AS semana,
      COUNT(*) AS sesiones,
      ROUND(SUM(CASE WHEN sport IN ('Run','TrailRun','VirtualRun','Walk','Hike') THEN distance_m END)/1000.0, 1) AS km,
      ROUND(SUM(${TIEMPO_SQL})/3600.0, 1) AS horas,
      ROUND(SUM(training_load)) AS carga,
      ROUND(MAX(CASE WHEN ${CARRERA} THEN distance_m END)/1000.0, 1) AS larga_km,
      SUM(COALESCE(fc_z1_s,0)+COALESCE(fc_z2_s,0)) AS z12, SUM(COALESCE(fc_z3_s,0)) AS z3,
      SUM(COALESCE(fc_z4_s,0)+COALESCE(fc_z5_s,0)+COALESCE(fc_z6_s,0)+COALESCE(fc_z7_s,0)) AS z4
    FROM activities WHERE date BETWEEN ? AND ? AND sport != 'WeightTraining' AND ${NO_BASURA} GROUP BY semana`, desde, today(env.TZ));
  const gym = await rows(env, `SELECT ${SEMANA(GYM_FECHA)} AS semana, COUNT(DISTINCT w.id) AS sesiones,
      SUM(CASE WHEN COALESCE(s.set_type,'normal') != 'warmup' THEN 1 ELSE 0 END) AS series,
      ROUND(SUM(CASE WHEN COALESCE(s.set_type,'normal') != 'warmup' THEN COALESCE(s.weight_kg,0)*COALESCE(s.reps,0) ELSE 0 END)) AS volumen_kg
    FROM gym_workouts w LEFT JOIN gym_sets s ON s.workout_id = w.id WHERE ${GYM_FECHA} >= ? GROUP BY semana`, desde);
  // Series efectivas por grupo muscular principal; las plantillas aún sin clasificar se cuentan aparte
  const musc = await rows(env, `SELECT ${SEMANA(GYM_FECHA)} AS semana, COALESCE(t.primary_muscle, 'sin_clasificar') AS musculo,
      COUNT(*) AS series
    FROM gym_sets s JOIN gym_workouts w ON w.id = s.workout_id LEFT JOIN exercise_templates t ON t.id = s.template_id
    WHERE ${GYM_FECHA} >= ? AND COALESCE(s.set_type,'normal') != 'warmup' GROUP BY semana, musculo ORDER BY series DESC`, desde);

  const semanasMap = new Map<string, Row>();
  const fila = (k: string) => semanasMap.get(k) ?? semanasMap.set(k, { semana: k }).get(k)!;
  for (const c of cardio) {
    const tot = c.z12 + c.z3 + c.z4;
    Object.assign(fila(c.semana), {
      sesiones: c.sesiones, km: c.km, horas: c.horas, carga: c.carga, larga_km: c.larga_km,
      z12_pct: tot ? Math.round((100 * c.z12) / tot) : null, z3_pct: tot ? Math.round((100 * c.z3) / tot) : null,
      z4mas_pct: tot ? Math.round((100 * c.z4) / tot) : null,
    });
  }
  for (const g of gym) Object.assign(fila(g.semana), { gym: g.sesiones, series: g.series, volumen_kg: g.volumen_kg || null });
  for (const m of musc) {
    const f = fila(m.semana);
    f.musculos = f.musculos ? `${f.musculos}, ${m.musculo} ${m.series}` : `${m.musculo} ${m.series}`;
  }
  const lista = [...semanasMap.values()].sort((a, b) => a.semana.localeCompare(b.semana)).slice(-semanas);
  return {
    semanas: tabla(lista, ["semana", "sesiones", "km", "horas", "carga", "larga_km", "z12_pct", "z3_pct", "z4mas_pct",
      "gym", "series", "volumen_kg", "musculos"]),
    notas: "Cardio sin gimnasio del reloj; zonas por tiempo de FC, sin las pausas del reloj en las actividades a pie; músculos = series efectivas por grupo principal (Hevy).",
  };
}

// --- progreso ---------------------------------------------------------------
interface Metrica { sql: string; unidad: string; mejorSi: "baja" | "sube"; fmt?: (v: number) => string | null; desc: string }

// Cada métrica devuelve (semana, valor, n) por semana
// Ventana: las semanas pedidas (ver desdeSemanas). Origen: activities o wellness, ambas de intervals.
// - eficiencia: media de eficiencia (migración 0008; COALESCE(gap, avg_speed_ms) x 60 / fc_media).
// - ritmo y ritmo_z2: suma de TIEMPO_SQL x 1000 / suma de distance_m, en carreras de al menos 1000 m.
// - fc, ppm, fc_reposo y vfc: medias simples por semana; ctl: el valor del último día con dato; km y carga: sumas, quitando NO_BASURA.
export const METRICAS: Record<string, Metrica> = {
  eficiencia: {
    desc: "metros por latido (GAP) en carreras, sin las pausas del reloj", unidad: "m/latido", mejorSi: "sube",
    sql: `SELECT ${SEMANA("date")} AS semana, AVG(eficiencia) AS valor, COUNT(eficiencia) AS n
      FROM activities WHERE date BETWEEN ? AND ? AND ${CARRERA} AND eficiencia IS NOT NULL GROUP BY semana`,
  },
  ritmo: {
    desc: "ritmo medio de las carreras", unidad: "s/km", mejorSi: "baja", fmt: mmss,
    sql: `SELECT ${SEMANA("date")} AS semana, SUM(${TIEMPO_SQL}) * 1000.0 / SUM(distance_m) AS valor, COUNT(*) AS n
      FROM activities WHERE date BETWEEN ? AND ? AND ${CARRERA} GROUP BY semana`,
  },
  ritmo_z2: {
    desc: "ritmo de las carreras con al menos 70 % del tiempo en Z1-Z2 (ritmo a FC baja)", unidad: "s/km", mejorSi: "baja", fmt: mmss,
    sql: `SELECT ${SEMANA("date")} AS semana, SUM(${TIEMPO_SQL}) * 1000.0 / SUM(distance_m) AS valor, COUNT(*) AS n
      FROM activities WHERE date BETWEEN ? AND ? AND ${CARRERA}
        AND (COALESCE(fc_z1_s,0)+COALESCE(fc_z2_s,0)) >= 0.7 * (COALESCE(fc_z1_s,0)+COALESCE(fc_z2_s,0)+COALESCE(fc_z3_s,0)
          +COALESCE(fc_z4_s,0)+COALESCE(fc_z5_s,0)+COALESCE(fc_z6_s,0)+COALESCE(fc_z7_s,0))
      GROUP BY semana`,
  },
  fc: {
    desc: "FC media de las carreras, sin las pausas del reloj", unidad: "lpm", mejorSi: "baja",
    sql: `SELECT ${SEMANA("date")} AS semana, AVG(fc_media) AS valor, COUNT(fc_media) AS n
      FROM activities WHERE date BETWEEN ? AND ? AND ${CARRERA} GROUP BY semana`,
  },
  ppm: {
    desc: "cadencia media de las carreras", unidad: "pasos/min", mejorSi: "sube",
    sql: `SELECT ${SEMANA("date")} AS semana, AVG(cadence_spm) AS valor, COUNT(cadence_spm) AS n
      FROM activities WHERE date BETWEEN ? AND ? AND ${CARRERA} GROUP BY semana`,
  },
  km: {
    desc: "km de carrera por semana", unidad: "km", mejorSi: "sube",
    sql: `SELECT ${SEMANA("date")} AS semana, SUM(distance_m) / 1000.0 AS valor, COUNT(*) AS n
      FROM activities WHERE date BETWEEN ? AND ? AND sport IN ('Run','TrailRun') AND ${NO_BASURA} GROUP BY semana`,
  },
  carga: {
    desc: "carga de entrenamiento semanal (todas las actividades)", unidad: "carga", mejorSi: "sube",
    sql: `SELECT ${SEMANA("date")} AS semana, SUM(training_load) AS valor, COUNT(*) AS n
      FROM activities WHERE date BETWEEN ? AND ? AND ${NO_BASURA} GROUP BY semana`,
  },
  ctl: {
    desc: "fitness (CTL) al final de cada semana", unidad: "CTL", mejorSi: "sube",
    // SQLite toma ctl de la fila con MAX(date): el último día con dato de cada semana
    sql: `SELECT ${SEMANA("date")} AS semana, MAX(date) AS ultimo, ctl AS valor, COUNT(ctl) AS n
      FROM wellness WHERE date BETWEEN ? AND ? AND ctl IS NOT NULL GROUP BY semana`,
  },
  fc_reposo: {
    desc: "FC en reposo media", unidad: "lpm", mejorSi: "baja",
    sql: `SELECT ${SEMANA("date")} AS semana, AVG(resting_hr) AS valor, COUNT(resting_hr) AS n
      FROM wellness WHERE date BETWEEN ? AND ? GROUP BY semana`,
  },
  vfc: {
    desc: "VFC media", unidad: "ms", mejorSi: "sube",
    sql: `SELECT ${SEMANA("date")} AS semana, AVG(hrv) AS valor, COUNT(hrv) AS n
      FROM wellness WHERE date BETWEEN ? AND ? GROUP BY semana`,
  },
};

/**
 * Recta de mínimos cuadrados: pendiente por semana y valores ajustados al inicio y al final.
 * cambio_pct = (fin - ini) / |ini| x 100, con los valores de la recta.
 */
export function tendencia(puntos: { x: number; y: number }[]) {
  const n = puntos.length;
  if (n < 2) return null;
  const mx = puntos.reduce((a, p) => a + p.x, 0) / n, my = puntos.reduce((a, p) => a + p.y, 0) / n;
  const sxx = puntos.reduce((a, p) => a + (p.x - mx) ** 2, 0);
  if (!sxx) return null;
  const m = puntos.reduce((a, p) => a + (p.x - mx) * (p.y - my), 0) / sxx;
  const x0 = Math.min(...puntos.map((p) => p.x)), x1 = Math.max(...puntos.map((p) => p.x));
  const ini = my + m * (x0 - mx), fin = my + m * (x1 - mx);
  return { pendiente: m, ini, fin, cambio_pct: ini ? ((fin - ini) / Math.abs(ini)) * 100 : null };
}

/**
 * Tendencia de una serie de semanas completas. x = semanas desde la primera con valor; hacen falta MIN_SEMANAS_TENDENCIA.
 * "estable" si el cambio total es menor del 2 %; si no, el signo de la pendiente y mejorSi dan mejorando o empeorando.
 */
function resumen(serie: { semana: string; valor: number }[], mejorSi: "baja" | "sube", unidad: string) {
  if (serie.length < MIN_SEMANAS_TENDENCIA) {
    return { tendencia: `pocos datos (${serie.length} semanas completas con valor; hacen falta ${MIN_SEMANAS_TENDENCIA})` };
  }
  const base = Date.parse(serie[0].semana);
  const t = tendencia(serie.map((s) => ({ x: (Date.parse(s.semana) - base) / (7 * 86400000), y: s.valor })))!;
  if (!t) return { tendencia: "sin variación" };
  const mejora = mejorSi === "sube" ? t.pendiente > 0 : t.pendiente < 0;
  const plano = t.cambio_pct != null && Math.abs(t.cambio_pct) < 2;
  return {
    pendiente_por_semana: `${t.pendiente >= 0 ? "+" : ""}${round(t.pendiente, unidad === "m/latido" ? 4 : 2)} ${unidad}`,
    cambio_total_pct: t.cambio_pct != null ? round(t.cambio_pct, 1) : null,
    tendencia: plano ? "estable" : mejora ? "mejorando" : "empeorando",
    mejor_si: mejorSi,
  };
}

export async function progreso(env: Env, args: { metrica?: string; ejercicio?: string; semanas: number }) {
  const desde = desdeSemanas(env, args.semanas);
  if (args.ejercicio) return progresoEjercicio(env, args.ejercicio, desde);
  const clave = args.metrica ?? "eficiencia";
  const m = METRICAS[clave];
  if (!m) return { error: `Métrica desconocida. Opciones: ${Object.keys(METRICAS).join(", ")}.` };
  const r = (await rows(env, m.sql, desde, today(env.TZ))).filter((x) => x.valor != null).sort((a, b) => a.semana.localeCompare(b.semana));
  const { completas, enCurso } = separarSemanas(env, r, desde);
  const dec = m.unidad === "m/latido" ? 3 : 1;
  const fila = (x: Row) => ({ semana: x.semana, valor: m.fmt ? m.fmt(x.valor) : round(x.valor, dec), n: x.n });
  return {
    metrica: clave, descripcion: m.desc, unidad: m.unidad,
    ...resumen(completas.map((x) => ({ semana: x.semana, valor: x.valor })), m.mejorSi, m.unidad),
    semanas: tabla(completas.map(fila), ["semana", "valor", "n"]),
    semana_en_curso: enCurso ? { ...fila(enCurso), nota: NOTA_EN_CURSO } : undefined,
  };
}

/**
 * Tendencia de un ejercicio (Hevy), sin series de calentamiento. Por semana y plantilla:
 * - e1RM (Epley) = peso x (1 + reps / 30), solo con peso > 0 y reps > 0; se toma el máximo de la semana.
 * - Sin peso en ninguna semana: mejor duración y, si tampoco hay, más repeticiones.
 * v_gym (migración 0002) usa la misma fórmula por serie, redondeada a 1 decimal y también en calentamientos.
 */
async function progresoEjercicio(env: Env, ejercicio: string, desde: string) {
  const r = await rows(env, `SELECT ${SEMANA(GYM_FECHA)} AS semana, s.template_id,
      MAX(CASE WHEN s.weight_kg > 0 AND s.reps > 0 THEN s.weight_kg * (1 + s.reps / 30.0) END) AS e1rm,
      MAX(s.reps) AS reps, MAX(s.duration_s) AS seg, COUNT(*) AS series
    FROM gym_sets s JOIN gym_workouts w ON w.id = s.workout_id
    WHERE s.template_id IN (SELECT DISTINCT template_id FROM gym_sets WHERE exercise LIKE ?)
      AND COALESCE(s.set_type,'normal') != 'warmup' AND ${GYM_FECHA} >= ?
    GROUP BY semana, s.template_id ORDER BY semana`, `%${ejercicio}%`, desde);
  if (!r.length) {
    const lista = await rows(env, `SELECT (SELECT exercise FROM gym_sets s2 WHERE s2.template_id = s.template_id
        ORDER BY s2.start_time DESC LIMIT 1) AS ejercicio, COUNT(DISTINCT workout_id) AS sesiones
      FROM gym_sets s GROUP BY template_id ORDER BY sesiones DESC LIMIT 40`);
    return { error: `No hay series de '${ejercicio}' en ese periodo.`, ejercicios_disponibles: lista.map((x) => x.ejercicio) };
  }
  // Si coinciden varias plantillas, se analiza la más frecuente
  const freq = new Map<string, number>();
  for (const x of r) freq.set(x.template_id, (freq.get(x.template_id) ?? 0) + 1);
  const tpl = [...freq.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const [nom] = await rows(env, "SELECT exercise FROM gym_sets WHERE template_id = ? ORDER BY start_time DESC LIMIT 1", tpl);
  const serie = r.filter((x) => x.template_id === tpl);
  const conPeso = serie.some((x) => x.e1rm);
  const campo = conPeso ? "e1rm" : serie.some((x) => x.seg) ? "seg" : "reps";
  const unidad = campo === "e1rm" ? "kg (1RM estimado)" : campo === "seg" ? "s (mejor serie)" : "reps (mejor serie)";
  const { completas, enCurso } = separarSemanas(env, serie, desde);
  const valores = completas.filter((x) => x[campo] != null).map((x) => ({ semana: x.semana, valor: x[campo] as number }));
  const fila = (x: Row) => ({ semana: x.semana, valor: x[campo] != null ? round(x[campo], 1) : null, series: x.series });
  const otras = [...freq.keys()].filter((k) => k !== tpl);
  return {
    ejercicio: nom?.exercise ?? ejercicio, unidad,
    ...resumen(valores, "sube", unidad.split(" ")[0]),
    semanas: tabla(completas.map(fila), ["semana", "valor", "series"]),
    semana_en_curso: enCurso ? { ...fila(enCurso), nota: NOTA_EN_CURSO } : undefined,
    otras_coincidencias: otras.length ? `${otras.length} ejercicio(s) más coinciden; afina el nombre` : undefined,
  };
}
