/**
 * codegraph-summary.selftest.mjs — check de lib/codegraph-summary.js (ULTRON 4,
 * F8.1): resumen del indice CodeGraph para el resume de SessionStart.
 *
 * Hermetico: crea un `.codegraph/codegraph.db` sintetico con el esquema real
 * (nodes/edges/files) bajo logs/_selftest-codegraph-summary/.
 *
 * Uso: node hooks/scripts/codegraph-summary.selftest.mjs   (exit 0 = verde)
 */
import { existsSync, rmSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..", "..");
const FIXTURE = join(ULTRON, "logs", "_selftest-codegraph-summary");
const ROOT = join(FIXTURE, "proyecto");
const SUB = join(ROOT, "src", "deep");
const DB = join(ROOT, ".codegraph", "codegraph.db");

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true, force: true });
mkdirSync(join(ROOT, ".codegraph"), { recursive: true });
mkdirSync(SUB, { recursive: true });

const db = new DatabaseSync(DB);
db.exec(`
  CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, start_column INTEGER NOT NULL, end_column INTEGER NOT NULL);
  CREATE TABLE edges (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL);
  CREATE TABLE files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0);
`);
const node = db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,1,1,0,0)");
const edge = db.prepare("INSERT INTO edges (source,target,kind) VALUES (?,?,?)");
const file = db.prepare("INSERT INTO files VALUES (?,?,?,?,?,?,?)");
// Ficheros y zonas
file.run("src/memory/service.rs", "h", "rust", 10, 1, 1, 40);
file.run("src/memory/store.rs", "h", "rust", 10, 1, 1, 30);
file.run("src/router/route.rs", "h", "rust", 10, 1, 1, 20);
file.run("hooks/a.js", "h", "javascript", 10, 1, 1, 12);
file.run("README.md", "h", "markdown", 10, 1, 1, 0);
// Simbolos: MemoryService (hub real), unwrap (stoplist), Cfg (usado solo desde su fichero)
node.run("svc", "struct", "MemoryService", "memory::MemoryService", "src/memory/service.rs", "rust");
node.run("unw", "method", "unwrap", "unwrap", "src/memory/store.rs", "rust");
node.run("cfg", "struct", "Cfg", "Cfg", "src/router/route.rs", "rust");
node.run("imp", "import", "MemoryService", "MemoryService", "hooks/a.js", "javascript");
for (let i = 0; i < 6; i++) node.run(`c${i}`, "function", `caller${i}`, `caller${i}`, i < 3 ? "src/router/route.rs" : `hooks/f${i}.js`, "rust");
for (let i = 0; i < 6; i++) edge.run(`c${i}`, "svc", "calls");           // svc: 4 ficheros distintos (route.rs + 3 hooks)
for (let i = 0; i < 6; i++) edge.run(`c${i}`, "unw", "calls");           // unwrap: mismo fan-in pero stoplist
edge.run("c0", "cfg", "references");                                     // cfg: solo desde su propio fichero (excluido)
edge.run("c0", "imp", "imports");                                        // import: kind fuera de HUB_KINDS
db.close();

const require = createRequire(import.meta.url);
const lib = require("./lib/codegraph-summary.js");

A(lib.findIndexRoot(SUB) === ROOT, "findIndexRoot: una subcarpeta (2 niveles) encuentra la raiz del indice", String(lib.findIndexRoot(SUB)));
// El negativo vive FUERA de ~/.ultron: findIndexRoot sube hasta dos niveles y
// el fixture cuelga de logs/, que tiene el indice de ULTRON encima.
const { tmpdir } = await import("node:os");
const SIN_INDICE = join(tmpdir(), `ultron-cg-selftest-${Date.now()}`, "sub");
mkdirSync(SIN_INDICE, { recursive: true });
A(lib.findIndexRoot(SIN_INDICE) === null, "findIndexRoot (NEGATIVO): sin .codegraph en el arbol -> null", String(lib.findIndexRoot(SIN_INDICE)));
A(lib.summarize(SIN_INDICE) === null, "summarize (NEGATIVO): sin indice -> null", "");
rmSync(dirname(SIN_INDICE), { recursive: true, force: true });

const s = lib.summarize(ROOT);
A(s && s.files === 5 && s.symbols === 10 && s.edges === 14 && s.from_cache === false, "summarize: conteos de ficheros, simbolos (sin kind=file) y aristas", JSON.stringify(s && { files: s.files, symbols: s.symbols, edges: s.edges }));
A(s && s.languages[0].language === "rust" && s.languages[0].symbols === 90 && !s.languages.some((l) => l.language === "markdown"), "summarize: lenguajes por simbolos, sin los de 0", JSON.stringify(s && s.languages));
A(s && s.zones[0].dir === "src/memory" && s.zones[0].symbols === 70 && s.zones[1].dir === "src/router", "summarize: zonas = dos primeros segmentos, ordenadas por simbolos", JSON.stringify(s && s.zones));
A(s && s.hubs.length === 1 && s.hubs[0].name === "MemoryService" && s.hubs[0].files === 4, "summarize: hub = usado desde mas ficheros; unwrap (stoplist), Cfg (mismo fichero) e import fuera", JSON.stringify(s && s.hubs));
A(existsSync(join(ROOT, ".codegraph", "ultron-summary.json")), "summarize: cache escrita en .codegraph/ultron-summary.json", "");
const s2 = lib.summarize(ROOT);
A(s2 && s2.from_cache === true && s2.symbols === 10, "summarize: segunda llamada sale de la cache", JSON.stringify(s2 && { from_cache: s2.from_cache }));
// Cache invalidada cuando el .db cambia de mtime
const future = new Date(Date.now() + 5000);
utimesSync(DB, future, future);
const s3 = lib.summarize(ROOT);
A(s3 && s3.from_cache === false, "summarize: un .db mas nuevo invalida la cache", JSON.stringify(s3 && { from_cache: s3.from_cache }));

const lines = lib.renderLines(s);
A(lines.length === 4 && /^codegraph \(indice \.codegraph: 5 ficheros, 10 simbolos, 14 aristas; rust 90, javascript 12\):$/.test(lines[0]), "renderLines: cabecera con conteos y lenguajes", lines[0]);
A(/^  zonas: src\/memory \(70\) · src\/router \(20\) · hooks\/a\.js \(12\)$/.test(lines[1]), "renderLines: zonas", lines[1]);
A(/MemoryService \[struct, 4 fich\.\]/.test(lines[2]) && /codegraph_explore/.test(lines[3]), "renderLines: hubs e instruccion de uso", lines[2] + " | " + lines[3]);
A(lib.renderLines(null).length === 0, "renderLines (NEGATIVO): sin resumen -> []", "");
A(lib.human(12434) === "12,4k" && lib.human(737) === "737" && lib.human(24000) === "24k", "human: 12434 -> 12,4k, 737 -> 737, 24000 -> 24k", `${lib.human(12434)} ${lib.human(737)} ${lib.human(24000)}`);

// Indice desmesurado -> no se resume (guard de tamano, probado con el tope por entorno)
{
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", ["-e", `console.log(JSON.stringify(require(${JSON.stringify(join(__dirname, "lib", "codegraph-summary.js"))}).summarize(${JSON.stringify(ROOT)})))`], {
    encoding: "utf8", env: { ...process.env, CODEGRAPH_SUMMARY_MAX_DB_BYTES: "1024" },
  });
  A(r.stdout.trim() === "null", "summarize (NEGATIVO): un .db por encima del tope de tamano -> null", r.stdout.trim().slice(0, 80));
}

rmSync(FIXTURE, { recursive: true, force: true });
console.log(fail === 0 ? "\nSELFTEST codegraph-summary: VERDE" : `\nSELFTEST codegraph-summary: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
