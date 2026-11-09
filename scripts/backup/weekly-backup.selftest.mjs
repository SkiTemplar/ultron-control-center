// weekly-backup.selftest.mjs — checks herméticos de scripts/backup/weekly-backup.ps1.
// Cada test corre el script real con USERPROFILE en un directorio temporal y
// `-Source`, así que no toca ni el backup ni la configuración reales (sin
// -Source tampoco hace el snapshot de brain.db).
//
// Cubre:
// - H9 (auditoría 2026-10-17): una fuente con ruta absoluta (D:\TFG) nunca se
//   copiaba porque Join-Path la pegaba detrás de USERPROFILE, y una fuente
//   inexistente contaba como «skipped» y el run salía con éxito.
// - N1 (auditoría 2026-10-23): sin destino configurado el script caía a
//   %USERPROFILE%\BACKUP y hacía /MIR en el mismo disco con exit 0. Ahora
//   aborta (exit 2, estado `failed`) sin destino explícito, con la unidad
//   desmontada o con el destino en el mismo volumen que las fuentes.
// - N5: retención de los logs de backup y robocopy (-KeepLogs).
//
// Los tests que copian de verdad usan ULTRON_BACKUP_ALLOW_SAME_VOLUME=1 porque
// el directorio temporal y las fuentes están en el mismo volumen.
//
// Uso: node scripts/backup/weekly-backup.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, 'weekly-backup.ps1');
const isWindows = process.platform === 'win32';

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'backup-selftest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, 'home');
  const root = join(dir, 'BK');
  mkdirSync(home, { recursive: true });
  return { dir, home, root };
}

function baseEnv(home) {
  const env = { ...process.env, USERPROFILE: home, ULTRON_BACKUP_SOURCES: '' };
  delete env.ULTRON_BACKUP_ROOT;
  delete env.ULTRON_BACKUP_ALLOW_SAME_VOLUME;
  return env;
}

/**
 * Ejecuta el script. Por defecto el destino va por ULTRON_BACKUP_ROOT y se
 * permite el mismo volumen (el sandbox está entero en %TEMP%).
 * `root: null` deja el destino sin configurar.
 */
function runBackup(sb, source, opts = {}) {
  const { root = sb.root, allowSameVolume = true, args = [] } = opts;
  const env = baseEnv(sb.home);
  if (root !== null) env.ULTRON_BACKUP_ROOT = root;
  if (allowSameVolume) env.ULTRON_BACKUP_ALLOW_SAME_VOLUME = '1';
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Source', source, ...args],
    { encoding: 'utf8', timeout: 60_000, env }
  );
  const statusPath = join(sb.home, '.ultron', '.tmp', 'backup-last-run.json');
  const status = existsSync(statusPath)
    ? JSON.parse(readFileSync(statusPath, 'utf8').replace(/^\uFEFF/, ''))
    : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, status };
}

function makeSource(sb, name = 'TFG') {
  const src = join(sb.dir, name);
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, 'memoria.txt'), 'capitulo 1\n', 'utf8');
  return src;
}

function assertAborted(r, code, pattern) {
  assert.equal(r.code, 2, `debía abortar con 2:\n${r.out}`);
  assert.match(r.out, pattern);
  assert.ok(r.status, `sin backup-last-run.json:\n${r.out}`);
  assert.equal(r.status.status, 'failed');
  assert.equal(r.status.aborted, true);
  assert.equal(r.status.error_code, code);
  assert.equal(r.status.any_failed, true);
  assert.match(r.status.error, pattern);
}

function freeDriveLetter() {
  for (const l of 'ZYXWVUTSRQPONMLKJ') {
    if (!existsSync(`${l}:\\`)) return l;
  }
  return null;
}

test('una fuente con ruta absoluta se copia tal cual a abs-<ruta>', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  const absSource = makeSource(sb);

  const r = runBackup(sb, absSource);
  assert.equal(r.code, 0, r.out);
  const slug = absSource.replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '');
  const copied = join(sb.root, `abs-${slug}`, 'memoria.txt');
  assert.ok(existsSync(copied), `no se copió a ${copied}\n${r.out}`);
  const res = r.status.results[absSource];
  assert.equal(res.failed, false);
  assert.equal(res.source, absSource);
  assert.equal(r.status.any_failed, false);
  assert.equal(r.status.status, 'ok');
});

test('una fuente relativa se sigue anclando en USERPROFILE', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.home, 'Documents'), { recursive: true });
  writeFileSync(join(sb.home, 'Documents', 'a.txt'), 'x\n', 'utf8');

  const r = runBackup(sb, 'Documents');
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(sb.root, 'Documents', 'a.txt')), r.out);
});

test('una fuente configurada que no existe es un fallo (exit 1), no un skip', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  const missing = join(sb.dir, 'NoExiste');

  const r = runBackup(sb, missing);
  assert.equal(r.code, 1, `debía salir con 1:\n${r.out}`);
  const res = r.status.results[missing];
  assert.equal(res.skipped, true);
  assert.equal(res.failed, true);
  assert.equal(r.status.any_failed, true);
  // Sin carpeta de destino vacía con mtime fresco que parezca un espejo bueno.
  const slug = missing.replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '');
  assert.equal(existsSync(join(sb.root, `abs-${slug}`)), false);
});

test('sin destino configurado aborta (exit 2) y no crea %USERPROFILE%\\BACKUP', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  const src = makeSource(sb);

  const r = runBackup(sb, src, { root: null });
  assertAborted(r, 'no_destination', /no backup destination configured/i);
  assert.equal(r.status.backup_root, null);
  assert.equal(existsSync(join(sb.home, 'BACKUP')), false, 'no debe caer a %USERPROFILE%\\BACKUP');
});

test('un destino en el mismo volumen que las fuentes aborta (exit 2)', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  const src = makeSource(sb);

  const r = runBackup(sb, src, { allowSameVolume: false });
  assertAborted(r, 'same_volume', /same volume/i);
  assert.equal(r.status.backup_root, sb.root);
  const volume = parse(sb.root).root.replace(/\\$/, '');
  assert.ok(r.status.error.toLowerCase().includes(volume.toLowerCase()), r.status.error);
  assert.equal(existsSync(sb.root), false, 'no debe crear ni copiar nada en el destino');
});

test('una unidad de destino desmontada aborta y deja el estado failed', { skip: !isWindows }, (t) => {
  const letter = freeDriveLetter();
  if (!letter) return t.skip('no hay letra de unidad libre');
  const sb = sandbox(t);
  const src = makeSource(sb);

  const r = runBackup(sb, src, { root: `${letter}:\\BACKUP` });
  assertAborted(r, 'drive_missing', /not mounted/i);
});

test('backup-root.txt manda sobre ULTRON_BACKUP_ROOT (mismo orden que backup_root())', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  const src = makeSource(sb);
  const fileRoot = join(sb.dir, 'DesdeFichero');
  const tmpDir = join(sb.home, '.ultron', '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'backup-root.txt'), `${fileRoot}\n`, 'utf8');

  const r = runBackup(sb, src);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.status.backup_root, fileRoot);
  assert.equal(existsSync(sb.root), false, 'la variable no debe usarse si hay fichero');
});

test('poda los logs de backup y robocopy y conserva los -KeepLogs más recientes', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  const src = makeSource(sb);
  const logDir = join(sb.home, '.ultron', 'logs');
  mkdirSync(logDir, { recursive: true });
  for (let d = 1; d <= 6; d++) {
    const day = `2026-01-0${d}`;
    writeFileSync(join(logDir, `backup-${day}.log`), 'x', 'utf8');
    writeFileSync(join(logDir, `backup-${day}.robocopy.log`), 'x', 'utf8');
  }
  writeFileSync(join(logDir, 'backup-2025-12-01.log.gz'), 'x', 'utf8');
  writeFileSync(join(logDir, 'otro.log'), 'ajeno', 'utf8');

  const r = runBackup(sb, src, { args: ['-KeepLogs', '3'] });
  assert.equal(r.code, 0, r.out);
  const left = readdirSync(logDir).sort();
  const main = left.filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.log(\.gz)?$/.test(f));
  const robo = left.filter((f) => /^backup-\d{4}-\d{2}-\d{2}\.robocopy\.log(\.gz)?$/.test(f));
  assert.equal(main.length, 3, left.join(', '));
  assert.equal(robo.length, 3, left.join(', '));
  assert.ok(main.includes('backup-2026-01-06.log') && main.includes('backup-2026-01-05.log'), left.join(', '));
  assert.ok(!main.includes('backup-2025-12-01.log.gz'), 'el .gz más viejo se poda');
  assert.ok(left.includes('otro.log'), 'no toca logs ajenos');
});

// -- Papelera (2026-11-09) -------------------------------------------------------
// /MIR borraba del destino lo que ya no estaba en el origen: un borrado por
// error desaparecía también de la copia en la siguiente ejecución. Ahora esos
// ficheros se mueven antes a <raíz>\_borrados\<fecha>\<carpeta destino>\.

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

test('lo borrado en el origen pasa a la papelera en vez de perderse', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.home, 'Documents', 'sub'), { recursive: true });
  writeFileSync(join(sb.home, 'Documents', 'queda.txt'), 'q\n', 'utf8');
  writeFileSync(join(sb.home, 'Documents', 'sub', 'borrado ñ.txt'), 'importante\n', 'utf8');
  assert.equal(runBackup(sb, 'Documents').code, 0);

  rmSync(join(sb.home, 'Documents', 'sub'), { recursive: true });
  const r = runBackup(sb, 'Documents');
  assert.equal(r.code, 0, r.out);

  const trashed = join(sb.root, '_borrados', today(), 'Documents', 'sub', 'borrado ñ.txt');
  assert.ok(existsSync(trashed), `no está en la papelera: ${trashed}\n${r.out}`);
  assert.equal(readFileSync(trashed, 'utf8'), 'importante\n');
  assert.equal(existsSync(join(sb.root, 'Documents', 'sub')), false, 'el espejo sigue igualando al origen');
  assert.ok(existsSync(join(sb.root, 'Documents', 'queda.txt')));
  assert.equal(r.status.results.Documents.trash_moved, 1);
  assert.equal(r.status.results.Documents.purged, true);
});

test('lo excluido y lo modificado no van a la papelera', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  const docs = join(sb.home, 'Documents');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'cambia.txt'), 'v1\n', 'utf8');
  assert.equal(runBackup(sb, 'Documents').code, 0);
  // Algo bajo un nombre excluido que solo vive en el destino: /MIR no lo borra.
  mkdirSync(join(sb.root, 'Documents', 'node_modules'), { recursive: true });
  writeFileSync(join(sb.root, 'Documents', 'node_modules', 'x.js'), 'x\n', 'utf8');
  writeFileSync(join(docs, 'cambia.txt'), 'v2 con otro tamaño\n', 'utf8');

  const exDir = join(sb.home, '.ultron', 'config');
  mkdirSync(exDir, { recursive: true });
  writeFileSync(join(exDir, 'backup-exclusions.txt'), 'node_modules/\n', 'utf8');
  const r = runBackup(sb, 'Documents');
  assert.equal(r.code, 0, r.out);
  assert.equal(existsSync(join(sb.root, '_borrados')), false, r.out);
  assert.equal(readFileSync(join(sb.root, 'Documents', 'cambia.txt'), 'utf8'), 'v2 con otro tamaño\n');
  assert.equal(r.status.results.Documents.trash_moved, 0);
});

test('poda las carpetas de la papelera más viejas que -TrashDays', { skip: !isWindows }, (t) => {
  const sb = sandbox(t);
  const src = makeSource(sb);
  const trash = join(sb.root, '_borrados');
  for (const name of ['2020-01-01', today(), 'ajena']) {
    mkdirSync(join(trash, name), { recursive: true });
    writeFileSync(join(trash, name, 'f.txt'), 'x', 'utf8');
  }

  const r = runBackup(sb, src, { args: ['-TrashDays', '28'] });
  assert.equal(r.code, 0, r.out);
  const left = readdirSync(trash).sort();
  assert.ok(!left.includes('2020-01-01'), left.join(', '));
  assert.ok(left.includes(today()) && left.includes('ajena'), left.join(', '));
});

// -- weekly-backup.sh (mismo defecto N1) ---------------------------------------
// Los abortos ocurren antes de comprobar rsync, así que se prueban también en
// Windows con el bash de Git. Las rutas pasan a forma MSYS (/c/...), que es
// la que el script trata como absoluta.

const SH_SCRIPT = join(__dirname, 'weekly-backup.sh');
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const BASH = isWindows ? (existsSync(GIT_BASH) ? GIT_BASH : null) : 'bash';
const slash = (p) => {
  const fwd = p.replace(/\\/g, '/');
  return isWindows ? fwd.replace(/^([A-Za-z]):\//, (_, d) => `/${d.toLowerCase()}/`) : fwd;
};

function runSh(sb, source, opts = {}) {
  const { root = slash(sb.root) } = opts;
  const env = { ...baseEnv(sb.home), HOME: slash(sb.home) };
  if (root !== null) env.ULTRON_BACKUP_ROOT = root;
  const r = spawnSync(BASH, [slash(SH_SCRIPT), '--source', slash(source)], {
    encoding: 'utf8', timeout: 60_000, env,
  });
  const statusPath = join(sb.home, '.ultron', '.tmp', 'backup-last-run.json');
  const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : null;
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, status };
}

test('sh: sin destino configurado aborta y no crea $HOME/BACKUP', { skip: !BASH }, (t) => {
  const sb = sandbox(t);
  const src = makeSource(sb);

  const r = runSh(sb, src, { root: null });
  assertAborted(r, 'no_destination', /no backup destination configured/i);
  assert.equal(r.status.backup_root, null);
  assert.equal(existsSync(join(sb.home, 'BACKUP')), false);
});

test('sh: un destino en el mismo dispositivo que las fuentes aborta', { skip: !BASH }, (t) => {
  const sb = sandbox(t);
  const src = makeSource(sb);

  const r = runSh(sb, src);
  assertAborted(r, 'same_volume', /same volume/i);
  assert.equal(existsSync(sb.root), false);
});

test('sh: backup-root.txt manda sobre ULTRON_BACKUP_ROOT', { skip: !BASH }, (t) => {
  const sb = sandbox(t);
  const src = makeSource(sb);
  const fileRoot = slash(join(sb.dir, 'DesdeFichero'));
  const tmpDir = join(sb.home, '.ultron', '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(tmpDir, 'backup-root.txt'), `${fileRoot}\n`, 'utf8');

  const r = runSh(sb, src);
  assertAborted(r, 'same_volume', /same volume/i);
  assert.equal(r.status.backup_root, fileRoot);
});
