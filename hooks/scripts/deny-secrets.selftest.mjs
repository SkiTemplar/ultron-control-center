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
// Hermetico: la pausa real del usuario (~/.ultron/run) no debe cambiar el resultado.
process.env.ULTRON_DENY_SECRETS_PAUSA = join(tmpdir(), 'deny-secrets-pausa-inexistente.json');
const { classify, decisionFor, ruleIdFor, handle, askEnPausa } = require('./deny-secrets.js');

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
  const env = { ...process.env, HOME: home, USERPROFILE: home, ULTRON_HOOK_LOGS_DIR: join(home, '.ultron', 'logs') };
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
check('tool desconocida', classify('WebSearch', { query: '.env' }), null);

// --- H23 (auditoria 2026-10-17): PowerShell, Grep y rutas con barra invertida
// Antes todo esto devolvia null: las claves de ~/.ultron/.env y de ~/.ssh
// entraban al contexto por la shell principal de Windows sin dialogo.
check('PowerShell Get-Content .env', classify('PowerShell', { command: 'Get-Content .env' }), 'command accesses a dotenv credential file');
check('PowerShell ruta con barra invertida', classify('PowerShell', { command: 'Get-Content C:\\Users\\x\\.ultron\\.env' }), 'command accesses a dotenv credential file');
check('PowerShell -Path con $HOME', classify('PowerShell', { command: 'gc -Path $HOME\\.ssh\\id_ed25519' }), 'command accesses a SSH private key');
check('PowerShell Join-Path con comillas', classify('PowerShell', { command: "Get-Content (Join-Path $env:USERPROFILE '.env')" }), 'command accesses a dotenv credential file');
check('PowerShell ruta con espacios entre comillas', classify('PowerShell', { command: 'type "C:\\Program Files\\app\\.env.local"' }), 'command accesses a dotenv credential file');
check('Bash ruta con barra invertida', classify('Bash', { command: 'cat C:\\app\\.env' }), 'command accesses a dotenv credential file');
check('Bash redireccion de entrada pegada', classify('Bash', { command: 'cat<.env' }), 'command accesses a dotenv credential file');
check('Bash flag con =', classify('Bash', { command: 'node --env-file=.env x.js' }), 'command accesses a dotenv credential file');
check('Bash credenciales por nombre suelto', classify('Bash', { command: 'cat credentials.json' }), 'command accesses a credentials/secrets file');
check('PowerShell clave SSH por nombre suelto', classify('PowerShell', { command: 'type id_rsa' }), 'command accesses a SSH private key');
check('Bash clave con ruta relativa', classify('Bash', { command: 'cat ./server.pem' }), 'command accesses a private key / keystore (.pem)');
check('PowerShell .\\ anclado', classify('PowerShell', { command: 'gc .\\certs\\server.pfx' }), 'command accesses a private key / keystore (.pfx)');
check('Bash glob de .env', classify('Bash', { command: 'cat .env*' }), 'command accesses a dotenv credential file');
check('Grep con path a .env', classify('Grep', { pattern: 'KEY', path: 'C:\\Users\\x\\.ultron\\.env' }), 'dotenv credential file');
check('Grep con glob de claves', classify('Grep', { pattern: 'BEGIN', path: 'C:/x', glob: '*.pem' }), 'private key / keystore (.pem)');
check('Grep dentro de .ssh', classify('Grep', { pattern: 'x', path: '~/.ssh' }), 'file inside an .ssh directory');
check('git-credentials', classify('Read', { file_path: 'C:\\Users\\x\\.git-credentials' }), 'git credential store');
check('netrc', classify('Bash', { command: 'cat ~/.netrc' }), 'command accesses a netrc credentials file');
check('_netrc de Windows', classify('Read', { file_path: 'C:/Users/x/_netrc' }), 'netrc credentials file');
check('npmrc', classify('Read', { file_path: 'C:/Users/x/.npmrc' }), 'package registry token file');
check('pypirc', classify('Read', { file_path: '/home/x/.pypirc' }), 'package registry token file');
check('gh hosts.yml', classify('Read', { file_path: 'C:\\Users\\x\\AppData\\Roaming\\GitHub CLI\\hosts.yml' }), 'GitHub CLI token file');
check('gh hosts.yml en .config/gh', classify('PowerShell', { command: 'cat ~/.config/gh/hosts.yml' }), 'command accesses a GitHub CLI token file');
check('decisionFor: npmrc -> ask', decisionFor('package registry token file'), 'ask');
check('decisionFor: git-credentials -> deny', decisionFor('git credential store'), 'deny');
check('ruleIdFor: git-credentials', ruleIdFor('git credential store'), 'git-credentials');
check('ruleIdFor: netrc', ruleIdFor('command accesses a netrc credentials file'), 'netrc');
check('ruleIdFor: registry', ruleIdFor('package registry token file'), 'registry-token');
check('ruleIdFor: gh', ruleIdFor('GitHub CLI token file'), 'gh-token');

// ALLOW de las mismas herramientas: sin falsos positivos nuevos.
check('PowerShell sin rutas', classify('PowerShell', { command: 'Get-ChildItem -Recurse' }), null);
check('PowerShell $env: no es .env', classify('PowerShell', { command: 'echo $env:USERPROFILE' }), null);
check('PowerShell ruta normal con barra invertida', classify('PowerShell', { command: 'Get-Content C:\\app\\src\\main.rs' }), null);
check('Bash regex con barra invertida', classify('Bash', { command: 'rg -n "foo\\\\bar" src' }), null);
check('Grep normal', classify('Grep', { pattern: 'TODO', path: 'C:/app/src', glob: '*.ts' }), null);
check('Grep sin path', classify('Grep', { pattern: '.env' }), null);
check('hosts.yml fuera de gh', classify('Read', { file_path: 'C:/app/config/hosts.yml' }), null);
check('.env.example por PowerShell', classify('PowerShell', { command: 'Get-Content .env.example' }), null);
check('git add de package.json', classify('Bash', { command: 'git add package.json src/a.ts' }), null);
// Falsos positivos medidos sobre 2.837 llamadas reales de shell (2026-10-17):
// propiedades `.key` en codigo y escapes de regex con barra invertida.
check('codigo con e.key no es una clave', classify('Bash', { command: 'node -e "window.addEventListener(k => k.key)"' }), null);
check('PowerShell $entry.Key no es una clave', classify('PowerShell', { command: '$h.GetEnumerator() | % { $_.Key }' }), null);
check('regex \\.env en grep no es el fichero', classify('Bash', { command: 'grep -n "\\.env" hooks/manifest.json' }), null);
check('regex mock\\.env\\( en node -e', classify('Bash', { command: "node -e \"s.replace(/mock\\.env\\(/, 'x')\"" }), null);
check('comentario entre comillas que nombra .env', classify('Bash', { command: 'git commit -m "docs: explica la carga del entorno"' }), null);

// Revision de H23: formas de PowerShell y de glob que el primer arreglo dejaba
// pasar (las cuatro devolvian null).
check('PowerShell -Path:valor pegado', classify('PowerShell', { command: 'Get-Content -Path:C:\\x\\.env' }), 'command accesses a dotenv credential file');
check('PowerShell ${env:X}\\ruta', classify('PowerShell', { command: 'Get-Content ${env:USERPROFILE}\\.ultron\\.env' }), 'command accesses a dotenv credential file');
check('PowerShell "$($env:X)\\ruta"', classify('PowerShell', { command: 'Get-Content "$($env:USERPROFILE)\\.ultron\\.env"' }), 'command accesses a dotenv credential file');
check('PowerShell comodin *.env', classify('PowerShell', { command: 'Get-Content C:\\app\\*.env' }), 'command accesses a dotenv credential file');
check('Grep glob *.env', classify('Grep', { pattern: 'KEY', glob: '*.env' }), 'dotenv credential file');
check('Grep glob con llaves', classify('Grep', { pattern: 'KEY', glob: '{.env,.npmrc}' }), 'dotenv credential file');
check('Grep glob de claves con llaves', classify('Grep', { pattern: 'BEGIN', glob: '*.{pem,key}' }), 'private key / keystore (.pem)');
check('Grep glob con llaves sin credenciales', classify('Grep', { pattern: 'TODO', path: 'C:/app', glob: '*.{ts,tsx}' }), null);
check('Grep glob .env.example', classify('Grep', { pattern: 'X', glob: '*.env.example' }), null);
check('PowerShell $(…) sin credenciales', classify('PowerShell', { command: 'Get-Content "$($env:USERPROFILE)\\notas\\a.md"' }), null);
check('PowerShell -Path:valor normal', classify('PowerShell', { command: 'Get-Content -Path:C:\\app\\src\\main.rs' }), null);
{
  // Comilla sin cerrar en una linea larga: el escaneo de rutas entre comillas
  // era cuadratico (650 ms con 96 KB). Con el tope tiene que ser lineal.
  const larga = 'palabra '.repeat(12000);
  const t0 = Date.now();
  classify('Bash', { command: `echo "${larga} '${larga}` });
  const ms = Date.now() - t0;
  check(`linea de 192 KB con comillas sin cerrar en <150 ms (medido ${ms} ms)`, ms < 150, true);
}

// Paridad tool <-> matcher: cada herramienta que el clasificador trata tiene
// que estar en el matcher del hook en la plantilla versionada.
{
  const { SHELL_TOOLS, FILE_TOOLS, SEARCH_TOOLS } = require('./deny-secrets.js');
  const plantilla = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'settings-hooks.json');
  const cfg = JSON.parse(readFileSync(plantilla, 'utf8'));
  const entradas = (cfg.hooks?.PreToolUse || [])
    .filter((m) => (m.hooks || []).some((h) => String(h.command || '').includes('deny-secrets.js')));
  check('plantilla: deny-secrets registrado en PreToolUse', entradas.length, 1);
  const matcher = new Set(String(entradas[0]?.matcher || '').split('|'));
  for (const tool of [...FILE_TOOLS, ...SHELL_TOOLS, ...SEARCH_TOOLS]) {
    check(`plantilla: el matcher de deny-secrets incluye ${tool}`, matcher.has(tool), true);
  }
}

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


// --- Ficheros de control de los guardianes (seguridad MEDIUM 2026-10-17) ---
// La pausa y el marcador uni desarman un freno: el agente no los escribe.
{
  const PAUSA = 'C:\\Users\\u\\.ultron\\run\\deny-secrets-pausa.json';
  const MARCA = 'C:\\uni\\ASIG\\trabajos\\T1\\.ultron-trabajo.json';
  // decisionFor(null) devuelve 'deny' (fail-closed), asi que sin el guard un
  // caso que no se clasifica pasaria igual: 'pasa' hace que el negativo falle.
  const deny = (tool, input) => {
    const reason = classify(tool, input);
    return reason ? decisionFor(reason) : 'pasa';
  };
  check('control: Write a la pausa -> deny', deny('Write', { file_path: PAUSA }), 'deny');
  check('control: Edit al marcador -> deny', deny('Edit', { file_path: MARCA }), 'deny');
  check('control: mayusculas no escapan', deny('Write', { file_path: MARCA.toUpperCase() }), 'deny');
  check('control: regla pause-file', ruleIdFor(classify('Write', { file_path: PAUSA })), 'pause-file');
  check('control: regla uni-marker', ruleIdFor(classify('Edit', { file_path: MARCA })), 'uni-marker');
  // N4 (auditoria 2026-10-23): un comodin con un rango invalido (`[z-a]`) no
  // casa con nada en la shell, pero el traductor lanzaba y el catch devolvia
  // `true`: bloqueaba el comando y lo atribuia a la pausa, que ni nombraba.
  check('control: glob con rango invalido no bloquea',
    deny('Bash', { command: 'cp a [z-a]ultron-trabajo.json' }), 'pasa');
  check('control: glob valido al marcador sigue bloqueando',
    deny('Bash', { command: 'cp a .ultron-trab*.json' }), 'deny');
  check('control: Set-Content a la pausa -> deny',
    deny('PowerShell', { command: `Set-Content -Path "${PAUSA}" -Value '{"hasta":"2099-01-01"}'` }), 'deny');
  check('control: echo > pausa -> deny',
    deny('Bash', { command: `echo '{"hasta":"2099-01-01"}' > ~/.ultron/run/deny-secrets-pausa.json` }), 'deny');
  check('control: node -e escribe la pausa -> deny',
    deny('Bash', { command: `node -e "require('fs').writeFileSync('C:/x/.ultron/run/deny-secrets-pausa.json','{}')"` }), 'deny');
  check('control: rm del marcador -> deny', deny('Bash', { command: 'rm trabajos/T1/.ultron-trabajo.json' }), 'deny');
  check('control: Remove-Item del marcador -> deny',
    deny('PowerShell', { command: `Remove-Item "${MARCA}"` }), 'deny');
  check('control: cat | tee al marcador -> deny',
    deny('Bash', { command: 'cat x.json | tee trabajos/T1/.ultron-trabajo.json' }), 'deny');
  check('control: git checkout del marcador -> deny',
    deny('Bash', { command: 'git checkout -- .ultron-trabajo.json' }), 'deny');
  check('control: Get-Content con Set-Content por tuberia -> deny',
    deny('PowerShell', { command: `Get-Content a.json | Set-Content "${MARCA}"` }), 'deny');
  // Leer sigue permitido: no desarma nada.
  check('control: Read del marcador -> pasa', classify('Read', { file_path: MARCA }), null);
  check('control: cat del marcador -> pasa', classify('Bash', { command: `cat "${MARCA}"` }), null);
  check('control: Get-Content de la pausa -> pasa',
    classify('PowerShell', { command: `Get-Content -Raw "${PAUSA}" | ConvertFrom-Json` }), null);
  check('control: Join-Path y Get-Content -> pasa',
    classify('PowerShell', { command: `Get-Content (Join-Path $HOME '.ultron/run/deny-secrets-pausa.json') 2>$null` }), null);
  check('control: git status no lo nombra -> pasa', classify('Bash', { command: 'git status --short' }), null);
  check('control: git commit -m que lo nombra -> pasa',
    classify('Bash', { command: 'git commit -m "fix: proteger .ultron-trabajo.json"' }), null);
  check('control: git commit seguido de rm -> deny',
    deny('Bash', { command: 'git commit -m "x" && rm .ultron-trabajo.json' }), 'deny');
  check('control: nombre parecido -> pasa',
    classify('Write', { file_path: 'C:\\x\\ultron-trabajo.json.bak' }), null);
  check('control: el selftest que lo menciona en el patron -> pasa',
    classify('Bash', { command: 'rg -n "deny-secrets-pausa" hooks' }), null);
  // Formas habituales de leer que no deben bloquear (revision 2026-10-18).
  check('control: cd && cat -> pasa',
    classify('Bash', { command: 'cd /c/uni/ASIG && cat trabajos/T1/.ultron-trabajo.json' }), null);
  check('control: Set-Location; Get-Content -> pasa',
    classify('PowerShell', { command: `Set-Location C:\\uni; Get-Content "${MARCA}"` }), null);
  check('control: git -C <ruta> --no-pager diff -> pasa',
    classify('Bash', { command: 'git -C C:/x --no-pager diff -- .ultron-trabajo.json' }), null);
  const commitHeredoc = (cuerpo) => `git commit -m "$(cat <<'EOF'\n${cuerpo}\nEOF\n)"`;
  check('control: commit con heredoc de Claude Code que lo nombra -> pasa',
    classify('Bash', { command: commitHeredoc('fix: proteger deny-secrets-pausa.json\n\nCo-Authored-By: x') }), null);
  // Casos negativos: lo que se parece a una lectura pero escribe o ejecuta.
  check('control: git diff --output al marcador -> deny',
    deny('Bash', { command: 'git diff --output=.ultron-trabajo.json' }), 'deny');
  check('control: git -c (puede fijar un comando) -> deny',
    deny('Bash', { command: 'git -c core.fsmonitor=x status -- .ultron-trabajo.json' }), 'deny');
  check('control: cd && rm -> deny', deny('Bash', { command: 'cd x && rm .ultron-trabajo.json' }), 'deny');
  check('control: heredoc que cierra antes y sigue codigo -> deny',
    deny('Bash', { command: commitHeredoc('x\nEOF\nrm .ultron-trabajo.json') }), 'deny');
  check('control: heredoc sin comillas (se expande) -> deny',
    deny('Bash', { command: 'git commit -m "$(cat <<EOF\n$(rm .ultron-trabajo.json)\nEOF\n)"' }), 'deny');
  check('control: heredoc en un comentario -> deny',
    deny('Bash', { command: "echo a # $(cat <<'EOF'\nrm .ultron-trabajo.json\nEOF\n)" }), 'deny');
  check('control: heredoc entre comillas simples -> deny',
    deny('Bash', { command: "echo '$(cat <<'EOF'\nrm .ultron-trabajo.json\nEOF\n)'" }), 'deny');
  check('control: commit con heredoc seguido de rm -> deny',
    deny('Bash', { command: `${commitHeredoc('x')} && rm .ultron-trabajo.json` }), 'deny');
  check('control: heredoc en PowerShell no se neutraliza -> deny',
    deny('PowerShell', { command: commitHeredoc('x .ultron-trabajo.json') }), 'deny');

  // Revision adversarial 2026-10-18: formas de nombrar el fichero sin que el
  // nombre aparezca entero como palabra (Win32 y la shell lo reconstruyen).
  const RUN = '~/.ultron/run/';
  check('control: Write con punto final (Win32 lo recorta) -> deny', deny('Write', { file_path: `${PAUSA}.` }), 'deny');
  check('control: Write con blanco final -> deny', deny('Write', { file_path: `${MARCA} ` }), 'deny');
  check('control: Write al flujo ::$DATA -> deny', deny('Write', { file_path: `${PAUSA}::$DATA` }), 'deny');
  check('control: nombre partido por comillas -> deny',
    deny('Bash', { command: `echo '{}' > ${RUN}deny-secrets-pausa".json"` }), 'deny');
  check('control: punto escapado con barra -> deny',
    deny('Bash', { command: `echo '{}' > ${RUN}deny-secrets-pausa\\.json` }), 'deny');
  check('control: ANSI-C $\'...\' -> deny',
    deny('Bash', { command: `rm .ultron-$'trabajo'.json` }), 'deny');
  check('control: expansion de llaves -> deny',
    deny('Bash', { command: `echo '{}' | tee ${RUN}deny-secrets-pausa.{json,bak}` }), 'deny');
  check('control: comodin de shell -> deny',
    deny('Bash', { command: `echo '{}' | tee ${RUN}deny-secrets-p*.json` }), 'deny');
  check('control: comodin de PowerShell -> deny',
    deny('PowerShell', { command: `Set-Content -Path ~\\.ultron\\run\\deny-secrets-pausa.jso? -Value '{}'` }), 'deny');
  check('control: escape con comilla invertida de PowerShell -> deny',
    deny('PowerShell', { command: 'Remove-Item .ultron-trabajo.`json' }), 'deny');
  check('control: concatenacion de PowerShell -> deny',
    deny('PowerShell', { command: `Remove-Item ('.ultron-' + 'trabajo.json')` }), 'deny');
  check('control: redireccion a /dev/null/.. -> deny',
    deny('Bash', { command: 'echo 1 >/dev/null/../../c/u/.ultron/run/deny-secrets-pausa.json' }), 'deny');
  check('control: less -o copia al fichero -> deny',
    deny('Bash', { command: 'less -o .ultron-trabajo.json /tmp/x' }), 'deny');
  check('control: rg --pre ejecuta un programa -> deny',
    deny('Bash', { command: 'rg --pre ./w.sh x .ultron-trabajo.json' }), 'deny');
  check('control: find -delete -> deny',
    deny('Bash', { command: 'find . -name .ultron-trabajo.json -delete' }), 'deny');
  check('control: find -exec rm -> deny',
    deny('Bash', { command: 'find . -name .ultron-trabajo.json -exec rm {} \\;' }), 'deny');
  check('control: sort -o al fichero -> deny',
    deny('Bash', { command: 'sort -uo .ultron-trabajo.json x' }), 'deny');
  // Lecturas legitimas que antes se bloqueaban o que no deben empezar a hacerlo.
  check('control: find que solo busca -> pasa',
    classify('Bash', { command: 'find /c/uni -name .ultron-trabajo.json 2>/dev/null' }), null);
  check('control: grep | sort -> pasa',
    classify('Bash', { command: 'grep -rl .ultron-trabajo.json hooks | sort' }), null);
  check('control: echo a stderr -> pasa',
    classify('Bash', { command: 'echo "falta .ultron-trabajo.json" >&2' }), null);
  check('control: git diff --output-indicator-new -> pasa',
    classify('Bash', { command: 'git diff --output-indicator-new=+ -- .ultron-trabajo.json' }), null);
  check('control: rm de *.json sin letras del nombre -> pasa',
    classify('Bash', { command: 'rm -f dist/*.json' }), null);
  check('control: Remove-Item de *.json -> pasa',
    classify('PowerShell', { command: 'Remove-Item -Recurse out\\*.json' }), null);
  check('control: tipo .NET entre corchetes no es comodin -> pasa',
    classify('PowerShell', { command: '[IO.File]::WriteAllText("C:\\x\\notas.txt", "a")' }), null);
}

// --- Pausa con caducidad de las peticiones 'ask' ---------------------------
{
  const fsx = require('fs');
  const osx = require('os');
  const px = require('path');
  const dir = fsx.mkdtempSync(px.join(osx.tmpdir(), 'deny-pausa-'));
  const pf = px.join(dir, 'pausa.json');
  process.env.ULTRON_DENY_SECRETS_PAUSA = pf;
  const envRead = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/.env' } });
  const keyRead = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x/.ssh/id_rsa' } });
  check('pausa: sin fichero -> no pausa', askEnPausa(), false);
  fsx.writeFileSync(pf, JSON.stringify({ hasta: new Date(Date.now() + 3600e3).toISOString() }));
  check('pausa vigente: .env sin peticion', handle(envRead), null);
  check('pausa vigente: clave SSH sigue en deny', JSON.parse(handle(keyRead)).hookSpecificOutput.permissionDecision, 'deny');
  fsx.writeFileSync(pf, JSON.stringify({ hasta: new Date(Date.now() - 1000).toISOString() }));
  check('pausa caducada: .env vuelve a ask', JSON.parse(handle(envRead)).hookSpecificOutput.permissionDecision, 'ask');
  fsx.writeFileSync(pf, JSON.stringify({ hasta: new Date(Date.now() + 48 * 3600e3).toISOString() }));
  check('pausa a mas de 12 h vista -> se ignora', askEnPausa(), false);
  fsx.writeFileSync(pf, '{roto');
  check('pausa ilegible -> no pausa', askEnPausa(), false);
  // Con la pausa movida por variable, su nombre propio tambien queda protegido.
  check('pausa movida: Write al fichero de la variable -> deny',
    ruleIdFor(classify('Write', { file_path: pf })), 'pause-file');
  process.env.ULTRON_DENY_SECRETS_PAUSA = join(tmpdir(), 'deny-secrets-pausa-inexistente.json');
  fsx.rmSync(dir, { recursive: true, force: true });
}

// --- seguridad-2 y hooks-9 (auditoria 2026-10-23) ----------------------------
// Los ficheros con mas credenciales reales de la maquina pasaban sin freno, y
// las reglas existentes se saltaban con un glob o con comillas partidas.
{
  const r = (tool, input) => {
    const reason = classify(tool, input);
    return reason ? `${decisionFor(reason)}/${ruleIdFor(reason)}` : 'pasa';
  };
  const sh = (command) => r('Bash', { command });
  const ps = (command) => r('PowerShell', { command });
  // Ficheros nuevos
  check('~/.claude.json por Read -> ask', r('Read', { file_path: 'C:\\Users\\x\\.claude.json' }), 'ask/claude-config');
  check('copia de ~/.claude.json -> ask', r('Read', { file_path: '/h/.claude/backups/.claude.json.backup.123' }), 'ask/claude-config');
  check('~/.claude.json por cat -> ask', sh('cat ~/.claude.json'), 'ask/claude-config');
  check('~/.codex/auth.json -> deny', r('Read', { file_path: 'C:/Users/x/.codex/auth.json' }), 'deny/cli-auth');
  check('~/.codex/auth.json por PowerShell -> deny', ps('Get-Content $HOME\\.codex\\auth.json'), 'deny/cli-auth');
  check('~/.gemini/oauth_creds.json -> deny', r('Read', { file_path: '/h/.gemini/oauth_creds.json' }), 'deny/cli-auth');
  check('mascot-bridge.json -> ask', r('Read', { file_path: 'C:\\Users\\x\\.ultron\\cockpit\\mascot-bridge.json' }), 'ask/bridge-token');
  check('mascot-bridge.json por Grep -> ask', r('Grep', { pattern: 'token', path: '~/.ultron/cockpit/mascot-bridge.json' }), 'ask/bridge-token');
  check('%TEMP%/ultron-pupus -> ask', r('Read', { file_path: 'C:\\Users\\x\\AppData\\Local\\Temp\\ultron-pupus\\chat-settings.json' }), 'ask/bridge-token');
  check('ultron-pupus por cmd %TEMP% -> ask', ps('type %TEMP%\\ultron-pupus\\chat-settings.json'), 'ask/bridge-token');
  check('MultiEdit tambien es herramienta de fichero', r('MultiEdit', { file_path: '/x/.env' }), 'ask/dotenv');
  // Globs
  check('glob .e* -> ask', sh('cat ~/.ultron/.e*'), 'ask/dotenv');
  check('glob .en? -> ask', sh('cat ~/.ultron/.en?'), 'ask/dotenv');
  check('glob [.]env -> ask', sh('cat ~/.ultron/.[e]nv'), 'ask/dotenv');
  check('glob en el directorio .co*/auth.json -> deny', sh('cat ~/.co*/auth.json'), 'deny/cli-auth');
  check('glob mascot-b* -> ask', sh('cat ~/.ultron/cockpit/mascot-b*'), 'ask/bridge-token');
  check('glob cockpit/*.json alcanza el token -> ask', sh('cat ~/.ultron/cockpit/*.json'), 'ask/bridge-token');
  check('glob .codex/* -> deny', ps('Get-Content ~/.codex/*'), 'deny/cli-auth');
  check('glob .cl*.json -> ask', sh('cat ~/.cl*.json'), 'ask/claude-config');
  check('glob id_* -> deny', sh('cat keys/id_*'), 'deny/ssh-key');
  check('Grep con glob .e* -> ask', r('Grep', { pattern: 'KEY', path: '~/.ultron', glob: '.e*' }), 'ask/dotenv');
  // Comillas partidas y concatenacion
  check('comillas vacias partidas .e""nv -> ask', sh('cat ~/.ultron/.e""nv'), 'ask/dotenv');
  check("comillas simples partidas .e''nv -> ask", sh("cat ~/.ultron/.e''nv"), 'ask/dotenv');
  check('comillas a mitad ".e"nv -> ask', sh('cat ~/.ultron/".e"nv'), 'ask/dotenv');
  check('escape de bash .e\\nv -> ask', sh('cat ~/.ultron/.e\\nv'), 'ask/dotenv');
  check("concatenacion JS '.'+'env' -> ask", sh("node -e \"require('fs').readFileSync(require('os').homedir()+'/.ultron/'+'.'+'env')\""), 'ask/dotenv');
  check('concatenacion PowerShell ".e" + "nv" -> ask', ps('gc (Join-Path $HOME ".ultron\\.e" + "nv")'), 'ask/dotenv');
  // Volcado de variables de entorno con secretos
  check('printenv -> ask', sh('printenv | grep API_KEY'), 'ask/env-dump');
  check('env suelto -> ask', sh('env | sort'), 'ask/env-dump');
  check('echo $GROQ_API_KEY -> ask', sh('echo $GROQ_API_KEY'), 'ask/env-dump');
  check('PowerShell $env:GEMINI_API_KEY -> ask', ps('Write-Output $env:GEMINI_API_KEY'), 'ask/env-dump');
  check('PowerShell gci env: -> ask', ps('Get-ChildItem env:'), 'ask/env-dump');
  check('reg query HKCU\\Environment -> ask', ps('reg query HKCU\\Environment /v GROQ_API_KEY'), 'ask/env-dump');
  check('Get-ItemProperty HKCU:\\Environment -> ask', ps('Get-ItemProperty -Path HKCU:\\Environment'), 'ask/env-dump');
  check('GetEnvironmentVariable de un token -> ask', ps("[Environment]::GetEnvironmentVariable('GITHUB_TOKEN','User')"), 'ask/env-dump');
  // Caso NEGATIVO: lo legitimo parecido sigue pasando
  check('ls de un directorio con * pasa', sh('ls src/*'), 'pasa');
  check('cp dist/* pasa', sh('cp dist/* out/'), 'pasa');
  check('scripts/*.mjs pasa', sh('node scripts/*.mjs'), 'pasa');
  check('package.json con glob ajeno pasa', sh('cat packages/*/package.json'), 'pasa');
  check('settings.json de .claude pasa', r('Read', { file_path: 'C:/Users/x/.claude/settings.json' }), 'pasa');
  check('auth.json fuera de .codex pasa', r('Read', { file_path: 'src/api/auth.json' }), 'pasa');
  check('config.toml de codex pasa', r('Read', { file_path: '/h/.codex/config.toml' }), 'pasa');
  check('mascot/bridge.rs pasa', r('Read', { file_path: 'src-tauri/src/mascot/bridge.rs' }), 'pasa');
  check('env con asignacion como prefijo pasa', sh('env FOO=1 node x.js'), 'pasa');
  check('$HOME no es un secreto', sh('echo $HOME $PATH'), 'pasa');
  check('$env:USERPROFILE no es un secreto', ps('echo $env:USERPROFILE'), 'pasa');
  check('comillas normales en un commit pasan', sh('git commit -m "fix: algo"'), 'pasa');
  check('grep de la palabra API_KEY pasa', sh('grep -rn API_KEY src/'), 'pasa');
  check('HKCU de otra clave pasa', ps('reg query HKCU\\Software\\Microsoft'), 'pasa');
  // Falsos positivos medidos al reproducir 14.612 llamadas reales (2026-10-23)
  check('comprobar que una variable existe pasa', sh('[ -n "$OMDB_API_KEY" ] && echo hay'), 'pasa');
  check('Get-ChildItem de $env:USERPROFILE no es un volcado', ps('Get-ChildItem "$env:USERPROFILE\\Downloads"'), 'pasa');
  check('una regex .*n no es un glob de dotfiles', sh("node -e \"s.replace(/x.*\\n/,'')\""), 'pasa');
  check('glob de un directorio en ultima posicion pasa', sh('ls -td ~/AppData/Local/Temp/*pupus*'), 'pasa');
  check('ultron-* en mitad de una ruta del repo pasa', sh('head -5 mods/ultron-*/hooks/register.tsx'), 'pasa');
  check('patron suelto de tasklist pasa', sh('tasklist //FI "IMAGENAME eq ultron*"'), 'pasa');
  check('patron suelto de find pasa', sh('find . -ipath "*mascot*" -print'), 'pasa');
  check('patron *IA* de find pasa', sh('find Content -iname "*IA*"'), 'pasa');
  check('grep del nombre del directorio del puente pasa', sh('grep -n "temp_dir\\|ultron-pupus" chat_gate.rs'), 'pasa');
  check('Set en mayuscula (PowerShell) no es un volcado', ps('Set'), 'pasa');
  check('set suelto de bash vuelca el entorno -> ask', sh('set | grep KEY'), 'ask/env-dump');
  check('glob de Temp que entra en ultron-pupus -> ask',
    sh('cat ~/AppData/Local/Temp/*pupus*/chat-settings.json'), 'ask/bridge-token');
}

// --- Auditoria 2026-11-01: Monitor, comandos interiores, cwd y dotenv ---------
// Cadenas inertes: solo se llama al clasificador, no se lee ningun fichero.
{
  const r = (tool, input, cwd) => {
    const reason = classify(tool, input, cwd);
    return reason ? `${decisionFor(reason)}/${ruleIdFor(reason)}` : 'pasa';
  };
  const sh = (command, cwd) => r('Bash', { command }, cwd);
  const ps = (command, cwd) => r('PowerShell', { command }, cwd);
  const enc = (s) => Buffer.from(s, 'utf16le').toString('base64');

  // Monitor ejecuta shell y cada linea de su stdout vuelve al modelo.
  check('Monitor: cat de una clave -> deny', r('Monitor', { command: 'tail -f ~/.ssh/id_rsa' }), 'deny/ssh-key');
  check('Monitor: .env -> ask', r('Monitor', { command: 'cat .env' }), 'ask/dotenv');
  check('Monitor: volcado de entorno -> ask', r('Monitor', { command: 'printenv' }), 'ask/env-dump');
  check('Monitor: escribir la pausa -> deny',
    r('Monitor', { command: 'echo {} > ~/.ultron/run/deny-secrets-pausa.json' }), 'deny/pause-file');
  check('Monitor: comando normal pasa', r('Monitor', { command: 'tail -f build.log' }), 'pasa');
  check('Monitor: ws sin command pasa', r('Monitor', { ws: { url: 'ws://localhost:1' } }), 'pasa');

  // -EncodedCommand y otras shells: el contenido era opaco.
  check('-EncodedCommand con una clave -> deny', ps(`powershell -EncodedCommand ${enc('gc ~/.ssh/id_rsa')}`), 'deny/ssh-key');
  check('-enc con .env -> ask', ps(`powershell -enc ${enc('Get-Content .env')}`), 'ask/dotenv');
  check('-encodedc abreviado -> deny', ps(`pwsh -encodedc ${enc('gc ~/.codex/auth.json')}`), 'deny/cli-auth');
  check('-EncodedCommand desde Bash -> deny', sh(`powershell.exe -e ${enc('type id_rsa')}`), 'deny/ssh-key');
  check('-EncodedCommand inocuo pasa', ps(`powershell -EncodedCommand ${enc('Get-Date')}`), 'pasa');
  check('cmd /c set -> ask', sh('cmd /c set'), 'ask/env-dump');
  check('bash -c env -> ask', sh('bash -c env'), 'ask/env-dump');
  check('bash -c printenv VAR -> ask', sh('bash -c "printenv GROQ_API_KEY"'), 'ask/env-dump');
  check('bash -c con comando normal pasa', sh('bash -c "ls src"'), 'pasa');
  check('texto que cita bash -c env pasa', sh('echo "bash -c env"'), 'pasa');

  // printenv con argumento: el nombre va sin `$`.
  check('printenv VAR secreta -> ask', sh('printenv GROQ_API_KEY'), 'ask/env-dump');
  check('printenv -0 VAR secreta -> ask', sh('printenv -0 GITHUB_TOKEN'), 'ask/env-dump');
  check('/usr/bin/printenv VAR secreta -> ask', sh('/usr/bin/printenv GITHUB_TOKEN'), 'ask/env-dump');
  check('sudo printenv VAR secreta -> ask', sh('sudo printenv GITHUB_TOKEN'), 'ask/env-dump');
  check('printenv PATH pasa', sh('printenv PATH'), 'pasa');
  check('printenv HOME USER pasa', sh('printenv HOME USER'), 'pasa');
  check('printenv MAX_TOKENS pasa', sh('printenv MAX_TOKENS'), 'pasa');

  // Lecturas del entorno por otras vias.
  check('node -p process.env.X -> ask', sh('node -p process.env.GROQ_API_KEY'), 'ask/env-dump');
  check('node -e con process.env[X] -> ask', sh(`node -e "console.log(process.env['GITHUB_TOKEN'])"`), 'ask/env-dump');
  check('node -p process.env entero -> ask', sh('node -p process.env'), 'ask/env-dump');
  check('node -e con process.env entero -> ask', sh('node -e "console.log(typeof process.env)"'), 'ask/env-dump');
  check('/proc/self/environ -> ask', sh('cat /proc/self/environ'), 'ask/env-dump');
  check('Get-Content env:X -> ask', ps('Get-Content env:GROQ_API_KEY'), 'ask/env-dump');
  check('node -p process.env.NODE_ENV pasa', sh('node -p process.env.NODE_ENV'), 'pasa');
  check('grep del patron process.env.X pasa', sh('grep -rn process.env.GROQ_API_KEY src'), 'pasa');
  check('un script que usa el entorno pasa', sh('node scripts/x.js'), 'pasa');

  // cd previo y cwd del payload.
  check('cd ~/.codex && cat auth.json -> deny', sh('cd ~/.codex && cat auth.json'), 'deny/cli-auth');
  check('cd .gemini; cat oauth_creds.json -> deny', sh('cd ~/.gemini; cat oauth_creds.json'), 'deny/cli-auth');
  check('cd ~/.aws && cat credentials -> deny', sh('cd ~/.aws && cat credentials'), 'deny/aws-credentials');
  check('cd .config/gh && cat hosts.yml -> deny', sh('cd ~/.config/gh && cat hosts.yml'), 'deny/gh-token');
  check('cd ~/.ssh && cat config -> deny', sh('cd ~/.ssh && cat config'), 'deny/ssh-dir');
  check('Set-Location y gc -> deny', ps('Set-Location $HOME\\.codex; gc auth.json'), 'deny/cli-auth');
  check('cd con ruta de Windows -> deny', ps('cd C:\\Users\\x\\.codex; type auth.json'), 'deny/cli-auth');
  check('cd .codex relativo -> deny', sh('cd .codex && cat auth.json'), 'deny/cli-auth');
  check('cd en dos pasos -> deny', sh('cd ~ && cd .codex && cat auth.json'), 'deny/cli-auth');
  check('cwd del payload en .codex -> deny', sh('cat auth.json', 'C:\\Users\\x\\.codex'), 'deny/cli-auth');
  check('cwd del payload en .aws -> deny', ps('gc credentials', '/home/x/.aws'), 'deny/aws-credentials');
  check('cwd y comodin -> deny', sh('cat *', '/home/x/.codex'), 'deny/cli-auth');
  check('cwd cockpit y *.json -> ask', sh('cat *.json', '/h/.ultron/cockpit'), 'ask/bridge-token');
  // Negativos: el directorio solo cuenta si el fichero esta en el.
  check('cd .codex y volver: auth.json de otro sitio pasa', sh('cd ~/.codex && cd ~/src && cat auth.json'), 'pasa');
  check('cd .codex y salir con .. pasa', sh('cd ~/.codex && cd .. && cat auth.json'), 'pasa');
  check('cd a un proyecto y cat auth.json pasa', sh('cd ~/src/api && cat auth.json'), 'pasa');
  check('cwd normal y cat auth.json pasa', sh('cat auth.json', 'C:\\proyecto'), 'pasa');
  check('cd ~/.gemini && ls -la pasa (solo lista nombres)', sh('cd ~/.gemini && ls -la'), 'pasa');
  check('cd .codex y config.toml pasa', sh('cd ~/.codex && cat config.toml'), 'pasa');
  check('cwd normal y codigo con e.key pasa', sh('node -e "k => k.key"', 'C:\\proyecto'), 'pasa');
  check('cwd cockpit y codigo con e.key pasa', sh('node -e "k => k.key"', '/h/.ultron/cockpit'), 'pasa');

  // Nombres de dotenv que la regla 1 no reconocia.
  check('prod.env por Read -> ask', r('Read', { file_path: 'C:/app/prod.env' }), 'ask/dotenv');
  check('prod.env por cat -> ask', sh('cat prod.env'), 'ask/dotenv');
  check('prod.env con ruta -> ask', sh('cat config/prod.env'), 'ask/dotenv');
  check('prod.env por Get-Content -> ask', ps('Get-Content prod.env'), 'ask/dotenv');
  check('prod.env por grep -> ask', sh('grep KEY prod.env'), 'ask/dotenv');
  check('prod.env por --env-file -> ask', sh('node --env-file=prod.env x.js'), 'ask/dotenv');
  check('prod.env por redireccion -> ask', sh('wc -l < prod.env'), 'ask/dotenv');
  check('.envrc -> ask', r('Read', { file_path: '/app/.envrc' }), 'ask/dotenv');
  check('.env-prod -> ask', sh('cat .env-prod'), 'ask/dotenv');
  check('flujo NTFS .env::$DATA -> ask', r('Read', { file_path: 'C:\\app\\.env::$DATA' }), 'ask/dotenv');
  check('flujo NTFS por PowerShell -> ask', ps('Get-Content C:\\app\\.env::$DATA'), 'ask/dotenv');
  check('.env con punto final -> ask', r('Read', { file_path: 'C:\\app\\.env.' }), 'ask/dotenv');
  check('clave con flujo NTFS -> deny', r('Read', { file_path: 'C:\\k\\server.pem::$DATA' }), 'deny/private-key');
  // Negativos: `process.env` en codigo y plantillas no son el fichero.
  check('import.meta.env suelto pasa', sh('echo import.meta.env'), 'pasa');
  check('$x.env en PowerShell pasa', ps('echo $x.env'), 'pasa');
  check('grep del patron prod.env pasa', sh('grep -rn prod.env src'), 'pasa');
  check('echo prod.env pasa', sh('echo prod.env'), 'pasa');
  check('example.env pasa', r('Read', { file_path: '/app/example.env' }), 'pasa');
  check('.env-example pasa', r('Read', { file_path: '/app/.env-example' }), 'pasa');
  check('environment.ts pasa', r('Read', { file_path: '/app/environment.ts' }), 'pasa');
  check('.environment no es dotenv', r('Read', { file_path: '/app/.environment' }), 'pasa');
  check('C: suelto no revienta', r('Read', { file_path: 'C:' }), 'pasa');

  // Texto citado que no accede a nada (LOW de la auditoria).
  check('commit -m que nombra .env pasa', sh('git commit -m "docs: explica .env y .ssh/id_rsa"'), 'pasa');
  check('commit -am que nombra .env pasa', sh('git commit -am "docs: explica .env"'), 'pasa');
  check('commit con comillas simples pasa', sh("git commit -m 'docs: explica .env'"), 'pasa');
  check('commit con heredoc que nombra .env pasa',
    sh(`git commit -m "$(cat <<'EOF'\ndocs: explica .env\nEOF\n)"`), 'pasa');
  // Negativos: lo que se ejecuta sigue contando.
  check('commit seguido de cat .env -> ask', sh('git commit -m "x" && cat .env'), 'ask/dotenv');
  check('commit con $() que lee .env -> ask', sh('git commit -m "$(cat .env)"'), 'ask/dotenv');
  check('commit con comilla escapada no se quita -> ask',
    ps('git commit -m "a\\" ; cat .env ; echo \\"b"'), 'ask/dotenv');
  check('heredoc que acaba y sigue codigo -> ask',
    sh(`git commit -m "$(cat <<'EOF'\nx\nEOF\ncat .env\n)"`), 'ask/dotenv');
  check('eval de un commit no se quita -> ask', sh('eval git commit -m "x; cat .env"'), 'ask/dotenv');
  check('otro comando con -m -> ask', sh('foo -m "cat .env"'), 'ask/dotenv');

  // Rendimiento: el hook es sincrono en cada llamada a la shell.
  const t0 = Date.now();
  classify('Bash', { command: 'sh -c '.repeat(5000) });
  classify('Bash', { command: 'cd x; '.repeat(5000) });
  classify('Bash', { command: 'git commit -m "x" && '.repeat(2000) });
  classify('Bash', { command: 'echo '.repeat(20000) });
  classify('PowerShell', { command: `powershell -enc ${'A'.repeat(100000)}` });
  const ms = Date.now() - t0;
  check(`lineas patologicas en <2500 ms (medido ${ms} ms)`, ms < 2500, true);
}

// --- Contrato por stdin: el proceso real, lo que ejecuta el motor -----------------
// Un fallo de carga o de una funcion sin definir solo se ve aqui, no importando el
// modulo: el 2026-11-01 una edicion a medias dejo el hook denegando toda llamada.
{
  const hook = join(dirname(fileURLToPath(import.meta.url)), 'deny-secrets.js');
  const stdin = (tool_name, tool_input) => spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input }),
    encoding: 'utf8',
    env: { ...process.env, ULTRON_HOOK_LOGS_DIR: join(tmpdir(), 'deny-secrets-selftest-logs') },
  });
  const decisionDe = (r) => (r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'pasa');
  const read = stdin('Read', { file_path: 'README.md' });
  check('stdin: Read de README.md sale con 0', read.status, 0);
  check('stdin: Read de README.md pasa sin salida', decisionDe(read), 'pasa');
  check('stdin: Bash normal pasa', decisionDe(stdin('Bash', { command: 'git status --short' })), 'pasa');
  check('stdin: Read de .env pide permiso', decisionDe(stdin('Read', { file_path: '.env' })), 'ask');
  check('stdin: Read de una clave se bloquea', decisionDe(stdin('Read', { file_path: 'a/.ssh/id_rsa' })), 'deny');
  check('stdin: Monitor con una clave se bloquea', decisionDe(stdin('Monitor', { command: 'cat a/.ssh/id_rsa' })), 'deny');
}

// --- Paridad con los tipos del motor (auditoria 2026-11-01) --------------------
// El selftest de paridad solo contrastaba las herramientas que ya estaban en la
// lista: `Monitor` nunca aparecia. Se deriva de los tipos y, si no estan (CI, sin
// CLI), de los minimos conocidos.
{
  const { SHELL_TOOLS } = require('./deny-secrets.js');
  const { herramientasShell, herramientasShellDelMotor } = require('./lib/motor-shell-tools.js');
  check('tipos: un `command` en el bloque cuenta como shell',
    herramientasShell('interface BuiltinToolInputs {\n    Foo: {\n      command?: string\n    }\n    Bar: {\n      path: string\n    }\n  }\n').join(), 'Foo');
  for (const tool of herramientasShellDelMotor()) {
    check(`tipos: SHELL_TOOLS incluye ${tool}`, SHELL_TOOLS.has(tool), true);
  }
}

if (failures > 0) {
  console.error(`SELFTEST deny-secrets: ROJO (${failures} fallos)`);
  process.exit(1);
}
console.log('SELFTEST deny-secrets: VERDE');
