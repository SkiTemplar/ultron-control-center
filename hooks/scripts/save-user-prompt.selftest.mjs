#!/usr/bin/env node
// save-user-prompt.selftest.mjs — fija el contrato de pruneOldInboxEntries
// (retencion de 90 dias del inbox de prompts, punto 4 del cleanup 2026-09-11).
// Hermetico: opera sobre un directorio temporal propio, nunca toca
// ~/.claude/memory/inbox.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { pruneOldInboxEntries, PRUNE_MAX_AGE_DAYS } = require('./save-user-prompt.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failures += 1;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgo(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'save-user-prompt-selftest-'));
try {
  const now = new Date();

  const recentName = `${ymd(now)}.md`;
  const borderlineName = `${ymd(daysAgo(now, PRUNE_MAX_AGE_DAYS - 1))}.md`;
  const oldName = `${ymd(daysAgo(now, PRUNE_MAX_AGE_DAYS + 1))}.md`;
  const unrelatedName = 'README.md';

  for (const name of [recentName, borderlineName, oldName, unrelatedName]) {
    fs.writeFileSync(path.join(dir, name), '# contenido de prueba\n', 'utf8');
  }

  // --- caso negativo: nada de esto debe borrarse en una pasada normal -------
  const result = pruneOldInboxEntries(dir, now);
  check('borra solo el fichero de mas de 90 dias', result.pruned, [oldName]);
  check('el fichero reciente NO se borra', fs.existsSync(path.join(dir, recentName)), true);
  check('el fichero limite (89 dias) NO se borra', fs.existsSync(path.join(dir, borderlineName)), true);
  check('el fichero fuera de patron NO se borra', fs.existsSync(path.join(dir, unrelatedName)), true);
  check('el fichero viejo SI se borra', fs.existsSync(path.join(dir, oldName)), false);
  check('escribe el marcador con la fecha de hoy', fs.readFileSync(path.join(dir, '.last-prune'), 'utf8'), ymd(now));

  // --- gate "como mucho una vez al dia" --------------------------------------
  fs.writeFileSync(path.join(dir, `${ymd(daysAgo(now, PRUNE_MAX_AGE_DAYS + 5))}.md`), 'x', 'utf8');
  const second = pruneOldInboxEntries(dir, now);
  check('segunda pasada el mismo dia no borra nada (marcador)', second, { pruned: [], skipped: 'already_pruned_today' });

  // --- dir inexistente: fail-safe, no lanza ----------------------------------
  const missing = pruneOldInboxEntries(path.join(dir, 'no-existe'), now);
  check('dir inexistente no lanza y no poda nada', missing, { pruned: [], skipped: 'no_dir' });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`SELFTEST save-user-prompt: ROJO (${failures} fallos)`);
  process.exit(1);
}
console.log('SELFTEST save-user-prompt: VERDE');
