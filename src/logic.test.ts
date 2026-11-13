/**
 * Tests de la lógica pura (sin red ni base de datos). Se ejecutan en cada build:
 * si fallan, Cloudflare no publica.
 */
import { describe, expect, it } from "vitest";
import { tendencia } from "./analisis";
import { esDura, estadoAtleta, semanaIso } from "./coach";
import type { Env } from "./env";
import { addDays, localDate, today } from "./env";
import { escalaFeel, feelExplicado, fmtActivity, mmss, pace, ritmoDe, TIEMPO_SQL, tiempoEnMarcha } from "./format";
import { validar } from "./plan";
import { prepararSql } from "./tools";
import { analizarStreams, computeSplits, deriva, leerLimites, type Split, zonaFc } from "./splits";
import { VERSION } from "./version";

const env = { TZ: "Europe/Madrid" } as Env;

/** Streams sintéticos a 1 Hz: velocidad constante, con una pausa del reloj opcional en un punto. */
function streams(metros: number, velocidad: number, opts: { paradaEn?: number; paradaS?: number; fc?: (i: number) => number } = {}) {
  const time: number[] = [], distance: (number | null)[] = [], heartrate: number[] = [], cadence: (number | null)[] = [], altitude: (number | null)[] = [];
  let t = 0, d = 0, i = 0, parado = false;
  while (true) {
    time.push(t); distance.push(d); heartrate.push(opts.fc ? opts.fc(i) : 150); cadence.push(82); altitude.push(0);
    if (d >= metros) break;
    t++; i++;
    if (!parado && opts.paradaEn != null && d >= opts.paradaEn) {
      parado = true;
      for (let k = 0; k < (opts.paradaS ?? 0); k++) {
        time.push(t); distance.push(null); heartrate.push(120); cadence.push(null); altitude.push(null); t++;
      }
    }
    d = Math.min(metros, d + velocidad);
  }
  return [["time", time], ["distance", distance], ["heartrate", heartrate], ["cadence", cadence], ["altitude", altitude]]
    .map(([type, data]) => ({ type, data }));
}

/**
 * Streams a 1 Hz con la distancia en metros enteros y a saltos (+0, +3, +3: 2 m/s de media).
 * Las muestras de `pausas` llevan null salvo tiempo y FC, como con el reloj en pausa.
 */
function streamsASaltos(segundos: number, pausas: [desde: number, hasta: number][] = []) {
  const time: number[] = [], distance: (number | null)[] = [], heartrate: number[] = [], cadence: (number | null)[] = [], altitude: (number | null)[] = [];
  let d = 0, corriendo = 0;
  for (let t = 0; t < segundos; t++) {
    const enPausa = pausas.some(([desde, hasta]) => t >= desde && t < hasta);
    time.push(t);
    heartrate.push(enPausa ? 100 : 150);
    if (enPausa) { distance.push(null); cadence.push(null); altitude.push(null); continue; }
    if (t > 0) { d += [0, 3, 3][corriendo % 3]; corriendo++; }
    distance.push(d); cadence.push(80); altitude.push(0);
  }
  return [["time", time], ["distance", distance], ["heartrate", heartrate], ["cadence", cadence], ["altitude", altitude]]
    .map(([type, data]) => ({ type, data }));
}

describe("splits", () => {
  it("usa solo el tiempo en movimiento (las paradas no cuentan)", () => {
    const s = computeSplits(streams(3000, 3, { paradaEn: 1500, paradaS: 120 }), true);
    expect(s.map((x) => x.km)).toEqual([1, 2, 3]);
    for (const x of s) expect(x.pace_s).toBeGreaterThanOrEqual(332);
    for (const x of s) expect(x.pace_s).toBeLessThanOrEqual(335);
  });

  it("los segundos sin avance en metros enteros no cuentan como parados", () => {
    const s = computeSplits(streamsASaltos(1100), true);
    expect(s[0].km).toBe(1);
    expect(s[0].pace_s).toBeGreaterThanOrEqual(498); // con el filtro de 0,5 m/s salía ~333
    expect(s[0].pace_s).toBeLessThanOrEqual(502);
  });

  it("una pausa del reloj no cuenta en el ritmo ni en la media de FC y cadencia", () => {
    const s = computeSplits(streamsASaltos(1160, [[200, 260]]), true);
    expect(s[0].pace_s).toBeGreaterThanOrEqual(498);
    expect(s[0].pace_s).toBeLessThanOrEqual(502);
    expect(s[0].hr).toBe(150);
    expect(s[0].cadence_spm).toBe(160);
  });

  it("el desnivel no suma durante una pausa aunque la altitud siga llegando", () => {
    const st = streamsASaltos(1160, [[200, 260]]);
    const altitude = st.find((x) => x.type === "altitude")!.data as number[];
    for (let i = 200; i < 260; i++) altitude[i] = i - 199;
    expect(computeSplits(st, true)[0].elev_m).toBe(0);
  });

  it("guarda el último tramo aunque la actividad acabe en pausa, y admite que empiece en pausa", () => {
    const fin = computeSplits(streamsASaltos(700, [[650, 700]]), true); // ~1300 m y pausa final
    expect(fin.at(-1)!.km).toBe(2);
    expect(fin.at(-1)!.dist_m).toBeGreaterThanOrEqual(200);
    const inicio = computeSplits(streamsASaltos(560, [[0, 30]]), true);
    expect(inicio[0].dist_m).toBeGreaterThanOrEqual(1000);
    expect(inicio[0].pace_s).toBeLessThanOrEqual(502);
  });

  it("un hueco sin distancia en el que se avanza cuenta como movimiento, no como pausa", () => {
    // 60 s sin señal corriendo: al volver la distancia ha subido ~120 m (2 m/s)
    const st = streamsASaltos(1100);
    const distance = st.find((x) => x.type === "distance")!.data as (number | null)[];
    for (let i = 200; i < 260; i++) distance[i] = null;
    const s = computeSplits(st, true);
    expect(s[0].pace_s).toBeGreaterThanOrEqual(498); // si se tomara por pausa saldría ~440
    expect(s[0].pace_s).toBeLessThanOrEqual(502);
  });

  it("un hueco en el que se avanza menos de 0,5 m/s es una pausa", () => {
    // 100 s de hueco y solo 7 m al volver (0,07 m/s): deriva del GPS, no carrera
    const st = streamsASaltos(1200, [[200, 300]]);
    const distance = st.find((x) => x.type === "distance")!.data as (number | null)[];
    for (let i = 300; i < distance.length; i++) distance[i]! += 7;
    const s = computeSplits(st, true);
    expect(s[0].pace_s).toBeGreaterThanOrEqual(490);
    expect(s[0].pace_s).toBeLessThanOrEqual(502);
    expect(s[0].hr).toBe(150);
  });

  it("descarta el último tramo de menos de 200 m aunque acabe en pausa", () => {
    expect(computeSplits(streamsASaltos(560, [[550, 560]]), true)).toHaveLength(1); // ~1100 m
  });

  it("sin distancia válida no hay parciales", () => {
    expect(computeSplits(streamsASaltos(50, [[0, 50]]), true)).toEqual([]);
  });

  it("duplica la cadencia en deportes a pie", () => {
    const s = computeSplits(streams(2000, 3), true);
    expect(s[0].cadence_spm).toBe(164);
  });

  it("incluye el último tramo parcial si tiene al menos 200 m", () => {
    expect(computeSplits(streams(2500, 2.5), true).at(-1)!.dist_m).toBe(500);
    expect(computeSplits(streams(2100, 2.5), true)).toHaveLength(2);
  });

  it("deriva: null con menos de 4 km completos, positiva si la FC sube a ritmo constante", () => {
    expect(deriva(computeSplits(streams(3000, 3), true))).toBeNull();
    const sube = computeSplits(streams(6000, 3, { fc: (i) => 140 + i / 100 }), true);
    expect(deriva(sube)!).toBeGreaterThan(3);
    const llano: Split[] = [1, 2, 3, 4].map((km) => ({ km, dist_m: 1000, pace_s: 330, hr: 150, cadence_spm: 164, elev_m: 0 }));
    expect(deriva(llano)).toBe(0);
  });
});

describe("ritmos y feel", () => {
  it("ritmo a partir de tiempo y distancia", () => {
    expect(ritmoDe(2000, 5000)).toBe("6:40");
    expect(ritmoDe(null, 5000)).toBeNull();
    expect(ritmoDe(2000, 0)).toBeNull();
  });

  it("feel con WATCH=suunto: etiqueta, escala y valor en el reloj", () => {
    expect(feelExplicado(1, "suunto")).toEqual({ feel_etiqueta: "muy bien", feel_reloj: 5, feel_escala: "en intervals 1 = muy bien y 5 = muy mal; valor en el reloj = 6 − feel" });
    expect(feelExplicado(5, "suunto")).toMatchObject({ feel_etiqueta: "muy mal", feel_reloj: 1 });
    expect(feelExplicado(2, " Suunto ").feel_reloj).toBe(4); // sin distinguir mayúsculas ni espacios
    expect(feelExplicado(null, "suunto")).toEqual({});
    expect(feelExplicado(0, "suunto")).toEqual({});
  });

  it("feel sin WATCH=suunto: solo la escala de intervals.icu", () => {
    for (const watch of [undefined, "", "garmin", "coros"]) {
      const f = feelExplicado(1, watch);
      expect(f).toEqual({ feel_etiqueta: "muy bien", feel_escala: "en intervals 1 = muy bien y 5 = muy mal" });
      expect(f).not.toHaveProperty("feel_reloj");
      expect(escalaFeel(watch)).not.toContain("reloj");
    }
    expect(feelExplicado(null, "garmin")).toEqual({});
  });
});

describe("fechas", () => {
  it("localDate pasa de UTC a la fecha de Madrid alrededor de medianoche", () => {
    expect(localDate("2026-11-02T23:30:00Z", "Europe/Madrid")).toBe("2026-11-03"); // invierno, UTC+1
    expect(localDate("2026-07-01T21:59:00Z", "Europe/Madrid")).toBe("2026-07-01"); // verano, UTC+2
    expect(localDate("2026-07-01T22:00:00Z", "Europe/Madrid")).toBe("2026-07-02");
    expect(localDate(null)).toBeNull();
  });

  it("semana ISO", () => {
    expect(semanaIso("2026-11-03")).toBe("2026-W45");
    expect(semanaIso("2026-01-01")).toBe("2026-W01");
    expect(semanaIso("2027-01-03")).toBe("2026-W53");
  });
});

describe("validar plan", () => {
  const hoy = today(env.TZ);
  const entreno = (fecha: string) => ({ fecha, tipo: "Run", nombre: "Rodaje", descripcion: "- 30m Z2 HR" });

  it("acepta un plan normal", () => {
    expect(validar(env, [entreno(addDays(hoy, 1)), entreno(addDays(hoy, 3))])).toBeNull();
  });
  it("rechaza fechas pasadas, más de 42 días y más de 10 entrenos", () => {
    expect(validar(env, [entreno(addDays(hoy, -1))])).toMatch(/ya ha pasado/);
    expect(validar(env, [entreno(addDays(hoy, 43))])).toMatch(/42 días/);
    expect(validar(env, Array.from({ length: 11 }, () => entreno(addDays(hoy, 1))))).toMatch(/Máximo 10/);
    expect(validar(env, [])).toMatch(/No hay/);
  });
  it("rechaza tipos y nombres no válidos", () => {
    expect(validar(env, [{ ...entreno(addDays(hoy, 1)), tipo: "Yoga" }])).toMatch(/tipo/);
    expect(validar(env, [{ ...entreno(addDays(hoy, 1)), nombre: " " }])).toMatch(/nombre/);
  });
});

describe("formato", () => {
  it("ritmo en min/km y sin ritmo para la cinta sin distancia", () => {
    expect(pace(2.797)).toBe("5:58");
    expect(pace(0.237)).toBeNull();
    expect(mmss(572)).toBe("9:32");
    const cinta = fmtActivity({ sport: "VirtualRun", distance_m: null, avg_speed_ms: 0.24, moving_s: 2 });
    expect(cinta.ritmo_min_km).toBeNull();
  });
});

describe("versión", () => {
  it("estado_atleta devuelve la versión del servidor", async () => {
    // Base de datos falsa y vacía: basta para ejecutar la herramienta real, sin red
    const consulta = { bind: () => consulta, all: async () => ({ results: [] }) };
    const vacio = { TZ: "Europe/Madrid", DB: { prepare: () => consulta } } as unknown as Env;
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect((await estadoAtleta(vacio)).version).toBe(VERSION);
  });
});

describe("sesión dura", () => {
  it("la intensidad va de 0 a 100: el umbral es 85", () => {
    expect(esDura({ intensity: 71.37 })).toBe(false);
    expect(esDura({ intensity: 84.9 })).toBe(false);
    expect(esDura({ intensity: 85 })).toBe(true);
    expect(esDura({})).toBe(false);
  });
  it("también es dura con 10 minutos o más en Z4-Z7", () => {
    expect(esDura({ intensity: 41, fc_z4_s: 300, fc_z5_s: 300 })).toBe(true);
    expect(esDura({ intensity: 41, fc_z4_s: 599 })).toBe(false);
  });
});

describe("tiempo en marcha", () => {
  it("carrera cuyo moving_s incluye pausas: usa distancia / velocidad", () => {
    const a = { sport: "Run", distance_m: 3000, avg_speed_ms: 2.5, moving_s: 2000 };
    expect(tiempoEnMarcha(a)).toBeCloseTo(1200, 0);
    expect(fmtActivity(a).tiempo).toBe("0:20:00");
  });
  it("sin distancia o velocidad válidas usa moving_s", () => {
    expect(tiempoEnMarcha({ sport: "WeightTraining", distance_m: null, avg_speed_ms: null, moving_s: 3600 })).toBe(3600);
    expect(tiempoEnMarcha({ sport: "Run", distance_m: 0, avg_speed_ms: 2.5, moving_s: 1200 })).toBe(1200);
    expect(tiempoEnMarcha({ sport: "Run", distance_m: 3000, avg_speed_ms: 0.2, moving_s: 1200 })).toBe(1200);
    expect(tiempoEnMarcha({ sport: "Run", moving_s: null })).toBeNull();
  });
  it("cinta y elíptica (velocidad no fiable) usan moving_s", () => {
    expect(tiempoEnMarcha({ sport: "VirtualRun", distance_m: 5630, avg_speed_ms: 3, moving_s: 2265 })).toBe(2265); // aun con velocidad creíble
    expect(tiempoEnMarcha({ sport: "Elliptical", distance_m: 1395, avg_speed_ms: 0.791, moving_s: 1553 })).toBe(1553);
  });
  it("la consulta SQL aplica la misma regla", () => {
    expect(TIEMPO_SQL).toContain("sport IN ('Run','TrailRun','Walk','Hike')");
    expect(TIEMPO_SQL).toContain("avg_speed_ms >= 0.5");
  });
});

describe("FC en marcha", () => {
  const LIMITES = [130, 140, 145, 155, 160, 170, 200];
  const crear = (o: Record<string, unknown[]>) => Object.entries(o).map(([type, data]) => ({ type, data }));

  it("no cuenta el reloj en pausa", () => {
    const { fcMarcha } = analizarStreams(streams(5000, 2.5, { paradaEn: 2000, paradaS: 600 }), true, LIMITES);
    expect(fcMarcha!.fc).toBe(150);
    const z = fcMarcha!.zonas_s!;
    expect(z[0]).toBe(0); // los 600 s a 120 lpm de la pausa no entran en Z1
    expect(z[3]).toBe(z.reduce((a, b) => a + b, 0)); // todo el tiempo en marcha, en Z4
    expect(z[3]).toBeGreaterThanOrEqual(1999);
    expect(z[3]).toBeLessThanOrEqual(2001);
  });

  it("los parciales y la FC usan la misma regla: un hueco corriendo sí cuenta", () => {
    const time = [...Array(500).keys()];
    const s = crear({ time, distance: time.map((t) => (t >= 100 && t < 110 ? null : t * 3)), heartrate: time.map(() => 150) });
    expect(analizarStreams(s, true, LIMITES).fcMarcha!.zonas_s![3]).toBe(499);
  });

  it("pondera por tiempo: una muestra tras 2 s pesa el doble", () => {
    const s = crear({ time: [0, 1, 3, 4], distance: [0, 3, 9, 12], heartrate: [100, 100, 160, 100] });
    const { fcMarcha } = analizarStreams(s, true, LIMITES);
    expect(fcMarcha!.fc).toBe(130); // (100 + 2 x 160 + 100) / 4 s
    expect(fcMarcha!.zonas_s).toEqual([2, 0, 0, 0, 2, 0, 0]);
  });

  it("ignora muestras sin FC y sin FC no hay cálculo", () => {
    const base = { time: [0, 1, 2], distance: [0, 3, 6] };
    expect(analizarStreams(crear({ ...base, heartrate: [0, 0, 150] }), true, LIMITES).fcMarcha)
      .toEqual({ fc: 150, zonas_s: [0, 0, 0, 1, 0, 0, 0] });
    expect(analizarStreams(crear(base), true, LIMITES).fcMarcha).toBeNull();
  });

  it("sin límites da la FC pero no las zonas", () => {
    expect(analizarStreams(streams(2000, 2.5), true).fcMarcha).toEqual({ fc: 150, zonas_s: null });
  });

  it("cada límite es la FC más alta de su zona y por encima del último va a la última", () => {
    expect(zonaFc(130, LIMITES)).toBe(0);
    expect(zonaFc(131, LIMITES)).toBe(1);
    expect(zonaFc(200, LIMITES)).toBe(6);
    expect(zonaFc(215, LIMITES)).toBe(6);
  });

  it("lee los límites como vienen de la base y descarta lo que no sirve", () => {
    expect(leerLimites("[154,163]")).toEqual([154, 163]);
    expect(leerLimites([154, 163])).toEqual([154, 163]);
    expect(leerLimites(null)).toBeNull();
    expect(leerLimites("no es json")).toBeNull();
    expect(leerLimites("[]")).toBeNull();
  });

  it("los parciales no cambian", () => {
    const s = streams(5000, 2.5, { paradaEn: 2000, paradaS: 600 });
    expect(analizarStreams(s, true, LIMITES).splits).toEqual(computeSplits(s, true));
  });
});

describe("tendencia", () => {
  it("pendiente de una recta perfecta y null sin variación", () => {
    const t = tendencia([0, 1, 2, 3].map((x) => ({ x, y: 10 + 2 * x })))!;
    expect(t.pendiente).toBeCloseTo(2);
    expect(t.cambio_pct).toBeCloseTo(60);
    expect(tendencia([{ x: 1, y: 3 }, { x: 1, y: 4 }])).toBeNull();
  });
});

describe("consulta_sql", () => {
  const error = (sql: string) => {
    const r = prepararSql(sql);
    return "error" in r ? r.error : null;
  };

  it("permite vistas y metadatos, rechaza tablas base y escrituras", () => {
    expect(error("SELECT date, aerobic_eff FROM v_activities WHERE sport='Run'")).toBeNull();
    expect(error("WITH x AS (SELECT * FROM v_gym) SELECT COUNT(*) FROM x;")).toBeNull();
    expect(error("SELECT name FROM d1_migrations")).toBeNull();
    expect(error("SELECT sql FROM sqlite_master WHERE name='v_splits'")).toBeNull();
    expect(error("SELECT sql FROM sqlite_schema")).toBeNull();
    expect(error("SELECT raw FROM activities")).toMatch(/vistas/);
    expect(error('SELECT raw FROM "activities"')).toMatch(/vistas/);
    expect(error("SELECT raw FROM 'activities'")).toMatch(/vistas/);
    expect(error("SELECT * FROM v_activities, 'notas'")).toMatch(/notas/);
    expect(error("SELECT * FROM v_activities JOIN notas ON 1=1")).toMatch(/notas/);
    expect(error("DELETE FROM v_activities")).toMatch(/SELECT/);
    expect(error("SELECT 1; DROP TABLE x")).toMatch(/SELECT/);
    expect(error("SELECT 1 /* x */; DROP TABLE x")).toMatch(/SELECT/);
    expect(error("REPLACE INTO notas VALUES (1)")).toMatch(/SELECT/);
  });

  it("no rechaza funciones, alias ni textos que nombran tablas", () => {
    expect(error("SELECT replace(name, 'Carrera ', '') FROM v_activities")).toBeNull();
    expect(error("SELECT sport, COUNT(*) AS activities FROM v_activities GROUP BY sport")).toBeNull();
    expect(error("SELECT name FROM v_activities WHERE name LIKE '%wellness%' OR name = 'update; drop'")).toBeNull();
  });

  it("quita comentarios y el ; final para poder envolver la consulta", () => {
    expect(prepararSql("SELECT * FROM v_activities -- últimas\n;")).toEqual({ sql: "SELECT * FROM v_activities", metadatos: false });
    expect(prepararSql("SELECT /* id */ id FROM v_gym; -- fin")).toEqual({ sql: "SELECT   id FROM v_gym", metadatos: false });
    expect(prepararSql("SELECT '--no' AS x FROM v_gym")).toEqual({ sql: "SELECT '--no' AS x FROM v_gym", metadatos: false });
    expect(prepararSql("SELECT sql FROM sqlite_master")).toMatchObject({ metadatos: true });
  });
});
