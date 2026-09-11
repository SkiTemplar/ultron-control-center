/**
 * research-mcp.selftest.mjs — check conductual del servidor MCP de
 * investigacion. Habla el protocolo real por stdio (initialize -> tools/list
 * -> tools/call) contra el server vivo. tools/call usa research_session_list
 * (solo filesystem local, hermetico) apuntando a una carpeta temporal via
 * RESEARCH_ROOT_OVERRIDE, para no tocar ni la red ni ~/.ultron/research/ real.
 * Uso: node hooks/scripts/research-mcp.selftest.mjs   (exit 0 = verde)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'research-mcp.js');
const tmpRoot = mkdtempSync(path.join(tmpdir(), 'research-mcp-selftest-'));

const msgs = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'research_session_list', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'tool_inexistente', arguments: {} } },
];

const child = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, RESEARCH_ROOT_OVERRIDE: tmpRoot } });
const byId = new Map();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id !== undefined) byId.set(m.id, m); } catch { /* ignora ruido no-JSON */ }
  }
});
for (const m of msgs) child.stdin.write(`${JSON.stringify(m)}\n`);
child.stdin.end();

const deadline = Date.now() + 30_000;
while (byId.size < 4 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
child.kill();
rmSync(tmpRoot, { recursive: true, force: true });

let fail = 0;
const A = (c, n, d) => { if (c) console.log(`  [PASS] ${n}`); else { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); } };

A(byId.get(1)?.result?.serverInfo?.name === 'research', 'initialize -> serverInfo', JSON.stringify(byId.get(1)));
const tools = byId.get(2)?.result?.tools ?? [];
A(tools.length === 6 && tools.some((t) => t.name === 'research_search'), 'tools/list = 6 tools con research_search', JSON.stringify(tools.map((t) => t.name)));
const listResult = byId.get(3)?.result?.content?.[0]?.text ?? '';
A(!byId.get(3)?.result?.isError && listResult === '[]', 'research_session_list en carpeta vacia -> []', listResult);
A(byId.get(4)?.result?.isError === true, 'tool inexistente -> isError (caso negativo)', JSON.stringify(byId.get(4)));

console.log(fail === 0 ? '\nSELFTEST RESEARCH-MCP: VERDE' : `\nSELFTEST RESEARCH-MCP: ROJO (${fail})`);
process.exit(fail === 0 ? 0 : 1);
