// mcp-memory-server.selftest.mjs — check conductual del MCP de memoria.
// Habla el protocolo real por stdio (initialize -> tools/list -> tools/call)
// contra el server vivo y verifica respuestas + caso negativo (tool inexistente).
// Uso: node scripts/mcp-memory-server.selftest.mjs   (exit 0 = verde)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "mcp-memory-server.mjs");

const msgs = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "selftest", version: "0" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_stats", arguments: {} } },
  { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "tool_inexistente", arguments: {} } },
];

const child = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "inherit"] });
const byId = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id !== undefined) byId.set(m.id, m); } catch {}
  }
});
for (const m of msgs) child.stdin.write(JSON.stringify(m) + "\n");
child.stdin.end();

const deadline = Date.now() + 90_000;
while (byId.size < 4 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200));
}
child.kill();

let fail = 0;
const A = (c, n, d) => { if (c) console.log(`  [PASS] ${n}`); else { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); } };

A(byId.get(1)?.result?.serverInfo?.name === "ultron-memory", "initialize -> serverInfo", JSON.stringify(byId.get(1)));
const tools = byId.get(2)?.result?.tools ?? [];
// memory_recall se retiro el 2026-10-03: con solo FTS5 daba recall@8 0,131 e inyectaba ruido.
A(tools.length === 3 && !tools.some((t) => t.name === "memory_recall") && tools.some((t) => t.name === "curso_status"), "tools/list = 3 tools, sin memory_recall y con curso_status", JSON.stringify(tools.map((t) => t.name)));
// Guarda contra la deriva del contrato: memory-orchestrate no puede volver a
// prometer recall "bajo demanda por MCP" (frase literal; otra redaccion se cuela).
const orch = readFileSync(new URL("../hooks/scripts/memory-orchestrate.js", import.meta.url), "utf8");
A(!/bajo demanda por MCP/i.test(orch), "memory-orchestrate no promete recall por MCP (retirado 2026-10-03)", "comentario obsoleto en memory-orchestrate.js");
const stats = byId.get(3)?.result?.content?.[0]?.text ?? "";
A(!byId.get(3)?.result?.isError && /"active"\s*:\s*\d+/.test(stats), "memory_stats devuelve JSON con active", stats.slice(0, 120));
A(byId.get(4)?.result?.isError === true, "tool inexistente -> isError (caso negativo)", JSON.stringify(byId.get(4)));

console.log(fail === 0 ? "\nSELFTEST MCP-MEMORIA: VERDE" : `\nSELFTEST MCP-MEMORIA: ROJO (${fail})`);
process.exit(fail === 0 ? 0 : 1);
