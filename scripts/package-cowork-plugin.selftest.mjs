/**
 * package-cowork-plugin.selftest.mjs — check del empaquetador del plugin de
 * Cowork (scripts/package-cowork-plugin.mjs).
 *
 * Hermetico: construye un arbol de plugin falso en logs/_selftest-package-cowork-plugin
 * y nunca escribe plugins/ultron-memory-cowork.zip. El plugin real solo se lee.
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
 *   G) plugin real: contiene manifiesto, .mcp.json y server, y ningun .zip.
 *   H) CLI: --src/--out escribe el zip (exit 0); argumento desconocido o --src
 *      inexistente exit 1.
 *   I) paridad: server/ del plugin identico a scripts/mcp-memory-server.mjs
 *      (solo lectura); syncServerCopy sobrescribe una vez, no reescribe si ya
 *      coincide y crea la copia si falta.
 *
 * Uso: node scripts/package-cowork-plugin.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";
import {
  CANONICAL_SERVER,
  DEFAULT_SRC,
  MANIFEST,
  PLUGIN_SERVER_REL,
  buildZip,
  collectEntries,
  listZipEntries,
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
A(real.includes(MANIFEST) && real.includes(".mcp.json") && real.includes("server/mcp-memory-server.mjs"),
  "G: plugin real con manifiesto, .mcp.json y server", real.join(","));

// H) CLI
const OUT = join(TMPDIR, "demo.zip");
const run = spawnSync(process.execPath, [SCRIPT, "--src", TREE, "--out", OUT], { encoding: "utf8" });
A(run.status === 0 && existsSync(OUT) && readFileSync(OUT).equals(zip), "H: CLI escribe el zip esperado", run.stderr);
const bad = spawnSync(process.execPath, [SCRIPT, "--nope"], { encoding: "utf8" });
A(bad.status === 1 && /argumento desconocido/.test(bad.stderr), "H: argumento desconocido -> exit 1", bad.stderr);
const missing = spawnSync(process.execPath, [SCRIPT, "--src", join(TMPDIR, "no-existe"), "--out", join(TMPDIR, "x.zip")], { encoding: "utf8" });
A(missing.status === 1 && /no existe la carpeta/.test(missing.stderr) && !existsSync(join(TMPDIR, "x.zip")),
  "H: --src inexistente -> exit 1 sin escribir zip", missing.stderr);

// I) paridad del servidor MCP
const copyPath = join(DEFAULT_SRC, PLUGIN_SERVER_REL);
A(readFileSync(copyPath).equals(readFileSync(CANONICAL_SERVER)),
  "I: server/ del plugin identico a scripts/mcp-memory-server.mjs",
  "difieren: ejecuta node scripts/package-cowork-plugin.mjs");
const SYNC = join(TMPDIR, "sync");
mkdirSync(join(SYNC, "server"), { recursive: true });
writeFileSync(join(SYNC, "fuente.mjs"), "// v2\n");
writeFileSync(join(SYNC, "server", "copia.mjs"), "// v1\n");
const first = syncServerCopy(join(SYNC, "fuente.mjs"), join(SYNC, "server", "copia.mjs"));
const second = syncServerCopy(join(SYNC, "fuente.mjs"), join(SYNC, "server", "copia.mjs"));
A(first === true && second === false && readFileSync(join(SYNC, "server", "copia.mjs"), "utf8") === "// v2\n",
  "I: syncServerCopy sobrescribe una vez y no reescribe si ya coincide", `${first}/${second}`);
A(syncServerCopy(join(SYNC, "fuente.mjs"), join(SYNC, "nueva", "copia.mjs")) === true && existsSync(join(SYNC, "nueva", "copia.mjs")),
  "I: syncServerCopy crea la copia si falta", "");

rmSync(TMPDIR, { recursive: true, force: true });
console.log(fail === 0 ? "package-cowork-plugin selftest: OK" : `package-cowork-plugin selftest: ${fail} fallo(s)`);
process.exit(fail === 0 ? 0 : 1);
