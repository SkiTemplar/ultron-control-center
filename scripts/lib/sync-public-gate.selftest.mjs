#!/usr/bin/env node
// Selftest del gate PII de sync-public: el escaner analiza los ficheros nuevos
// (H31), no se publica sin patrones personales de email y handle (H32), los
// binarios sin analizar se detectan y el commit del espejo no lleva el email
// personal.
// Ejecutar: node scripts/lib/sync-public-gate.selftest.mjs
//
// Los datos "personales" de las pruebas son ficticios y la ruta de usuario se
// monta en tiempo de ejecucion: este fichero viaja al espejo y el propio gate lo
// analiza.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EXT_BINARIAS,
  PARTES_SIN_ANALIZAR,
  SCRIPT_GATE,
  binariosSinAnalizar,
  borrarVerificado,
  ejecutarGatePii,
  emailDelEspejo,
  existeRuta,
  interpretarSalidaGate,
  leerPatronesPii,
  mensajeDelEspejo,
  parsearNameStatusZ,
  validarPatronesPii,
} from './sync-public-gate.mjs';

const RAIZ = path.resolve(import.meta.dirname, '..', '..');
const ESCANER = path.join(RAIZ, SCRIPT_GATE);
const EMAIL_FICTICIO = 'persona.ficticia@ejemplo.test';
const HANDLE_FICTICIO = 'handleficticio';
const TOKENS = [EMAIL_FICTICIO, HANDLE_FICTICIO];
const RUTA_PERSONAL = 'C:/Users/' + 'Rod' + 'rigo' + '/notas.txt';

let asserts = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  asserts++;
};
const igual = (a, b, msg) => {
  assert.deepStrictEqual(a, b, msg);
  asserts++;
};
const lanza = (fn, re, msg) => {
  assert.throws(fn, re, msg);
  asserts++;
};

// --- validarPatronesPii (H32: fail-closed sin email ni handle) ---------------
ok(validarPatronesPii([]).length > 0, 'sin patrones => no se publica');
ok(validarPatronesPii(undefined).length > 0, 'undefined => no se publica');
ok(validarPatronesPii([EMAIL_FICTICIO]).some((p) => p.includes('handle')), 'solo email => falta el handle');
ok(validarPatronesPii([HANDLE_FICTICIO]).some((p) => p.includes('email')), 'solo handle => falta el email');
ok(validarPatronesPii([EMAIL_FICTICIO, 'ab']).some((p) => p.includes('corto')), 'patron de 2 caracteres => rechazado');
ok(validarPatronesPii([EMAIL_FICTICIO, 'a,b,c']).some((p) => p.includes('coma')), 'patron con coma => rechazado');
igual(validarPatronesPii(TOKENS), [], 'email + handle => validos');

// --- leerPatronesPii: variable + fichero local, sin duplicados ---------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-public-gate-'));
try {
  const fichero = path.join(tmp, '.publicpii');
  fs.writeFileSync(fichero, `# comentario\n${HANDLE_FICTICIO}\r\n\n${EMAIL_FICTICIO}\n`);
  const ambos = leerPatronesPii({ env: { ULTRON_PII_EXTRA: ` ${EMAIL_FICTICIO} ,` }, fichero });
  igual(ambos.tokens, [EMAIL_FICTICIO, HANDLE_FICTICIO], 'union de variable y fichero, sin duplicar ni comentarios');
  igual(ambos.origenes.length, 2, 'se informan los dos origenes');
  const nada = leerPatronesPii({ env: {}, fichero: path.join(tmp, 'no-existe') });
  igual(nada.tokens, [], 'sin variable ni fichero => sin patrones');
  ok(validarPatronesPii(nada.tokens).length > 0, 'y entonces el gate no publica');

  // --- interpretarSalidaGate ------------------------------------------------
  igual(
    interpretarSalidaGate('[audit-personal-data] scope=head HIGH=2 MEDIUM=1 FILES=9 UNREAD=0 EXTRA=2'),
    { high: 2, medium: 1, ficheros: 9, ilegibles: 0, extra: 2 },
    'resumen completo',
  );
  igual(
    interpretarSalidaGate('[audit-personal-data] scope=head HIGH=0 MEDIUM=0'),
    null,
    'escaner antiguo sin FILES/UNREAD/EXTRA => sin veredicto',
  );
  igual(interpretarSalidaGate(''), null, 'salida vacia => sin veredicto');

  // --- binariosSinAnalizar --------------------------------------------------
  igual(
    binariosSinAnalizar([
      ['A', 'docs/web/captura.PNG'],
      ['M', 'docs/manual.pdf'],
      ['R100', 'viejo.txt', 'img/nuevo.webp'],
      ['D', 'borrado.png'],
      ['A', 'docs/texto.md'],
    ]),
    ['docs/web/captura.PNG', 'docs/manual.pdf', 'img/nuevo.webp'],
    'altas, modificados y renombrados binarios; las bajas y el texto no',
  );
  igual(binariosSinAnalizar([]), [], 'sin cambios => sin binarios');
  igual(
    binariosSinAnalizar([
      ['A', 'docs/build/notas.md'],
      ['M', 'web/DIST/index.html'],
      ['A', 'src/builder.md'],
      ['A', 'scripts/backup/copia.mjs'],
    ]),
    ['docs/build/notas.md', 'web/DIST/index.html'],
    'rutas bajo directorios que el escaner salta => sin analizar; nombres parecidos no',
  );

  // --- parsearNameStatusZ ---------------------------------------------------
  igual(
    parsearNameStatusZ('A\0a.txt\0R087\0viejo.txt\0nuevo.png\0M\0captúra.md\0'),
    [['A', 'a.txt'], ['R087', 'viejo.txt', 'nuevo.png'], ['M', 'captúra.md']],
    'altas, renombrados con origen y destino, rutas no ASCII sin citar',
  );
  igual(parsearNameStatusZ(''), [], 'sin cambios => sin filas');
  lanza(() => parsearNameStatusZ('R100\0viejo.txt\0'), /ilegible/, 'renombrado truncado => error');
  lanza(() => parsearNameStatusZ('A\0'), /ilegible/, 'alta sin ruta => error');

  // La lista de binarios debe ser la misma que la del escaner.
  const fuente = fs.readFileSync(ESCANER, 'utf8');
  const bloque = fuente.match(/BINARY_EXT\s*=\s*\{([\s\S]*?)\}/);
  ok(bloque, 'BINARY_EXT localizado en el escaner');
  const extPython = [...bloque[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  igual([...EXT_BINARIAS].sort(), extPython, 'EXT_BINARIAS == BINARY_EXT de audit_personal_data.py');
  const bloqueSkip = fuente.match(/SKIP_PATH_PARTS\s*=\s*\{([\s\S]*?)\}/);
  ok(bloqueSkip, 'SKIP_PATH_PARTS localizado en el escaner');
  const partesPython = [...bloqueSkip[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  igual([...PARTES_SIN_ANALIZAR].sort(), partesPython, 'PARTES_SIN_ANALIZAR == SKIP_PATH_PARTS de audit_personal_data.py');

  // --- borrarVerificado: rutas no ASCII --------------------------------------
  // En Node 24 sobre Windows, fs.rmSync de estas rutas no borra y no avisa.
  const conTilde = path.join(tmp, 'borrado', 'auditoría.md');
  fs.mkdirSync(path.dirname(conTilde), { recursive: true });
  fs.writeFileSync(conTilde, 'x\n');
  borrarVerificado(conTilde);
  ok(!existeRuta(conTilde), 'fichero con nombre no ASCII => borrado');
  const dirTilde = path.join(tmp, 'dír');
  fs.mkdirSync(path.join(dirTilde, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(dirTilde, 'sub', 'ñ.txt'), 'x\n');
  borrarVerificado(dirTilde);
  ok(!existeRuta(dirTilde), 'directorio con nombre no ASCII => borrado entero');
  borrarVerificado(path.join(tmp, 'no-existe'));
  ok(!existeRuta(path.join(tmp, 'no-existe')), 'ruta inexistente => sin error');

  // --- emailDelEspejo -------------------------------------------------------
  ok(emailDelEspejo({ emailRepo: EMAIL_FICTICIO, tokens: TOKENS }).error, 'email personal del repo => error');
  ok(emailDelEspejo({ emailRepo: 'otro@ejemplo.test', tokens: TOKENS }).error, 'email no noreply sin configurar => error');
  ok(emailDelEspejo({ emailPublico: EMAIL_FICTICIO.toUpperCase(), tokens: TOKENS }).error, 'email publico == personal => error');
  ok(emailDelEspejo({ tokens: TOKENS }).error, 'sin email => error');
  const noreply = `123+${HANDLE_FICTICIO}@users.noreply.github.com`;
  igual(emailDelEspejo({ emailRepo: noreply, tokens: TOKENS }), { email: noreply }, 'noreply del repo => valido');
  igual(
    emailDelEspejo({ emailPublico: noreply, emailRepo: EMAIL_FICTICIO, tokens: TOKENS }),
    { email: noreply },
    'el email publico manda sobre el del repo',
  );

  // --- mensajeDelEspejo -----------------------------------------------------
  igual(
    mensajeDelEspejo({ auto: true, head: 'abc1234', tokens: TOKENS }),
    { mensaje: 'sync: espejo de abc1234' },
    '--auto sin -m => mensaje generico, sin el asunto privado',
  );
  igual(
    mensajeDelEspejo({ msg: ' sync: docs nuevas ', tokens: TOKENS }),
    { mensaje: 'sync: docs nuevas' },
    '-m limpio => se publica tal cual',
  );
  ok(mensajeDelEspejo({ tokens: TOKENS }).error, '--apply sin -m => error');
  ok(mensajeDelEspejo({ msg: `sync: gracias ${HANDLE_FICTICIO.toUpperCase()}`, tokens: TOKENS }).error, '-m con handle personal => error');
  ok(mensajeDelEspejo({ msg: `sync: ver ${RUTA_PERSONAL}`, tokens: TOKENS }).error, '-m con ruta de usuario => error');
  ok(mensajeDelEspejo({ msg: 'sync: /home/alguien/x', tokens: [] }).error, '-m con /home/<x> => error');

  // --- ejecutarGatePii sobre un clon real ------------------------------------
  const python = elegirPython();
  const clon = path.join(tmp, 'clon');
  fs.mkdirSync(path.join(clon, 'scripts', 'cockpit'), { recursive: true });
  fs.copyFileSync(ESCANER, path.join(clon, SCRIPT_GATE));
  fs.writeFileSync(path.join(clon, 'base.txt'), 'contenido publico\n');
  git(clon, ['init', '-q']);
  git(clon, ['add', '-A']);
  git(clon, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
  const informe = path.join(tmp, 'informe.md');

  // Alta limpia: veredicto completo y HIGH=0.
  fs.writeFileSync(path.join(clon, 'limpio.md'), 'nada personal\n');
  const limpio = ejecutarGatePii({ clon, tokens: TOKENS, python, informe });
  igual(limpio.high, 0, `alta limpia => HIGH=0\n${limpio.salida}`);
  igual(limpio.extra, 2, 'el escaner carga los dos patrones personales');
  igual(limpio.ficheros, 3, 'base + escaner + alta');

  // Alta con una ruta personal. Sin indexar, el escaner no la ve: es el fallo
  // original (HIGH=0 sobre un arbol sin analizar).
  fs.writeFileSync(path.join(clon, 'nuevo.md'), `ver ${RUTA_PERSONAL}\n`);
  const sinIndexar = spawnSync(python[0], [...python.slice(1), SCRIPT_GATE, '--out', informe], {
    cwd: clon,
    encoding: 'utf8',
    windowsHide: true,
  });
  const vSinIndexar = interpretarSalidaGate(sinIndexar.stdout);
  ok(vSinIndexar && vSinIndexar.high === 0 && vSinIndexar.ficheros === 3, 'sin git add -A el alta no se analiza (caso original)');
  const conRuta = ejecutarGatePii({ clon, tokens: TOKENS, python, informe });
  ok(conRuta.high >= 1, `alta con ruta personal => HIGH>0\n${conRuta.salida}`);
  fs.rmSync(path.join(clon, 'nuevo.md'));

  // Alta con el email y el handle personales: solo los detectan los patrones extra.
  fs.writeFileSync(path.join(clon, 'contacto.md'), `escribe a ${EMAIL_FICTICIO}\n`);
  const conEmail = ejecutarGatePii({ clon, tokens: TOKENS, python, informe });
  ok(conEmail.high >= 1, 'alta con el email personal => HIGH>0');
  const sinPatrones = ejecutarGatePii({ clon, tokens: [], python, informe });
  igual(sinPatrones.high, 0, 'sin patrones extra el email pasa: por eso sync-public exige configurarlos');
  fs.rmSync(path.join(clon, 'contacto.md'));

  // Nombre de fichero no ASCII: git lo citaba y el escaner se lo saltaba.
  fs.writeFileSync(path.join(clon, 'auditoría.md'), `${HANDLE_FICTICIO}\n`);
  const noAscii = ejecutarGatePii({ clon, tokens: TOKENS, python, informe });
  ok(noAscii.high >= 1, `fichero con nombre no ASCII => se analiza\n${noAscii.salida}`);
  // unlinkSync y no rmSync: en Node 24 sobre Windows, rmSync de una ruta no
  // ASCII vuelve sin error y deja el fichero.
  fs.unlinkSync(path.join(clon, 'auditoría.md'));

  // Escaner que no informa de su cobertura o no carga los patrones => sin publicar.
  const falso = (linea) => ['node', '-e', `console.log(${JSON.stringify(linea)})`];
  lanza(
    () => ejecutarGatePii({ clon, tokens: TOKENS, python: falso('[audit-personal-data] scope=head HIGH=0 MEDIUM=0') }),
    /veredicto legible/,
    'escaner antiguo => error',
  );
  lanza(
    () => ejecutarGatePii({ clon, tokens: TOKENS, python: falso('scope=head HIGH=0 MEDIUM=0 FILES=3 UNREAD=0 EXTRA=0') }),
    /0 de 2 patrones/,
    'patrones no cargados => error',
  );
  lanza(
    () => ejecutarGatePii({ clon, tokens: TOKENS, python: falso('scope=head HIGH=0 MEDIUM=0 FILES=1 UNREAD=0 EXTRA=2') }),
    /listó 1 ficheros/,
    'cobertura parcial => error',
  );
  lanza(
    () => ejecutarGatePii({ clon, tokens: TOKENS, python: falso('scope=head HIGH=0 MEDIUM=0 FILES=3 UNREAD=1 EXTRA=2') }),
    /no pudo leer 1/,
    'fichero ilegible => error',
  );
  lanza(
    () => ejecutarGatePii({ clon: path.join(tmp, 'no-es-un-repo'), tokens: TOKENS, python }),
    /git add -A falló/,
    'clon inexistente => error',
  );

  // Binario con nombre no ASCII y texto bajo build/: el diff sin `-z` citaba la
  // ruta ("c\303\241ptura.png"), su extension no casaba y se publicaba sin revisar.
  fs.writeFileSync(path.join(clon, 'cáptura.png'), 'png\n');
  fs.mkdirSync(path.join(clon, 'build'), { recursive: true });
  fs.writeFileSync(path.join(clon, 'build', 'notas.md'), 'notas\n');
  git(clon, ['add', '-A']);
  const diffZ = spawnSync('git', ['diff', '--cached', '--name-status', '-z'], { cwd: clon, encoding: 'utf8', windowsHide: true });
  igual(
    binariosSinAnalizar(parsearNameStatusZ(diffZ.stdout)).sort(),
    ['build/notas.md', 'cáptura.png'],
    'diff real con -z => el binario no ASCII y el fichero bajo build/ se marcan',
  );
  const diffViejo = spawnSync('git', ['diff', '--cached', '--name-status'], { cwd: clon, encoding: 'utf8', windowsHide: true });
  const filasViejas = diffViejo.stdout.trim().split('\n').map((l) => l.split('\t'));
  ok(
    !binariosSinAnalizar(filasViejas).includes('cáptura.png'),
    'el parseo antiguo sin -z no ve el binario no ASCII (caso original)',
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`SELFTEST sync-public-gate: VERDE (${asserts} asserts)`);

function git(cwd, argv) {
  const r = spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr}`);
}

/** uv en local (norma del repo); `python` en el runner del CI, que no trae uv. */
function elegirPython() {
  const candidatos = [['uv', 'run', '--no-project', 'python'], ['python'], ['python3']];
  for (const c of candidatos) {
    const r = spawnSync(c[0], [...c.slice(1), '--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) return c;
  }
  throw new Error('no hay interprete de Python (uv, python ni python3) para ejecutar el escaner');
}
