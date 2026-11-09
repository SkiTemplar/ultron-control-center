#!/usr/bin/env node
/**
 * usage-pace-guard.selftest.mjs — lib/usage-pace.js y el hook usage-pace-guard.js.
 * Hermetico: snapshot del statusline y estado en un directorio temporal.
 *
 * Uso: node hooks/scripts/usage-pace-guard.selftest.mjs   (exit 0 = verde)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const HOOK = join(__dirname, 'usage-pace-guard.js');
const ROOT = mkdtempSync(join(tmpdir(), 'usage-pace-'));
const PAYLOAD = join(ROOT, 'payload.json');
process.env.ULTRON_USAGE_PACE_PAYLOAD = PAYLOAD;
process.env.ULTRON_USAGE_PACE_STATE_DIR = join(ROOT, 'state');
delete process.env.ULTRON_USAGE_PACE;
delete process.env.CLAUDE_NO_HOOKS;

const { windowPace, toEpochSeconds, paceAll } = require(join(__dirname, 'lib', 'usage-pace.js'));
const { decide } = require(HOOK);

let passed = 0;
let failed = 0;
function run(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

const NOW = 1_790_000_000; // epoch s fijo
const H = 3600;
const D = 86400;
let sid = 0;

function payload(rateLimits) {
  writeFileSync(PAYLOAD, JSON.stringify({ rate_limits: rateLimits }));
  utimesSync(PAYLOAD, NOW, NOW);
}

console.log('usage-pace (lib)');

run('5 h: 50 % usado con 4 h restantes -> por encima del ritmo (proyeccion 250 %)', () => {
  const p = windowPace('five_hour', 50, NOW + 4 * H, NOW);
  assert.equal(Math.round(p.elapsedPct), 20);
  assert.equal(Math.round(p.projectedPct), 250);
  assert.equal(p.over, true);
});

run('semanal: 50 % un dia despues del reset -> por encima del ritmo', () => {
  const p = windowPace('seven_day', 50, NOW + 6 * D, NOW);
  assert.equal(p.over, true);
});

run('semanal: 50 % a mitad de semana -> dentro del ritmo', () => {
  const p = windowPace('seven_day', 40, NOW + 3.5 * D, NOW);
  assert.equal(p.over, false);
});

run('suelo: 10 % en los primeros minutos no avisa', () => {
  const p = windowPace('five_hour', 10, NOW + 5 * H - 300, NOW);
  assert.ok(p.projectedPct > 100);
  assert.equal(p.over, false);
});

run('cuota agotada (100 %) no avisa: ya no hay nada que reducir', () => {
  assert.equal(windowPace('five_hour', 100, NOW + 4 * H, NOW).over, false);
});

run('resets_at en epoch s, epoch ms e ISO dan lo mismo', () => {
  const iso = new Date((NOW + H) * 1000).toISOString();
  assert.equal(toEpochSeconds(NOW + H), NOW + H);
  assert.equal(toEpochSeconds((NOW + H) * 1000), NOW + H);
  assert.equal(toEpochSeconds(iso), NOW + H);
});

run('clave desconocida o resets_at invalido -> null', () => {
  assert.equal(windowPace('monthly', 50, NOW + H, NOW), null);
  assert.equal(windowPace('five_hour', 50, 'no-fecha', NOW), null);
  assert.equal(windowPace('five_hour', undefined, NOW + H, NOW), null);
});

run('paceAll ignora ventanas nulas y resuelve seven_day_opus como semanal', () => {
  const r = paceAll({ five_hour: null, seven_day_opus: { used_percentage: 60, resets_at: NOW + 6 * D } }, NOW);
  assert.deepEqual(Object.keys(r), ['seven_day_opus']);
  assert.equal(r.seven_day_opus.over, true);
});

run('5 h y semanal avisan con la misma regla de ritmo, sin techo absoluto', () => {
  const h = windowPace('five_hour', 22, NOW + 4 * H, NOW);
  assert.equal(h.over, true);
  assert.equal(h.alert, true, 'ritmo alto en 5 h avisa');
  const atPace = windowPace('five_hour', 40, NOW + 2 * H, NOW); // 60 % transcurrido
  assert.equal(atPace.alert, false, '40 % al ritmo no avisa: ya no hay techo del 25 %');
  assert.equal('cap' in atPace, false);
  assert.equal(windowPace('seven_day', 50, NOW + 6 * D, NOW).alert, true);
});

console.log('usage-pace-guard (hook)');

run('por encima del ritmo -> aviso al agente y al usuario', () => {
  payload({ seven_day: { used_percentage: 50, resets_at: NOW + 6 * D } });
  const out = decide({ session_id: `s${sid++}` }, { now: NOW * 1000 });
  assert.match(out.systemMessage, /REDUCIR USO/);
  assert.match(out.hookSpecificOutput.additionalContext, /50 % usado con 14 %/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

run('dentro del ritmo -> silencio', () => {
  payload({ seven_day: { used_percentage: 30, resets_at: NOW + 2 * D } });
  assert.equal(decide({ session_id: `s${sid++}` }, { now: NOW * 1000 }), null);
});

run('misma ventana: avisa una vez; repite solo si la proyeccion sube 50 puntos', () => {
  const s = `s${sid++}`;
  payload({ seven_day: { used_percentage: 50, resets_at: NOW + 6 * D } });
  assert.ok(decide({ session_id: s }, { now: NOW * 1000 }));
  assert.equal(decide({ session_id: s }, { now: NOW * 1000 }), null);
  payload({ seven_day: { used_percentage: 70, resets_at: NOW + 6 * D } }); // 350 -> 490 %
  assert.ok(decide({ session_id: s }, { now: NOW * 1000 }));
});

run('5 h por encima del ritmo -> aviso al agente y al usuario', () => {
  payload({ five_hour: { used_percentage: 22, resets_at: NOW + 4 * H } });
  const out = decide({ session_id: `s${sid++}` }, { now: NOW * 1000 });
  assert.match(out.systemMessage, /ventana de 5 h: 22 % usado con 20 % de ventana transcurrida/);
  assert.match(out.hookSpecificOutput.additionalContext, /ventana de 5 h/);
});

run('5 h al 30 % yendo al ritmo -> silencio (sin techo absoluto)', () => {
  payload({ five_hour: { used_percentage: 30, resets_at: NOW + 1 * H } }); // 80 % transcurrido
  assert.equal(decide({ session_id: `s${sid++}` }, { now: NOW * 1000 }), null);
});

run('5 h por encima del ritmo pero bajo el suelo del 15 % -> silencio', () => {
  payload({ five_hour: { used_percentage: 12, resets_at: NOW + 4.5 * H } });
  assert.equal(decide({ session_id: `s${sid++}` }, { now: NOW * 1000 }), null);
});

run('5 h y semanal por encima del ritmo -> las dos en el mismo aviso', () => {
  payload({
    five_hour: { used_percentage: 35, resets_at: NOW + 4 * H },
    seven_day: { used_percentage: 55, resets_at: NOW + 6 * D },
  });
  const out = decide({ session_id: `s${sid++}` }, { now: NOW * 1000 });
  assert.match(out.hookSpecificOutput.additionalContext, /ventana de 5 h/);
  assert.match(out.hookSpecificOutput.additionalContext, /semanal/);
});

run('snapshot viejo (>15 min) -> silencio', () => {
  payload({ seven_day: { used_percentage: 90, resets_at: NOW + 6 * D } });
  assert.equal(decide({ session_id: `s${sid++}` }, { now: (NOW + 16 * 60) * 1000 }), null);
});

run('sin snapshot o ULTRON_USAGE_PACE=0 -> silencio', () => {
  rmSync(PAYLOAD, { force: true });
  assert.equal(decide({ session_id: `s${sid++}` }, { now: NOW * 1000 }), null);
  payload({ seven_day: { used_percentage: 90, resets_at: NOW + 6 * D } });
  process.env.ULTRON_USAGE_PACE = '0';
  try {
    assert.equal(decide({ session_id: `s${sid++}` }, { now: NOW * 1000 }), null);
  } finally {
    delete process.env.ULTRON_USAGE_PACE;
  }
});

run('end-to-end: el proceso sale 0 y emite JSON valido', () => {
  const nowSec = Date.now() / 1000;
  writeFileSync(PAYLOAD, JSON.stringify({ rate_limits: { seven_day: { used_percentage: 50, resets_at: nowSec + 6 * D } } }));
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ session_id: 'e2e' }), encoding: 'utf8', env: process.env });
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /REDUCIR USO/);
});

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${passed} ok, ${failed} fallos`);
process.exit(failed ? 1 : 0);
