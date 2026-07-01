/**
 * subagent-lifecycle.selftest.mjs — check conductual del hook de ciclo de vida (casilla 3.9).
 *
 * Dispara el hook real (log redirigido via SUBAGENT_LIFECYCLE_LOG) con payloads
 * SubagentStart / SubagentStop sinteticos y verifica:
 *   - hook_event_name manda: SubagentStart -> "start", SubagentStop -> "stop";
 *   - fallback por shape: sin hook_event_name, un payload con resultado -> "stop";
 *   - se capturan agent_id / agent / label (tolerante a snake/camel/anidado).
 *
 * Uso: node scripts/subagent-lifecycle.selftest.mjs   (exit 0 = verde)
 */
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, "..");
const HOOK = join(ULTRON, "hooks", "scripts", "subagent-lifecycle.js");
const TMPLOG = join(ULTRON, "logs", "_selftest-lifecycle.jsonl");

if (existsSync(TMPLOG)) rmSync(TMPLOG);

function fire(payload) {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, SUBAGENT_LIFECYCLE_LOG: TMPLOG },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`hook exit ${r.status}: ${r.stderr}`);
}

// start explicito
fire({ hook_event_name: "SubagentStart", agent_id: "sa-1", subagent_type: "rust-engineer", description: "impl feed" });
// stop explicito del mismo agente
fire({ hook_event_name: "SubagentStop", agent_id: "sa-1", agent_type: "rust-engineer" });
// start sin hook_event_name pero con shape de arranque (sin resultado) -> "start"
fire({ agentId: "sa-2", task: { subagent_type: "code-reviewer" } });
// stop inferido por shape (trae last_assistant_message) sin hook_event_name -> "stop"
fire({ agent_id: "sa-2", agent: "code-reviewer", last_assistant_message: { content: "done" } });

const recs = readFileSync(TMPLOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

A(recs.length === 4, "4 registros escritos", `got ${recs.length}`);
A(recs[0].event === "start" && recs[0].agent === "rust-engineer" && recs[0].agent_id === "sa-1",
  "SubagentStart -> start + agent + agent_id", JSON.stringify(recs[0]));
A(recs[0].label === "impl feed", "description -> label", JSON.stringify(recs[0]));
A(recs[1].event === "stop" && recs[1].agent_id === "sa-1",
  "SubagentStop -> stop (mismo agent_id)", JSON.stringify(recs[1]));
A(recs[2].event === "start" && recs[2].agent === "code-reviewer" && recs[2].agent_id === "sa-2",
  "sin hook_event_name + shape arranque (anidado, camel agentId) -> start", JSON.stringify(recs[2]));
A(recs[3].event === "stop" && recs[3].agent_id === "sa-2",
  "sin hook_event_name + last_assistant_message -> stop (fallback por shape)", JSON.stringify(recs[3]));

rmSync(TMPLOG, { force: true });
console.log(fail === 0 ? "\nSELFTEST 3.9 (lifecycle): VERDE" : `\nSELFTEST 3.9 (lifecycle): ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
