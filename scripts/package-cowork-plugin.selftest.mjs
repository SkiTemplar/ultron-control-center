/**
 * package-cowork-plugin.selftest.mjs — check del empaquetador del plugin de
 * Cowork (scripts/package-cowork-plugin.mjs).
 *
 * Hermetico: construye un arbol de plugin falso en logs/_selftest-package-cowork-plugin
 * y nunca escribe plugins/ultron-memory-cowork.zip. El plugin real solo se lee
 * (salvo el caso I, que sincroniza server/ contra las fuentes canonicas: es la
 * misma operacion que hace `node scripts/package-cowork-plugin.mjs`).
 *
 * Casos:
 *   A) estructura: entradas de directorio explicitas, separador "/", orden
 *      estable, made-by Unix, flag UTF-8, modos 0644 / 0755.
 *   B) ida y vuelta: cada fichero se descomprime desde su cabecera local y
 *      coincide byte a byte con el origen, CRC incluido.
 *   C) determinismo: dos empaquetados del mismo arbol son identicos.
 *   D) negativos de nombre: backslash, "..", ".", absoluta, unidad de Windows,
 *      segmento vacio y zip anidado se rechazan.
 *   E) negativo: arbol sin .claude-plugin/plugin.json se rechaza.
 *   F) negativo: un .zip dentro del arbol se rechaza.
 *   G) plugin real: manifiesto, .mcp.json, hooks/hooks.json, ambos servidores
 *      MCP y ningun .zip.
 *   H) CLI: --src/--out escribe el zip (exit 0); argumento desconocido o --src
 *      inexistente exit 1.
 *   I) resolveLocalClosure: sigue require()/import locales (literal y
 *      path.join(__dirname|'..', ...)), incluye el cierre completo y lanza
 *      ante un require que no resuelve.
 *   J) syncManagedServers + pruneOrphans: copia lo que cambio, borra un
 *      fichero huerfano y una carpeta que se queda vacia, es idempotente.
 *   K) paridad real: cada fichero bajo server/ del plugin es byte a byte
 *      identico a su fuente en scripts/ o hooks/scripts/ (ejecuta
 *      `node scripts/package-cowork-plugin.mjs` si esto falla).
 *   L) hooks.json y .mcp.json del plugin real: cada command/args referencia
 *      un fichero que existe tras el cierre resuelto de su grupo.
 *
 * Uso: node scripts/package-cowork-plugin.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import {
  DEFAULT_SRC,
  MANIFEST,
  SYNC_GROUPS,
  buildZip,
  collectEntries,
  extractLocalTargets,
  listZipEntries,
  resolveLocalClosure,
  syncManagedServers,
  syncServerCopy,
  validateEntryName,
} from "./package-cowork-plugin.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const SCRIPT = join(__dirname, "package-cowork-plugin.mjs");
const REAL_PLUGIN = join(ULTRON, "plugins", "ultron-memory-cowork");
const TMPDIR = join(ULTRON, "logs", "_selftest-package-cowork-plugin");
const TREE = join(TMPDIR, "plugin");

rmSync(TMPDIR, { recursive: true, force: true });
mkdirSync(join(TREE, ".claude-plugin"), { recursive: true });
mkdirSync(join(TREE, "server"), { recursive: true });
writeFileSync(join(TREE, ".claude-plugin", "plugin.json"), '{"name":"demo","version":"1.0.0"}\n');
writeFileSync(join(TREE, ".mcp.json"), '{"mcpServers":{}}\n');
writeFileSync(join(TREE, "server", "srv.mjs"), "// ".repeat(400) + "\n");
writeFileSync(join(TREE, "README.md"), "demo\n");

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));
const throws = (fn, re) => {
  try { fn(); return false; } catch (err) { return re.test(err.message); }
};

// A) estructura
const entries = collectEntries(TREE);
const zip = buildZip(entries);
const listed = listZipEntries(zip);
const names = listed.map((e) => e.name);
const expected = [".claude-plugin/", ".claude-plugin/plugin.json", ".mcp.json", "README.md", "server/", "server/srv.mjs"];
A(JSON.stringify(names) === JSON.stringify(expected), "A: nombres, orden y directorios explicitos", JSON.stringify(names));
A(names.every((n) => !n.includes("\\")), "A: separador /", JSON.stringify(names));
A(listed.every((e) => e.madeBy >> 8 === 3), "A: made-by Unix", listed.map((e) => e.madeBy).join(","));
A(listed.every((e) => (e.flags & 0x0800) !== 0), "A: flag UTF-8", listed.map((e) => e.flags).join(","));
const modeOf = (e) => (e.externalAttr >>> 16) & 0o777;
A(listed.filter((e) => e.name.endsWith("/")).every((e) => modeOf(e) === 0o755), "A: directorios 0755", "");
A(listed.filter((e) => !e.name.endsWith("/")).every((e) => modeOf(e) === 0o644), "A: ficheros 0644", "");

// B) ida y vuelta
const bodyOf = (e) => {
  const start = e.localOffset + 30 + zip.readUInt16LE(e.localOffset + 26) + zip.readUInt16LE(e.localOffset + 28);
  const raw = zip.subarray(start, start + e.compressedSize);
  return e.method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
};
const mismatches = listed
  .filter((e) => !e.name.endsWith("/"))
  .filter((e) => {
    const src = readFileSync(join(TREE, ...e.name.split("/")));
    const out = bodyOf(e);
    return !out.equals(src) || crc32(out) !== e.crc || out.length !== e.size;
  })
  .map((e) => e.name);
A(mismatches.length === 0, "B: contenido y CRC coinciden", mismatches.join(","));
A(listed.some((e) => e.method === 8), "B: al menos una entrada deflate", "");

// C) determinismo
A(buildZip(collectEntries(TREE)).equals(zip), "C: mismo arbol -> mismo zip", "");

// D) negativos de nombre
const badNames = ["a\\b.txt", "../x", "a/../b", "./a", "/abs", "C:/x", "a//b", "inner.zip", "CON", "server/nul.txt", "com1/"];
const accepted = badNames.filter((n) => !throws(() => validateEntryName(n), /./));
A(accepted.length === 0, "D: nombres invalidos rechazados", accepted.join(" | "));
A(!throws(() => validateEntryName(".claude-plugin/plugin.json"), /./), "D: nombre valido aceptado", "");

// E) sin manifiesto
const NOMANIFEST = join(TMPDIR, "sin-manifiesto");
mkdirSync(NOMANIFEST, { recursive: true });
writeFileSync(join(NOMANIFEST, ".mcp.json"), "{}\n");
A(throws(() => collectEntries(NOMANIFEST), /falta/), "E: arbol sin manifiesto rechazado", "");

// F) zip anidado
const NESTED = join(TMPDIR, "anidado");
mkdirSync(join(NESTED, ".claude-plugin"), { recursive: true });
writeFileSync(join(NESTED, ".claude-plugin", "plugin.json"), "{}\n");
writeFileSync(join(NESTED, "dist.zip"), "PK");
A(throws(() => collectEntries(NESTED), /zip anidado/), "F: zip anidado rechazado", "");

// G) plugin real (solo lectura)
const real = collectEntries(REAL_PLUGIN).map((e) => e.name);
A(
  real.includes(MANIFEST) && real.includes(".mcp.json") && real.includes("hooks/hooks.json")
    && real.includes("server/mcp-memory-server.mjs") && real.includes("server/hooks-scripts/research-mcp.js"),
  "G: plugin real con manifiesto, .mcp.json, hooks.json y ambos servidores MCP",
  real.join(","),
);
A(!real.some((n) => /\.zip$/i.test(n)), "G: plugin real sin .zip anidado", real.filter((n) => /\.zip$/i.test(n)).join(","));

// H) CLI
const OUT = join(TMPDIR, "demo.zip");
const run = spawnSync(process.execPath, [SCRIPT, "--src", TREE, "--out", OUT], { encoding: "utf8" });
A(run.status === 0 && existsSync(OUT) && readFileSync(OUT).equals(zip), "H: CLI escribe el zip esperado", run.stderr);
const bad = spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" });
A(bad.status === 1 && /argumento desconocido/.test(bad.stderr), "H: argumento desconocido -> exit 1", bad.stderr);
const missing = spawnSync(process.execPath, [SCRIPT, "--src", join(TMPDIR, "no-existe"), "--out", join(TMPDIR, "x.zip")], { encoding: "utf8" });
A(missing.status === 1 && /no existe la carpeta/.test(missing.stderr) && !existsSync(join(TMPDIR, "x.zip")),
  "H: --src inexistente -> exit 1 sin escribir zip", missing.stderr);

// I) resolveLocalClosure
const CLOSURE_ROOT = join(TMPDIR, "closure");
mkdirSync(join(CLOSURE_ROOT, "lib", "deep"), { recursive: true });
writeFileSync(join(CLOSURE_ROOT, "entry.js"), [
  "const a = require('./lib/a');",
  "const path = require('path');",
  "const b = require(path.join(__dirname, 'lib', 'b.js'));",
].join("\n"));
writeFileSync(join(CLOSURE_ROOT, "lib", "a.js"), "const c = require('./deep/c');\nmodule.exports = c;\n");
writeFileSync(join(CLOSURE_ROOT, "lib", "b.js"), "const path = require('path');\nconst c = require(path.join('..', 'lib', 'deep', 'c.js'));\nmodule.exports = c;\n");
writeFileSync(join(CLOSURE_ROOT, "lib", "deep", "c.js"), "module.exports = 1;\n");
const closure = resolveLocalClosure(CLOSURE_ROOT, ["entry.js"]);
A(
  JSON.stringify(closure) === JSON.stringify(["entry.js", "lib/a.js", "lib/b.js", "lib/deep/c.js"]),
  "I: resolveLocalClosure sigue require literal y path.join(__dirname|'..', ...)",
  JSON.stringify(closure),
);
writeFileSync(join(CLOSURE_ROOT, "roto.js"), "const x = require('./no-existe');\n");
A(throws(() => resolveLocalClosure(CLOSURE_ROOT, ["roto.js"]), /require local sin resolver/),
  "I: require local que no resuelve lanza", "");
A(extractLocalTargets("import { x } from '../y.mjs';").includes("../y.mjs"), "I: extractLocalTargets reconoce import ESM", "");

// J) syncManagedServers + pruneOrphans
const SYNC_ROOT = join(TMPDIR, "sync-root");
mkdirSync(SYNC_ROOT, { recursive: true });
writeFileSync(join(SYNC_ROOT, "srv.js"), "const dep = require('./lib/dep');\nmodule.exports = dep;\n");
mkdirSync(join(SYNC_ROOT, "lib"), { recursive: true });
writeFileSync(join(SYNC_ROOT, "lib", "dep.js"), "module.exports = 1;\n");
const SYNC_PLUGIN = join(TMPDIR, "sync-plugin");
mkdirSync(SYNC_PLUGIN, { recursive: true });
const group = { id: "demo", root: SYNC_ROOT, entries: ["srv.js"], destPrefix: "server/demo" };
const first = syncManagedServers(SYNC_PLUGIN, [group]);
A(first.changed === 2, "J: primera sincronizacion copia entry + dep", String(first.changed));
A(
  existsSync(join(SYNC_PLUGIN, "server", "demo", "srv.js")) && existsSync(join(SYNC_PLUGIN, "server", "demo", "lib", "dep.js")),
  "J: arbol copiado con la misma estructura relativa",
  "",
);
const second = syncManagedServers(SYNC_PLUGIN, [group]);
A(second.changed === 0, "J: segunda pasada sin cambios es idempotente", String(second.changed));
// huerfano: un fichero que ya no forma parte del cierre desaparece, y su carpeta si queda vacia tambien
writeFileSync(join(SYNC_PLUGIN, "server", "demo", "lib", "huerfano.js"), "// ya no se genera desde la fuente\n");
mkdirSync(join(SYNC_PLUGIN, "server", "demo", "lib", "vacia"), { recursive: true });
const third = syncManagedServers(SYNC_PLUGIN, [group]);
A(
  third.changed === 1 && !existsSync(join(SYNC_PLUGIN, "server", "demo", "lib", "huerfano.js")) && !existsSync(join(SYNC_PLUGIN, "server", "demo", "lib", "vacia")),
  "J: pruneOrphans borra fichero huerfano y carpeta vacia",
  `changed=${third.changed}`,
);

// K) paridad real: sincroniza el plugin real y comprueba que no quedo nada por copiar
const beforeSync = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
A(beforeSync.status === 0, "K: package-cowork-plugin.mjs (plugin real) sale con exit 0", beforeSync.stderr);
const { changed: realChanged, resolved } = syncManagedServers(REAL_PLUGIN, SYNC_GROUPS);
A(realChanged === 0, "K: tras sincronizar, una segunda pasada no cambia nada (plugin real al dia)", String(realChanged));
const diffs = [];
for (const { group: g, rels } of resolved) {
  for (const rel of rels) {
    const canonical = join(g.root, ...rel.split("/"));
    const copy = join(REAL_PLUGIN, ...g.destPrefix.split("/"), ...rel.split("/"));
    if (!existsSync(copy) || !readFileSync(copy).equals(readFileSync(canonical))) diffs.push(`${g.id}:${rel}`);
  }
}
A(diffs.length === 0, "K: cada fichero del cierre resuelto es identico a su fuente", diffs.join(","));

// L) hooks.json y .mcp.json del plugin real referencian ficheros existentes
const hooksJson = JSON.parse(readFileSync(join(REAL_PLUGIN, "hooks", "hooks.json"), "utf8"));
const hookCommands = Object.values(hooksJson.hooks).flat().flatMap((m) => m.hooks).map((h) => h.command);
const hookPathsExist = hookCommands.every((cmd) => {
  const m = cmd.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/);
  return m && existsSync(join(REAL_PLUGIN, m[1]));
});
A(hookPathsExist && hookCommands.length === 3, "L: hooks.json referencia 3 comandos y los 3 ficheros existen", hookCommands.join(" | "));
const mcpJson = JSON.parse(readFileSync(join(REAL_PLUGIN, ".mcp.json"), "utf8"));
const mcpArgsExist = Object.values(mcpJson.mcpServers).every((s) =>
  s.args.every((a) => !a.includes("${CLAUDE_PLUGIN_ROOT}") || existsSync(join(REAL_PLUGIN, a.replace("${CLAUDE_PLUGIN_ROOT}/", "")))));
A(mcpArgsExist && Object.keys(mcpJson.mcpServers).length === 2, "L: .mcp.json referencia 2 servidores y sus ficheros existen", JSON.stringify(mcpJson));

rmSync(TMPDIR, { recursive: true, force: true });
console.log(fail === 0 ? "package-cowork-plugin selftest: OK" : `package-cowork-plugin selftest: ${fail} fallo(s)`);
process.exit(fail === 0 ? 0 : 1);
