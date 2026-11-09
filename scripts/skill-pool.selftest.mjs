// skill-pool.selftest.mjs — checks herméticos de scripts/skill-pool.mjs.
//
// Cada test crea su propio directorio temporal con una pool
// (ULTRON_SKILL_POOL_ROOT), un registro de proyectos (ULTRON_PROJECTS_JSON) y
// un home falso (USERPROFILE/HOME). El remoto es un repo git local creado aquí
// y clonado por file://: nunca toca ~/.ultron/skill-pool ni el registro real.
// Utilidades en scripts/skill-pool/testkit.mjs.
//
// Uso: node scripts/skill-pool.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, existsSync, readFileSync, writeFileSync, rmSync, renameSync, chmodSync, symlinkSync, readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  addDemo, git, isLink, makeRemote, ok, readGitignore, readPool, registerProject, rejected, run, wsTest,
} from './skill-pool/testkit.mjs';

const REMOTE = makeRemote();
const t = (name, fn) => wsTest(REMOTE, name, fn);
const IS_WINDOWS = process.platform === 'win32';

test.after(() => rmSync(REMOTE.dir, { recursive: true, force: true, maxRetries: 3 }));

// --- add -------------------------------------------------------------------------

t('add: clona en repos/<n>@<sha7> con el HEAD fijado y registra review null', (ws) => {
  addDemo(ws, { review: false });
  assert.equal(git(['rev-parse', 'HEAD'], ws.clone), REMOTE.sha1);
  const [entry] = readPool(ws).entries;
  assert.equal(entry.sha, REMOTE.sha1);
  assert.equal(entry.path, 'skills/demo');
  assert.equal(entry.kind, 'skill');
  assert.equal(entry.review, null);
});

t('add deja los ficheros del clon en solo lectura', (ws) => {
  addDemo(ws);
  assert.throws(() => writeFileSync(join(ws.clone, 'skills', 'demo', 'SKILL.md'), 'editado'), /EPERM|EACCES/);
});

t('add rechaza --path con .., un SHA corto o inexistente, un --ref no válido y un nombre duplicado', (ws) => {
  const base = ['add', REMOTE.url, '--kind', 'skill', '--path', 'skills/demo'];
  rejected(ws, [...base, '--name', 'malo', '--sha', REMOTE.sha1, '--path', '../fuera'], /subcarpeta relativa/);
  rejected(ws, [...base, '--name', 'corto', '--sha', REMOTE.sha1.slice(0, 12)], /40 caracteres/);
  rejected(ws, [...base, '--name', 'nosha', '--sha', 'deadbeef'.repeat(5)], /no existe/);
  for (const ref of ['bad..ref', '-x', 'a b', '@{-1}']) {
    rejected(ws, [...base, '--name', 'ref', '--sha', REMOTE.sha1, '--ref', ref], /--ref no es un nombre de rama/);
  }
  const repos = join(ws.poolRoot, 'repos');
  assert.deepEqual(existsSync(repos) ? readdirSync(repos) : [], [], 'ningún rechazo deja clon');
  assert.equal(existsSync(join(ws.poolRoot, 'pool.json')), false);
  addDemo(ws);
  rejected(ws, [...base, '--name', 'demo', '--sha', REMOTE.sha1], /ya hay una entrada/);
});

t('add python-lib: no clona y aparece en list --json', (ws) => {
  ok(ws, ['add', '--name', 'supervision', '--kind', 'python-lib', '--version', '0.26.1', '--license', 'MIT']);
  assert.equal(existsSync(join(ws.poolRoot, 'repos')), false);
  const { entries } = JSON.parse(ok(ws, ['list', '--json']).out);
  assert.equal(entries[0].version, '0.26.1');
  assert.equal(entries[0].path, null);
});

// --- link / unlink ---------------------------------------------------------------

t('link crea la junction y la línea del .gitignore; repetido es idempotente', (ws) => {
  addDemo(ws);
  ok(ws, ['link', 'demo-proj', 'demo']);
  assert.ok(isLink(ws.link), 'la junction debe existir');
  assert.match(readFileSync(join(ws.link, 'SKILL.md'), 'utf8'), /Cuerpo de demo/);
  ok(ws, ['link', ws.project, 'demo']);
  assert.ok(isLink(ws.link));
  assert.equal(readGitignore(ws).split(/\r?\n/).filter((l) => l === '.claude/skills/demo').length, 1);
});

t('link no duplica la línea si el .gitignore ya la cubre con otra forma', (ws) => {
  addDemo(ws);
  for (const existing of ['/.claude/skills/demo', '.claude/skills/demo/', '.claude/', '/.claude/skills']) {
    const original = `node_modules/\n${existing}\n`;
    writeFileSync(join(ws.project, '.gitignore'), original);
    ok(ws, ['link', 'demo-proj', 'demo']);
    assert.equal(readGitignore(ws), original, `con "${existing}" no debe añadir nada`);
  }
});

t('unlink quita la junction y su línea, conserva los finales de línea y la pool sobrevive', (ws) => {
  addDemo(ws);
  const original = 'a\r\nb\n';
  writeFileSync(join(ws.project, '.gitignore'), original);
  ok(ws, ['link', 'demo-proj', 'demo']);
  ok(ws, ['unlink', 'demo-proj', 'demo']);
  assert.equal(existsSync(ws.link), false);
  assert.ok(existsSync(join(ws.clone, 'skills', 'demo', 'SKILL.md')), 'la pool no debe perder contenido');
  assert.equal(readGitignore(ws), original);
  writeFileSync(join(ws.project, '.gitignore'), '.claude/\r\n/.claude/skills/demo/\r\nb');
  ok(ws, ['unlink', 'demo-proj', 'demo']);
  assert.equal(readGitignore(ws), '.claude/\r\nb', 'quita la variante con barras y deja .claude/');
});

t('link rechaza una entrada sin revisión salvo con --unreviewed', (ws) => {
  addDemo(ws, { review: false });
  rejected(ws, ['link', 'demo-proj', 'demo'], /no tiene revisión/);
  assert.equal(existsSync(ws.link), false);
  ok(ws, ['link', 'demo-proj', 'demo', '--unreviewed']);
  assert.ok(isLink(ws.link));
});

t('link rechaza el proyecto __home y una ruta igual al home, también con otra grafía', (ws) => {
  addDemo(ws);
  rejected(ws, ['link', '__home', 'demo'], /home no se admite/);
  rejected(ws, ['link', 'home-path', 'demo'], /home no se admite/);
  const variants = [ws.home, `${ws.home}\\`, `${ws.home}/`, ws.home.replace(/\\/g, '/')];
  if (IS_WINDOWS) variants.push(ws.home.toUpperCase(), ws.home.toLowerCase());
  for (const v of variants) rejected(ws, ['link', v, 'demo'], /home no se admite/);
  assert.equal(existsSync(join(ws.home, '.claude')), false);
  assert.equal(existsSync(join(ws.otherHome, '.claude')), false);
});

t('link rechaza un proyecto que es una junction al home o cuyo .claude apunta al del home', (ws) => {
  addDemo(ws);
  const viaJunction = join(ws.dir, 'proyecto-junction');
  symlinkSync(ws.home, viaJunction, 'junction');
  registerProject(ws, 'via-junction', viaJunction);
  rejected(ws, ['link', 'via-junction', 'demo'], /home no se admite/);
  const shared = join(ws.dir, 'proyecto-claude-compartido');
  mkdirSync(join(ws.home, '.claude'), { recursive: true });
  mkdirSync(shared);
  symlinkSync(join(ws.home, '.claude'), join(shared, '.claude'), 'junction');
  rejected(ws, ['link', shared, 'demo'], /resuelve a .* en el home/);
  assert.equal(existsSync(join(ws.home, '.claude', 'skills')), false, 'no debe crear nada en el home');
});

t('link rechaza si el HEAD del clon no coincide con el SHA fijado', (ws) => {
  addDemo(ws);
  git(['checkout', '--quiet', '--detach', REMOTE.sha2], ws.clone);
  rejected(ws, ['link', 'demo-proj', 'demo'], /no coincide con el SHA fijado/);
  assert.equal(existsSync(ws.link), false);
});

t('link, show y doctor rechazan un clon editado a través de la junction', (ws) => {
  addDemo(ws);
  ok(ws, ['link', 'demo-proj', 'demo']);
  const skillMd = join(ws.link, 'SKILL.md');
  chmodSync(skillMd, 0o644);
  writeFileSync(skillMd, 'instrucciones inyectadas desde un proyecto\n');
  for (const args of [['link', 'demo-proj', 'demo'], ['show', 'demo']]) rejected(ws, args, /cambios sin fijar/);
  const doctor = run(ws, ['doctor']);
  assert.equal(doctor.status, 1, doctor.out);
  assert.match(doctor.out, /cambios sin fijar/);
  git(['checkout', '--', '.'], ws.clone);
  writeFileSync(join(ws.link, 'nuevo.md'), 'fichero sin seguimiento\n');
  rejected(ws, ['link', 'demo-proj', 'demo'], /cambios sin fijar/);
  rmSync(join(ws.link, 'nuevo.md'));
  git(['update-index', '--assume-unchanged', 'skills/demo/SKILL.md'], ws.clone);
  rejected(ws, ['link', 'demo-proj', 'demo'], /cambios sin fijar.*oculto/);
});

t('link y unlink rechazan nombres con .. o separadores', (ws) => {
  addDemo(ws);
  for (const bad of ['..', '../demo', 'a/b', 'a\\b', 'demo..x']) {
    rejected(ws, ['link', 'demo-proj', bad], /nombre no válido/);
    rejected(ws, ['unlink', 'demo-proj', bad], /nombre no válido/);
  }
});

t('link rechaza una entrada cuya ruta resuelve fuera de la pool', (ws) => {
  addDemo(ws);
  const pool = readPool(ws);
  pool.entries[0].path = '../../..';
  writeFileSync(join(ws.poolRoot, 'pool.json'), JSON.stringify(pool));
  rejected(ws, ['link', 'demo-proj', 'demo'], /fuera de su clon/);
  assert.equal(existsSync(ws.link), false);
});

t('link y unlink no tocan una junction ya existente que apunta fuera de la pool', (ws) => {
  addDemo(ws);
  const outside = join(ws.dir, 'fuera');
  mkdirSync(outside);
  writeFileSync(join(outside, 'SKILL.md'), 'skill ajena\n');
  mkdirSync(join(ws.project, '.claude', 'skills'), { recursive: true });
  symlinkSync(outside, ws.link, 'junction');
  rejected(ws, ['link', 'demo-proj', 'demo'], /enlace ajeno a la pool/);
  rejected(ws, ['unlink', 'demo-proj', 'demo'], /apunta fuera de la pool/);
  assert.ok(isLink(ws.link), 'la junction ajena debe seguir');
  assert.equal(readFileSync(join(ws.link, 'SKILL.md'), 'utf8'), 'skill ajena\n');
});

t('unlink rechaza un destino que no es un enlace y no lo borra', (ws) => {
  addDemo(ws);
  mkdirSync(ws.link, { recursive: true });
  writeFileSync(join(ws.link, 'propio.md'), 'skill propia del proyecto\n');
  rejected(ws, ['unlink', 'demo-proj', 'demo'], /no es un enlace/);
  assert.ok(existsSync(join(ws.link, 'propio.md')), 'la carpeta real debe sobrevivir');
  rejected(ws, ['link', 'demo-proj', 'demo'], /no es un enlace/);
});

// --- show / update / doctor ------------------------------------------------------

t('show imprime el SKILL.md y los ficheros; sin revisión exige --unreviewed', (ws) => {
  addDemo(ws, { review: false });
  rejected(ws, ['show', 'demo'], /no tiene revisión/);
  const { out } = ok(ws, ['show', 'demo', '--unreviewed']);
  assert.match(out, /Cuerpo de demo/);
  assert.match(out, /ref\.md/);
});

t('update sin --accept no cambia nada; con --accept re-fija y deja review null', (ws) => {
  addDemo(ws);
  const preview = ok(ws, ['update', 'demo']);
  assert.match(preview.out, /ref\.md/);
  assert.equal(readPool(ws).entries[0].sha, REMOTE.sha1);
  ok(ws, ['update', 'demo', '--accept']);
  const [entry] = readPool(ws).entries;
  assert.equal(entry.sha, REMOTE.sha2);
  assert.equal(entry.review, null);
  assert.equal(git(['rev-parse', 'HEAD'], join(ws.poolRoot, 'repos', `demo@${REMOTE.sha2.slice(0, 7)}`)), REMOTE.sha2);
  rejected(ws, ['link', 'demo-proj', 'demo'], /no tiene revisión/);
});

t('doctor sale con 0 si la pool y los enlaces están bien', (ws) => {
  addDemo(ws);
  ok(ws, ['link', 'demo-proj', 'demo']);
  assert.match(ok(ws, ['doctor']).out, /sin problemas/);
});

t('doctor detecta una junction rota y un SHA cambiado', (ws) => {
  addDemo(ws);
  addDemo(ws, { name: 'otra' });
  ok(ws, ['link', 'demo-proj', 'demo']);
  renameSync(ws.clone, `${ws.clone}-movido`);
  git(['checkout', '--quiet', '--detach', REMOTE.sha2], join(ws.poolRoot, 'repos', `otra@${REMOTE.sha1.slice(0, 7)}`));
  const r = run(ws, ['doctor']);
  assert.notEqual(r.status, 0, r.out);
  assert.match(r.out, /enlace roto/);
  assert.match(r.out, /otra: el HEAD del clon .* no coincide con el SHA fijado/);
  assert.match(r.out, /demo: entrada sin carpeta/);
  assert.match(r.out, /carpeta sin entrada/);
});

// --- skills propias (~/.claude/skills/_disabled) ---------------------------------

function makeOwnSkill(ws, name = 'mia') {
  const dir = join(ws.home, '.claude', 'skills', '_disabled', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: skill propia\n---\nCuerpo propio.\n`);
  return dir;
}

t('list y show incluyen las skills propias de _disabled sin pedir revisión', (ws) => {
  makeOwnSkill(ws);
  mkdirSync(join(ws.home, '.claude', 'skills', '_disabled', 'sin-skill-md'), { recursive: true });
  const list = ok(ws, ['list']).out;
  assert.match(list, /mia\s+propia/);
  assert.doesNotMatch(list, /sin-skill-md/);
  assert.deepEqual(JSON.parse(ok(ws, ['list', '--json']).out).own.map((s) => s.name), ['mia']);
  assert.match(ok(ws, ['show', 'mia']).out, /Cuerpo propio/);
});

t('link y unlink de una skill propia: junction a _disabled y línea del .gitignore', (ws) => {
  const own = makeOwnSkill(ws);
  const link = join(ws.project, '.claude', 'skills', 'mia');
  ok(ws, ['link', 'demo-proj', 'mia']);
  assert.ok(isLink(link));
  assert.equal(readFileSync(join(link, 'SKILL.md'), 'utf8'), readFileSync(join(own, 'SKILL.md'), 'utf8'));
  assert.match(readGitignore(ws), /^\.claude\/skills\/mia$/m);
  ok(ws, ['unlink', 'demo-proj', 'mia']);
  assert.equal(existsSync(link), false);
  assert.ok(existsSync(join(own, 'SKILL.md')), 'unlink no toca la skill propia');
});

t('la pool gana a una skill propia con el mismo nombre', (ws) => {
  addDemo(ws);
  makeOwnSkill(ws, 'demo');
  assert.match(ok(ws, ['show', 'demo']).out, /Cuerpo de demo/);
});

t('show y link rechazan un nombre que no está ni en la pool ni entre las propias', (ws) => {
  rejected(ws, ['show', 'nada'], /ni en la pool ni entre tus skills/);
  rejected(ws, ['link', 'demo-proj', 'nada'], /ni en la pool ni entre tus skills/);
});

t('link de una skill propia también rechaza el home', (ws) => {
  makeOwnSkill(ws);
  rejected(ws, ['link', '__home', 'mia'], /home/);
});
