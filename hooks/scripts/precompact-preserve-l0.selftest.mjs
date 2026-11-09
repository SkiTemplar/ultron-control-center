/**
 * Selftest de precompact-preserve-l0.js (hooks-4 y hooks-11, 2026-10-23).
 *
 * Extremo a extremo con HOME, %TEMP% y directorio L0 temporales:
 *   - con hechos en el transcript, el scratch se escribe en el fichero de la
 *     sesion y NO en la antigua ruta global ~/.ultron/.tmp/context.md;
 *   - sin hechos no se escribe nada;
 *   - borra el marcador del protocolo socratico de la sesion, y el primer
 *     prompt tras compactar vuelve a llevar el protocolo completo;
 *   - el resume solo inyecta el scratch en el SessionStart source=compact.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(here, 'precompact-preserve-l0.js');
const GATE = path.join(here, 'socratic-gate.js');

let fallos = 0;
function comprueba(nombre, real, esperado) {
  if (real === esperado) console.log(`ok     ${nombre}`);
  else {
    fallos++;
    console.error(`FALLO  ${nombre}\n       esperado=${esperado} real=${real}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'precompact-selftest-'));
const home = path.join(root, 'home');
const temp = path.join(root, 'temp');
const l0 = path.join(root, 'l0');
const proyecto = path.join(root, 'proyecto');
for (const d of [home, temp, l0, proyecto]) fs.mkdirSync(d, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  ULTRON_L0_DIR: l0,
  ULTRON_HOOK_LOGS_DIR: path.join(root, 'logs'),
  SOCRATIC_PROJECTS_OVERRIDE: path.join(root, 'projects-inexistente.json'),
};
const SID = 'abcd-1234-sesion';

function transcript(nombre, textos) {
  const p = path.join(root, nombre);
  const lineas = textos.map(([type, text]) => JSON.stringify({ type, message: { content: [{ type: 'text', text }] } }));
  fs.writeFileSync(p, lineas.join('\n') + '\n');
  return p;
}

function precompact(transcriptPath) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: SID, transcript_path: transcriptPath, cwd: proyecto, trigger: 'auto' }),
    env,
    encoding: 'utf8',
  });
}

function gate(prompt) {
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ session_id: SID, prompt, cwd: proyecto }),
    env,
    encoding: 'utf8',
  });
  const out = (r.stdout || '').trim();
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : '';
}

try {
  // --- scratch por sesion --------------------------------------------------
  const conHechos = transcript('con-hechos.jsonl', [
    ['user', 'Decidimos usar SQLite para la cola.'],
    ['assistant', 'Pendiente: migrar el lector antiguo.'],
  ]);
  const r1 = precompact(conHechos);
  comprueba('sale con 0', r1.status, 0);
  const fichero = path.join(l0, `${SID}.md`);
  comprueba('escribe el scratch de la sesion', fs.existsSync(fichero), true);
  comprueba('el scratch lleva los hechos', fs.readFileSync(fichero, 'utf8').includes('Decidimos usar SQLite'), true);
  comprueba('no escribe la ruta global antigua', fs.existsSync(path.join(home, '.ultron', '.tmp', 'context.md')), false);

  const sinHechos = transcript('sin-hechos.jsonl', [['user', 'hola'], ['assistant', 'buenas']]);
  precompact(sinHechos);
  comprueba('sin hechos no queda scratch', fs.existsSync(fichero), false);

  // --- orden: se conserva lo ultimo, no lo mas antiguo (auditoria 2026-11-01) ---
  const largos = Array.from({ length: 60 }, (_, i) => ['user', `pendiente numero ${i + 1} del trabajo`]);
  precompact(transcript('largo.jsonl', largos));
  const largo = fs.readFileSync(fichero, 'utf8');
  comprueba('conserva el ultimo turno', largo.includes('pendiente numero 60 del'), true);
  comprueba('conserva 12 hechos, del 49 al 60', largo.includes('pendiente numero 49 del'), true);
  comprueba('descarta los mas antiguos', largo.includes('pendiente numero 1 del'), false);
  comprueba('descarta el 48', largo.includes('pendiente numero 48 del'), false);
  comprueba('van en orden de lectura', largo.indexOf('numero 49 del') < largo.indexOf('numero 60 del'), true);

  // --- resume: solo tras compactar ----------------------------------------
  precompact(conHechos);
  process.env.ULTRON_L0_DIR = l0;
  const { readL0Scratch } = await import('./lib/l0-scratch.js').then((m) => m.default || m);
  comprueba('el resume lo inyecta en source=compact', readL0Scratch(null, { sessionId: SID, source: 'compact' }).includes('SQLite'), true);
  comprueba('el resume no lo inyecta en startup', readL0Scratch(null, { sessionId: SID, source: 'startup' }), '');
  const etiqueta = readL0Scratch(null, { sessionId: SID, source: 'compact' });
  comprueba('texto de los turnos: no confiable', etiqueta.includes('trust="untrusted"'), true);
  comprueba('texto de los turnos: nunca como sistema', etiqueta.includes('trust="system"'), false);

  // --- protocolo socratico tras /compact ------------------------------------
  const primero = gate('Vamos a ver el modulo de colas');
  comprueba('primer prompt: protocolo completo', primero.includes('Protocolo activo'), true);
  const segundo = gate('Lee el README y resume la seccion de instalacion');
  comprueba('segundo prompt sin decision: nada', segundo, '');
  precompact(conHechos);
  comprueba('PreCompact borra el marcador socratico', fs.existsSync(path.join(temp, `ultron-socratic-${SID}`)), false);
  const tras = gate('Lee el README y resume la seccion de instalacion');
  comprueba('primer prompt tras compactar: protocolo completo otra vez', tras.includes('Protocolo activo'), true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(fallos ? `\n${fallos} FALLOS` : '\nTodo verde');
process.exit(fallos ? 1 : 0);
