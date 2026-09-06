/**
 * run-project-tests.selftest.mjs — check conductual de F4.1 (tests
 * automaticos tras editar codigo): trigger PostToolUse, runner desacoplado,
 * reporter UserPromptSubmit y lib/run-project-tests.js.
 *
 * Hermetico: RUN_TESTS_STATE_DIR / RUN_TESTS_PROJECT apuntan a un fixture
 * temporal bajo logs/_selftest-run-tests/; los "tests" del proyecto fixture
 * son scripts node que imitan la salida de vitest/cargo. Debounce a 0 salvo
 * en el caso que lo prueba.
 *
 * Uso: node hooks/scripts/run-project-tests.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..", "..");
const TRIGGER = join(__dirname, "run-project-tests.js");
const REPORT = join(__dirname, "run-project-tests-report.js");

const FIXTURE = join(ULTRON, "logs", "_selftest-run-tests");
const STATE_DIR = join(FIXTURE, "state");
const PROJ_DIR = join(FIXTURE, "proj");
const PROJECT = "proj-selftest";

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const BASE_ENV = { ...process.env, RUN_TESTS_STATE_DIR: STATE_DIR, RUN_TESTS_PROJECT: PROJECT, RUN_TESTS_DEBOUNCE_MS: "0" };

function reset() {
  if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(PROJ_DIR, "src"), { recursive: true });
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(PROJ_DIR, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(PROJ_DIR, "README.md"), "# fixture\n");
  writeFileSync(join(PROJ_DIR, "fail.js"), [
    "console.log(' FAIL  src/a.test.ts > suma > devuelve 2');",
    "console.log(' ✕ suma devuelve 2 12ms');",
    "console.log(' ✕ resta devuelve 0');",
    "console.log(' Tests  2 failed | 3 passed');",
    "process.exit(1);",
  ].join("\n"));
  writeFileSync(join(PROJ_DIR, "pass.js"), "console.log(' Tests  5 passed'); process.exit(0);");
  writeFileSync(join(PROJ_DIR, "custom.js"), [
    "console.log('test memory::tests::alpha ... FAILED');",
    "console.log('test memory::tests::beta ... ok');",
    "console.log('test result: FAILED. 4 passed; 1 failed; 0 ignored');",
    "process.exit(101);",
  ].join("\n"));
  writeFileSync(join(PROJ_DIR, "slow.js"), "setTimeout(() => process.exit(0), 4000);");
}

function setPackageTest(script) {
  writeFileSync(join(PROJ_DIR, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0", scripts: { test: script } }, null, 2));
}

function fire(script, payload, extraEnv = {}) {
  const r = spawnSync("node", [script], { input: JSON.stringify(payload), encoding: "utf8", timeout: 20000, env: { ...BASE_ENV, ...extraEnv } });
  return { stdout: (r.stdout || "").trim(), status: r.status, stderr: r.stderr || "" };
}

const editPayload = (file, sessionId = "s1") => ({
  tool_name: "Edit", tool_input: { file_path: join(PROJ_DIR, file) }, cwd: PROJ_DIR, session_id: sessionId,
});

function readResult() {
  const p = join(STATE_DIR, `${PROJECT}.result.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function readState() {
  const p = join(STATE_DIR, `${PROJECT}.state.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
}

// Espera a que el runner desacoplado deje un resultado nuevo y suelte el lock.
function waitResult(afterIso, maxMs = 20000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const r = readResult();
    const s = readState();
    if (r && r.finished_at && r.finished_at > afterIso && !s.running) return r;
    spawnSync("node", ["-e", "setTimeout(()=>{},200)"]);
  }
  return readResult();
}

// ---------------------------------------------------------------------------
// Caso 1: package.json con script real -> runner -> fallo con nombres -> reporter una vez.
reset();
setPackageTest("node fail.js");
let t0 = new Date().toISOString();
let r = fire(TRIGGER, editPayload("src/a.ts"));
A(r.status === 0 && r.stdout === "", "caso1: trigger exit 0 y sin output (async, no habla al modelo)", `status=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
let res = waitResult(t0);
A(res && res.status === "failed" && res.source === "package.json" && /npm test/.test(res.cmd),
  "caso1: runner ejecuta 'npm test' del package.json y registra failed", JSON.stringify(res));
A(res && res.failed_tests.includes("resta devuelve 0") && res.failed_total >= 2,
  "caso1: los nombres de los tests rotos salen del output vitest", JSON.stringify(res && res.failed_tests));
let rep = fire(REPORT, { prompt: "sigue", cwd: PROJ_DIR, session_id: "s1" });
A(/TESTS proj-selftest/.test(rep.stdout) && /resta devuelve 0/.test(rep.stdout) && /Arregla/.test(rep.stdout),
  "caso1: el reporter nombra los tests rotos en el turno siguiente", rep.stdout);
let rep2 = fire(REPORT, { prompt: "sigue", cwd: PROJ_DIR, session_id: "s1" });
A(rep2.stdout === "", "caso1: el mismo fallo no se repite en el turno siguiente", rep2.stdout);

// Caso 2: arreglado -> passed -> 'verdes de nuevo' una sola vez.
setPackageTest("node pass.js");
t0 = new Date().toISOString();
fire(TRIGGER, editPayload("src/a.ts"));
res = waitResult(t0);
A(res && res.status === "passed" && res.failed_total === 0, "caso2: runner registra passed", JSON.stringify(res));
rep = fire(REPORT, { prompt: "sigue", cwd: PROJ_DIR, session_id: "s1" });
A(/verdes de nuevo/.test(rep.stdout), "caso2: tras un fallo reportado, el paso a verde se anuncia", rep.stdout);
rep2 = fire(REPORT, { prompt: "sigue", cwd: PROJ_DIR, session_id: "s1" });
A(rep2.stdout === "", "caso2: verde estable -> silencio", rep2.stdout);

// Caso 3 (NEGATIVO): editar un fichero que no es codigo no lanza nada.
const stateBefore3 = JSON.stringify(readState());
const resBefore3 = JSON.stringify(readResult());
r = fire(TRIGGER, editPayload("README.md"));
A(r.status === 0 && JSON.stringify(readState()) === stateBefore3 && JSON.stringify(readResult()) === resBefore3,
  "caso3: README.md no dispara tests (estado y resultado intactos)", "estado cambio");
r = fire(TRIGGER, { tool_name: "Read", tool_input: { file_path: join(PROJ_DIR, "src", "a.ts") }, cwd: PROJ_DIR, session_id: "s1" });
A(JSON.stringify(readState()) === stateBefore3, "caso3: la herramienta Read no dispara tests", "estado cambio");

// Caso 4: 'test:' en CLAUDE.md manda sobre package.json; salida estilo cargo.
writeFileSync(join(PROJ_DIR, "CLAUDE.md"), "# Proyecto\n\n- test: `node custom.js` (suite corta; la larga se lanza a mano)\n- lint: npm run lint\n");
t0 = new Date().toISOString();
fire(TRIGGER, editPayload("src/a.ts"));
res = waitResult(t0);
A(res && res.cmd === "node custom.js" && res.source === "CLAUDE.md", "caso4: el comando declarado en CLAUDE.md manda", JSON.stringify(res));
A(res && res.status === "failed" && res.failed_tests.length === 1 && res.failed_tests[0] === "memory::tests::alpha" && /4 passed, 1 failed/.test(res.summary),
  "caso4: parser cargo: nombre del test roto + resumen", JSON.stringify(res));

// Caso 5: sin comando -> no_command; reporter una vez por sesion.
reset();
setPackageTest('echo "Error: no test specified" && exit 1');
r = fire(TRIGGER, editPayload("src/a.ts", "s5"));
res = readResult();
A(res && res.status === "no_command", "caso5: placeholder de npm = sin comando de test", JSON.stringify(res));
rep = fire(REPORT, { prompt: "sigue", cwd: PROJ_DIR, session_id: "s5" });
A(/sin comando de test/.test(rep.stdout), "caso5: el reporter avisa de que no hay tests", rep.stdout);
rep2 = fire(REPORT, { prompt: "sigue", cwd: PROJ_DIR, session_id: "s5" });
A(rep2.stdout === "", "caso5: una sola vez por sesion", rep2.stdout);
const rep3 = fire(REPORT, { prompt: "sigue", cwd: PROJ_DIR, session_id: "s6" });
A(/sin comando de test/.test(rep3.stdout), "caso5: en otra sesion se vuelve a decir", rep3.stdout);

// Caso 6: debounce -> la segunda edicion en la ventana no lanza otro runner.
reset();
setPackageTest("node pass.js");
t0 = new Date().toISOString();
fire(TRIGGER, editPayload("src/a.ts"), { RUN_TESTS_DEBOUNCE_MS: "60000" });
waitResult(t0);
fire(TRIGGER, editPayload("src/a.ts"), { RUN_TESTS_DEBOUNCE_MS: "60000" });
A(readState().skipped_debounce === 1, "caso6: segunda edicion dentro del debounce -> no relanza", JSON.stringify(readState()));

// Caso 7: tope de tiempo -> timeout -> reporter pide un comando mas corto.
reset();
writeFileSync(join(PROJ_DIR, "CLAUDE.md"), "test: node slow.js\n");
t0 = new Date().toISOString();
fire(TRIGGER, editPayload("src/a.ts", "s7"), { RUN_TESTS_TIME_CAP_MS: "1500" });
res = waitResult(t0);
A(res && res.status === "timeout", "caso7: la suite que no cabe en el tope queda como timeout", JSON.stringify(res));
rep = fire(REPORT, { prompt: "sigue", cwd: PROJ_DIR, session_id: "s7" }, { RUN_TESTS_TIME_CAP_MS: "1500" });
A(/no terminó en 2 s/.test(rep.stdout) && /más corta/.test(rep.stdout), "caso7: el reporter pide un comando mas corto", rep.stdout);

// Caso 8: lib — parsers y deteccion por manifiesto.
const require = createRequire(import.meta.url);
process.env.RUN_TESTS_STATE_DIR = STATE_DIR;
const lib = require("./lib/run-project-tests.js");
const py = lib.parseFailures("FAILED tests/test_x.py::test_login - AssertionError\nFAILED tests/test_y.py::test_b\n===== 2 failed, 10 passed in 1.2s =====", 1);
A(py.failed.length === 2 && py.failed[0] === "tests/test_x.py::test_login" && /pytest: 2 failed/.test(py.summary), "caso8: parser pytest", JSON.stringify(py));
const go = lib.parseFailures("--- FAIL: TestSum (0.00s)\nFAIL\nexit status 1", 1);
A(go.failed.length === 1 && go.failed[0] === "TestSum", "caso8: parser go", JSON.stringify(go));
const gen = lib.parseFailures("boom", 3);
A(gen.failed.length === 0 && gen.summary === "exit 3", "caso8 (NEGATIVO): salida sin patron -> lista vacia y exit code", JSON.stringify(gen));
const det = (files) => { const d = join(FIXTURE, "det-" + Math.random().toString(36).slice(2, 7)); mkdirSync(d, { recursive: true }); for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c); return lib.detectTestCommand(d); };
A(det({ "Cargo.toml": "[package]" }).cmd === "cargo test --quiet", "caso8: Cargo.toml -> cargo test", JSON.stringify(det({ "Cargo.toml": "[package]" })));
A(det({ "pyproject.toml": "[project]" }).cmd === "uv run pytest -q", "caso8: pyproject -> uv run pytest (norma UV)", "");
A(det({ "go.mod": "module x" }).cmd === "go test ./...", "caso8: go.mod -> go test", "");
A(det({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }), "pnpm-lock.yaml": "" }).cmd === "pnpm test", "caso8: pnpm-lock -> pnpm test", "");
A(det({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }) === null, "caso8 (NEGATIVO): placeholder npm -> null", "");
A(det({ "README.md": "nada" }) === null, "caso8 (NEGATIVO): sin manifiesto -> null", "");

// ---------------------------------------------------------------------------
// Espera a que no quede ningun runner con el lock antes de borrar el fixture
// (un comando en marcha mantiene el cwd abierto en Windows -> EPERM).
{
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && readState().running) spawnSync("node", ["-e", "setTimeout(()=>{},250)"]);
}
rmSync(FIXTURE, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
console.log(fail === 0 ? "\nSELFTEST run-project-tests: VERDE" : `\nSELFTEST run-project-tests: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
