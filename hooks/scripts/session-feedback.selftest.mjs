/**
 * session-feedback.selftest.mjs — check conductual de la metrica externa
 * (ULTRON 4, plan 12.1): hooks session-feedback-mark.js (SessionEnd) y
 * session-feedback-capture.js (UserPromptSubmit) + lib/session-feedback.js.
 *
 * Hermetico: SESSION_FEEDBACK_PROJECTS_DIR / SESSION_FEEDBACK_LOG /
 * SESSION_FEEDBACK_PROJECT apuntan a un fixture temporal bajo
 * logs/_selftest-session-feedback/; ULTRON_MEMORY_BIN apunta a un binario
 * ausente para que nunca se proponga un candidato real.
 *
 * Uso: node hooks/scripts/session-feedback.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..", "..");
const MARK = join(__dirname, "session-feedback-mark.js");
const CAPTURE = join(__dirname, "session-feedback-capture.js");

const FIXTURE = join(ULTRON, "logs", "_selftest-session-feedback");
const PROJECTS = join(FIXTURE, "projects");
const LOG = join(FIXTURE, "session-feedback.jsonl");
const PROJECT = "proyecto-selftest";
const PENDING = join(PROJECTS, PROJECT, "feedback-pending.json");

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const ENV = {
  ...process.env,
  SESSION_FEEDBACK_PROJECTS_DIR: PROJECTS,
  SESSION_FEEDBACK_LOG: LOG,
  ULTRON_MEMORY_BIN: join(FIXTURE, "no-existe", "ultron-memory.exe"),
};

function reset() {
  if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true, force: true });
  mkdirSync(join(PROJECTS, PROJECT), { recursive: true });
}

// Transcript con N turnos humanos repartidos en `minutes` minutos.
function makeTranscript(name, { humanTurns, minutes, start = Date.parse("2026-09-03T18:00:00.000Z") }) {
  const p = join(FIXTURE, `${name}.jsonl`);
  const lines = [];
  const step = humanTurns > 1 ? (minutes * 60000) / (humanTurns - 1) : 0;
  for (let i = 0; i < humanTurns; i++) {
    const ts = new Date(start + i * step).toISOString();
    lines.push(JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: `peticion humana ${i}` } }));
    lines.push(JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "x" } }] } }));
    lines.push(JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }));
    lines.push(JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: "<system-reminder>ruido</system-reminder>" } }));
  }
  writeFileSync(p, lines.join("\n"), "utf8");
  return p;
}

function fire(hook, payload, extraEnv = {}) {
  const r = spawnSync("node", [hook], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 15000,
    env: { ...ENV, SESSION_FEEDBACK_PROJECT: PROJECT, ...extraEnv },
  });
  return { stdout: (r.stdout || "").trim(), status: r.status, stderr: r.stderr || "" };
}

function readLog() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

function readPending() {
  return existsSync(PENDING) ? JSON.parse(readFileSync(PENDING, "utf8")) : null;
}

function gitRepoWithCommitAt(dir, isoDate) {
  mkdirSync(dir, { recursive: true });
  const git = (args, env = {}) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  git(["init", "-q"]);
  git(["config", "user.email", "selftest@ultron.local"]);
  git(["config", "user.name", "selftest"]);
  git(["commit", "--allow-empty", "-q", "-m", "feat: trabajo de la sesion"], { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate });
}

// ---------------------------------------------------------------------------
// Caso 1: mark escribe el pending con minutos, turnos y commits de la sesion.
reset();
const repo1 = join(FIXTURE, "repo1");
gitRepoWithCommitAt(repo1, "2026-09-03T18:05:00Z");
const t1 = makeTranscript("t1", { humanTurns: 4, minutes: 12 });
const r1 = fire(MARK, { cwd: repo1, session_id: "sesion-A", transcript_path: t1, reason: "prompt_input_exit" });
const p1 = readPending();
A(r1.status === 0, "caso1: mark exit 0", `status=${r1.status} stderr=${r1.stderr}`);
A(p1 && p1.session_id === "sesion-A", "caso1: pending escrito para la sesion", JSON.stringify(p1));
A(p1 && p1.human_turns === 4 && p1.minutes === 12 && p1.commits === 1,
  "caso1: pending trae 4 turnos humanos, 12 min y 1 commit (tool_results y system-reminders no cuentan)",
  JSON.stringify(p1));

// Caso 2 (NEGATIVO): proyecto ultron -> nunca se pregunta.
reset();
const t2 = makeTranscript("t2", { humanTurns: 6, minutes: 30 });
fire(MARK, { cwd: repo1, session_id: "sesion-U", transcript_path: t2 }, { SESSION_FEEDBACK_PROJECT: "ultron" });
A(!existsSync(join(PROJECTS, "ultron", "feedback-pending.json")) && !readPending(),
  "caso2: proyecto 'ultron' excluido -> sin pending", "pending encontrado");

// Caso 3 (NEGATIVO): sesion trivial (2 turnos) -> sin pending.
reset();
const t3 = makeTranscript("t3", { humanTurns: 2, minutes: 40 });
fire(MARK, { cwd: repo1, session_id: "sesion-corta", transcript_path: t3 });
A(!readPending(), "caso3: 2 turnos humanos -> sesion trivial, sin pending", JSON.stringify(readPending()));

// Caso 4 (NEGATIVO): proyecto sin carpeta en el cockpit -> sin pending.
reset();
const t4 = makeTranscript("t4", { humanTurns: 5, minutes: 10 });
fire(MARK, { cwd: repo1, session_id: "sesion-x", transcript_path: t4 }, { SESSION_FEEDBACK_PROJECT: "no-registrado" });
A(!existsSync(join(PROJECTS, "no-registrado")), "caso4: proyecto no registrado -> no se crea nada", "carpeta creada");

// Caso 5: sobreescribir un pending sin responder lo registra como sin_respuesta.
reset();
const t5a = makeTranscript("t5a", { humanTurns: 3, minutes: 5 });
fire(MARK, { cwd: repo1, session_id: "sesion-B", transcript_path: t5a });
const t5b = makeTranscript("t5b", { humanTurns: 3, minutes: 7, start: Date.parse("2026-09-04T09:00:00.000Z") });
fire(MARK, { cwd: repo1, session_id: "sesion-C", transcript_path: t5b });
const log5 = readLog();
A(readPending() && readPending().session_id === "sesion-C", "caso5: el pending pasa a la sesion nueva", JSON.stringify(readPending()));
A(log5.length === 1 && log5[0].answer === "sin_respuesta" && log5[0].rated_session_id === "sesion-B",
  "caso5: la sesion ignorada queda registrada como sin_respuesta", JSON.stringify(log5));

// Caso 6: capture registra 'fb: sí <nota>', retira el pending y contesta al modelo.
const r6 = fire(CAPTURE, { prompt: "fb: sí ha ido fino con los tests", cwd: repo1, session_id: "sesion-D" });
const log6 = readLog();
const last6 = log6[log6.length - 1];
A(r6.status === 0, "caso6: capture exit 0", `status=${r6.status} stderr=${r6.stderr}`);
A(last6 && last6.answer === "si" && last6.note === "ha ido fino con los tests" && last6.rated_session_id === "sesion-C" && last6.had_pending === true,
  "caso6: entrada si + nota + sesion valorada", JSON.stringify(last6));
A(!readPending(), "caso6: el pending se retira al responder", "pending sigue");
A(/session_feedback registrado: sí/.test(r6.stdout) && /UserPromptSubmit/.test(r6.stdout),
  "caso6: additionalContext confirma el registro", r6.stdout);

// Caso 7 (NEGATIVO): un prompt normal no toca nada ni emite nada.
const antes7 = readLog().length;
const r7 = fire(CAPTURE, { prompt: "arregla el login, que falla el sitemap", cwd: repo1, session_id: "sesion-D" });
A(r7.status === 0 && r7.stdout === "" && readLog().length === antes7,
  "caso7: prompt sin 'fb:' -> silencio y log intacto", `stdout="${r7.stdout}"`);

// Caso 8: 'fb: estorbó' sin pending se registra igualmente (had_pending=false).
const r8 = fire(CAPTURE, { prompt: "FB: estorbó", cwd: repo1, session_id: "sesion-E" });
const last8 = readLog().slice(-1)[0];
A(last8 && last8.answer === "estorbo" && last8.had_pending === false && last8.note === "",
  "caso8: feedback espontaneo sin pending -> registrado con had_pending=false", JSON.stringify(last8));
A(/sin sesion pendiente/.test(r8.stdout), "caso8: el contexto avisa de que no habia sesion pendiente", r8.stdout);

// Caso 9: lib — parseAnswer, stats y renderResumeLines.
const require = createRequire(import.meta.url);
process.env.SESSION_FEEDBACK_PROJECTS_DIR = PROJECTS;
process.env.SESSION_FEEDBACK_LOG = LOG;
const lib = require("./lib/session-feedback.js");
const pa = lib.parseAnswer;
A(pa("fb: Si").answer === "si" && pa("fb:no").answer === "no" && pa("fb: estorbo porque repite").answer === "estorbo" && pa("fb: estorbo porque repite").note === "porque repite",
  "caso9: parseAnswer acepta variantes (mayusculas, sin espacio, con nota)", JSON.stringify([pa("fb: Si"), pa("fb:no")]));
A(pa("fabuloso, sigue") === null && pa("el fb: si de ayer") === null && pa("") === null,
  "caso9 (NEGATIVO): parseAnswer rechaza texto sin prefijo al inicio", "acepto algo indebido");
const s9 = lib.stats();
A(s9.n === 3 && s9.si === 1 && s9.estorbo === 1 && s9.sin_respuesta === 1 && s9.pct_si === 33,
  "caso9: stats sobre el jsonl (1 si, 1 estorbo, 1 sin respuesta -> 33 %)", JSON.stringify(s9));
const lines9 = lib.renderResumeLines(PROJECT);
A(lines9.length === 1 && /session_feedback \(ultimas 3/.test(lines9[0]) && /si 33 %/.test(lines9[0]),
  "caso9: sin pending el resume solo lleva la cifra", JSON.stringify(lines9));
lib.writePending(PROJECT, { session_id: "sesion-F", ended_at: "2026-09-04T10:00:00.000Z", minutes: 25, human_turns: 7, commits: 2 });
const lines9b = lib.renderResumeLines(PROJECT);
A(lines9b.length === 2 && /feedback_pendiente/.test(lines9b[0]) && /2026-09-04/.test(lines9b[0]) && /PREGUNTA/.test(lines9b[0]) && /25 min, 7 turnos, 2 commits/.test(lines9b[0]),
  "caso9: con pending el resume ordena preguntar con fecha, minutos, turnos y commits", JSON.stringify(lines9b));
A(lib.renderResumeLines("ultron").length === 1, "caso9 (NEGATIVO): para 'ultron' nunca hay pregunta, solo la cifra", JSON.stringify(lib.renderResumeLines("ultron")));

// ---------------------------------------------------------------------------
rmSync(FIXTURE, { recursive: true, force: true });
console.log(fail === 0 ? "\nSELFTEST session-feedback: VERDE" : `\nSELFTEST session-feedback: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
