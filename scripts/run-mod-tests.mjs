#!/usr/bin/env node
// run-mod-tests.mjs — tests de los mods de Claude Code (mods/*) y del MCP de
// escritorio (tools/ultron-desktop-mcp).
//
// Por qué (mascota-mods-3, 2026-10-23): ningún gate ejecutaba `claude plugin
// test` ni server.test.mjs, y el rojo de ultron-permisos pasó desapercibido.
// Corre en el job `mods-tests` del CI (windows-latest, con la versión de
// `@anthropic-ai/claude-code` fijada en el workflow) y en local.
//
// Hermético: `claude plugin test` no necesita sesión iniciada ni el ~/.claude
// del usuario (verificado con HOME limpio y sin variables CLAUDE_*/ANTHROPIC_*);
// el MCP de escritorio levanta un puente falso en un HOME temporal.
//
// Uso:
//   node scripts/run-mod-tests.mjs                 todos los mods + el MCP
//   node scripts/run-mod-tests.mjs --filter <txt>  solo los que contengan el texto
//   node scripts/run-mod-tests.mjs --list          lista lo que ejecutaría
// Sale con 1 si falla alguno o si falta la CLI `claude` (nunca un verde sin medir).

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const MODS = path.join(ROOT, 'mods');
const MCP_TEST = path.join('tools', 'ultron-desktop-mcp', 'server.test.mjs');
const TIMEOUT_MS = 300_000;

const args = process.argv.slice(2);
const value = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : null);

/** Mods con carpeta tests/ no vacía, ordenados. */
export function discoverMods(modsDir = MODS) {
  let entries;
  try {
    entries = fs.readdirSync(modsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => {
      try {
        return fs.readdirSync(path.join(modsDir, name, 'tests')).some((f) => /\.test\.tsx?$/.test(f));
      } catch {
        return false;
      }
    })
    .sort();
}

/** Lista de suites: cada mod con `claude plugin test` y el MCP con node --test. */
export function buildSuites(mods) {
  const modSuites = mods.map((name) => ({
    name: `mods/${name}`,
    cwd: path.join(MODS, name),
    cmd: 'claude',
    argv: ['plugin', 'test'],
  }));
  const mcp = { name: MCP_TEST.split(path.sep).join('/'), cwd: ROOT, cmd: process.execPath, argv: ['--test', MCP_TEST] };
  return [...modSuites, mcp];
}

/** Resumen "N pass / M fail" de la salida de bun test o node --test. */
export function summarize(out) {
  const bun = /(\d+) pass[\s\S]*?(\d+) fail/.exec(out);
  if (bun) return `${bun[1]} pass, ${bun[2]} fail`;
  // node --test: "ℹ pass N" con el reporter spec (TTY o no) y "# pass N" con tap.
  const pass = /^(?:#|ℹ) pass (\d+)/m.exec(out);
  const fail = /^(?:#|ℹ) fail (\d+)/m.exec(out);
  return pass && fail ? `${pass[1]} pass, ${fail[1]} fail` : 'sin resumen';
}

function claudeVersion() {
  const r = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

function runSuite(s) {
  const t0 = Date.now();
  // shell en Windows: `claude` puede ser un .cmd de npm (CI) o un .exe (local).
  const r = spawnSync(s.cmd, s.argv, {
    cwd: s.cwd,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === 'win32' && s.cmd === 'claude',
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { name: s.name, ok: r.status === 0 && !r.error, ms: Date.now() - t0, out, summary: summarize(out) };
}

function main() {
  const filter = value('--filter');
  const suites = buildSuites(discoverMods()).filter((s) => !filter || s.name.includes(filter));
  if (args.includes('--list')) {
    for (const s of suites) console.log(s.name);
    return 0;
  }
  if (suites.some((s) => s.cmd === 'claude')) {
    const v = claudeVersion();
    if (!v) {
      console.error('FALTA la CLI `claude`: sin ella los tests de los mods no se pueden ejecutar (npm i -g @anthropic-ai/claude-code).');
      return 1;
    }
    console.log(`claude ${v}`);
  }
  const results = suites.map((s) => {
    const r = runSuite(s);
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${(r.ms / 1000).toFixed(1)} s, ${r.summary})`);
    if (!r.ok) console.log(r.out.trim().split('\n').slice(-25).map((l) => `      ${l}`).join('\n'));
    return r;
  });
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} suites en verde${failed.length ? `; fallan ${failed.length}` : ''}.`);
  return failed.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  process.exit(main());
}
