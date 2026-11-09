/**
 * Selftest de lib/hook-obs.js: destino de la telemetria (hooks-7, 2026-10-23).
 *
 * Los selftests y los harnesses escribian en ~/.ultron/logs/hook-errors.jsonl
 * y hook-timing.jsonl, que la pestana Hooks ensena como disparos reales. Aqui
 * se fija el orden de destino (variable explicita, proceso de prueba,
 * produccion) y que un proceso de prueba de verdad no toca el log real.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const obs = require('./hook-obs.js');

let fallos = 0;
function comprueba(nombre, real, esperado) {
  if (real === esperado) console.log(`ok     ${nombre}`);
  else {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${esperado} real=${real}`);
  }
}

const prod = path.join(os.homedir(), '.ultron', 'logs');
const tmpLogs = path.join(os.tmpdir(), 'ultron-selftest-logs');

comprueba('la variable explicita manda', obs.logsDir({ ULTRON_HOOK_LOGS_DIR: '/x/logs', ULTRON_SELFTEST: '1' }, ['node', 'a.js']), '/x/logs');
comprueba('ULTRON_SELFTEST=1 va al temporal', obs.logsDir({ ULTRON_SELFTEST: '1' }, ['node', 'hook.js']), tmpLogs);
comprueba('un *.selftest.mjs principal va al temporal', obs.logsDir({}, ['node', 'C:/r/hooks/scripts/x.selftest.mjs']), tmpLogs);
// Caso NEGATIVO: un hook de produccion sigue escribiendo en ~/.ultron/logs.
comprueba('un hook real escribe en produccion', obs.logsDir({}, ['node', 'C:/r/hooks/scripts/deny-secrets.js']), prod);
comprueba('ULTRON_SELFTEST distinto de 1 no cuenta', obs.isTestProcess({ ULTRON_SELFTEST: '0' }, ['node', 'h.js']), false);

// Extremo a extremo: un hijo que registra un error con la variable fijada lo
// deja en ese directorio y no en el log real.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-obs-selftest-'));
try {
  const real = path.join(prod, 'hook-errors.jsonl');
  const antes = fs.existsSync(real) ? fs.statSync(real).size : -1;
  const script = path.join(dir, 'hijo.cjs');
  fs.writeFileSync(
    script,
    `require(${JSON.stringify(path.join(here, 'hook-obs.js'))}).logHookError('hook-obs-selftest', new Error('prueba'));\n`,
  );
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, ULTRON_HOOK_LOGS_DIR: dir },
    encoding: 'utf8',
  });
  comprueba('e2e: el hijo sale con 0', r.status, 0);
  const linea = fs.readFileSync(path.join(dir, 'hook-errors.jsonl'), 'utf8').trim();
  comprueba('e2e: el error queda en el directorio aislado', JSON.parse(linea).hook, 'hook-obs-selftest');
  const despues = fs.existsSync(real) ? fs.statSync(real).size : -1;
  comprueba('e2e: el log real no cambia', despues, antes);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
