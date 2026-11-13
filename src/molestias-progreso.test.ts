/**
 * Tests de dos fallos vistos en la code review:
 * - una molestia abierta y antigua no debe quedar fuera por haber muchas notas de otros tipos;
 * - progreso no debe contar la semana en curso como si estuviera completa.
 * Se ejecutan con SQLite de verdad y todas las migraciones. Sin clave de intervals: no se llama a nada de fuera.
 * Si la versión de Node no trae node:sqlite, estos tests se saltan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { progreso } from "./analisis";
import { estadoAtleta, nota, revisarActividad } from "./coach";
import type { Env } from "./env";
import { addDays } from "./env";

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

// Sábado 7-nov-2026 a mediodía en Madrid. Su lunes es el 2-nov.
const SABADO = "2026-11-07";
const LUNES = "2026-11-02";
const fijarHora = (iso: string) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
};

describe.skipIf(!sqlite)("molestias y progreso", () => {
  let env: Env;
  beforeEach(() => {
    env = { TZ: "Europe/Madrid", DB: baseDePrueba() } as unknown as Env;
    fijarHora(`${SABADO}T12:00:00Z`);
  });
  afterEach(() => vi.useRealTimers());

  const anotar = (fecha: string, tipo: string | null, texto: string) =>
    env.DB.prepare("INSERT INTO notas (fecha, tipo, texto) VALUES (?, ?, ?)").bind(fecha, tipo, texto).run();
  /** n notas de un tipo, de la más reciente (ayer) hacia atrás. */
  const anotarVarias = async (n: number, tipo: string | null) => {
    for (let i = 1; i <= n; i++) await anotar(addDays(SABADO, -i), tipo, `${tipo} ${i}`);
  };

  describe("molestias", () => {
    it("una molestia de hace 30 días sigue dando alerta y saliendo aunque haya 10 notas más recientes", async () => {
      const { meta } = await anotar(addDays(SABADO, -30), "molestia", "Zona A");
      await anotarVarias(10, "sensacion");
      const r = await estadoAtleta(env) as any;
      expect(r.alertas.map((a: any) => a.clave)).toContain(`nota:${meta.last_row_id}:2026-W45`);
      expect(r.notas_abiertas.map((n: any) => n.texto)).toContain("Zona A");
    });

    it("todas las molestias abiertas entran, aunque haya más de 10, y las que no caben en alertas siguen activas", async () => {
      await anotarVarias(13, "molestia");
      const r = await estadoAtleta(env) as any;
      expect(r.notas_abiertas.filter((n: any) => n.tipo === "molestia")).toHaveLength(13);
      expect(r.notas_omitidas).toBeUndefined();
      // Las de hace menos de 6 días aún no toca revisarlas: 13 - 5 = 8 alertas guardadas, y salen 2 por respuesta
      const { results } = await env.DB.prepare("SELECT clave FROM alertas_activas WHERE clave LIKE 'nota:%'").all();
      expect(results).toHaveLength(8);
      expect(r.alertas).toHaveLength(2);
    });

    it("las demás notas se quedan en las 10 más recientes y se indica cuántas se omiten", async () => {
      await anotar(addDays(SABADO, -30), "molestia", "Zona A");
      await anotarVarias(15, "sensacion");
      const r = await estadoAtleta(env) as any;
      const otras = r.notas_abiertas.filter((n: any) => n.tipo !== "molestia");
      expect(otras.map((n: any) => n.texto)).toEqual(Array.from({ length: 10 }, (_, i) => `sensacion ${i + 1}`));
      expect(r.notas_abiertas).toHaveLength(11);
      expect(r.notas_omitidas).toMatch(/^5 notas abiertas/);
    });

    it("con 10 notas o menos de otros tipos no hay aviso de omitidas y la salida sigue por fecha", async () => {
      await anotarVarias(10, "sensacion");
      await anotar(addDays(SABADO, -3), "molestia", "Zona B");
      const r = await estadoAtleta(env) as any;
      expect(r.notas_abiertas).toHaveLength(11);
      expect(r.notas_omitidas).toBeUndefined();
      const fechas = r.notas_abiertas.map((n: any) => n.fecha);
      expect(fechas).toEqual([...fechas].sort().reverse());
    });

    it("una nota sin tipo cuenta como de las demás: ni se pierde ni dispara alerta", async () => {
      await anotarVarias(11, null);
      const r = await estadoAtleta(env) as any;
      expect(r.notas_abiertas).toHaveLength(10);
      expect(r.notas_omitidas).toMatch(/^1 nota abierta/);
      expect(r.alertas).toEqual([]);
    });

    it("una molestia cerrada no entra ni da alerta", async () => {
      const { meta } = await anotar(addDays(SABADO, -30), "molestia", "Zona A");
      await nota(env, { cerrar: meta.last_row_id });
      const r = await estadoAtleta(env) as any;
      expect(r.notas_abiertas).toBeUndefined();
      expect(r.alertas).toEqual([]);
    });

    it("nota devuelve también todas las molestias y el aviso de omitidas", async () => {
      await anotar(addDays(SABADO, -30), "molestia", "Zona A");
      await anotarVarias(12, "sensacion");
      const r = await nota(env, { texto: "Otra más", tipo: "sensacion" }) as any;
      const textos = r.abiertas.filas.map((f: unknown[]) => f[r.abiertas.columnas.indexOf("texto")]);
      expect(textos).toContain("Zona A");
      expect(textos).toHaveLength(11);
      expect(r.omitidas).toMatch(/^3 notas abiertas/);
    });

    it("revisar_actividad usa la misma lista", async () => {
      const { meta } = await anotar(addDays(SABADO, -30), "molestia", "Zona A");
      await anotarVarias(12, "sensacion");
      await env.DB.prepare("INSERT INTO activities (id, sport, start_local, moving_s, raw, synced_at) VALUES ('a1', 'Ride', ?, 3600, '{}', 'x')")
        .bind(`${SABADO}T08:00:00`).run();
      const r = await revisarActividad(env, "a1") as any;
      expect(r.alertas.map((a: any) => a.clave)).toContain(`nota:${meta.last_row_id}:2026-W45`);
      expect(r.notas_abiertas.map((n: any) => n.texto)).toContain("Zona A");
      expect(r.notas_omitidas).toMatch(/^2 notas abiertas/);
    });
  });

  describe("progreso", () => {
    const correr = (id: string, fecha: string, km: number) =>
      env.DB.prepare("INSERT INTO activities (id, sport, start_local, distance_m, moving_s, raw, synced_at) VALUES (?, 'Run', ?, ?, 3600, '{}', 'x')")
        .bind(id, `${fecha}T08:00:00`, km * 1000).run();
    /** n semanas completas anteriores a la del lunes dado, cada una con kms[i] (o 30) km el miércoles. */
    const semanasDe = async (n: number, lunes = LUNES, kms: (i: number) => number = () => 30) => {
      for (let i = 1; i <= n; i++) await correr(`s${i}`, addDays(lunes, -7 * i + 2), kms(i));
    };

    it("8 semanas iguales y un sábado con 5 km: estable, no empeorando", async () => {
      await semanasDe(8);
      await correr("hoy", SABADO, 5);
      const r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
      expect(r.tendencia).toBe("estable");
      expect(r.cambio_total_pct).toBe(0);
    });

    it("la semana en curso sale aparte, marcada como incompleta, y no en la tabla", async () => {
      await semanasDe(8);
      await correr("hoy", SABADO, 5);
      const r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
      expect(r.semanas.filas.map((f: unknown[]) => f[0])).not.toContain(LUNES);
      expect(r.semanas.filas).toHaveLength(8);
      expect(r.semana_en_curso).toMatchObject({ semana: LUNES, valor: 5, n: 1 });
      expect(r.semana_en_curso.nota).toMatch(/incompleta/);
    });

    it("sin datos esta semana no hay semana_en_curso", async () => {
      await semanasDe(8);
      const r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
      expect(r.semana_en_curso).toBeUndefined();
    });

    it("la pendiente sale solo de las semanas completas", async () => {
      await semanasDe(4, LUNES, (i) => 50 - 10 * i); // 10, 20, 30, 40 km, de la más antigua a la última
      await correr("hoy", SABADO, 1);
      const r = await progreso(env, { metrica: "km", semanas: 4 }) as any;
      expect(r.pendiente_por_semana).toBe("+10 km");
      expect(r.tendencia).toBe("mejorando");
    });

    it("el mínimo de 4 semanas cuenta solo las completas", async () => {
      await semanasDe(3);
      await correr("hoy", SABADO, 30);
      const r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
      expect(r.tendencia).toMatch(/^pocos datos \(3 semanas completas/);
      expect(r.pendiente_por_semana).toBeUndefined();
      expect(r.semana_en_curso.valor).toBe(30);
    });

    it("el mínimo se cumple con 4 semanas completas sin dato en la semana en curso", async () => {
      await semanasDe(4);
      const r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
      expect(r.tendencia).toBe("estable");
    });

    it("el domingo por la noche la semana sigue en curso; el lunes ya es completa", async () => {
      fijarHora("2026-11-08T20:00:00Z"); // domingo, 21:00 en Madrid
      await semanasDe(8);
      await correr("hoy", "2026-11-08", 30);
      let r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
      expect(r.semana_en_curso.semana).toBe(LUNES);
      fijarHora("2026-11-08T23:30:00Z"); // en UTC aún domingo; en Madrid, lunes 9
      r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
      expect(r.semana_en_curso).toBeUndefined();
      expect(r.semanas.filas.map((f: unknown[]) => f[0])).toContain(LUNES);
    });

    it("una semana antigua de la que solo entra el domingo no falsea la tendencia", async () => {
      await semanasDe(8);
      await correr("borde", "2026-09-06", 5); // sábado 7-nov, 8 semanas: la ventana empieza este domingo
      const r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
      expect(r.tendencia).toBe("estable");
      expect(r.semanas.filas.map((f: unknown[]) => f[0])).not.toContain("2026-08-31");
    });

    it("cualquier día de la semana da exactamente las semanas completas pedidas", async () => {
      for (let i = 0; i < 70; i++) await correr(`d${i}`, addDays("2026-11-08", -i), 5);
      for (let d = 0; d < 7; d++) {
        fijarHora(`${addDays(LUNES, d)}T12:00:00Z`);
        const r = await progreso(env, { metrica: "km", semanas: 8 }) as any;
        expect(r.semanas.filas).toHaveLength(8);
        expect(r.semanas.filas[7][0]).toBe("2026-10-26");
        expect(r.semanas.filas.every((f: unknown[]) => f[1] === 35)).toBe(true);
        expect(r.tendencia).toBe("estable");
      }
    });

    describe("ejercicios", () => {
      const gimnasio = async (id: string, fecha: string, kg: number) => {
        await env.DB.prepare("INSERT INTO gym_workouts (id, title, start_time, date) VALUES (?, 'Fuerza', ?, ?)")
          .bind(id, `${fecha}T10:00:00Z`, fecha).run();
        await env.DB.prepare(`INSERT INTO gym_sets (workout_id, exercise_index, set_index, exercise, template_id, set_type, weight_kg, reps, start_time)
          VALUES (?, 0, 0, 'Sentadilla', 'tpl', 'normal', ?, 5, ?)`).bind(id, kg, `${fecha}T10:00:00Z`).run();
      };

      it("una sesión floja hoy no cambia la tendencia del ejercicio y sale aparte", async () => {
        for (let i = 1; i <= 6; i++) await gimnasio(`g${i}`, addDays(LUNES, -7 * i + 2), 100);
        await gimnasio("hoy", SABADO, 40);
        const r = await progreso(env, { ejercicio: "Sentadilla", semanas: 8 }) as any;
        expect(r.tendencia).toBe("estable");
        expect(r.semanas.filas.map((f: unknown[]) => f[0])).not.toContain(LUNES);
        expect(r.semana_en_curso).toMatchObject({ semana: LUNES, valor: 46.7, series: 1 });
        expect(r.semana_en_curso.nota).toMatch(/incompleta/);
      });

      it("una semana antigua de la que solo entra el domingo no cuenta", async () => {
        for (let i = 1; i <= 6; i++) await gimnasio(`g${i}`, addDays(LUNES, -7 * i + 2), 100);
        await gimnasio("borde", "2026-09-06", 40);
        const r = await progreso(env, { ejercicio: "Sentadilla", semanas: 8 }) as any;
        expect(r.tendencia).toBe("estable");
        expect(r.semanas.filas.map((f: unknown[]) => f[0])).not.toContain("2026-08-31");
      });

      it("el mínimo también cuenta solo las semanas completas", async () => {
        for (let i = 1; i <= 3; i++) await gimnasio(`g${i}`, addDays(LUNES, -7 * i + 2), 100);
        await gimnasio("hoy", SABADO, 100);
        const r = await progreso(env, { ejercicio: "Sentadilla", semanas: 8 }) as any;
        expect(r.tendencia).toMatch(/^pocos datos \(3 semanas completas/);
      });
    });
  });
});
