#!/usr/bin/env node
/**
 * sync-registry.selftest.mjs — regression guard for the enabled-plugin filter
 * in sync-registry.js.
 *
 * Contexto (2026-09-14): tras desinstalar commit-commands, feature-dev,
 * code-review y skill-creator (plugins@claude-plugins-official) y el
 * marketplace ecc, sus directorios de cache siguieron en disco. skills-registry.json
 * arrastraba 4 entradas fantasma porque nunca se habia re-sincronizado, no
 * porque el filtro estuviera roto. Este harness fija en un test el
 * comportamiento correcto de `isNamespacedIdEnabled` para que una regresion
 * futura (ej. alguien vuelve a comparar solo contra disco) se detecte.
 *
 * Uso: node cockpit/skill-lazy/sync-registry.selftest.mjs
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const requireCjs = createRequire(import.meta.url);
const { isNamespacedIdEnabled } = requireCjs('./sync-registry.js');

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log('  PASS:', label);
    passed++;
  } else {
    console.log('  FAIL:', label);
    failed++;
  }
}

console.log('\n=== isNamespacedIdEnabled ===');

const ENABLED = ['superpowers@claude-plugins-official', 'codex@openai-codex'];

// Caso negativo: plugin ausente de enabledPlugins (desinstalado) -> filtrada.
assert(
  'skill de un plugin desinstalado (commit-commands) NO pasa el filtro',
  isNamespacedIdEnabled('commit-commands:commit', ENABLED) === false
);
assert(
  'skill de un plugin desinstalado (ecc) NO pasa el filtro',
  isNamespacedIdEnabled('ecc:hookify', ENABLED) === false
);

// Caso positivo: plugin presente y activo -> pasa.
assert(
  'skill de un plugin instalado y activo SI pasa el filtro',
  isNamespacedIdEnabled('superpowers:test-driven-development', ENABLED) === true
);

// Id sin namespace (skill local, sin plugin) -> siempre pasa.
assert(
  'skill local sin ":" siempre pasa el filtro',
  isNamespacedIdEnabled('skill-creator', ENABLED) === true
);

// Fail-open: settings.json ilegible (enabled === null) -> no oculta nada.
assert(
  'settings.json ilegible (enabled=null) no oculta la skill (fail-open)',
  isNamespacedIdEnabled('commit-commands:commit', null) === true
);

// Check 13.3 (2026-11-01): ~/.ultron/skills no lo carga Claude Code; una skill sin
// copia en ~/.claude no se puede invocar y registrarla crea un fantasma.
console.log('\n=== Descubrimiento en ~/.ultron/skills ===');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-registry-'));
try {
  const skill = (...parts) => {
    const dir = path.join(home, ...parts);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n');
  };
  skill('.ultron', 'skills', 'plantilla-sin-copia');
  skill('.ultron', 'skills', 'con-copia');
  skill('.claude', 'skills', '_disabled', 'con-copia');
  const script = path.join(import.meta.dirname, 'sync-registry.js');
  const r = spawnSync(process.execPath, [script, '--detect-only'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  const ids = r.status === 0 ? JSON.parse(r.stdout).map((a) => a.id) : [];
  assert('skill de ~/.ultron/skills sin copia en ~/.claude no se detecta', r.status === 0 && !ids.includes('plantilla-sin-copia'));
  assert('skill con copia en ~/.claude sí se detecta', ids.includes('con-copia'));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('\n=== Summary ===');
console.log('  Passed:', passed);
console.log('  Failed:', failed);
process.exitCode = failed > 0 ? 1 : 0;
