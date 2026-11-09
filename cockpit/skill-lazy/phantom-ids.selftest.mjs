#!/usr/bin/env node
/**
 * phantom-ids.selftest.mjs — ningún id que el routing pueda proponer apunta a
 * algo inexistente.
 *
 * Contexto (2026-10-03): tras desinstalar superpowers, agent-skills,
 * playwright y frontend-design, y con 37 agentes como `.md.disabled`, el
 * dispatcher seguía sugiriendo 51 ids que Claude Code no podía invocar. El
 * hint mandaba al modelo a un no-op silencioso.
 *
 * Bloques:
 *   1. Inventario real: cada id fijo de v2 (PERSONAS, PLUGINS, AGENTS,
 *      PLANNING_LAZY_SKILLS), de config/intent-rules.yaml y de los rosters de
 *      cockpit/projects existe en ~/.claude con el tipo correcto. Depende del
 *      ~/.claude de la máquina: por eso este selftest es local-only.
 *   2. Caso negativo: el mismo inventario con un id falso inyectado en una
 *      copia en memoria (y un id de skill usado como agente) se detecta.
 *   3. Resolver sobre un árbol temporal (hermético): skill activa, lazy,
 *      archivada, agente activo y desactivado, plugin instalado, apagado y
 *      sincronizado.
 *   4. Emisión e2e: v2 ejecutado como hook con HOME y fixtures temporales
 *      descarta el agente fantasma de un roster, deja `phantom_id_dropped` en
 *      el log y sigue proponiendo el agente real.
 *
 * Uso: node cockpit/skill-lazy/phantom-ids.selftest.mjs
 */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const requireCjs = createRequire(import.meta.url);
const HERE = import.meta.dirname;
const ROOT = path.resolve(HERE, '..', '..');
const { createResolver, collectStaticIds, findPhantoms } = requireCjs('./id-resolver.js');
const v2 = requireCjs('./routing-dispatcher.v2.js');

let passed = 0;
let failed = 0;
function assert(label, condition, extra) {
  if (condition) {
    console.log('  PASS:', label);
    passed++;
  } else {
    console.log('  FAIL:', label, extra !== undefined ? '-> ' + JSON.stringify(extra) : '');
    failed++;
  }
}

function write(file, text = '---\nname: x\ndescription: x\n---\n') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// ---------------------------------------------------------------------------
console.log('\n=== 1. Inventario real: 0 ids fantasma ===');
const entries = collectStaticIds({
  v2,
  intentRulesPath: path.join(ROOT, 'config', 'intent-rules.yaml'),
  projectsDir: path.join(ROOT, 'cockpit', 'projects'),
});
const realResolver = createResolver();
const phantoms = findPhantoms(entries, realResolver);
const bySource = (src) => entries.filter((e) => e.source.startsWith(src)).length;
assert('el inventario no está vacío (v2 + intent-rules)', bySource('v2:') > 50 && bySource('intent-rules') > 10, {
  v2: bySource('v2:'),
  intent: bySource('intent-rules'),
});
assert(
  `0 fantasmas entre ${entries.length} referencias`,
  phantoms.length === 0,
  phantoms.map((p) => `${p.id} (${p.source}, ${p.kind}: ${realResolver.kindOf(p.id) || 'no existe'})`),
);

// ---------------------------------------------------------------------------
console.log('\n=== 2. Caso negativo: un id falso se detecta ===');
const FAKE = 'fantasma-inexistente-7f3a';
const withFake = [...entries, { id: FAKE, source: 'v2:PLUGINS', kind: 'skill' }];
const caught = findPhantoms(withFake, realResolver).map((p) => p.id);
assert('el id falso inyectado en la copia aparece como fantasma', caught.includes(FAKE), caught);
assert('el original no se ha mutado', !entries.some((e) => e.id === FAKE));
const SKILL_ONLY = 'hiper-plans';
const asAgent = findPhantoms([{ id: SKILL_ONLY, source: 'v2:AGENTS', kind: 'agent' }], realResolver);
assert(`una skill (${SKILL_ONLY}) declarada como agente se detecta`, asAgent.length === 1, asAgent);
const fakePlugin = findPhantoms([{ id: 'superpowers:brainstorming', source: 'intent-rules:skill', kind: 'skill' }], realResolver);
assert('una skill de plugin desinstalado (superpowers:*) se detecta', fakePlugin.length === 1, fakePlugin);

// ---------------------------------------------------------------------------
console.log('\n=== 3. Resolver sobre árbol temporal ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-ids-'));
try {
  const claude = path.join(tmp, '.claude');
  write(path.join(claude, 'skills', 'activa', 'SKILL.md'));
  write(path.join(claude, 'skills', '_disabled', 'lazy', 'SKILL.md'));
  write(path.join(claude, 'skills', '_archived', 'retirada', 'SKILL.md'));
  write(path.join(claude, 'skills', 'synced', 'org', 'sincro', 'SKILL.md'));
  write(path.join(claude, 'agents', 'agente.md'));
  write(path.join(claude, 'agents', 'apagado.md.disabled'));
  const pOn = path.join(tmp, 'cache', 'pon', '1.0.0');
  const pOff = path.join(tmp, 'cache', 'poff', '1.0.0');
  write(path.join(pOn, 'skills', 'sk', 'SKILL.md'));
  write(path.join(pOn, 'agents', 'ag.md'));
  write(path.join(pOn, 'commands', 'cmd.md'));
  write(path.join(pOff, 'skills', 'sk', 'SKILL.md'));
  write(
    path.join(claude, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'pon@m': [{ installPath: pOn }], 'poff@m': [{ installPath: pOff }] } }),
  );
  write(path.join(claude, 'settings.json'), JSON.stringify({ enabledPlugins: { 'pon@m': true, 'poff@m': false } }));
  write(path.join(claude, 'plugins', 'synced', 'org', 'eng~g2', 'skills', 'dbg', 'SKILL.md'));

  const r = createResolver({ claudeDir: claude });
  const cases = [
    ['activa', 'skill'],
    ['lazy', 'skill'],
    ['retirada', null],
    ['sincro', 'synced-skill'],
    ['agente', 'agent'],
    ['apagado', null],
    ['Explore', 'builtin-agent'],
    ['pon:sk', 'plugin-skill'],
    ['pon:ag', 'plugin-agent'],
    ['pon:cmd', 'plugin-command'],
    ['sk', 'plugin-skill'],
    ['poff:sk', null],
    ['pon:no-existe', null],
    ['eng:dbg', 'plugin-skill'],
    ['../agents/agente', null],
    ['', null],
  ];
  for (const [id, want] of cases) {
    assert(`kindOf(${JSON.stringify(id)}) = ${want}`, r.kindOf(id) === want, r.kindOf(id));
  }
  assert('isEmittable: skill con etiqueta de agente = false', r.isEmittable('activa', 'agent') === false);
  assert('isEmittable: agente de plugin con etiqueta de agente = true', r.isEmittable('pon:ag', 'agent') === true);

  // -------------------------------------------------------------------------
  console.log('\n=== 4. Emisión e2e: v2 como hook descarta el fantasma y lo registra ===');
  const fix = path.join(tmp, 'fix');
  write(path.join(fix, 'claude-agents', 'agente-real.md'));
  write(
    path.join(fix, 'projects', 'demo', 'agent-roster.json'),
    JSON.stringify({ entries: [{ name: 'agente-real' }, { name: 'agente-fantasma' }] }),
  );
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ULTRON_ROUTING_FIXTURES: fix };
  const runHook = (prompt) => {
    const res = spawnSync(process.execPath, [path.join(HERE, 'routing-dispatcher.v2.js')], {
      input: JSON.stringify({ prompt, session_id: 'phantom-selftest' }),
      env,
      encoding: 'utf8',
      timeout: 30000,
    });
    try {
      return JSON.parse(res.stdout).hookSpecificOutput.additionalContext || '';
    } catch (_) {
      return `<<salida no JSON: ${res.stdout} ${res.stderr}>>`;
    }
  };
  const ghostCtx = runHook('agente-fantasma revisa este modulo');
  assert('el agente fantasma del roster no se sugiere', !ghostCtx.includes('agente-fantasma'), ghostCtx);
  const realCtx = runHook('agente-real revisa este modulo');
  assert('el agente real del roster sí se sugiere', realCtx.includes('agent:agente-real'), realCtx);
  const logFile = path.join(home, '.claude', 'logs', 'routing-dispatcher.jsonl');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const dropped = log
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.msg === 'phantom_id_dropped');
  assert(
    'el log registra phantom_id_dropped con el id',
    dropped.some((e) => e.id === 'agente-fantasma'),
    dropped,
  );
  assert('el agente real no aparece como descartado', !dropped.some((e) => e.id === 'agente-real'), dropped);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('\n=== Summary ===');
console.log('  Passed:', passed);
console.log('  Failed:', failed);
process.exitCode = failed > 0 ? 1 : 0;
