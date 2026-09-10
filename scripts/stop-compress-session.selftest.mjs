/**
 * stop-compress-session.selftest.mjs — check conductual del hook Stop
 * `stop-compress-session` tras retirar la extraccion LLM duplicada (2026-09-10:
 * un solo camino de captura, el del sidecar `ultron-memory capture`).
 *
 * Hermetico: HOME/USERPROFILE redirigidos a un temp dir (logs, throttle y
 * cockpit propios — nunca toca el ~/.ultron real), cockpit temporal con
 * projects.json registrando un proyecto de mentira, y el sidecar sustituido
 * por ULTRON_MEMORY_BIN=<node.exe real> apuntando a dos scripts sin extension
 * ("capture" / "inbox") en el cwd del hook: Node ejecuta un fichero dado como
 * argv[1] sea cual sea su extension, asi que sirven de stub cross-platform sin
 * pasar por shell (spawnSync/spawn de la produccion NO usan shell:true, y en
 * Node 24 un .cmd/.bat directo sin shell:true falla con EINVAL en Windows —
 * verificado en este mismo entorno — asi que un stub .cmd/.bat no es viable).
 * El stub "capture" registra la peticion recibida (args + stdin) y devuelve
 * el CaptureReport que cada caso deja en FAKE.
 *
 * Casos:
 *   A) captura normal -> compact.json con decisions/next/bugs mapeados desde
 *      facts (kind decision/task/lesson), machine.facts_extracted/ai_used, y
 *      el transcript que le llega al sidecar sin el secreto en claro
 *      (redactSecrets turno a turno antes de construir transcriptText).
 *   B) throttle GLOBAL activo (deja el .tmp/stop-compress-global.json de A
 *      reciente) -> la primera pasada de una sesion NUEVA respeta el global:
 *      no se llama al sidecar (0 peticiones nuevas), pero compact.json se
 *      sigue escribiendo con arrays vacios.
 *   C) transcript sin turnos -> no_turns_skip, sin compact.json.
 *   D) opt-out STOP_COMPRESS_DISABLED=1 -> nada de nada.
 *
 * Uso: node scripts/stop-compress-session.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const HOOK = join(ULTRON, "hooks", "scripts", "stop-compress-session.js");

const TMPDIR = join(ULTRON, "logs", "_selftest-stop-compress-session");
const HOME = join(TMPDIR, "home");
const STUBDIR = join(TMPDIR, "stubbin");
const PROJECT_CWD = join(TMPDIR, "project-cwd");
const TRANSCRIPTS = join(TMPDIR, "transcripts");
const LOG = join(HOME, ".claude", "logs", "stop-compress-session.jsonl");
const COCKPIT = join(HOME, ".ultron", "cockpit");
const REGISTRY = join(COCKPIT, "projects.json");
const PROJECT = "demo";
const SESSIONS_DIR = join(COCKPIT, "projects", PROJECT, "sessions");
const GLOBAL_THROTTLE = join(HOME, ".ultron", ".tmp", "stop-compress-global.json");
const REQ = join(TMPDIR, "capture-request.jsonl");
const FAKE = join(TMPDIR, "fake-capture-response.json");
const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

rmSync(TMPDIR, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });
mkdirSync(STUBDIR, { recursive: true });
mkdirSync(PROJECT_CWD, { recursive: true });
mkdirSync(TRANSCRIPTS, { recursive: true });
mkdirSync(COCKPIT, { recursive: true });

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function readCompact(sessionId) {
  const p = join(SESSIONS_DIR, sessionId, "compact.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function writeTranscript(sessionId, turns) {
  const p = join(TRANSCRIPTS, `${sessionId}.jsonl`);
  const lines = turns.map((t) => JSON.stringify({ type: t.role, message: { content: t.text } }));
  writeFileSync(p, lines.join("\n") + "\n", "utf8");
  return p;
}
function fire(sessionId, transcriptPath, extraEnv = {}) {
  const env = {
    ...process.env,
    HOME,
    USERPROFILE: HOME,
    ULTRON_MEMORY_BIN: process.execPath,
    STOP_COMPRESS_TEST_REQUEST_OUT: REQ,
    STOP_COMPRESS_TEST_FAKE_RESPONSE: FAKE,
    ...extraEnv,
  };
  const payload = { transcript_path: transcriptPath, session_id: sessionId, cwd: PROJECT_CWD };
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env,
    cwd: STUBDIR, // el sidecar-stub (findBinary -> node.exe) hereda este cwd sin overrides
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`hook exit ${r.status}: ${r.stderr}`);
}

// ---------- fixtures: cockpit + stubs del sidecar ----------
writeFileSync(
  REGISTRY,
  JSON.stringify({ projects: [{ id: PROJECT, name: "Demo", path: PROJECT_CWD, tags: [] }] }),
  "utf8",
);

// Stub "capture": Node ejecuta este fichero (sin extension) como su script
// principal cuando se le invoca `node capture ...` con cwd=STUBDIR — asi el
// binario de la produccion (spawnSync/spawn SIN shell:true) puede "encontrar"
// y correr el stub igual en Windows y Linux sin necesitar un .exe real.
writeFileSync(
  join(STUBDIR, "capture"),
  `
const fs = require('fs');
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch (_) {}
const args = process.argv.slice(2);
const out = process.env.STOP_COMPRESS_TEST_REQUEST_OUT;
if (out) {
  try { fs.appendFileSync(out, JSON.stringify({ args, stdin }) + '\\n'); } catch (_) {}
}
const fake = process.env.STOP_COMPRESS_TEST_FAKE_RESPONSE;
if (fake && fs.existsSync(fake)) {
  process.stdout.write(fs.readFileSync(fake, 'utf8'));
}
`,
  "utf8",
);
// Stub "inbox" (subcomando 'inbox drain --auto', detached/fire-and-forget):
// no hace falta que haga nada observable, solo que exista y salga limpio.
writeFileSync(join(STUBDIR, "inbox"), `process.exit(0);\n`, "utf8");

// ---------- A: captura normal ----------
console.log("A - captura normal: decisions/next/bugs desde facts, sin fuga del secreto");
{
  const fakeReport = {
    created: ["c1", "c2", "c3"],
    facts: [
      { kind: "decision", title: "Un solo camino de captura: el sidecar", origin: "origin:user" },
      { kind: "task", title: "Escribir el selftest hermetico", origin: "origin:user" },
      { kind: "lesson", title: "El throttle global evita el 429 en paralelo", origin: "origin:assistant" },
      { kind: "fact", title: "No deberia aparecer en ninguna lista", origin: "origin:unknown" },
    ],
    router_used: true,
    strategy: "router",
    note: "3 candidate(s) proposed",
  };
  writeFileSync(FAKE, JSON.stringify(fakeReport), "utf8");
  const sessionId = "sess-a";
  const tp = writeTranscript(sessionId, [
    { role: "user", text: `arranca la sesion, la clave es ${SECRET} no deberia salir` },
    { role: "assistant", text: "entendido, no la repito" },
    { role: "user", text: "vale, seguimos" },
  ]);
  fire(sessionId, tp);

  const reqs = readJsonl(REQ);
  A(reqs.length === 1, "una peticion al sidecar (capture)", JSON.stringify(reqs).slice(0, 200));
  const req = reqs[0] || { args: [], stdin: "" };
  A(req.args.includes("--project") && req.args.includes(PROJECT), "la peticion lleva --project", JSON.stringify(req.args));
  A(req.args.includes("--session") && req.args.includes(sessionId), "la peticion lleva --session", JSON.stringify(req.args));
  A(!req.stdin.includes(SECRET), "el secreto NO sale de la maquina (redactado antes del sidecar)", req.stdin);
  A(req.stdin.includes("[REDACTED"), "el hueco del secreto lleva un placeholder de redaccion", req.stdin.slice(0, 200));

  const c = readCompact(sessionId);
  A(!!c, "compact.json escrito", "no existe");
  A(c && c.decisions.length === 1 && c.decisions[0].text === "Un solo camino de captura: el sidecar", "decisions <- kind decision", JSON.stringify(c && c.decisions));
  A(c && c.decisions[0].origin === "origin:user", "decisions conserva el origin", JSON.stringify(c && c.decisions));
  A(c && c.next.length === 1 && c.next[0] === "Escribir el selftest hermetico", "next <- kind task", JSON.stringify(c && c.next));
  A(c && c.bugs.length === 1 && c.bugs[0].text === "El throttle global evita el 429 en paralelo", "bugs <- kind lesson", JSON.stringify(c && c.bugs));
  A(c && c.machine.facts_extracted === 4, "machine.facts_extracted = facts.length del informe", JSON.stringify(c && c.machine));
  A(c && c.machine.ai_used === true, "machine.ai_used = report.router_used", JSON.stringify(c && c.machine));

  const log = readJsonl(LOG);
  A(log.some((l) => l.msg === "memory_capture" && l.sessionId === sessionId && l.code === 0), "log: memory_capture code=0", JSON.stringify(log.filter((l) => l.sessionId === sessionId)));
  A(!log.some((l) => l.msg === "throttled_global" && l.sessionId === sessionId), "log: sin throttled_global en la primera pasada global", JSON.stringify(log));
  A(existsSync(GLOBAL_THROTTLE), "throttle global escrito tras la captura", "no existe .tmp/stop-compress-global.json");
}

// ---------- B: throttle GLOBAL ----------
console.log("B - throttle global activo: sesion NUEVA respeta el global, compact.json vacio pero presente");
{
  const reqBefore = readJsonl(REQ).length;
  const sessionId = "sess-b";
  const tp = writeTranscript(sessionId, [{ role: "user", text: "sesion nueva, sin relacion con la anterior" }]);
  fire(sessionId, tp);

  const reqAfter = readJsonl(REQ).length;
  A(reqAfter === reqBefore, "0 peticiones nuevas al sidecar (globalmente throttled)", `antes=${reqBefore} despues=${reqAfter}`);

  const log = readJsonl(LOG).filter((l) => l.sessionId === sessionId);
  A(log.some((l) => l.msg === "throttled_global"), "log: throttled_global para la sesion nueva", JSON.stringify(log));

  const c = readCompact(sessionId);
  A(!!c, "compact.json igualmente escrito (local, sin egress)", "no existe");
  A(c && c.decisions.length === 0 && c.next.length === 0 && c.bugs.length === 0, "arrays vacios (no hubo captura esta pasada)", JSON.stringify(c));
  A(c && c.machine.facts_extracted === 0 && c.machine.ai_used === false, "machine refleja 0 hechos / sin AI", JSON.stringify(c && c.machine));
}

// ---------- C: transcript sin turnos ----------
console.log("C - transcript sin turnos: no_turns_skip, sin compact.json");
{
  const reqBefore = readJsonl(REQ).length;
  const sessionId = "sess-c";
  const tp = join(TRANSCRIPTS, `${sessionId}.jsonl`);
  writeFileSync(tp, `${JSON.stringify({ type: "system", message: { content: "ping" } })}\n`, "utf8");
  fire(sessionId, tp);

  const log = readJsonl(LOG).filter((l) => l.sessionId === sessionId);
  A(log.some((l) => l.msg === "no_turns_skip"), "log: no_turns_skip", JSON.stringify(log));
  A(!readCompact(sessionId), "sin compact.json", "compact.json existe y no deberia");
  A(readJsonl(REQ).length === reqBefore, "0 peticiones nuevas al sidecar", "hubo peticion");
}

// ---------- D: opt-out por env ----------
console.log("D - opt-out STOP_COMPRESS_DISABLED=1: nada de nada");
{
  const logBefore = readJsonl(LOG).length;
  const reqBefore = readJsonl(REQ).length;
  const sessionId = "sess-d";
  const tp = writeTranscript(sessionId, [{ role: "user", text: "esto no deberia procesarse" }]);
  fire(sessionId, tp, { STOP_COMPRESS_DISABLED: "1" });

  const logAfter = readJsonl(LOG);
  A(logAfter.length === logBefore + 1 && logAfter[logAfter.length - 1].msg === "opt_out_via_env", "log: una linea opt_out_via_env y nada mas", JSON.stringify(logAfter.slice(logBefore)));
  A(!readCompact(sessionId), "sin compact.json", "compact.json existe y no deberia");
  A(readJsonl(REQ).length === reqBefore, "0 peticiones nuevas al sidecar", "hubo peticion");
}

rmSync(TMPDIR, { recursive: true, force: true });
console.log(fail === 0 ? "\nstop-compress-session selftest: VERDE" : `\nstop-compress-session selftest: ${fail} FALLO(S)`);
process.exit(fail === 0 ? 0 : 1);
