// registry-backup.selftest.mjs — retención de las copias de cockpit/projects.json.
//
// Hallazgo N5 (auditoría 2026-10-23): cada escritura del registro dejaba un
// `projects.json.bak-<fecha>` y nadie los borraba (36 copias). Las copias se
// crean ahora con backupWithRetention, que conserva las N más recientes.
//
// Uso: node scripts/lib/registry-backup.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backupWithRetention, DEFAULT_KEEP } from './registry-backup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOCRATIC = join(__dirname, '..', 'project-socratic.mjs');

function workspace(t, oldBackups) {
  const dir = mkdtempSync(join(tmpdir(), 'registry-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const registry = join(dir, 'projects.json');
  writeFileSync(registry, JSON.stringify({ projects: [{ id: 'demo', path: dir }] }), 'utf8');
  const base = Date.now() / 1000 - 10_000;
  oldBackups.forEach((name, i) => {
    const p = join(dir, name);
    writeFileSync(p, `viejo ${i}`, 'utf8');
    utimesSync(p, base + i, base + i);
  });
  // Ajenos que la poda no debe tocar.
  writeFileSync(join(dir, 'projects.json.tmp'), 'tmp', 'utf8');
  writeFileSync(join(dir, 'otro.json.bak'), 'otro', 'utf8');
  return { dir, registry };
}

const backups = (dir) => readdirSync(dir).filter((n) => n.startsWith('projects.json.bak')).sort();

test('crea la copia con fecha y conserva solo las `keep` más recientes', (t) => {
  const old = ['projects.json.bak', 'projects.json.bak-dvj-ide'];
  for (let i = 0; i < 8; i++) old.push(`projects.json.bak-2026-09-0${i + 1}T10-00-00-000Z`);
  const ws = workspace(t, old);

  const r = backupWithRetention(ws.registry, { keep: 4, now: new Date('2026-10-23T09:00:00.000Z') });

  assert.equal(r.backup, `${ws.registry}.bak-2026-10-23T09-00-00-000Z`);
  assert.equal(readFileSync(r.backup, 'utf8'), readFileSync(ws.registry, 'utf8'));
  const left = backups(ws.dir);
  assert.equal(left.length, 4, left.join(', '));
  assert.ok(left.includes('projects.json.bak-2026-10-23T09-00-00-000Z'));
  // Las 3 más recientes por mtime de las viejas: 06, 07 y 08 de septiembre.
  assert.ok(left.includes('projects.json.bak-2026-09-08T10-00-00-000Z'), left.join(', '));
  assert.ok(!left.includes('projects.json.bak'), 'la .bak más antigua se poda');
  assert.equal(r.pruned.length, 7);
  assert.deepEqual(r.failed, []);
  assert.ok(existsSync(join(ws.dir, 'projects.json.tmp')), 'no toca el .tmp');
  assert.ok(existsSync(join(ws.dir, 'otro.json.bak')), 'no toca copias de otros ficheros');
});

test('con menos copias que el tope no borra nada (caso negativo)', (t) => {
  const ws = workspace(t, ['projects.json.bak']);
  const r = backupWithRetention(ws.registry, { keep: 4 });
  assert.equal(backups(ws.dir).length, 2);
  assert.deepEqual(r.pruned, []);
});

test('sin registro no crea copia ni poda', (t) => {
  const ws = workspace(t, ['projects.json.bak']);
  rmSync(ws.registry);
  const r = backupWithRetention(ws.registry, { keep: 0 });
  assert.equal(r.backup, null);
  assert.deepEqual(backups(ws.dir), ['projects.json.bak']);
});

test('project-socratic.mjs poda al crear su copia', (t) => {
  const old = Array.from({ length: DEFAULT_KEEP + 5 }, (_, i) => `projects.json.bak-old-${String(i).padStart(2, '0')}`);
  const ws = workspace(t, old);
  const r = spawnSync(process.execPath, [SOCRATIC, 'demo', 'light'], {
    encoding: 'utf8',
    env: { ...process.env, ULTRON_PROJECTS_JSON_OVERRIDE: ws.registry },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(backups(ws.dir).length, DEFAULT_KEEP, backups(ws.dir).join(', '));
  assert.equal(JSON.parse(readFileSync(ws.registry, 'utf8')).projects[0].socratic, 'light');
});
