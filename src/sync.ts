/**
 * Sincronización intervals.icu + Hevy → D1.
 * La importación inicial del histórico se hace por tramos a lo largo de varias ejecuciones
 * del cron, para no pasar del límite de subpeticiones del plan gratuito.
 */
import { Budget, HevyClient, IntervalsClient } from "./clients";
import { addDays, conHevy, type Env, getStates, localDate, nowIso, setStateStmt, today } from "./env";
import { rows } from "./format";
import { rutinaStmt, rutinaValida } from "./rutinas";
import { calcularSplits, SPLITS_POR_CALCULAR_SQL } from "./splits";

// El plan gratuito permite 50 subpeticiones por ejecución, y cuentan tanto las llamadas
// a intervals.icu/Hevy como las consultas a D1. Dejamos margen.
const TOTAL_BUDGET = 45;
const INTERVALS_BUDGET = 16;
// Límite de 10 ms de CPU por ejecución: poco trabajo por vuelta y el cron hace el resto.
const MAX_CHUNKS_PER_RUN = 4;      // 4 tramos x 45 días = 6 meses de histórico por ejecución
const MAX_HEVY_PAGES_PER_RUN = 8;  // 8 páginas x 10 entrenos
const CHUNK_DAYS = 45;             // tamaño de cada tramo del histórico
const REFRESH_DAYS = 14;      // re-descarga los últimos N días por si editas algo
const EXTRAS_BUDGET = 10;     // reservado para plantillas de Hevy (hasta 5) y splits pendientes (4)
const MAX_TEMPLATES_PER_RUN = 3;
const RUTINAS_BUDGET = 6;     // 1 batch + hasta 2 páginas de rutinas y 3 de carpetas
const MAX_PAGINAS_RUTINAS = 2;
const MAX_PAGINAS_CARPETAS = 3;

const n = (v: any) => (v === undefined ? null : v);

// --- intervals.icu ----------------------------------------------------------
function activityStmt(env: Env, a: any, syncedAt: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO activities (id, start_local, sport, name, distance_m, moving_s, elapsed_s, elev_gain_m,
       avg_hr, max_hr, avg_cadence, avg_speed_ms, avg_watts, training_load, intensity, raw, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       start_local=excluded.start_local, sport=excluded.sport, name=excluded.name,
       distance_m=excluded.distance_m, moving_s=excluded.moving_s, elapsed_s=excluded.elapsed_s,
       elev_gain_m=excluded.elev_gain_m, avg_hr=excluded.avg_hr, max_hr=excluded.max_hr,
       avg_cadence=excluded.avg_cadence, avg_speed_ms=excluded.avg_speed_ms,
       avg_watts=excluded.avg_watts, training_load=excluded.training_load,
       intensity=excluded.intensity, raw=excluded.raw, synced_at=excluded.synced_at`,
  ).bind(
    String(a.id), n(a.start_date_local), n(a.type), n(a.name), n(a.distance), n(a.moving_time),
    n(a.elapsed_time), n(a.total_elevation_gain), n(a.average_heartrate), n(a.max_heartrate),
    n(a.average_cadence), n(a.average_speed), n(a.icu_average_watts ?? a.average_watts),
    n(a.icu_training_load), n(a.icu_intensity), JSON.stringify(a), syncedAt,
  );
}

function wellnessStmt(env: Env, w: any): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO wellness (date, ctl, atl, ramp_rate, resting_hr, hrv, sleep_s, weight, raw)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET ctl=excluded.ctl, atl=excluded.atl, ramp_rate=excluded.ramp_rate,
       resting_hr=excluded.resting_hr, hrv=excluded.hrv, sleep_s=excluded.sleep_s,
       weight=excluded.weight, raw=excluded.raw`,
  ).bind(w.id, n(w.ctl), n(w.atl), n(w.rampRate), n(w.restingHR), n(w.hrv), n(w.sleepSecs), n(w.weight), JSON.stringify(w));
}

/** Un tramo = 2 llamadas a intervals.icu + 1 batch en D1 (3 subpeticiones). */
async function syncIntervalsChunk(
  env: Env, client: IntervalsClient, oldest: string, newest: string, extra: D1PreparedStatement[] = [],
) {
  const list = await client.activities(oldest, newest);
  const acts = (list ?? []).filter((a) => a?.id);
  const well = (await client.wellness(oldest, newest)).filter((w) => w?.id);
  const syncedAt = nowIso();
  const stmts: D1PreparedStatement[] = [
    ...acts.map((a) => activityStmt(env, a, syncedAt)),
    ...well.map((w) => wellnessStmt(env, w)),
  ];
  // Borra las actividades que ya no existen en intervals.icu dentro de este tramo.
  // Solo con una lista válida y no vacía: un 404 o una respuesta rara vaciaría el tramo entero.
  if (acts.length) {
    const keep = JSON.stringify(acts.map((a) => String(a.id)));
    stmts.push(
      env.DB.prepare(
        `DELETE FROM activities WHERE substr(start_local,1,10) BETWEEN ? AND ?
           AND id NOT IN (SELECT value FROM json_each(?))`,
      ).bind(oldest, newest, keep),
    );
  }
  stmts.push(...extra);
  await env.DB.batch(stmts);
  return { activities: acts.length, wellness: well.length };
}

export async function syncIntervals(env: Env, budget: Budget) {
  if (!env.INTERVALS_API_KEY) return { estado: "desactivado (falta INTERVALS_API_KEY)" };
  const client = new IntervalsClient(env);
  const end = addDays(today(env.TZ), 1);
  if (!budget.take()) return { estado: "sin presupuesto de peticiones en esta ejecución" };
  const st = await getStates(env, ["intervals_backfill_done", "intervals_cursor"]);

  if (st.intervals_backfill_done !== "1") {
    let cursor = st.intervals_cursor || env.HISTORY_START || "2018-01-01";
    let acts = 0, well = 0, chunks = 0;
    while (cursor <= end && chunks < MAX_CHUNKS_PER_RUN && budget.take(3)) {
      const candidate = addDays(cursor, CHUNK_DAYS - 1);
      const chunkEnd = candidate < end ? candidate : end;
      const next = addDays(chunkEnd, 1);
      const extra = [setStateStmt(env, "intervals_cursor", next)];
      if (next > end) extra.push(setStateStmt(env, "intervals_backfill_done", "1"));
      const r = await syncIntervalsChunk(env, client, cursor, chunkEnd, extra);
      acts += r.activities; well += r.wellness; chunks++;
      cursor = next;
    }
    const done = cursor > end;
    return {
      modo: done ? "histórico completado" : `importando histórico (va por ${cursor})`,
      tramos: chunks, actividades: acts, dias_wellness: well,
    };
  }

  if (!budget.take(3)) return { estado: "sin presupuesto de peticiones en esta ejecución" };
  const r = await syncIntervalsChunk(env, client, addDays(today(env.TZ), -REFRESH_DAYS), end);
  return { modo: "incremental", actividades: r.activities, dias_wellness: r.wellness };
}

/** Refresco rápido de los últimos días (3 subpeticiones), para revisar una actividad recién hecha. */
export async function syncRecent(env: Env, days = 2) {
  if (!env.INTERVALS_API_KEY) return null;
  const client = new IntervalsClient(env);
  return syncIntervalsChunk(env, client, addDays(today(env.TZ), -days), addDays(today(env.TZ), 1));
}

// --- Hevy -------------------------------------------------------------------
function workoutStmts(env: Env, w: any): D1PreparedStatement[] {
  const start: string | null = w.start_time ?? null;
  const end: string | null = w.end_time ?? null;
  const duration = start && end ? Math.round((Date.parse(end) - Date.parse(start)) / 1000) : null;
  const stmts = [
    env.DB.prepare(
      `INSERT INTO gym_workouts (id, title, start_time, end_time, duration_s, raw, updated_at, date)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, start_time=excluded.start_time,
         end_time=excluded.end_time, duration_s=excluded.duration_s, raw=excluded.raw, updated_at=excluded.updated_at,
         date=excluded.date`,
    ).bind(w.id, n(w.title), start, end, Number.isFinite(duration) ? duration : null, JSON.stringify(w),
      w.updated_at ?? nowIso(), localDate(start, env.TZ)),
    env.DB.prepare("DELETE FROM gym_sets WHERE workout_id=?").bind(w.id),
  ];
  for (const ex of w.exercises ?? []) {
    for (const s of ex.sets ?? []) {
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO gym_sets (workout_id, exercise_index, set_index, exercise, template_id, set_type,
             weight_kg, reps, distance_m, duration_s, rpe, start_time)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).bind(
          w.id, ex.index ?? 0, s.index ?? 0, n(ex.title), n(ex.exercise_template_id), n(s.type ?? s.set_type),
          n(s.weight_kg), n(s.reps), n(s.distance_meters), n(s.duration_seconds), n(s.rpe), start,
        ),
      );
    }
  }
  return stmts;
}

function deleteWorkoutStmts(env: Env, id: string): D1PreparedStatement[] {
  return [
    env.DB.prepare("DELETE FROM gym_sets WHERE workout_id=?").bind(id),
    env.DB.prepare("DELETE FROM gym_workouts WHERE id=?").bind(id),
  ];
}

/** Una página de Hevy solo vale con su lista y su page_count: un 404 o una respuesta rara no dicen que el tramo esté leído. */
const paginaValida = (data: any, clave: string) => Array.isArray(data?.[clave]) && Number.isInteger(data.page_count);

export async function syncHevy(env: Env, budget: Budget) {
  if (!conHevy(env)) return { estado: "desactivado (falta HEVY_API_KEY)" };
  const client = new HevyClient(env);
  if (!budget.take()) return { estado: "sin presupuesto de peticiones en esta ejecución" };
  const st = await getStates(env, ["hevy_since", "hevy_page", "hevy_backfill_started"]);

  // Importación inicial: todas las páginas de /workouts, repartidas entre ejecuciones.
  // Cada página = 1 llamada a Hevy + 1 batch en D1 (2 subpeticiones).
  if (!st.hevy_since) {
    let page = Number(st.hevy_page || "1");
    const startedAt = st.hevy_backfill_started || new Date(Date.now() - 5 * 60_000).toISOString();
    let count = 0, pageCount = page, pages = 0;
    while (pages < MAX_HEVY_PAGES_PER_RUN && budget.take(2)) {
      const data = await client.workoutsPage(page);
      // Sin escribir nada: la siguiente ejecución repite esta página. El error se ve en fallos_hevy.
      if (!paginaValida(data, "workouts")) throw new Error(`Hevy no ha dado una página válida de entrenos (página ${page}): no se avanza`);
      const ws = data!.workouts!;
      pageCount = data!.page_count!;
      const finished = page >= pageCount || ws.length === 0;
      const stmts = ws.flatMap((w) => workoutStmts(env, w));
      stmts.push(
        setStateStmt(env, "hevy_page", String(page + 1)),
        setStateStmt(env, "hevy_backfill_started", startedAt),
      );
      if (finished) stmts.push(setStateStmt(env, "hevy_since", startedAt)); // a partir de aquí, solo cambios
      await env.DB.batch(stmts);
      count += ws.length; pages++;
      if (finished) return { modo: "histórico completado", entrenos: count };
      page++;
    }
    return { modo: `importando histórico (página ${page} de ${pageCount})`, entrenos: count };
  }

  // Incremental: solo cambios (creados/editados/borrados) desde la última vez
  const runStarted = new Date(Date.now() - 5 * 60_000).toISOString();
  let page = 1, upd = 0, del = 0, complete = false;
  while (budget.take(2)) {
    const data = await client.eventsPage(st.hevy_since, page);
    // 'since' se queda como está: la siguiente ejecución repite el tramo. El error se ve en fallos_hevy.
    if (!paginaValida(data, "events")) throw new Error(`Hevy no ha dado una página válida de cambios (página ${page}): no se avanza`);
    const stmts: D1PreparedStatement[] = [];
    for (const ev of data!.events!) {
      if (ev.type === "deleted" && ev.id) { stmts.push(...deleteWorkoutStmts(env, ev.id)); del++; }
      else if (ev.workout) { stmts.push(...workoutStmts(env, ev.workout)); upd++; }
    }
    complete = page >= data!.page_count!;
    // Si no dio tiempo a leer todas las páginas, no avanzamos 'since' (se repetirá; es idempotente)
    if (complete) stmts.push(setStateStmt(env, "hevy_since", runStarted));
    if (stmts.length) await env.DB.batch(stmts);
    if (complete) break;
    page++;
  }
  return { modo: "incremental", actualizados: upd, borrados: del, completo: complete };
}

// --- rutinas de Hevy --------------------------------------------------------
/** Lee las páginas de una lista. null si alguna respuesta no es válida: en ese caso no se toca nada de lo guardado. */
async function leerLista(budget: Budget, leer: (page: number) => Promise<any>, clave: string, valido: (x: any) => boolean, maxPaginas: number) {
  const items: any[] = [];
  for (let page = 1; page <= maxPaginas && budget.take(); page++) {
    const data = await leer(page);
    const lista = data?.[clave];
    if (!Array.isArray(lista) || !lista.every(valido)) return null;
    items.push(...lista);
    // Sin page_count no se puede saber si la lista está completa
    if (!Number.isInteger(data.page_count)) return { items, completa: false };
    if (page >= data.page_count) return { items, completa: true };
  }
  return { items, completa: false };
}

/**
 * Guarda las rutinas y sus carpetas (1 batch). Hevy no da eventos de rutinas, así que una borrada solo se detecta porque
 * falta en la lista: se marca solo con una lista válida, completa y no vacía, como las actividades de intervals.icu.
 */
export async function syncRutinas(env: Env, budget: Budget) {
  if (!conHevy(env)) return { estado: "desactivado (falta HEVY_API_KEY)" };
  if (!budget.take()) return { estado: "sin presupuesto de peticiones en esta ejecución" }; // el batch final
  const client = new HevyClient(env);
  const rutinas = await leerLista(budget, (p) => client.routinesPage(p), "routines", rutinaValida, MAX_PAGINAS_RUTINAS);
  if (!rutinas) return { estado: "Hevy no ha dado una lista válida de rutinas: no se ha tocado nada" };

  const ahora = nowIso();
  const stmts = rutinas.items.map((r) => rutinaStmt(env, r, ahora));
  const marcar = rutinas.completa && rutinas.items.length > 0;
  if (marcar) {
    stmts.push(env.DB.prepare("UPDATE rutinas SET borrada_en=? WHERE borrada_en IS NULL AND id NOT IN (SELECT value FROM json_each(?))")
      .bind(ahora, JSON.stringify(rutinas.items.map((r) => r.id))));
  }

  // Si fallan las carpetas, las rutinas se guardan igual: solo se quedan sin el nombre de la carpeta
  let carpetas: number | string;
  try {
    const f = await leerLista(budget, (p) => client.routineFoldersPage(p), "routine_folders", (x) => Number.isFinite(x?.id), MAX_PAGINAS_CARPETAS);
    if (!f) carpetas = "lista no válida";
    else {
      carpetas = f.items.length;
      for (const c of f.items) {
        stmts.push(env.DB.prepare(`INSERT INTO rutina_carpetas (id, title, orden) VALUES (?,?,?)
          ON CONFLICT(id) DO UPDATE SET title=excluded.title, orden=excluded.orden`).bind(c.id, n(c.title), n(c.index)));
      }
      if (f.completa && f.items.length) {
        stmts.push(env.DB.prepare("DELETE FROM rutina_carpetas WHERE id NOT IN (SELECT value FROM json_each(?))")
          .bind(JSON.stringify(f.items.map((c) => c.id))));
      }
    }
  } catch (e: any) {
    carpetas = `error: ${String(e?.message ?? e).slice(0, 120)}`;
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { rutinas: rutinas.items.length, completa: rutinas.completa, borradas_comprobadas: marcar, carpetas };
}

// --- extras: plantillas de Hevy y splits ------------------------------------
/** Grupos musculares de las plantillas de Hevy que aún no conocemos (pocas por ejecución). */
async function syncTemplates(env: Env, budget: Budget) {
  if (!conHevy(env) || !budget.take()) return null;
  const missing = await rows(env, `SELECT DISTINCT template_id AS id FROM gym_sets
    WHERE template_id IS NOT NULL AND template_id NOT IN (SELECT id FROM exercise_templates)
    ORDER BY RANDOM() LIMIT ?`, MAX_TEMPLATES_PER_RUN); // al azar: una que falle siempre no ocupa el sitio de las demás
  if (!missing.length) return null;
  const client = new HevyClient(env);
  const stmts: D1PreparedStatement[] = [];
  let fallos = 0;
  for (const { id } of missing) {
    if (!budget.take()) break;
    let t: any;
    try { t = await client.exerciseTemplate(id); } catch { fallos++; break; } // probablemente Hevy caído: se pedirá más tarde
    t = t?.exercise_template ?? t;
    if (t !== null && !t?.title) { fallos++; break; } // respuesta rara: tampoco confirma nada
    // Solo un 404 (null) confirma que no existe: se guarda vacía para no pedirla en cada ejecución
    stmts.push(env.DB.prepare(
      `INSERT OR REPLACE INTO exercise_templates (id, title, primary_muscle, secondary_muscles, equipment) VALUES (?,?,?,?,?)`,
    ).bind(id, n(t?.title), n(t?.primary_muscle_group), t?.secondary_muscle_groups ? JSON.stringify(t.secondary_muscle_groups) : null,
      n(t?.equipment ?? t?.type)));
  }
  if (stmts.length && budget.take()) await env.DB.batch(stmts);
  return { nuevas: stmts.length, fallos };
}

/** Calcula los splits y la FC en marcha de la carrera más reciente que no los tenga (una por ejecución). */
async function splitsPendientes(env: Env, budget: Budget) {
  if (!env.INTERVALS_API_KEY || !budget.take()) return null;
  const [a] = await rows(env, `SELECT id, sport, distance_m, splits_estado, json_extract(raw,'$.icu_hr_zones') AS zonas_fc FROM activities
    WHERE ${SPLITS_POR_CALCULAR_SQL} AND sport IN ('Run','TrailRun','VirtualRun','Walk','Hike') AND distance_m >= 1000
    ORDER BY start_local DESC LIMIT 1`, nowIso());
  if (!a || !budget.take(3)) return null;
  return { actividad: a.id, estado: await calcularSplits(env, new IntervalsClient(env), a) };
}

// --- todo -------------------------------------------------------------------
export async function runSync(env: Env) {
  const result: Record<string, unknown> = { inicio: nowIso() };
  // Presupuesto total de subpeticiones (fetch + D1). Se reserva una parte para Hevy
  // aunque intervals.icu esté importando histórico, y 1 para guardar el resultado.
  const intervalsBudget = new Budget(INTERVALS_BUDGET);
  try {
    result.intervals = await syncIntervals(env, intervalsBudget);
  } catch (e: any) {
    result.intervals = { error: String(e?.message ?? e) };
  }
  const hevyBudget = new Budget(TOTAL_BUDGET - 1 - EXTRAS_BUDGET - RUTINAS_BUDGET - (INTERVALS_BUDGET - intervalsBudget.left));
  try {
    result.hevy = await syncHevy(env, hevyBudget);
  } catch (e: any) {
    result.hevy = { error: String(e?.message ?? e) };
  }
  try {
    result.rutinas = await syncRutinas(env, new Budget(RUTINAS_BUDGET));
  } catch (e: any) {
    result.rutinas = { error: String(e?.message ?? e) };
  }
  const extras = new Budget(EXTRAS_BUDGET);
  try {
    const t = await syncTemplates(env, extras);
    if (t) result.plantillas = t;
  } catch (e: any) {
    result.plantillas = { error: String(e?.message ?? e) };
  }
  // Con intervals caído en esta ejecución no se piden streams: fallarían y gastarían los intentos de la actividad
  if (!(result.intervals as any)?.error) {
    try {
      const s = await splitsPendientes(env, extras);
      if (s) result.splits = s;
    } catch (e: any) {
      result.splits = { error: String(e?.message ?? e) };
    }
  }
  result.fin = nowIso();
  // Fallos consecutivos por fuente (se ven en estado_atleta); un acierto los pone a 0
  const prev = await getStates(env, ["fallos_intervals", "fallos_hevy"]);
  const fallos = (k: "intervals" | "hevy") =>
    String((result[k] as any)?.error ? Number(prev[`fallos_${k}`] ?? 0) + 1 : 0);
  await env.DB.batch([
    setStateStmt(env, "last_sync", nowIso()),
    setStateStmt(env, "last_sync_result", JSON.stringify(result)),
    setStateStmt(env, "fallos_intervals", fallos("intervals")),
    setStateStmt(env, "fallos_hevy", fallos("hevy")),
  ]);
  console.log("Sincronización", JSON.stringify(result));
  return result;
}
