#!/usr/bin/env node
/**
 * regen-manifest.selftest.mjs — fija el contrato de hooks/regen-manifest.js.
 *
 * Hermetico: no lee ~/.claude/settings.json, no escribe manifest.json, no
 * toca el disco salvo por el `exists` inyectado. Solo ejercita las funciones
 * puras del modulo (por eso regen-manifest.js solo llama a main() bajo
 * `require.main === module`).
 *
 * Cubre las dos cosas que se arreglaron el 2026-09-22:
 *   1. la forma EXEC de una entrada de hook ({command:"node", args:[ruta]}),
 *      que antes colapsaba los 20 hooks al id "node" y se llevaba por delante
 *      script, checksum y metadatos de todos de golpe;
 *   2. la puerta de paridad plantilla <-> manifest que corre en CI, con su
 *      caso NEGATIVO obligatorio (mandamiento 7): cada clase de drift que
 *      debe detectar se prueba provocandola.
 *
 * Uso: node hooks/regen-manifest.selftest.mjs   (exit 0 = verde)
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { scriptPathOf, idOf, flattenHooks, templateScriptRel, templateParityProblems } =
  require('./regen-manifest.js');

let fallos = 0;
function check(nombre, real, esperado) {
  const ok = JSON.stringify(real) === JSON.stringify(esperado);
  if (ok) console.log(`ok   ${nombre}`);
  else {
    fallos += 1;
    console.error(`FAIL ${nombre}: esperado ${JSON.stringify(esperado)}, real ${JSON.stringify(real)}`);
  }
}

// --- forma shell (la de siempre) -------------------------------------------
check(
  'shell: node <ruta windows>',
  scriptPathOf('node C:/Users/x/.ultron/hooks/scripts/deny-secrets.js'),
  'C:/Users/x/.ultron/hooks/scripts/deny-secrets.js',
);
check(
  'shell: uv run python <ruta>',
  scriptPathOf('uv run python /home/x/.ultron/scripts/cockpit/agg.py aggregate --today'),
  '/home/x/.ultron/scripts/cockpit/agg.py',
);
check(
  'shell: powershell -File <ruta>',
  scriptPathOf('powershell -ExecutionPolicy Bypass -File C:/x/instalar.ps1'),
  'C:/x/instalar.ps1',
);
check(
  'shell: token {USERPROFILE} de la plantilla',
  scriptPathOf('node {USERPROFILE}/.ultron/hooks/scripts/memory-orchestrate.js'),
  '{USERPROFILE}/.ultron/hooks/scripts/memory-orchestrate.js',
);

// --- forma exec (lo que faltaba) -------------------------------------------
// Con esta forma `command` es solo "node": sin leer args[0] los 20 hooks
// colapsan al mismo id y el manifest pierde todos sus metadatos a la vez.
check(
  'exec: la ruta esta en args[0]',
  scriptPathOf('node', ['C:/Users/x/.ultron/hooks/scripts/deny-secrets.js']),
  'C:/Users/x/.ultron/hooks/scripts/deny-secrets.js',
);
check(
  'exec: args[0] no es la ruta (uv run python X)',
  scriptPathOf('uv', ['run', 'python', '/home/x/.ultron/scripts/cockpit/agg.py', 'aggregate']),
  '/home/x/.ultron/scripts/cockpit/agg.py',
);
check(
  'exec: id sale del basename, no de "node"',
  idOf(scriptPathOf('node', ['C:/x/hooks/scripts/deny-secrets.js']), 'node', [
    'C:/x/hooks/scripts/deny-secrets.js',
  ]),
  'deny-secrets',
);
// Caso NEGATIVO: sin ruta reconocible no se inventa una — el id degrada al
// comando completo (incluidos los args) y no a "node" a secas, que es lo que
// hacia que entradas distintas se pisaran entre si en el manifest.
check('exec: sin ruta -> null', scriptPathOf('node', ['--version']), null);
check('exec: id degradado lleva los args', idOf(null, 'node', ['--version']), 'node-version');
check('shell: comando sin script -> null', scriptPathOf('echo hola'), null);

// --- aplanado ---------------------------------------------------------------
const plantillaOk = {
  hooks: {
    SessionStart: [
      {
        matcher: 'startup|resume',
        hooks: [
          { type: 'command', command: 'node {USERPROFILE}/.ultron/hooks/scripts/a.js', timeout: 10 },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          { type: 'command', command: 'node', args: ['{USERPROFILE}/.ultron/hooks/scripts/b.js'], timeout: 5, async: true },
        ],
      },
    ],
  },
};
const plano = flattenHooks(plantillaOk.hooks);
check('flatten: dos entradas', plano.length, 2);
check('flatten: matcher por defecto es *', plano[1].matcher, '*');
check('flatten: async se lee', [plano[0].async, plano[1].async], [false, true]);
check('flatten: la forma exec tambien resuelve id', plano[1].id, 'b');
// Una clave que no es un evento (una nota en el fichero) no puede romper el
// aplanado ni colarse como hook.
check('flatten: una nota suelta se ignora', flattenHooks({ _nota: 'texto', Stop: [] }).length, 0);

// --- ruta relativa al repo --------------------------------------------------
check(
  'rel: .ultron',
  templateScriptRel('{USERPROFILE}/.ultron/hooks/scripts/a.js'),
  'hooks/scripts/a.js',
);
check(
  'rel: .maria (nombre nuevo de la raiz)',
  templateScriptRel('{USERPROFILE}/.maria/hooks/scripts/a.js'),
  'hooks/scripts/a.js',
);
check('rel: fuera del repo -> null', templateScriptRel('/usr/bin/algo.js'), null);
check('rel: sin script -> null', templateScriptRel(null), null);

// --- puerta de paridad ------------------------------------------------------
const manifiestoOk = {
  hooks: [
    { id: 'a', event: 'SessionStart', matcher: 'startup|resume', timeout_s: 10, async: false },
    { id: 'b', event: 'Stop', matcher: '*', timeout_s: 5, async: true },
    // Entrada de mas: el manifest es un SUPERCONJUNTO (guarda tambien hooks de
    // la maquina del mantenedor que la plantilla no instala). No es drift.
    { id: 'solo-en-el-manifiesto', event: 'Stop', matcher: '*', timeout_s: 9, async: true },
  ],
};
const existeTodo = () => true;
check(
  'paridad: plantilla y manifest coherentes -> sin problemas',
  templateParityProblems(plantillaOk, manifiestoOk, '/repo', existeTodo),
  [],
);

// Caso NEGATIVO 1: el hook no esta en el manifest.
const sinEntrada = { hooks: manifiestoOk.hooks.filter((h) => h.id !== 'b') };
const p1 = templateParityProblems(plantillaOk, sinEntrada, '/repo', existeTodo);
check('paridad NEG: falta en el manifest -> 1 problema', p1.length, 1);
check('paridad NEG: el problema nombra la clave', p1[0].includes('Stop|*|b'), true);

// Caso NEGATIVO 2: timeout distinto (el sintoma real que se corrigio hoy:
// memory-orchestrate instalado con 12 s mientras el hook presupuesta 20).
const otroTimeout = {
  hooks: manifiestoOk.hooks.map((h) => (h.id === 'a' ? { ...h, timeout_s: 12 } : h)),
};
const p2 = templateParityProblems(plantillaOk, otroTimeout, '/repo', existeTodo);
check('paridad NEG: timeout distinto -> 1 problema', p2.length, 1);
check('paridad NEG: el problema dice los dos valores', p2[0].includes('plantilla=10 manifest=12'), true);

// Caso NEGATIVO 3: async distinto. Es el peor de los tres: async=true descarta
// el stdout, asi que un hook que habla al modelo se vuelve un no-op silencioso.
const otroAsync = {
  hooks: manifiestoOk.hooks.map((h) => (h.id === 'b' ? { ...h, async: false } : h)),
};
const p3 = templateParityProblems(plantillaOk, otroAsync, '/repo', existeTodo);
check('paridad NEG: async distinto -> 1 problema', p3.length, 1);
check('paridad NEG: el problema dice async', p3[0].includes('async'), true);

// Caso NEGATIVO 4: el script referenciado no existe en el repo.
const p4 = templateParityProblems(plantillaOk, manifiestoOk, '/repo', () => false);
check('paridad NEG: script ausente -> 2 problemas', p4.length, 2);
check('paridad NEG: dice que no existe', p4[0].includes('no existe en el repo'), true);

// Caso NEGATIVO 5: la plantilla apunta fuera del repo.
const fuera = {
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'node /opt/otro/x.js', timeout: 5, async: true }] }],
  },
};
const p5 = templateParityProblems(
  fuera,
  { hooks: [{ id: 'x', event: 'Stop', matcher: '*', timeout_s: 5, async: true }] },
  '/repo',
  existeTodo,
);
check('paridad NEG: script fuera del repo -> 1 problema', p5.length, 1);
check('paridad NEG: lo dice claro', p5[0].includes('dentro del repo'), true);

if (fallos > 0) {
  console.error(`SELFTEST regen-manifest: ROJO (${fallos} fallos)`);
  process.exit(1);
}
console.log('SELFTEST regen-manifest: VERDE');
