// project-usage.selftest.mjs — checks herméticos del agregador de uso por proyecto
// (scripts/lib/usage-transcripts.mjs y scripts/project-usage.mjs). Usa un directorio
// temporal de transcripts y de cache: nunca lee ~/.claude ni escribe en ~/.ultron.
//
// Uso: node scripts/project-usage.selftest.mjs   (exit 0 = verde)

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeProjectDir, ownerOfDir, costOf, projectUsage } from './lib/usage-transcripts.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'project-usage.mjs');
const NOW = Date.parse('2026-09-28T12:00:00Z');
const at = (isoOrOffsetDays) => (typeof isoOrOffsetDays === 'number' ? new Date(NOW - isoOrOffsetDays * 86400000).toISOString() : isoOrOffsetDays);

/** Linea de transcript de un mensaje del asistente. */
function line({ id, model = 'claude-sonnet-5-5', out = 1000, ts = at(0) }) {
  return JSON.stringify({
    timestamp: ts,
    message: {
      id,
      model,
      usage: {
        input_tokens: 1000,
        output_tokens: out,
        cache_read_input_tokens: 10000,
        cache_creation_input_tokens: 2000,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2000 },
      },
    },
  });
}
// Coste a mano de una llamada de sonnet-5-5 con esos tokens: (1000*2 + 1000*10 + 10000*0.2 + 2000*2*2) / 1e6
const CALL_COST = 0.022;

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'project-usage-selftest-'));
  const claude = join(dir, 'claude-projects');
  const cache = join(dir, 'cache');
  const registry = join(dir, 'projects.json');
  mkdirSync(claude, { recursive: true });
  writeFileSync(
    registry,
    JSON.stringify([
      { id: 'demo', name: 'Demo', path: 'C:\\fx\\demo' },
      { id: 'demo-hijo', name: 'Demo hijo', path: 'C:\\fx\\demo\\hijo' },
      { id: 'otro', name: 'Otro', path: 'C:\\fx\\otro' },
    ]),
  );
  const env = {
    ULTRON_CLAUDE_PROJECTS_DIR: claude,
    ULTRON_USAGE_CACHE_DIR: cache,
    ULTRON_PROJECTS_JSON_OVERRIDE: registry,
  };
  Object.assign(process.env, env);
  return { dir, claude, cache, env };
}

test('encodeProjectDir: misma codificacion que Claude Code', () => {
  assert.equal(encodeProjectDir('C:\\Users\\Alice\\.ultron'), 'C--Users-Alice--ultron');
  assert.equal(
    encodeProjectDir('C:\\Users\\Alice\\PERSONAL\\ProyectosPersonales\\Explored\\Explored'),
    'C--Users-Alice-PERSONAL-ProyectosPersonales-Explored-Explored',
  );
});

test('ownerOfDir: gana el proyecto con el prefijo mas largo y los worktrees van al padre', () => {
  const projects = [
    { id: 'web', path: 'C:\\P\\Web' },
    { id: 'risk', path: 'C:\\P\\Web\\risk' },
  ];
  assert.equal(ownerOfDir('C--P-Web-risk', projects), 'risk');
  assert.equal(ownerOfDir('C--P-Web', projects), 'web');
  assert.equal(ownerOfDir('C--P-Web--claude-worktrees-agent-1', projects), 'web');
  assert.equal(ownerOfDir('C--P-Web-risk--claude-worktrees-x', projects), 'risk');
  assert.equal(ownerOfDir('C--P-Otro', projects), null);
});

test('costOf: coste a mano, escritura de 5 min y de 1 h, modelo con fecha y modelo desconocido', () => {
  const t = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6 };
  // sonnet-5-5: 2 + 10 + 0,2 + 2*1,25 + 2*2 = 18,7
  assert.ok(Math.abs(costOf('claude-sonnet-5-5', t) - 18.7) < 1e-9);
  // haiku con sufijo de fecha se normaliza: 1 + 5 + 0,1 + 1,25 + 2 = 9,35
  assert.ok(Math.abs(costOf('claude-haiku-4-5-20251001', t) - 9.35) < 1e-9);
  assert.equal(costOf('claude-mystery-9', t), null);
});

test('projectUsage: dedupe por id, subagentes, worktrees, otro proyecto excluido y coste a mano', () => {
  const ws = makeWorkspace();
  const dirDemo = join(ws.claude, 'C--fx-demo');
  mkdirSync(join(dirDemo, 'sess1', 'subagents'), { recursive: true });
  // Sesion principal: m1 sale en dos lineas (se queda la de mas salida) y m2.
  writeFileSync(join(dirDemo, 'sess1.jsonl'), [line({ id: 'm1', out: 10 }), line({ id: 'm1', out: 1000 }), line({ id: 'm2' })].join('\n'));
  writeFileSync(join(dirDemo, 'sess1', 'subagents', 'agent-x.jsonl'), line({ id: 's1' }));
  // Worktree del mismo proyecto: cuenta para demo.
  const dirWt = join(ws.claude, 'C--fx-demo--claude-worktrees-w1');
  mkdirSync(dirWt, { recursive: true });
  writeFileSync(join(dirWt, 'w.jsonl'), line({ id: 'w1' }));
  // Proyecto hijo y otro proyecto: NO cuentan para demo.
  mkdirSync(join(ws.claude, 'C--fx-demo-hijo'), { recursive: true });
  writeFileSync(join(ws.claude, 'C--fx-demo-hijo', 'h.jsonl'), line({ id: 'h1' }));
  mkdirSync(join(ws.claude, 'C--fx-otro'), { recursive: true });
  writeFileSync(join(ws.claude, 'C--fx-otro', 'o.jsonl'), line({ id: 'o1' }));

  const r = projectUsage('demo', { days: 30, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.dirs, 2, 'carpeta propia + worktree');
  assert.equal(r.totals.messages, 4, 'm1 (dedupe), m2, s1 y w1');
  assert.equal(r.totals.sessions, 2, 'sess1 y el worktree; los subagentes no son sesiones');
  assert.equal(r.bySource.sub.messages, 1);
  assert.equal(r.bySource.main.messages, 3);
  assert.ok(Math.abs(r.totals.costUsd - 4 * CALL_COST) < 1e-9, `coste ${r.totals.costUsd}`);
  assert.equal(r.bySource.main.avgContextTokens, 13000, 'entrada + lectura + escritura por llamada');
  assert.equal(r.byModel.length, 1);
  assert.equal(r.byModel[0].sharePct, 100);
  assert.equal(r.byDay.length, 30);

  const hijo = projectUsage('demo-hijo', { days: 30, now: NOW });
  assert.equal(hijo.totals.messages, 1);
  rmSync(ws.dir, { recursive: true, force: true });
});

test('projectUsage: ventana de dias, modelo sin precio y proyecto inexistente', () => {
  const ws = makeWorkspace();
  const d = join(ws.claude, 'C--fx-demo');
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, 's.jsonl'),
    [line({ id: 'hoy' }), line({ id: 'viejo', ts: at(60) }), line({ id: 'raro', model: 'claude-mystery-9' })].join('\n'),
  );
  const corto = projectUsage('demo', { days: 30, now: NOW });
  assert.equal(corto.totals.messages, 2, 'el mensaje de hace 60 dias queda fuera');
  assert.deepEqual(corto.unpricedModels, ['claude-mystery-9']);
  assert.ok(corto.notes.some((n) => /claude-mystery-9/.test(n)), 'se avisa del modelo sin precio');
  assert.ok(Math.abs(corto.totals.costUsd - CALL_COST) < 1e-9, 'el desconocido cuenta 0 $');
  const largo = projectUsage('demo', { days: 90, now: NOW });
  assert.equal(largo.totals.messages, 3);
  const nada = projectUsage('no-existe', { now: NOW });
  assert.equal(nada.ok, false);
  assert.equal(nada.error.code, 'PROJECT_NOT_FOUND');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('cache por fichero: se crea, se reutiliza y se invalida si el fichero crece', () => {
  const ws = makeWorkspace();
  const d = join(ws.claude, 'C--fx-demo');
  mkdirSync(d, { recursive: true });
  const f = join(d, 's.jsonl');
  writeFileSync(f, line({ id: 'a' }));
  const first = projectUsage('demo', { days: 30, now: NOW });
  assert.equal(first.totals.messages, 1);
  assert.ok(existsSync(ws.cache) && readdirSync(ws.cache).some((x) => x.endsWith('.json')), 'cache escrita');
  const again = projectUsage('demo', { days: 30, now: NOW });
  assert.equal(again.totals.messages, 1, 'segunda lectura desde cache: mismo resultado');
  appendFileSync(f, `\n${line({ id: 'b' })}`);
  const grown = projectUsage('demo', { days: 30, now: NOW });
  assert.equal(grown.totals.messages, 2, 'el fichero cambio de tamano: se relee');
  rmSync(f);
  const gone = projectUsage('demo', { days: 30, now: NOW });
  assert.equal(gone.totals.messages, 0, 'un transcript borrado deja de contar');
  rmSync(ws.dir, { recursive: true, force: true });
});

test('CLI --json: contrato ok, error de proyecto y error de argumentos', () => {
  const ws = makeWorkspace();
  const d = join(ws.claude, 'C--fx-demo');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 's.jsonl'), line({ id: 'x', ts: new Date().toISOString() }));
  const run = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8', env: { ...process.env, ...ws.env } });
    let json = null;
    try {
      json = JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      /* json = null */
    }
    return { status: r.status, json };
  };
  const ok = run(['demo', '--days', '7']);
  assert.equal(ok.status, 0);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.days, 7);
  assert.equal(ok.json.byDay.length, 7);
  const missing = run(['no-existe']);
  assert.equal(missing.status, 1);
  assert.equal(missing.json.error.code, 'PROJECT_NOT_FOUND');
  const bad = run(['demo', '--days', '0']);
  assert.equal(bad.status, 1);
  assert.equal(bad.json.error.code, 'BAD_ARGS');
  rmSync(ws.dir, { recursive: true, force: true });
});
