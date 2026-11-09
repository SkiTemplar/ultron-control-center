/**
 * Selftest de batch-capture.js (hooks-6, auditoria 2026-10-23).
 *
 * Fija que el hook solo encola lo que dice su regla (comandos rechazados o
 * que la IA no puede ejecutar) y no el ensayo y error normal: 716 de las 729
 * lineas pendientes eran comandos de exploracion fallidos. Hermetico: HOME
 * temporal y telemetria aislada.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, 'batch-capture.js');
const bc = require('./batch-capture.js');

let fallos = 0;
function comprueba(nombre, real, esperado) {
  if (real === esperado) console.log(`ok     ${nombre}`);
  else {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${esperado} real=${real}`);
  }
}

// --- clasificacion ---------------------------------------------------------
comprueba('rechazo del usuario -> rejected', bc.classifyReason("The user doesn't want to proceed with this tool use."), 'rejected');
comprueba('sandbox -> ai_cannot_execute', bc.classifyReason('Operation not permitted (sandbox)'), 'ai_cannot_execute');
comprueba('acceso denegado -> ai_cannot_execute', bc.classifyReason('Access is denied.'), 'ai_cannot_execute');
// Caso NEGATIVO: el fallo normal de un comando ya no se encola.
comprueba('exit code 1 no se encola', bc.classifyReason('Exit code 1\ngrep: x: No such file or directory'), null);
comprueba('stderr cualquiera no se encola', bc.classifyReason('error: could not compile'), null);
comprueba('error de fontaneria no se encola', bc.classifyReason('InputValidationError: command is required'), null);
comprueba('sin texto no se encola', bc.classifyReason(''), null);

// --- extremo a extremo -------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-capture-selftest-'));
try {
  const tr = path.join(root, 't.jsonl');
  const linea = (o) => JSON.stringify(o);
  fs.writeFileSync(
    tr,
    [
      linea({ message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'cd x && grep foo' } }] } }),
      linea({ message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'Exit code 1' }] } }),
      linea({ message: { content: [{ type: 'tool_use', id: 'b', name: 'PowerShell', input: { command: 'winget install Foo' } }] } }),
      linea({ message: { content: [{ type: 'tool_result', tool_use_id: 'b', is_error: true, content: 'The user doesn\'t want to proceed' }] } }),
    ].join('\n') + '\n',
  );
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ transcript_path: tr, session_id: 's1' }),
    env: { ...process.env, HOME: root, USERPROFILE: root, ULTRON_HOOK_LOGS_DIR: path.join(root, 'logs') },
    encoding: 'utf8',
  });
  comprueba('e2e: sale con 0', r.status, 0);
  const pending = path.join(root, '.ultron', 'batches', 'queue-pending.jsonl');
  const lineas = fs.readFileSync(pending, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  comprueba('e2e: solo se encola el rechazado', lineas.length, 1);
  comprueba('e2e: con su motivo', lineas[0].reason, 'rejected');
  comprueba('e2e: y su .ps1', fs.existsSync(lineas[0].path), true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
