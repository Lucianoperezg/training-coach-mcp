/**
 * Herramientas MCP del entrenador (11; 10 sin HEVY_API_KEY). Cardio = reloj vía intervals.icu; fuerza = Hevy (opcional).
 * El servidor calcula y devuelve respuestas compactas; Claude interpreta.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { historial, METRICAS, progreso } from "./analisis";
import { estadoAtleta, nota, revisarActividad } from "./coach";
import { conHevy, type Env } from "./env";
import { CAMPOS, type Campo, estado, MAX_TEXTO_ESTADO } from "./estado";
import { escalaFeel, json, type Row, rows } from "./format";
import { programarEntrenos, TIPOS, verPlan } from "./plan";
import { programarRutinas, TIPOS_SERIE } from "./rutinas";
import { tramos } from "./tramos";
import { VERSION } from "./version";

/** Instrucciones del servidor. Sin Hevy no se mencionan el gimnasio de Hevy ni sus rutinas. */
export const instrucciones = (env: Env) => `Datos de entrenamiento personales del atleta: carrera (reloj vía intervals.icu)${conHevy(env) ? ", gimnasio (Hevy)" : ""} y forma/fatiga diaria.
- Revisar un entreno: revisar_actividad (sin id = el último; sincroniza antes).
- Planificar: estado_atleta y ver_plan; programar_entrenos (crear, modificar o borrar) va en dos pasos y nunca se confirma sin el sí explícito del atleta.
${conHevy(env) ? "- Rutinas de Hevy: se leen con consulta_sql (v_rutinas); programar_rutinas (crear, modificar o restaurar) va en dos pasos y nunca se confirma sin el sí explícito del atleta.\n" : ""}- Un tramo que no es un intervalo oficial (un cambio de ritmo o de cadencia, series sin marcar, un tramo por km o por minutos): tramos.
- Evolución: historial (por semanas) y progreso (tendencia de una métrica o de un ejercicio).
- Lee estado al empezar: objetivo, plan, rutina, decisiones y reglas compartidos con los otros chats. Guarda ahí lo que cambie.
- Guarda con nota lo que deba recordarse (molestias, sensaciones, objetivos).
- Si una respuesta trae alertas, plantea su pregunta_sugerida al atleta. La alerta seguirá saliendo en todos los chats hasta que la marques con nota(resolver_alerta=clave) o caduque: márcala en cuanto el atleta responda.
- consulta_sql solo para lo que no cubra lo anterior.
Convenciones: fechas locales; cadencia en pasos/min; ritmos en min/km; gap = ritmo ajustado por pendiente; las tablas vienen como {columnas, filas}.
Interpreta la FC siempre con las zonas personales que traen revisar_actividad y estado_atleta, nunca con valores genéricos.`;

const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD");
const SOLO_LECTURA = { readOnlyHint: true, openWorldHint: false } as const;

const serie = {
  type: z.enum(TIPOS_SERIE).optional(), weight_kg: z.number().nullable().optional(), reps: z.number().int().nullable().optional(),
  distance_meters: z.number().int().nullable().optional(), duration_seconds: z.number().int().nullable().optional(),
  custom_metric: z.number().nullable().optional(),
  rep_range: z.object({ start: z.number().nullable().optional(), end: z.number().nullable().optional() }).nullable().optional(),
};
const ejercicioNuevo = {
  exercise_template_id: z.string(), rest_seconds: z.number().int().nullable().optional(), notes: z.string().nullable().optional(),
  superset_id: z.number().int().nullable().optional(), series: z.array(z.object(serie)),
};

// --- consulta_sql: solo vistas sin raw y metadatos de la base -----------------
const MAX_FILAS = 100;
const MAX_TEXTO = 200;
// Lista de permitidos: una tabla nueva queda fuera de consulta_sql hasta que se añada aquí
const VISTAS = ["v_activities", "v_splits", "v_gym", "v_wellness", "v_rutinas", "v_rutinas_copias"];
// Vistas con datos que solo da Hevy: sin HEVY_API_KEY no se anuncian ni se aceptan
const VISTAS_HEVY = ["v_gym", "v_rutinas", "v_rutinas_copias"];
/** Vistas que acepta consulta_sql con esta configuración. */
export const vistasDe = (env: Pick<Env, "HEVY_API_KEY">) => conHevy(env) ? VISTAS : VISTAS.filter((v) => !VISTAS_HEVY.includes(v));
const FUNCIONES_TABLA = ["json_each", "json_tree"];
// Metadatos de la base: su columna sql (el DDL) se devuelve entera
const METADATOS = ["sqlite_master", "sqlite_schema", "d1_migrations"];
// replace( es la función de texto de SQLite; solo se rechaza REPLACE como sentencia
const ESCRITURA = new Set(["insert", "update", "delete", "drop", "alter", "create", "replace", "attach", "detach", "pragma", "vacuum", "reindex", "analyze", "begin", "commit", "rollback", "savepoint", "release", "load_extension"]);
// Palabras reservadas que nunca son un nombre de tabla sin comillas
const NO_TABLA = new Set(["select", "from", "where", "group", "having", "order", "limit", "union", "except", "intersect", "values", "join", "on", "as", "in", "with"]);
// Terminan la lista de tablas de un FROM. WINDOW va aparte, porque también puede ser un alias
const FIN_DE_FROM = new Set(["select", "where", "group", "having", "order", "limit", "union", "except", "intersect", "values"]);

const SOLO_CONSULTA = "Solo se permite una consulta SELECT/WITH.";

type Pieza = { tipo: "palabra" | "nombre" | "texto" | "numero" | "signo"; valor: string };

// Mismas reglas que SQLite (tokenize.c), y todo lo demás se rechaza: ?, :x, @x, $x, #, [x], `x`, textos sin cerrar...
const ID = "\\w$\\u0080-\\uFEFE\\uFF00-\\uFFFF";
const LEXICO = new RegExp([
  "(?<espacio>[ \\t\\n\\f\\r]+)",
  "(?<comentario>--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|$))",
  "(?<texto>'(?:[^']|'')*')",
  '(?<nombre>"(?:[^"]|"")*")',
  `(?<numero>(?:0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d*)?(?:[eE][+-]?\\d+)?|\\.\\d+(?:[eE][+-]?\\d+)?)(?![${ID}]))`,
  `(?<palabra>[A-Za-z_\\u0080-\\uFEFE\\uFF00-\\uFFFF][${ID}]*)`,
  "(?<signo>->>?|[(),.;*+\\-/%<>=!|&~])",
].join("|"), "y");

/** Trocea como SQLite y devuelve las piezas y el texto sin comentarios ni el ; final. null si hay algo que no se reconoce. */
function trocear(sql: string): { piezas: Pieza[]; limpia: string } | null {
  if (sql.includes("\0")) return null;
  const piezas: Pieza[] = [];
  let limpia = "";
  let cerrada = false;
  LEXICO.lastIndex = 0;
  while (LEXICO.lastIndex < sql.length) {
    const m = LEXICO.exec(sql);
    if (!m) return null;
    const g = m.groups!;
    if (g.comentario !== undefined) { if (!cerrada) limpia += " "; continue; }
    if (g.espacio !== undefined) { if (!cerrada) limpia += m[0]; continue; }
    if (cerrada) return null; // algo después del ;
    if (m[0] === ";") { cerrada = true; continue; }
    limpia += m[0];
    const tipo = (["texto", "nombre", "numero", "palabra", "signo"] as const).find((t) => g[t] !== undefined)!;
    piezas.push({ tipo, valor: m[0] });
  }
  return { piezas, limpia: limpia.trim() };
}

// SQLite solo pliega mayúsculas ASCII: toLowerCase convertiría también otras letras en k o s
const minusculas = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const esNombre = (p?: Pieza) => p !== undefined && (p.tipo === "palabra" || p.tipo === "nombre" || p.tipo === "texto");
/** Nombre normalizado: sin comillas y en minúsculas. SQLite también acepta 'x' como nombre de tabla. */
const nombreDe = (p: Pieza) => minusculas(p.tipo === "palabra" ? p.valor : p.valor.slice(1, -1).replace(p.tipo === "texto" ? /''/g : /""/g, p.tipo === "texto" ? "'" : '"'));
const palabra = (p?: Pieza) => (p?.tipo === "palabra" ? minusculas(p.valor) : "");

/**
 * Lee los WITH: nombre, desde qué pieza y hasta qué pieza vale. Un nombre solo existe dentro del paréntesis de su WITH:
 * fuera de él, ese mismo nombre es la tabla de verdad. null si un WITH no tiene la forma de siempre.
 */
function leerCtes(piezas: Pieza[], cierre: number[], padre: number[]): { nombre: string; desde: number; hasta: number }[] | null {
  const ctes: { nombre: string; desde: number; hasta: number }[] = [];
  for (let i = 0; i < piezas.length; i++) {
    if (palabra(piezas[i]) !== "with") continue;
    // WITH solo abre una consulta; en otro sitio sería un alias o una columna
    if (i > 0 && piezas[i - 1].valor !== "(") return null;
    const hasta = padre[i] < 0 ? piezas.length : cierre[padre[i]];
    let j = i + 1;
    if (palabra(piezas[j]) === "recursive" && palabra(piezas[j + 1]) !== "as" && piezas[j + 1]?.valor !== "(") j++;
    for (;;) {
      if (!esNombre(piezas[j]) || NO_TABLA.has(palabra(piezas[j]))) return null;
      ctes.push({ nombre: nombreDe(piezas[j]), desde: i, hasta });
      j++;
      if (piezas[j]?.valor === "(") j = cierre[j] + 1;
      if (palabra(piezas[j]) !== "as") return null;
      j++;
      if (palabra(piezas[j]) === "not") j++;
      if (palabra(piezas[j]) === "materialized") j++;
      if (piezas[j]?.valor !== "(") return null;
      j = cierre[j] + 1;
      if (piezas[j]?.valor !== ",") break;
      j++;
    }
  }
  return ctes;
}

/**
 * Prepara la consulta para ejecutarla: quita comentarios y el ; final, y comprueba que es una sola consulta
 * que solo lee vistas, sus propios WITH, json_each/json_tree y metadatos. D1 no tiene modo de solo lectura y
 * ejecuta todas las sentencias del texto, así que esta función es la única defensa. Trabaja sobre las piezas,
 * no sobre el texto: un texto entre comillas o un alias no cuentan, salvo si ocupan el lugar de una tabla.
 */
export function prepararSql(sql: string, vistas: string[] = VISTAS): { sql: string; metadatos: boolean } | { error: string } {
  const t = trocear(sql);
  if (!t) return { error: `${SOLO_CONSULTA} Sin parámetros (?, :x), sin nombres entre [] o acentos graves y con los textos cerrados.` };
  const { piezas, limpia } = t;
  if (!["select", "with"].includes(palabra(piezas[0]))) return { error: SOLO_CONSULTA };

  // Paréntesis cuadrados: nada puede cerrar el SELECT * FROM (...) que envuelve la consulta
  const cierre: number[] = [];
  const padre: number[] = [];
  const abiertos: number[] = [];
  for (let i = 0; i < piezas.length; i++) {
    const { tipo, valor } = piezas[i];
    if (tipo === "signo" && valor === ")") {
      if (!abiertos.length) return { error: SOLO_CONSULTA };
      cierre[abiertos.pop()!] = i;
    }
    padre[i] = abiertos.length ? abiertos[abiertos.length - 1] : -1;
    if (tipo === "signo" && valor === "(") abiertos.push(i);
  }
  if (abiertos.length) return { error: SOLO_CONSULTA };

  for (let i = 0; i < piezas.length; i++) {
    const p = palabra(piezas[i]);
    const esFuncionReplace = p === "replace" && piezas[i + 1]?.valor === "(";
    if (ESCRITURA.has(p) && !esFuncionReplace && palabra(piezas[i - 1]) !== "as") return { error: SOLO_CONSULTA };
  }

  const ctes = leerCtes(piezas, cierre, padre);
  if (!ctes) return { error: SOLO_CONSULTA };

  // Recorre la consulta: tras FROM, JOIN, IN sin paréntesis y las comas de un FROM viene siempre una tabla
  let metadatos = false;
  let esperaTabla = false;
  const enFrom: boolean[] = [false]; // uno por cada nivel de paréntesis
  for (let i = 0; i < piezas.length; i++) {
    const pieza = piezas[i];
    const nivel = enFrom.length - 1;
    const signo = pieza.tipo === "signo" ? pieza.valor : "";
    if (esperaTabla) {
      esperaTabla = false;
      if (signo === "(") {
        // (SELECT ...) es una subconsulta; (a JOIN b) o ('a') son más tablas
        const lista = !["select", "with", "values"].includes(palabra(piezas[i + 1]));
        enFrom.push(lista);
        esperaTabla = lista;
        continue;
      }
      let nombre = pieza;
      const conEsquema = piezas[i + 1]?.tipo === "signo" && piezas[i + 1].valor === ".";
      if (conEsquema) {
        if (!esNombre(pieza) || nombreDe(pieza) !== "main") return { error: SOLO_CONSULTA };
        nombre = piezas[i + 2];
        i += 2;
      }
      if (!esNombre(nombre) || NO_TABLA.has(palabra(nombre))) return { error: SOLO_CONSULTA };
      const n = nombreDe(nombre);
      // main.x siempre es la tabla de verdad, aunque haya un WITH con ese nombre
      if (!conEsquema && ctes.some((c) => c.nombre === n && c.desde <= i && i < c.hasta)) continue;
      if (METADATOS.includes(n)) metadatos = true;
      else if (!vistas.includes(n) && !FUNCIONES_TABLA.includes(n)) return { error: `Usa las vistas (${vistas.join(", ")}) en lugar de "${n}".` };
      continue;
    }
    if (signo === "(") enFrom.push(false);
    else if (signo === ")") enFrom.pop();
    else if (signo === ",") esperaTabla = enFrom[nivel];
    else {
      const p = palabra(pieza);
      if (p === "from") {
        // a IS DISTINCT FROM b es una comparación
        if (palabra(piezas[i - 1]) !== "distinct") { enFrom[nivel] = true; esperaTabla = true; }
      } else if (p === "join") esperaTabla = true;
      else if (p === "in") esperaTabla = piezas[i + 1]?.valor !== "(";
      else if (FIN_DE_FROM.has(p)) enFrom[nivel] = false;
      // Como SQLite: WINDOW solo es la cláusula si sigue "nombre AS"; si no, es un alias y el FROM continúa
      else if (p === "window" && esNombre(piezas[i + 1]) && palabra(piezas[i + 2]) === "as") enFrom[nivel] = false;
    }
  }
  if (esperaTabla) return { error: SOLO_CONSULTA };
  return { sql: limpia, metadatos };
}

/** La consulta tal como se ejecuta. D1 ejecuta todas las sentencias del texto: la seguridad depende de prepararSql. */
export const sqlFinal = (sql: string) => `SELECT * FROM (${sql}) LIMIT ${MAX_FILAS + 1}`;

const recortar = (r: Row) =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && v.length > MAX_TEXTO ? `${v.slice(0, MAX_TEXTO)}…` : v]));

// --- registro de herramientas ----------------------------------------------
export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "entrenos", version: VERSION }, { instructions: instrucciones(env) });
  const hevy = conHevy(env);

  // --- entrenador -------------------------------------------------------------
  server.registerTool("revisar_actividad", {
    description: `Revisión completa de una actividad en una llamada: resumen, % por zonas, splits por km (sin el tiempo en pausa), deriva cardiaca, recuperación de FC, polarización, comparación con actividades parecidas de 8 semanas, plan del día, gimnasio previo, forma de ese día (con sueño) y alertas. Sin id: la última (sincroniza antes). Ritmos: ritmo_movimiento_min_km = velocidad media de intervals (avg_speed_ms), sin pausas del reloj, igual que ritmo_min_km; ritmo_total_min_km = elapsed_s / distancia, con pausas. Tiempos: tiempo = distancia / velocidad media, sin pausas del reloj, a pie y con GPS; en cinta, gimnasio y otros deportes es moving_s, que a veces incluye pausas; tiempo_total = elapsed_s, con pausas. FC: fc, % por zonas y eficiencia_m_lat no incluyen las pausas del reloj en actividades a pie de 1 km o más; en gimnasio y en lo que aún no esté calculado son los valores de intervals. feel: ${escalaFeel(env.WATCH)}. recuperacion_fc: caída de FC en la ventana de 60 s que da intervals; solo sale si intervals la da, y que falte no significa nada malo. polarizacion: polarization_index de intervals, sin escala propia, a pie y desde 500 m; en estos datos, 0 cuando no hay tiempo en Z5 o más. forma_ese_dia: sueno_puntuacion es la del reloj y fc_sueno, la FC media durante el sueño.`,
    inputSchema: { id: z.string().optional().describe("id de la actividad; por defecto, la última") },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ id }) => json(await revisarActividad(env, id)));

  server.registerTool("estado_atleta", {
    description: `Estado actual para planificar: forma (CTL/ATL/TSB), carga de 7 y 28 días por deporte, recuperación (FC en reposo, VFC, horas y puntuación de sueño, FC durante el sueño y media de pasos de los 7 días anteriores a hoy), último entreno duro, ${hevy ? "gimnasio de las últimas 72 h, " : ""}notas abiertas (todas las molestias y las 10 más recientes del resto; notas_omitidas dice cuántas quedan fuera), umbrales y zonas, estado de la sincronización y alertas (cada una con su clave; siguen saliendo hasta resolverlas con nota o hasta que caduquen).`,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async () => json(await estadoAtleta(env)));

  server.registerTool("nota", {
    description: "Notas persistentes del atleta (molestias, sensaciones, objetivos). texto crea una nota; cerrar=id la cierra; revisada=id marca que se ha revisado hoy; resolver_alerta=clave marca una alerta como resuelta para que deje de salir en todos los chats. Devuelve las abiertas: todas las molestias y las 10 más recientes del resto (omitidas dice cuántas quedan fuera).",
    inputSchema: {
      texto: z.string().optional(),
      tipo: z.enum(["molestia", "sensacion", "objetivo", "otro"]).optional(),
      cerrar: z.number().int().optional(),
      revisada: z.number().int().optional(),
      resolver_alerta: z.string().optional().describe("clave de la alerta, tal como viene en alertas"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => json(await nota(env, args)));

  server.registerTool("estado", {
    description: `Estado compartido entre chats, en texto: objetivo (del momento), plan (vigente), rutina (con cargas objetivo), decisiones (de la semana) y reglas (personales). Las molestias van en nota, no aquí.
Sin campos: lee el estado vigente con su version y los últimos cambios (historial = cuántos, version = ver una versión antigua).
Con campos: actualiza solo esos ("" vacía uno) y guarda una versión nueva con qué cambió y cuándo. Exige version_base, la version que leíste (0 si está vacío): si otro chat ha guardado antes, no se guarda nada y hay que releer e integrar. Cada campo reemplaza al anterior entero: para añadir, incluye también lo que ya había. origen = qué chat lo cambia; motivo = por qué, en una frase.`,
    inputSchema: {
      ...Object.fromEntries(CAMPOS.map((c) => [c, z.string().max(MAX_TEXTO_ESTADO).optional()])) as Record<Campo, z.ZodOptional<z.ZodString>>,
      version_base: z.number().int().min(0).optional(),
      origen: z.string().max(40).optional(),
      motivo: z.string().max(300).optional(),
      historial: z.number().int().min(1).max(50).optional(),
      version: z.number().int().min(1).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (args) => json(await estado(env, args)));

  // --- análisis por semanas ---------------------------------------------------
  server.registerTool("historial", {
    description: `Resumen por semana (lunes a domingo): sesiones, km, horas, carga, tirada larga, % de tiempo en Z1-2 / Z3 / Z4+${hevy ? ", y gimnasio (sesiones, series, volumen y series por grupo muscular)" : ""}.`,
    inputSchema: { semanas: z.number().int().min(1).max(52).default(8) },
    annotations: SOLO_LECTURA,
  }, async ({ semanas }) => json(await historial(env, semanas)));

  server.registerTool("progreso", {
    description: `Tendencia semanal con pendiente calculada y si mejora o empeora, solo con semanas completas (mínimo 4 con datos). La semana en curso sale aparte en semana_en_curso, marcada como incompleta: no cuenta en la tendencia. metrica: ${Object.keys(METRICAS).join(", ")} (eficiencia = metros por latido; ritmo_z2 = ritmo en carreras suaves).${hevy ? " O ejercicio (nombre en cualquier idioma): 1RM estimado, o reps/segundos si es de peso corporal o isométrico." : ""}`,
    inputSchema: {
      metrica: z.enum(Object.keys(METRICAS) as [string, ...string[]]).optional(),
      ejercicio: z.string().optional(),
      semanas: z.number().int().min(4).max(104).default(12),
    },
    annotations: SOLO_LECTURA,
  }, async (args) => json(await progreso(env, args)));

  // --- planificación ----------------------------------------------------------
  server.registerTool("ver_plan", {
    description: "Calendario de intervals.icu (entrenos planificados, notas, carreras objetivo) y, para los días ya pasados, qué se hizo realmente. Por defecto, de hace 6 días a dentro de 13.",
    inputSchema: { desde: fecha.optional(), hasta: fecha.optional() },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ desde, hasta }) => json(await verPlan(env, desde, hasta)));

  server.registerTool("programar_entrenos", {
    description: `Crea, modifica o borra entrenos en el calendario de intervals.icu, en DOS pasos:
1) Llamada con "entrenos", "modificar" y/o "borrar": NO cambia nada, devuelve vista previa y plan_id.
2) Solo tras el sí explícito del atleta: llamada con plan_id y confirmar=true. Mira el estado de cada fila: lo que sale como error NO se ha hecho.
modificar: lista de {id, y solo lo que cambia: fecha, tipo, nombre, descripcion}. borrar: lista de ids. Los id salen en ver_plan; solo se pueden tocar entrenos de hoy en adelante que creó el MCP (del_entrenador); los demás, el atleta en intervals.icu.
Cada entreno: fecha (YYYY-MM-DD), tipo (Run, TrailRun, Walk, Hike, Ride, WeightTraining...), nombre y descripcion con los pasos en formato intervals.icu, una línea por paso empezando por "- ": duración (10m, 30s, 1h) o distancia (2km, 400mtr) y objetivo de FC, p. ej. "- 10m Z2 HR", "- 20m Z2-Z3 HR", "- 3m 90-95% LTHR". Repeticiones: línea "4x" (o "Series 4x") con una línea en blanco antes y después del bloque. Usa solo objetivos de FC en todo el entreno (sin ritmo: no hay ritmo umbral configurado). Máximo 10 cambios por plan, hasta 42 días vista.`,
    inputSchema: {
      entrenos: z.array(z.object({
        fecha, tipo: z.enum(TIPOS), nombre: z.string(), descripcion: z.string().default(""),
      })).optional(),
      modificar: z.array(z.object({
        id: z.number().int().positive(), fecha: fecha.optional(), tipo: z.enum(TIPOS).optional(), nombre: z.string().optional(), descripcion: z.string().optional(),
      })).optional(),
      borrar: z.array(z.number().int().positive()).optional(),
      plan_id: z.string().optional(),
      confirmar: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (args) => json(await programarEntrenos(env, args)));

  // Sin Hevy, Claude no ve las rutinas: ni esta herramienta ni sus vistas en consulta_sql
  if (hevy) server.registerTool("programar_rutinas", {
    description: `Crea, modifica o restaura rutinas de Hevy, en DOS pasos:
1) Llamada con "crear", "modificar" y/o "restaurar": NO cambia nada en Hevy, devuelve vista previa (antes, después, diferencias y avisos) y plan_id, que caduca en 24 h.
2) Solo tras el sí explícito del atleta: llamada con plan_id y confirmar=true. Se aplica exactamente lo mostrado. Mira el estado de cada fila: lo que sale como error NO se ha hecho.
Lee las rutinas con consulta_sql (v_rutinas): routine_id, exercise_index, set_index y template_id salen de ahí. consulta_sql corta los textos largos: para reescribir unas notas, parte del texto completo de "antes" en la vista previa. Puede cambiar cualquier rutina, también las creadas en la app. No toca entrenos ya hechos.
modificar: lista de {routine_id, y solo lo que cambia}. Lo que no se nombra se conserva: notas, descansos, tipos de serie, rangos de repeticiones y superseries. Campos: title, notes (generales), ejercicios: [{indice (exercise_index), exercise_template_id, rest_seconds, notes, superset_id, series_cambios: [{indice (set_index; sin él, todas las series), y solo lo que cambia: weight_kg, reps, rep_range {start, end}, type...}] o series: [lista completa nueva]}], quitar_ejercicios: [indice], anadir_ejercicios: [{exercise_template_id, series, posicion, rest_seconds, notes, superset_id}], orden: [indice actual de todos los que se quedan, en el orden nuevo]. No cambia de carpeta una rutina existente.
crear: lista de {title, folder_id (carpeta; salen en v_rutinas), notes, ejercicios: [{exercise_template_id, series, rest_seconds, notes, superset_id}]}.
Cada exercise_template_id nuevo se comprueba en Hevy; salen en v_rutinas y v_gym. Tipos de serie: warmup, normal, failure, dropset. Pesos en kg.
Antes de cada cambio guarda una copia completa de la rutina y devuelve su copia_id; si la rutina ha cambiado en Hevy desde la vista previa, no la pisa y da error.
restaurar: lista de copia_id (salen en v_rutinas_copias) para volver a esa versión; la rutina actual también se copia antes.
Borrar: la API de Hevy no lo permite; las rutinas se borran en la app. Máximo 5 rutinas por plan.`,
    inputSchema: {
      crear: z.array(z.object({
        title: z.string(), folder_id: z.number().int().nullable().optional(), notes: z.string().optional(), ejercicios: z.array(z.object(ejercicioNuevo)),
      })).optional(),
      modificar: z.array(z.object({
        routine_id: z.string(), title: z.string().optional(), notes: z.string().nullable().optional(),
        ejercicios: z.array(z.object({
          indice: z.number().int(), exercise_template_id: z.string().optional(), rest_seconds: z.number().int().nullable().optional(),
          notes: z.string().nullable().optional(), superset_id: z.number().int().nullable().optional(), series: z.array(z.object(serie)).optional(),
          series_cambios: z.array(z.object({ indice: z.number().int().optional(), ...serie })).optional(),
        })).optional(),
        quitar_ejercicios: z.array(z.number().int()).optional(),
        anadir_ejercicios: z.array(z.object({ ...ejercicioNuevo, posicion: z.number().int().optional() })).optional(),
        orden: z.array(z.number().int()).optional(),
      })).optional(),
      restaurar: z.array(z.number().int().positive()).optional(),
      plan_id: z.string().optional(),
      confirmar: z.boolean().default(false),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (args) => json(await programarRutinas(env, args)));

  server.registerTool("tramos", {
    description: `Analiza tramos de una carrera que no son intervalos oficiales, con los datos segundo a segundo de intervals.icu (se piden al usarla, no se guardan). Sin id: la última carrera. Solo lectura. Tres modos:
1) Sin desde/hasta ni trabajo/descanso: perfil (t_medio, km, ritmo, cad_ppm y fc cada 30 s; resolucion en segundos) y escalones_detectados: tramos donde la cadencia (o el ritmo, si no hay cadencia o senal=ritmo) cambia de nivel y se mantiene, más rápidos o más lentos que lo de alrededor. Duración mínima min_duracion_s (10 por defecto; sirve para series de 20 s). Cada escalón trae inicio y fin (mm:ss y km), duración, distancia, ritmo, cadencia, FC media y máxima, zancada, vs_alrededor y confianza (claro / difuso: difuso = el cambio fue progresivo, los bordes tienen más margen).
2) Con desde y/o hasta (unidad km, por defecto, o min, contados desde el inicio de la actividad con el reloj): medias exactas del tramo (ritmo en movimiento, FC media y máxima, cadencia, zancada en metros por paso, desnivel + y -, segundos en zonas de FC personales y tiempo en pausa) y una serie más fina dentro del tramo.
3) Con trabajo y descanso (por ejemplo "2min" y "2min", o "400m" y "200m"; repeticiones opcional): busca dónde encaja ese patrón y devuelve una tabla por repetición (inicio, fin, duración, distancia, ritmo, cadencia, FC, zancada, confianza), otra de los descansos y la evolución de la 1.ª a la última. Si no encaja bien (una serie más corta, una repetición que falta), lo dice en avisos_encaje y enseña lo detectado, sin forzar.
Precisión: los bordes se fijan sobre los datos de 1 Hz, donde la cadencia cruza el punto medio entre los dos niveles (margen esperado de 1-2 s; con ritmo por GPS, más). El ritmo de un tramo es su distancia entre su tiempo en movimiento; las pausas del reloj no cuentan. En tramos de menos de 30 s la FC no es representativa (va 20-30 s retrasada; fc_ok=false). Si faltan streams (por ejemplo, sin cadencia) devuelve lo que hay y lo avisa en avisos.`,
    inputSchema: {
      id: z.string().optional().describe("id de la actividad; por defecto, la última carrera"),
      desde: z.number().min(0).optional().describe("inicio del tramo, en km o minutos desde el inicio (según unidad)"),
      hasta: z.number().min(0).optional().describe("fin del tramo, en km o minutos desde el inicio (según unidad)"),
      unidad: z.enum(["km", "min"]).default("km").describe("unidad de desde y hasta"),
      resolucion: z.number().int().min(1).max(300).optional().describe("segundos por punto de la serie (perfil: 30; tramo: automático)"),
      min_duracion_s: z.number().int().min(4).max(600).optional().describe("duración mínima de un escalón en segundos (10 por defecto)"),
      senal: z.enum(["cadencia", "ritmo"]).optional().describe("señal para detectar escalones; por defecto, cadencia si hay"),
      trabajo: z.string().optional().describe('modo series: duración o distancia del trabajo, p. ej. "2min", "90s", "400m"'),
      descanso: z.string().optional().describe('modo series: duración o distancia del descanso, p. ej. "2min", "200m"'),
      repeticiones: z.number().int().min(1).max(50).optional().describe("modo series: repeticiones esperadas"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => json(await tramos(env, args)));

  // --- consulta libre -------------------------------------------------------------
  server.registerTool("consulta_sql", {
    description: `Consulta SQL de SOLO LECTURA (una SELECT/WITH, SQLite) para lo que no cubran las demás herramientas. Máximo ${MAX_FILAS} filas. En FROM solo valen estas vistas, sus propios WITH, json_each, json_tree y los metadatos sqlite_master, sqlite_schema y d1_migrations; sin parámetros (?, :x) ni nombres entre [] o acentos graves. Vistas:
v_activities(id, date, start_local, sport, name, distance_m, moving_s, elapsed_s, elev_gain_m, elev_loss_m, avg_hr, max_hr, cadence_spm, avg_speed_ms, gap_ms, stride_m, avg_watts, training_load, intensity, trimp, feel, temp_avg, calories, decoupling, lthr_used, aerobic_eff, hr_z1_s..hr_z7_s, fc_media, fc_marcha, eficiencia, fc_z1_s..fc_z7_s, hrr_start_bpm, hrr_end_bpm, hrr_bpm, polarization_index)
v_splits(activity_id, date, sport, km, dist_m, pace_s, hr, cadence_spm, elev_m)
${hevy ? `v_gym(workout_id, date, start_time, workout, template_id, exercise, exercise_index, set_index, set_type, weight_kg, reps, duration_s, distance_m, rpe, metrica, e1rm) — un ejercicio = un template_id
` : ""}v_wellness(date, ctl, atl, tsb, ramp_rate, resting_hr, hrv, sleep_h, weight, sleep_score, sleep_quality, avg_sleeping_hr, steps)
${hevy ? `v_rutinas(routine_id, rutina, carpeta, folder_id, notas_rutina, updated_at, exercise_index, exercise, template_id, superset_id, rest_s, exercise_notes, set_index, set_type, weight_kg, reps, rep_min, rep_max, duration_s, distance_m, custom_metric) — rutinas vigentes de Hevy, una fila por serie, según la última sincronización (cada 15 min); peso y repeticiones son objetivos. Con varias rutinas filtra por rutina: pueden pasar de ${MAX_FILAS} filas
v_rutinas_copias(copia_id, routine_id, rutina, motivo, plan_id, creado, updated_at, ejercicios) — copias guardadas antes de cada cambio, para programar_rutinas(restaurar)
` : ""}date = fecha local; cadence_spm en pasos/min; velocidades en m/s; pace_s en s/km, sin el tiempo en pausa; moving_s a veces incluye pausas: para el ritmo en movimiento usa avg_speed_ms; feel: ${escalaFeel(env.WATCH, { conFuente: false })}; FC, zonas y eficiencia: usa fc_media, fc_z1_s..fc_z7_s y eficiencia (metros por latido), sin las pausas del reloj en actividades a pie y con reserva al valor de intervals; avg_hr, hr_z1_s..hr_z7_s y aerobic_eff son los de intervals, con pausas; fc_marcha es el cálculo del MCP y NULL si aún no existe o no aplica; sleep_quality: en estos datos, a menor número, mejor puntuación de sueño; hrr_*: caída de FC en 60 s de intervals, NULL en muchas actividades; polarization_index: en estos datos, 0 cuando no hay tiempo en Z5 o más; los datos del día de hoy pueden estar incompletos.`,
    inputSchema: { sql: z.string() },
    annotations: SOLO_LECTURA,
  }, async ({ sql }) => {
    const q = prepararSql(sql, vistasDe(env));
    if ("error" in q) return json({ error: q.error });
    try {
      const r = await rows(env, sqlFinal(q.sql));
      const datos = r.slice(0, MAX_FILAS);
      return json({ filas: datos.length, truncado: r.length > MAX_FILAS || undefined, datos: q.metadatos ? datos : datos.map(recortar) });
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) });
    }
  });

  return server;
}
