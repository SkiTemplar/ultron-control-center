// project-new.selftest.mjs — checks herméticos del flag `--socratic` de
// scripts/project-new.mjs (auditoría 2026-10-17: `--socratic uni` se rechazaba
// aunque `uni` es un modo válido de project-socratic.mjs, y en un proyecto ya
// registrado el flag se ignoraba en silencio). Cada test usa un registro y un
// directorio de tableros temporales por override de entorno: nunca toca el
// cockpit real del usuario.
//
// Uso: node scripts/project-new.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'project-new.mjs');

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'project-new-selftest-'));
  const projectDir = join(dir, 'Demo');
  mkdirSync(projectDir, { recursive: true });
  const registry = join(dir, 'projects.json');
  const env = {
    ...process.env,
    ULTRON_PROJECTS_JSON_OVERRIDE: registry,
    ULTRON_BOARDS_DIR_OVERRIDE: join(dir, 'boards'),
  };
  return { dir, projectDir, registry, env };
}

function run(args, env) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, timeout: 30_000 });
}

function socraticOf(registry, id) {
  const data = JSON.parse(readFileSync(registry, 'utf8'));
  return data.projects.find((p) => p.id === id)?.socratic;
}

for (const mode of ['strict', 'light', 'off', 'uni']) {
  test(`--socratic ${mode} se acepta y se guarda en el alta`, () => {
    const ws = makeWorkspace();
    try {
      const r = run(['--name', 'Demo', '--path', ws.projectDir, '--socratic', mode], ws.env);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(socraticOf(ws.registry, 'demo'), mode);
    } finally {
      rmSync(ws.dir, { recursive: true, force: true });
    }
  });
}

test('--socratic con un modo inexistente falla sin escribir el registro', () => {
  const ws = makeWorkspace();
  try {
    const r = run(['--name', 'Demo', '--path', ws.projectDir, '--socratic', 'estricto'], ws.env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--socratic admite strict \| light \| off \| uni/);
    assert.throws(() => readFileSync(ws.registry, 'utf8'));
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});

test('--socratic sobre un proyecto ya registrado actualiza el modo (no se ignora)', () => {
  const ws = makeWorkspace();
  try {
    assert.equal(run(['--name', 'Demo', '--path', ws.projectDir], ws.env).status, 0);
    assert.equal(socraticOf(ws.registry, 'demo'), undefined);
    const r = run(['--name', 'Demo', '--path', ws.projectDir, '--socratic', 'uni'], ws.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(socraticOf(ws.registry, 'demo'), 'uni');
  } finally {
    rmSync(ws.dir, { recursive: true, force: true });
  }
});
