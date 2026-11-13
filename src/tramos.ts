/**
 * tramos: perfil, escalones detectados, medias de un tramo y patrón de series, a partir de los streams de
 * intervals.icu pedidos en el momento (no se guardan). Solo lectura. Los cálculos están documentados en
 * docs/procedencia-datos.md (sección "tramos").
 */
import { type Env } from "./env";
import { A_PIE, intervalsClient, mmss, round, type Row, rows } from "./format";
import { leerLimites, MIN_SPEED_HUECO, zonaFc } from "./splits";

const STREAMS = ["time", "distance", "heartrate", "cadence", "altitude"];
const MIN_DURACION_DEF = 10; // s: duración mínima de un escalón (ajustable)
const VENTANA_MAX = 6; // s: mitad de la ventana de detección
const UMBRAL_CAD_MIN = 5; // ppm
const UMBRAL_VEL_MIN = 0.5; // m/s
const FC_FIABLE_S = 30; // por debajo, la FC (que va 20-30 s retrasada) no representa el tramo
const MAX_PUNTOS = 400;
const MAX_ESCALONES = 60;

// --- rejilla a 1 Hz -----------------------------------------------------------------------------------------------
/** Los streams en segundos (índice k = k segundos desde la primera muestra con distancia). */
export interface Rejilla {
  n: number; t0: number; time: any[];
  dist: Float64Array; hr: Float64Array; cad: Float64Array; alt: Float64Array; vel: Float64Array;
  mov: Uint8Array; // 1 = el segundo [k, k+1) es en movimiento
  hayCad: boolean; hayHr: boolean; hayAlt: boolean;
}

/** Misma regla de pausa que los parciales (splits.ts): un hueco sin distancia que avanza menos de 0,5 m/s. */
export function construirRejilla(streams: any[], aPie: boolean): Rejilla | null {
  const get = (t: string): any[] => streams.find((s) => s?.type === t)?.data ?? [];
  const time = get("time"), dist = get("distance"), hr = get("heartrate"), cad = get("cadence"), alt = get("altitude");
  let first = 0, end = Math.min(time.length, dist.length);
  while (first < end && dist[first] == null) first++;
  while (end > first && dist[end - 1] == null) end--;
  if (end - first < 2) return null;
  const t0 = time[first];
  const n = Math.floor(time[end - 1] - t0);
  if (n < 2) return null;
  const D = new Float64Array(n + 1), H = new Float64Array(n + 1).fill(NaN), C = new Float64Array(n + 1).fill(NaN);
  const A = new Float64Array(n + 1).fill(NaN), mov = new Uint8Array(n + 1);
  let prev = first;
  for (let i = first + 1; i < end; i++) {
    if (dist[i] == null) continue;
    const ta = time[prev] - t0, tb = time[i] - t0, dt = tb - ta;
    if (dt <= 0) { prev = i; continue; }
    const pausa = i - prev > 1 && (dist[i] - dist[prev]) / dt < MIN_SPEED_HUECO;
    for (let k = Math.max(0, Math.ceil(ta)); k < Math.ceil(tb) && k <= n; k++) {
      D[k] = dist[prev] + ((k - ta) / dt) * (dist[i] - dist[prev]);
      mov[k] = pausa ? 0 : 1;
    }
    prev = i;
  }
  D[n] = dist[end - 1]; mov[n] = 0;
  // Rellena hasta 2 s hacia delante (las muestras pueden ir cada 2 s)
  const rellenar = (x: Float64Array) => {
    let ult = -9;
    for (let k = 0; k <= n; k++) { if (!Number.isNaN(x[k])) ult = k; else if (ult >= 0 && k - ult <= 2) x[k] = x[ult]; }
  };
  const poner = (serie: any[], dst: Float64Array, valido: (v: number) => boolean, f: (v: number) => number) => {
    for (let j = first; j < end; j++) {
      const v = serie[j];
      if (typeof v !== "number" || !valido(v)) continue;
      const k = Math.round(time[j] - t0);
      if (k >= 0 && k <= n) dst[k] = f(v);
    }
    rellenar(dst);
  };
  poner(hr, H, (v) => v > 0, (v) => v);
  poner(cad, C, (v) => v > 0, (v) => (aPie ? v * 2 : v));
  poner(alt, A, () => true, (v) => v); // la altitud puede ser 0 o negativa
  // Velocidad: distancia entre k-3 y k+3 s (la distancia va a saltos de metro entero)
  const V = new Float64Array(n + 1);
  for (let k = 0; k <= n; k++) {
    if (!mov[k]) { V[k] = NaN; continue; }
    const lo = Math.max(0, k - 3), hi = Math.min(n, k + 3);
    V[k] = (D[hi] - D[lo]) / (hi - lo);
  }
  let nMov = 0, nCad = 0, nHr = 0, nAlt = 0;
  for (let k = 0; k <= n; k++) {
    if (mov[k]) nMov++;
    if (mov[k] && !Number.isNaN(C[k])) nCad++;
    if (!Number.isNaN(H[k])) nHr++;
    if (!Number.isNaN(A[k])) nAlt++;
  }
  return { n, t0, time, dist: D, hr: H, cad: C, alt: A, vel: V, mov, hayCad: nCad >= 0.5 * nMov && nCad > 0, hayHr: nHr > 0, hayAlt: nAlt > 0 };
}

// --- medias de un tramo --------------------------------------------------------------------------------------------
export interface Estad {
  dur_s: number; mov_s: number; pausa_s: number; dist_m: number; ritmo_s_km: number | null;
  fc: number | null; fc_max: number | null; cad: number | null; zancada_m: number | null;
  asc_m: number; desc_m: number; zonas_s: number[] | null; fc_fiable: boolean;
}

/** Estadísticas de los segundos [a, b). Ritmo = segundos en movimiento / km recorridos (no media de velocidades). */
export function estadisticas(g: Rejilla, a: number, b: number, limites: number[] | null): Estad {
  a = Math.max(0, Math.round(a)); b = Math.min(g.n, Math.round(b));
  let mov = 0, hrS = 0, hrN = 0, hrMax = 0, cadS = 0, cadN = 0, asc = 0, desc = 0;
  const zonas = limites ? new Array(7).fill(0) : null;
  for (let k = a; k < b; k++) {
    if (!g.mov[k]) continue;
    mov++;
    const h = g.hr[k], c = g.cad[k];
    if (!Number.isNaN(h)) { hrS += h; hrN++; if (h > hrMax) hrMax = h; if (zonas) zonas[Math.min(zonaFc(h, limites!), 6)]++; }
    if (!Number.isNaN(c)) { cadS += c; cadN++; }
    const x = g.alt[k], y = g.alt[k + 1];
    if (!Number.isNaN(x) && !Number.isNaN(y)) { if (y > x) asc += y - x; else desc += x - y; }
  }
  const dist = Math.max(0, g.dist[b] - g.dist[a]);
  const cad = cadN ? cadS / cadN : null;
  return {
    dur_s: b - a, mov_s: mov, pausa_s: b - a - mov, dist_m: Math.round(dist),
    ritmo_s_km: mov > 0 && dist > 0 ? Math.round(mov / (dist / 1000)) : null,
    fc: hrN ? round(hrS / hrN, 0) : null, fc_max: hrN ? hrMax : null,
    cad: cad != null ? round(cad, 0) : null,
    zancada_m: cad && mov > 0 && dist > 0 ? round(dist / ((cad * mov) / 60), 2) : null,
    asc_m: Math.round(asc), desc_m: Math.round(desc), zonas_s: zonas, fc_fiable: b - a >= FC_FIABLE_S,
  };
}

// --- detección de escalones -------------------------------------------------------------------------------------------
export interface Escalon {
  a: number; b: number; dir: "más rápido" | "más lento"; delta: number; confianza: "claro" | "difuso";
  anchoA: number; anchoB: number;
}
export interface Deteccion { senal: "cadencia" | "ritmo"; umbral: number; escalones: Escalon[]; unidad: string }

const mediana = (xs: number[]) => {
  if (!xs.length) return NaN;
  const s = xs.slice().sort((p, q) => p - q), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Escalones: segmentación por cambios de nivel de la señal (cadencia; ritmo si falta o se pide).
 * 1) D[k] = media de [k, k+W) - media de [k-W, k), con W = min_duracion/2 (3-6 s). Un borde es un máximo local de |D|
 *    (en ±W s) con |D| >= 0,7 x umbral. 2) Entre bordes, cada segmento tiene un nivel (media sin 2 s de cada lado).
 * 3) Es escalón si dura al menos min_duracion - 4 s (antes del ajuste) y su nivel difiere >= umbral del de lo que
 *    tiene alrededor (media de los niveles vecinos). 4) Los bordes se ajustan sobre los datos de 1 Hz sin suavizar:
 *    el primer segundo (de 3 seguidos) que pasa del punto medio entre su nivel y el del vecino, buscando a ±8 s.
 * umbral = max(suelo, 0,35 x (p90 - p10) de la señal): suelo 5 ppm o max(0,5 m/s, 12 % de la mediana).
 */
export function detectar(g: Rejilla, minDur = MIN_DURACION_DEF, forzarRitmo = false): Deteccion {
  const usaCad = g.hayCad && !forzarRitmo;
  const sig = usaCad ? g.cad : g.vel;
  const n = g.n;
  const P = new Float64Array(n + 2), Q = new Float64Array(n + 2);
  for (let k = 0; k <= n; k++) {
    const ok = g.mov[k] && !Number.isNaN(sig[k]);
    P[k + 1] = P[k] + (ok ? sig[k] : 0); Q[k + 1] = Q[k] + (ok ? 1 : 0);
  }
  const media = (a: number, b: number, minN: number) => {
    a = Math.max(0, a); b = Math.min(n + 1, b);
    const c = b > a ? Q[b] - Q[a] : 0;
    return c >= minN ? (P[b] - P[a]) / c : NaN;
  };
  const W = Math.max(3, Math.min(VENTANA_MAX, Math.round(minDur / 2)));
  const minN = Math.ceil(W * 0.6);
  const vals: number[] = [];
  for (let k = 0; k <= n; k += 3) if (g.mov[k] && !Number.isNaN(sig[k])) vals.push(sig[k]);
  vals.sort((p, q) => p - q);
  const pc = (p: number) => (vals.length ? vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] : 0);
  const suelo = usaCad ? UMBRAL_CAD_MIN : Math.max(UMBRAL_VEL_MIN, 0.12 * pc(0.5));
  const umbral = Math.max(suelo, 0.35 * (pc(0.9) - pc(0.1)));
  const res: Deteccion = { senal: usaCad ? "cadencia" : "ritmo", umbral: round(umbral, 2), escalones: [], unidad: usaCad ? "ppm" : "m/s" };
  if (vals.length < 20) return res;

  const Dd = new Float64Array(n + 1);
  for (let k = W; k <= n - W; k++) {
    const m1 = media(k - W, k, minN), m2 = media(k, k + W, minN);
    Dd[k] = Number.isNaN(m1) || Number.isNaN(m2) ? 0 : m2 - m1;
  }
  const bordes: number[] = [];
  for (let k = W; k <= n - W; k++) {
    const v = Math.abs(Dd[k]);
    if (v < 0.7 * umbral) continue;
    let max = true;
    for (let j = Math.max(W, k - W); j <= Math.min(n - W, k + W) && max; j++) {
      const w = Math.abs(Dd[j]);
      if (w > v || (w === v && j < k)) max = false;
    }
    if (max) bordes.push(k);
  }
  const lim = [0, ...bordes, n];
  type Seg = { a: number; b: number; nivel: number; med: number };
  const seg: Seg[] = [];
  for (let i = 0; i + 1 < lim.length; i++) {
    const a = lim[i], b = lim[i + 1];
    let nivel = media(a + 2, b - 2, 3);
    if (Number.isNaN(nivel)) nivel = media(a, b, 3);
    const interior: number[] = [];
    for (let k = a + 3; k < b - 3; k++) if (g.mov[k] && !Number.isNaN(sig[k])) interior.push(sig[k]);
    seg.push({ a, b, nivel, med: interior.length >= 3 ? mediana(interior) : nivel });
  }
  const valido = (x?: Seg): x is Seg => x !== undefined && !Number.isNaN(x.nivel);
  const medio = (x: Seg) => (Number.isNaN(x.med) ? x.nivel : x.med);

  // Anchura de la transición (s entre el 20 % y el 80 % del salto) con media de 3 s: "desde" -> "hasta" cerca de "centro"
  const suave = (k: number) => media(k - 1, k + 2, 2);
  const ancho = (centro: number, desde: number, hasta: number): number => {
    const f = (k: number) => (suave(k) - desde) / (hasta - desde);
    let k80 = -1;
    for (let k = centro - 15; k <= centro + 15; k++) { const v = f(k); if (v >= 0.8) { k80 = k; break; } }
    if (k80 < 0) return Infinity;
    let k20 = -1;
    for (let k = k80; k >= centro - 30; k--) { const v = f(k); if (v <= 0.2) { k20 = k; break; } }
    return k20 < 0 ? Infinity : k80 - k20;
  };

  let ultimoFin = -1;
  for (let i = 0; i < seg.length; i++) {
    const s = seg[i];
    if (!valido(s) || s.b - s.a < Math.max(4, minDur - 4)) continue;
    const vecinos = [seg[i - 1], seg[i + 1]].filter(valido);
    if (!vecinos.length) continue;
    const alrededor = vecinos.reduce((t, v) => t + v.nivel, 0) / vecinos.length;
    const diff = s.nivel - alrededor;
    if (Math.abs(diff) < umbral) continue;
    const signo = diff > 0 ? 1 : -1;
    const dentro = medio(s);
    const ant = seg[i - 1], sigu = seg[i + 1];
    const fuera = (x?: Seg) => (valido(x) ? medio(x) : NaN);
    const fA = Number.isNaN(fuera(ant)) ? fuera(sigu) : fuera(ant);
    const fB = Number.isNaN(fuera(sigu)) ? fuera(ant) : fuera(sigu);
    const midA = (dentro + fA) / 2, midB = (dentro + fB) / 2;
    const dentroEn = (k: number, mid: number) => k <= n && g.mov[k] === 1 && !Number.isNaN(sig[k]) && signo * (sig[k] - mid) > 0;
    const fueraEn = (k: number, mid: number) => k <= n && g.mov[k] === 1 && !Number.isNaN(sig[k]) && signo * (sig[k] - mid) <= 0;
    let ini = s.a;
    for (let k = Math.max(0, s.a - 8); k <= s.a + 8; k++) {
      if (dentroEn(k, midA) && dentroEn(k + 1, midA) && dentroEn(k + 2, midA)) { ini = k; break; }
    }
    let fin = s.b;
    for (let k = Math.max(ini + 1, s.b - 8); k <= s.b + 8; k++) {
      if (fueraEn(k, midB) && fueraEn(k + 1, midB) && fueraEn(k + 2, midB)) { fin = k; break; }
    }
    fin = Math.min(fin, n);
    if (fin - ini < minDur || ini < ultimoFin) continue;
    const aA = ancho(ini, fA, dentro), aB = ancho(fin, dentro, fB);
    ultimoFin = fin;
    res.escalones.push({
      a: ini, b: fin, dir: diff > 0 ? "más rápido" : "más lento",
      delta: round(diff, 2), confianza: aA <= 6 && aB <= 6 ? "claro" : "difuso", anchoA: aA, anchoB: aB,
    });
    if (res.escalones.length >= MAX_ESCALONES) break;
  }
  return res;
}

// --- presentación -------------------------------------------------------------------------------------------------
const mmssT = (s: number) => mmss(s)!;
const kmDe = (g: Rejilla, k: number) => round((g.dist[k] - g.dist[0]) / 1000, 2);

/** Perfil: ritmo, cadencia y FC cada `res` segundos (medias del trozo; el ritmo, con la distancia del trozo). */
export function perfil(g: Rejilla, res: number, desde = 0, hasta = g.n) {
  const filas: any[][] = [];
  for (let a = desde; a < hasta; a += res) {
    const b = Math.min(hasta, a + res);
    let mov = 0, hs = 0, hn = 0, cs = 0, cn = 0;
    for (let k = a; k < b; k++) {
      if (!g.mov[k]) continue;
      mov++;
      if (!Number.isNaN(g.hr[k])) { hs += g.hr[k]; hn++; }
      if (!Number.isNaN(g.cad[k])) { cs += g.cad[k]; cn++; }
    }
    const d = g.dist[b] - g.dist[a];
    if (mov < Math.max(1, res / 3)) continue;
    const medio = Math.round(a + (b - a) / 2);
    filas.push([mmssT(medio), kmDe(g, medio), d > 0 ? mmssT(mov / (d / 1000)) : null,
      cn ? Math.round(cs / cn) : null, hn ? Math.round(hs / hn) : null]);
  }
  return { resolucion_s: res, columnas: ["t_medio", "km", "ritmo", "cad_ppm", "fc"], filas };
}

const COLS_TRAMO = ["n", "inicio", "fin", "inicio_km", "fin_km", "dur_s", "dist_m", "ritmo", "cad_ppm", "fc", "fc_max", "fc_ok", "zancada_m", "confianza"];
function filaTramo(g: Rejilla, n: number | string, a: number, b: number, e: Estad, confianza: string | null, extra: any[] = []) {
  return [n, mmssT(a), mmssT(b), kmDe(g, a), kmDe(g, b), e.dur_s, e.dist_m, e.ritmo_s_km != null ? mmssT(e.ritmo_s_km) : null,
    e.cad, e.fc, e.fc_max, e.fc_fiable, e.zancada_m, confianza, ...extra];
}

function resumenTramo(g: Rejilla, a: number, b: number, e: Estad) {
  return {
    inicio: { min: mmssT(a), km: kmDe(g, a) }, fin: { min: mmssT(b), km: kmDe(g, b) },
    duracion_s: e.dur_s, tiempo_movimiento_s: e.mov_s, tiempo_pausa_s: e.pausa_s, distancia_m: e.dist_m,
    ritmo_movimiento_min_km: e.ritmo_s_km != null ? mmssT(e.ritmo_s_km) : null,
    fc_media: e.fc, fc_max: e.fc_max, cadencia_ppm: e.cad, zancada_m_por_paso: e.zancada_m,
    desnivel_positivo_m: e.asc_m, desnivel_negativo_m: e.desc_m,
    zonas_fc_s: e.zonas_s ? Object.fromEntries(e.zonas_s.map((s, i) => [`Z${i + 1}`, s])) : null,
    ...(e.fc_fiable ? {} : { aviso_fc: "tramo de menos de 30 s: la FC va 20-30 s retrasada y no es representativa" }),
  };
}

// --- patrón de series -----------------------------------------------------------------------------------------------
export interface Medida { valor: number; unidad: "s" | "m" }
/** "120s", "2min", "400m", "1.5km" (un número solo = segundos). */
export function leerMedida(v: unknown): Medida | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*(s|seg|min|m|km)?\s*$/i.exec(String(v ?? ""));
  if (!m) return null;
  const x = Number(m[1].replace(",", ".")), u = (m[2] ?? "s").toLowerCase();
  return u === "min" ? { valor: x * 60, unidad: "s" } : u === "km" ? { valor: x * 1000, unidad: "m" } : { valor: x, unidad: u === "m" ? "m" : "s" };
}

interface Rep { esc: Escalon; tam: number; faltan: number }

function ajustarPatron(g: Rejilla, det: Deteccion, trabajo: Medida, descanso: Medida, reps?: number) {
  const med = (a: number, b: number, u: "s" | "m") => (u === "s" ? b - a : g.dist[b] - g.dist[a]);
  const rapidos = det.escalones.filter((e) => e.dir === "más rápido");
  const cand = rapidos.map((e) => ({ e, tam: med(e.a, e.b, trabajo.unidad) }))
    .filter((c) => Math.abs(c.tam / trabajo.valor - 1) <= 0.3);
  const tolDesc = 0.4 * descanso.valor + (descanso.unidad === "s" ? 4 : 10);
  // Cadena más larga de repeticiones separadas por ~descanso (o por descanso + las series que falten en medio)
  const best: { len: number; err: number; prev: number }[] = [];
  let mejor = -1;
  for (let j = 0; j < cand.length; j++) {
    best[j] = { len: 1, err: Math.abs(cand[j].tam / trabajo.valor - 1), prev: -1 };
    for (let i = 0; i < j; i++) {
      const gap = med(cand[i].e.b, cand[j].e.a, descanso.unidad);
      if (gap < 0) continue;
      const m = Math.max(0, Math.round((gap - descanso.valor) / (trabajo.valor + descanso.valor)));
      if (Math.abs(gap - (descanso.valor + m * (trabajo.valor + descanso.valor))) > tolDesc) continue;
      const len = best[i].len + 1, err = best[i].err + Math.abs(cand[j].tam / trabajo.valor - 1);
      if (len > best[j].len || (len === best[j].len && err < best[j].err)) best[j] = { len, err, prev: i };
    }
    if (mejor < 0 || best[j].len > best[mejor].len || (best[j].len === best[mejor].len && best[j].err < best[mejor].err)) mejor = j;
  }
  const cadena: Rep[] = [];
  for (let j = mejor; j >= 0; j = best[j].prev) cadena.unshift({ esc: cand[j].e, tam: cand[j].tam, faltan: 0 });
  for (let i = 1; i < cadena.length; i++) { // series que faltan antes de la repetición i
    const gap = med(cadena[i - 1].esc.b, cadena[i].esc.a, descanso.unidad);
    cadena[i].faltan = Math.max(0, Math.round((gap - descanso.valor) / (trabajo.valor + descanso.valor)));
  }
  const enCadena = new Set(cadena.map((c) => c.esc));
  const aviso: string[] = [];
  const fmtTam = (x: number) => (trabajo.unidad === "s" ? mmssT(x) : `${Math.round(x)} m`);
  cadena.forEach((c, i) => {
    if (Math.abs(c.tam / trabajo.valor - 1) > 0.1) aviso.push(`repetición ${i + 1}: ${fmtTam(c.tam)} en vez de ${fmtTam(trabajo.valor)}`);
    if (c.faltan) aviso.push(`faltan ${c.faltan} repetición(es) antes de la ${i + 1}`);
  });
  const faltanTotal = cadena.reduce((t, c) => t + c.faltan, 0);
  if (reps && cadena.length + faltanTotal !== reps) aviso.push(`pedías ${reps} repeticiones y encajan ${cadena.length}${faltanTotal ? ` (más ${faltanTotal} que faltan en medio)` : ""}`);
  return { cadena, otros: rapidos.filter((e) => !enCadena.has(e)), aviso };
}

// --- herramienta ---------------------------------------------------------------------------------------------------------
export interface ArgsTramos {
  id?: string; desde?: number; hasta?: number; unidad?: "km" | "min"; resolucion?: number;
  min_duracion_s?: number; senal?: "cadencia" | "ritmo"; trabajo?: string; descanso?: string; repeticiones?: number;
}

const indiceDe = (g: Rejilla, valor: number, unidad: "km" | "min"): number => {
  if (unidad === "min") return Math.max(0, Math.min(g.n, Math.round(valor * 60)));
  const objetivo = g.dist[0] + valor * 1000;
  for (let k = 0; k <= g.n; k++) if (g.dist[k] >= objetivo) return k;
  return g.n;
};

const FC_AVISO = "FC no representativa en tramos de menos de 30 s (va 20-30 s retrasada).";

/** Cálculo puro sobre streams (lo que prueban los tests). */
export function analizarTramos(streams: any[], aPie: boolean, args: ArgsTramos, limites: number[] | null, vueltas: unknown = null): Row {
  const g = construirRejilla(streams, aPie);
  if (!g) return { error: "Los streams no traen distancia suficiente para analizar tramos." };
  const avisos: string[] = [];
  if (!g.hayCad) avisos.push("Sin cadencia en esta actividad: los escalones y sus bordes se detectan con el ritmo (GPS), con más margen de error (varios segundos).");
  if (!g.hayHr) avisos.push("Sin FC en esta actividad.");
  if (!g.hayAlt) avisos.push("Sin altitud en esta actividad: no hay desnivel.");
  const minDur = Math.max(4, args.min_duracion_s ?? MIN_DURACION_DEF);
  const forzar = args.senal === "ritmo";
  if (forzar && g.hayCad) avisos.push("Detección forzada por ritmo (GPS): más margen de error en los bordes.");
  const trabajo = args.trabajo != null ? leerMedida(args.trabajo) : null, descanso = args.descanso != null ? leerMedida(args.descanso) : null;
  if ((args.trabajo != null && !trabajo) || (args.descanso != null && !descanso)) return { error: 'trabajo y descanso van como "120s", "2min" o "400m".' };
  if (!trabajo !== !descanso) return { error: "El patrón necesita trabajo y descanso a la vez." };
  let pausa = 0;
  for (let k = 0; k < g.n; k++) if (!g.mov[k]) pausa++;
  const out: Row = { total: { km: kmDe(g, g.n), duracion: mmssT(g.n), tiempo_pausa_s: pausa } };
  const tabla = (filas: any[][], columnas: string[]) => ({ columnas, filas });

  if (trabajo && descanso) {
    const det = detectar(g, minDur, forzar);
    const { cadena, otros, aviso } = ajustarPatron(g, det, trabajo, descanso, args.repeticiones);
    out.modo = "patron";
    out.senal = det.senal;
    if (!cadena.length) {
      out.encaje = "ninguno";
      out.aviso = "Ningún escalón rápido encaja con el patrón pedido (±30 % en el trabajo). Esto es lo que se detecta en realidad (escalones_detectados).";
      out.escalones_detectados = filasEscalones(g, det, limites);
      out.avisos = avisos;
      return out;
    }
    const ests = cadena.map((c) => estadisticas(g, c.esc.a, c.esc.b, limites));
    out.encaje = aviso.length ? "parcial" : "bueno";
    if (aviso.length) out.avisos_encaje = aviso;
    out.repeticiones = tabla(cadena.map((c, i) => filaTramo(g, i + 1, c.esc.a, c.esc.b, ests[i], c.esc.confianza)), COLS_TRAMO);
    const descs: any[][] = [];
    for (let i = 1; i < cadena.length; i++) {
      if (cadena[i].faltan) continue;
      const a = cadena[i - 1].esc.b, b = cadena[i].esc.a;
      descs.push(filaTramo(g, `${i}-${i + 1}`, a, b, estadisticas(g, a, b, limites), null));
    }
    out.descansos = tabla(descs, COLS_TRAMO);
    if (ests.length > 1) {
      const p = ests[0], u = ests[ests.length - 1];
      const dif = (x: number | null, y: number | null) => (x != null && y != null ? round(y - x, 1) : null);
      out.evolucion_1a_a_ultima = {
        cadencia_ppm: dif(p.cad, u.cad), ritmo_s_km: dif(p.ritmo_s_km, u.ritmo_s_km), fc_media: dif(p.fc, u.fc), fc_max: dif(p.fc_max, u.fc_max),
        nota: "ultima menos primera; ritmo negativo = más rápido",
      };
    }
    if (otros.length) out.otros_escalones_rapidos = filasEscalones(g, { ...det, escalones: otros }, limites);
    const v = compararVueltas(vueltas, g, cadena.map((c) => c.esc)); if (v) out.vueltas_reloj = v;
    if (ests.some((e) => !e.fc_fiable)) avisos.push(FC_AVISO);
    out.avisos = avisos;
    return out;
  }

  if (args.desde != null || args.hasta != null) {
    const u = args.unidad ?? "km";
    const a = args.desde != null ? indiceDe(g, args.desde, u) : 0, b = args.hasta != null ? indiceDe(g, args.hasta, u) : g.n;
    if (b - a < 2) return { ...out, error: "El tramo es demasiado corto o está fuera de la actividad." };
    const e = estadisticas(g, a, b, limites);
    const res = Math.max(args.resolucion ?? Math.min(30, Math.max(2, Math.round((b - a) / 40))), Math.ceil((b - a) / MAX_PUNTOS));
    out.modo = "tramo";
    out.tramo = resumenTramo(g, a, b, e);
    out.serie = perfil(g, Math.max(1, res), a, b);
    if (!e.fc_fiable) avisos.push(FC_AVISO);
    out.avisos = avisos;
    return out;
  }

  const det = detectar(g, minDur, forzar);
  out.modo = "perfil";
  out.perfil = perfil(g, Math.max(5, args.resolucion ?? 30, Math.ceil(g.n / MAX_PUNTOS)));
  out.escalones_detectados = filasEscalones(g, det, limites);
  out.criterio = `senal=${det.senal}; umbral=${det.umbral} ${det.unidad}; duración mínima=${minDur} s; bordes en el punto medio entre niveles, sobre datos de 1 Hz`;
  const v = compararVueltas(vueltas, g, det.escalones); if (v) out.vueltas_reloj = v;
  if (det.escalones.some((s) => s.b - s.a < FC_FIABLE_S)) avisos.push(FC_AVISO + " Mira fc_ok.");
  out.avisos = avisos;
  return out;
}

function filasEscalones(g: Rejilla, det: Deteccion, limites: number[] | null) {
  const cols = [...COLS_TRAMO, "vs_alrededor", det.senal === "cadencia" ? "delta_ppm" : "delta_m_s"];
  const filas = det.escalones.map((s, i) => filaTramo(g, i + 1, s.a, s.b, estadisticas(g, s.a, s.b, limites), s.confianza, [s.dir, s.delta]));
  return { columnas: cols, filas };
}

/** Compara los escalones con las vueltas del reloj (icu_intervals del raw), si las hay. Mejor esfuerzo. */
function compararVueltas(vueltas: unknown, g: Rejilla, escs: Escalon[]) {
  let v: any = vueltas;
  try { if (typeof v === "string") v = JSON.parse(v); } catch { return null; }
  if (!Array.isArray(v) || !v.length) return null;
  const seg: { a: number; b: number }[] = [];
  for (const x of v) {
    const a = g.time[x?.start_index], b = g.time[x?.end_index];
    if (typeof a === "number" && typeof b === "number") seg.push({ a: a - g.t0, b: b - g.t0 });
  }
  const filas: any[][] = [];
  escs.forEach((e, i) => {
    let mejor: { a: number; b: number } | null = null, ov = 0;
    for (const s of seg) { const o = Math.min(e.b, s.b) - Math.max(e.a, s.a); if (o > ov) { ov = o; mejor = s; } }
    if (mejor && ov >= 0.5 * (e.b - e.a)) filas.push([i + 1, mejor.a - e.a, mejor.b - e.b]);
  });
  return filas.length ? { columnas: ["escalon", "vuelta_menos_detectado_inicio_s", "vuelta_menos_detectado_fin_s"], filas } : null;
}

export async function tramos(env: Env, args: ArgsTramos): Promise<Row> {
  const filtro = args.id ? "a.id = ?" : "a.sport IN ('Run','TrailRun') AND a.distance_m >= 1000";
  const [a] = await rows(env, `SELECT a.id, a.date, a.sport, a.name, a.distance_m, json_extract(a.raw,'$.icu_hr_zones') AS zonas_fc,
      json_extract(a.raw,'$.icu_intervals') AS vueltas FROM activities a WHERE ${filtro} ORDER BY a.start_local DESC LIMIT 1`, ...(args.id ? [args.id] : []));
  if (!a) return { error: args.id ? `No existe la actividad ${args.id}.` : "No hay carreras." };
  if (!A_PIE.includes(a.sport)) return { error: "tramos solo vale para deportes a pie." };
  const client = intervalsClient(env);
  if (!client) return { error: "intervals.icu no está configurado: no se pueden pedir los streams." };
  let streams: any[];
  try { streams = await client.streams(a.id, STREAMS); } catch (e: any) { return { error: `No se pudieron pedir los streams a intervals.icu: ${String(e?.message ?? e)}` }; }
  const r = analizarTramos(streams, true, args, leerLimites(a.zonas_fc), a.vueltas);
  return { actividad: { id: a.id, fecha: a.date, nombre: a.name, deporte: a.sport }, ...r };
}
