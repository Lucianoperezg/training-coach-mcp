/**
 * Entrenos MCP en Cloudflare Workers.
 *  - fetch: servidor MCP remoto en https://<tu-worker>.workers.dev/mcp/<MCP_TOKEN>
 *  - scheduled: el cron sincroniza intervals.icu (reloj) y Hevy con la base de datos D1
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Env } from "./env";
import { runSync } from "./sync";
import { buildServer } from "./tools";

/** Comparación en tiempo constante para no filtrar el token por tiempos de respuesta. */
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function authorized(req: Request, url: URL, env: Env): boolean {
  if (!env.MCP_TOKEN || env.MCP_TOKEN.length < 32) return false; // sin token válido, nadie entra
  const fromPath = url.pathname.replace(/^\/mcp\/?/, "").replace(/\/$/, "");
  const fromHeader = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return safeEqual(fromPath, env.MCP_TOKEN) || safeEqual(fromHeader, env.MCP_TOKEN);
}

const notFound = () => new Response("Not found", { status: 404 });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      // No expone datos: solo si está vivo y cuándo sincronizó
      const row = await env.DB.prepare("SELECT value FROM sync_state WHERE key='last_sync'").first<{ value: string }>();
      return Response.json({ ok: true, ultima_sync: row?.value ?? null });
    }

    if (!url.pathname.startsWith("/mcp")) return notFound();
    // Límite por IP antes de autenticar: también frena los intentos de adivinar el token
    if (env.MCP_LIMITER) {
      const key = req.headers.get("cf-connecting-ip") ?? "local";
      if (!(await env.MCP_LIMITER.limit({ key })).success) {
        return new Response("Too many requests", { status: 429, headers: { "Retry-After": "60" } });
      }
    }
    if (!authorized(req, url, env)) return notFound(); // 404 en vez de 401: no revela que existe

    // Modo sin sesión: un servidor y un transporte por petición (encaja con Workers)
    const server = buildServer(env);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return transport.handleRequest(req);
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSync(env));
  },
} satisfies ExportedHandler<Env>;
