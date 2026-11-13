/**
 * Tests de las rutinas de Hevy: sincronización, vista previa, conservación de campos, cambios entre vista previa y
 * confirmación, API caída y restauración. Con SQLite de verdad y todas las migraciones, y Hevy simulado: nunca tocan datos reales.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Budget } from "./clients";
import type { Env } from "./env";
import { programarEntrenos } from "./plan";
import { camposNoEnviables, cuerpoDesde, programarRutinas } from "./rutinas";
import { runSync, syncRutinas } from "./sync";
import { buildServer, prepararSql } from "./tools";

const nodeImport = (m: string): Promise<any> => import(/* @vite-ignore */ m);
const sqlite = await nodeImport("node:sqlite").catch(() => null);
const fs = await nodeImport("node:fs");

function baseDePrueba() {
  const db = new sqlite.DatabaseSync(":memory:");
  for (const f of (fs.readdirSync("migrations") as string[]).sort()) db.exec(fs.readFileSync(`migrations/${f}`, "utf8"));
  let romperCopias = false;
  const stmt = (sql: string, params: unknown[] = []): any => ({
    bind: (...p: unknown[]) => stmt(sql, p),
    all: async () => ({ results: db.prepare(sql).all(...params) }),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => {
      if (romperCopias && sql.includes("INSERT INTO rutina_copias")) throw new Error("D1 caída");
      const r = db.prepare(sql).run(...params);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });
  return {
    prepare: (sql: string) => stmt(sql),
    batch: async (ss: any[]) => { for (const s of ss) await s.run(); },
    romperCopias: (v: boolean) => { romperCopias = v; },
  } as unknown as D1Database & { romperCopias: (v: boolean) => void };
}

const BASE = "http://hevy.prueba/v1";
const P1 = "PLANTILLA1", P2 = "PLANTILLA2", NUEVA = "PLANTILLA3";

/** Una rutina como la devuelve Hevy, con todo lo que hay que conservar. */
function rutinaEjemplo(): any {
  return {
    id: "r1", title: "Upper A", folder_id: 42, notes: "Notas de la rutina", updated_at: "2026-11-01T10:00:00Z", created_at: "2026-01-01T10:00:00Z",
    exercises: [
      {
        index: 0, title: "Press banca", exercise_template_id: P1, rest_seconds: 120, notes: "Controlado", superset_id: null,
        sets: [
          { index: 0, type: "warmup", weight_kg: 40, reps: 10, rep_range: null, distance_meters: null, duration_seconds: null, custom_metric: null },
          { index: 1, type: "normal", weight_kg: 60, reps: null, rep_range: { start: 8, end: 10 }, distance_meters: null, duration_seconds: null, custom_metric: null },
          { index: 2, type: "failure", weight_kg: 60, reps: 8, rep_range: null, distance_meters: null, duration_seconds: null, custom_metric: null },
        ],
      },
      {
        index: 1, title: "Remo", exercise_template_id: P2, rest_seconds: 90, notes: null, superset_id: 3,
        sets: [{ index: 0, type: "dropset", weight_kg: 50, reps: 12, rep_range: null, distance_meters: 200, duration_seconds: 30, custom_metric: 5 }],
      },
    ],
  };
}

/** Hevy simulado: guarda las rutinas, las carpetas, las plantillas y cada petición de escritura. */
function hevySimulado() {
  const rutinas = new Map<string, any>([["r1", rutinaEjemplo()]]);
  const carpetas: any[] = [{ id: 42, index: 0, title: "Fuerza" }];
  const plantillas = new Map<string, any>([[P1, { id: P1, title: "Press banca" }], [P2, { id: P2, title: "Remo" }], [NUEVA, { id: NUEVA, title: "Curl" }]]);
  const escrituras: { metodo: string; ruta: string; cuerpo: any }[] = [];
  const lecturas: string[] = [];
  let fallo: ((metodo: string, ruta: string) => Response | null) | null = null;
  let siguiente = 100;

  const fetchFalso = async (entrada: string, init?: RequestInit) => {
    const url = new URL(entrada), metodo = init?.method ?? "GET", ruta = url.pathname.replace("/v1", "");
    const cuerpo = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (metodo === "GET") lecturas.push(ruta); else escrituras.push({ metodo, ruta, cuerpo });
    const f = fallo?.(metodo, ruta);
    if (f) return f;
    if (ruta === "/routines" && metodo === "GET") {
      const lista = [...rutinas.values()], page = Number(url.searchParams.get("page") ?? 1);
      return Response.json({ page, page_count: Math.max(1, Math.ceil(lista.length / 10)), routines: lista.slice((page - 1) * 10, page * 10) });
    }
    if (ruta === "/routines" && metodo === "POST") {
      const id = `nueva${siguiente++}`;
      const r = { id, ...cuerpo.routine, updated_at: "2026-11-07T10:00:00Z", created_at: "2026-11-07T10:00:00Z" };
      r.exercises = r.exercises.map((e: any, i: number) => ({ ...e, index: i, title: plantillas.get(e.exercise_template_id)?.title, sets: e.sets.map((s: any, j: number) => ({ ...s, index: j })) }));
      rutinas.set(id, r);
      return Response.json({ routine: r }, { status: 201 });
    }
    const m = ruta.match(/^\/routines\/(.+)$/);
    if (m) {
      const actual = rutinas.get(m[1]);
      if (!actual) return new Response("no existe", { status: 404 });
      if (metodo === "PUT") {
        const r = {
          ...cuerpo.routine, id: m[1], created_at: actual.created_at, updated_at: "2026-11-07T11:00:00Z",
          exercises: cuerpo.routine.exercises.map((e: any, i: number) => ({
            ...e, index: i, title: plantillas.get(e.exercise_template_id)?.title, sets: e.sets.map((s: any, j: number) => ({ ...s, index: j })),
          })),
        };
        rutinas.set(m[1], r);
        return Response.json({ routine: r });
      }
      return Response.json({ routine: actual });
    }
    if (ruta === "/routine_folders") return Response.json({ page: 1, page_count: 1, routine_folders: carpetas });
    const c = ruta.match(/^\/routine_folders\/(\d+)$/);
    if (c) {
      const f = carpetas.find((x) => x.id === Number(c[1]));
      return f ? Response.json(f) : new Response("no existe", { status: 404 });
    }
    const t = ruta.match(/^\/exercise_templates\/(.+)$/);
    if (t) return plantillas.has(t[1]) ? Response.json(plantillas.get(t[1])) : new Response("no existe", { status: 404 });
    if (ruta === "/workouts") return Response.json({ page: 1, page_count: 1, workouts: [] });
    if (ruta === "/workouts/events") return Response.json({ page: 1, page_count: 1, events: [] });
    return new Response("no simulado", { status: 500 });
  };
  return { rutinas, carpetas, plantillas, escrituras, lecturas, fetchFalso, fallar: (f: typeof fallo) => { fallo = f; } };
}

const series = (env: Env, sql: string, ...p: unknown[]) => env.DB.prepare(sql).bind(...p).all<any>().then((r) => r.results);

describe.skipIf(!sqlite)("rutinas de Hevy", () => {
  let env: Env & { DB: D1Database & { romperCopias: (v: boolean) => void } };
  let hevy: ReturnType<typeof hevySimulado>;
  beforeEach(() => {
    env = { TZ: "Europe/Madrid", DB: baseDePrueba(), HEVY_API_KEY: "k", HEVY_BASE_URL: BASE } as any;
    hevy = hevySimulado();
    vi.stubGlobal("fetch", hevy.fetchFalso);
  });
  afterEach(() => vi.unstubAllGlobals());

  const sincronizar = () => syncRutinas(env, new Budget(6));
  const preparar = async (args: any) => {
    const r: any = await programarRutinas(env, args);
    expect(r.error).toBeUndefined();
    return r;
  };
  const subirPeso = { modificar: [{ routine_id: "r1", ejercicios: [{ indice: 0, series_cambios: [{ indice: 1, weight_kg: 62.5 }] }] }] };

  // --- lectura -------------------------------------------------------------------
  describe("sincronización", () => {
    it("guarda las rutinas y v_rutinas da una fila por serie con todo lo pedido", async () => {
      const r: any = await sincronizar();
      expect(r).toMatchObject({ rutinas: 1, completa: true, carpetas: 1 });
      const filas = await series(env, "SELECT * FROM v_rutinas ORDER BY exercise_index, set_index");
      expect(filas).toHaveLength(4);
      expect(filas[1]).toMatchObject({
        routine_id: "r1", rutina: "Upper A", carpeta: "Fuerza", folder_id: 42, notas_rutina: "Notas de la rutina", exercise_index: 0, exercise: "Press banca",
        template_id: P1, rest_s: 120, exercise_notes: "Controlado", set_index: 1, set_type: "normal", weight_kg: 60, rep_min: 8, rep_max: 10,
      });
      expect(filas[3]).toMatchObject({ exercise: "Remo", superset_id: 3, duration_s: 30, distance_m: 200, custom_metric: 5 });
    });

    it("un ejercicio sin series sale igualmente en la vista", async () => {
      hevy.rutinas.get("r1").exercises[1].sets = [];
      await sincronizar();
      const filas = await series(env, "SELECT exercise, set_index FROM v_rutinas WHERE exercise = 'Remo'");
      expect(filas).toEqual([{ exercise: "Remo", set_index: null }]);
    });

    it("una rutina borrada en Hevy deja de ser vigente, y vuelve si reaparece", async () => {
      const otra = { ...rutinaEjemplo(), id: "r2", title: "Lower A" };
      hevy.rutinas.set("r2", otra);
      await sincronizar();
      hevy.rutinas.delete("r2");
      await sincronizar();
      expect(await series(env, "SELECT DISTINCT rutina FROM v_rutinas")).toEqual([{ rutina: "Upper A" }]);
      const [marcada] = await series(env, "SELECT borrada_en FROM rutinas WHERE id = 'r2'");
      expect(marcada.borrada_en).toBeTruthy();
      hevy.rutinas.set("r2", otra);
      await sincronizar();
      expect(await series(env, "SELECT DISTINCT rutina FROM v_rutinas ORDER BY rutina")).toHaveLength(2);
    });

    it.each([
      ["un 500", () => new Response("caída", { status: 500 })],
      ["un 404", () => new Response("no", { status: 404 })],
      ["un cuerpo sin lista", () => Response.json({ mensaje: "mantenimiento" })],
      ["una lista con una rutina rara", () => Response.json({ page: 1, page_count: 1, routines: [{ id: "r1", title: "x" }] })],
      ["una lista vacía", () => Response.json({ page: 1, page_count: 1, routines: [] })],
      ["una lista sin page_count", () => Response.json({ routines: [] })],
    ])("%s no borra ni pisa nada", async (_n, respuesta) => {
      await sincronizar();
      hevy.fallar((m, r) => (m === "GET" && r === "/routines" ? respuesta() : null));
      await sincronizar().catch(() => {}); // un 500 lanza error: runSync lo recoge
      expect(await series(env, "SELECT DISTINCT rutina FROM v_rutinas")).toEqual([{ rutina: "Upper A" }]);
    });

    it("una lista incompleta (sin presupuesto para todas las páginas) no marca borradas", async () => {
      for (let i = 2; i <= 25; i++) hevy.rutinas.set(`r${i}`, { ...rutinaEjemplo(), id: `r${i}`, title: `R${i}` });
      await sincronizar();
      await env.DB.prepare("INSERT INTO rutinas (id, title, raw) VALUES ('vieja', 'Vieja', '{\"exercises\":[]}')").run();
      const r: any = await sincronizar();
      expect(r.completa).toBe(false);
      const [v] = await series(env, "SELECT borrada_en FROM rutinas WHERE id = 'vieja'");
      expect(v.borrada_en).toBeNull();
    });

    it("no pasa de las subpeticiones que tiene reservadas", async () => {
      for (let i = 2; i <= 25; i++) hevy.rutinas.set(`r${i}`, { ...rutinaEjemplo(), id: `r${i}` });
      const presupuesto = new Budget(6);
      await syncRutinas(env, presupuesto);
      expect(hevy.lecturas.length + 1).toBeLessThanOrEqual(6); // lecturas + 1 batch
      expect(presupuesto.left).toBeGreaterThanOrEqual(0);
    });

    it("si fallan las carpetas, las rutinas se guardan igual", async () => {
      hevy.fallar((m, r) => (r === "/routine_folders" ? new Response("x", { status: 500 }) : null));
      const r: any = await sincronizar();
      expect(String(r.carpetas)).toMatch(/error/);
      expect(await series(env, "SELECT DISTINCT rutina, carpeta FROM v_rutinas")).toEqual([{ rutina: "Upper A", carpeta: null }]);
    });

    it("consulta_sql permite las vistas y no las tablas", () => {
      expect("error" in prepararSql("SELECT * FROM v_rutinas")).toBe(false);
      expect("error" in prepararSql("SELECT * FROM v_rutinas_copias")).toBe(false);
      for (const t of ["rutinas", "rutina_copias", "rutina_carpetas", "planes_rutinas"]) {
        expect("error" in prepararSql(`SELECT raw FROM ${t}`)).toBe(true);
      }
    });
  });

  // --- cuerpo que se manda ---------------------------------------------------------
  describe("lo que se envía a Hevy", () => {
    it("conserva todo lo que la API acepta y quita lo que solo existe en la respuesta", () => {
      expect(cuerpoDesde(rutinaEjemplo())).toEqual({
        title: "Upper A", folder_id: 42, notes: "Notas de la rutina",
        exercises: [
          {
            exercise_template_id: P1, superset_id: null, rest_seconds: 120, notes: "Controlado",
            sets: [
              { type: "warmup", weight_kg: 40, reps: 10, distance_meters: null, duration_seconds: null, custom_metric: null, rep_range: null },
              { type: "normal", weight_kg: 60, reps: null, distance_meters: null, duration_seconds: null, custom_metric: null, rep_range: { start: 8, end: 10 } },
              { type: "failure", weight_kg: 60, reps: 8, distance_meters: null, duration_seconds: null, custom_metric: null, rep_range: null },
            ],
          },
          {
            exercise_template_id: P2, superset_id: 3, rest_seconds: 90, notes: null,
            sets: [{ type: "dropset", weight_kg: 50, reps: 12, distance_meters: 200, duration_seconds: 30, custom_metric: 5, rep_range: null }],
          },
        ],
      });
    });

    it("respeta el orden de index aunque la respuesta venga desordenada", () => {
      const r = rutinaEjemplo();
      r.exercises.reverse();
      expect(cuerpoDesde(r).exercises.map((e) => e.exercise_template_id)).toEqual([P1, P2]);
    });

    it("si Hevy no devuelve las notas generales no manda notes, para no vaciarlas", () => {
      const r = rutinaEjemplo();
      delete r.notes;
      expect("notes" in cuerpoDesde(r)).toBe(false);
    });

    it("detecta los campos desconocidos con valor", () => {
      const r = rutinaEjemplo();
      expect(camposNoEnviables(r)).toEqual([]);
      r.exercises[0].sets[0].rpe = 8;
      r.exercises[0].algo_nuevo = null; // sin valor no se pierde nada
      expect(camposNoEnviables(r)).toEqual(["serie.rpe"]);
    });
  });

  // --- vista previa ------------------------------------------------------------------
  describe("vista previa", () => {
    it("no escribe en Hevy ni guarda copias, y muestra antes, después y plan_id", async () => {
      const r = await preparar(subirPeso);
      expect(hevy.escrituras).toEqual([]);
      expect(await series(env, "SELECT * FROM rutina_copias")).toEqual([]);
      expect(r.plan_id).toBeTruthy();
      expect(r.caduca_en_h).toBe(24);
      expect(r.modificar[0].antes.ejercicios[0]).toContain("60 kg × 8-10 reps");
      expect(r.modificar[0].despues.ejercicios[0]).toContain("62.5 kg × 8-10 reps");
      expect(r.modificar[0].diferencias.join()).toContain("62.5 kg");
      expect(r.instruccion).toMatch(/NO está hecho/);
    });

    describe("todo lo que cambia se ve", () => {
      const cambiarSerie = (campos: any, indice = 1) => ({ modificar: [{ routine_id: "r1", ejercicios: [{ indice: 0, series_cambios: [{ indice, ...campos }] }] }] });
      const cambiarEjercicio = (campos: any) => ({ modificar: [{ routine_id: "r1", ejercicios: [{ indice: 1, ...campos }] }] });

      it("un cambio de reps en una serie con rango sale en antes, después y diferencias", async () => {
        const r = await preparar(cambiarSerie({ reps: 9 }));
        const m = r.modificar[0];
        expect(m.antes.ejercicios[0]).toContain("60 kg × 8-10 reps");
        expect(m.despues.ejercicios[0]).toContain("60 kg × 9 reps (rango 8-10)");
        expect(m.diferencias.join()).toContain("9 reps (rango 8-10)");
        // Y lo que se envía es justo eso
        await programarRutinas(env, { plan_id: r.plan_id, confirmar: true });
        expect(hevy.escrituras[0].cuerpo.routine.exercises[0].sets[1]).toMatchObject({ weight_kg: 60, reps: 9, rep_range: { start: 8, end: 10 } });
      });

      it.each<[string, any, RegExp]>([
        ["tipo", cambiarSerie({ type: "failure" }), /\+ #0 .*al fallo 60 kg × 8-10 reps/],
        ["tipo a normal", cambiarSerie({ type: "normal" }, 0), /\+ #0 Press banca \[PLANTILLA1\] \| 40 kg × 10 reps/],
        ["peso", cambiarSerie({ weight_kg: 62.5 }), /\+ #0 .*62\.5 kg × 8-10 reps/],
        ["peso a cero", cambiarSerie({ weight_kg: 0 }), /\+ #0 .*0 kg × 8-10 reps/],
        ["quitar el peso", cambiarSerie({ weight_kg: null }), /\+ #0 .*· 8-10 reps ·/],
        ["reps sin rango", cambiarSerie({ reps: 11 }, 0), /\+ #0 .*40 kg × 11 reps/],
        ["rango", cambiarSerie({ rep_range: { start: 6, end: 8 } }), /\+ #0 .*60 kg × 6-8 reps/],
        ["rango sin final", cambiarSerie({ rep_range: { start: 8 } }), /\+ #0 .*60 kg × desde 8 reps/],
        ["rango sin inicio", cambiarSerie({ rep_range: { end: 10 } }), /\+ #0 .*60 kg × hasta 10 reps/],
        ["rango sin final y reps", cambiarSerie({ reps: 9, rep_range: { start: 8 } }), /\+ #0 .*60 kg × 9 reps \(rango desde 8\)/],
        ["quitar el rango", cambiarSerie({ rep_range: null }), /\+ #0 .*· 60 kg · /],
        ["distancia", cambiarSerie({ distance_meters: 300 }), /\+ #0 .*300 m/],
        ["duración", cambiarSerie({ duration_seconds: 45 }), /\+ #0 .*45 s/],
        ["métrica", cambiarSerie({ custom_metric: 7 }), /\+ #0 .*métrica 7/],
        ["series nuevas", { modificar: [{ routine_id: "r1", ejercicios: [{ indice: 0, series: [{ reps: 5 }] }] }] }, /\+ #0 Press banca \[PLANTILLA1\] \| 5 reps \|/],
        ["descanso", cambiarEjercicio({ rest_seconds: 60 }), /\+ #1 .*descanso 60 s/],
        ["descanso a cero", cambiarEjercicio({ rest_seconds: 0 }), /\+ #1 .*descanso 0 s/],
        ["quitar el descanso", cambiarEjercicio({ rest_seconds: null }), /− #1 .*descanso 90 s/],
        ["notas del ejercicio", cambiarEjercicio({ notes: "Lento" }), /\+ #1 .*notas: Lento/],
        ["superserie", cambiarEjercicio({ superset_id: 4 }), /\+ #1 .*superserie 4/],
        ["superserie cero", cambiarEjercicio({ superset_id: 0 }), /\+ #1 .*superserie 0/],
        ["quitar la superserie", cambiarEjercicio({ superset_id: null }), /− #1 .*superserie 3/],
        ["otro ejercicio", cambiarEjercicio({ exercise_template_id: NUEVA }), /\+ #1 Curl \[PLANTILLA3\]/],
        ["orden", { modificar: [{ routine_id: "r1", orden: [1, 0] }] }, /cambia el orden de los ejercicios: Press banca, Remo → Remo, Press banca/],
        ["ejercicio quitado", { modificar: [{ routine_id: "r1", quitar_ejercicios: [0] }] }, /− #0 Press banca/],
        ["ejercicio añadido", { modificar: [{ routine_id: "r1", anadir_ejercicios: [{ exercise_template_id: NUEVA, posicion: 1, series: [{ reps: 10 }] }] }] }, /\+ #1 Curl \[PLANTILLA3\] \| 10 reps/],
        ["título", { modificar: [{ routine_id: "r1", title: "Upper B" }] }, /título: "Upper A" → "Upper B"/],
        ["notas generales", { modificar: [{ routine_id: "r1", notes: "Nuevas" }] }, /notas generales: "Notas de la rutina" → "Nuevas"/],
        ["vaciar las notas generales", { modificar: [{ routine_id: "r1", notes: null }] }, /notas generales: "Notas de la rutina" → \(vacías\)/],
      ])("%s", async (_n, args, esperado) => {
        const r = await preparar(args);
        expect(r.modificar[0].diferencias.join("\n")).toMatch(esperado);
      });

      it("un ejercicio movido y cambiado a la vez se ve con su posición nueva", async () => {
        const r = await preparar({ modificar: [{ routine_id: "r1", orden: [1, 0], ejercicios: [{ indice: 0, rest_seconds: 30 }, { indice: 1, rest_seconds: 30 }] }] });
        const d = r.modificar[0].diferencias.join("\n");
        expect(d).toMatch(/− #0 Press banca/);
        expect(d).toMatch(/\+ #1 Press banca/);
        expect(d).toMatch(/− #1 Remo/);
        expect(d).toMatch(/\+ #0 Remo/);
      });

      it("quitar uno de dos ejercicios iguales no se confunde con un cambio de orden", async () => {
        const a = hevy.rutinas.get("r1");
        a.exercises[1].index = 2;
        a.exercises.push({ ...structuredClone(a.exercises[0]), index: 1 });
        const r = await preparar({ modificar: [{ routine_id: "r1", quitar_ejercicios: [0] }] });
        expect(r.modificar[0].diferencias.join("\n")).not.toMatch(/orden/);
      });

      it("una serie con reps y rango enseña los dos también al crear", async () => {
        const r = await preparar({ crear: [{ title: "x", ejercicios: [{ exercise_template_id: P1, series: [{ reps: 9, rep_range: { start: 8, end: 10 } }] }] }] });
        expect(r.crear[0].ejercicios[0]).toContain("9 reps (rango 8-10)");
      });

      it("si Hevy no devuelve las notas generales y se envían otras, dice que no se sabe cuáles se sustituyen", async () => {
        delete hevy.rutinas.get("r1").notes;
        const nuevas = await preparar({ modificar: [{ routine_id: "r1", notes: "Nuevas" }] });
        expect(nuevas.modificar[0].diferencias.join()).toMatch(/notas generales: .*no se sabe.* → "Nuevas"/);
        const vacias = await preparar({ modificar: [{ routine_id: "r1", title: "Otra", notes: null }] });
        expect(vacias.modificar[0].diferencias.join()).toMatch(/notas generales: .*no se sabe.* → \(vacías\)/);
      });

      /** Aplica un cambio para tener una copia, y la retoca como si fuera antigua. */
      const copiaRetocada = async (retocar: (raw: any) => void) => {
        const { plan_id } = await preparar(subirPeso);
        await programarRutinas(env, { plan_id, confirmar: true });
        const [c] = await series(env, "SELECT copia_id, raw FROM rutina_copias");
        const raw = JSON.parse(c.raw);
        retocar(raw);
        await env.DB.prepare("UPDATE rutina_copias SET raw = ? WHERE copia_id = ?").bind(JSON.stringify(raw), c.copia_id).run();
        return c.copia_id as number;
      };

      it("restaurar una copia sin notas sobre una rutina con notas lo dice: no se envían", async () => {
        const copia = await copiaRetocada((raw) => {
          delete raw.notes;
          raw.exercises[0].sets[1].weight_kg = 62.5; // lo único distinto son las notas
        });
        const v = await preparar({ restaurar: [copia] });
        expect(v.restaurar[0].diferencias.join()).toMatch(/notas generales: "Notas de la rutina" → no se envían/);
      });

      it("un tipo de serie desconocido en una copia se enseña tal cual", async () => {
        const copia = await copiaRetocada((raw) => { raw.exercises[0].sets[1].type = "cluster"; });
        const v = await preparar({ restaurar: [copia] });
        expect(v.restaurar[0].despues.ejercicios[0]).toContain("cluster 60 kg × 8-10 reps");
      });

      it("red de seguridad: lo que se envía distinto y no tiene texto propio sale igualmente en diferencias", async () => {
        const r = await preparar(cambiarSerie({ rep_range: { start: 8, end: 10, raro: 1 } }));
        expect(r.modificar[0].diferencias.join()).toContain("exercises.0.sets.1.rep_range.raro");
        // También si cambia algo más que sí se describe
        const conTitulo = await preparar({ modificar: [{ ...cambiarSerie({ rep_range: { start: 8, end: 10, raro: 1 } }).modificar[0], title: "Upper B" }] });
        expect(conTitulo.modificar[0].diferencias.join()).toContain("Upper B");
        expect(conTitulo.modificar[0].diferencias.join()).toContain("exercises.0.sets.1.rep_range.raro");
      });
    });

    it("avisa si Hevy no devuelve las notas generales o trae campos que no se pueden enviar", async () => {
      const a = hevy.rutinas.get("r1");
      delete a.notes;
      a.exercises[0].sets[0].rpe = 8;
      const r = await preparar(subirPeso);
      expect(r.modificar[0].avisos.join()).toMatch(/notas generales/);
      expect(r.modificar[0].avisos.join()).toMatch(/serie\.rpe/);
    });

    it("avisa si la rutina ha cambiado desde la última sincronización, y la deja al día", async () => {
      await sincronizar();
      const sinAviso = await preparar(subirPeso);
      expect(sinAviso.modificar[0].avisos).toBeUndefined();
      expect(sinAviso.modificar[0].antes.ejercicios[0]).toMatch(/^#0 Press banca/);
      hevy.rutinas.get("r1").updated_at = "2026-11-07T09:00:00Z";
      const conAviso = await preparar(subirPeso);
      expect(conAviso.modificar[0].avisos.join()).toMatch(/desde la última sincronización/);
      const [g] = await series(env, "SELECT updated_at FROM rutinas WHERE id = 'r1'");
      expect(g.updated_at).toBe("2026-11-07T09:00:00Z");
    });

    it("rechaza un cambio vacío, una rutina que no existe, repetidas, índices malos y datos no válidos", async () => {
      const error = async (a: any) => ((await programarRutinas(env, a)) as any).error;
      expect(await error({})).toMatch(/nada que hacer/);
      expect(await error({ modificar: [{ routine_id: "r1" }] })).toMatch(/nada que cambiar/);
      expect(await error({ modificar: [{ routine_id: "r1", title: "Upper A" }] })).toMatch(/nada que cambiar/);
      expect(await error({ modificar: [{ routine_id: "nada", title: "x" }] })).toMatch(/No existe/);
      expect(await error({ modificar: [{ routine_id: "r1", title: "x" }, { routine_id: "r1", title: "y" }] })).toMatch(/dos veces/);
      expect(await error({ modificar: [{ routine_id: "r1", ejercicios: [{ indice: 9, rest_seconds: 1 }] }] })).toMatch(/no existe el ejercicio/);
      expect(await error({ modificar: [{ routine_id: "r1", ejercicios: [{ indice: 0, series_cambios: [{ indice: 9, reps: 1 }] }] }] })).toMatch(/no existe la serie/);
      expect(await error({ modificar: [{ routine_id: "r1", ejercicios: [{ indice: 0, series_cambios: [{ weight_kg: -1 }] }] }] })).toMatch(/weight_kg/);
      expect(await error({ modificar: [{ routine_id: "r1", quitar_ejercicios: [0, 1] }] })).toMatch(/al menos un ejercicio/);
      expect(await error({ modificar: [{ routine_id: "r1", orden: [0] }] })).toMatch(/orden/);
      expect(await error({ crear: [{ title: "", ejercicios: [] }] })).toMatch(/título/);
      expect(await error({ crear: [{ title: "x", ejercicios: [{ exercise_template_id: P1, series: [] }] }] })).toMatch(/al menos una serie/);
      expect(await error({ crear: [{ title: "x", folder_id: 7, ejercicios: [{ exercise_template_id: P1, series: [{}] }] }] })).toMatch(/carpeta/);
      expect(await error({ crear: Array(6).fill({ title: "x", ejercicios: [] }) })).toMatch(/Máximo/);
      expect(await error({ restaurar: [99] })).toMatch(/No existe la copia/);
      expect(hevy.escrituras).toEqual([]);
      expect(await series(env, "SELECT * FROM planes_rutinas")).toEqual([]);
    });

    it("sin plantilla existente no guarda plan; si no se puede comprobar, tampoco", async () => {
      const anadir = (id: string) => ({ modificar: [{ routine_id: "r1", anadir_ejercicios: [{ exercise_template_id: id, series: [{ reps: 10 }] }] }] });
      expect(((await programarRutinas(env, anadir("NOEXISTE"))) as any).error).toMatch(/no existe en Hevy/);
      // Una fila sin título (la sincronización las guarda así si Hevy no las devuelve) no demuestra que exista
      await env.DB.prepare("INSERT INTO exercise_templates (id) VALUES ('VACIA')").run();
      expect(((await programarRutinas(env, anadir("VACIA"))) as any).error).toMatch(/no existe en Hevy/);
      hevy.fallar((_m, r) => (r.startsWith("/exercise_templates") ? new Response("x", { status: 500 }) : null));
      expect(((await programarRutinas(env, anadir(NUEVA))) as any).error).toMatch(/No se ha podido comprobar/);
      expect(await series(env, "SELECT * FROM planes_rutinas")).toEqual([]);
    });

    it("una plantilla ya conocida no se vuelve a pedir, y las que ya están en la rutina no se piden", async () => {
      await env.DB.prepare("INSERT INTO exercise_templates (id, title) VALUES (?, 'Curl')").bind(NUEVA).run();
      await preparar({ modificar: [{ routine_id: "r1", anadir_ejercicios: [{ exercise_template_id: NUEVA, series: [{ reps: 10 }] }] }] });
      expect(hevy.lecturas.filter((r) => r.startsWith("/exercise_templates"))).toEqual([]);
    });

    it("con Hevy caído no guarda plan", async () => {
      hevy.fallar(() => new Response("x", { status: 503 }));
      expect(((await programarRutinas(env, subirPeso)) as any).error).toMatch(/No se ha podido leer/);
      expect(await series(env, "SELECT * FROM planes_rutinas")).toEqual([]);
    });
  });

  // --- aplicar ---------------------------------------------------------------------------
  describe("confirmar", () => {
    const confirmar = (plan_id: string) => programarRutinas(env, { plan_id, confirmar: true }) as Promise<any>;

    it("aplica exactamente lo mostrado, conservando el resto, con la copia guardada antes", async () => {
      const original = structuredClone(hevy.rutinas.get("r1"));
      const { plan_id } = await preparar(subirPeso);
      // Lo que se pase junto a la confirmación se ignora
      const r: any = await programarRutinas(env, { plan_id, confirmar: true, modificar: [{ routine_id: "r1", title: "Otro" }] });
      expect(r.estado).toBe("hecho");
      expect(hevy.escrituras).toHaveLength(1);
      const esperado = cuerpoDesde(original);
      esperado.exercises[0].sets[1].weight_kg = 62.5;
      expect(hevy.escrituras[0]).toEqual({ metodo: "PUT", ruta: "/routines/r1", cuerpo: { routine: esperado } });
      // La copia es la rutina completa de antes
      const copias = await series(env, "SELECT * FROM rutina_copias");
      expect(copias).toHaveLength(1);
      expect(JSON.parse(copias[0].raw)).toEqual(original);
      expect(copias[0]).toMatchObject({ routine_id: "r1", motivo: "modificar", plan_id });
      expect(r.resultado.filas[0]).toContain(copias[0].copia_id);
      // La lectura local queda al día sin esperar al cron
      const [fila] = await series(env, "SELECT weight_kg FROM v_rutinas WHERE exercise_index = 0 AND set_index = 1");
      expect(fila.weight_kg).toBe(62.5);
    });

    it("aplica los cambios de ejercicios: cambiar, quitar, añadir, ordenar y todas las series a la vez", async () => {
      const { plan_id } = await preparar({
        modificar: [{
          routine_id: "r1", title: "Upper B", notes: "Nuevas",
          ejercicios: [{ indice: 1, rest_seconds: 60, series_cambios: [{ weight_kg: 55 }] }],
          anadir_ejercicios: [{ exercise_template_id: NUEVA, posicion: 0, series: [{ weight_kg: 10, rep_range: { start: 10, end: 12 } }], rest_seconds: 45 }],
          orden: [1, 0],
        }],
      });
      await confirmar(plan_id);
      const b = hevy.escrituras[0].cuerpo.routine;
      expect(b).toMatchObject({ title: "Upper B", notes: "Nuevas", folder_id: 42 });
      expect(b.exercises.map((e: any) => e.exercise_template_id)).toEqual([NUEVA, P2, P1]);
      expect(b.exercises[0]).toMatchObject({ rest_seconds: 45, sets: [{ type: "normal", weight_kg: 10, rep_range: { start: 10, end: 12 } }] });
      // Remo: cambia lo pedido y conserva el tipo de serie, la superserie y el resto
      expect(b.exercises[1]).toMatchObject({ rest_seconds: 60, superset_id: 3, sets: [{ type: "dropset", weight_kg: 55, reps: 12, duration_seconds: 30 }] });
      expect(b.exercises[2].sets).toHaveLength(3);
    });

    it("si la rutina cambió después de la vista previa, no la pisa y da error", async () => {
      const { plan_id } = await preparar(subirPeso);
      const a = hevy.rutinas.get("r1");
      a.exercises[1].notes = "Cambiado en la app";
      a.updated_at = "2026-11-07T09:00:00Z";
      const r = await confirmar(plan_id);
      expect(r.estado).toBe("fallido");
      expect(r.resultado.filas[0].join()).toMatch(/ha cambiado en Hevy/);
      expect(hevy.escrituras).toEqual([]);
      expect(await series(env, "SELECT * FROM rutina_copias")).toEqual([]);
    });

    it("también detecta un cambio que solo se ve en updated_at", async () => {
      const { plan_id } = await preparar(subirPeso);
      hevy.rutinas.get("r1").updated_at = "2026-11-07T09:00:00Z";
      expect((await confirmar(plan_id)).estado).toBe("fallido");
      expect(hevy.escrituras).toEqual([]);
    });

    it("sin copia guardada no escribe", async () => {
      const { plan_id } = await preparar(subirPeso);
      env.DB.romperCopias(true);
      const r = await confirmar(plan_id);
      expect(r.resultado.filas[0].join()).toMatch(/no se ha podido guardar la copia/);
      expect(hevy.escrituras).toEqual([]);
    });

    it("con Hevy caído no se pierde nada, y al reintentar no se duplica la copia", async () => {
      await sincronizar();
      const original = structuredClone(hevy.rutinas.get("r1"));
      const { plan_id } = await preparar(subirPeso);
      hevy.fallar((m) => (m === "PUT" ? new Response("x", { status: 503 }) : null));
      const r = await confirmar(plan_id);
      expect(r.estado).toBe("fallido");
      expect(r.resultado.filas[0].join()).toMatch(/503/);
      expect(hevy.rutinas.get("r1")).toEqual(original);
      const [f] = await series(env, "SELECT weight_kg FROM v_rutinas WHERE exercise_index = 0 AND set_index = 1");
      expect(f.weight_kg).toBe(60);
      expect(await series(env, "SELECT * FROM rutina_copias")).toHaveLength(1);
      hevy.fallar(null);
      expect((await confirmar(plan_id)).estado).toBe("hecho");
      expect(await series(env, "SELECT * FROM rutina_copias")).toHaveLength(1);
      expect(hevy.rutinas.get("r1").exercises[0].sets[1].weight_kg).toBe(62.5);
    });

    it("con la lectura caída al confirmar no toca nada", async () => {
      const { plan_id } = await preparar(subirPeso);
      hevy.fallar((m) => (m === "GET" ? new Response("x", { status: 500 }) : null));
      expect((await confirmar(plan_id)).estado).toBe("fallido");
      expect(hevy.escrituras).toEqual([]);
    });

    it("si el PUT llegó pero la respuesta se perdió, al reintentar sale como ya aplicado", async () => {
      const { plan_id } = await preparar(subirPeso);
      const fetchReal = hevy.fetchFalso;
      vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
        const r = await fetchReal(u, init);
        if (init?.method === "PUT") throw new Error("se cortó la conexión");
        return r;
      });
      expect((await confirmar(plan_id)).estado).toBe("fallido");
      vi.stubGlobal("fetch", fetchReal);
      const r = await confirmar(plan_id);
      expect(r.estado).toBe("hecho");
      expect(r.resultado.filas[0]).toContain("ya_aplicado");
      expect(hevy.escrituras).toHaveLength(1);
    });

    it("avisa si Hevy guarda algo distinto de lo pedido", async () => {
      const { plan_id } = await preparar(subirPeso);
      const fetchReal = hevy.fetchFalso;
      vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
        const r = await fetchReal(u, init);
        if (init?.method !== "PUT") return r;
        const datos: any = await r.json();
        datos.routine.exercises[0].rest_seconds = 999;
        return Response.json(datos);
      });
      const res = await confirmar(plan_id);
      expect(res.resultado.filas[0]).toContain("aplicado_con_diferencias");
      expect(res.resultado.filas[0].join()).toMatch(/exercises\.0\.rest_seconds/);
    });

    it("un plan aplicado no se repite; uno desconocido o caducado da error; dos a la vez, solo uno", async () => {
      const { plan_id } = await preparar(subirPeso);
      await confirmar(plan_id);
      expect((await confirmar(plan_id)).error).toMatch(/ya se aplicó/);
      expect(hevy.escrituras).toHaveLength(1);
      expect((await confirmar("nada")).error).toMatch(/No existe/);
      expect(((await programarRutinas(env, { confirmar: true })) as any).error).toMatch(/plan_id/);

      const otro = await preparar({ modificar: [{ routine_id: "r1", title: "Otra vez" }] });
      await env.DB.prepare("UPDATE planes_rutinas SET creado = ? WHERE plan_id = ?").bind(new Date(Date.now() - 25 * 3600_000).toISOString(), otro.plan_id).run();
      expect((await confirmar(otro.plan_id)).error).toMatch(/caducado/);

      const tercero = await preparar({ modificar: [{ routine_id: "r1", title: "Tercero" }] });
      await env.DB.prepare("UPDATE planes_rutinas SET estado = 'aplicando', aplicando_desde = ? WHERE plan_id = ?").bind(new Date().toISOString(), tercero.plan_id).run();
      expect((await confirmar(tercero.plan_id)).error).toMatch(/aplicando/);
      // Un intento que se quedó colgado no bloquea para siempre
      await env.DB.prepare("UPDATE planes_rutinas SET aplicando_desde = ? WHERE plan_id = ?").bind(new Date(Date.now() - 600_000).toISOString(), tercero.plan_id).run();
      expect((await confirmar(tercero.plan_id)).estado).toBe("hecho");
    });

    it("un plan de rutinas no se puede confirmar con programar_entrenos", async () => {
      const { plan_id } = await preparar(subirPeso);
      env.INTERVALS_API_KEY = "k";
      expect(((await programarEntrenos(env, { plan_id, confirmar: true })) as any).error).toMatch(/No existe/);
      expect(hevy.escrituras).toEqual([]);
    });
  });

  // --- crear -----------------------------------------------------------------------------
  describe("crear", () => {
    const nueva = { crear: [{ title: "Accesorios", folder_id: 42, notes: "Suave", ejercicios: [{ exercise_template_id: P1, rest_seconds: 60, series: [{ type: "warmup", weight_kg: 20, reps: 15 }, { weight_kg: 30, rep_range: { start: 8, end: 12 } }] }] }] };

    it("vista previa sin escribir y, al confirmar, crea lo mostrado", async () => {
      const r = await preparar(nueva);
      expect(hevy.escrituras).toEqual([]);
      expect(r.crear[0]).toMatchObject({ titulo: "Accesorios", carpeta: "Fuerza" });
      const c: any = await programarRutinas(env, { plan_id: r.plan_id, confirmar: true });
      expect(c.estado).toBe("hecho");
      expect(hevy.escrituras).toHaveLength(1);
      expect(hevy.escrituras[0]).toMatchObject({ metodo: "POST", ruta: "/routines" });
      expect(hevy.escrituras[0].cuerpo.routine).toMatchObject({ title: "Accesorios", folder_id: 42, notes: "Suave" });
      expect(hevy.escrituras[0].cuerpo.routine.exercises[0].sets[1]).toMatchObject({ type: "normal", weight_kg: 30 });
      expect(await series(env, "SELECT DISTINCT rutina FROM v_rutinas")).toEqual([{ rutina: "Accesorios" }]);
    });

    it("un rechazo (4xx) se puede reintentar; un fallo incierto no vuelve a crear, para no duplicar", async () => {
      const { plan_id } = await preparar(nueva);
      hevy.fallar((m) => (m === "POST" ? Response.json({ error: "routine-limit-exceeded" }, { status: 403 }) : null));
      const r1: any = await programarRutinas(env, { plan_id, confirmar: true });
      expect(r1.resultado.filas[0].join()).toMatch(/403/);
      hevy.fallar((m) => (m === "POST" ? new Response("x", { status: 502 }) : null));
      const r2: any = await programarRutinas(env, { plan_id, confirmar: true });
      expect(r2.resultado.filas[0].join()).toMatch(/502/);
      hevy.fallar(null);
      const posts = hevy.escrituras.length;
      const r3: any = await programarRutinas(env, { plan_id, confirmar: true });
      expect(r3.resultado.filas[0].join()).toMatch(/puede que la rutina se creara/);
      expect(hevy.escrituras.length).toBe(posts);
    });

    it("una rutina ya creada no se repite si otra del plan falló", async () => {
      const dos = { crear: [nueva.crear[0], { ...nueva.crear[0], title: "Otra" }] };
      const { plan_id } = await preparar(dos);
      let n = 0;
      hevy.fallar((m) => (m === "POST" && ++n === 2 ? Response.json({ error: "x" }, { status: 400 }) : null));
      const r1: any = await programarRutinas(env, { plan_id, confirmar: true });
      expect(r1.estado).toBe("parcial");
      hevy.fallar(null);
      const r2: any = await programarRutinas(env, { plan_id, confirmar: true });
      expect(r2.estado).toBe("hecho");
      expect([...hevy.rutinas.values()].filter((r) => r.title === "Accesorios")).toHaveLength(1);
      expect([...hevy.rutinas.values()].filter((r) => r.title === "Otra")).toHaveLength(1);
    });
  });

  // --- restaurar --------------------------------------------------------------------------
  describe("restaurar", () => {
    const aplicarCambio = async () => {
      const { plan_id } = await preparar(subirPeso);
      await programarRutinas(env, { plan_id, confirmar: true });
      const [c] = await series(env, "SELECT copia_id FROM rutina_copias");
      hevy.escrituras.length = 0;
      return c.copia_id as number;
    };

    it("en dos pasos: vuelve a la copia y guarda también la versión que se sustituye", async () => {
      const original = cuerpoDesde(rutinaEjemplo());
      const copia = await aplicarCambio();
      const v = await preparar({ restaurar: [copia] });
      expect(hevy.escrituras).toEqual([]);
      expect(v.restaurar[0].copia_id).toBe(copia);
      expect(v.restaurar[0].antes.ejercicios[0]).toContain("62.5 kg");
      expect(v.restaurar[0].despues.ejercicios[0]).toContain("60 kg × 8-10 reps");
      const r: any = await programarRutinas(env, { plan_id: v.plan_id, confirmar: true });
      expect(r.estado).toBe("hecho");
      expect(hevy.escrituras).toHaveLength(1);
      expect(hevy.escrituras[0].cuerpo.routine).toEqual(original);
      expect(cuerpoDesde(hevy.rutinas.get("r1"))).toEqual(original);
      const copias = await series(env, "SELECT motivo, raw FROM rutina_copias ORDER BY copia_id");
      expect(copias.map((c: any) => c.motivo)).toEqual(["modificar", "restaurar"]);
      expect(JSON.parse(copias[1].raw).exercises[0].sets[1].weight_kg).toBe(62.5);
    });

    it("no pisa una rutina que cambió después de la vista previa", async () => {
      const copia = await aplicarCambio();
      const { plan_id } = await preparar({ restaurar: [copia] });
      hevy.rutinas.get("r1").title = "Cambiada en la app";
      const r: any = await programarRutinas(env, { plan_id, confirmar: true });
      expect(r.estado).toBe("fallido");
      expect(hevy.escrituras).toEqual([]);
    });

    it("no hace nada si ya está igual que la copia", async () => {
      const copia = await aplicarCambio();
      hevy.rutinas.get("r1").exercises[0].sets[1].weight_kg = 60;
      expect(((await programarRutinas(env, { restaurar: [copia] })) as any).error).toMatch(/ya está igual/);
    });

    it("si la rutina se borró en la app, la crea de nuevo, también en dos pasos", async () => {
      const copia = await aplicarCambio();
      hevy.rutinas.delete("r1");
      const v = await preparar({ restaurar: [copia] });
      expect(v.crear[0].aviso).toMatch(/id nuevo/);
      expect(hevy.escrituras).toEqual([]);
      const r: any = await programarRutinas(env, { plan_id: v.plan_id, confirmar: true });
      expect(r.estado).toBe("hecho");
      expect(hevy.escrituras[0]).toMatchObject({ metodo: "POST", ruta: "/routines" });
      expect(hevy.escrituras[0].cuerpo.routine.exercises[0].sets[1].weight_kg).toBe(60);
    });
  });

  it("por el protocolo MCP: los parámetros llegan enteros y la confirmación aplica lo mostrado", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "prueba", version: "1" });
    await Promise.all([buildServer(env).connect(a), client.connect(b)]);
    const llamar = async (args: any) => JSON.parse(((await client.callTool({ name: "programar_rutinas", arguments: args })) as any).content[0].text);
    const v = await llamar({
      modificar: [{
        routine_id: "r1", ejercicios: [{ indice: 0, series_cambios: [{ indice: 1, weight_kg: 62.5, rep_range: { start: 6, end: 8 } }] }],
        anadir_ejercicios: [{ exercise_template_id: NUEVA, posicion: 1, series: [{ type: "warmup", reps: 15 }] }],
      }],
    });
    expect(v.error).toBeUndefined();
    expect(hevy.escrituras).toEqual([]);
    const r = await llamar({ plan_id: v.plan_id, confirmar: true });
    expect(r.estado).toBe("hecho");
    const b2 = hevy.escrituras[0].cuerpo.routine;
    expect(b2.exercises[0].sets[1]).toMatchObject({ type: "normal", weight_kg: 62.5, rep_range: { start: 6, end: 8 } });
    expect(b2.exercises[1]).toMatchObject({ exercise_template_id: NUEVA, sets: [{ type: "warmup", reps: 15 }] });
  });

  it("runSync: las rutinas entran en la sincronización y su fallo no afecta a lo demás", async () => {
    const r: any = await runSync(env);
    expect(r.rutinas).toMatchObject({ rutinas: 1, completa: true });
    expect(await series(env, "SELECT DISTINCT rutina FROM v_rutinas")).toEqual([{ rutina: "Upper A" }]);
    hevy.fallar((_m, ruta) => (ruta === "/routines" ? new Response("x", { status: 500 }) : null));
    const r2: any = await runSync(env);
    expect(r2.rutinas.error).toMatch(/500/);
    expect(r2.hevy.error).toBeUndefined();
    expect(await series(env, "SELECT DISTINCT rutina FROM v_rutinas")).toEqual([{ rutina: "Upper A" }]);
  });

  it("solo escribe en /routines: nunca en entrenos hechos ni con DELETE", async () => {
    const { plan_id } = await preparar({ ...subirPeso, crear: [{ title: "x", ejercicios: [{ exercise_template_id: P1, series: [{ reps: 1 }] }] }] });
    await programarRutinas(env, { plan_id, confirmar: true });
    expect(hevy.escrituras.length).toBe(2);
    for (const e of hevy.escrituras) {
      expect(e.ruta).toMatch(/^\/routines/);
      expect(["POST", "PUT"]).toContain(e.metodo);
    }
  });

  it("no pasa del límite de subpeticiones con un plan del tamaño máximo", async () => {
    for (let i = 2; i <= 5; i++) hevy.rutinas.set(`r${i}`, { ...rutinaEjemplo(), id: `r${i}` });
    let d1 = 0;
    const prep = env.DB.prepare.bind(env.DB);
    const base = env.DB as any;
    const envolver = (s: any): any => ({
      bind: (...p: unknown[]) => envolver(s.bind(...p)),
      all: () => { d1++; return s.all(); }, first: () => { d1++; return s.first(); }, run: () => { d1++; return s.run(); },
    });
    base.prepare = (sql: string) => envolver(prep(sql));
    const args = { modificar: [1, 2, 3, 4, 5].map((i) => ({ routine_id: `r${i}`, title: `Nueva ${i}` })) };
    const { plan_id } = await preparar(args);
    expect(hevy.lecturas.length + hevy.escrituras.length + d1).toBeLessThanOrEqual(50);
    hevy.lecturas.length = 0; hevy.escrituras.length = 0; d1 = 0;
    const r: any = await programarRutinas(env, { plan_id, confirmar: true });
    expect(r.estado).toBe("hecho");
    expect(hevy.lecturas.length + hevy.escrituras.length + d1).toBeLessThanOrEqual(50);
  });
});
