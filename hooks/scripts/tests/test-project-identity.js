#!/usr/bin/env node
// Test del resolver de identidad de proyecto: el project_id debe sobrevivir a
// renombrar y mover la carpeta. Regresion real (2026-08-23): el home-reorg
// movio CARRERA -> PERSONAL y dejo 46 memorias huerfanas, con Legacy FC
// resolviendo a "LegacyFc" mientras sus 221 items vivian bajo "legacy-fc".
//
// Cubre tambien la colision que descarto el SHA raiz como clave primaria: dos
// repos con el mismo arbol, autor, mensaje y segundo comparten commit raiz, y
// el alta automatica de proyectos crea justo ese caso.
//
// Hermetico: repos temporales propios y registro redirigido con
// ULTRON_PROJECT_IDENTITY_PATH; nunca toca el registro real del usuario.
// Ejecutar: node hooks/scripts/tests/test-project-identity.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ultron-identity-'));
process.env.ULTRON_PROJECT_IDENTITY_PATH = path.join(sandbox, 'registry.json');

const {
  resolveProjectId,
  basenameId,
  repoRootFor,
  rootShaFor,
  readRepoUuid,
  readRegistry,
  writeRegistry,
} = require('../lib/project-identity.js');

function git(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });
}

/** Repo de un commit, sin remote: el caso de LegacyFc y AutoAlbumMaker. */
function makeRepo(dir, content) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'f.txt'), content || 'contenido\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

// --- Sin repo: comportamiento historico (basename) ---
const plain = path.join(sandbox, 'sin-git');
fs.mkdirSync(plain, { recursive: true });
assert.strictEqual(resolveProjectId(plain), 'sin-git', 'sin .git debe caer al basename');
assert.strictEqual(basenameId('C:/x/.ultron'), 'ultron', 'los puntos iniciales se recortan');

// --- Entradas invalidas: nunca lanzan ---
assert.doesNotThrow(() => resolveProjectId(null), 'cwd null no debe lanzar');
assert.doesNotThrow(() => resolveProjectId(''), 'cwd vacio no debe lanzar');
assert.doesNotThrow(() => resolveProjectId(path.join(sandbox, 'no-existe')), 'cwd inexistente no debe lanzar');

// --- Repo real: se le fija un UUID propio y sobrevive al renombrado ---
const original = makeRepo(path.join(sandbox, 'proyecto-viejo'), 'uno\n');
const idAntes = resolveProjectId(original);
assert.strictEqual(idAntes, 'proyecto-viejo', 'primer alta usa el basename como nombre legible');

const uuid = readRepoUuid(original);
assert.ok(uuid, 'el alta debe escribir ultron.projectId en .git/config');

const renamed = path.join(sandbox, 'ProyectoNuevo');
fs.renameSync(original, renamed);
assert.strictEqual(
  resolveProjectId(renamed),
  idAntes,
  'renombrar la carpeta NO debe cambiar el project_id — es la regresion que rompio Legacy FC'
);
assert.strictEqual(readRepoUuid(renamed), uuid, 'el UUID viaja con el .git, no con la ruta');

// --- Subdirectorio: mismo proyecto que la raiz ---
const sub = path.join(renamed, 'src', 'components');
fs.mkdirSync(sub, { recursive: true });
assert.strictEqual(resolveProjectId(sub), idAntes, 'un subdirectorio del repo no es otro proyecto');
assert.strictEqual(repoRootFor(sub), renamed, 'repoRootFor debe subir hasta la raiz del repo');

// --- El id canonico del registro manda sobre el basename ---
// Es lo que permite apuntar una carpeta al id que YA tiene los datos en
// brain.db sin reescribir miles de filas.
writeRegistry((reg) => {
  reg.repos[uuid].id = 'id-canonico';
  reg.paths = {};
});
assert.strictEqual(
  resolveProjectId(renamed),
  'id-canonico',
  'un id canonico registrado debe ganar al basename de la carpeta'
);

// --- Repos GEMELOS: mismo SHA raiz, identidades distintas ---
// Mismo arbol, autor, mensaje y segundo => mismo commit raiz. Sin UUID en
// .git/config estos dos proyectos compartirian memoria en silencio.
const g1 = makeRepo(path.join(sandbox, 'gemelo-uno'), 'igual\n');
const g2 = makeRepo(path.join(sandbox, 'gemelo-dos'), 'igual\n');
const id1 = resolveProjectId(g1);
const id2 = resolveProjectId(g2);
if (rootShaFor(g1) === rootShaFor(g2)) {
  assert.notStrictEqual(readRepoUuid(g1), readRepoUuid(g2), 'repos gemelos vivos no comparten UUID');
  assert.notStrictEqual(id1, id2, 'repos gemelos vivos no comparten project_id');
}

// --- Repo conocido por SHA y sin UUID: hereda su identidad (proyecto mudado) ---
const mudado = makeRepo(path.join(sandbox, 'mudado'), 'unico-mudado\n');
const idMudado = resolveProjectId(mudado);
const uuidMudado = readRepoUuid(mudado);
const shaMudado = rootShaFor(mudado);
// Simula el estado previo a esta version: registro con el SHA, repo sin UUID.
execFileSync('git', ['-C', mudado, 'config', '--local', '--unset', 'ultron.projectId'], { stdio: 'ignore' });
writeRegistry((reg) => {
  reg.paths = {};
  reg.bySha[shaMudado] = uuidMudado;
  reg.repos[uuidMudado].paths = [path.join(sandbox, 'ruta-que-ya-no-existe').toLowerCase()];
});
assert.strictEqual(
  resolveProjectId(mudado),
  idMudado,
  'un repo ya registrado por SHA, con su ruta anterior muerta, conserva su identidad'
);

// --- Si no se puede fijar el UUID en .git/config, el alta NO se da por buena ---
// Regresion 2026-08-23: se registraba el atajo por ruta aunque la escritura en
// git fallara, y el alta no se reintentaba nunca; el repo quedaba atado a su
// ubicacion, que es justo lo que este modulo elimina.
const noEscribible = makeRepo(path.join(sandbox, 'no-escribible'), 'sin-permisos\n');
const identityMod = require.cache[require.resolve('../lib/project-identity.js')].exports;
const writeReal = identityMod.writeRepoUuid;
require('../lib/project-identity.js');
{
  // Simula el fallo de escritura sustituyendo git por un binario inexistente.
  const PATH_REAL = process.env.PATH;
  process.env.PATH = path.join(sandbox, 'sin-git-en-path');
  const idFallo = resolveProjectId(noEscribible);
  process.env.PATH = PATH_REAL;
  assert.ok(idFallo, 'sin poder escribir el UUID se sigue devolviendo un id');
  const reg = readRegistry();
  const rutaRegistrada = Object.keys(reg.paths).some((p) => p.includes('no-escribible'));
  assert.strictEqual(rutaRegistrada, false, 'un alta fallida no debe persistir el atajo por ruta');
}
assert.strictEqual(typeof writeReal, 'function', 'writeRepoUuid sigue exportado');

// --- Registro corrupto: no rompe el prompt ---
fs.writeFileSync(process.env.ULTRON_PROJECT_IDENTITY_PATH, '{no es json');
assert.doesNotThrow(() => resolveProjectId(renamed), 'un registro corrupto no debe lanzar');
assert.ok(resolveProjectId(renamed), 'con registro corrupto se sigue devolviendo un id');

fs.rmSync(sandbox, { recursive: true, force: true });
console.log('test-project-identity: OK');
