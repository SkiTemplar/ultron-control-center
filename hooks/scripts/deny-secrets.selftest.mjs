#!/usr/bin/env node
// deny-secrets.selftest.mjs — fija el contrato del port Node de deny-secrets
// (audit 08-09 #4). Hermetico: sin FS, sin HOME, sin red — solo el modulo.
// Cubre caso feliz (allow), caso negativo (deny) y el fail-closed.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classify, handle } = require('./deny-secrets.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

// --- DENY: rutas de credenciales reales -----------------------------------
check('.env por Read', classify('Read', { file_path: 'C:\\proyecto\\.env' }), 'dotenv credential file');
check('.env.production', classify('Read', { file_path: '/app/.env.production' }), 'dotenv credential file');
check('clave .pem', classify('Write', { file_path: 'C:/keys/server.pem' }), 'private key / keystore (.pem)');
check('keystore .jks', classify('Edit', { file_path: 'app/release.jks' }), 'private key / keystore (.jks)');
check('id_rsa', classify('Read', { file_path: '/home/user/keys/id_rsa' }), 'SSH private key');
check('id_ed25519.pub tambien (prefijo)', classify('Read', { file_path: 'x/id_ed25519.pub' }), 'SSH private key');
check('dentro de .ssh', classify('Read', { file_path: 'C:\\Users\\x\\.ssh\\config' }), 'file inside an .ssh directory');
check('aws credentials', classify('Read', { file_path: '/home/u/.aws/credentials' }), 'AWS credentials file');
check('secrets.json', classify('Read', { file_path: 'config/secrets.json' }), 'credentials/secrets file');
check('.credentials.json dotfile', classify('Read', { file_path: 'x/.credentials.json' }), 'credentials/secrets file');
check('service-account key', classify('Read', { file_path: 'gcp/service-account-prod.json' }), 'service-account key file');
check('notebook_path tambien', classify('NotebookEdit', { notebook_path: 'nb/.env' }), 'dotenv credential file');
check('bash cat .ssh', classify('Bash', { command: 'cat ~/.ssh/id_ed25519' }), 'command accesses a SSH private key');
check('bash con comillas', classify('Bash', { command: 'type "C:/app/.env"' }), 'command accesses a dotenv credential file');

// --- ALLOW: falsos positivos que NO deben saltar --------------------------
check('.env.example es plantilla', classify('Read', { file_path: 'x/.env.example' }), null);
check('.env.template', classify('Read', { file_path: 'x/.env.template' }), null);
check('secrets_scanner.py es codigo', classify('Read', { file_path: 'scripts/secrets_scanner.py' }), null);
check('archivo normal', classify('Read', { file_path: 'src/main.rs' }), null);
check('bash sin rutas', classify('Bash', { command: 'git status' }), null);
check('bash flag no-ruta', classify('Bash', { command: 'cargo build --release' }), null);
check('tool sin path', classify('Read', {}), null);
check('tool desconocida', classify('Grep', { pattern: '.env' }), null);

// --- Contrato del hook completo (handle) ----------------------------------
const denyOut = handle(JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/x/.env' },
}));
const denyJson = JSON.parse(denyOut);
check('handle deny: permissionDecision', denyJson.hookSpecificOutput.permissionDecision, 'deny');
check('handle deny: event name', denyJson.hookSpecificOutput.hookEventName, 'PreToolUse');
check(
  'handle deny: razon con prefijo',
  denyJson.hookSpecificOutput.permissionDecisionReason.startsWith('BLOCKED (deny-secrets):'),
  true,
);

check('handle allow: sin output', handle(JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: 'src/lib.rs' },
})), null);
check('handle: otro evento se ignora', handle(JSON.stringify({
  hook_event_name: 'PostToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/x/.env' },
})), null);
check('handle: JSON invalido no revienta', handle('{{{no json'), null);

// --- Robustez de tipos (paridad con los isinstance-checks del .py) --------
// Nota alcance: el catch fail-closed de handle() es un cinturon para bugs
// FUTUROS del classifier — con JSON plano (sin getters/protos raros) no
// existe hoy input que haga lanzar a classify(), asi que ese catch no es
// alcanzable e2e; lo que si se fija aqui es que los tipos inesperados
// degradan a null sin crash, igual que hacia el .py.
check('tool_input no-dict', classify('Read', 'no-un-dict'), null);
check('file_path no-string', classify('Read', { file_path: 42 }), null);
check('command no-string', classify('Bash', { command: ['cat', '.env'] }), null);

if (failures > 0) {
  console.error(`SELFTEST deny-secrets: ROJO (${failures} fallos)`);
  process.exit(1);
}
console.log('SELFTEST deny-secrets: VERDE');
