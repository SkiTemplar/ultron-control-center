/**
 * agent-usage.mjs — registro CONSULTABLE de invocaciones de subagentes (casilla 0.3).
 *
 * Lee el harvest del hook SubagentStop (.tmp/subagent-harvest.jsonl) y agrega
 * "agente X invocado N veces" + chars + ultima vez. Para los wrappers genericos
 * (workflow-subagent / general-purpose) desglosa por `label` (la identidad real de
 * la tarea). Para los 'unknown' muestra la firma de claves del payload (diagnostico
 * mand. 10: para fijar el campo de atribucion real con datos, no a ciegas).
 *
 * El dato YA se capturaba; esto lo HACE CONSUMIBLE (mand. 12). Lo consumira la
 * casilla 2.1 (panel) sin reinventar la agregacion.
 *
 * Uso: node scripts/agent-usage.mjs [--project ultron] [--json]
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const ARGS = process.argv.slice(2);
const FLAG_JSON = ARGS.includes("--json");
const pi = ARGS.indexOf("--project");
const projFilter = pi >= 0 ? ARGS[pi + 1] : null;

const LOG = process.env.SUBAGENT_HARVEST_LOG
  || join(homedir(), ".ultron", ".tmp", "subagent-harvest.jsonl");

function load() {
  if (!existsSync(LOG)) return [];
  return readFileSync(LOG, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

let rows = load();
if (projFilter) rows = rows.filter((r) => r.project === projFilter);

const byAgent = new Map();
for (const r of rows) {
  const k = r.agent || "unknown";
  const a = byAgent.get(k) || { agent: k, count: 0, chars: 0, last: "", labels: new Map() };
  a.count++;
  a.chars += r.chars || 0;
  if (!a.last || (r.ts || "") > a.last) a.last = r.ts || "";
  if (r.label) a.labels.set(r.label, (a.labels.get(r.label) || 0) + 1);
  byAgent.set(k, a);
}
const agents = [...byAgent.values()].sort((x, y) => y.count - x.count);

const unknownKeys = new Map();
for (const r of rows) {
  if ((r.agent || "unknown") === "unknown" && Array.isArray(r._keys)) {
    const sig = r._keys.slice().sort().join(",");
    unknownKeys.set(sig, (unknownKeys.get(sig) || 0) + 1);
  }
}

const topLabels = (m, n) => [...m.entries()].sort((p, q) => q[1] - p[1]).slice(0, n);

if (FLAG_JSON) {
  console.log(JSON.stringify({
    log: LOG,
    total: rows.length,
    project: projFilter || "(todos)",
    agents: agents.map((a) => ({
      agent: a.agent, count: a.count, chars: a.chars, last: a.last,
      top_labels: topLabels(a.labels, 5).map(([label, n]) => ({ label, n })),
    })),
    unknown_keys: [...unknownKeys.entries()].sort((p, q) => q[1] - p[1]).map(([keys, n]) => ({ keys, n })),
  }, null, 2));
} else {
  console.log(`\n=== Uso de subagentes (${rows.length} invocaciones · proyecto: ${projFilter || "todos"}) ===\n`);
  if (!rows.length) console.log("  (sin datos: no hay harvest todavia)");
  for (const a of agents) {
    const lastShort = a.last ? a.last.slice(0, 16).replace("T", " ") : "?";
    console.log(`  ${String(a.count).padStart(4)}x  ${a.agent.padEnd(22)}  ${String(a.chars).padStart(9)} chars  ultima ${lastShort}`);
    const top = topLabels(a.labels, 3);
    if (top.length) console.log(`         labels: ${top.map(([l, n]) => `${l}(${n})`).join(" · ")}`);
  }
  if (unknownKeys.size) {
    console.log(`\n  [diagnostico] payloads 'unknown' por firma de claves (para fijar el campo real):`);
    for (const [keys, n] of topLabels(unknownKeys, 8)) {
      console.log(`     ${String(n).padStart(4)}x  {${keys}}`);
    }
  }
  console.log("");
}
