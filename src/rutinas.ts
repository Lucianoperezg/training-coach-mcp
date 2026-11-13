/**
 * Rutinas de Hevy: crear, modificar y restaurar en dos pasos, como programar_entrenos.
 * 1) programar_rutinas(crear, modificar, restaurar) guarda el plan y devuelve una vista previa con plan_id. No escribe en Hevy.
 * 2) programar_rutinas(plan_id, confirmar=true) aplica exactamente lo que se mostró.
 *
 * La documentación de Hevy no dice si PUT reemplaza la rutina entera; sus ejercicios no llevan id, así que se trata como si
 * la reemplazara: siempre se manda la rutina completa, partiendo de lo que hay ahora. Los entrenos hechos no se tocan: aquí
 * solo se escribe en /routines. La API no tiene DELETE de rutinas.
 */
import { Budget, HevyClient } from "./clients";
import type { Env } from "./env";
import { conHevy, nowIso } from "./env";
import { type Row, rows, tabla } from "./format";

const MAX_OPS = 5;
const MAX_EJERCICIOS = 40;
const MAX_SERIES = 30;
const MAX_TITULO = 120;
const MAX_NOTAS = 2000;
const CADUCA_H = 24;
const APLICANDO_MAX_MS = 120_000; // pasado este tiempo, un intento que se quedó a medias ya no bloquea
const PRESUPUESTO_VISTA_PREVIA = 40; // el plan gratuito permite 50 subpeticiones por ejecución

export const TIPOS_SERIE = ["warmup", "normal", "failure", "dropset"] as const;

export interface Serie {
  type?: string; weight_kg?: number | null; reps?: number | null; distance_meters?: number | null;
  duration_seconds?: number | null; custom_metric?: number | null; rep_range?: { start?: number | null; end?: number | null } | null;
}
export interface EjercicioNuevo {
  exercise_template_id: string; rest_seconds?: number | null; notes?: string | null; superset_id?: number | null; series: Serie[];
}
export interface RutinaNueva { title: string; folder_id?: number | null; notes?: string; ejercicios: EjercicioNuevo[] }
export interface CambioEjercicio {
  indice: number; exercise_template_id?: string; rest_seconds?: number | null; notes?: string | null; superset_id?: number | null;
  series?: Serie[]; series_cambios?: (Serie & { indice?: number })[];
}
export interface CambioRutina {
  routine_id: string; title?: string; notes?: string | null; ejercicios?: CambioEjercicio[]; quitar_ejercicios?: number[];
  anadir_ejercicios?: (EjercicioNuevo & { posicion?: number })[]; orden?: number[];
}

/** Lo que se manda a Hevy: solo los campos de PutRoutinesRequestBody (la respuesta trae más, como index o title). */
interface Cuerpo { title: string; folder_id: number | null; notes?: string | null; exercises: Row[] }
interface Op { tipo: "crear" | "modificar" | "restaurar"; routine_id?: string; copia_id?: number; antes?: Row; despues: Cuerpo }

// --- de la respuesta de Hevy a lo que se envía --------------------------------
const ordenar = (lista: Row[] | undefined): Row[] =>
  (lista ?? []).map((x, i) => ({ x, k: x.index ?? i })).sort((a, b) => a.k - b.k).map((o) => o.x);

const serieDesde = (s: Row): Row => ({
  type: s.type, weight_kg: s.weight_kg ?? null, reps: s.reps ?? null, distance_meters: s.distance_meters ?? null,
  duration_seconds: s.duration_seconds ?? null, custom_metric: s.custom_metric ?? null, rep_range: s.rep_range ?? null,
});
const ejercicioDesde = (e: Row): Row => ({
  exercise_template_id: e.exercise_template_id, superset_id: e.superset_id ?? null, rest_seconds: e.rest_seconds ?? null,
  notes: e.notes ?? null, sets: ordenar(e.sets).map(serieDesde),
});

/**
 * La rutina completa tal como hay que reenviarla, en su orden. Las notas generales solo se incluyen si Hevy las ha devuelto:
 * según su documentación la lectura no las trae, y mandar null podría borrarlas.
 */
export function cuerpoDesde(r: Row): Cuerpo {
  const c: Cuerpo = { title: r.title, folder_id: r.folder_id ?? null, exercises: ordenar(r.exercises).map(ejercicioDesde) };
  if ("notes" in r) c.notes = r.notes;
  return c;
}

const CONOCIDOS = {
  rutina: new Set(["id", "title", "folder_id", "notes", "updated_at", "created_at", "exercises"]),
  ejercicio: new Set(["index", "title", "exercise_template_id", "superset_id", "rest_seconds", "notes", "sets"]),
  serie: new Set(["index", "type", "weight_kg", "reps", "distance_meters", "duration_seconds", "custom_metric", "rep_range"]),
};

/** Campos con valor que Hevy devuelve y su API no deja enviar: se verían afectados por un reemplazo completo. */
export function camposNoEnviables(r: Row): string[] {
  const fuera = new Set<string>();
  const mirar = (o: Row, conocidos: Set<string>, prefijo: string) => {
    for (const [k, v] of Object.entries(o)) if (v != null && !conocidos.has(k)) fuera.add(prefijo + k);
  };
  mirar(r, CONOCIDOS.rutina, "");
  for (const e of r.exercises ?? []) {
    mirar(e, CONOCIDOS.ejercicio, "ejercicio.");
    for (const s of e.sets ?? []) mirar(s, CONOCIDOS.serie, "serie.");
  }
  return [...fuera];
}

/** Forma de comparar: sin nulos ni textos vacíos, con las claves ordenadas. */
function limpio(v: any): any {
  if (Array.isArray(v)) return v.map(limpio);
  if (v && typeof v === "object") {
    const o: Row = {};
    for (const k of Object.keys(v).sort()) {
      const x = limpio(v[k]);
      if (x != null && x !== "" && !(typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length)) o[k] = x;
    }
    return o;
  }
  return v;
}

/** Huella de la rutina completa (campos y updated_at): cualquier cambio en Hevy la altera. */
const huella = (r: Row) => JSON.stringify(limpio(r));

/** Dónde difieren dos cuerpos. Las notas generales no se comparan si Hevy no las devuelve. */
export function diferencias(esperado: Cuerpo, obtenido: Cuerpo): string[] {
  const a = limpio(esperado), b = limpio(obtenido), fuera: string[] = [];
  if (!("notes" in obtenido)) delete a.notes;
  const ver = (x: any, y: any, ruta: string) => {
    if (x && y && typeof x === "object" && typeof y === "object") {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) ver(x[k], y[k], ruta ? `${ruta}.${k}` : k);
    } else if (x !== y) fuera.push(ruta);
  };
  ver(a, b, "");
  return fuera;
}

export const rutinaValida = (r: any): boolean =>
  !!r && typeof r === "object" && typeof r.id === "string" && !!r.id && typeof r.title === "string" && Array.isArray(r.exercises);

/** La rutina de una respuesta de Hevy, o null. Se aceptan {routine: {...}} y {routine: [{...}]}. */
function rutinaDe(respuesta: any): Row | null {
  const r = Array.isArray(respuesta?.routine) ? respuesta.routine[0] : respuesta?.routine;
  return rutinaValida(r) ? r : null;
}

export function rutinaStmt(env: Env, r: Row, ahora = nowIso()): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO rutinas (id, title, folder_id, updated_at, raw, synced_at, borrada_en) VALUES (?,?,?,?,?,?,NULL)
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, folder_id=excluded.folder_id, updated_at=excluded.updated_at,
       raw=excluded.raw, synced_at=excluded.synced_at, borrada_en=NULL
     WHERE rutinas.raw IS NOT excluded.raw OR rutinas.borrada_en IS NOT NULL`,
  ).bind(r.id, r.title, r.folder_id ?? null, r.updated_at ?? null, JSON.stringify(r), ahora);
}

// --- validación ---------------------------------------------------------------
const noNeg = (v: unknown) => v == null || (typeof v === "number" && Number.isFinite(v) && v >= 0);
const enteroNoNeg = (v: unknown) => v == null || (Number.isInteger(v) && (v as number) >= 0);

function errorSerie(s: Row): string | null {
  if (!TIPOS_SERIE.includes(s.type)) return `tipo de serie no válido (${TIPOS_SERIE.join(", ")})`;
  if (!noNeg(s.weight_kg)) return "weight_kg no válido";
  if (!enteroNoNeg(s.reps)) return "reps no válidas";
  if (!enteroNoNeg(s.distance_meters)) return "distance_meters no válido";
  if (!enteroNoNeg(s.duration_seconds)) return "duration_seconds no válido";
  if (!noNeg(s.custom_metric)) return "custom_metric no válido";
  const rr = s.rep_range;
  if (rr != null) {
    if (!noNeg(rr.start) || !noNeg(rr.end)) return "rep_range no válido";
    if (rr.start != null && rr.end != null && rr.start > rr.end) return "rep_range: start mayor que end";
  }
  return null;
}

function errorCuerpo(c: Cuerpo): string | null {
  if (typeof c.title !== "string" || !c.title.trim() || c.title.length > MAX_TITULO) return `el título debe tener de 1 a ${MAX_TITULO} caracteres`;
  if (c.notes != null && (typeof c.notes !== "string" || c.notes.length > MAX_NOTAS)) return `las notas pueden tener ${MAX_NOTAS} caracteres como mucho`;
  if (!c.exercises.length) return "una rutina necesita al menos un ejercicio";
  if (c.exercises.length > MAX_EJERCICIOS) return `máximo ${MAX_EJERCICIOS} ejercicios`;
  for (const [i, e] of c.exercises.entries()) {
    const n = `ejercicio en posición ${i}`;
    if (typeof e.exercise_template_id !== "string" || !e.exercise_template_id) return `${n}: falta exercise_template_id`;
    if (!enteroNoNeg(e.rest_seconds)) return `${n}: rest_seconds no válido`;
    if (!enteroNoNeg(e.superset_id)) return `${n}: superset_id no válido`;
    if (e.notes != null && (typeof e.notes !== "string" || e.notes.length > MAX_NOTAS)) return `${n}: notas de ${MAX_NOTAS} caracteres como mucho`;
    if (e.sets.length > MAX_SERIES) return `${n}: máximo ${MAX_SERIES} series`;
    for (const [j, s] of e.sets.entries()) {
      const error = errorSerie(s);
      if (error) return `${n}, serie ${j}: ${error}`;
    }
  }
  return null;
}

const serieNueva = (s: Serie): Row => ({ ...serieDesde(s), type: s.type ?? "normal" });
const ejercicioNuevo = (e: EjercicioNuevo): Row => ({
  exercise_template_id: e.exercise_template_id, superset_id: e.superset_id ?? null, rest_seconds: e.rest_seconds ?? null,
  notes: e.notes ?? null, sets: (e.series ?? []).map(serieNueva),
});

/** Aplica el cambio sobre la rutina actual. Lo que no se nombra queda exactamente igual. */
export function aplicarCambio(actual: Row, c: CambioRutina): Cuerpo | { error: string } {
  const originales = ordenar(actual.exercises);
  const cuerpo = cuerpoDesde(actual);
  const posicion = (lista: Row[], indice: number) => lista.findIndex((x, i) => (x.index ?? i) === indice);
  if (c.title !== undefined) cuerpo.title = c.title;
  if (c.notes !== undefined) cuerpo.notes = c.notes;

  const vistos = new Set<number>();
  for (const ce of c.ejercicios ?? []) {
    const p = posicion(originales, ce.indice);
    if (p < 0) return { error: `no existe el ejercicio con indice ${ce.indice}` };
    if (vistos.has(p)) return { error: `el ejercicio con indice ${ce.indice} aparece dos veces` };
    vistos.add(p);
    const e = cuerpo.exercises[p];
    if (ce.exercise_template_id !== undefined) e.exercise_template_id = ce.exercise_template_id;
    if (ce.rest_seconds !== undefined) e.rest_seconds = ce.rest_seconds;
    if (ce.notes !== undefined) e.notes = ce.notes;
    if (ce.superset_id !== undefined) e.superset_id = ce.superset_id;
    if (ce.series && ce.series_cambios) return { error: `ejercicio ${ce.indice}: usa series o series_cambios, no los dos` };
    if (ce.series) {
      if (!ce.series.length) return { error: `ejercicio ${ce.indice}: series no puede estar vacío` };
      e.sets = ce.series.map(serieNueva);
    }
    for (const sc of ce.series_cambios ?? []) {
      const { indice, ...campos } = sc;
      const sets = ordenar(originales[p].sets);
      // Sin indice, el cambio va a todas las series del ejercicio
      const destinos = indice === undefined ? e.sets.map((_: Row, i: number) => i) : [posicion(sets, indice)];
      if (destinos[0] === -1) return { error: `ejercicio ${ce.indice}: no existe la serie con indice ${indice}` };
      for (const d of destinos) e.sets[d] = { ...e.sets[d], ...campos };
    }
  }

  const quitar = new Set<number>();
  for (const i of c.quitar_ejercicios ?? []) {
    const p = posicion(originales, i);
    if (p < 0) return { error: `no existe el ejercicio con indice ${i}` };
    quitar.add(p);
  }
  let posiciones = originales.map((_, i) => i).filter((p) => !quitar.has(p));
  if (c.orden) {
    const pedidas = c.orden.map((i) => posicion(originales, i));
    const faltan = new Set(posiciones);
    for (const p of pedidas) faltan.delete(p);
    if (pedidas.length !== posiciones.length || new Set(pedidas).size !== pedidas.length || faltan.size || pedidas.includes(-1)) {
      return { error: "orden debe nombrar una vez cada ejercicio que se queda, por su indice actual" };
    }
    posiciones = pedidas;
  }
  const lista = posiciones.map((p) => cuerpo.exercises[p]);
  for (const n of c.anadir_ejercicios ?? []) {
    if (!n.series?.length) return { error: `ejercicio nuevo ${n.exercise_template_id}: necesita al menos una serie` };
    const e = ejercicioNuevo(n);
    if (n.posicion === undefined) lista.push(e);
    else lista.splice(Math.max(0, n.posicion), 0, e);
  }
  cuerpo.exercises = lista;
  return cuerpo;
}

// --- comprobaciones contra Hevy -------------------------------------------------
/**
 * Comprueba que existan las plantillas. Una fila sin título en exercise_templates no vale: la sincronización las guarda
 * vacías cuando Hevy no devuelve la plantilla. Si no se puede comprobar, es un error: no se escribe a ciegas.
 */
async function comprobarPlantillas(env: Env, client: HevyClient, ids: string[], budget: Budget): Promise<{ error: string } | { titulos: Map<string, string> }> {
  const titulos = new Map<string, string>();
  if (!ids.length) return { titulos };
  if (!budget.take()) return { error: "Plan demasiado grande para una sola llamada: repártelo en varios." };
  for (const f of await rows(env, `SELECT id, title FROM exercise_templates WHERE title IS NOT NULL
    AND id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids))) titulos.set(String(f.id), String(f.title));
  const nuevas: Row[] = [];
  for (const id of ids) {
    if (titulos.has(id)) continue;
    if (!budget.take()) return { error: "Demasiados ejercicios sin comprobar para una sola llamada: repártelo en varios planes." };
    let t: any;
    try { t = await client.exerciseTemplate(id); } catch (err: any) {
      return { error: `No se ha podido comprobar el ejercicio ${id} en Hevy, no se ha guardado ningún plan: ${String(err?.message ?? err).slice(0, 160)}` };
    }
    t = t?.exercise_template ?? t;
    if (!t?.title) return { error: `El ejercicio ${id} no existe en Hevy: no se ha guardado ningún plan.` };
    titulos.set(id, String(t.title));
    nuevas.push({ id, ...t });
  }
  if (nuevas.length && budget.take()) {
    await env.DB.batch(nuevas.map((t) => env.DB.prepare(
      "INSERT OR REPLACE INTO exercise_templates (id, title, primary_muscle, secondary_muscles, equipment) VALUES (?,?,?,?,?)",
    ).bind(t.id, t.title, t.primary_muscle_group ?? null, t.secondary_muscle_groups ? JSON.stringify(t.secondary_muscle_groups) : null,
      t.equipment ?? t.type ?? null))).catch(() => { /* es solo una caché */ });
  }
  return { titulos };
}

// --- presentación -------------------------------------------------------------
const TIPO_TEXTO: Row = { warmup: "calent.", failure: "al fallo", dropset: "dropset" };

function rangoTexto(r: Row | null | undefined): string | null {
  if (r?.start != null && r?.end != null) return `${r.start}-${r.end}`;
  if (r?.start != null) return `desde ${r.start}`;
  return r?.end != null ? `hasta ${r.end}` : null;
}

/** Repeticiones y rango son campos distintos y se envían los dos: si hay los dos, se ven los dos. */
function repsTexto(s: Row): string | null {
  const rango = rangoTexto(s.rep_range);
  if (s.reps != null) return rango ? `${s.reps} reps (rango ${rango})` : `${s.reps} reps`;
  return rango ? `${rango} reps` : null;
}

function serieTexto(s: Row): string {
  const partes = [
    s.weight_kg != null ? `${s.weight_kg} kg` : null, repsTexto(s),
    s.duration_seconds != null ? `${s.duration_seconds} s` : null, s.distance_meters != null ? `${s.distance_meters} m` : null,
    s.custom_metric != null ? `métrica ${s.custom_metric}` : null,
  ].filter(Boolean).join(" × ") || "sin objetivo";
  const tipo = TIPO_TEXTO[s.type] ?? (s.type && s.type !== "normal" ? s.type : null); // una copia antigua puede traer otro tipo
  return tipo ? `${tipo} ${partes}` : partes;
}

function lineas(c: Cuerpo, titulos: Map<string, string>): string[] {
  return c.exercises.map((e) => [
    `${titulos.get(e.exercise_template_id) ?? e.exercise_template_id} [${e.exercise_template_id}]`,
    e.sets.map(serieTexto).join(" · ") || "sin series",
    e.rest_seconds != null ? `descanso ${e.rest_seconds} s` : null,
    e.superset_id != null ? `superserie ${e.superset_id}` : null,
    e.notes ? `notas: ${e.notes}` : null,
  ].filter(Boolean).join(" | "));
}

function vistaRutina(c: Cuerpo, titulos: Map<string, string>) {
  return { titulo: c.title, carpeta_id: c.folder_id, ...("notes" in c ? { notas: c.notes } : {}), ejercicios: lineas(c, titulos).map((l, i) => `#${i} ${l}`) };
}

const notasTexto = (n: unknown) => (n ? `"${n}"` : "(vacías)");

/** Qué pasa con las notas generales, o null si nada. Sin la clave notes no se envían: Hevy decide si las conserva. */
function diferenciaNotas(antes: Cuerpo, despues: Cuerpo): string | null {
  if (!("notes" in despues)) {
    return antes.notes ? `notas generales: ${notasTexto(antes.notes)} → no se envían, Hevy podría conservarlas o borrarlas` : null;
  }
  if (!("notes" in antes)) return `notas generales: no se sabe cuáles hay, Hevy no las devuelve → ${notasTexto(despues.notes)}`;
  return (antes.notes ?? "") !== (despues.notes ?? "") ? `notas generales: ${notasTexto(antes.notes)} → ${notasTexto(despues.notes)}` : null;
}

/** Empareja las líneas iguales de antes y después, contando repetidas: [posición antes, posición después]. */
function emparejar(a: string[], d: string[]): [number, number][] {
  const libres = d.map((_, j) => j), pares: [number, number][] = [];
  a.forEach((l, i) => {
    const k = libres.findIndex((j) => d[j] === l);
    if (k >= 0) pares.push([i, libres.splice(k, 1)[0]]);
  });
  return pares;
}

function resumenDiferencias(antes: Cuerpo, despues: Cuerpo, titulos: Map<string, string>): string[] {
  const a = lineas(antes, titulos), d = lineas(despues, titulos), fuera: string[] = [];
  if (antes.title !== despues.title) fuera.push(`título: "${antes.title}" → "${despues.title}"`);
  const notas = diferenciaNotas(antes, despues);
  if (notas) fuera.push(notas);
  if (antes.folder_id !== despues.folder_id) fuera.push(`carpeta: ${antes.folder_id} → ${despues.folder_id}`);
  const pares = emparejar(a, d);
  const enA = new Set(pares.map(([i]) => i)), enD = new Set(pares.map(([, j]) => j));
  a.forEach((l, i) => { if (!enA.has(i)) fuera.push(`− #${i} ${l}`); });
  d.forEach((l, j) => { if (!enD.has(j)) fuera.push(`+ #${j} ${l}`); });
  if (pares.some(([, j], n) => n > 0 && j < pares[n - 1][1])) {
    const nombres = (c: Cuerpo) => c.exercises.map((e) => titulos.get(e.exercise_template_id) ?? e.exercise_template_id).join(", ");
    fuera.push(`cambia el orden de los ejercicios: ${nombres(antes)} → ${nombres(despues)}`);
  }
  // Red de seguridad: dos ejercicios con el mismo texto pero distinto contenido no pasan sin verse
  const rutas = pares.flatMap(([i, j]) =>
    diferencias(despues.exercises[j] as Cuerpo, antes.exercises[i] as Cuerpo).map((r) => `exercises.${j}.${r}`));
  if (rutas.length) fuera.push(`otros cambios sin descripción, míralos antes de aprobar: ${rutas.join(", ")}`);
  return fuera;
}

function avisosDe(actual: Row): string[] {
  const avisos: string[] = [];
  if (!("notes" in actual)) avisos.push("Hevy no ha devuelto las notas generales de esta rutina: no se pueden ver, copiar ni comprobar que se conserven.");
  const fuera = camposNoEnviables(actual);
  if (fuera.length) avisos.push(`Hevy devuelve campos que su API no deja enviar y podrían perderse: ${fuera.join(", ")}.`);
  return avisos;
}

// --- paso 1: vista previa --------------------------------------------------------
const errorLectura = (id: string, err: any) =>
  `No se ha podido leer la rutina ${id} en Hevy, no se ha guardado ningún plan: ${String(err?.message ?? err).slice(0, 160)}`;

async function vistaPrevia(env: Env, client: HevyClient, args: { crear?: RutinaNueva[]; modificar?: CambioRutina[]; restaurar?: number[] }) {
  const crear = args.crear ?? [], modificar = args.modificar ?? [], restaurar = args.restaurar ?? [];
  const total = crear.length + modificar.length + restaurar.length;
  if (!total) return { error: "No hay nada que hacer: indica crear, modificar o restaurar, o plan_id con confirmar=true." };
  if (total > MAX_OPS) return { error: `Máximo ${MAX_OPS} rutinas por plan.` };

  const budget = new Budget(PRESUPUESTO_VISTA_PREVIA);
  const ops: Op[] = [], actuales = new Map<number, Row>(), nuevas = new Set<string>(), tocadas = new Set<string>();
  const carpetas = new Map<number, Row>();

  for (const c of crear) {
    const cuerpo: Cuerpo = { title: c.title, folder_id: c.folder_id ?? null, exercises: (c.ejercicios ?? []).map(ejercicioNuevo) };
    if (c.notes) cuerpo.notes = c.notes;
    const error = errorCuerpo(cuerpo);
    if (error) return { error: `Rutina nueva "${c.title}": ${error}.` };
    if (cuerpo.exercises.some((e) => !e.sets.length)) return { error: `Rutina nueva "${c.title}": cada ejercicio necesita al menos una serie.` };
    if (cuerpo.folder_id != null && !carpetas.has(cuerpo.folder_id)) {
      if (!budget.take()) return { error: "Plan demasiado grande para una sola llamada: repártelo en varios." };
      try {
        const f = await client.routineFolder(cuerpo.folder_id);
        if (!f) return { error: `No existe la carpeta ${cuerpo.folder_id} en Hevy.` };
        carpetas.set(cuerpo.folder_id, f);
      } catch (err: any) {
        return { error: `No se ha podido comprobar la carpeta ${cuerpo.folder_id} en Hevy, no se ha guardado ningún plan: ${String(err?.message ?? err).slice(0, 160)}` };
      }
    }
    for (const e of cuerpo.exercises) nuevas.add(e.exercise_template_id);
    ops.push({ tipo: "crear", despues: cuerpo });
  }

  const leer = async (id: string): Promise<Row | null> => {
    if (tocadas.has(id)) return { error: `La rutina ${id} aparece dos veces en el plan.` };
    tocadas.add(id);
    if (!budget.take()) return { error: "Plan demasiado grande para una sola llamada: repártelo en varios." };
    try {
      const respuesta = await client.routine(id);
      if (respuesta === null) return null;
      return rutinaDe(respuesta) ?? { error: `Hevy ha dado una respuesta no válida para la rutina ${id}: no se ha guardado ningún plan.` };
    } catch (err: any) {
      return { error: errorLectura(id, err) };
    }
  };

  for (const c of modificar) {
    const actual = await leer(c.routine_id);
    if (actual === null) return { error: `No existe la rutina ${c.routine_id} en Hevy.` };
    if (actual.error) return { error: actual.error };
    const despues = aplicarCambio(actual, c);
    if ("error" in despues) return { error: `Rutina ${c.routine_id}: ${despues.error}.` };
    const error = errorCuerpo(despues);
    if (error) return { error: `Rutina ${c.routine_id}: ${error}.` };
    if (!diferencias(despues, { ...cuerpoDesde(actual), ...("notes" in despues ? { notes: actual.notes ?? null } : {}) }).length) {
      return { error: `Rutina ${c.routine_id}: nada que cambiar.` };
    }
    const existentes = new Set((actual.exercises as Row[]).map((e) => e.exercise_template_id));
    for (const e of despues.exercises) if (!existentes.has(e.exercise_template_id)) nuevas.add(e.exercise_template_id);
    actuales.set(ops.length, actual);
    ops.push({ tipo: "modificar", routine_id: c.routine_id, antes: actual, despues });
  }

  for (const id of restaurar) {
    if (!budget.take()) return { error: "Plan demasiado grande para una sola llamada: repártelo en varios." };
    const [copia] = await rows(env, "SELECT copia_id, routine_id, raw FROM rutina_copias WHERE copia_id = ?", id);
    if (!copia) return { error: `No existe la copia ${id}. Las copias salen en la vista v_rutinas_copias.` };
    const guardada = JSON.parse(copia.raw) as Row;
    const despues = cuerpoDesde(guardada);
    const actual = await leer(String(copia.routine_id));
    if (actual === null) {
      // Ya no está en Hevy (se borró en la app): no hay nada que pisar, se crea otra vez, con un id nuevo
      if (!despues.notes) delete despues.notes;
      for (const e of despues.exercises) nuevas.add(e.exercise_template_id);
      ops.push({ tipo: "crear", copia_id: id, despues });
      continue;
    }
    if (actual.error) return { error: actual.error };
    if (!diferencias(despues, cuerpoDesde(actual)).length) return { error: `La rutina ${copia.routine_id} ya está igual que la copia ${id}.` };
    const existentes = new Set((actual.exercises as Row[]).map((e) => e.exercise_template_id));
    for (const e of despues.exercises) if (!existentes.has(e.exercise_template_id)) nuevas.add(e.exercise_template_id);
    actuales.set(ops.length, actual);
    ops.push({ tipo: "restaurar", routine_id: String(copia.routine_id), copia_id: id, antes: actual, despues });
  }

  const plantillas = await comprobarPlantillas(env, client, [...nuevas], budget);
  if ("error" in plantillas) return { error: plantillas.error };

  const titulos = plantillas.titulos;
  for (const a of actuales.values()) for (const e of a.exercises as Row[]) if (e.title) titulos.set(e.exercise_template_id, e.title);

  // Los índices que manda Claude salen de v_rutinas, que puede ir hasta 15 minutos por detrás de lo que acaba de leerse
  const desfasadas = new Set<string>();
  if (actuales.size && budget.take(2)) {
    const guardadas = new Map((await rows(env, "SELECT id, updated_at FROM rutinas WHERE id IN (SELECT value FROM json_each(?))",
      JSON.stringify([...actuales.values()].map((a) => a.id)))).map((f) => [String(f.id), f.updated_at]));
    const refrescar: D1PreparedStatement[] = [];
    for (const a of actuales.values()) {
      if (guardadas.get(a.id) === (a.updated_at ?? null)) continue;
      desfasadas.add(a.id);
      refrescar.push(rutinaStmt(env, a));
    }
    if (refrescar.length) await env.DB.batch(refrescar).catch(() => { /* la sincronización la pondrá al día */ });
  }

  const planId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  await env.DB.prepare("INSERT INTO planes_rutinas (plan_id, creado, estado, payload) VALUES (?, ?, 'pendiente', ?)")
    .bind(planId, new Date().toISOString(), JSON.stringify(ops)).run();

  const conActual = (tipo: Op["tipo"]) => ops.filter((o) => o.tipo === tipo && o.antes).map((o) => {
    const antes = cuerpoDesde(o.antes!);
    const avisos = avisosDe(o.antes!);
    if (o.tipo === "modificar" && desfasadas.has(o.routine_id!)) {
      avisos.unshift("Esta rutina ha cambiado en Hevy desde la última sincronización: comprueba que los índices apuntan a los ejercicios que querías.");
    }
    return Object.fromEntries(Object.entries({
      routine_id: o.routine_id, copia_id: o.copia_id, antes: vistaRutina(antes, titulos), despues: vistaRutina(o.despues, titulos),
      diferencias: resumenDiferencias(antes, o.despues, titulos), avisos: avisos.length ? avisos : null,
    }).filter(([, v]) => v != null));
  });
  const nuevasOps = ops.filter((o) => o.tipo === "crear");
  const mod = conActual("modificar"), res = conActual("restaurar");
  return Object.fromEntries(Object.entries({
    plan_id: planId,
    caduca_en_h: CADUCA_H,
    crear: nuevasOps.length ? nuevasOps.map((o) => ({
      ...vistaRutina(o.despues, titulos), carpeta: o.despues.folder_id != null ? carpetas.get(o.despues.folder_id)?.title ?? null : null,
      copia_id: o.copia_id ?? null, aviso: o.copia_id ? "La rutina ya no existe en Hevy: se creará de nuevo, con un id nuevo." : null,
    })) : null,
    modificar: mod.length ? mod : null,
    restaurar: res.length ? res : null,
    instruccion: "NO está hecho todavía. Muestra este plan al atleta y espera su sí explícito; " +
      "solo entonces llama a programar_rutinas con este plan_id y confirmar=true.",
  }).filter(([, v]) => v != null));
}

// --- paso 2: aplicar --------------------------------------------------------------
const textoError = (err: any) => String(err?.message ?? err).slice(0, 200);

/** Comprueba lo que Hevy ha guardado de verdad y actualiza la copia local. */
async function verificar(env: Env, client: HevyClient, op: Op, fila: Row, respuesta: any): Promise<Row> {
  let guardada = rutinaDe(respuesta);
  if (!guardada) guardada = rutinaDe(await client.routine(op.routine_id!).catch(() => null));
  if (!guardada) return { ...fila, aviso: "Hevy ha aceptado el cambio pero no se ha podido comprobar: míralo en la app" };
  const dif = diferencias(op.despues, cuerpoDesde(guardada));
  const verificada = dif.length
    ? { ...fila, estado: "aplicado_con_diferencias", aviso: `Hevy ha guardado algo distinto de lo pedido en: ${dif.slice(0, 5).join(", ")}. Míralo en la app; se puede restaurar con la copia` }
    : fila;
  try { await rutinaStmt(env, guardada).run(); } catch { /* la sincronización la pondrá al día */ }
  return verificada;
}

const HECHOS = new Set(["creado", "modificado", "restaurado", "ya_aplicado", "aplicado_con_diferencias"]);

async function confirmar(env: Env, client: HevyClient, planId: string | undefined) {
  if (!planId) return { error: "Para confirmar hace falta el plan_id de la vista previa." };
  const [p] = await rows(env, "SELECT * FROM planes_rutinas WHERE plan_id = ?", planId);
  if (!p) return { error: `No existe el plan ${planId}.` };
  if (p.estado === "hecho") return { error: "Ese plan ya se aplicó.", resultado: JSON.parse(p.resultado ?? "null") };
  if (Date.now() - Date.parse(p.creado) > CADUCA_H * 3600_000) return { error: "El plan ha caducado: genera una vista previa nueva." };

  // Solo un intento a la vez, para que una doble llamada no aplique dos veces
  const ahora = new Date().toISOString();
  const toma = await env.DB.prepare(`UPDATE planes_rutinas SET estado = 'aplicando', aplicando_desde = ?
    WHERE plan_id = ? AND estado <> 'hecho' AND (estado <> 'aplicando' OR aplicando_desde < ?)`)
    .bind(ahora, planId, new Date(Date.now() - APLICANDO_MAX_MS).toISOString()).run();
  if (!toma.meta?.changes) return { error: "Ese plan se está aplicando ahora mismo: espera un par de minutos y mira el resultado." };

  const ops = JSON.parse(p.payload) as Op[];
  const previos = JSON.parse(p.resultado ?? "[]") as Row[];
  const resultado: Row[] = [...previos];
  const guardarProgreso = () => env.DB.prepare("UPDATE planes_rutinas SET resultado = ? WHERE plan_id = ?").bind(JSON.stringify(resultado), planId).run();

  for (const [i, op] of ops.entries()) {
    const anterior = previos[i];
    if (anterior && HECHOS.has(anterior.estado)) continue;
    const base: Row = { op: op.tipo, routine_id: op.routine_id, rutina: op.despues.title, copia_restaurada: op.copia_id, copia_id: anterior?.copia_id };

    if (op.tipo === "crear") {
      // POST no tiene clave para evitar duplicados: si un intento anterior no terminó, no se sabe si se creó
      if (anterior?.intentado) {
        resultado[i] = { ...base, estado: "error", intentado: true, error: "un intento anterior no terminó y puede que la rutina se creara: míralo en la app; si no está, genera una vista previa nueva" };
        continue;
      }
      try {
        resultado[i] = { ...base, estado: "error", intentado: true, error: "creación sin terminar" };
        await guardarProgreso();
      } catch (err: any) {
        resultado[i] = { ...base, estado: "error", error: `no se ha podido apuntar el intento: no se ha creado (${textoError(err)})` };
        continue;
      }
      try {
        const r = await client.createRoutine({ routine: op.despues });
        const creada = rutinaDe(r);
        if (!creada) {
          resultado[i] = { ...base, estado: "error", intentado: true, error: "Hevy ha respondido sin la rutina: míralo en la app antes de repetir" };
        } else {
          resultado[i] = { ...base, routine_id: creada.id, estado: "creado" };
          try { await rutinaStmt(env, creada).run(); } catch { /* la sincronización la pondrá al día */ }
        }
      } catch (err: any) {
        // Un 4xx es un rechazo seguro; un fallo de red o un 5xx podría haberla creado
        const rechazada = /^HTTP 4\d\d\b/.test(String(err?.message));
        resultado[i] = { ...base, estado: "error", error: textoError(err), ...(rechazada ? {} : { intentado: true }) };
      }
    } else {
      let fila: Row = { ...base, estado: "error", error: "sin terminar" };
      try {
        fila = await prepararEscritura(env, client, op, planId, anterior);
        if (fila.estado === "listo") {
          const respuesta = await client.updateRoutine(op.routine_id!, { routine: op.despues });
          fila = await verificar(env, client, op, { ...fila, estado: op.tipo === "restaurar" ? "restaurado" : "modificado" }, respuesta);
        }
      } catch (err: any) {
        fila = { ...base, ...(fila.copia_id != null ? { copia_id: fila.copia_id } : {}), estado: "error", error: textoError(err) };
      }
      resultado[i] = fila;
    }
    await guardarProgreso().catch(() => { /* el resultado se devuelve igual; se guarda al final */ });
  }

  const errores = resultado.filter((r) => r.estado === "error").length;
  const estado = !errores ? "hecho" : errores === resultado.length ? "fallido" : "parcial";
  await env.DB.prepare("UPDATE planes_rutinas SET estado = ?, resultado = ?, aplicando_desde = NULL WHERE plan_id = ?")
    .bind(estado, JSON.stringify(resultado), planId).run();
  return {
    estado,
    resultado: tabla(resultado, ["op", "routine_id", "rutina", "estado", "copia_id", "copia_restaurada", "aviso", "error"]),
    nota: errores
      ? "Lo que sale con estado error NO se ha hecho. Puedes reintentar con el mismo plan_id y confirmar=true: lo ya hecho no se repite."
      : "Hecho en Hevy. Con copia_id se puede volver atrás: programar_rutinas(restaurar=[copia_id]), también en dos pasos.",
  };
}

/** Lee la rutina, comprueba que no ha cambiado y guarda la copia. Devuelve estado "listo" si se puede escribir. */
async function prepararEscritura(env: Env, client: HevyClient, op: Op, planId: string, anterior: Row | undefined): Promise<Row> {
  const id = op.routine_id!;
  const base: Row = { op: op.tipo, routine_id: id, rutina: op.despues.title, copia_restaurada: op.copia_id, copia_id: anterior?.copia_id };
  const respuesta = await client.routine(id);
  if (respuesta === null) return { ...base, estado: "error", error: "la rutina ya no existe en Hevy" };
  const actual = rutinaDe(respuesta);
  if (!actual) return { ...base, estado: "error", error: "Hevy ha dado una respuesta no válida: no se ha tocado nada" };
  if (huella(actual) !== huella(op.antes!)) {
    if (!diferencias(op.despues, cuerpoDesde(actual)).length) return { ...base, estado: "ya_aplicado" };
    return { ...base, estado: "error", error: "la rutina ha cambiado en Hevy después de la vista previa: no se ha tocado; genera una nueva" };
  }
  if (base.copia_id == null) {
    try {
      const r = await env.DB.prepare("INSERT INTO rutina_copias (routine_id, title, raw, motivo, plan_id, creado) VALUES (?,?,?,?,?,?)")
        .bind(id, actual.title, JSON.stringify(actual), op.tipo, planId, nowIso()).run();
      if (r.meta?.last_row_id == null) throw new Error("sin id de la copia");
      base.copia_id = r.meta.last_row_id;
    } catch (err: any) {
      return { ...base, estado: "error", error: `no se ha podido guardar la copia: no se ha tocado la rutina (${textoError(err)})` };
    }
  }
  return { ...base, estado: "listo" };
}

// --- herramienta -------------------------------------------------------------------
export async function programarRutinas(env: Env, args: {
  crear?: RutinaNueva[]; modificar?: CambioRutina[]; restaurar?: number[]; plan_id?: string; confirmar?: boolean;
}) {
  if (!conHevy(env)) return { error: "Hevy no configurado" };
  const client = new HevyClient(env);
  return args.confirmar ? confirmar(env, client, args.plan_id) : vistaPrevia(env, client, args);
}
