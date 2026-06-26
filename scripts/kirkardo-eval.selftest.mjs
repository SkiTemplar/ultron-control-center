/**
 * kirkardo-eval.selftest.mjs — check conductual de la casilla 0.4 (medidor honesto).
 *
 * Falla SIN el fix:
 *   A) Pre-fix, un run --cat=N pisaba logs/kirkardo-eval.json (canonico) -> la
 *      asercion "canonico intacto" fallaba y no existia kirkardo-eval.scoped.json.
 *   B) Pre-fix, readHarnessNote() lideraba con `overall` (el "10" de un run cat19) y
 *      NO descartaba runs scoped -> las aserciones de all_cats_pass/scoped fallaban.
 *
 * Uso: node scripts/kirkardo-eval.selftest.mjs   (exit 0 = verde, 1 = rojo)
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const LOGS = join(ULTRON, "logs");
const CANON = join(LOGS, "kirkardo-eval.json");
const SCOPED = join(LOGS, "kirkardo-eval.scoped.json");
const require = createRequire(import.meta.url);

let failures = 0;
const ok = (name) => console.log(`  [PASS] ${name}`);
const ko = (name, detail) => { failures++; console.log(`  [FAIL] ${name}\n         -> ${detail}`); };
function assert(cond, name, detail) { cond ? ok(name) : ko(name, detail); }

// ---------------------------------------------------------------------------
// A) Un run scoped (--cat) NO contamina el JSON canonico + escribe side-file.
// ---------------------------------------------------------------------------
console.log("A) scoped run no clobber + side-file");
const canonBefore = existsSync(CANON) ? readFileSync(CANON, "utf8") : null;
if (existsSync(SCOPED)) rmSync(SCOPED); // empezar limpio

execFileSync("node", [join("scripts", "kirkardo-eval.mjs"), "--cat=19", "--no-gate", "--json"], {
  cwd: ULTRON, encoding: "utf8", stdio: ["ignore", "ignore", "inherit"],
});

const canonAfter = existsSync(CANON) ? readFileSync(CANON, "utf8") : null;
assert(canonBefore === canonAfter, "canonico intacto tras run --cat=19",
  "el run scoped pisó logs/kirkardo-eval.json (regresion del clobber)");
assert(existsSync(SCOPED), "existe logs/kirkardo-eval.scoped.json", "el run scoped no escribio su side-file");
if (existsSync(SCOPED)) {
  const s = JSON.parse(readFileSync(SCOPED, "utf8"));
  assert(s.scoped === true, "side-file marcado scoped:true", `scoped=${s.scoped}`);
  assert(Array.isArray(s.cats_run) && s.cats_run.length === 1 && s.cats_run[0] === 19,
    "side-file cats_run=[19]", `cats_run=${JSON.stringify(s.cats_run)}`);
  assert(s.all_cats_pass === false, "scoped no afirma all_cats_pass", `all_cats_pass=${s.all_cats_pass}`);
}

// ---------------------------------------------------------------------------
// B) readHarnessNote: descarta scoped + lidera con all_cats_pass (no overall).
// ---------------------------------------------------------------------------
console.log("B) readHarnessNote honesto");
const { readHarnessNote } = require(join(ULTRON, "hooks", "scripts", "memory-session-resume.js"));
const tmp = join(LOGS, "_selftest");
if (!existsSync(tmp)) require("node:fs").mkdirSync(tmp, { recursive: true });

// B1: un JSON scoped (el "10" del 06-25) NO debe inyectarse.
const fxScoped = join(tmp, "scoped.json");
writeFileSync(fxScoped, JSON.stringify({ scoped: true, overall: 10, overall_core: 0, all_cats_pass: true, laggards: [] }));
assert(readHarnessNote(fxScoped) === "", "scoped -> nota vacia (no propaga el 10)",
  `devolvio: "${readHarnessNote(fxScoped)}"`);

// B2: un run COMPLETO con laggards -> nota honesta (FAIL + laggards, no '10' suelto).
const fxFull = join(tmp, "full.json");
writeFileSync(fxFull, JSON.stringify({
  scoped: false, overall: 7.95, overall_core: 9.51, all_cats_pass: false,
  laggards: [{ cat: 20, nota: 0 }, { cat: 21, nota: 0 }, { cat: 8, nota: 3.3 }],
}));
const note = readHarnessNote(fxFull);
assert(note.includes("all_cats_pass=FAIL"), "nota lidera con all_cats_pass=FAIL", `nota="${note}"`);
assert(note.includes("cat20=0"), "nota muestra laggard cat20=0", `nota="${note}"`);
assert(note.includes("core 9.51"), "nota cita core 9.51", `nota="${note}"`);
assert(!/:\s*overall \d/.test(note), "no lidera con 'overall N' como headline", `nota="${note}"`);

// B3: un run COMPLETO limpio -> PASS.
const fxPass = join(tmp, "pass.json");
writeFileSync(fxPass, JSON.stringify({ scoped: false, overall: 9.8, overall_core: 9.9, all_cats_pass: true, laggards: [] }));
assert(readHarnessNote(fxPass).includes("all_cats_pass=PASS"), "run limpio -> all_cats_pass=PASS",
  `nota="${readHarnessNote(fxPass)}"`);

rmSync(tmp, { recursive: true, force: true });

console.log(failures === 0 ? "\nSELFTEST 0.4: VERDE" : `\nSELFTEST 0.4: ROJO (${failures} fallo/s)`);
process.exit(failures === 0 ? 0 : 1);
