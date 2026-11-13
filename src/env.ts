export interface Env {
  DB: D1Database;
  MCP_TOKEN: string;
  INTERVALS_API_KEY?: string;
  INTERVALS_ATHLETE_ID?: string;
  HEVY_API_KEY?: string;
  MCP_LIMITER?: RateLimit;     // límite de peticiones en /mcp (binding opcional)
  HISTORY_START?: string;
  TZ?: string;                 // zona horaria del atleta (Hevy guarda en UTC)
  WATCH?: string;              // marca del reloj; "suunto" activa la conversión del feel (ver format.ts)
  INTERVALS_BASE_URL?: string; // solo para pruebas locales
  HEVY_BASE_URL?: string;      // solo para pruebas locales
}

/** ¿Está Hevy configurado? Sin clave no se sincroniza ni se anuncian el gimnasio de Hevy ni sus rutinas. */
export const conHevy = (env: Pick<Env, "HEVY_API_KEY">) => !!env.HEVY_API_KEY;

export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");


/** Fecha local YYYY-MM-DD de un instante ISO en la zona horaria del atleta. */
export function localDate(iso: string | null, tz = "Europe/Madrid"): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10); // zona horaria inválida: mejor UTC que nada
  }
}

/** Fecha local de hoy (YYYY-MM-DD) en la zona horaria del atleta. */
export const today = (tz?: string) => localDate(new Date().toISOString(), tz)!;

export function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function getState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key=?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

/** Lee varias claves de estado en una sola consulta (cada consulta cuenta como subpetición). */
export async function getStates(env: Env, keys: string[]): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM sync_state WHERE key IN (SELECT value FROM json_each(?))",
  ).bind(JSON.stringify(keys)).all<{ key: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export function setStateStmt(env: Env, key: string, value: string): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT INTO sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).bind(key, value);
}

export async function setState(env: Env, key: string, value: string): Promise<void> {
  await setStateStmt(env, key, value).run();
}
