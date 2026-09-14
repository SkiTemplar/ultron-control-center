#!/usr/bin/env node
/**
 * uni-deliverable-guard.selftest.mjs — check conductual del bloqueo real de
 * escritura del entregable en modo trabajo universitario (decidido
 * 2026-09-14). Hermetico: directorios temporales reales (findTrabajoMarker
 * usa fs directo, sin override), se borran al final.
 *
 * Uso: node hooks/scripts/uni-deliverable-guard.selftest.mjs   (exit 0 = verde)
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { classify, handle } = require('./uni-deliverable-guard.js');

let fail = 0;
const ok = (n) => console.log(`  [PASS] ${n}`);
const ko = (n, d) => { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); };
const A = (c, n, d) => (c ? ok(n) : ko(n, d));

const ROOT = mkdtempSync(join(tmpdir(), 'ultron-uniguard-'));

function proyecto(nombre, { marker, corruptRaw } = {}) {
  const dir = join(ROOT, nombre);
  mkdirSync(join(dir, 'borrador'), { recursive: true });
  mkdirSync(join(dir, 'entrega'), { recursive: true });
  mkdirSync(join(dir, 'codigo'), { recursive: true });
  if (corruptRaw !== undefined) {
    writeFileSync(join(dir, '.ultron-trabajo.json'), corruptRaw, 'utf8');
  } else if (marker !== null) {
    writeFileSync(
      join(dir, '.ultron-trabajo.json'),
      JSON.stringify(marker || { protegidas: ['borrador', 'entrega'] }, null, 2),
      'utf8',
    );
  }
  return dir;
}

const PROYECTO = proyecto('trabajo-1');
const SIN_MARCADOR = join(ROOT, 'sin-marcador');
mkdirSync(SIN_MARCADOR, { recursive: true });
const CORRUPTO = proyecto('trabajo-corrupto', { corruptRaw: '{ esto no es json' });

// --- classify(): Write bloquea en carpeta protegida ------------------------
const c1 = classify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(PROYECTO, 'borrador', 'x.md') },
  cwd: PROYECTO,
});
A(c1 && c1.decision === 'deny', 'Write en borrador/x.md -> deny', JSON.stringify(c1));

// --- classify(): Write en codigo/ permite -----------------------------------
const c2 = classify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(PROYECTO, 'codigo', 'main.cpp') },
  cwd: PROYECTO,
});
A(c2 === null, 'Write en codigo/ -> permite (null)', JSON.stringify(c2));

// --- classify(): fuera de proyectos con marcador permite --------------------
const c3 = classify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(SIN_MARCADOR, 'entrega', 'x.md') },
  cwd: SIN_MARCADOR,
});
A(c3 === null, 'sin marcador en el arbol -> permite', JSON.stringify(c3));

// --- ULTRON_UNI_GUARD=off desactiva el guard --------------------------------
process.env.ULTRON_UNI_GUARD = 'off';
const c4 = classify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(PROYECTO, 'entrega', 'final.md') },
  cwd: PROYECTO,
});
A(c4 === null, 'ULTRON_UNI_GUARD=off -> permite incluso en carpeta protegida', JSON.stringify(c4));
delete process.env.ULTRON_UNI_GUARD;

// --- traversal: entrega/../entrega/x sigue resolviendo dentro -> bloquea ---
const c5 = classify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(PROYECTO, 'entrega', '..', 'entrega', 'x.md') },
  cwd: PROYECTO,
});
A(c5 && c5.decision === 'deny', 'traversal entrega/../entrega/x -> bloquea (resuelto)', JSON.stringify(c5));

// --- marcador corrupto: permite pero avisa ----------------------------------
const c6 = classify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Write',
  tool_input: { file_path: join(CORRUPTO, 'entrega', 'x.md') },
  cwd: CORRUPTO,
});
A(c6 && c6.decision === 'warn', 'marcador corrupto -> NO bloquea, avisa (warn)', JSON.stringify(c6));

// --- Bash con redireccion a carpeta protegida -------------------------------
const c7 = classify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: `echo "hola" > ${join(PROYECTO, 'entrega', 'final.md')}` },
  cwd: PROYECTO,
});
A(c7 && c7.decision === 'deny', 'Bash `> entrega/final.md` -> deny', JSON.stringify(c7));

// --- Bash sin destino protegido permite -------------------------------------
const c8 = classify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'git status' },
  cwd: PROYECTO,
});
A(c8 === null, 'Bash sin ruta de escritura -> permite', JSON.stringify(c8));

// --- handle(): contrato JSON completo (deny) --------------------------------
const outDeny = handle(JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: join(PROYECTO, 'entrega', 'x.md') },
  cwd: PROYECTO,
}));
const jsonDeny = JSON.parse(outDeny);
A(
  jsonDeny.hookSpecificOutput.permissionDecision === 'deny',
  'handle(): Edit en entrega/ -> permissionDecision deny',
  outDeny,
);
A(
  jsonDeny.hookSpecificOutput.hookEventName === 'PreToolUse',
  'handle(): hookEventName correcto',
  outDeny,
);
A(
  jsonDeny.systemMessage.includes('BLOQUEADO'),
  'handle(): systemMessage anuncia el bloqueo',
  jsonDeny.systemMessage,
);

// --- handle(): tool no cubierta (Read) -> null ------------------------------
const outRead = handle(JSON.stringify({
  hook_event_name: 'PreToolUse',
  tool_name: 'Read',
  tool_input: { file_path: join(PROYECTO, 'entrega', 'x.md') },
  cwd: PROYECTO,
}));
A(outRead === null, 'handle(): Read no esta cubierta por el guard -> null', String(outRead));

// --- handle(): evento distinto de PreToolUse -> null ------------------------
const outOtro = handle(JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} }));
A(outOtro === null, 'handle(): evento != PreToolUse -> null', String(outOtro));

// --- handle(): JSON invalido en stdin -> null (nunca revienta) -------------
const outMalo = handle('{ esto no es json');
A(outMalo === null, 'handle(): stdin no-JSON -> null sin excepcion', String(outMalo));

// --- rendimiento: sin marcador en el camino, coste minimo -------------------
const t0 = Date.now();
for (let i = 0; i < 200; i++) {
  classify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_input: { file_path: join(SIN_MARCADOR, `f${i}.md`) },
    cwd: SIN_MARCADOR,
  });
}
const elapsedPerCall = (Date.now() - t0) / 200;
A(elapsedPerCall < 30, `rendimiento: <30ms/llamada sin marcador (medido ${elapsedPerCall.toFixed(2)}ms)`, String(elapsedPerCall));

rmSync(ROOT, { recursive: true, force: true });
console.log(fail === 0 ? '\nSELFTEST uni-deliverable-guard: VERDE' : `\nSELFTEST uni-deliverable-guard: ROJO (${fail} fallo/s)`);
process.exit(fail === 0 ? 0 : 1);
