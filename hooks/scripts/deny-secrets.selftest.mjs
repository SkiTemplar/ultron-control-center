#!/usr/bin/env node
// deny-secrets.selftest.mjs — fija el contrato del port Node de deny-secrets
// (audit 08-09 #4). Hermetico: el grueso no toca ni FS ni HOME ni red, y el
// bloque de instrumentacion del final lanza el hook con un HOME temporal
// propio, asi que tampoco escribe en el sistema vivo.
// Cubre caso feliz (allow), caso negativo (deny), el fail-closed y el rastro
// en hook-timing.jsonl (2026-09-22).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { classify, decisionFor, ruleIdFor, handle } = require('./deny-secrets.js');

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

// --- deny vs ask ----------------------------------------------------------
// El fichero de entorno del proyecto degrada a permiso explicito del usuario;
// el resto de credenciales sigue en bloqueo duro.
check('decisionFor: dotenv -> ask', decisionFor('dotenv credential file'), 'ask');
check(
  'decisionFor: dotenv via bash -> ask',
  decisionFor('command accesses a dotenv credential file'),
  'ask',
);
check('decisionFor: SSH key -> deny', decisionFor('SSH private key'), 'deny');
check('decisionFor: keystore -> deny', decisionFor('private key / keystore (.pem)'), 'deny');
check('decisionFor: sin motivo -> deny', decisionFor(null), 'deny');

// --- Contrato del hook completo (handle) ----------------------------------
const askOut = handle(JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/x/.env' },
}));
const askJson = JSON.parse(askOut);
check('handle ask: permissionDecision', askJson.hookSpecificOutput.permissionDecision, 'ask');
check('handle ask: event name', askJson.hookSpecificOutput.hookEventName, 'PreToolUse');
check(
  'handle ask: razon con prefijo',
  askJson.hookSpecificOutput.permissionDecisionReason.startsWith('PERMISO REQUERIDO (deny-secrets):'),
  true,
);

const denyOut = handle(JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: '/home/u/.ssh/id_rsa' },
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

// --- Instrumentacion (2026-09-22) -----------------------------------------
// El hook era el unico registrado sin observe(): 0 lineas en hook-timing.jsonl
// y por tanto ninguna forma de saber si el tripwire habia saltado nunca.
// Lo que se registra es el NOMBRE de la regla, jamas la ruta.

check('ruleIdFor: dotenv', ruleIdFor('dotenv credential file'), 'dotenv');
check('ruleIdFor: por bash conserva la regla', ruleIdFor('command accesses a SSH private key'), 'ssh-key');
check('ruleIdFor: keystore', ruleIdFor('private key / keystore (.pem)'), 'private-key');
check('ruleIdFor: dentro de .ssh', ruleIdFor('file inside an .ssh directory'), 'ssh-dir');
check('ruleIdFor: aws', ruleIdFor('AWS credentials file'), 'aws-credentials');
check('ruleIdFor: service account', ruleIdFor('service-account key file'), 'service-account');
// Caso NEGATIVO: un motivo que no reconoce NO se inventa una regla.
check('ruleIdFor: motivo desconocido', ruleIdFor('algo que no existe'), 'unknown');
check('ruleIdFor: sin motivo', ruleIdFor(null), 'unknown');

// Extremo a extremo con HOME temporal: el proceso real deja su linea.
const home = mkdtempSync(join(tmpdir(), 'deny-secrets-selftest-'));
try {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const hook = join(dirname(fileURLToPath(import.meta.url)), 'deny-secrets.js');
  const ruta = '/home/quienquieraqueseas/.ssh/id_rsa_de_produccion';
  const r = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: ruta },
    }),
    encoding: 'utf8',
    env,
  });
  check('e2e: el hook sale con 0 aunque bloquee', r.status, 0);
  check('e2e: bloquea', JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');

  const log = join(home, '.ultron', 'logs', 'hook-timing.jsonl');
  const lineas = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  check('e2e: una sola linea de timing', lineas.length, 1);
  const rec = lineas[0];
  check('e2e: el hook se identifica', rec.hook, 'deny-secrets');
  check('e2e: trae exit_code', rec.exit_code, 0);
  check('e2e: trae la decision', rec.decision, 'deny');
  check('e2e: trae el nombre de la regla', rec.rule, 'ssh-key');
  check('e2e: trae la tool', rec.tool, 'Read');
  check('e2e: no vino por bash', rec.via_bash, false);
  check('e2e: mide el tiempo', typeof rec.elapsed_ms === 'number', true);
  // Caso NEGATIVO de privacidad (mandamiento 9, repo publico): la linea NO
  // puede llevar la ruta del fichero de credenciales ni ningun trozo de ella.
  const crudo = JSON.stringify(rec);
  check('e2e: la ruta NO aparece en el log', crudo.includes('id_rsa_de_produccion'), false);
  check('e2e: ni el directorio del usuario', crudo.includes('quienquieraqueseas'), false);
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`SELFTEST deny-secrets: ROJO (${failures} fallos)`);
  process.exit(1);
}
console.log('SELFTEST deny-secrets: VERDE');
