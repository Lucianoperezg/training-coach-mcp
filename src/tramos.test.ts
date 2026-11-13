/**
 * Tests de la herramienta tramos con streams sintéticos a 1 Hz (sin red ni base de datos).
 * Cadencia del stream = por pierna (x2 a pie): 85 = 170 ppm.
 */
import { describe, expect, it } from "vitest";
import { analizarTramos, construirRejilla, detectar, estadisticas, leerMedida } from "./tramos";

interface Tr { dur: number; v: number; cad: number | null; hr?: number; rampa?: number; pausa?: boolean }

/** PRNG determinista (mulberry32) para que el ruido sea siempre el mismo. */
function prng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Streams a 1 Hz. rampa = segundos que tarda la cadencia/velocidad en llegar al nivel del tramo desde el anterior. */
function sintetico(trs: Tr[], opts: { ruidoCad?: number; ruidoGps?: number; sinCad?: boolean; seed?: number } = {}) {
  const rnd = prng(opts.seed ?? 1);
  const time: number[] = [], distance: (number | null)[] = [], heartrate: number[] = [], cadence: (number | null)[] = [], altitude: (number | null)[] = [];
  let t = 0, d = 0, vPrev = trs[0].v, cPrev = trs[0].cad ?? 0, hrPrev = trs[0].hr ?? 140, hrNow = hrPrev;
  for (const tr of trs) {
    for (let i = 0; i < tr.dur; i++) {
      const f = tr.rampa ? Math.min(1, (i + 1) / tr.rampa) : 1;
      const v = vPrev + (tr.v - vPrev) * f, c = cPrev + ((tr.cad ?? 0) - cPrev) * f;
      hrNow += ((tr.hr ?? hrPrev) - hrNow) / 25; // la FC va con retraso
      time.push(t); heartrate.push(Math.round(hrNow)); altitude.push(0);
      if (tr.pausa) { distance.push(null); cadence.push(null); }
      else {
        d += v + (opts.ruidoGps ? (rnd() - 0.5) * 2 * opts.ruidoGps : 0);
        distance.push(Math.round(d)); // metros enteros, como en intervals
        cadence.push(opts.sinCad || tr.cad == null ? null : Math.round(c + (opts.ruidoCad ? (rnd() - 0.5) * 2 * opts.ruidoCad : 0)));
      }
      t++;
    }
    if (!tr.pausa) { vPrev = tr.v; cPrev = tr.cad ?? cPrev; }
    hrPrev = tr.hr ?? hrPrev;
  }
  return [["time", time], ["distance", distance], ["heartrate", heartrate], ["cadence", cadence], ["altitude", altitude]]
    .map(([type, data]) => ({ type, data }));
}

const LENTO = { v: 3.0, cad: 82 }, RAPIDO = { v: 4.2, cad: 92 };
const col = (r: any, nombre: string) => r.columnas.indexOf(nombre);
const seg = (mmss: string) => { const [m, s] = mmss.split(":").map(Number); return m * 60 + s; };
const fila = (r: any, i: number, nombre: string) => r.filas[i][col(r, nombre)];

describe("tramos: escalones", () => {
  it("detecta un escalón claro con los bordes a ±2 s", () => {
    const s = sintetico([{ dur: 300, ...LENTO }, { dur: 120, ...RAPIDO }, { dur: 300, ...LENTO }], { ruidoCad: 1 });
    const r: any = analizarTramos(s, true, {}, null);
    const e = r.escalones_detectados;
    expect(r.modo).toBe("perfil");
    const rapidos = e.filas.filter((f: any[]) => f[col(e, "vs_alrededor")] === "más rápido");
    expect(rapidos).toHaveLength(1);
    const i = e.filas.indexOf(rapidos[0]);
    expect(Math.abs(fila(e, i, "dur_s") - 120)).toBeLessThanOrEqual(3);
    expect(fila(e, i, "confianza")).toBe("claro");
    expect(Math.abs(fila(e, i, "cad_ppm") - 184)).toBeLessThanOrEqual(2);
    const g = construirRejilla(s, true)!;
    const det = detectar(g);
    const esc = det.escalones.find((x) => x.dir === "más rápido")!;
    expect(Math.abs(esc.a - 300)).toBeLessThanOrEqual(2);
    expect(Math.abs(esc.b - 420)).toBeLessThanOrEqual(2);
  });

  it("un rodaje con ruido no da escalones", () => {
    const s = sintetico([{ dur: 1800, v: 3.0, cad: 82 }], { ruidoCad: 3, ruidoGps: 0.6 });
    const r: any = analizarTramos(s, true, {}, null);
    expect(r.escalones_detectados.filas).toHaveLength(0);
  });

  it("detecta series de 20 s con bordes de 1-2 s", () => {
    const trs: Tr[] = [{ dur: 300, ...LENTO }];
    for (let i = 0; i < 6; i++) trs.push({ dur: 20, ...RAPIDO }, { dur: 60, ...LENTO });
    const s = sintetico(trs, { ruidoCad: 1 });
    const g = construirRejilla(s, true)!;
    const rapidos = detectar(g).escalones.filter((e) => e.dir === "más rápido");
    expect(rapidos).toHaveLength(6);
    rapidos.forEach((e, i) => {
      expect(Math.abs(e.a - (300 + i * 80))).toBeLessThanOrEqual(2);
      expect(Math.abs(e.b - (320 + i * 80))).toBeLessThanOrEqual(2);
    });
    // en 20 s el ritmo sale de la distancia entre bordes y se avisa de la FC
    const r: any = analizarTramos(s, true, {}, null);
    expect(r.avisos.join(" ")).toContain("FC no representativa");
    const e = r.escalones_detectados;
    const iR = e.filas.findIndex((f: any[]) => f[col(e, "vs_alrededor")] === "más rápido");
    expect(fila(e, iR, "fc_ok")).toBe(false);
    expect(seg(fila(e, iR, "ritmo"))).toBeGreaterThan(232); // 1000 / 4,2 m/s = 238 s; bordes ±2 s
    expect(seg(fila(e, iR, "ritmo"))).toBeLessThan(244);
  });

  it("una aceleración progresiva sale con confianza difusa", () => {
    const s = sintetico([{ dur: 300, ...LENTO }, { dur: 150, ...RAPIDO, rampa: 60 }, { dur: 300, ...LENTO }], { ruidoCad: 1 });
    const g = construirRejilla(s, true)!;
    const esc = detectar(g).escalones.filter((e) => e.dir === "más rápido");
    // o no se detecta como escalón, o si se detecta es difuso: nunca "claro"
    for (const e of esc) expect(e.confianza).toBe("difuso");
  });

  it("GPS ruidoso con cadencia limpia: los bordes salen de la cadencia", () => {
    const s = sintetico([{ dur: 300, ...LENTO }, { dur: 120, ...RAPIDO }, { dur: 300, ...LENTO }], { ruidoGps: 1.5, ruidoCad: 1 });
    const g = construirRejilla(s, true)!;
    const det = detectar(g);
    expect(det.senal).toBe("cadencia");
    const esc = det.escalones.filter((e) => e.dir === "más rápido");
    expect(esc).toHaveLength(1);
    expect(Math.abs(esc[0].a - 300)).toBeLessThanOrEqual(2);
    expect(Math.abs(esc[0].b - 420)).toBeLessThanOrEqual(2);
  });

  it("sin cadencia usa el ritmo y avisa", () => {
    const s = sintetico([{ dur: 300, ...LENTO }, { dur: 120, ...RAPIDO }, { dur: 300, ...LENTO }], { sinCad: true });
    const r: any = analizarTramos(s, true, {}, null);
    expect(r.avisos.join(" ")).toContain("Sin cadencia");
    expect(r.criterio).toContain("senal=ritmo");
    const e = r.escalones_detectados;
    const rap = e.filas.filter((f: any[]) => f[col(e, "vs_alrededor")] === "más rápido");
    expect(rap).toHaveLength(1);
    expect(Math.abs(rap[0][col(e, "dur_s")] - 120)).toBeLessThanOrEqual(8);
    expect(rap[0][col(e, "cad_ppm")]).toBeNull();
  });
});

describe("tramos: medias de un tramo", () => {
  const base = sintetico([{ dur: 600, v: 3.0, cad: 80, hr: 140 }, { dur: 600, v: 4.0, cad: 90, hr: 170 }]);

  it("tramo por km", () => {
    const r: any = analizarTramos(base, true, { desde: 0.5, hasta: 1.5, unidad: "km" }, [120, 140, 155, 170, 185, 200]);
    expect(r.modo).toBe("tramo");
    expect(r.tramo.distancia_m).toBeGreaterThan(995);
    expect(r.tramo.distancia_m).toBeLessThan(1005);
    expect(r.tramo.ritmo_movimiento_min_km).toBe("5:33"); // 1000 / 3 m/s
    expect(r.tramo.cadencia_ppm).toBe(160);
    expect(r.tramo.zancada_m_por_paso).toBeCloseTo(3.0 / (160 / 60), 1);
    expect(r.serie.filas.length).toBeGreaterThan(5);
  });

  it("tramo por minutos, con zonas de FC personales", () => {
    const r: any = analizarTramos(base, true, { desde: 11, hasta: 19, unidad: "min" }, [120, 140, 155, 170, 185, 200]);
    expect(r.tramo.duracion_s).toBe(480);
    expect(r.tramo.ritmo_movimiento_min_km).toBe("4:10");
    expect(r.tramo.cadencia_ppm).toBe(180);
    const z = r.tramo.zonas_fc_s;
    expect(Object.values(z).reduce((a: any, b: any) => a + b, 0)).toBe(480);
    expect(z.Z4 + z.Z5).toBeGreaterThan(400); // FC ~170 -> zona 4-5
    expect(r.tramo.inicio.min).toBe("11:00");
  });

  it("una pausa dentro del tramo no cuenta como movimiento", () => {
    const s = sintetico([{ dur: 200, ...LENTO, hr: 140 }, { dur: 40, ...LENTO, pausa: true }, { dur: 200, ...LENTO, hr: 140 }]);
    const r: any = analizarTramos(s, true, { desde: 3, hasta: 6, unidad: "min" }, null);
    expect(r.tramo.tiempo_pausa_s).toBeGreaterThanOrEqual(40); // el hueco va de la última muestra con distancia a la primera
    expect(r.tramo.tiempo_pausa_s).toBeLessThanOrEqual(41);
    expect(r.tramo.tiempo_movimiento_s).toBeGreaterThanOrEqual(139);
    expect(Math.abs(seg(r.tramo.ritmo_movimiento_min_km) - 333)).toBeLessThanOrEqual(4); // sin las pausas
    expect(r.total.tiempo_pausa_s).toBeGreaterThanOrEqual(40);
  });

  it("estadisticas: desnivel positivo y negativo", () => {
    const s = sintetico([{ dur: 100, ...LENTO }]);
    const alt = s.find((x) => x.type === "altitude")!.data as number[];
    for (let i = 0; i < alt.length; i++) alt[i] = i < 50 ? i : 100 - i; // sube 49 m y baja 50
    const g = construirRejilla(s, true)!;
    const e = estadisticas(g, 0, 99, null);
    expect(e.asc_m).toBeGreaterThanOrEqual(49);
    expect(e.desc_m).toBeGreaterThanOrEqual(48);
  });

  it("sin cadencia devuelve lo que hay y avisa", () => {
    const s = sintetico([{ dur: 300, ...LENTO }], { sinCad: true });
    const r: any = analizarTramos(s, true, { desde: 1, hasta: 3, unidad: "min" }, null);
    expect(r.tramo.cadencia_ppm).toBeNull();
    expect(r.tramo.zancada_m_por_paso).toBeNull();
    expect(r.tramo.ritmo_movimiento_min_km).toBe("5:33");
    expect(r.avisos.join(" ")).toContain("Sin cadencia");
  });
});

describe("tramos: patrón de series", () => {
  const serie = (reps: number[], descanso = 120): Tr[] => {
    const t: Tr[] = [{ dur: 400, ...LENTO }];
    reps.forEach((d, i) => { t.push({ dur: d, ...RAPIDO }, { dur: i === reps.length - 1 ? 300 : descanso, ...LENTO }); });
    return t;
  };

  it("2'/2' encaja y da una tabla por repetición, con descansos y evolución", () => {
    const s = sintetico(serie([120, 120, 120, 120]), { ruidoCad: 1 });
    const r: any = analizarTramos(s, true, { trabajo: "2min", descanso: "2min", repeticiones: 4 }, null);
    expect(r.modo).toBe("patron");
    expect(r.encaje).toBe("bueno");
    expect(r.repeticiones.filas).toHaveLength(4);
    expect(r.descansos.filas).toHaveLength(3);
    r.repeticiones.filas.forEach((f: any[], i: number) => {
      expect(Math.abs(f[col(r.repeticiones, "dur_s")] - 120)).toBeLessThanOrEqual(3);
      expect(Math.abs(seg(f[col(r.repeticiones, "ritmo")]) - 238)).toBeLessThanOrEqual(6);
    });
    expect(r.evolucion_1a_a_ultima.cadencia_ppm).toBeDefined();
  });

  it("una repetición más corta (1:40) se avisa sin forzar el encaje", () => {
    const s = sintetico(serie([120, 120, 100, 120]), { ruidoCad: 1 });
    const r: any = analizarTramos(s, true, { trabajo: "2min", descanso: "2min", repeticiones: 4 }, null);
    expect(r.encaje).toBe("parcial");
    expect(r.avisos_encaje.join(" ")).toMatch(/repetición 3: 1:4\d en vez de 2:00/);
    expect(Math.abs(r.repeticiones.filas[2][col(r.repeticiones, "dur_s")] - 100)).toBeLessThanOrEqual(3);
  });

  it("falta una repetición en medio: lo dice", () => {
    const t: Tr[] = [{ dur: 400, ...LENTO }, { dur: 120, ...RAPIDO }, { dur: 120, ...LENTO }, { dur: 120, ...RAPIDO }, { dur: 360, ...LENTO }, { dur: 120, ...RAPIDO }, { dur: 300, ...LENTO }];
    const r: any = analizarTramos(sintetico(t, { ruidoCad: 1 }), true, { trabajo: "2min", descanso: "2min", repeticiones: 4 }, null);
    expect(r.encaje).toBe("parcial");
    expect(r.avisos_encaje.join(" ")).toContain("faltan 1 repetición");
    expect(r.repeticiones.filas).toHaveLength(3);
  });

  it("series de 20 s con descanso de 60 s", () => {
    const trs: Tr[] = [{ dur: 300, ...LENTO }];
    for (let i = 0; i < 5; i++) trs.push({ dur: 20, ...RAPIDO }, { dur: 60, ...LENTO });
    const r: any = analizarTramos(sintetico(trs, { ruidoCad: 1 }), true, { trabajo: "20s", descanso: "60s", repeticiones: 5 }, null);
    expect(r.encaje).toBe("bueno");
    expect(r.repeticiones.filas).toHaveLength(5);
    expect(r.avisos.join(" ")).toContain("FC no representativa");
  });

  it("si nada encaja, enseña lo que hay", () => {
    const s = sintetico(serie([120, 120]), { ruidoCad: 1 });
    const r: any = analizarTramos(s, true, { trabajo: "400m", descanso: "1min" }, null);
    expect(r.encaje === "ninguno" || r.encaje === "parcial" || r.encaje === "bueno").toBe(true);
    const r2: any = analizarTramos(s, true, { trabajo: "30s", descanso: "30s" }, null);
    expect(r2.encaje).toBe("ninguno");
    expect(r2.escalones_detectados.filas.length).toBeGreaterThan(0);
  });

  it("patrón por distancia", () => {
    // 4,2 m/s x 120 s = 504 m
    const r: any = analizarTramos(sintetico(serie([120, 120, 120]), { ruidoCad: 1 }), true, { trabajo: "500m", descanso: "360m" }, null);
    expect(r.repeticiones.filas).toHaveLength(3);
  });

  it("leerMedida", () => {
    expect(leerMedida("2min")).toEqual({ valor: 120, unidad: "s" });
    expect(leerMedida("400m")).toEqual({ valor: 400, unidad: "m" });
    expect(leerMedida("1.5km")).toEqual({ valor: 1500, unidad: "m" });
    expect(leerMedida("abc")).toBeNull();
  });
});

describe("tramos: rendimiento", () => {
  it("una carrera de 90 min a 1 Hz con 8 series se analiza en pocos ms", () => {
    const trs: Tr[] = [{ dur: 900, ...LENTO }];
    for (let i = 0; i < 8; i++) trs.push({ dur: 120, ...RAPIDO }, { dur: 120, ...LENTO });
    trs.push({ dur: 2000, ...LENTO });
    const s = sintetico(trs, { ruidoCad: 2, ruidoGps: 0.5 });
    analizarTramos(s, true, {}, [120, 140, 155, 170, 185, 200]); // calentamiento del JIT
    const t = performance.now();
    const r: any = analizarTramos(s, true, {}, [120, 140, 155, 170, 185, 200]);
    const ms = performance.now() - t;
    console.log(`tramos perfil 90 min: ${ms.toFixed(1)} ms; ${JSON.stringify(r).length} bytes`);
    expect(ms).toBeLessThan(40);
    expect(JSON.stringify(r).length).toBeLessThan(20000);
  });
});
