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

// --- H27 (auditoria 2026-10-17): marcador en trabajos/<X>/, sesion en la
// asignatura. La busqueda solo subia desde el cwd y nunca veia el marcador,
// que vive por DEBAJO: el bloqueo duro no protegia ninguna carpeta real.
const ASIGNATURA = join(ROOT, 'XYZ-Asignatura');
const TRABAJO = join(ASIGNATURA, 'trabajos', 'T1');
mkdirSync(join(TRABAJO, 'entrega'), { recursive: true });
writeFileSync(join(TRABAJO, '.ultron-trabajo.json'), JSON.stringify({ protegidas: ['borrador', 'entrega'] }), 'utf8');
const SIN_MARCA = join(ASIGNATURA, 'trabajos', 'T2');
mkdirSync(join(SIN_MARCA, 'entrega'), { recursive: true });

const h1 = classify({
  tool_name: 'Write',
  tool_input: { file_path: join(TRABAJO, 'entrega', 'memoria.md') },
  cwd: ASIGNATURA,
});
A(h1 && h1.decision === 'deny', 'H27: Write en trabajos/T1/entrega con cwd en la asignatura -> deny', JSON.stringify(h1));

const h2 = classify({
  tool_name: 'PowerShell',
  tool_input: { command: 'Set-Content x > trabajos\\T1\\entrega\\memoria.md' },
  cwd: ASIGNATURA,
});
A(h2 && h2.decision === 'deny', 'H27: redireccion relativa a trabajos/T1/entrega desde la asignatura -> deny', JSON.stringify(h2));

const h3 = classify({
  tool_name: 'Write',
  tool_input: { file_path: join(TRABAJO, 'notas.md') },
  cwd: ASIGNATURA,
});
A(h3 === null, 'H27: Write fuera de las protegidas del trabajo -> null', JSON.stringify(h3));

const h4 = classify({
  tool_name: 'Write',
  tool_input: { file_path: join(SIN_MARCA, 'entrega', 'memoria.md') },
  cwd: ASIGNATURA,
});
A(h4 && h4.decision === 'warn' && /sin marcador/.test(h4.reason),
  'H27: trabajos/T2/entrega sin marcador -> aviso (no bloquea)', JSON.stringify(h4));

const h5 = classify({
  tool_name: 'Write',
  tool_input: { file_path: join(SIN_MARCA, 'codigo', 'main.cpp') },
  cwd: ASIGNATURA,
});
A(h5 === null, 'H27: trabajos/T2/codigo sin marcador -> null (sin aviso)', JSON.stringify(h5));

// Revision de H27: un destino a mas de MAX_LEVELS por debajo del marcador no
// lo alcanzaba subiendo, caia en el aviso de "sin marcador" y NO se bloqueaba.
const h6 = classify({
  tool_name: 'Write',
  tool_input: { file_path: join(TRABAJO, 'entrega', 'a', 'b', 'c', 'd', 'memoria.md') },
  cwd: ASIGNATURA,
});
A(h6 && h6.decision === 'deny', 'H27: destino profundo en trabajos/T1/entrega -> deny', JSON.stringify(h6));

// --- Auditoria 2026-11-01: 14 de 19 formas de escribir no daban destino -------
{
  const { bashDestCandidates } = require('./uni-deliverable-guard.js');
  const casos = [
    ['Set-Content entrega/x.md -Value hola', 'entrega/x.md'],
    ['Set-Content -Path entrega/x.md -Value otra/cosa.md', 'entrega/x.md'],
    ['Add-Content -LiteralPath "entrega/x y.md" -Value z', 'entrega/x y.md'],
    ['"hola" | Out-File entrega/x.md', 'entrega/x.md'],
    ['"hola" | Out-File -FilePath entrega/x.md', 'entrega/x.md'],
    ['[IO.File]::WriteAllText("entrega/x.md", "a")', 'entrega/x.md'],
    ["[System.IO.File]::AppendAllText('entrega/x.md', 'a')", 'entrega/x.md'],
    ['New-Item entrega/x.md', 'entrega/x.md'],
    ['New-Item -ItemType File -Path entrega/x.md', 'entrega/x.md'],
    ['Remove-Item entrega/x.md', 'entrega/x.md'],
    ['Copy-Item a.md -Destination entrega/x.md', 'entrega/x.md'],
    ["sed -i 's/a/b/' entrega/x.md", 'entrega/x.md'],
    ["sed -i.bak 's/a/b/' entrega/x.md", 'entrega/x.md'],
    ['echo z>entrega/x.md', 'entrega/x.md'],
    ['echo z>>entrega/x.md', 'entrega/x.md'],
    ['echo z 2>entrega/x.md', 'entrega/x.md'],
    ['git mv a.md entrega/x.md', 'entrega/x.md'],
    ['git -C . mv a.md entrega/x.md', 'entrega/x.md'],
    ['git rm entrega/x.md', 'entrega/x.md'],
    ['rm entrega/x.md', 'entrega/x.md'],
    ['rm -f a.md entrega/x.md', 'entrega/x.md'],
    ['cat a.md | tee entrega/x.md', 'entrega/x.md'],
    ['touch entrega/x.md', 'entrega/x.md'],
    ['dd if=a.md of=entrega/x.md', 'entrega/x.md'],
    ['cp -t entrega a.md', 'entrega'],
    ['cp --target-directory=entrega a.md', 'entrega'],
    ['cp a.md entrega/x.md', 'entrega/x.md'],
    ['robocopy src entrega x.md', 'entrega'],
    ['cd entrega && echo z > x.md', 'entrega/x.md'],
    ['cd entrega; rm x.md', 'entrega/x.md'],
    ['bash -c "echo z > entrega/x.md"', 'entrega/x.md'],
    ['cat > entrega/x.md <<EOF\nhola\nEOF', 'entrega/x.md'],
    [`powershell -enc ${Buffer.from('rm entrega/x.md', 'utf16le').toString('base64')}`, 'entrega/x.md'],
  ];
  for (const [cmd, esperado] of casos) {
    const destinos = bashDestCandidates(cmd);
    A(destinos.includes(esperado), `destino de ${JSON.stringify(cmd).slice(0, 60)}`, JSON.stringify(destinos));
  }
  // Negativos: lo que no escribe en la ruta no da destino, y una opcion no es la ruta.
  const sinDestino = [
    'echo "z > entrega/x.md"',
    "grep 'rm entrega/x.md' notas.md",
    'cat entrega/x.md',
    'ls entrega',
    'git status',
    'git commit -m "docs: touch entrega/x.md"',
    "cat <<'EOF' > a.md\nrm entrega/x.md\nEOF",
    'echo z >&2',
    "sed 's/a/b/' entrega/x.md",
  ];
  for (const cmd of sinDestino) {
    const destinos = bashDestCandidates(cmd);
    A(!destinos.some((d) => d.includes('entrega')), `sin destino en ${JSON.stringify(cmd).slice(0, 60)}`, JSON.stringify(destinos));
  }
  const conOtro = bashDestCandidates('Set-Content -Path a.md -Value entrega/x.md');
  A(conOtro.join() === 'a.md', 'el valor de -Value no es un destino', JSON.stringify(conOtro));
  const dosCd = bashDestCandidates('cd a && cd b && rm x.md');
  A(dosCd.join() === 'a/b/x.md', 'dos cd seguidos se acumulan', JSON.stringify(dosCd));
  const absoluta = bashDestCandidates('cd a && rm /tmp/x.md');
  A(absoluta.join() === '/tmp/x.md', 'una ruta absoluta no se une al cd', JSON.stringify(absoluta));

  // De extremo a extremo con marcador: bloquea por PowerShell y por Monitor.
  const ps = classify({ tool_name: 'PowerShell', tool_input: { command: 'Set-Content entrega/x.md -Value hola' }, cwd: PROYECTO });
  A(ps && ps.decision === 'deny', 'PowerShell Set-Content en entrega/ -> deny', JSON.stringify(ps));
  const mon = classify({ tool_name: 'Monitor', tool_input: { command: 'echo z > entrega/x.md' }, cwd: PROYECTO });
  A(mon && mon.decision === 'deny', 'Monitor con redireccion a entrega/ -> deny', JSON.stringify(mon));
  const cd = classify({ tool_name: 'Bash', tool_input: { command: 'cd entrega && echo z > x.md' }, cwd: PROYECTO });
  A(cd && cd.decision === 'deny', 'cd entrega && > x.md -> deny', JSON.stringify(cd));
  const lee = classify({ tool_name: 'PowerShell', tool_input: { command: 'Get-Content entrega/x.md' }, cwd: PROYECTO });
  A(lee === null, 'PowerShell Get-Content de entrega/ -> permite', JSON.stringify(lee));
  const codigo = classify({ tool_name: 'Bash', tool_input: { command: 'rm codigo/main.o' }, cwd: PROYECTO });
  A(codigo === null, 'rm en codigo/ -> permite', JSON.stringify(codigo));
}

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
