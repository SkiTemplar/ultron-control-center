/**
 * lesson-distill.selftest.mjs — check conductual del hook SessionEnd
 * `lesson-distill` (ULTRON 4 F1.2, Q2b).
 *
 * Hermetico: transcript sintetico, daemon simulado por fichero
 * (LESSON_DISTILL_FAKE_RESPONSE), peticion capturada (LESSON_DISTILL_REQUEST_OUT)
 * y candidatos a fichero (LESSON_DISTILL_CANDIDATE_OUT). No toca ni daemon ni
 * inbox.
 *
 * Casos:
 *   A) transcript corto -> 'digest sin cuerpo', 0 peticiones, 0 candidatos.
 *   B) transcript con cuerpo + 2 lecciones del daemon -> 2 candidatos `lesson`
 *      con titulo/summary/content/session_id/project; el digest lleva el
 *      tool_error y NO lleva el secreto (redaccion antes de salir).
 *   C) respuesta del daemon invalida (lecciones incompletas, basura, error)
 *      -> 0 candidatos, sin lanzar.
 *   D) daemon caido (respuesta null) -> 'daemon no responde', 0 candidatos.
 *   E) opt-out LESSON_DISTILL_DISABLED=1 -> ni log.
 *
 * Uso: node scripts/lesson-distill.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const HOOK = join(ULTRON, "hooks", "scripts", "lesson-distill.js");
const TMPDIR = join(ULTRON, "logs", "_selftest-lesson-distill");
const LOG = join(TMPDIR, "log.jsonl");
const REQ = join(TMPDIR, "request.jsonl");
const CAND = join(TMPDIR, "candidates.jsonl");
const FAKE = join(TMPDIR, "fake-response.json");
const TRANSCRIPT = join(TMPDIR, "transcript.jsonl");

rmSync(TMPDIR, { recursive: true, force: true });
mkdirSync(TMPDIR, { recursive: true });

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

function reset() {
  for (const f of [LOG, REQ, CAND]) rmSync(f, { force: true });
}
function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function fire(payload, extraEnv = {}) {
  const env = {
    ...process.env,
    LESSON_DISTILL_LOG: LOG,
    LESSON_DISTILL_REQUEST_OUT: REQ,
    LESSON_DISTILL_FAKE_RESPONSE: FAKE,
    LESSON_DISTILL_CANDIDATE_OUT: CAND,
    ...extraEnv,
  };
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(payload), env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`hook exit ${r.status}: ${r.stderr}`);
}
function writeTranscript(entries) {
  writeFileSync(TRANSCRIPT, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}
const user = (text) => ({ type: "user", message: { role: "user", content: text } });
const assistant = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const toolError = (text) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: text }] },
});

const SECRET = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const BASE = { transcript_path: TRANSCRIPT, cwd: "C:/x/ultron", session_id: "sess-1" };

// ---------- A: transcript corto ----------
console.log("A — transcript corto");
reset();
writeTranscript([user("hola"), assistant("hola, dime")]);
writeFileSync(FAKE, JSON.stringify({ lessons: [{ symptom: "s", cause: "c", rule: "r" }] }));
fire(BASE);
let log = readJsonl(LOG);
A(log.length === 1 && log[0].skipped === "digest sin cuerpo", "digest corto -> skipped 'digest sin cuerpo'", JSON.stringify(log));
A(readJsonl(REQ).length === 0, "sin peticion al daemon", `${readJsonl(REQ).length} peticiones`);
A(readJsonl(CAND).length === 0, "0 candidatos", `${readJsonl(CAND).length}`);

// ---------- B: sesion con cuerpo + 2 lecciones ----------
console.log("B — dos lecciones");
reset();
const relleno = "El test de integracion del daemon fallaba de forma intermitente al arrancar en frio. ".repeat(6);
writeTranscript([
  user("arregla el test de integracion del daemon, falla al arrancar en frio"),
  toolError(`Error: ECONNREFUSED 127.0.0.1:7788 token ${SECRET}`),
  assistant(relleno),
  user("vale, y por que pasaba"),
  assistant("Porque el cliente leia la variable de entorno al construirse y la cacheaba. " + relleno),
]);
writeFileSync(
  FAKE,
  JSON.stringify({
    lessons: [
      { symptom: "ECONNREFUSED al arrancar en frio", cause: "el cliente cachea la config al construirse", rule: "Reinicia el daemon tras cambiar el entorno" },
      { symptom: "dos configuraciones dan cifras identicas", cause: "la variable no llega al proceso vivo", rule: "Pasa la variable por la peticion" },
    ],
    digest_chars: 999,
  })
);
fire(BASE);
log = readJsonl(LOG);
const reqs = readJsonl(REQ);
const cands = readJsonl(CAND);
A(reqs.length === 1 && reqs[0].cmd === "lesson_distill" && reqs[0].project === "ultron", "1 peticion lesson_distill con project", JSON.stringify(reqs.map((r) => [r.cmd, r.project])));
A(reqs.length === 1 && reqs[0].prompt.includes("[tool_error]: Error: ECONNREFUSED"), "el digest lleva el tool_error como sintoma", reqs[0] && reqs[0].prompt.slice(0, 200));
A(reqs.length === 1 && !reqs[0].prompt.includes(SECRET), "el secreto NO sale en el digest (redaccion)", reqs[0] && reqs[0].prompt.slice(0, 300));
A(cands.length === 2, "2 candidatos propuestos", `${cands.length}`);
const c0 = cands[0] && cands[0].candidate;
A(c0 && c0.type === "lesson" && c0.scope === "project" && c0.source === "lesson-distill", "candidato type=lesson scope=project source=lesson-distill", JSON.stringify(c0));
A(c0 && c0.title === "[lesson] Reinicia el daemon tras cambiar el entorno", "titulo = [lesson] + regla", c0 && c0.title);
A(c0 && c0.summary.startsWith("ECONNREFUSED al arrancar en frio → el cliente"), "summary = sintoma → causa", c0 && c0.summary);
A(c0 && c0.content.includes("Regla: Reinicia") && c0.content.includes("Proyecto origen: ultron"), "content con los 3 campos y proyecto origen", c0 && c0.content);
A(c0 && c0.session_id === "sess-1" && c0.project === "ultron", "session_id y project de la sesion", JSON.stringify(c0 && { s: c0.session_id, p: c0.project }));
A(log.length === 1 && log[0].lessons === 2 && log[0].proposed === 2 && log[0].tool_errors === 1, "log: lessons=2 proposed=2 tool_errors=1", JSON.stringify(log[0]));

// ---------- C: respuesta invalida ----------
console.log("C — respuesta del daemon invalida");
reset();
writeFileSync(FAKE, JSON.stringify({ lessons: [{ symptom: "solo sintoma" }, { cause: "x", rule: "" }, "basura", null] }));
fire(BASE);
A(readJsonl(CAND).length === 0, "lecciones incompletas -> 0 candidatos", `${readJsonl(CAND).length}`);
A(readJsonl(LOG)[0].lessons === 0, "log lessons=0", JSON.stringify(readJsonl(LOG)[0]));
reset();
writeFileSync(FAKE, JSON.stringify({ error: "all providers failed" }));
fire(BASE);
A(readJsonl(LOG)[0].skipped && readJsonl(LOG)[0].skipped.startsWith("daemon: all providers"), "error del daemon -> skipped con motivo", JSON.stringify(readJsonl(LOG)[0]));
A(readJsonl(CAND).length === 0, "error del daemon -> 0 candidatos", `${readJsonl(CAND).length}`);

// ---------- D: daemon caido ----------
console.log("D — daemon caido");
reset();
writeFileSync(FAKE, "no soy json");
fire(BASE);
A(readJsonl(LOG)[0].skipped === "daemon no responde", "respuesta nula -> 'daemon no responde'", JSON.stringify(readJsonl(LOG)[0]));
A(readJsonl(CAND).length === 0, "0 candidatos", `${readJsonl(CAND).length}`);

// ---------- E: opt-out ----------
console.log("E — opt-out");
reset();
writeFileSync(FAKE, JSON.stringify({ lessons: [{ symptom: "s", cause: "c", rule: "r" }] }));
fire(BASE, { LESSON_DISTILL_DISABLED: "1" });
A(readJsonl(LOG).length === 0 && readJsonl(CAND).length === 0, "LESSON_DISTILL_DISABLED=1 -> ni log ni candidatos", `${readJsonl(LOG).length}/${readJsonl(CAND).length}`);

rmSync(TMPDIR, { recursive: true, force: true });
console.log(fail === 0 ? "\nSELFTEST lesson-distill: VERDE" : `\nSELFTEST lesson-distill: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
