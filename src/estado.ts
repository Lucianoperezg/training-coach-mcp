/**
 * Estado compartido entre chats: objetivo, plan, rutina, decisiones y reglas, en texto.
 * Cada cambio crea una versión completa en estado_versiones (nunca se reescribe), así que queda el historial.
 * Para escribir hay que decir sobre qué versión se trabaja (version_base): si otro chat ha guardado antes,
 * se rechaza en vez de pisar su cambio. Las molestias no van aquí, sino en nota.
 */
import type { Env } from "./env";
import { nowIso } from "./env";
import { type Row, rows, tabla } from "./format";

export const CAMPOS = ["objetivo", "plan", "rutina", "decisiones", "reglas"] as const;
export type Campo = (typeof CAMPOS)[number];
export const MAX_TEXTO_ESTADO = 8000;
const CAMBIOS_RECIENTES = 5;

export type ArgsEstado = Partial<Record<Campo, string>> & {
  version_base?: number; origen?: string; motivo?: string; historial?: number; version?: number;
};

const ULTIMA = "SELECT * FROM estado_versiones ORDER BY version DESC LIMIT 1";

function vista(v: Row | undefined) {
  return {
    version: v?.version ?? 0, actualizado: v?.creado ?? null, origen: v?.origen ?? null,
    ...Object.fromEntries(CAMPOS.map((c) => [c, v?.[c] ?? ""])),
  };
}

async function cambios(env: Env, n: number) {
  const hs = await rows(env, "SELECT version, creado, origen, motivo, cambiados FROM estado_versiones ORDER BY version DESC LIMIT ?", n);
  return tabla(hs.map((h) => ({ ...h, fecha: h.creado, cambiados: (JSON.parse(h.cambiados) as string[]).join(", ") })),
    ["version", "fecha", "origen", "cambiados", "motivo"]);
}

export async function estado(env: Env, args: ArgsEstado) {
  const nuevos = CAMPOS.filter((c) => args[c] !== undefined);

  // Leer: el estado vigente (o una versión antigua) y lo último que ha cambiado
  if (!nuevos.length) {
    if (args.version != null) {
      const [v] = await rows(env, "SELECT * FROM estado_versiones WHERE version = ?", args.version);
      return v ? { ...vista(v), motivo: v.motivo ?? null, antigua: true } : { error: `No existe la versión ${args.version}.` };
    }
    const [v] = await rows(env, ULTIMA);
    return { ...vista(v), cambios_recientes: await cambios(env, args.historial ?? CAMBIOS_RECIENTES) };
  }

  // Actualizar: solo los campos indicados; "" vacía un campo y el resto se conserva
  for (const c of nuevos) {
    if (args[c]!.length > MAX_TEXTO_ESTADO) return { error: `${c}: ${MAX_TEXTO_ESTADO} caracteres como mucho. No se ha guardado nada.` };
  }
  if (args.version_base == null) {
    return { error: "Para actualizar hace falta version_base: lee antes el estado y pasa su version (0 si está vacío). No se ha guardado nada." };
  }
  const [actual] = await rows(env, ULTIMA);
  const conflicto = (v: number) => ({
    error: `Otro chat ha cambiado el estado: vas sobre la versión ${args.version_base} y la vigente es la ${v}. No se ha guardado nada: vuelve a leerlo, integra tu cambio y repite.`,
    version_vigente: v,
  });
  if ((actual?.version ?? 0) !== args.version_base) return conflicto(actual?.version ?? 0);

  const valor = (c: Campo): string => args[c] ?? actual?.[c] ?? "";
  const cambiados = nuevos.filter((c) => valor(c) !== (actual?.[c] ?? ""));
  if (!cambiados.length) return { hecho: "sin cambios: no se crea versión nueva", ...vista(actual) };

  // La comprobación de versión va en el propio INSERT: dos escrituras a la vez no pueden pisarse
  const r = await env.DB.prepare(`INSERT INTO estado_versiones (creado, origen, motivo, cambiados, ${CAMPOS.join(", ")})
    SELECT ?, ?, ?, ?, ${CAMPOS.map(() => "?").join(", ")}
    WHERE (SELECT COALESCE(MAX(version), 0) FROM estado_versiones) = ?`)
    .bind(nowIso(), args.origen ?? null, args.motivo ?? null, JSON.stringify(cambiados), ...CAMPOS.map(valor), args.version_base).run();
  if (!r.meta.changes) {
    const [v] = await rows(env, ULTIMA);
    return conflicto(v?.version ?? 0);
  }
  const [v] = await rows(env, ULTIMA);
  return { hecho: `guardado: ${cambiados.join(", ")}`, ...vista(v) };
}
