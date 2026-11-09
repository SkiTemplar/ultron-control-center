/**
 * Selftest de pupus-permission.js (2026-10-27).
 *
 * Fija que el hook PermissionRequest solo decide cuando el bocadillo de Pupus
 * contesta, y que en cualquier otro caso (sesión de Sessions, ULTRON cerrado,
 * respuesta sin decisión) no escribe nada y deja mandar al diálogo de la
 * terminal. Hermético: HOME temporal y un puente falso en 127.0.0.1.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, 'pupus-permission.js');
const pp = require('./pupus-permission.js');

let fallos = 0;
function comprueba(nombre, real, esperado) {
  if (real === esperado) console.log(`ok     ${nombre}`);
  else {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${JSON.stringify(esperado)} real=${JSON.stringify(real)}`);
  }
}

const entrada = { session_id: 's', cwd: 'C:/p', tool_name: 'Bash', tool_input: { command: 'git push' } };
const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

// --- puro --------------------------------------------------------------------
comprueba('terminal normal -> pregunta', pp.shouldAsk({}, entrada), true);
comprueba('sesion de Sessions -> no pregunta', pp.shouldAsk({ ULTRON_SESION_ID: 'x' }, entrada), false);
comprueba('opt-out -> no pregunta', pp.shouldAsk({ PUPUS_PERMISSION_DISABLED: '1' }, entrada), false);
comprueba('entrada sin tool_name -> no pregunta', pp.shouldAsk({}, { cwd: 'x' }), false);
comprueba('allow del puente -> se escribe', pp.outputFor(allow), JSON.stringify(allow));
// Caso NEGATIVO: sin decision valida no se escribe nada (manda la terminal).
comprueba('respuesta vacia -> nada', pp.outputFor({}), '');
comprueba('behavior raro -> nada', pp.outputFor({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'ask' } } }), '');
comprueba('otro evento -> nada', pp.outputFor({ hookSpecificOutput: { hookEventName: 'PreToolUse', decision: { behavior: 'allow' } } }), '');

// --- extremo a extremo ---------------------------------------------------------
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pupus-perm-'));
const file = path.join(home, '.ultron', 'cockpit', 'mascot-bridge.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
comprueba('sin fichero del puente -> null', pp.readBridge(file), null);

let recibido = null;
let respuesta = allow;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    recibido = { path: req.url, token: req.headers['x-ultron-token'], body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respuesta));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

function corre(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ULTRON_SESION_ID: '', HOME: home, USERPROFILE: home, ULTRON_SELFTEST: '1', ...env },
    });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(entrada));
  });
}

let r = await corre({});
comprueba('ULTRON cerrado (sin fichero) -> exit 0 sin salida', `${r.code}|${r.out}`, '0|');

fs.writeFileSync(file, JSON.stringify({ port, token: 'tok' }));
r = await corre({});
comprueba('con puente: exit 0', r.code, 0);
comprueba('con puente: devuelve el allow', r.out, JSON.stringify(allow));
comprueba('con puente: ruta', recibido && recibido.path, '/v1/permission');
comprueba('con puente: token', recibido && recibido.token, 'tok');
comprueba('con puente: reenvia la entrada', recibido && recibido.body.tool_input.command, 'git push');

respuesta = {};
r = await corre({});
comprueba('bocadillo sin decision -> sin salida', r.out, '');

recibido = null;
respuesta = allow;
r = await corre({ ULTRON_SESION_ID: 'ses-1' });
comprueba('sesion de Sessions -> ni llama ni decide', `${r.out}|${recibido}`, '|null');

server.close();
fs.rmSync(home, { recursive: true, force: true });
if (fallos) {
  console.error(`\n${fallos} fallo(s)`);
  process.exit(1);
}
console.log('\npupus-permission: todo ok');
