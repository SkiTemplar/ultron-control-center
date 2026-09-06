/**
 * response-meter.selftest.mjs — check del medidor de concision (F4.2/7.3):
 * lib/response-meter.js (measure, stats, linea del resume) y el Stop hook
 * response-meter.js sobre un transcript de fixture.
 *
 * Hermetico: RESPONSE_METER_LOG apunta a logs/_selftest-response-meter/.
 *
 * Uso: node hooks/scripts/response-meter.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..", "..");
const HOOK = join(__dirname, "response-meter.js");
const FIXTURE = join(ULTRON, "logs", "_selftest-response-meter");
const LOG = join(FIXTURE, "response-meter.jsonl");

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

if (existsSync(FIXTURE)) rmSync(FIXTURE, { recursive: true, force: true });
mkdirSync(FIXTURE, { recursive: true });
process.env.RESPONSE_METER_LOG = LOG;
const require = createRequire(import.meta.url);
const lib = require("./lib/response-meter.js");

// --- measure ----------------------------------------------------------------
const corta = lib.measure("Build — Verde. Tests — 57/57.");
A(corta.lines === 1 && corta.words === 6 && !corta.over_limit && corta.apologies === 0 && corta.preambles === 0,
  "measure: respuesta de una linea, sin senales", JSON.stringify(corta));

const larga = lib.measure(["## Resumen", "Buena pregunta. Tienes razón, mi error.", "- uno", "- dos", "| a | b |", "```", "x", "```", ...Array.from({ length: 12 }, (_, i) => `linea ${i}`)].join("\n"));
A(larga.headers === 1 && larga.bullets === 2 && larga.tables === 1 && larga.fences === 2, "measure: cabeceras, listas, tablas y fences", JSON.stringify(larga));
A(larga.apologies === 2 && larga.preambles === 1, "measure: 'tienes razón' + 'mi error' = 2 disculpas; 'buena pregunta' = 1 preambulo", JSON.stringify(larga));
A(larga.over_limit === true && larga.lines > lib.MAX_LINES, "measure: mas de MAX_LINES lineas -> sobre el limite", JSON.stringify(larga));

const neg = lib.measure("La razón técnica: el lock. Sin errores. Claro está que el build es verde.");
A(neg.apologies === 0, "measure (NEGATIVO): 'razón técnica' y 'sin errores' no son disculpas", JSON.stringify(neg));
A(neg.preambles === 0, "measure (NEGATIVO): 'claro está' a mitad de frase no es preambulo", JSON.stringify(neg));
const muchasPalabras = lib.measure(Array.from({ length: 230 }, () => "palabra").join(" "));
A(muchasPalabras.lines === 1 && muchasPalabras.over_limit === true, "measure: 230 palabras en una linea -> sobre el limite por palabras", JSON.stringify(muchasPalabras));

// --- hook sobre transcript --------------------------------------------------
function transcript(name, turns) {
  const p = join(FIXTURE, `${name}.jsonl`);
  const lines = [];
  for (const t of turns) {
    if (t.user !== undefined) lines.push(JSON.stringify({ type: "user", message: { role: "user", content: t.user } }));
    if (t.tool) {
      lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } }] } }));
      lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }));
    }
    if (t.assistant !== undefined) lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t.assistant }] } }));
  }
  writeFileSync(p, lines.join("\n"));
  return p;
}
function fire(transcriptPath, sessionId) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path: transcriptPath.replace(/\\/g, "/"), cwd: FIXTURE.replace(/\\/g, "/"), session_id: sessionId, hook_event_name: "Stop" }),
    encoding: "utf8", timeout: 15000, env: { ...process.env, RESPONSE_METER_LOG: LOG, RESPONSE_METER_PROJECT: "fixture" },
  });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: r.stderr || "" };
}
const readLog = () => (existsSync(LOG) ? readFileSync(LOG, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

const t1 = transcript("t1", [
  { user: "arregla el login", assistant: "Voy a mirar el login." },
  { user: "vale, hazlo", tool: true, assistant: "Perdón, me equivoqué antes.\nLogin — Reparado.\nTests — 12/12." },
]);
const r1 = fire(t1, "ses-A");
const l1 = readLog();
A(r1.status === 0 && r1.stdout === "", "hook: exit 0 y sin output (async, no habla al modelo)", `status=${r1.status} stdout=${r1.stdout} stderr=${r1.stderr}`);
A(l1.length === 1 && l1[0].session_id === "ses-A" && l1[0].lines === 3 && l1[0].apologies === 2 && l1[0].project === "fixture",
  "hook: mide solo el texto del asistente tras el ultimo mensaje humano (3 lineas, 2 disculpas)", JSON.stringify(l1));

const t2 = transcript("t2", [{ user: "sigue", tool: true }]);
const r2 = fire(t2, "ses-A");
A(r2.status === 0 && readLog().length === 1, "hook (NEGATIVO): turno sin texto del asistente -> no registra nada", JSON.stringify(readLog()));

// --- stats y linea del resume ----------------------------------------------
rmSync(LOG, { force: true });
A(lib.renderResumeLine() === "", "resume (NEGATIVO): sin datos -> linea vacia", lib.renderResumeLine());
const entry = (session, lines, over = false, apologies = 0) => lib.appendEntry({ ts: new Date().toISOString(), session_id: session, project: "fixture", lines, words: lines * 8, over_limit: over, apologies, preambles: 0 });
entry("s1", 20, true, 1); entry("s1", 10);
entry("s2", 8); entry("s2", 6);
entry("s3", 4); entry("s3", 2); entry("s3", 3);
entry("s4", 2); entry("s4", 2);
const stats = lib.statsBySession();
A(stats.length === 3 && stats[0].session_id === "s2" && stats[2].session_id === "s4" && stats[2].avg_lines === 2,
  "stats: ventana de las ultimas 3 sesiones en orden", JSON.stringify(stats));
const line = lib.renderResumeLine();
A(/response_meter \(ultimas 3 sesiones, 7 respuestas\)/.test(line) && /media 3,9 lineas/.test(line) && /0 % sobre el limite/.test(line) && /tendencia baja/.test(line),
  "resume: media, % sobre el limite y tendencia a la baja", line);
entry("s5", 30, true, 3);
A(/tendencia sube/.test(lib.renderResumeLine()) && /disculpas 3/.test(lib.renderResumeLine()), "resume: una sesion peor invierte la tendencia y suma disculpas", lib.renderResumeLine());

rmSync(FIXTURE, { recursive: true, force: true });
console.log(fail === 0 ? "\nSELFTEST response-meter: VERDE" : `\nSELFTEST response-meter: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
