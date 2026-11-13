/**
 * Planificación: ver el calendario de intervals.icu y crear, modificar o borrar entrenos en dos pasos.
 * 1) programar_entrenos(entrenos, modificar, borrar) guarda el plan y devuelve una vista previa con plan_id.
 * 2) programar_entrenos(plan_id, confirmar=true) aplica exactamente lo que se mostró.
 * Cada evento creado lleva external_id "entrenos-mcp:<plan_id>:<n>" y queda en la tabla eventos_mcp con el id que da
 * intervals.icu, así que reintentar no duplica nada. Solo se modifican o borran eventos del MCP (ver motivoNoEditable).
 */
import type { Env } from "./env";
import { addDays, nowIso, today } from "./env";
import type { IntervalsClient } from "./clients";
import { A_PIE, hms, intervalsClient, round, type Row, rows, tabla, tiempoEnMarcha } from "./format";

export const PREFIJO = "entrenos-mcp:";
const MAX_ENTRENOS = 10;
const MAX_DIAS = 42;
const CADUCA_H = 24;
export const TIPOS = ["Run", "TrailRun", "Walk", "Hike", "Ride", "VirtualRide", "WeightTraining", "Workout", "Swim"] as const;

export interface Entreno { fecha: string; tipo: string; nombre: string; descripcion: string }

const familia = (t: string) => (A_PIE.includes(t) ? "pie" : t);

function eventoCorto(e: Row, propios?: Set<number>): Row {
  return {
    id: e.id, fecha: String(e.start_date_local ?? "").slice(0, 10), categoria: e.category, tipo: e.type, nombre: e.name,
    duracion: e.moving_time ? hms(e.moving_time) : null,
    carga: e.icu_training_load != null ? Math.round(e.icu_training_load) : null,
    del_entrenador: String(e.external_id ?? "").startsWith(PREFIJO) || propios?.has(Number(e.id)) || null,
  };
}

/** Entreno planificado de un día que corresponde a una actividad (para "plan frente a hecho"). */
export async function planDelDia(env: Env, fecha: string, tipo: string): Promise<Row | null> {
  const client = intervalsClient(env);
  if (!client) return null;
  const evs = (await client.events(fecha, fecha)).filter((e) => e.category === "WORKOUT" && familia(e.type) === familia(tipo));
  if (!evs.length) return null;
  const e = evs[0];
  return Object.fromEntries(Object.entries({
    nombre: e.name, duracion_plan: e.moving_time ? hms(e.moving_time) : null,
    carga_plan: e.icu_training_load != null ? Math.round(e.icu_training_load) : null,
    pasos: e.description ? String(e.description).slice(0, 300) : null,
  }).filter(([, v]) => v != null));
}

// --- ver_plan ---------------------------------------------------------------
export async function verPlan(env: Env, desde?: string, hasta?: string) {
  const client = intervalsClient(env);
  if (!client) return { error: "intervals.icu no configurado" };
  const hoy = today(env.TZ);
  const d = desde ?? addDays(hoy, -6), h = hasta ?? addDays(hoy, 13);
  const evs = (await client.events(d, h)).sort((a, b) => String(a.start_date_local).localeCompare(String(b.start_date_local)));
  const hechas = await rows(env, `SELECT date, sport, distance_m, moving_s, avg_speed_ms, fc_media, training_load FROM activities
    WHERE date BETWEEN ? AND ? AND moving_s >= 120`, d, h < hoy ? h : hoy);
  const propios = new Set((await rows(env, "SELECT event_id FROM eventos_mcp WHERE borrado IS NULL")).map((f) => Number(f.event_id)));
  const filas = evs.map((e) => {
    const r = eventoCorto(e, propios);
    if (e.category === "WORKOUT" && r.fecha <= hoy) {
      const a = hechas.find((x) => x.date === r.fecha && familia(x.sport) === familia(e.type));
      r.hecho = a
        ? [a.distance_m ? `${round(a.distance_m / 1000, 1)} km` : null, hms(tiempoEnMarcha(a)), a.fc_media ? `${Math.round(a.fc_media)} lpm` : null,
          a.training_load != null ? `carga ${Math.round(a.training_load)}` : null].filter(Boolean).join(" · ")
        : (r.fecha < hoy ? "no hecho" : "pendiente hoy");
    }
    return r;
  });
  return {
    desde: d, hasta: h,
    eventos: tabla(filas, ["fecha", "categoria", "tipo", "nombre", "duracion", "carga", "hecho", "del_entrenador", "id"]),
  };
}

// --- programar_entrenos -----------------------------------------------------
export function validar(env: Env, entrenos: Entreno[]): string | null {
  const hoy = today(env.TZ), limite = addDays(hoy, MAX_DIAS);
  if (!entrenos.length) return "No hay entrenos.";
  if (entrenos.length > MAX_ENTRENOS) return `Máximo ${MAX_ENTRENOS} entrenos por plan.`;
  for (const [i, e] of entrenos.entries()) {
    const n = `Entreno ${i + 1}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.fecha)) return `${n}: fecha con formato YYYY-MM-DD.`;
    if (e.fecha < hoy) return `${n}: la fecha ${e.fecha} ya ha pasado.`;
    if (e.fecha > limite) return `${n}: como mucho ${MAX_DIAS} días vista.`;
    if (!(TIPOS as readonly string[]).includes(e.tipo)) return `${n}: tipo no válido (${TIPOS.join(", ")}).`;
    if (!e.nombre?.trim() || e.nombre.length > 80) return `${n}: nombre de 1 a 80 caracteres.`;
    if ((e.descripcion ?? "").length > 1500) return `${n}: descripción de 1500 caracteres como mucho.`;
  }
  return null;
}

// --- reajuste: modificar y borrar ---------------------------------------------
/** Lo que el atleta ve de un evento: es lo que se compara para saber si ha cambiado. */
interface Vista { fecha: string; tipo: string; nombre: string; descripcion: string }
export interface CambioEntreno { id: number; fecha?: string; tipo?: string; nombre?: string; descripcion?: string }
interface OpModificar { id: number; antes: Vista; despues: Vista }
interface OpBorrar { id: number; antes: Vista }
interface Payload { crear: Entreno[]; modificar: OpModificar[]; borrar: OpBorrar[] }

const vista = (e: Row): Vista => ({
  fecha: String(e.start_date_local ?? "").slice(0, 10), tipo: e.type, nombre: e.name ?? "", descripcion: e.description ?? "",
});
const CAMPOS_VISTA = ["fecha", "tipo", "nombre", "descripcion"] as const;
const iguales = (a: Vista, b: Vista) => CAMPOS_VISTA.every((c) => a[c] === b[c]);

/**
 * Por qué no se puede tocar este evento (null si se puede). Es del MCP si está en eventos_mcp (registrado) o si su
 * external_id lleva PREFIJO; un external_id de otro origen manda sobre el registro. Solo entrenos, de hoy en adelante:
 * el pasado se queda como está para no alterar el "plan frente a hecho".
 */
export function motivoNoEditable(e: Row, registrado: boolean, hoy: string): string | null {
  const ext = e.external_id ? String(e.external_id) : null;
  if (ext ? !ext.startsWith(PREFIJO) : !registrado) return `el evento ${e.id} no lo creó el MCP: solo puede cambiarlo el atleta en intervals.icu`;
  if (e.category !== "WORKOUT") return `el evento ${e.id} no es un entreno planificado`;
  if (String(e.start_date_local ?? "").slice(0, 10) < hoy) return `el evento ${e.id} ya ha pasado`;
  return null;
}

/** ids de la lista que están en eventos_mcp, con su external_id. */
async function registrados(env: Env, ids: number[]) {
  const fs = await rows(env, `SELECT event_id, external_id FROM eventos_mcp
    WHERE borrado IS NULL AND event_id IN (SELECT value FROM json_each(?))`, JSON.stringify(ids));
  return new Map(fs.map((f) => [Number(f.event_id), f.external_id as string | null]));
}

/** Comprueba cada cambio contra el calendario y fija qué se va a hacer. Con cualquier error no se guarda ningún plan. */
async function prepararReajuste(env: Env, client: IntervalsClient, modificar: CambioEntreno[], borrar: number[]):
Promise<{ error: string } | { modificar: OpModificar[]; borrar: OpBorrar[] }> {
  const ids = [...modificar.map((c) => c.id), ...borrar];
  if (new Set(ids).size !== ids.length) return { error: "El mismo evento aparece dos veces en el plan." };
  if (!ids.length) return { modificar: [], borrar: [] };
  const hoy = today(env.TZ);
  const propios = await registrados(env, ids);
  const leer = async (id: number): Promise<Row | { error: string }> => {
    let e: Row | null;
    try { e = await client.event(id); } catch (err: any) {
      return { error: `intervals.icu no ha respondido, no se ha guardado ningún plan: ${String(err?.message ?? err).slice(0, 160)}` };
    }
    if (!e) return { error: `No existe el evento ${id}.` };
    const motivo = motivoNoEditable(e, propios.has(id), hoy);
    return motivo ? { error: `No se puede: ${motivo}.` } : e;
  };
  const opsM: OpModificar[] = [], opsB: OpBorrar[] = [];
  for (const c of modificar) {
    const e = await leer(c.id);
    if (e.error) return { error: e.error };
    const antes = vista(e);
    const despues: Vista = {
      fecha: c.fecha ?? antes.fecha, tipo: c.tipo ?? antes.tipo, nombre: c.nombre ?? antes.nombre, descripcion: c.descripcion ?? antes.descripcion,
    };
    if (iguales(antes, despues)) return { error: `Evento ${c.id}: nada que cambiar.` };
    // Solo se valida lo que cambia; el resto ya está en el calendario
    const error = validar(env, [{
      fecha: c.fecha ?? today(env.TZ), tipo: c.tipo ?? TIPOS[0], nombre: c.nombre ?? "-", descripcion: c.descripcion ?? "",
    }]);
    if (error) return { error: error.replace("Entreno 1", `Evento ${c.id}`) };
    opsM.push({ id: c.id, antes, despues });
  }
  for (const id of borrar) {
    const e = await leer(id);
    if (e.error) return { error: e.error };
    opsB.push({ id, antes: vista(e) });
  }
  return { modificar: opsM, borrar: opsB };
}

/** Aplica un cambio tal como se mostró. Si el atleta tocó el evento después de la vista previa, no lo pisa. */
async function aplicarModificar(env: Env, client: IntervalsClient, op: OpModificar, registro: Map<number, string | null>): Promise<Row> {
  const base: Row = { op: "modificar", id: op.id, fecha: op.despues.fecha, nombre: op.despues.nombre };
  const hoy = today(env.TZ);
  const e = await client.event(op.id);
  if (!e) return { ...base, estado: "error", error: "el evento ya no existe" };
  const actual = vista(e);
  if (iguales(actual, op.despues)) return { ...base, estado: "ya_aplicado" };
  if (!iguales(actual, op.antes)) return { ...base, estado: "error", error: "se ha cambiado en intervals.icu después de la vista previa: genera una nueva" };
  const motivo = motivoNoEditable(e, registro.has(op.id), hoy);
  if (motivo) return { ...base, estado: "error", error: motivo };
  if (op.despues.fecha < hoy) return { ...base, estado: "error", error: "la fecha ya ha pasado: genera una vista previa nueva" };
  // Se manda el evento completo, también external_id y categoría, por si PUT sustituye lo que no se envía
  const hora = String(e.start_date_local ?? "").slice(10) || "T00:00:00";
  const ev = await client.updateEvent(op.id, {
    category: e.category, start_date_local: `${op.despues.fecha}${hora}`, type: op.despues.tipo, name: op.despues.nombre,
    description: op.despues.descripcion, external_id: e.external_id ?? registro.get(op.id) ?? undefined,
  });
  // Un 2xx no basta: la respuesta tiene que reflejar el cambio
  if (!ev || Number(ev.id) !== op.id || String(ev.start_date_local ?? "").slice(0, 10) !== op.despues.fecha ||
    ev.name !== op.despues.nombre || ev.type !== op.despues.tipo) {
    return { ...base, estado: "error", error: "intervals.icu ha respondido pero no refleja el cambio: compruébalo con ver_plan" };
  }
  return {
    ...base, estado: "modificado", duracion: ev.moving_time ? hms(ev.moving_time) : null,
    aviso: op.despues.descripcion && !ev.moving_time ? "intervals.icu no ha interpretado los pasos: revisa el formato" : null,
  };
}

async function aplicarBorrar(env: Env, client: IntervalsClient, op: OpBorrar, registro: Map<number, string | null>): Promise<Row> {
  const base: Row = { op: "borrar", id: op.id, fecha: op.antes.fecha, nombre: op.antes.nombre };
  const e = await client.event(op.id);
  if (!e) return { ...base, estado: "ya_no_existia" };
  if (!iguales(vista(e), op.antes)) return { ...base, estado: "error", error: "se ha cambiado en intervals.icu después de la vista previa: genera una nueva" };
  const motivo = motivoNoEditable(e, registro.has(op.id), today(env.TZ));
  if (motivo) return { ...base, estado: "error", error: motivo };
  await client.deleteEvent(op.id);
  return { ...base, estado: "borrado" };
}

/** Apunta en eventos_mcp lo hecho. Si falla, el cambio en intervals.icu sigue siendo cierto: solo se avisa. */
async function apuntar(env: Env, r: Row, campo: "modificado" | "borrado", ext: string | null) {
  try {
    await env.DB.prepare(`INSERT INTO eventos_mcp (event_id, external_id, creado, ${campo}) VALUES (?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET ${campo} = excluded.${campo}`).bind(r.id, ext, nowIso(), nowIso()).run();
  } catch {
    r.aviso = [r.aviso, "hecho en intervals.icu, pero no se ha podido apuntar en el registro"].filter(Boolean).join("; ");
  }
}

// --- programar_entrenos -------------------------------------------------------
export async function programarEntrenos(env: Env, args: {
  entrenos?: Entreno[]; modificar?: CambioEntreno[]; borrar?: number[]; plan_id?: string; confirmar?: boolean;
}) {
  const client = intervalsClient(env);
  if (!client) return { error: "intervals.icu no configurado" };

  // Paso 1: vista previa. No escribe nada en intervals.icu.
  if (!args.confirmar) {
    const entrenos = args.entrenos ?? [], modificar = args.modificar ?? [], borrar = args.borrar ?? [];
    const total = entrenos.length + modificar.length + borrar.length;
    if (total > MAX_ENTRENOS) return { error: `Máximo ${MAX_ENTRENOS} cambios por plan.` };
    if (entrenos.length || !total) {
      const error = validar(env, entrenos);
      if (error) return { error };
    }
    const reajuste = await prepararReajuste(env, client, modificar, borrar);
    if ("error" in reajuste) return { error: reajuste.error };
    const planId = crypto.randomUUID().replace(/-/g, "").slice(0, 10);
    const payload: Payload = { crear: entrenos, ...reajuste };
    await env.DB.prepare("INSERT INTO planes (plan_id, creado, estado, payload) VALUES (?, ?, 'pendiente', ?)")
      .bind(planId, new Date().toISOString(), JSON.stringify(payload)).run();
    const tocados = new Set([...reajuste.modificar.map((o) => o.id), ...reajuste.borrar.map((o) => o.id)]);
    const fechas = [...entrenos.map((e) => e.fecha), ...reajuste.modificar.map((o) => o.despues.fecha)].sort();
    let yaHay: Row[] = [];
    if (fechas.length) {
      try {
        yaHay = (await client.events(fechas[0], fechas[fechas.length - 1]))
          .filter((e) => e.category === "WORKOUT" && !tocados.has(Number(e.id))).map((e) => eventoCorto(e));
      } catch { /* la vista previa no depende de esto */ }
    }
    return Object.fromEntries(Object.entries({
      plan_id: planId,
      caduca_en_h: CADUCA_H,
      entrenos: entrenos.length ? entrenos.map((e) => ({ fecha: e.fecha, tipo: e.tipo, nombre: e.nombre, pasos: e.descripcion })) : null,
      modificar: reajuste.modificar.length
        ? reajuste.modificar.map((o) => ({ id: o.id, antes: o.antes, despues: o.despues, cambia: CAMPOS_VISTA.filter((c) => o.antes[c] !== o.despues[c]) }))
        : null,
      borrar: reajuste.borrar.length ? reajuste.borrar.map((o) => ({ id: o.id, ...o.antes })) : null,
      ya_hay_en_esas_fechas: yaHay.length ? tabla(yaHay, ["fecha", "tipo", "nombre", "duracion", "del_entrenador"]) : null,
      instruccion: "NO está hecho todavía. Muestra este plan al atleta y espera su sí explícito; " +
        "solo entonces llama a programar_entrenos con este plan_id y confirmar=true.",
    }).filter(([, v]) => v != null));
  }

  // Paso 2: confirmar. Se aplica exactamente lo guardado; se ignora cualquier lista nueva.
  if (!args.plan_id) return { error: "Para confirmar hace falta el plan_id de la vista previa." };
  const [p] = await rows(env, "SELECT * FROM planes WHERE plan_id = ?", args.plan_id);
  if (!p) return { error: `No existe el plan ${args.plan_id}.` };
  if (p.estado === "hecho") return { error: "Ese plan ya se programó.", resultado: JSON.parse(p.resultado ?? "null") };
  if (Date.now() - Date.parse(p.creado) > CADUCA_H * 3600_000) return { error: "El plan ha caducado: genera una vista previa nueva." };
  // Los planes guardados antes de poder modificar y borrar son una lista de entrenos
  const guardado = JSON.parse(p.payload);
  const plan: Payload = Array.isArray(guardado) ? { crear: guardado, modificar: [], borrar: [] } : guardado;
  if (plan.crear.length) {
    const error = validar(env, plan.crear);
    if (error) return { error: `${error} Genera una vista previa nueva.` };
  }

  const resultado: Row[] = [];
  // Primero crear y lo último borrar: si algo falla a medias, sobra un entreno en vez de faltar
  if (plan.crear.length) {
    const fechas = plan.crear.map((e) => e.fecha).sort();
    const existentes = new Map<string, number>();
    const yaRegistrados = await rows(env, "SELECT event_id, external_id FROM eventos_mcp WHERE plan_id = ?", p.plan_id);
    for (const f of yaRegistrados) existentes.set(String(f.external_id), Number(f.event_id));
    try {
      for (const e of await client.events(fechas[0], fechas[fechas.length - 1])) {
        if (e.external_id && !existentes.has(String(e.external_id))) existentes.set(String(e.external_id), Number(e.id));
      }
    } catch (err: any) {
      // Sin saber qué hay en el calendario, crear podría duplicar
      return { error: `intervals.icu no ha respondido, no se ha hecho nada: ${String(err?.message ?? err).slice(0, 160)}` };
    }
    const registrar = (id: number, ext: string) => env.DB.prepare(`INSERT INTO eventos_mcp (event_id, external_id, plan_id, creado)
      VALUES (?, ?, ?, ?) ON CONFLICT(event_id) DO NOTHING`).bind(id, ext, p.plan_id, nowIso()).run();
    for (const [i, e] of plan.crear.entries()) {
      const ext = `${PREFIJO}${p.plan_id}:${i}`;
      const base: Row = { op: "crear", fecha: e.fecha, nombre: e.nombre };
      const previo = existentes.get(ext);
      if (previo != null) {
        await registrar(previo, ext).catch(() => {});
        resultado.push({ ...base, estado: "ya_existia", id: previo });
        continue;
      }
      try {
        const ev = await client.createEvent({
          category: "WORKOUT", start_date_local: `${e.fecha}T00:00:00`, type: e.tipo, name: e.nombre,
          description: e.descripcion ?? "", external_id: ext,
        });
        if (ev?.id == null) throw new Error("intervals.icu ha respondido sin el id del evento: compruébalo con ver_plan");
        const fila: Row = {
          ...base, estado: "creado", id: ev.id, external_id_devuelto: ev.external_id === ext,
          duracion: ev.moving_time ? hms(ev.moving_time) : null,
          aviso: e.descripcion && !ev.moving_time ? "intervals.icu no ha interpretado los pasos: revisa el formato" : null,
        };
        await registrar(Number(ev.id), ext).catch(() => {
          fila.aviso = [fila.aviso, "creado en intervals.icu, pero no se ha podido apuntar en el registro"].filter(Boolean).join("; ");
        });
        resultado.push(fila);
      } catch (err: any) {
        resultado.push({ ...base, estado: "error", error: String(err?.message ?? err).slice(0, 160) });
      }
    }
  }

  const registro = await registrados(env, [...plan.modificar.map((o) => o.id), ...plan.borrar.map((o) => o.id)]);
  for (const op of plan.modificar) {
    try {
      const r = await aplicarModificar(env, client, op, registro);
      if (r.estado === "modificado") await apuntar(env, r, "modificado", registro.get(op.id) ?? null);
      resultado.push(r);
    } catch (err: any) {
      resultado.push({ op: "modificar", id: op.id, fecha: op.despues.fecha, nombre: op.despues.nombre, estado: "error", error: String(err?.message ?? err).slice(0, 160) });
    }
  }
  for (const op of plan.borrar) {
    try {
      const r = await aplicarBorrar(env, client, op, registro);
      if (r.estado === "borrado" || r.estado === "ya_no_existia") await apuntar(env, r, "borrado", registro.get(op.id) ?? null);
      resultado.push(r);
    } catch (err: any) {
      resultado.push({ op: "borrar", id: op.id, fecha: op.antes.fecha, nombre: op.antes.nombre, estado: "error", error: String(err?.message ?? err).slice(0, 160) });
    }
  }

  const errores = resultado.filter((r) => r.estado === "error").length;
  const estado = !errores ? "hecho" : errores === resultado.length ? "fallido" : "parcial";
  await env.DB.prepare("UPDATE planes SET estado = ?, resultado = ? WHERE plan_id = ?")
    .bind(estado, JSON.stringify(resultado), p.plan_id).run();
  return {
    estado,
    resultado: tabla(resultado, ["op", "fecha", "nombre", "estado", "duracion", "aviso", "error", "id", "external_id_devuelto"]),
    nota: errores
      ? "Lo que sale con estado error NO se ha hecho. Puedes reintentar con el mismo plan_id y confirmar=true: lo ya hecho no se repite."
      : "En el calendario de intervals.icu. Llegan al reloj solo si en intervals.icu está activado 'Upload planned workouts'.",
  };
}
