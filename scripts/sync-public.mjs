#!/usr/bin/env node
/**
 * sync-public.mjs — publica el arbol de este repo en el espejo publico.
 *
 * Este repositorio es PRIVADO. El espejo publico
 * (github.com/SkiTemplar/ultron-control-center) se venia sincronizando a mano:
 * clonar, volcar, mirar el diff y commitear. El problema de hacerlo a mano no
 * es el trabajo, es que cada vez hay que volver a decidir que sale — y un
 * volcado completo publica MAS de lo que habia, porque los sync anteriores
 * fueron selectivos. Asi es como la hoja de ruta acaba publicada sin que nadie
 * lo decida (2026-08-23: el volcado incluia GOAL.md y MASTERPLAN).
 *
 * Que hace:
 *   1. Clona el espejo publico en un temporal.
 *   2. Lo vacia (salvo .git) y vuelca `git archive HEAD` de este repo. Volcar
 *      SOLO lo trackeado es lo que garantiza que nada ignorado viaje: el
 *      .gitignore ya es el filtro de datos personales.
 *   3. Borra del clon lo que liste .publicignore.
 *   4. Pasa el gate PII sobre el arbol resultante y ABORTA si hay HIGH.
 *   5. Enseña altas, bajas y modificaciones.
 *   6. Con --apply, commitea y empuja. Sin --apply no escribe nada remoto.
 *
 * Fail-closed por diseño: sin .publicignore, sin gate PII o con HIGH>0 el
 * script para. La opcion segura ante un fallo es NO publicar.
 *
 * Uso:
 *   node scripts/sync-public.mjs                      # dry-run
 *   node scripts/sync-public.mjs --apply -m "sync: X" # publica
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const RAIZ = path.resolve(path.join(import.meta.dirname, '..'));
const ESPEJO = 'https://github.com/SkiTemplar/ultron-control-center.git';
const IGNORE_FILE = path.join(RAIZ, '.publicignore');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const MSG = args.includes('-m') ? args[args.indexOf('-m') + 1] : null;

const log = (...a) => console.log(...a);
function abortar(motivo) {
  console.error(`\n[sync-public] ABORTADO: ${motivo}`);
  process.exit(1);
}

function git(cwd, argv, opts = {}) {
  return execFileSync('git', argv, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: opts.mostrar ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Patrones de lo que NO se publica, uno por linea (`#` comenta).
 * Vive FUERA del repo a proposito: si la lista viajara en el espejo, estaria
 * anunciando que existen esos ficheros y que se ocultan.
 */
function leerExclusiones() {
  if (!fs.existsSync(IGNORE_FILE)) {
    abortar(
      `no existe ${IGNORE_FILE}.\n` +
        '  Sin la lista de exclusiones este script publicaria el arbol entero,\n' +
        '  incluida la planificacion interna. Crealo antes de sincronizar.'
    );
  }
  const lineas = fs
    .readFileSync(IGNORE_FILE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lineas.length) abortar(`${IGNORE_FILE} esta vacio: si de verdad no hay nada que excluir, ponlo explicito con una linea "# ninguna".`);
  return lineas;
}

/** Rutas trackeadas que casan con un patron (glob simple con * y prefijo de dir). */
function expandir(patron, trackeados) {
  if (patron.endsWith('/')) return trackeados.filter((f) => f.startsWith(patron));
  if (patron.includes('*')) {
    const re = new RegExp('^' + patron.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
    return trackeados.filter((f) => re.test(f));
  }
  return trackeados.filter((f) => f === patron || f.startsWith(patron + '/'));
}

// --- 1. Preparacion ----------------------------------------------------------
const exclusiones = leerExclusiones();
const sucio = git(RAIZ, ['status', '--porcelain']).trim();
if (sucio) {
  abortar('el repo tiene cambios sin commitear.\n  Se publica lo que esta en HEAD, asi que un arbol sucio publicaria algo distinto de lo que crees.');
}
const head = git(RAIZ, ['rev-parse', '--short', 'HEAD']).trim();
const trackeados = git(RAIZ, ['ls-files']).trim().split('\n');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-sync-'));
const clon = path.join(tmp, 'espejo');
log(`[sync-public] HEAD ${head} · ${trackeados.length} ficheros trackeados`);
log('[sync-public] clonando espejo...');
execFileSync('git', ['clone', '--depth', '1', '-q', ESPEJO, clon], { windowsHide: true });

// --- 2. Volcado del arbol trackeado -----------------------------------------
for (const e of fs.readdirSync(clon)) {
  if (e !== '.git') fs.rmSync(path.join(clon, e), { recursive: true, force: true });
}
// `git archive | tar` seria lo idiomatico, pero el tar de Git Bash lee `C:\...`
// como host remoto ("Cannot connect to C: resolve failed"). `checkout-index`
// hace el mismo volcado sin depender de tar: escribe el INDICE, que coincide
// con HEAD porque arriba ya se exige un arbol limpio.
const prefijo = clon.replace(/\\/g, '/') + '/';
const volcado = spawnSync('git', ['checkout-index', '-a', '-f', `--prefix=${prefijo}`], {
  cwd: RAIZ,
  encoding: 'utf8',
  windowsHide: true,
});
if (volcado.status !== 0) abortar(`el volcado del arbol fallo:\n${volcado.stderr || ''}`);

// --- 3. Exclusiones ----------------------------------------------------------
let excluidos = 0;
for (const patron of exclusiones) {
  const casan = expandir(patron, trackeados);
  if (!casan.length) log(`   aviso: el patron "${patron}" no casa con ningun fichero trackeado`);
  for (const f of casan) {
    const p = path.join(clon, f);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      excluidos++;
    }
  }
}
log(`[sync-public] ${excluidos} fichero(s) excluidos por .publicignore`);

// --- 4. Gate PII -------------------------------------------------------------
log('[sync-public] gate PII sobre el arbol a publicar...');
const pii = spawnSync('uv', ['run', 'python', 'scripts/cockpit/audit_personal_data.py'], {
  cwd: clon,
  encoding: 'utf8',
  windowsHide: true,
});
const salida = `${pii.stdout || ''}${pii.stderr || ''}`;
const marca = salida.match(/HIGH=(\d+)/);
if (!marca) abortar(`el gate PII no devolvio un veredicto legible:\n${salida.slice(-400)}`);
if (Number(marca[1]) > 0) abortar(`el gate PII encontro ${marca[1]} hallazgo(s) HIGH. NADA se ha publicado.`);
log(`[sync-public] gate PII: HIGH=0`);

// --- 5. Diff -----------------------------------------------------------------
git(clon, ['add', '-A']);
const estado = git(clon, ['diff', '--cached', '--name-status']).trim();
if (!estado) {
  log('\n[sync-public] el espejo ya esta al dia. Nada que publicar.');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}
const filas = estado.split('\n').map((l) => l.split('\t'));
const altas = filas.filter((f) => f[0].startsWith('A'));
const bajas = filas.filter((f) => f[0].startsWith('D'));
const mods = filas.filter((f) => f[0].startsWith('M'));
log(`\n=== ALTAS (${altas.length}) — se publican por primera vez ===`);
for (const [, f] of altas) log(`   + ${f}`);
log(`\n=== BAJAS (${bajas.length}) — desaparecen del espejo ===`);
for (const [, f] of bajas) log(`   - ${f}`);
log(`\n=== MODIFICADOS: ${mods.length} ===`);

if (!APPLY) {
  log('\n[sync-public] DRY-RUN. Revisa las ALTAS una a una: son lo unico que no estaba publicado.');
  log('  Para publicar:  node scripts/sync-public.mjs --apply -m "sync: ..."');
  log(`  Clon en: ${clon}`);
  process.exit(0);
}

// --- 6. Publicacion ----------------------------------------------------------
if (!MSG) abortar('--apply exige un mensaje con -m "sync: que ha cambiado".');
// La identidad se hereda de este repo, nunca se incrusta aqui: el script viaja
// al espejo publico y el gate PII rechaza datos personales en el codigo.
let autor;
try {
  autor = {
    nombre: git(RAIZ, ['config', 'user.name']).trim(),
    email: git(RAIZ, ['config', 'user.email']).trim(),
  };
} catch {
  autor = null;
}
if (!autor?.nombre || !autor?.email) {
  abortar('no hay identidad git configurada (user.name / user.email) para firmar el commit del espejo.');
}
git(clon, [
  '-c', `user.name=${autor.nombre}`,
  '-c', `user.email=${autor.email}`,
  'commit', '-q', '-m', MSG,
]);
git(clon, ['push', 'origin', 'main'], { mostrar: true });
log(`\n[sync-public] publicado. HEAD privado ${head} -> espejo actualizado.`);
fs.rmSync(tmp, { recursive: true, force: true });
