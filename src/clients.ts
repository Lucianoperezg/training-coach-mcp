/**
 * Clientes HTTP de intervals.icu (puente con el reloj) y Hevy.
 * Cada llamada (y cada consulta a D1) consume 1 "subpetición": el plan gratuito de Workers
 * permite 50 por ejecución, así que llevamos la cuenta con un presupuesto.
 */
import type { Env } from "./env";

export class Budget {
  constructor(public left: number) {}
  /** Reserva n subpeticiones; devuelve false si no quedan suficientes. */
  take(n = 1): boolean {
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }
}

async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`HTTP ${res.status} en ${new URL(url).pathname}: ${body}`);
  }
  return res.json();
}

/**
 * Escritura: cualquier respuesta que no sea 2xx (404 incluido) es un error, nunca un "hecho".
 * Un 2xx con el cuerpo vacío o que no es JSON devuelve null: quien llama decide si le basta.
 */
async function sendJson(method: string, url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 200);
    throw new Error(`HTTP ${res.status} en ${new URL(url).pathname}: ${text}`);
  }
  try { return await res.json(); } catch { return null; }
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export class IntervalsClient {
  static BASE = "https://intervals.icu/api/v1";
  private auth: string;
  private athlete: string;

  constructor(env: Env) {
    // Autenticación básica: usuario literal "API_KEY", contraseña = tu clave
    this.auth = "Basic " + btoa(`API_KEY:${env.INTERVALS_API_KEY}`);
    this.athlete = env.INTERVALS_ATHLETE_ID || "0";
    this.base = env.INTERVALS_BASE_URL || IntervalsClient.BASE; // solo se cambia para pruebas
  }
  private base: string;

  private get(path: string, params: Record<string, string | number | undefined> = {}) {
    return getJson(`${this.base}${path}${qs(params)}`, { Authorization: this.auth });
  }

  /** null si la API no devuelve una lista (404, respuesta rara): el llamante NO debe borrar nada. */
  activities(oldest: string, newest: string): Promise<any[] | null> {
    return this.get(`/athlete/${this.athlete}/activities`, { oldest, newest }).then((r) => (Array.isArray(r) ? r : null));
  }
  wellness(oldest: string, newest: string): Promise<any[]> {
    return this.get(`/athlete/${this.athlete}/wellness`, { oldest, newest }).then((r) => r ?? []);
  }
  athleteProfile(): Promise<any> {
    return this.get(`/athlete/${this.athlete}`).then((r) => r ?? {});
  }
  activity(id: string): Promise<any> {
    return this.get(`/activity/${encodeURIComponent(id)}`).then((r) => r ?? {});
  }
  intervals(id: string): Promise<any> {
    return this.get(`/activity/${encodeURIComponent(id)}/intervals`).then((r) => r ?? {});
  }
  streams(id: string, types: string[]): Promise<any[]> {
    return this.get(`/activity/${encodeURIComponent(id)}/streams`, { types: types.join(",") }).then((r) => r ?? []);
  }
  /** Eventos del calendario (entrenos planificados, notas...) entre dos fechas locales, ambas incluidas. */
  events(oldest: string, newest: string): Promise<any[]> {
    return this.get(`/athlete/${this.athlete}/events`, { oldest, newest }).then((r) => (Array.isArray(r) ? r : []));
  }
  /** Un evento del calendario; null si no existe. */
  event(id: number): Promise<any> {
    return this.get(`/athlete/${this.athlete}/events/${id}`);
  }
  /** Crea un evento. Lanza error si intervals.icu no responde 2xx. */
  createEvent(event: Record<string, unknown>): Promise<any> {
    return sendJson("POST", `${this.base}/athlete/${this.athlete}/events${qs({ upsertOnUid: "false" })}`,
      { Authorization: this.auth }, event);
  }
  /** Modifica un evento. Lanza error si intervals.icu no responde 2xx. */
  updateEvent(id: number, event: Record<string, unknown>): Promise<any> {
    return sendJson("PUT", `${this.base}/athlete/${this.athlete}/events/${id}`, { Authorization: this.auth }, event);
  }
  /**
   * Borra un único evento. Lanza error si intervals.icu no responde 2xx.
   * Nunca se pasa others=true: borraría también los eventos añadidos a la vez.
   */
  async deleteEvent(id: number): Promise<void> {
    await sendJson("DELETE", `${this.base}/athlete/${this.athlete}/events/${id}`, { Authorization: this.auth });
  }
}

export class HevyClient {
  static BASE = "https://api.hevyapp.com/v1";
  static PAGE_SIZE = 10; // máximo que permite la API
  private key: string;

  constructor(env: Env) {
    this.key = env.HEVY_API_KEY!;
    this.base = env.HEVY_BASE_URL || HevyClient.BASE; // solo se cambia para pruebas
  }
  private base: string;

  private get(path: string, params: Record<string, string | number | undefined>) {
    return getJson(`${this.base}${path}${qs(params)}`, { "api-key": this.key });
  }
  private send(method: string, path: string, body: unknown) {
    return sendJson(method, `${this.base}${path}`, { "api-key": this.key }, body);
  }

  workoutsPage(page: number): Promise<{ page_count?: number; workouts?: any[] } | null> {
    return this.get("/workouts", { page, pageSize: HevyClient.PAGE_SIZE });
  }
  exerciseTemplate(id: string): Promise<any> {
    return this.get(`/exercise_templates/${encodeURIComponent(id)}`, {});
  }
  eventsPage(since: string, page: number): Promise<{ page_count?: number; events?: any[] } | null> {
    return this.get("/workouts/events", { since, page, pageSize: HevyClient.PAGE_SIZE });
  }
  routinesPage(page: number): Promise<{ page_count?: number; routines?: any[] } | null> {
    return this.get("/routines", { page, pageSize: HevyClient.PAGE_SIZE });
  }
  /** Una rutina; null si no existe (404). */
  routine(id: string): Promise<any> {
    return this.get(`/routines/${encodeURIComponent(id)}`, {});
  }
  /** Crea una rutina. Lanza error si Hevy no responde 2xx. */
  createRoutine(body: { routine: unknown }): Promise<any> {
    return this.send("POST", "/routines", body);
  }
  /** Modifica una rutina: hay que mandarla completa. Lanza error si Hevy no responde 2xx. */
  updateRoutine(id: string, body: { routine: unknown }): Promise<any> {
    return this.send("PUT", `/routines/${encodeURIComponent(id)}`, body);
  }
  routineFoldersPage(page: number): Promise<{ page_count?: number; routine_folders?: any[] } | null> {
    return this.get("/routine_folders", { page, pageSize: HevyClient.PAGE_SIZE });
  }
  routineFolder(id: number): Promise<any> {
    return this.get(`/routine_folders/${id}`, {});
  }
}
