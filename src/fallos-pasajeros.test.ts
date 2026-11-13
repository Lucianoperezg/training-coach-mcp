/**
 * Fallos pasajeros de la sincronización: un error momentáneo no debe dejar datos mal para siempre sin avisar.
 * Con SQLite de verdad y todas las migraciones, e intervals y Hevy simulados: nunca tocan datos reales.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntervalsClient } from "./clients";
import type { Env } from "./env";
import { obtenerSplits } from "./splits";
import { runSync } from "./sync";

const nodeImport = (m: string): Promise<any> => import(/* @vite-ignore */ m);
const sqlite = await nodeImport("node:sqlite").catch(() => null);
const fs = await nodeImport("node:fs");

const HORA = 3_600_000;
const AHORA = Date.parse("2026-11-07T12:00:00Z");
const SINCE = "2026-11-01T00:00:00Z";

/** Cuenta cada consulta y cada batch como una subpetición, igual que Cloudflare. */
function baseDePrueba() {
  const db = new sqlite.DatabaseSync(":memory:");
  for (const f of (fs.readdirSync("migrations") as string[]).sort()) db.exec(fs.readFileSync(`migrations/${f}`, "utf8"));
  const cuenta = { d1: 0 };
  const stmt = (sql: string, params: unknown[] = []): any => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => { cuenta.d1++; return { results: db.prepare(sql).all(...params) }; },
    first: async () => { cuenta.d1++; return db.prepare(sql).get(...params) ?? null; },
    run: async () => { cuenta.d1++; db.prepare(sql).run(...params); return { meta: {} }; },
    ejecutar: () => db.prepare(sql).run(...params),
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (ss: any[]) => { cuenta.d1++; for (const s of ss) s.ejecutar(); },
    cuenta,
  } as unknown as D1Database & { cuenta: { d1: number } };
}

const STREAMS_BUENOS = [
  { type: "time", data: Array.from({ length: 1000 }, (_, i) => i) },
  { type: "distance", data: Array.from({ length: 1000 }, (_, i) => i * 3) },
  { type: "heartrate", data: Array.from({ length: 1000 }, () => 150) },
];
const hevyVacio = (r: string) => (r === "/workouts" ? { page: 1, page_count: 1, workouts: [] } : { page: 1, page_count: 1, events: [] });
const entreno = {
  id: "w1", title: "Pierna", start_time: "2026-11-07T10:00:00Z", end_time: "2026-11-07T11:00:00Z", updated_at: "2026-11-07T11:00:00Z",
  exercises: [{ index: 0, title: "Sentadilla", exercise_template_id: "SENTADILLA", sets: [{ index: 0, type: "normal", weight_kg: 80, reps: 5 }] }],
};

describe.skipIf(!sqlite)("fallos pasajeros", () => {
  let env: Env & { DB: D1Database & { cuenta: { d1: number } } };
  let llamadas: string[];
  let intervals: (ruta: string) => Response | null;
  let hevy: (ruta: string) => Response | null;

  const de = (trozo: string) => llamadas.filter((l) => l.includes(trozo)).length;
  const estado = async (clave: string) => ((await env.DB.prepare("SELECT value FROM sync_state WHERE key=?").bind(clave).first<any>())?.value ?? null);
  const fila = (id: string) => env.DB.prepare("SELECT * FROM activities WHERE id=?").bind(id).first<any>();
  const ponerEstado = (clave: string, valor: string) => env.DB.prepare("INSERT OR REPLACE INTO sync_state(key,value) VALUES(?,?)").bind(clave, valor).run();
  const carrera = (id: string, fecha = "2026-11-06", estadoSplits: string | null = null) => env.DB.prepare(
    "INSERT INTO activities (id, sport, start_local, distance_m, avg_hr, splits_estado, raw, synced_at) VALUES (?, 'Run', ?, 3000, 160, ?, '{}', 'x')",
  ).bind(id, `${fecha}T10:00:00`, estadoSplits).run();
  const serie = (template: string, workout = "w0", set = 0) => env.DB.prepare(
    "INSERT INTO gym_sets (workout_id, exercise_index, set_index, exercise, template_id) VALUES (?, 0, ?, 'x', ?)",
  ).bind(workout, set, template).run();
  const avanzar = (horas: number) => vi.setSystemTime(Date.now() + horas * HORA);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(AHORA);
    env = {
      TZ: "Europe/Madrid", DB: baseDePrueba(), INTERVALS_API_KEY: "k", INTERVALS_BASE_URL: "http://intervals.prueba/api/v1",
      HEVY_API_KEY: "k", HEVY_BASE_URL: "http://hevy.prueba/v1",
    } as any;
    llamadas = []; intervals = () => null; hevy = () => null;
    vi.stubGlobal("fetch", async (entrada: string) => {
      const url = new URL(entrada);
      const ruta = url.pathname.replace("/api/v1", "").replace("/v1", "");
      llamadas.push(`${url.host}${ruta}`);
      if (url.host === "intervals.prueba") {
        const f = intervals(ruta);
        if (f) return f;
        return Response.json(ruta.endsWith("/streams") ? STREAMS_BUENOS : []);
      }
      const f = hevy(ruta);
      if (f) return f;
      if (ruta === "/routines") return Response.json({ page: 1, page_count: 1, routines: [] });
      if (ruta === "/routine_folders") return Response.json({ page: 1, page_count: 1, routine_folders: [] });
      if (ruta === "/workouts" || ruta === "/workouts/events") return Response.json(hevyVacio(ruta));
      const t = ruta.match(/^\/exercise_templates\/(.+)$/);
      if (t) return Response.json({ id: t[1], title: t[1], primary_muscle_group: "quadriceps" });
      return new Response("no simulado", { status: 500 });
    });
    await ponerEstado("intervals_backfill_done", "1");
    await ponerEstado("hevy_since", SINCE);
    env.DB.cuenta.d1 = 0;
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  // --- 1. parciales y FC ---------------------------------------------------------
  describe("parciales y FC sin pausas", () => {
    const streamsCaidos = (status = 500) => { intervals = (r) => (r.endsWith("/streams") ? new Response("caído", { status }) : null); };

    it("reproducción: un 500 pasajero no la deja sin parciales y con FC con pausas para siempre", async () => {
      await carrera("a1");
      streamsCaidos();
      await runSync(env);
      intervals = () => null; // intervals se recupera
      avanzar(1);
      await runSync(env);
      const a = await fila("a1");
      expect(a.splits_estado).toBe("ok");
      expect(a.fc_marcha).toBe(150);
      expect(a.fc_media).toBe(150);
      expect(de("/streams")).toBe(2);
    });

    it("no reintenta antes de tiempo, y mientras tanto no bloquea a otra carrera más antigua", async () => {
      await carrera("reciente", "2026-11-06");
      await carrera("antigua", "2026-10-01");
      intervals = (r) => (r.includes("/reciente/") ? new Response("caído", { status: 503 }) : null);
      await runSync(env);
      expect(de("/activity/reciente/streams")).toBe(1);
      avanzar(0.25);
      await runSync(env);
      expect(de("/activity/reciente/streams")).toBe(1);
      expect(de("/activity/antigua/streams")).toBe(1);
      expect((await fila("antigua")).splits_estado).toBe("ok");
    });

    it("con un fallo persistente pide los streams 4 veces en total, espaciadas, y lo da por definitivo", async () => {
      await carrera("a1");
      streamsCaidos();
      await runSync(env); // intento 1
      expect((await fila("a1")).splits_estado).toMatch(/^reintento1:/);
      for (const horas of [1, 6, 24]) { avanzar(horas); await runSync(env); }
      expect(de("/streams")).toBe(4);
      expect((await fila("a1")).splits_estado).toBe("error");
      intervals = () => null;
      for (let i = 0; i < 5; i++) { avanzar(48); await runSync(env); }
      expect(de("/streams")).toBe(4);
    });

    it("las esperas son de 1, 6 y 24 horas", async () => {
      await carrera("a1");
      streamsCaidos();
      await runSync(env);
      for (const [horas, llevadas] of [[0.75, 1], [0.25, 2], [5.5, 2], [0.5, 3], [23.5, 3], [0.5, 4]] as const) {
        avanzar(horas);
        await runSync(env);
        expect(de("/streams")).toBe(llevadas);
      }
    });

    it.each([
      ["no existe (404)", () => new Response("no", { status: 404 })],
      ["llega sin datos", () => Response.json([])],
    ])("si intervals responde que %s es definitivo: una sola llamada", async (_n, respuesta) => {
      await carrera("a1");
      intervals = (r) => (r.endsWith("/streams") ? respuesta() : null);
      await runSync(env);
      expect((await fila("a1")).splits_estado).toBe("error");
      avanzar(48);
      await runSync(env);
      expect(de("/streams")).toBe(1);
    });

    it("una respuesta rara (no es una lista) es pasajera, también con límite", async () => {
      await carrera("a1");
      intervals = (r) => (r.endsWith("/streams") ? Response.json({ mensaje: "mantenimiento" }) : null);
      await runSync(env);
      expect((await fila("a1")).splits_estado).toMatch(/^reintento1:/);
    });

    it("no toca lo que ya estaba en error, ni lo que quedó en procesando porque la ejecución murió", async () => {
      await carrera("vieja", "2026-11-01", "error");
      await carrera("muerta", "2026-11-02", "procesando");
      await runSync(env);
      expect(de("/streams")).toBe(0);
      expect((await fila("vieja")).splits_estado).toBe("error");
      expect((await fila("muerta")).splits_estado).toBe("procesando");
    });

    it("si intervals está caído en esta ejecución no gasta intentos", async () => {
      await carrera("a1");
      intervals = () => new Response("caído", { status: 500 });
      for (let i = 0; i < 10; i++) { const r: any = await runSync(env); expect(r.intervals.error).toMatch(/500/); avanzar(24); }
      expect(de("/streams")).toBe(0);
      expect((await fila("a1")).splits_estado).toBeNull();
    });

    it("revisar_actividad: en espera sale como pendiente sin llamar; pasada la espera, lo recalcula", async () => {
      await carrera("a1");
      streamsCaidos();
      await runSync(env);
      expect(de("/streams")).toBe(1);
      intervals = () => null;
      const cliente = new IntervalsClient(env);
      const enEspera = await obtenerSplits(env, cliente, await fila("a1"));
      expect(enEspera).toEqual({ estado: "pendiente", splits: [], calculado: false });
      expect(de("/streams")).toBe(1);
      avanzar(1);
      const pasada = await obtenerSplits(env, cliente, await fila("a1"));
      expect(pasada.estado).toBe("ok");
      expect(pasada.calculado).toBe(true);
      expect(pasada.splits.length).toBeGreaterThan(0);
    });

    it("revisar_actividad: si el recálculo vuelve a fallar también dice pendiente, sin mostrar el estado interno", async () => {
      await carrera("a1");
      streamsCaidos();
      const r = await obtenerSplits(env, new IntervalsClient(env), await fila("a1"));
      expect(r.estado).toBe("pendiente");
      expect((await fila("a1")).splits_estado).toMatch(/^reintento1:/);
    });
  });

  // --- 2. tramos de Hevy ---------------------------------------------------------
  describe("tramos de Hevy", () => {
    const eventos = (r: () => Response) => { hevy = (ruta) => (ruta === "/workouts/events" ? r() : null); };

    it("reproducción: un 404 no da el tramo por leído y el entreno se recoge después", async () => {
      eventos(() => new Response("no", { status: 404 }));
      const r: any = await runSync(env);
      expect(await estado("hevy_since")).toBe(SINCE);
      expect(r.hevy.error).toBeTruthy(); // se avisa
      expect(await estado("fallos_hevy")).toBe("1");
      eventos(() => Response.json({ page: 1, page_count: 1, events: [{ type: "updated", workout: entreno }] }));
      const r2: any = await runSync(env);
      expect(r2.hevy).toMatchObject({ actualizados: 1, completo: true });
      expect(await estado("hevy_since")).not.toBe(SINCE);
      expect(await estado("fallos_hevy")).toBe("0");
    });

    it.each([
      ["sin lista de eventos", () => Response.json({ mensaje: "mantenimiento" })],
      ["una lista en vez de un objeto", () => Response.json([])],
      ["sin page_count", () => Response.json({ events: [] })],
      ["sin cuerpo útil", () => Response.json(null)],
    ])("%s: no avanza, no repite la petición y lo avisa", async (_n, respuesta) => {
      eventos(respuesta);
      const r: any = await runSync(env);
      expect(await estado("hevy_since")).toBe(SINCE);
      expect(de("/workouts/events")).toBe(1);
      expect(r.hevy.error).toBeTruthy();
    });

    it("una lista válida vacía sí avanza", async () => {
      const r: any = await runSync(env);
      expect(r.hevy).toMatchObject({ completo: true });
      expect(await estado("hevy_since")).not.toBe(SINCE);
    });

    it("una página mala tras otra buena: guarda la buena y no avanza", async () => {
      let n = 0;
      eventos(() => (++n === 1
        ? Response.json({ page: 1, page_count: 2, events: [{ type: "updated", workout: entreno }] })
        : new Response("no", { status: 404 })));
      const r: any = await runSync(env);
      expect(r.hevy.error).toBeTruthy();
      expect(await estado("hevy_since")).toBe(SINCE);
      expect((await env.DB.prepare("SELECT count(*) AS n FROM gym_workouts").first<any>()).n).toBe(1);
    });

    describe("importación inicial", () => {
      beforeEach(async () => { await env.DB.prepare("DELETE FROM sync_state WHERE key='hevy_since'").run(); });
      const paginas = (r: () => Response) => { hevy = (ruta) => (ruta === "/workouts" ? r() : null); };

      it("reproducción: un 404 no la da por terminada ni salta páginas", async () => {
        await ponerEstado("hevy_page", "3");
        paginas(() => new Response("no", { status: 404 }));
        const r: any = await runSync(env);
        expect(r.hevy.error).toBeTruthy();
        expect(await estado("hevy_since")).toBeNull();
        expect(await estado("hevy_page")).toBe("3");
        expect(de("/workouts")).toBe(1);
      });

      it("sin page_count tampoco avanza", async () => {
        paginas(() => Response.json({ workouts: [entreno] }));
        await runSync(env);
        expect(await estado("hevy_since")).toBeNull();
        expect(await estado("hevy_page")).toBeNull();
      });

      it("una cuenta sin entrenos sí termina", async () => {
        paginas(() => Response.json({ page: 1, page_count: 0, workouts: [] }));
        const r: any = await runSync(env);
        expect(r.hevy.modo).toBe("histórico completado");
        expect(await estado("hevy_since")).not.toBeNull();
      });
    });
  });

  // --- 3. ejercicios -------------------------------------------------------------
  describe("ejercicios sin músculo", () => {
    const plantilla = (id: string) => env.DB.prepare("SELECT * FROM exercise_templates WHERE id=?").bind(id).first<any>();
    const fallaPlantilla = (f: (id: string) => Response | null) => {
      hevy = (ruta) => { const t = ruta.match(/^\/exercise_templates\/(.+)$/); return t ? f(t[1]) : null; };
    };

    it("reproducción: un 500 pasajero no guarda la sentadilla vacía y se vuelve a pedir", async () => {
      await serie("SENTADILLA");
      fallaPlantilla(() => new Response("caído", { status: 500 }));
      const r: any = await runSync(env);
      expect(r.plantillas).toMatchObject({ nuevas: 0, fallos: 1 });
      expect(await plantilla("SENTADILLA")).toBeNull();
      hevy = () => null;
      await runSync(env);
      expect(await plantilla("SENTADILLA")).toMatchObject({ title: "SENTADILLA", primary_muscle: "quadriceps" });
      expect(de("/exercise_templates/")).toBe(2);
    });

    it("un 404 confirma que no existe: se guarda vacía y no se vuelve a pedir", async () => {
      await serie("BORRADA");
      fallaPlantilla(() => new Response("no", { status: 404 }));
      const r: any = await runSync(env);
      expect(r.plantillas).toMatchObject({ nuevas: 1, fallos: 0 });
      expect(await plantilla("BORRADA")).toMatchObject({ title: null, primary_muscle: null });
      await runSync(env);
      expect(de("/exercise_templates/")).toBe(1);
    });

    it("una respuesta sin título no confirma nada: no se guarda", async () => {
      await serie("RARA");
      fallaPlantilla(() => Response.json({ mensaje: "mantenimiento" }));
      await runSync(env);
      expect(await plantilla("RARA")).toBeNull();
    });

    it("lee la respuesta envuelta en exercise_template", async () => {
      await serie("ENVUELTA");
      fallaPlantilla((id) => Response.json({ exercise_template: { id, title: "Prensa", primary_muscle_group: "quadriceps" } }));
      await runSync(env);
      expect(await plantilla("ENVUELTA")).toMatchObject({ title: "Prensa", primary_muscle: "quadriceps" });
    });

    it("tras un fallo deja de pedir más en esa ejecución, sin perder las ya leídas", async () => {
      for (let i = 0; i < 3; i++) await serie(`T${i}`, "w0", i);
      let n = 0;
      fallaPlantilla((id) => (++n === 2 ? new Response("caído", { status: 500 }) : Response.json({ id, title: id })));
      const r: any = await runSync(env);
      expect(r.plantillas).toMatchObject({ nuevas: 1, fallos: 1 });
      expect(de("/exercise_templates/")).toBe(2);
    });

    it("una plantilla que falla siempre no impide leer las demás", async () => {
      await serie("MALA");
      for (let i = 0; i < 6; i++) await serie(`T${i}`, "w0", i + 1);
      fallaPlantilla((id) => (id === "MALA" ? new Response("caído", { status: 500 }) : Response.json({ id, title: id })));
      for (let i = 0; i < 60; i++) await runSync(env);
      const { n } = (await env.DB.prepare("SELECT count(*) AS n FROM exercise_templates").first<any>())!;
      expect(n).toBe(6);
      expect(await plantilla("MALA")).toBeNull();
    });
  });

  // --- presupuesto ---------------------------------------------------------------
  describe("presupuesto de subpeticiones", () => {
    /** Subpeticiones de una ejecución del cron. */
    const gasto = async () => {
      llamadas.length = 0; env.DB.cuenta.d1 = 0;
      await runSync(env);
      return llamadas.length + env.DB.cuenta.d1;
    };
    const cargar = async () => {
      for (let i = 0; i < 3; i++) await carrera(`a${i}`, `2026-11-0${i + 1}`);
      for (let i = 0; i < 6; i++) await serie(`T${i}`, "w0", i);
    };

    it("con un fallo persistente de los streams y de las plantillas no pasa de 46 y Hevy sigue leyendo", async () => {
      await cargar();
      intervals = (r) => (r.endsWith("/streams") ? new Response("caído", { status: 500 }) : null);
      hevy = (ruta) => (ruta.startsWith("/exercise_templates") ? new Response("caído", { status: 500 }) : null);
      for (let i = 0; i < 12; i++) {
        expect(await gasto()).toBeLessThanOrEqual(46);
        avanzar(1);
      }
      expect(await estado("hevy_since")).not.toBe(SINCE);
      expect(await estado("fallos_hevy")).toBe("0");
    });

    it("con todo caído no pasa de 46 y el cron termina y lo apunta", async () => {
      await cargar();
      intervals = () => new Response("caído", { status: 500 });
      hevy = () => new Response("caído", { status: 500 });
      expect(await gasto()).toBeLessThanOrEqual(46);
      expect(await estado("fallos_intervals")).toBe("1");
      expect(await estado("fallos_hevy")).toBe("1");
      expect(await estado("last_sync")).toBeTruthy();
    });

    it("con muchas páginas de cambios en Hevy y fallos a la vez, tampoco pasa de 46", async () => {
      await cargar();
      intervals = (r) => (r.endsWith("/streams") ? new Response("caído", { status: 500 }) : null);
      hevy = (ruta) => {
        if (ruta === "/workouts/events") return Response.json({ page: 1, page_count: 99, events: [] });
        return ruta.startsWith("/exercise_templates") ? new Response("caído", { status: 500 }) : null;
      };
      expect(await gasto()).toBeLessThanOrEqual(46);
    });
  });
});
