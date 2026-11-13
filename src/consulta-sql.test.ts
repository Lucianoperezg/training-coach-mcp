/**
 * consulta_sql no puede escribir ni leer tablas base. Cada ataque se comprueba contra el filtro y, además, ejecutándolo
 * en un motor de verdad con todas las migraciones y un dato canario en las tablas protegidas: nunca toca datos reales.
 * - Siempre: SQLite de Node (si la versión de Node no trae node:sqlite, esa parte se salta).
 * - Con D1_LOCAL=1: también una D1 local, en memoria y con una configuración temporal. Va aparte porque `npm run typecheck`
 *   corre en la build de Cloudflare y arrancar workerd allí podría bloquear un despliegue:
 *     D1_LOCAL=1 npx vitest run src/consulta-sql.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prepararSql, sqlFinal } from "./tools";

const nodeImport = (m: string): Promise<any> => import(/* @vite-ignore */ m);
const sqlite = await nodeImport("node:sqlite").catch(() => null);
const fs = await nodeImport("node:fs");
declare const process: { env: Record<string, string | undefined> };

const CANARIO = "CANARIO_SECRETO";
const migraciones = (): string[] => (fs.readdirSync("migrations") as string[]).sort().map((f) => fs.readFileSync(`migrations/${f}`, "utf8"));
const tablasDeMigraciones = (): string[] => [...new Set(migraciones().flatMap((m) => [...m.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w+)/gi)].map((x) => x[1])))];

// El primero es el truco de la revisión: el alias entre comillas se come el trozo con el DELETE
const ATAQUES_ESCRITURA: Record<string, string> = {
  "comilla dentro de un nombre": `SELECT 1, 'a as "b') ; DELETE FROM notas ; SELECT * FROM (SELECT 1, 'c" d'`,
  "UPDATE con el mismo truco": `SELECT 1, 'a as "b') ; UPDATE notas SET texto='x' ; SELECT * FROM (SELECT 1, 'c" d'`,
  "; a secas": "SELECT 1) ; DELETE FROM notas ; SELECT * FROM (SELECT 1",
  "; con comentarios": "SELECT 1) /* x */ ; /* y */ DELETE FROM notas -- z\n; SELECT * FROM (SELECT 1",
  "WITH que acaba en DELETE": "WITH a AS (SELECT 1) DELETE FROM notas",
  "WITH que acaba en INSERT": "WITH a AS (SELECT 1) INSERT INTO notas(fecha, texto) VALUES ('x', 'y')",
  "WITH que acaba en REPLACE": "WITH a AS (SELECT 1) REPLACE INTO notas(id, fecha, texto) VALUES (1, 'x', 'y')",
  "parámetro con paréntesis y comilla": `SELECT :a(')) ; DELETE FROM notas ; SELECT * FROM (SELECT ':x'`,
  "parámetro con $": `SELECT $a(')) ; DELETE FROM notas ; SELECT * FROM (SELECT '$b'`,
  "acento grave que esconde un ;": "SELECT 1 AS `a'` FROM v_gym) ; DELETE FROM notas ; SELECT * FROM (SELECT 1 AS `b'` FROM v_gym",
  "corchete que esconde un ;": "SELECT 1 AS [a'] FROM v_gym) ; DELETE FROM notas ; SELECT * FROM (SELECT 1 AS [b'] FROM v_gym",
  "carácter nulo": "SELECT 1\0) ; DELETE FROM notas ; SELECT * FROM (SELECT 1",
  "BOM como separador": "SELECT 1)﻿; DELETE FROM notas ; SELECT * FROM (SELECT 1",
  "varias sentencias": "SELECT 'a' ; DROP TABLE notas",
  "ATTACH": "ATTACH DATABASE 'x' AS y",
  "PRAGMA": "PRAGMA writable_schema=1",
};

const ATAQUES_LECTURA: Record<string, string> = {
  "tabla a secas": "SELECT raw FROM activities",
  "entre comillas dobles": 'SELECT raw FROM "activities"',
  "entre comillas simples": "SELECT raw FROM 'activities'",
  "texto entre paréntesis": "SELECT raw FROM ('activities')",
  "doble paréntesis": "SELECT texto FROM (('notas'))",
  "nombre entre paréntesis": 'SELECT texto FROM ("notas")',
  "unión entre paréntesis": "SELECT texto FROM (v_gym JOIN 'notas')",
  "paréntesis que cierra el envoltorio": "SELECT 1) UNION SELECT * FROM (SELECT texto FROM notas",
  "con esquema": "SELECT texto FROM main.notas",
  "esquema y comillas": `SELECT texto FROM "main".'notas'`,
  "esquema que no es main": "SELECT texto FROM temp.notas",
  "coma tras JOIN": "SELECT texto FROM v_gym JOIN v_wellness ON 1=1, 'notas'",
  "JOIN con comillas": `SELECT texto FROM v_gym LEFT JOIN "notas" ON 1=1`,
  "comentario de bloque en medio": "SELECT texto FROM/**/notas",
  "comentario de línea en medio": "SELECT texto FROM -- nada\n'notas'",
  "comilla en un comentario": "SELECT /* ' */ texto FROM notas /* ' */",
  "subconsulta": "SELECT (SELECT texto FROM 'notas')",
  "subconsulta en WHERE": "SELECT 1 FROM v_gym WHERE 1 IN (SELECT texto FROM notas)",
  "EXISTS": "SELECT 1 WHERE EXISTS (SELECT 1 FROM notas WHERE texto LIKE 'C%')",
  "UNION": "SELECT 1 UNION SELECT texto FROM notas",
  "IN con tabla": "SELECT 'x' IN sync_state",
  "IN con texto": "SELECT 'x' IN 'sync_state'",
  "NOT IN con esquema": "SELECT 'x' NOT IN main.sync_state",
  "CTE de otro ámbito, después": "SELECT texto FROM notas, (WITH notas AS (SELECT 1) SELECT * FROM notas)",
  "CTE que se acaba en su paréntesis": "SELECT * FROM (WITH notas AS (SELECT 1) SELECT * FROM notas) JOIN notas",
  "CTE con esquema": "WITH notas AS (SELECT 1) SELECT texto FROM main.notas",
  "CTE que apunta a la tabla": "WITH x AS (SELECT texto FROM notas) SELECT * FROM x",
  "CTE con letra no ASCII que se pliega": 'WITH "gym_worKouts" AS (SELECT 1) SELECT raw FROM gym_workouts',
  "alias with": "SELECT texto FROM v_gym with, notas",
  "alias window": "SELECT texto FROM v_gym window, notas",
  "CTE llamado from": `WITH "from" AS (SELECT 1) SELECT join from notas`,
  "en mayúsculas": "SELECT TEXTO FROM NOTAS",
  "tabla interna de Cloudflare": "SELECT * FROM _cf_KV",
  "tabla interna de SQLite": "SELECT * FROM sqlite_sequence",
  "catálogo temporal": "SELECT * FROM sqlite_temp_master",
  "función de PRAGMA": "SELECT * FROM pragma_table_info('notas')",
  "tabla que aún no existe": "SELECT * FROM tabla_del_futuro",
};

// Lo que debe seguir funcionando, también ejecutado en el motor
const LEGITIMAS = [
  "SELECT date, aerobic_eff FROM v_activities WHERE sport='Run'",
  "SELECT * FROM v_gym;",
  "select * from V_GYM limit 5",
  'SELECT * FROM "v_gym"',
  "SELECT * FROM 'v_gym'",
  "SELECT * FROM main.v_gym",
  "SELECT replace(name, 'Carrera ', '') FROM v_activities",
  "SELECT replace (name, 'a', 'b') AS replace FROM v_activities",
  "SELECT sport, COUNT(*) AS activities FROM v_activities GROUP BY sport",
  'SELECT sport AS "notas", COUNT(*) AS planes FROM v_activities GROUP BY sport',
  "SELECT name FROM v_activities WHERE name LIKE '%wellness%' OR name = 'update; drop'",
  "SELECT name FROM v_activities WHERE name = 'o''brien ; DELETE FROM notas' OR name LIKE '%\"%'",
  "SELECT 'a[b]`c`:d?e$f@g#h' AS texto",
  "SELECT 1 AS \"it's\", 2 AS \"a;b\", 3 AS \"--no\"",
  "SELECT '--no' AS x, '/* no */' AS y FROM v_gym",
  "SELECT /* comentario ' */ date FROM v_wellness -- otro '\n WHERE ctl > 1",
  "WITH x AS (SELECT * FROM v_gym) SELECT COUNT(*) FROM x;",
  "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<3) SELECT i FROM n",
  "WITH a AS (SELECT 1 AS v), b(w) AS MATERIALIZED (SELECT v FROM a), c AS NOT MATERIALIZED (SELECT w FROM b) SELECT * FROM c, a",
  "WITH a AS (SELECT * FROM b), b AS (SELECT 1 AS v) SELECT * FROM a",
  "WITH rutinas AS (SELECT DISTINCT rutina FROM v_rutinas) SELECT * FROM rutinas",
  "SELECT * FROM (SELECT date, ctl FROM v_wellness) w WHERE w.ctl > 0",
  "SELECT g.date, w.ctl FROM v_gym g JOIN v_wellness w ON g.date = w.date, v_splits s LEFT OUTER JOIN v_activities a ON a.id = s.activity_id LIMIT 1",
  "SELECT g.date FROM v_gym AS g NATURAL JOIN (v_wellness) WHERE g.date IN (SELECT date FROM v_activities) ORDER BY 1 DESC, 1 ASC LIMIT 1 OFFSET 0",
  "SELECT g.date FROM v_gym g JOIN v_wellness w USING (date)",
  "SELECT sport, sum(distance_m) OVER (PARTITION BY sport, date ORDER BY date) FROM v_activities",
  "SELECT sum(distance_m) OVER w, count(*) OVER z FROM v_activities WINDOW w AS (PARTITION BY sport), z AS (ORDER BY date)",
  "SELECT date FROM v_wellness UNION ALL SELECT date FROM v_gym EXCEPT SELECT date FROM v_splits",
  "SELECT CASE WHEN ctl > 1 THEN 'a' ELSE 'b' END, CAST(ctl AS INTEGER) FROM v_wellness",
  "SELECT 1 IS DISTINCT FROM 2 AS r, 1.5e3, .5, 1., 0x1F, 1 << 2, 1 <> 2, 'a' || 'b', -1, ~1 FROM v_gym",
  "SELECT '{\"a\":1}' -> 'a', '{\"a\":1}' ->> 'a', x'41'",
  "SELECT r.copia_id, j.value FROM v_rutinas_copias r, json_each(r.ejercicios) j",
  "SELECT value FROM json_each('[1,2]')",
  "SELECT fullkey FROM json_tree('[1,2]')",
  "SELECT date AS año FROM v_gym",
  "SELECT name FROM d1_migrations",
  "SELECT sql FROM sqlite_master WHERE name='v_splits'",
  "SELECT sql FROM sqlite_schema",
  "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('notas', 'activities')",
  "SELECT name FROM sqlite_master WHERE name LIKE 'notas'",
];

describe("consulta_sql: filtro", () => {
  for (const [nombre, sql] of Object.entries({ ...ATAQUES_ESCRITURA, ...ATAQUES_LECTURA })) {
    it(`rechaza: ${nombre}`, () => expect(prepararSql(sql)).toHaveProperty("error"));
  }
  for (const sql of LEGITIMAS) it(`permite: ${sql}`, () => expect(prepararSql(sql)).not.toHaveProperty("error"));

  it("ninguna tabla de las migraciones se puede leer, tampoco las que se añadan", () => {
    const tablas = tablasDeMigraciones();
    expect(tablas.length).toBeGreaterThan(15);
    for (const t of tablas) {
      for (const sql of [`SELECT * FROM ${t}`, `SELECT * FROM "${t}"`, `SELECT * FROM ('${t}')`, `SELECT * FROM v_gym, main.${t}`, `SELECT 1 IN ${t}`]) {
        expect(prepararSql(sql), sql).toHaveProperty("error");
      }
    }
  });

  it("todas las vistas de las migraciones están permitidas: una vista nueva hay que añadirla a VISTAS", () => {
    const vistas = [...new Set(migraciones().flatMap((m) => [...m.matchAll(/CREATE\s+VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`[]?(\w+)/gi)].map((x) => x[1])))];
    expect(vistas.length).toBeGreaterThan(5);
    for (const v of vistas) expect(prepararSql(`SELECT * FROM ${v}`), v).not.toHaveProperty("error");
  });

  it("marca los metadatos solo cuando se leen de verdad", () => {
    expect(prepararSql("SELECT sql FROM main.sqlite_master")).toMatchObject({ metadatos: true });
    expect(prepararSql("SELECT 'sqlite_master' AS x FROM v_gym")).toMatchObject({ metadatos: false });
    expect(prepararSql("WITH sqlite_master AS (SELECT * FROM v_gym) SELECT * FROM sqlite_master")).toMatchObject({ metadatos: false });
  });

  it("no deja comentarios abiertos que se coman el envoltorio", () => {
    expect(prepararSql("SELECT 1 /* sin cerrar")).toEqual({ sql: "SELECT 1", metadatos: false });
    expect(sqlFinal("SELECT 1")).toMatch(/^SELECT \* FROM \(SELECT 1\) LIMIT \d+$/);
  });

  it("rechaza textos y nombres sin cerrar y paréntesis descompensados", () => {
    for (const sql of ["SELECT 'a", 'SELECT "a', "SELECT (1", "SELECT 1)", "", "   ", "-- nada"]) expect(prepararSql(sql), sql).toHaveProperty("error");
  });
});

// --- ejecutando de verdad ------------------------------------------------------
interface Motor {
  /** Ejecuta todas las sentencias del texto, como hace D1 con prepare().all(), y devuelve filas. */
  ejecutar(sql: string): Promise<unknown[]>;
}

const SIEMBRA = [
  "CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)",
  `INSERT INTO notas(fecha, tipo, texto) VALUES ('2026-11-07', 'otro', '${CANARIO}')`,
  `INSERT INTO sync_state(key, value) VALUES ('${CANARIO}', '${CANARIO}')`,
  `INSERT INTO activities(id, start_local, sport, name, raw) VALUES ('a1', '2026-11-07T10:00:00', 'Run', 'Carrera', '{"x":"${CANARIO}"}')`,
];

/** Lo que cambiaría si una consulta escribe: el esquema y todas las filas de todas las tablas. */
async function foto(m: Motor): Promise<string> {
  const objetos = await m.ejecutar("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name");
  const salida = [JSON.stringify(objetos)];
  for (const t of tablasDeMigraciones()) salida.push(t, JSON.stringify(await m.ejecutar(`SELECT * FROM ${t}`)));
  return salida.join("\n");
}

/** Generador con semilla: el mismo resultado en cada ejecución. */
function azar(semilla: number) {
  let s = semilla;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s >>> 8) % n;
  };
}

const PIEZAS_FUZZ = ["SELECT", "FROM", "WITH", "AS", "IN", "JOIN", "ON", "WHERE", "UNION", "(", ")", ",", ".", ";", "'", '"', "`", "[", "]", "--", "\n", "/*", "*/", "*", "1", "x", ":a", "$a", "?",
  "notas", "'notas'", '"notas"', "main", "main.notas", "sync_state", "'sync_state'", "activities", "v_gym", "v_wellness", "'v_gym'", "sqlite_master", "texto", "raw", "DELETE FROM notas", "UPDATE notas SET texto=1",
  `'a as "b'`, `'c" d'`, "with", "window", "join", "RECURSIVE", "VALUES", "json_each", "replace("];

function pruebasContra(motor: () => Motor, iteraciones: number) {
  const pasarPorElFiltro = async (m: Motor, sql: string): Promise<unknown[] | null> => {
    const q = prepararSql(sql);
    if ("error" in q) return null;
    return m.ejecutar(sqlFinal(q.sql));
  };

  it("el ataque es real: sin el filtro, escribe en notas", async () => {
    const m = motor();
    const antes = await m.ejecutar("SELECT count(*) AS n FROM notas");
    await m.ejecutar(sqlFinal("SELECT 1) ; INSERT INTO notas(fecha, texto) VALUES ('x', 'testigo') ; SELECT * FROM (SELECT 1"));
    expect(await m.ejecutar("SELECT count(*) AS n FROM notas")).not.toEqual(antes);
    await m.ejecutar("DELETE FROM notas WHERE texto = 'testigo'");
  });

  for (const [nombre, sql] of Object.entries(ATAQUES_ESCRITURA)) {
    it(`no cambia nada: ${nombre}`, async () => {
      const m = motor();
      const antes = await foto(m);
      await pasarPorElFiltro(m, sql).catch(() => null);
      expect(await foto(m)).toBe(antes);
    });
  }

  for (const [nombre, sql] of Object.entries(ATAQUES_LECTURA)) {
    it(`no enseña el canario: ${nombre}`, async () => {
      const r = await pasarPorElFiltro(motor(), sql).catch(() => null);
      expect(JSON.stringify(r)).not.toContain(CANARIO);
    });
  }

  for (const sql of LEGITIMAS) {
    it(`funciona: ${sql}`, async () => {
      expect(await pasarPorElFiltro(motor(), sql)).not.toBeNull();
    });
  }

  it(`${iteraciones} consultas al azar: lo que pasa el filtro no escribe ni enseña el canario`, async () => {
    const m = motor();
    const antes = await foto(m);
    const n = azar(20261107);
    let aceptadas = 0;
    for (let i = 0; i < iteraciones; i++) {
      const piezas = Array.from({ length: 1 + n(9) }, () => PIEZAS_FUZZ[n(PIEZAS_FUZZ.length)]);
      const sql = `${n(2) ? "SELECT * FROM" : "SELECT 1,"} ${piezas.join(n(4) ? " " : "")}`;
      const q = prepararSql(sql);
      if ("error" in q) continue;
      aceptadas++;
      const r = await m.ejecutar(sqlFinal(q.sql)).catch(() => null);
      expect(JSON.stringify(r), sql).not.toContain(CANARIO);
    }
    expect(await foto(m)).toBe(antes);
    expect(aceptadas).toBeGreaterThan(0);
  }, 120_000);
}

describe.skipIf(!sqlite)("consulta_sql: en SQLite de verdad", () => {
  let db: any;
  beforeAll(() => {
    db = new sqlite.DatabaseSync(":memory:");
    for (const m of migraciones()) db.exec(m);
    for (const s of SIEMBRA) db.exec(s);
  });
  afterAll(() => db.close());
  pruebasContra(() => ({
    // exec ejecuta todas las sentencias, como D1; prepare lee las filas de la primera
    ejecutar: async (sql) => {
      db.exec(sql);
      return /^\s*(select|with)\b/i.test(sql) ? db.prepare(sql).all() : [];
    },
  }), 4000);
});

describe.skipIf(!process.env.D1_LOCAL)("consulta_sql: en una D1 local", () => {
  let proxy: any;
  let carpeta = "";
  beforeAll(async () => {
    const [{ getPlatformProxy }, os, path] = await Promise.all([nodeImport("wrangler"), nodeImport("node:os"), nodeImport("node:path")]);
    // Configuración temporal, con un id inventado y fuera de la repo: esta base no tiene nada que ver con la real
    carpeta = fs.mkdtempSync(path.join(os.tmpdir(), "d1-consulta-sql-"));
    fs.writeFileSync(path.join(carpeta, "w.js"), "export default { fetch() { return new Response('ok'); } };");
    fs.writeFileSync(path.join(carpeta, "wrangler.toml"), `name = "prueba-local"\nmain = "w.js"\ncompatibility_date = "2026-06-01"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "prueba"\ndatabase_id = "00000000-0000-0000-0000-000000000000"\n`);
    proxy = await getPlatformProxy({ configPath: path.join(carpeta, "wrangler.toml"), persist: false });
    for (const m of migraciones()) await proxy.env.DB.prepare(m).all();
    for (const s of SIEMBRA) await proxy.env.DB.prepare(s).all();
  }, 120_000);
  afterAll(async () => {
    await proxy?.dispose();
    if (carpeta) fs.rmSync(carpeta, { recursive: true, force: true });
  });
  pruebasContra(() => ({
    ejecutar: async (sql) => (await proxy.env.DB.prepare(sql).all()).results ?? [],
  }), 1500);
});
