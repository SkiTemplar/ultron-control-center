#!/usr/bin/env node
// deny-secrets-rutas-volcados.selftest.mjs: rutas sin normalizar, `cd` tras un abridor de
// bloque, volcados de entorno y coste acotado (revision final 2026-11-02). Sale de
// deny-secrets.selftest.mjs por el limite de 800 lineas. Hermetico: la pausa real del
// usuario no cambia el resultado y no toca HOME ni la red.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
process.env.ULTRON_DENY_SECRETS_PAUSA = join(tmpdir(), 'deny-secrets-pausa-inexistente.json');
const { classify, decisionFor, ruleIdFor, handle } = require('./deny-secrets.js');

let failures = 0;
function check(name, actual, expected) {
  if (actual === expected) {
    console.log(`ok   ${name}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// --- Revision final 2026-11-02, H1: rutas sin normalizar y `cd` tras un opener ----
{
  const CLI = 'CLI auth token file';
  for (const p of ['C:/Users/R/.codex/./auth.json', String.raw`.gemini\x\..\oauth_creds.json`, '.codex/auth.json/.', '.codex./auth.json']) {
    check(`ruta sin normalizar: ${p}`, classify('Read', { file_path: p }), CLI);
  }
  check('ruta sin normalizar: gh', classify('Read', { file_path: '~/.config/gh/./hosts.yml' }), 'GitHub CLI token file');
  for (const c of [
    'cat ~/.codex/./auth.json',
    'cat ~/.gemini/./oauth_creds.json',
    'cd ~/.codex && cat ./auth.json',
    '(cd ~/.codex && cat auth.json)',
    '{ cd ~/.codex; cat auth.json; }',
    'if cd ~/.codex; then cat auth.json; fi',
    'cd ~/.codex & cat auth.json',
    'cd ~/.codex >/dev/null && cat auth.json',
    'cd ~/.codex || exit; cat auth.json',
    'cd ~/.codex && < auth.json cat',
    'x=$(cd ~/.codex && cat auth.json)',
    'pushd ~/.codex; cat auth.json',
  ]) {
    check(`cd/normalizacion: ${c}`, decisionFor(classify('Bash', { command: c })) === 'deny' && Boolean(classify('Bash', { command: c })), true);
  }
  // Caso negativo: normalizar y seguir el `cd` no marcan lo corriente.
  for (const p of ['a/./b.txt', '.codex/../README.md', 'src/../auth.json', './auth.json']) {
    check(`ruta corriente: ${p}`, classify('Read', { file_path: p }), null);
  }
  for (const c of [
    '(cd src && cat auth.json)',
    'cd .codex/.. && cat auth.json',
    '(cd control-center && npm run build) && git status',
    'cd src-tauri && cargo test 2>&1 | tail -5',
    'if cd build; then make; fi',
  ]) {
    check(`cd corriente: ${c}`, classify('Bash', { command: c }), null);
  }
}

// --- Revision final 2026-11-02, H2: volcados de entorno ---------------------------
{
  const dump = 'command reads an environment secret dump';
  for (const c of [
    'echo $ULTRON_KEY_ANTHROPIC_CREDITS',
    'echo ${ULTRON_KEY_ANTHROPIC_CREDITS}',
    'printenv ULTRON_KEY_ANTHROPIC_CREDITS',
    String.raw`reg query HKCU\\Environment`,
    String.raw`reg query HKCU\Environment`,
    'reg query HKCU/Environment',
    String.raw`reg query "HKCU\Environment"`,
    String.raw`reg query HKCU\"Environment"`,
    String.raw`reg export HKCU\Environment x.txt`,
    String.raw`reg save HKCU\Environment x.hiv`,
    'reg query HKCU /s',
    'export',
    'export -p',
    'export | grep KEY',
    'export > e.txt',
    'declare',
    'declare -x',
    'declare -p GROQ_API_KEY',
    'typeset -x',
    'SET',
    'set | sort',
    'set GROQ_API_KEY',
    'e"xpo"rt',
    '(export)',
    '{ export; }',
    'git status && export',
    'cd /tmp & env',
    'echo "$(env)"',
    'bash -c export',
    'cmd /c set',
    'Get-CimInstance Win32_Environment',
    'bash <<EOF\nexport\nEOF',
  ]) {
    check(`volcado: ${c}`, classify('Bash', { command: c }), dump);
    check(`volcado pide permiso: ${c}`, decisionFor(classify('Bash', { command: c })), 'ask');
  }
  // Caso negativo: asignar o consultar sin valores no es volcar.
  for (const c of [
    'export FOO=1',
    'export FOO',
    'export PATH="$PATH:/x" && cargo test',
    'export -n FOO',
    'declare -x FOO=1',
    'declare -f foo',
    'declare -p FOO',
    'typeset -x FOO=1',
    'set -e',
    'set -euo pipefail',
    'env FOO=1 cargo test',
    'echo "environment"',
    String.raw`reg query HKCU\Software\X`,
    'grep -n export src/a.ts',
    '[ -n "$ULTRON_KEY_X" ] && echo ok',
    'for pat in a b; do grep "$pat" f; done',
    '$token = 3',
    // Formas medidas en transcripts reales: texto citado y codigo, no comandos.
    'grep -hE "foo|bar|export)" a.txt',
    String.raw`node -e "if (a && !env) throw 1"`,
    'cat > a.mjs <<\'EOF\'\nif (a && !env) x();\nEOF',
    'echo "a; export"',
    'cat > a.cpp <<\'EOF\'\nx = "set";\nexport\nEOF',
  ]) {
    check(`no es volcado: ${c}`, classify('Bash', { command: c }), null);
  }
  check('una variable secreta en mayusculas sigue contando', classify('Bash', { command: 'echo $TOKEN' }), dump);
}

// --- Revision final 2026-11-02, M1: coste acotado y fallo hacia pedir permiso ------
{
  const big = 'x'.repeat(64 * 1024 + 1);
  const TOO_LARGE = 'input too large to classify';
  check('comando enorme: no se clasifica', classify('Bash', { command: big }), TOO_LARGE);
  check('comando enorme: pide permiso', decisionFor(TOO_LARGE), 'ask');
  check('comando enorme: regla con nombre', ruleIdFor(TOO_LARGE), 'input-too-large');
  check('comando enorme: relleno delante de una clave no pasa', classify('Bash', { command: `cat ~/.codex/auth.json # ${big}` }), TOO_LARGE);
  check('ruta enorme', classify('Read', { file_path: big }), TOO_LARGE);
  check('glob enorme', classify('Grep', { pattern: 'x', glob: big }), TOO_LARGE);
  // Caso negativo: el contenido de un Write no es un campo clasificado.
  check('Write con mucho contenido pasa', classify('Write', { file_path: 'a.txt', content: big }), null);
  check('comando en el tope se clasifica', classify('Bash', { command: 'y'.repeat(64 * 1024) }), null);
  // Llaves: el recorte no puede dejar sin mirar la alternativa de detras.
  const alts = Array.from({ length: 100 }, (_, i) => `a${i}`).join(',');
  check('glob con mas alternativas que el tope', classify('Grep', { pattern: 'x', glob: `{${alts},.env}` }), TOO_LARGE);
  check('glob pequeno con .env', classify('Grep', { pattern: 'x', glob: '{a,.env}' }), 'dotenv credential file');
  check('glob pequeno sin secreto', classify('Grep', { pattern: 'x', glob: '*.{ts,tsx}' }), null);
  const t0 = Date.now();
  classify('Bash', { command: '`'.repeat(64 * 1024) });
  classify('Grep', { pattern: 'x', glob: '{a,b}'.repeat(26) });
  const ms = Date.now() - t0;
  check(`acentos y llaves patologicos en <1500 ms (medido ${ms} ms)`, ms < 1500, true);
  // La pausa es para los 'ask' clasificados, no para lo que no se ha podido mirar.
  const dir = mkdtempSync(join(tmpdir(), 'deny-secrets-pausa-'));
  const previa = process.env.ULTRON_DENY_SECRETS_PAUSA;
  process.env.ULTRON_DENY_SECRETS_PAUSA = join(dir, 'pausa.json');
  writeFileSync(process.env.ULTRON_DENY_SECRETS_PAUSA, JSON.stringify({ hasta: new Date(Date.now() + 3600e3).toISOString() }));
  const payload = (tool_input) => JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input });
  check('con pausa, .env pasa', handle(payload({ file_path: '.env' })), null);
  check('con pausa, lo enorme sigue preguntando', JSON.parse(handle(payload({ file_path: big }))).hookSpecificOutput.permissionDecision, 'ask');
  process.env.ULTRON_DENY_SECRETS_PAUSA = previa;
  rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`SELFTEST deny-secrets-rutas-volcados: ROJO (${failures} fallos)`);
  process.exit(1);
}
console.log('SELFTEST deny-secrets-rutas-volcados: VERDE');
