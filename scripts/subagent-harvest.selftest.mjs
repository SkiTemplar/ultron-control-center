/**
 * subagent-harvest.selftest.mjs — checks conductuales del hook SubagentStop.
 *
 * Bloque A (casilla 0.3, 2026-08): atribucion del agente y de la tarea.
 * Bloque B (ULTRON 4 F1.1, Q1a, 2026-09-02): grifo del candidato agent_note:
 *   - wrappers genericos (general-purpose, workflow-subagent, unknown...) NUNCA
 *     proponen candidato aunque el resultado sea largo y titulable;
 *   - un especialista con < 400 caracteres tampoco;
 *   - un especialista con >= 400 caracteres pero sin titulo derivable tampoco;
 *   - un especialista con >= 400 caracteres y titulo derivable SI (titulo
 *     prefijado con [agente], content <= 2000, type agent_note);
 *   - si el payload no trae texto, se lee el ultimo `assistant` del transcript
 *     (`agent_transcript_path`) y cuenta igual.
 *
 * Hermetico: log redirigido (SUBAGENT_HARVEST_LOG) y candidatos a fichero
 * (SUBAGENT_HARVEST_CANDIDATE_OUT) en vez de al sidecar -> no toca el inbox.
 *
 * Uso: node scripts/subagent-harvest.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const HOOK = join(ULTRON, "hooks", "scripts", "subagent-harvest.js");
const TMPDIR = join(ULTRON, "logs", "_selftest-harvest");
const TMPLOG = join(TMPDIR, "harvest.jsonl");
const TMPCAND = join(TMPDIR, "candidates.jsonl");
const TMPTRANSCRIPT = join(TMPDIR, "agent-transcript.jsonl");

rmSync(TMPDIR, { recursive: true, force: true });
mkdirSync(TMPDIR, { recursive: true });

function fire(payload) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, SUBAGENT_HARVEST_LOG: TMPLOG, SUBAGENT_HARVEST_CANDIDATE_OUT: TMPCAND },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`hook exit ${r.status}: ${r.stderr}`);
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

// ---------- Bloque A: atribucion ----------
const SHORT = "x".repeat(50);
fire({ subagent_type: "rust-engineer", cwd: "C:/x/ultron", result: SHORT });
fire({ agentType: "workflow-subagent", description: "verify:memoria-gobernanza", result: SHORT });
fire({ foo: "bar", result: SHORT });
fire({ task: { subagent_type: "code-reviewer" }, result: SHORT });

let recs = readJsonl(TMPLOG);
console.log("Bloque A — atribucion");
A(recs.length === 4, "4 registros escritos", `got ${recs.length}`);
A(recs[0].agent === "rust-engineer", "subagent_type -> agent rust-engineer", JSON.stringify(recs[0]));
A(recs[1].agent === "workflow-subagent", "agentType (camel) -> agent workflow-subagent", JSON.stringify(recs[1]));
A(recs[1].label === "verify:memoria-gobernanza", "description -> label (desambigua wrapper generico)", JSON.stringify(recs[1]));
A(recs[2].agent === "unknown", "payload sin campo de agente -> unknown", JSON.stringify(recs[2]));
A(Array.isArray(recs[2]._keys) && recs[2]._keys.includes("foo"), "unknown -> _keys diagnostico", JSON.stringify(recs[2]));
A(recs[3].agent === "code-reviewer", "task.subagent_type anidado -> agent code-reviewer", JSON.stringify(recs[3]));
A(readJsonl(TMPCAND).length === 0, "resultados < 400 chars: 0 candidatos", `got ${readJsonl(TMPCAND).length}`);

// ---------- Bloque B: grifo Q1a ----------
rmSync(TMPLOG, { force: true });
rmSync(TMPCAND, { force: true });

// Texto con sustancia: primera linea titulable, > 400 chars.
const LESSON =
  "El test de integracion fallaba porque el daemon leia la variable de entorno al arrancar y no en cada peticion.\n" +
  "Causa: el cliente construye la configuracion una vez y la cachea en un OnceCell.\n" +
  "Regla: cualquier A/B por variable de entorno exige reiniciar el daemon o pasar la variable por la peticion.\n" +
  "Verificado en runtime: dos configuraciones opuestas daban cifras identicas hasta el reinicio; despues divergen.\n" +
  "Archivos: memory/src/daemon_client.rs, memory/src/serve.rs. Tests: 3 nuevos, todos verdes.";
if (LESSON.length < 400) throw new Error(`fixture LESSON demasiado corto: ${LESSON.length}`);

// Texto largo SIN linea titulable: solo fences y decoracion.
const JUNK = "```\n" + "x".repeat(450) + "\n```\n---\n";
if (JUNK.length < 400) throw new Error(`fixture JUNK demasiado corto: ${JUNK.length}`);

fire({ agent_type: "general-purpose", result: LESSON });                 // generico -> no
fire({ agent_type: "workflow-subagent", result: LESSON });               // generico -> no
fire({ agent_type: "Explore", result: LESSON });                         // generico (case) -> no
fire({ foo: "bar", result: LESSON });                                    // unknown -> no
fire({ agent_type: "rust-engineer", result: LESSON.slice(0, 200) });     // corto -> no
fire({ agent_type: "rust-engineer", result: JUNK });                     // sin titulo -> no
fire({ agent_type: "rust-engineer", result: LESSON, session_id: "s-1" }); // SI

let cands = readJsonl(TMPCAND);
recs = readJsonl(TMPLOG);
console.log("Bloque B — grifo Q1a");
A(recs.length === 7, "7 registros en el scratch log (Sink 1 nunca se cierra)", `got ${recs.length}`);
A(cands.length === 1, "solo 1 candidato de 7 disparos", `got ${cands.length}: ${JSON.stringify(cands.map((c) => c.candidate.title))}`);
const c0 = cands[0] && cands[0].candidate;
A(c0 && c0.type === "agent_note" && c0.source === "subagent-harvest", "candidato type agent_note / source subagent-harvest", JSON.stringify(c0));
A(c0 && c0.title.startsWith("[rust-engineer] El test de integracion fallaba"), "titulo derivado del contenido con prefijo [agente]", c0 && c0.title);
A(c0 && c0.content.length <= 2000 && c0.session_id === "s-1", "content <= 2000 y session_id de la sesion padre", JSON.stringify(c0 && { len: c0.content.length, sid: c0.session_id }));
A(recs.every((r) => r.from === "payload"), "from=payload cuando el texto viene en el payload", JSON.stringify(recs.map((r) => r.from)));

// ---------- Bloque C: fallback al transcript ----------
rmSync(TMPLOG, { force: true });
rmSync(TMPCAND, { force: true });

const transcript = [
  { type: "user", message: { role: "user", content: "haz X" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "..." }, { type: "text", text: LESSON }] } },
].map((e) => JSON.stringify(e)).join("\n") + "\n";
writeFileSync(TMPTRANSCRIPT, transcript, "utf8");

fire({ agent_type: "debugger", agent_transcript_path: TMPTRANSCRIPT });          // texto solo en transcript -> SI
fire({ agent_type: "general-purpose", agent_transcript_path: TMPTRANSCRIPT });   // generico -> no aunque haya texto
fire({ agent_type: "debugger", agent_transcript_path: join(TMPDIR, "no-existe.jsonl") }); // sin texto -> no

cands = readJsonl(TMPCAND);
recs = readJsonl(TMPLOG);
console.log("Bloque C — transcript");
A(recs[0].from === "transcript" && recs[0].chars === LESSON.length, "texto recuperado del ultimo assistant del transcript", JSON.stringify({ from: recs[0].from, chars: recs[0].chars }));
A(recs[2].from === "none" && recs[2].chars === 0, "transcript inexistente -> chars 0, sin lanzar", JSON.stringify(recs[2]));
A(cands.length === 1 && cands[0].candidate.title.startsWith("[debugger] "), "1 candidato (debugger), 0 del generico", JSON.stringify(cands.map((c) => c.candidate.title)));

rmSync(TMPDIR, { recursive: true, force: true });
console.log(fail === 0 ? "\nSELFTEST harvest: VERDE" : `\nSELFTEST harvest: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
