/**
 * subagent-harvest.selftest.mjs — check conductual de la atribucion (casilla 0.3).
 *
 * Dispara el hook real con payloads SubagentStop sinteticos (log redirigido via
 * SUBAGENT_HARVEST_LOG) y verifica que la atribucion mejorada captura el agente y
 * la identidad de tarea. Falla SIN el fix:
 *   - el hook viejo solo leia agent_type/subagent_type/agent -> 'agentType' (camel)
 *     y 'task.subagent_type' caian a 'unknown';
 *   - no capturaba 'label' (los wrappers genericos perdian el especialista);
 *   - no dejaba '_keys' de diagnostico en los 'unknown'.
 *
 * result < 80 chars a proposito: salta el sink2 (candidate) -> NO ensucia el inbox.
 *
 * Uso: node scripts/subagent-harvest.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const HOOK = join(ULTRON, "hooks", "scripts", "subagent-harvest.js");
const TMPLOG = join(ULTRON, "logs", "_selftest-harvest.jsonl");

if (existsSync(TMPLOG)) rmSync(TMPLOG);

function fire(payload) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, SUBAGENT_HARVEST_LOG: TMPLOG },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`hook exit ${r.status}: ${r.stderr}`);
}

const R = "x".repeat(50); // <80 => sink2 (candidate) se salta => no toca el inbox
fire({ subagent_type: "rust-engineer", cwd: "C:/x/ultron", result: R });
fire({ agentType: "workflow-subagent", description: "verify:memoria-gobernanza", result: R });
fire({ foo: "bar", result: R });
fire({ task: { subagent_type: "code-reviewer" }, result: R });

const recs = readFileSync(TMPLOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

A(recs.length === 4, "4 registros escritos", `got ${recs.length}`);
A(recs[0].agent === "rust-engineer", "subagent_type -> agent rust-engineer", JSON.stringify(recs[0]));
A(recs[1].agent === "workflow-subagent", "agentType (camel) -> agent workflow-subagent", JSON.stringify(recs[1]));
A(recs[1].label === "verify:memoria-gobernanza", "description -> label (desambigua wrapper generico)", JSON.stringify(recs[1]));
A(recs[2].agent === "unknown", "payload sin campo de agente -> unknown", JSON.stringify(recs[2]));
A(Array.isArray(recs[2]._keys) && recs[2]._keys.includes("foo"), "unknown -> _keys diagnostico", JSON.stringify(recs[2]));
A(recs[3].agent === "code-reviewer", "task.subagent_type anidado -> agent code-reviewer", JSON.stringify(recs[3]));

rmSync(TMPLOG, { force: true });
console.log(fail === 0 ? "\nSELFTEST 0.3: VERDE" : `\nSELFTEST 0.3: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
