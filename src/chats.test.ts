/**
 * Tests de lo que usan los chats Carreras y Preparador físico: estado compartido, alertas activas y reajuste del calendario.
 * Se ejecutan con SQLite de verdad y todas las migraciones, e intervals.icu simulado: nunca tocan la base ni el calendario reales.
 * Si la versión de Node no trae node:sqlite, estos tests se saltan (en local, con Node 22.13 o superior, siempre corren).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { caducidad, elegirAlertas, estadoAtleta, nota, revisarActividad, semanaIso } from "./coach";
import type { Env } from "./env";
import { addDays, today } from "./env";
import { CAMPOS, estado, MAX_TEXTO_ESTADO } from "./estado";
import { motivoNoEditable, PREFIJO, programarEntrenos, verPlan } from "./plan";
import { buildServer, prepararSql, vistasDe } from "./tools";

// Importaciones por nombre variable: tsconfig solo incluye los tipos de Workers, no los de Node
const nodeImport = (m: string): Promise<any> => import(/* @vite-ignore */ m);
const sqlite = await nodeImport("node:sqlite").catch(() => null);
const fs = await nodeImport("node:fs");

/** D1 sobre SQLite en memoria, con todas las migraciones aplicadas en orden. */
function baseDePrueba() {
  const db = new sqlite.DatabaseSync(":memory:");
  for (const f of (fs.readdirSync("migrations") as string[]).sort()) db.exec(fs.readFileSync(`migrations/${f}`, "utf8"));
  const stmt = (sql: string, params: unknown[] = []): any => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => {
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: any[]) => Promise.all(ss.map((s) => s.run())) } as unknown as D1Database;
}

const BASE = "http://intervals.prueba/api/v1";
const hoy = today("Europe/Madrid");
const manana = addDays(hoy, 1);

/** Calendario simulado de intervals.icu: guarda los eventos y las peticiones de escritura. */
function calendarioSimulado() {
  const eventos = new Map<number, any>();
  const escrituras: { metodo: string; url: string; cuerpo?: any }[] = [];
  let siguiente = 100;
  let fallo: ((metodo: string, url: string) => number | null) | null = null;
  const fetchFalso = async (entrada: string, init?: RequestInit) => {
    const url = new URL(entrada), metodo = init?.method ?? "GET";
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (metodo !== "GET") escrituras.push({ metodo, url: url.pathname + url.search, cuerpo });
    const status = fallo?.(metodo, url.pathname);
    if (status) return new Response("fallo simulado", { status });
    const m = url.pathname.match(/\/events\/(\d+)$/);
    if (m) {
      const id = Number(m[1]), e = eventos.get(id);
      if (!e) return new Response("no existe", { status: 404 });
      if (metodo === "DELETE") { eventos.delete(id); return new Response("", { status: 200 }); }
      if (metodo === "PUT") { eventos.set(id, { ...e, ...cuerpo, id }); return Response.json(eventos.get(id)); }
      return Response.json(e);
    }
    if (metodo === "POST") {
      const e = { ...cuerpo, id: siguiente++, moving_time: cuerpo.description ? 1800 : undefined };
      eventos.set(e.id, e);
      return Response.json(e);
    }
    const [desde, hasta] = [url.searchParams.get("oldest") ?? "", url.searchParams.get("newest") ?? ""];
    return Response.json([...eventos.values()].filter((e) => e.start_date_local.slice(0, 10) >= desde && e.start_date_local.slice(0, 10) <= hasta));
  };
  return { eventos, escrituras, fetchFalso, fallar: (f: typeof fallo) => { fallo = f; } };
}

const ajeno = (id: number, fecha = manana) => ({
  id, category: "WORKOUT", start_date_local: `${fecha}T00:00:00`, type: "Run", name: "Del atleta", description: "- 10m Z2 HR",
});

describe.skipIf(!sqlite)("con base de datos", () => {
  let env: Env;
  beforeEach(() => {
    env = { TZ: "Europe/Madrid", DB: baseDePrueba(), INTERVALS_API_KEY: "k", INTERVALS_ATHLETE_ID: "0", INTERVALS_BASE_URL: BASE } as unknown as Env;
  });
  afterEach(() => vi.unstubAllGlobals());

  // --- estado ---------------------------------------------------------------
  describe("estado", () => {
    it("empieza vacío, en la versión 0", async () => {
      const e: any = await estado(env, {});
      expect(e.version).toBe(0);
      for (const c of CAMPOS) expect(e[c]).toBe("");
    });

    it("actualiza solo los campos indicados y guarda qué cambió, quién y cuándo", async () => {
      await estado(env, { objetivo: "objetivo A", reglas: "regla A", version_base: 0, origen: "chat 1", motivo: "inicio" });
      const r: any = await estado(env, { plan: "plan B", objetivo: "objetivo A", version_base: 1, origen: "chat 2" });
      expect(r.version).toBe(2);
      expect(r.hecho).toBe("guardado: plan");
      expect(r.objetivo).toBe("objetivo A");
      expect(r.reglas).toBe("regla A");
      const leido: any = await estado(env, {});
      expect(leido.origen).toBe("chat 2");
      expect(leido.cambios_recientes.columnas).toEqual(["version", "fecha", "origen", "cambiados", "motivo"]);
      expect(leido.cambios_recientes.filas.map((f: any[]) => [f[0], f[3]])).toEqual([[2, "plan"], [1, "objetivo, reglas"]]);
      expect(leido.cambios_recientes.filas[0][1]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("permite leer una versión antigua y vaciar un campo con texto vacío", async () => {
      await estado(env, { rutina: "rutina A", version_base: 0 });
      await estado(env, { rutina: "", version_base: 1 });
      expect(((await estado(env, {})) as any).rutina).toBe("");
      expect(((await estado(env, { version: 1 })) as any).rutina).toBe("rutina A");
      expect(((await estado(env, { version: 9 })) as any).error).toMatch(/No existe/);
    });

    it("rechaza una escritura sobre una versión vieja: no pisa lo de otro chat", async () => {
      await estado(env, { decisiones: "de un chat", version_base: 0 });
      const r: any = await estado(env, { decisiones: "de otro chat", version_base: 0 });
      expect(r.error).toMatch(/Otro chat/);
      expect(r.version_vigente).toBe(1);
      expect(((await estado(env, {})) as any).decisiones).toBe("de un chat");
    });

    it("exige version_base, limita el tamaño y no crea versión si nada cambia", async () => {
      expect(((await estado(env, { plan: "x" })) as any).error).toMatch(/version_base/);
      expect(((await estado(env, { plan: "x".repeat(MAX_TEXTO_ESTADO + 1), version_base: 0 })) as any).error).toMatch(/caracteres/);
      await estado(env, { plan: "x", version_base: 0 });
      const r: any = await estado(env, { plan: "x", version_base: 1 });
      expect(r.hecho).toMatch(/sin cambios/);
      expect(r.version).toBe(1);
    });

    it("consulta_sql no lee las tablas nuevas", () => {
      for (const t of ["estado_versiones", "alertas_activas", "eventos_mcp"]) expect(prepararSql(`SELECT * FROM ${t}`)).toHaveProperty("error");
    });
  });

  // --- alertas ---------------------------------------------------------------
  describe("alertas activas", () => {
    // Sin clave de intervals: estas herramientas no salen a la red
    beforeEach(() => { env.INTERVALS_API_KEY = undefined; });
    /** Guarda una alerta de actividad como la dejaría revisar_actividad. */
    const guardar = (clave: string, prioridad: number, caduca: string | null, creada = "2026-01-01T00:00:00Z") =>
      env.DB.prepare("INSERT INTO alertas_activas (clave, motivo, pregunta, prioridad, creada, caduca) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(clave, `motivo ${clave}`, `pregunta ${clave}`, prioridad, creada, caduca).run();
    const FUTURO = `${addDays(hoy, 2)}T00:00:00Z`;
    const claves = async () => ((await estadoAtleta(env)).alertas as any[]).map((a) => a.clave);

    it("una alerta de una actividad sigue saliendo en otra herramienta y en cada respuesta, con su clave", async () => {
      await guardar("cortada:a1", 3, FUTURO);
      expect(await claves()).toEqual(["cortada:a1"]);
      expect(await claves()).toEqual(["cortada:a1"]);
      const [a] = (await estadoAtleta(env)).alertas as any[];
      expect(a.motivo).toBe("motivo cortada:a1");
      expect(a.pregunta_sugerida).toBe("pregunta cortada:a1");
    });

    /** Actividad de bicicleta sin sensaciones: revisar_actividad detecta la alerta feel. */
    const actividad = (id: string, fecha: string, raw = "{}") => env.DB.prepare(
      "INSERT INTO activities (id, sport, start_local, moving_s, raw, synced_at) VALUES (?, 'Ride', ?, 3600, ?, 'x')")
      .bind(id, `${fecha}T08:00:00`, raw).run();
    const deRevision = async (id: string) => (((await revisarActividad(env, id)) as any).alertas as any[]).map((a) => a.clave);

    it("lo detectado al revisar una actividad sale también en estado_atleta y en la revisión de otra", async () => {
      await actividad("a1", hoy);
      await actividad("a2", addDays(hoy, -1));
      expect(await deRevision("a1")).toEqual(["feel:a1"]);
      expect(await claves()).toEqual(["feel:a1"]);
      expect(await deRevision("a2")).toEqual(["feel:a1", "feel:a2"]);
    });

    it("resolverla con nota la quita de todos los chats, y volver a revisar no la resucita", async () => {
      await actividad("a1", hoy);
      await revisarActividad(env, "a1");
      expect((await nota(env, { resolver_alerta: "feel:a1" })).hecho).toEqual(["alerta feel:a1 resuelta"]);
      expect(await claves()).toEqual([]);
      expect(await deRevision("a1")).toEqual([]);
    });

    it("deja de salir cuando ya no aplica: el atleta registró las sensaciones", async () => {
      await actividad("a1", hoy);
      await revisarActividad(env, "a1");
      await env.DB.prepare("UPDATE activities SET raw = ? WHERE id = 'a1'").bind('{"feel":2}').run();
      expect(await deRevision("a1")).toEqual([]);
      expect(await claves()).toEqual([]);
    });

    it("revisar una actividad antigua no reabre una alerta ya caducada", async () => {
      await actividad("vieja", addDays(hoy, -30));
      expect(await deRevision("vieja")).toEqual([]);
    });

    it("avisa si la clave no existe o ya estaba resuelta", async () => {
      expect((await nota(env, { resolver_alerta: "nada:1" })).hecho[0]).toMatch(/no hay ninguna/);
      await guardar("feel:a1", 1, FUTURO);
      await nota(env, { resolver_alerta: "feel:a1" });
      expect((await nota(env, { resolver_alerta: "feel:a1" })).hecho[0]).toMatch(/no hay ninguna/);
    });

    it("caduca sola", async () => {
      await guardar("feel:a1", 1, "2020-01-01T00:00:00Z");
      expect(await claves()).toEqual([]);
    });

    it("máximo 2 por respuesta, por prioridad; las demás salen al resolver las primeras", async () => {
      await guardar("feel:a1", 1, FUTURO);
      await guardar("cortada:a1", 3, FUTURO);
      await guardar("fc_alta:a1", 2, FUTURO);
      expect(await claves()).toEqual(["cortada:a1", "fc_alta:a1"]);
      await nota(env, { resolver_alerta: "cortada:a1" });
      expect(await claves()).toEqual(["fc_alta:a1", "feel:a1"]);
    });

    it("una alerta de estado guardada solo sale si su condición se sigue cumpliendo", async () => {
      await guardar(`carga:${semanaIso(hoy)}`, 3, null);
      expect(await claves()).toEqual([]); // sin actividades, la carga ya no es alta
    });

    it("una alerta de estado detectada ahora se guarda, sale y se puede resolver", async () => {
      // 28 días con carga 10 y una última semana muy cargada: dispara la alerta de carga
      for (let i = 0; i < 28; i++) {
        await env.DB.prepare(`INSERT INTO activities (id, sport, start_local, moving_s, training_load, raw, synced_at)
          VALUES (?, 'Run', ?, 3600, ?, '{}', 'x')`).bind(`a${i}`, `${addDays(hoy, -i)}T08:00:00`, i < 7 ? 60 : 5).run();
      }
      const clave = `carga:${semanaIso(hoy)}`;
      expect(await claves()).toContain(clave);
      await nota(env, { resolver_alerta: clave });
      expect(await claves()).not.toContain(clave);
    });
  });

  // --- datos leídos de raw (migración 0012) -----------------------------------
  describe("sueño, pasos, recuperación de FC y polarización desde raw", () => {
    const dia = (n: number) => addDays(hoy, -n);
    const insertarDia = (fecha: string, raw: unknown) =>
      env.DB.prepare("INSERT INTO wellness (date, ctl, atl, raw) VALUES (?, 10, 10, ?)").bind(fecha, JSON.stringify(raw)).run();
    const insertarActividad = (id: string, sport: string, raw: unknown) =>
      env.DB.prepare(`INSERT INTO activities (id, sport, start_local, distance_m, moving_s, splits_estado, raw, synced_at)
        VALUES (?, ?, ?, 5000, 1800, 'ok', ?, 'x')`).bind(id, sport, `${dia(1)}T10:00:00`, JSON.stringify(raw)).run();

    it("las vistas leen los campos con los nombres de intervals", async () => {
      await insertarDia(dia(1), { sleepScore: 70, sleepQuality: 3, avgSleepingHR: 60, steps: 5000 });
      await insertarActividad("a1", "Run", { icu_hrr: { start_bpm: 180, end_bpm: 150, hrr: 30 }, polarization_index: 0.5 });
      const w: any = await env.DB.prepare("SELECT sleep_score, sleep_quality, avg_sleeping_hr, steps FROM v_wellness").first();
      expect({ ...w }).toEqual({ sleep_score: 70, sleep_quality: 3, avg_sleeping_hr: 60, steps: 5000 });
      const a: any = await env.DB.prepare("SELECT hrr_start_bpm, hrr_end_bpm, hrr_bpm, polarization_index FROM v_activities").first();
      expect({ ...a }).toEqual({ hrr_start_bpm: 180, hrr_end_bpm: 150, hrr_bpm: 30, polarization_index: 0.5 });
    });

    it("estado_atleta: los pasos de hoy no entran en la media y lo que falta queda vacío", async () => {
      await insertarDia(hoy, { sleepScore: 70, avgSleepingHR: 60, steps: 100 });
      await insertarDia(dia(1), { sleepScore: 80, avgSleepingHR: 55, steps: 4000 });
      await insertarDia(dia(2), { steps: 6000 });
      await insertarDia(dia(3), {});
      const r = (await estadoAtleta(env) as any).recuperacion;
      expect(r.sueno_puntuacion_7d).toEqual([70, 80, null, null]);
      expect(r.fc_sueno_7d).toEqual([60, 55, null, null]);
      expect(r.pasos_media_7d).toBe(5000);
    });

    it("estado_atleta: sin pasos anteriores a hoy, no sale la media", async () => {
      await insertarDia(hoy, { steps: 100 });
      const salida = JSON.parse(JSON.stringify((await estadoAtleta(env) as any).recuperacion));
      expect(salida).not.toHaveProperty("pasos_media_7d");
    });

    it("revisar_actividad: muestra la recuperación de FC, la polarización y el sueño de ese día", async () => {
      await insertarDia(dia(1), { sleepScore: 75, avgSleepingHR: 58 });
      await insertarActividad("a1", "Run", { icu_hrr: { start_bpm: 180, end_bpm: 150, hrr: 30 }, polarization_index: 0 });
      const r = await revisarActividad(env, "a1") as any;
      expect(r.actividad.recuperacion_fc).toEqual({ inicio_lpm: 180, fin_lpm: 150, caida_lpm_60s: 30 });
      expect(r.actividad.polarizacion).toBe(0);
      expect(r.forma_ese_dia).toMatchObject({ sueno_puntuacion: 75, fc_sueno: 58 });
    });

    it("revisar_actividad: sin icu_hrr no sale la recuperación, y en gimnasio no sale la polarización", async () => {
      await insertarActividad("a1", "Run", { polarization_index: 0.5 });
      await insertarActividad("g1", "WeightTraining", { polarization_index: 0 });
      const carrera = (await revisarActividad(env, "a1") as any).actividad;
      expect(carrera).not.toHaveProperty("recuperacion_fc");
      expect(carrera.polarizacion).toBe(0.5);
      expect((await revisarActividad(env, "g1") as any).actividad).not.toHaveProperty("polarizacion");
    });
  });

  // --- reajuste del calendario ------------------------------------------------
  describe("programar_entrenos: modificar y borrar", () => {
    let cal: ReturnType<typeof calendarioSimulado>;
    beforeEach(() => {
      cal = calendarioSimulado();
      vi.stubGlobal("fetch", cal.fetchFalso);
    });
    const entreno = { fecha: manana, tipo: "Run", nombre: "Rodaje", descripcion: "- 30m Z2 HR" };
    /** Crea un entreno por el camino real y devuelve su id. */
    async function crear() {
      const p: any = await programarEntrenos(env, { entrenos: [entreno] });
      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      const cols: string[] = r.resultado.columnas;
      return r.resultado.filas[0][cols.indexOf("id")] as number;
    }
    const fila = (r: any, i = 0) => Object.fromEntries(r.resultado.columnas.map((c: string, k: number) => [c, r.resultado.filas[i][k]]));

    it("crear registra el evento, y el resultado dice si external_id ha vuelto", async () => {
      const p: any = await programarEntrenos(env, { entrenos: [entreno] });
      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r.estado).toBe("hecho");
      expect(fila(r).external_id_devuelto).toBe(true);
      const { results } = await env.DB.prepare("SELECT event_id, external_id FROM eventos_mcp").all();
      expect(results).toEqual([{ event_id: fila(r).id, external_id: `${PREFIJO}${p.plan_id}:0` }]);
    });

    it("la vista previa no escribe nada; confirmar modifica exactamente lo que se mostró", async () => {
      const id = await crear();
      cal.escrituras.length = 0;
      const p: any = await programarEntrenos(env, { modificar: [{ id, nombre: "Rodaje suave", fecha: addDays(hoy, 2) }] });
      expect(p.instruccion).toMatch(/NO está/);
      expect(p.modificar[0].antes.nombre).toBe("Rodaje");
      expect(p.modificar[0].despues).toMatchObject({ nombre: "Rodaje suave", fecha: addDays(hoy, 2), descripcion: "- 30m Z2 HR" });
      expect(p.modificar[0].cambia).toEqual(["fecha", "nombre"]);
      expect(cal.escrituras).toEqual([]);
      expect(cal.eventos.get(id).name).toBe("Rodaje");

      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true, modificar: [{ id, nombre: "Otro" }] } as any);
      expect(r.estado).toBe("hecho");
      expect(fila(r).estado).toBe("modificado");
      expect(cal.eventos.get(id)).toMatchObject({ name: "Rodaje suave", start_date_local: `${addDays(hoy, 2)}T00:00:00`, description: "- 30m Z2 HR" });
      expect(cal.eventos.get(id).external_id).toMatch(new RegExp(`^${PREFIJO}`));
      expect(cal.escrituras).toHaveLength(1);
      expect(cal.escrituras[0].metodo).toBe("PUT");
      expect(cal.escrituras[0].url).toBe(`/api/v1/athlete/0/events/${id}`);
    });

    it("borrar usa solo DELETE del evento, sin arrastrar otros, con respuesta vacía", async () => {
      const id = await crear();
      const otro = await crear();
      cal.escrituras.length = 0;
      const p: any = await programarEntrenos(env, { borrar: [id] });
      expect(p.borrar[0]).toMatchObject({ id, nombre: "Rodaje" });
      expect(cal.eventos.has(id)).toBe(true);
      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r.estado).toBe("hecho");
      expect(fila(r).estado).toBe("borrado");
      expect(cal.eventos.has(id)).toBe(false);
      expect(cal.eventos.has(otro)).toBe(true);
      expect(cal.escrituras).toEqual([{ metodo: "DELETE", url: `/api/v1/athlete/0/events/${id}`, cuerpo: undefined }]);
    });

    it("sin vista previa no se confirma, y un plan hecho no se repite", async () => {
      const id = await crear();
      expect(((await programarEntrenos(env, { confirmar: true })) as any).error).toMatch(/plan_id/);
      const p: any = await programarEntrenos(env, { borrar: [id] });
      await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(((await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true })) as any).error).toMatch(/ya se programó/);
    });

    it("no toca eventos que no creó el MCP", async () => {
      cal.eventos.set(7, ajeno(7));
      for (const args of [{ borrar: [7] }, { modificar: [{ id: 7, nombre: "x" }] }]) {
        const r: any = await programarEntrenos(env, args);
        expect(r.error).toMatch(/no lo creó el MCP/);
        expect(r.plan_id).toBeUndefined();
      }
      expect(cal.escrituras).toEqual([]);
    });

    it("reconoce como suyo un evento con el prefijo aunque no esté en el registro", async () => {
      cal.eventos.set(8, { ...ajeno(8), external_id: `${PREFIJO}antiguo:0` });
      const p: any = await programarEntrenos(env, { borrar: [8] });
      expect(p.plan_id).toBeTruthy();
    });

    it("funciona aunque intervals no devuelva external_id: manda el registro", async () => {
      const id = await crear();
      delete cal.eventos.get(id).external_id;
      const p: any = await programarEntrenos(env, { modificar: [{ id, nombre: "Nuevo" }] });
      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r.estado).toBe("hecho");
      // Le devuelve su external_id para no perderlo
      expect(cal.escrituras.at(-1)!.cuerpo.external_id).toMatch(new RegExp(`^${PREFIJO}`));
    });

    it("reintentar la creación no duplica aunque external_id no vuelva", async () => {
      const p: any = await programarEntrenos(env, { entrenos: [entreno, { ...entreno, nombre: "Otro" }] });
      let creados = 0;
      cal.fallar((m) => (m === "POST" && ++creados === 2 ? 500 : null));
      const r1: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r1.estado).toBe("parcial");
      expect(fila(r1, 1).estado).toBe("error");
      for (const e of cal.eventos.values()) delete e.external_id;
      cal.fallar(null);
      const r2: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r2.estado).toBe("hecho");
      expect(fila(r2, 0).estado).toBe("ya_existia");
      expect(fila(r2, 1).estado).toBe("creado");
      expect(cal.eventos.size).toBe(2);
    });

    it("un fallo de intervals nunca sale como hecho, y se puede reintentar", async () => {
      const id = await crear();
      for (const [args, metodo] of [[{ modificar: [{ id, nombre: "Nuevo" }] }, "PUT"], [{ borrar: [id] }, "DELETE"]] as const) {
        const p: any = await programarEntrenos(env, args as any);
        cal.fallar((m) => (m === metodo ? 500 : null));
        const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
        expect(r.estado).toBe("fallido");
        expect(fila(r).estado).toBe("error");
        expect(fila(r).error).toMatch(/HTTP 500/);
        expect(r.nota).toMatch(/NO/);
        cal.fallar(null);
        expect(cal.eventos.get(id).name).toBe("Rodaje");
      }
      const p: any = await programarEntrenos(env, { borrar: [id] });
      cal.fallar((m) => (m === "DELETE" ? 500 : null));
      await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      cal.fallar(null);
      const ok: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(ok.estado).toBe("hecho");
      expect(cal.eventos.has(id)).toBe(false);
    });

    it("al reintentar un plan a medias, lo ya hecho no se repite", async () => {
      const a = await crear(), b = await crear();
      const p: any = await programarEntrenos(env, { modificar: [{ id: a, nombre: "Cambiado" }], borrar: [b] });
      cal.fallar((m) => (m === "DELETE" ? 500 : null));
      const r1: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r1.estado).toBe("parcial");
      expect([fila(r1, 0).estado, fila(r1, 1).estado]).toEqual(["modificado", "error"]);
      cal.fallar(null);
      cal.escrituras.length = 0;
      const r2: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r2.estado).toBe("hecho");
      expect([fila(r2, 0).estado, fila(r2, 1).estado]).toEqual(["ya_aplicado", "borrado"]);
      expect(cal.escrituras.map((e) => e.metodo)).toEqual(["DELETE"]);
    });

    it("un 2xx que no refleja el cambio cuenta como error", async () => {
      const id = await crear();
      const p: any = await programarEntrenos(env, { modificar: [{ id, nombre: "Nuevo" }] });
      vi.stubGlobal("fetch", async (u: string, init?: RequestInit) =>
        (init?.method === "PUT" ? Response.json({ id, name: "Rodaje", type: "Run", start_date_local: `${manana}T00:00:00` }) : cal.fetchFalso(u, init)));
      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(fila(r).estado).toBe("error");
    });

    it("una creación con respuesta sin id cuenta como error", async () => {
      const p: any = await programarEntrenos(env, { entrenos: [entreno] });
      vi.stubGlobal("fetch", async (u: string, init?: RequestInit) =>
        (init?.method === "POST" ? new Response("", { status: 200 }) : cal.fetchFalso(u, init)));
      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r.estado).toBe("fallido");
    });

    it("no aplica nada si el atleta cambió el evento después de la vista previa", async () => {
      const id = await crear();
      const p: any = await programarEntrenos(env, { modificar: [{ id, nombre: "Nuevo" }] });
      cal.eventos.get(id).description = "- 5m Z1 HR";
      cal.escrituras.length = 0;
      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(fila(r).estado).toBe("error");
      expect(fila(r).error).toMatch(/cambiado/);
      expect(cal.escrituras).toEqual([]);
    });

    it("si el evento ya no existe al confirmar: borrar no dice 'borrado' y modificar es un error", async () => {
      const id = await crear();
      const pb: any = await programarEntrenos(env, { borrar: [id] });
      const pm: any = await programarEntrenos(env, { modificar: [{ id, nombre: "Nuevo" }] });
      cal.eventos.delete(id);
      const rb: any = await programarEntrenos(env, { plan_id: pb.plan_id, confirmar: true });
      expect(fila(rb).estado).toBe("ya_no_existia");
      const rm: any = await programarEntrenos(env, { plan_id: pm.plan_id, confirmar: true });
      expect(fila(rm).estado).toBe("error");
      expect(fila(rm).error).toMatch(/ya no existe/);
    });

    it("si intervals falla en la vista previa no se guarda el plan", async () => {
      const id = await crear();
      cal.fallar(() => 503);
      const r: any = await programarEntrenos(env, { borrar: [id] });
      expect(r.error).toMatch(/HTTP 503/);
      expect(r.plan_id).toBeUndefined();
    });

    it("valida los cambios y rechaza mezclas sin sentido", async () => {
      const id = await crear();
      const error = async (a: any) => ((await programarEntrenos(env, a)) as any).error;
      expect(await error({})).toMatch(/No hay/);
      expect(await error({ modificar: [{ id }] })).toMatch(/nada que cambiar/);
      expect(await error({ modificar: [{ id, nombre: "Rodaje" }] })).toMatch(/nada que cambiar/);
      expect(await error({ modificar: [{ id, fecha: addDays(hoy, -1) }] })).toMatch(/ya ha pasado/);
      expect(await error({ modificar: [{ id, fecha: addDays(hoy, 43) }] })).toMatch(/42 días/);
      expect(await error({ modificar: [{ id, nombre: " " }] })).toMatch(/nombre/);
      expect(await error({ modificar: [{ id, nombre: "x" }], borrar: [id] })).toMatch(/dos veces/);
      expect(await error({ borrar: Array.from({ length: 11 }, (_, i) => i + 1) })).toMatch(/Máximo 10/);
      expect(await error({ borrar: [12345] })).toMatch(/No existe/);
    });

    it("un plan puede crear, modificar y borrar a la vez", async () => {
      const a = await crear(), b = await crear();
      const p: any = await programarEntrenos(env, {
        entrenos: [{ ...entreno, nombre: "Nuevo" }], modificar: [{ id: a, nombre: "Cambiado" }], borrar: [b],
      });
      const r: any = await programarEntrenos(env, { plan_id: p.plan_id, confirmar: true });
      expect(r.estado).toBe("hecho");
      expect([0, 1, 2].map((i) => fila(r, i).estado)).toEqual(["creado", "modificado", "borrado"]);
    });

    it("confirma planes guardados con el formato anterior (lista de entrenos)", async () => {
      await env.DB.prepare("INSERT INTO planes (plan_id, creado, estado, payload) VALUES ('viejo', ?, 'pendiente', ?)")
        .bind(new Date().toISOString(), JSON.stringify([entreno])).run();
      const r: any = await programarEntrenos(env, { plan_id: "viejo", confirmar: true });
      expect(r.estado).toBe("hecho");
    });

    it("ver_plan marca como del entrenador lo registrado aunque external_id no vuelva, pero no lo ajeno", async () => {
      const id = await crear();
      delete cal.eventos.get(id).external_id;
      cal.eventos.set(7, ajeno(7));
      const r: any = await verPlan(env, hoy, addDays(hoy, 3));
      const cols: string[] = r.eventos.columnas;
      const del = (i: number) => r.eventos.filas.find((f: any[]) => f[cols.indexOf("id")] === i)[cols.indexOf("del_entrenador")];
      expect(del(id)).toBe(true);
      expect(del(7)).toBeNull();
    });
  });
});

// --- lógica pura, sin base de datos ----------------------------------------
describe("caducidad de alertas", () => {
  const a = (clave: string, extra = {}) => ({ clave, motivo: "", pregunta_sugerida: "", prioridad: 1, ...extra });
  it("cuenta los días desde la actividad y el último día es entero", () => {
    expect(caducidad(a("feel:x", { fecha: "2026-03-10" }))).toBe("2026-03-13T00:00:00Z");
    expect(caducidad(a("deriva:x", { fecha: "2026-03-10" }))).toBe("2026-03-14T00:00:00Z");
    expect(caducidad(a("pierna48:x", { fecha: "2026-03-10" }))).toBe("2026-03-14T00:00:00Z");
    expect(caducidad(a("fc_alta:x", { fecha: "2026-03-10" }))).toBe("2026-03-16T00:00:00Z");
    expect(caducidad(a("cortada:x", { fecha: "2026-03-10" }))).toBe("2026-03-18T00:00:00Z");
  });
  it("respeta un instante exacto, y las de estado no caducan por fecha", () => {
    expect(caducidad(a("pierna_hoy:x", { caduca: "2026-03-10T12:00:00Z" }))).toBe("2026-03-10T12:00:00Z");
    expect(caducidad(a("carga:2026-W10"))).toBeNull();
    expect(caducidad(a("nota:3:2026-W10"))).toBeNull();
  });
});

describe("elegir alertas", () => {
  const fila = (clave: string, prioridad: number, creada = "2026-01-01") => ({ clave, motivo: "m", pregunta: "p", prioridad, creada });
  it("a igual prioridad sale antes la más antigua", () => {
    const r = elegirAlertas([fila("feel:b", 1, "2026-01-02"), fila("feel:a", 1, "2026-01-01"), fila("deriva:c", 1, "2026-01-03")], new Set());
    expect(r.map((x) => x.clave)).toEqual(["feel:a", "feel:b"]);
  });
  it("las de estado solo salen si se detectan ahora", () => {
    const r = elegirAlertas([fila("carga:s", 3), fila("vfc:s", 2), fila("feel:a", 1)], new Set(["vfc:s"]));
    expect(r.map((x) => x.clave)).toEqual(["vfc:s", "feel:a"]);
  });
});

describe("qué eventos se pueden tocar", () => {
  const ev = (extra = {}) => ({ ...ajeno(1), ...extra });
  it("solo los registrados o con el prefijo", () => {
    expect(motivoNoEditable(ev(), false, hoy)).toMatch(/no lo creó el MCP/);
    expect(motivoNoEditable(ev(), true, hoy)).toBeNull();
    expect(motivoNoEditable(ev({ external_id: `${PREFIJO}p:0` }), false, hoy)).toBeNull();
  });
  it("un external_id de otro origen manda, aunque esté registrado", () => {
    expect(motivoNoEditable(ev({ external_id: "otra-app:1" }), true, hoy)).toMatch(/no lo creó el MCP/);
  });
  it("solo entrenos planificados, y nunca del pasado", () => {
    expect(motivoNoEditable(ev({ category: "NOTE" }), true, hoy)).toMatch(/no es un entreno/);
    expect(motivoNoEditable(ajeno(1, addDays(hoy, -1)), true, hoy)).toMatch(/pasado/);
    expect(motivoNoEditable(ajeno(1, hoy), true, hoy)).toBeNull();
  });
});

describe.skipIf(!sqlite)("por el protocolo MCP", () => {
  it("registra las 11 herramientas y estado acepta sus parámetros", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const env = { TZ: "Europe/Madrid", DB: baseDePrueba(), HEVY_API_KEY: "k" } as unknown as Env;
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "prueba", version: "1" });
    await Promise.all([buildServer(env).connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(11);
    const programar = tools.find((t) => t.name === "programar_entrenos")!;
    expect(Object.keys(programar.inputSchema.properties!)).toEqual(expect.arrayContaining(["modificar", "borrar", "plan_id", "confirmar"]));
    const r: any = await client.callTool({ name: "estado", arguments: { objetivo: "objetivo A", version_base: 0, origen: "chat 1" } });
    expect(JSON.parse(r.content[0].text)).toMatchObject({ version: 1, objetivo: "objetivo A", origen: "chat 1" });
  });
});

/** Lo que Claude ve al conectarse: instrucciones y herramientas. No toca la base de datos. */
async function conectar(env: Partial<Env>) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "prueba", version: "1" });
  await Promise.all([buildServer({ DB: {}, ...env } as unknown as Env).connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  const desc = (n: string) => tools.find((t) => t.name === n)?.description ?? "";
  return { instrucciones: client.getInstructions() ?? "", nombres: tools.map((t) => t.name), desc };
}

describe("Hevy opcional y feel según el reloj, tal como lo ve Claude", () => {
  it("sin HEVY_API_KEY no se anuncian las rutinas", async () => {
    const c = await conectar({});
    expect(c.nombres).toHaveLength(10);
    expect(c.nombres).not.toContain("programar_rutinas");
    expect(c.instrucciones).not.toMatch(/Hevy|programar_rutinas|v_rutinas/i);
    expect(c.desc("consulta_sql")).not.toMatch(/v_rutinas|programar_rutinas/);
  });
  it("con HEVY_API_KEY se anuncian", async () => {
    const c = await conectar({ HEVY_API_KEY: "k" });
    expect(c.nombres).toHaveLength(11);
    expect(c.nombres).toContain("programar_rutinas");
    expect(c.instrucciones).toMatch(/programar_rutinas/);
    expect(c.desc("consulta_sql")).toMatch(/v_rutinas_copias/);
  });
  it("sin HEVY_API_KEY no se describe el gimnasio de Hevy en ninguna herramienta", async () => {
    const sin = await conectar({});
    const con = await conectar({ HEVY_API_KEY: "k" });
    expect(sin.desc("consulta_sql")).not.toMatch(/v_gym/);
    expect(sin.desc("historial")).not.toMatch(/gimnasio/);
    expect(sin.desc("progreso")).not.toMatch(/ejercicio|1RM/);
    expect(sin.desc("estado_atleta")).not.toMatch(/gimnasio/);
    expect(con.desc("consulta_sql")).toMatch(/v_gym\(/);
    expect(con.desc("historial")).toMatch(/gimnasio \(sesiones/);
    expect(con.desc("progreso")).toMatch(/1RM estimado/);
    expect(con.desc("estado_atleta")).toMatch(/gimnasio de las últimas 72 h/);
  });
  it("sin HEVY_API_KEY consulta_sql rechaza las vistas de Hevy y no las nombra", () => {
    for (const v of ["v_gym", "v_rutinas", "v_rutinas_copias"]) {
      const r = prepararSql(`SELECT * FROM ${v}`, vistasDe({}));
      expect(r, v).toHaveProperty("error");
      // La lista de vistas del mensaje (antes de "en lugar de", que repite lo pedido)
      expect((r as { error: string }).error.split(" en lugar de ")[0]).not.toMatch(/v_gym|v_rutinas/);
      expect(prepararSql(`SELECT * FROM ${v}`, vistasDe({ HEVY_API_KEY: "k" })), v).not.toHaveProperty("error");
    }
    expect(prepararSql("SELECT * FROM v_activities", vistasDe({}))).not.toHaveProperty("error");
  });
  it("las instrucciones no nombran ninguna marca de reloj", async () => {
    expect((await conectar({ WATCH: "suunto" })).instrucciones).not.toMatch(/suunto/i);
  });
  it("la conversión del feel solo se explica con WATCH=suunto", async () => {
    const suunto = await conectar({ WATCH: "suunto" });
    const otro = await conectar({ WATCH: "garmin" });
    for (const n of ["revisar_actividad", "consulta_sql"]) {
      expect(suunto.desc(n)).toContain("6 − feel");
      expect(otro.desc(n)).not.toContain("6 − feel");
      expect(otro.desc(n)).toMatch(/1 = muy bien/);
    }
  });
});
