/**
 * hubs-refresh.selftest.mjs — lib/hubs-refresh.js: regenera la lista de
 * comodines solo si falta o tiene más de una semana, y nunca lanza.
 * Hermético: fichero temporal y spawn simulado.
 * Uso: node hooks/scripts/hubs-refresh.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { hubsStale, maybeRefreshHubs, REFRESH_EVERY_MS } = require(join(__dirname, 'lib', 'hubs-refresh.js'));

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const dir = mkdtempSync(join(tmpdir(), 'hubs-refresh-'));
const file = join(dir, 'memory-hubs.json');
const now = Date.now();
try {
  A(hubsStale(file, now) === true, 'sin fichero: toca regenerar', 'false');

  writeFileSync(file, '{}');
  const fresco = new Date(now - 60 * 1000);
  utimesSync(file, fresco, fresco);
  A(hubsStale(file, now) === false, 'fichero de hace 1 min: no toca', 'true');

  const viejo = new Date(now - REFRESH_EVERY_MS - 1000);
  utimesSync(file, viejo, viejo);
  A(hubsStale(file, now) === true, 'fichero de hace más de 7 días: toca', 'false');

  const llamadas = [];
  const spawn = (args) => { llamadas.push(args); return true; };
  A(maybeRefreshHubs(spawn, { file, now }) === true && llamadas[0].join(' ') === 'hubs --apply', 'viejo: lanza hubs --apply', JSON.stringify(llamadas));

  utimesSync(file, fresco, fresco);
  A(maybeRefreshHubs(spawn, { file, now }) === false && llamadas.length === 1, 'fresco: no lanza (caso negativo)', String(llamadas.length));

  const explota = () => { throw new Error('boom'); };
  utimesSync(file, viejo, viejo);
  A(maybeRefreshHubs(explota, { file, now }) === false, 'spawn que lanza: devuelve false sin propagar', 'propagó');

  process.env.ULTRON_HUBS_REFRESH = 'off';
  A(maybeRefreshHubs(spawn, { file, now }) === false, 'ULTRON_HUBS_REFRESH=off: no lanza', 'lanzó');
  delete process.env.ULTRON_HUBS_REFRESH;
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\n${fail} FAIL` : '\nOK');
process.exit(fail ? 1 : 0);
