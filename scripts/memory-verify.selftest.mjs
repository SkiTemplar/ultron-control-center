// Selftest de scripts/memory-verify.mjs y hooks/scripts/lib/project-tracker.js (sin red).
// Uso: node scripts/memory-verify.selftest.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verify, repoPathCandidate, staleRefs } from './memory-verify.mjs';

const require = createRequire(import.meta.url);
const { externalTrackerFor } = require('../hooks/scripts/lib/project-tracker.js');

const ROOT = mkdtempSync(join(tmpdir(), 'memory-verify-'));
const REPO = join(ROOT, 'repo');
const MEM = join(ROOT, 'memory');

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

function git(...args) {
  execFileSync('git', ['-C', REPO, ...args], { stdio: 'ignore' });
}

mkdirSync(join(REPO, 'Docs'), { recursive: true });
mkdirSync(join(REPO, 'Content'), { recursive: true });
mkdirSync(MEM, { recursive: true });
writeFileSync(join(REPO, 'Docs', 'Plan.md'), 'plan');
writeFileSync(join(REPO, 'Content', 'DT_Items.uasset'), 'bin');
git('init', '-q', '-b', 'dev');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');

run('repoPathCandidate: solo rutas bajo un directorio de la raiz', () => {
  const top = new Set(['Docs', 'Content']);
  assert.equal(repoPathCandidate('Docs/Plan.md', top), 'Docs/Plan.md');
  assert.equal(repoPathCandidate('Docs\\Plan.md', top), 'Docs/Plan.md');
  // NEGATIVO: comandos, URL, rutas absolutas, de home y de otros directorios no se comprueban.
  for (const span of ['git diff base...HEAD', 'https://x.y/Docs/a', 'C:/Docs/a', '~/Docs/a', 'Otro/a.md', 'Docs', 'Docs/<n>.md']) {
    assert.equal(repoPathCandidate(span, top), '', span);
  }
});

run('staleRefs: rama borrada y ruta borrada; lo que existe no sale', () => {
  const refs = staleRefs('todo en la rama `macro-update`; la rama `dev` sigue. Ver `Docs/Plan.md` y `Docs/Viejo.md`.', {
    branches: new Set(['dev']),
    topDirs: new Set(['Docs']),
    exists: (rel) => rel === 'Docs/Plan.md',
  });
  assert.deepEqual(refs, [
    { kind: 'branch', value: 'macro-update' },
    { kind: 'path', value: 'Docs/Viejo.md' },
  ]);
});

run('verify: informa solo de las memorias con referencias caducadas', () => {
  writeFileSync(join(MEM, 'MEMORY.md'), '- indice con `Docs/NoExiste.md`');
  writeFileSync(join(MEM, 'viva.md'), 'Rama `dev`, plan en `Docs/Plan.md`, tabla `Content/DT_Items` (asset sin extension).');
  writeFileSync(join(MEM, 'caducada.md'), 'Trabajo en la rama `macro-update`; script `Docs/Borrado.md`.');
  const report = verify({ repo: REPO, memoryDir: MEM });
  assert.equal(report.checked, 2, 'MEMORY.md no cuenta');
  assert.deepEqual(report.stale.map((s) => s.file), ['caducada.md']);
  assert.deepEqual(report.stale[0].refs.map((r) => `${r.kind}:${r.value}`), ['branch:macro-update', 'path:Docs/Borrado.md']);
});

run('project-tracker: la etiqueta tracker:<x> declara el tracker externo', () => {
  const registry = join(ROOT, 'projects.json');
  writeFileSync(registry, JSON.stringify({ projects: [{ id: 'a', tags: ['juego', 'Tracker:GitHub'] }, { id: 'b', tags: ['juego'] }] }));
  assert.equal(externalTrackerFor('a', registry), 'github');
  // NEGATIVO: sin etiqueta, proyecto desconocido o registro ausente -> kanban de ULTRON.
  assert.equal(externalTrackerFor('b', registry), '');
  assert.equal(externalTrackerFor('zzz', registry), '');
  assert.equal(externalTrackerFor('a', join(ROOT, 'no-existe.json')), '');
});

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fallos`);
process.exit(failed ? 1 : 0);
