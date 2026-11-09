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
 *   3b. Reapunta al espejo las URLs de este repo privado (bootstrap, instalador
 *      y auto-updater apuntaban a un 404 para quien clonase el espejo).
 *   4. Indexa el clon (`git add -A`) y pasa el gate PII sobre ese indice, con
 *      los ficheros nuevos dentro, y ABORTA si hay HIGH (scripts/lib/sync-public-gate.mjs).
 *   5. Enseña altas, bajas y modificaciones.
 *   6. Con --apply, commitea y empuja. Sin --apply no escribe nada remoto.
 *
 * Fail-closed por diseño: sin .publicignore, sin gate PII, con HIGH>0, sin los
 * patrones personales de email y handle (ULTRON_PII_EXTRA o el fichero
 * gitignorado .publicpii), si el gate no analiza todo el indice, con binarios
 * nuevos o modificados sin revisar o sin un email publico para el commit, el
 * script para. La opcion segura ante un fallo es NO publicar.
 *
 * Uso:
 *   node scripts/sync-public.mjs                      # dry-run
 *   node scripts/sync-public.mjs --apply -m "sync: X" # publica
 *   node scripts/sync-public.mjs --apply -m "sync: X" --binarios-revisados
 *                                                     # publica binarios ya revisados a mano
 *   node scripts/sync-public.mjs --auto               # modo automatico
 *
 * El commit del espejo se firma con `git config ultron.publicEmail` (o la
 * variable ULTRON_PUBLIC_GIT_EMAIL), normalmente el noreply de GitHub: los
 * metadatos del commit son publicos y el gate PII no los ve.
 *
 * --auto (lo lanza git-hooks/pre-push via sync-public-auto.mjs, 2026-09-16):
 * publica sin preguntar SOLO si no hay altas. Con altas no publica nada y deja
 * una alerta en alerts.jsonl (pestaña Notifications) con la lista, para
 * revisarlas y publicar a mano. Tolera un arbol sucio: vuelca HEAD, no el
 * directorio de trabajo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { reapuntarRepo, FICHEROS_REESCRITOS } from './lib/public-rewrite.mjs';
import {
  CLAVE_EMAIL_PUBLICO,
  FICHERO_PII,
  VAR_EMAIL_PUBLICO,
  VAR_PII,
  binariosSinAnalizar,
  borrarVerificado,
  ejecutarGatePii,
  existeRuta,
  emailDelEspejo,
  leerPatronesPii,
  mensajeDelEspejo,
  parsearNameStatusZ,
  validarPatronesPii,
} from './lib/sync-public-gate.mjs';

const RAIZ = path.resolve(path.join(import.meta.dirname, '..'));
const ESPEJO = 'https://github.com/SkiTemplar/ultron-control-center.git';
const IGNORE_FILE = path.join(RAIZ, '.publicignore');
const PII_FILE = path.join(RAIZ, FICHERO_PII);

const args = process.argv.slice(2);
const AUTO = args.includes('--auto');
const APPLY = AUTO || args.includes('--apply');
const BINARIOS_REVISADOS = args.includes('--binarios-revisados');
let MSG = args.includes('-m') ? args[args.indexOf('-m') + 1] : null;

const log = (...a) => console.log(...a);
// Temporal del clon; abortar() lo purga para no dejar ~0,8 GB por cada fallo.
let tmpActivo = null;
function abortar(motivo) {
  if (tmpActivo) limpiarTmp(tmpActivo);
  console.error(`\n[sync-public] ABORTADO: ${motivo}`);
  if (AUTO) alertar('warn', `Sync al repo publico abortado: ${motivo.split('\n')[0]}`);
  process.exit(1);
}

/**
 * Borra el temporal del clon sin tumbar el script.
 *
 * En Windows, `git push` deja handles abiertos sobre el .git del clon durante
 * unos instantes, asi que un `rmSync` inmediato lanza EBUSY/EPERM. Ocurria
 * DESPUES de publicar, de modo que un sync correcto terminaba con un stack de
 * Node y parecia haber fallado (2026-09-18). Se reintenta un par de veces y, si
 * el temporal se resiste, se avisa y se sigue: el sistema ya lo purga solo.
 */
function limpiarTmp(dir) {
  for (let intento = 0; intento < 3; intento++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (e) {
      if (intento === 2) log(`   aviso: no se pudo borrar el temporal ${dir} (${e.code || e.message})`);
    }
  }
}

/** Alerta para la pestaña Notifications (mismo formato que alerts.jsonl). */
function alertar(severity, message) {
  const fila = {
    message,
    severity,
    source: 'sync.public',
    status: 'backend',
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  try {
    fs.appendFileSync(path.join(os.homedir(), '.ultron', 'alerts.jsonl'), JSON.stringify(fila) + '\n');
  } catch (err) {
    console.error(`[sync-public] no se pudo escribir la alerta: ${err.message}`);
  }
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
 * Borra una ruta del clon y ABORTA si sigue ahí (borrarVerificado: en Node 24
 * sobre Windows, fs.rmSync de una ruta no ASCII no borra y no avisa).
 */
function borrarRuta(p) {
  try {
    borrarVerificado(p);
  } catch (err) {
    abortar(err.message);
  }
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

/**
 * Patrones personales (email y handle) que el gate busca ademas de los
 * genericos. No pueden ir en el codigo porque el script viaja al espejo; sin
 * ellos el gate no detecta el email ni el usuario, asi que no se publica.
 */
function leerPatronesPersonales() {
  const { tokens, origenes } = leerPatronesPii({ env: process.env, fichero: PII_FILE });
  const problemas = validarPatronesPii(tokens);
  if (problemas.length) {
    abortar(
      `patrones personales del gate PII incompletos: ${problemas.join('; ')}.\n` +
        `  Ponlos en ${PII_FILE} (gitignorado; un email y un handle por linea, # comenta)\n` +
        `  o en la variable ${VAR_PII} separados por comas.`
    );
  }
  log(`[sync-public] ${tokens.length} patron(es) personales desde ${origenes.join(' + ')}`);
  return tokens;
}

/** Lee una clave de git config de este repo; '' si no existe. */
function gitConfig(clave) {
  try {
    return git(RAIZ, ['config', clave]).trim();
  } catch {
    return '';
  }
}

/**
 * Identidad del commit del espejo. El nombre se hereda de este repo; el email
 * debe ser publico (noreply) porque el gate PII no mira los metadatos.
 */
function resolverAutor(tokens) {
  const nombre = gitConfig('user.name');
  if (!nombre) abortar('no hay user.name configurado en git para firmar el commit del espejo.');
  const r = emailDelEspejo({
    emailPublico: process.env[VAR_EMAIL_PUBLICO] || gitConfig(CLAVE_EMAIL_PUBLICO),
    emailRepo: gitConfig('user.email'),
    tokens,
  });
  if (r.error) abortar(r.error);
  return { nombre, email: r.email };
}

// --- 1. Preparacion ----------------------------------------------------------
const exclusiones = leerExclusiones();
const patronesPii = leerPatronesPersonales();
// La identidad se resuelve antes de clonar: si falta, no se descarga el espejo.
const autor = APPLY ? resolverAutor(patronesPii) : null;
const sucio = git(RAIZ, ['status', '--porcelain']).trim();
if (sucio && !AUTO) {
  abortar('el repo tiene cambios sin commitear.\n  Se publica lo que esta en HEAD, asi que un arbol sucio publicaria algo distinto de lo que crees.');
}
const head = git(RAIZ, ['rev-parse', '--short', 'HEAD']).trim();
// El mensaje del commit es público y el gate no lo lee: en --auto va uno
// genérico y un -m con datos personales aborta antes de clonar.
if (APPLY) {
  const mensaje = mensajeDelEspejo({ auto: AUTO, msg: MSG, head, tokens: patronesPii });
  if (mensaje.error) abortar(mensaje.error);
  MSG = mensaje.mensaje;
}
// Lista y volcado salen de HEAD, no del indice: en --auto el arbol puede estar
// sucio y lo que se publica es siempre lo commiteado.
// `-z`: sin él, git cita las rutas no ASCII con escapes octales y ningún patrón
// de .publicignore casa con ellas, así que se publicaban.
const trackeados = git(RAIZ, ['ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-sync-'));
tmpActivo = tmp;
const clon = path.join(tmp, 'espejo');
log(`[sync-public] HEAD ${head} · ${trackeados.length} ficheros trackeados`);
log('[sync-public] clonando espejo...');
execFileSync('git', ['clone', '--depth', '1', '-q', ESPEJO, clon], { windowsHide: true });

// --- 2. Volcado del arbol trackeado -----------------------------------------
for (const e of fs.readdirSync(clon)) {
  if (e !== '.git') borrarRuta(path.join(clon, e));
}
// `git archive | tar` seria lo idiomatico, pero el tar de Git Bash lee `C:\...`
// como host remoto ("Cannot connect to C: resolve failed"). `checkout-index`
// hace el mismo volcado sin depender de tar. Escribe un indice TEMPORAL cargado
// desde HEAD, asi el indice y el arbol de trabajo reales no se tocan y un
// arbol sucio (--auto) no cuela cambios sin commitear.
const prefijo = clon.replace(/\\/g, '/') + '/';
const envIndice = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index-head') };
const lectura = spawnSync('git', ['read-tree', 'HEAD'], {
  cwd: RAIZ,
  encoding: 'utf8',
  windowsHide: true,
  env: envIndice,
});
if (lectura.status !== 0) abortar(`no se pudo cargar HEAD en un indice temporal:\n${lectura.stderr || ''}`);
const volcado = spawnSync('git', ['checkout-index', '-a', '-f', `--prefix=${prefijo}`], {
  cwd: RAIZ,
  encoding: 'utf8',
  windowsHide: true,
  env: envIndice,
});
if (volcado.status !== 0) abortar(`el volcado del arbol fallo:\n${volcado.stderr || ''}`);

// --- 3. Exclusiones ----------------------------------------------------------
let excluidos = 0;
for (const patron of exclusiones) {
  const casan = expandir(patron, trackeados);
  if (!casan.length) log(`   aviso: el patron "${patron}" no casa con ningun fichero trackeado`);
  for (const f of casan) {
    const p = path.join(clon, f);
    if (existeRuta(p)) {
      borrarRuta(p);
      excluidos++;
    }
  }
}
log(`[sync-public] ${excluidos} fichero(s) excluidos por .publicignore`);

// --- 3b. Reapuntado del repo -------------------------------------------------
// El volcado se lleva las URLs de este repo, que es PRIVADO: quien clonaba el
// espejo se encontraba el bootstrap, el instalador y el auto-updater apuntando
// a un 404. Solo se reescribe el arbol publicado; aqui nada cambia.
let reapuntados = 0;
let refsReapuntadas = 0;
for (const f of FICHEROS_REESCRITOS) {
  const p = path.join(clon, f);
  if (!fs.existsSync(p)) continue;
  const { texto, cambios } = reapuntarRepo(fs.readFileSync(p, 'utf8'));
  if (!cambios) continue;
  fs.writeFileSync(p, texto);
  reapuntados++;
  refsReapuntadas += cambios;
  log(`   ~ ${f} (${cambios} referencia/s al repo privado)`);
}
log(`[sync-public] ${reapuntados} fichero(s) reapuntados al espejo (${refsReapuntadas} referencia/s)`);

// --- 4. Gate PII -------------------------------------------------------------
// El gate indexa el clon (`git add -A`) ANTES de escanear: el escaner lista con
// `git ls-files`, y sin indexar los ficheros nuevos no se leian (H31).
log('[sync-public] gate PII sobre el arbol a publicar...');
let gate;
try {
  gate = ejecutarGatePii({ clon, tokens: patronesPii });
} catch (err) {
  abortar(err.message);
}
if (gate.high > 0) abortar(`el gate PII encontro ${gate.high} hallazgo(s) HIGH. NADA se ha publicado.`);
log(`[sync-public] gate PII: HIGH=0 sobre ${gate.ficheros} fichero(s), ${gate.extra} patron(es) personales`);

// --- 5. Diff -----------------------------------------------------------------
// `-z`: sin él, una ruta no ASCII sale citada y su extensión no casa con la
// lista de binarios (parsearNameStatusZ).
let filas;
try {
  filas = parsearNameStatusZ(git(clon, ['diff', '--cached', '--name-status', '-z']));
} catch (err) {
  abortar(err.message);
}
if (!filas.length) {
  log('\n[sync-public] el espejo ya esta al dia. Nada que publicar.');
  limpiarTmp(tmp);
  process.exit(0);
}
const altas = filas.filter((f) => f[0].startsWith('A'));
const bajas = filas.filter((f) => f[0].startsWith('D'));
const mods = filas.filter((f) => f[0].startsWith('M'));
log(`\n=== ALTAS (${altas.length}) — se publican por primera vez ===`);
for (const [, f] of altas) log(`   + ${f}`);
log(`\n=== BAJAS (${bajas.length}) — desaparecen del espejo ===`);
for (const [, f] of bajas) log(`   - ${f}`);
log(`\n=== MODIFICADOS: ${mods.length} ===`);
// El escaner no lee binarios ni lo que cuelga de build/, dist/...: un fichero
// así nuevo o modificado (una captura con una ruta personal, por ejemplo) solo
// lo puede revisar una persona.
const binarios = binariosSinAnalizar(filas);
if (binarios.length) {
  log(`\n=== SIN ANALIZAR (${binarios.length}) — binarios o rutas que el gate salta, revisalos a mano ===`);
  for (const f of binarios) log(`   ! ${f}`);
}

if (!APPLY) {
  log('\n[sync-public] DRY-RUN. Revisa las ALTAS una a una: son lo unico que no estaba publicado.');
  log('  Para publicar:  node scripts/sync-public.mjs --apply -m "sync: ..."');
  log(`  Clon en: ${clon}`);
  process.exit(0);
}

// --- 6. Publicacion ----------------------------------------------------------
if (AUTO && altas.length) {
  const lista = altas.slice(0, 10).map(([, f]) => f).join(', ');
  const resto = altas.length > 10 ? ` (+${altas.length - 10} mas)` : '';
  alertar(
    'warn',
    `Sync al repo publico en pausa: ${altas.length} fichero(s) nuevo(s) por revisar (${lista}${resto}). ` +
      'Publicar con: node scripts/sync-public.mjs --apply -m "sync: ..."',
  );
  log('\n[sync-public] --auto: hay ALTAS, no se publica. Alerta registrada.');
  limpiarTmp(tmp);
  process.exit(0);
}
if (binarios.length && !BINARIOS_REVISADOS) {
  abortar(
    `${binarios.length} binario(s) o fichero(s) nuevo(s) o modificado(s) que el gate PII no lee (${binarios.slice(0, 5).join(', ')}${binarios.length > 5 ? ', ...' : ''}).\n` +
      '  Revisalos con el dry-run y publica con --binarios-revisados.'
  );
}
// La identidad (resolverAutor, paso 1) se hereda de este repo y nunca se
// incrusta aqui: el script viaja al espejo publico.
git(clon, [
  '-c', `user.name=${autor.nombre}`,
  '-c', `user.email=${autor.email}`,
  'commit', '-q', '-m', MSG,
]);
git(clon, ['push', 'origin', 'main'], { mostrar: true });
log(`\n[sync-public] publicado. HEAD privado ${head} -> espejo actualizado.`);
limpiarTmp(tmp);
