#!/usr/bin/env node
// docs-ci-drift.selftest.mjs — la documentacion no puede contradecir el CI ni
// el codigo (L7, auditoria 2026-10-26).
//
//   1. Cada job de primer nivel de .github/workflows/ci.yml aparece en la
//      tabla «CI gates» de docs/INTEGRATION.md.
//   2. Si ci.yml define `mods-tests`, docs/MODS.md no dice que ningun gate de CI
//      ejecuta los tests de los mods.
//   3. Si env_keys.rs declara ALLOWED_KEYS con alguna clave, docs/INSTALL.md no
//      promete que no hacen falta API keys.
//
// Limite: las frases prohibidas son literales (cubren la regresion exacta, no
// la semantica) y el parser de jobs es por indentacion, acotado al bloque jobs:.
// Hermetico: solo lee ficheros versionados.
// Uso: node scripts/docs-ci-drift.selftest.mjs   (exit 0 = verde)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

/** Jobs de primer nivel del bloque `jobs:` de un workflow (2 espacios de indentacion). */
export function ciJobs(yml) {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break; // siguiente clave de primer nivel: fin del bloque jobs
    const m = /^ {2}([a-z0-9-]+):\s*$/.exec(l);
    if (m) jobs.push(m[1]);
  }
  return jobs;
}

/** Jobs citados en la tabla de la seccion «CI gates» (`| \`job\` | ... |`). */
export function documentedJobs(md) {
  const i = md.indexOf('### CI gates');
  if (i < 0) return [];
  const rest = md.slice(i + 1);
  const next = rest.search(/\n#{1,3} /);
  const section = next < 0 ? rest : rest.slice(0, next);
  return [...section.matchAll(/^\|\s*`([a-z0-9-]+)`\s*\|/gm)].map((m) => m[1]);
}

/** Problemas de deriva entre los textos dados. */
export function driftProblems({ ciYml, integration, mods, install, envKeys }) {
  const problems = [];
  const jobs = ciJobs(ciYml);
  if (jobs.length === 0) problems.push('ci.yml sin jobs reconocibles (parser roto?)');
  const documented = new Set(documentedJobs(integration));
  for (const job of jobs) {
    if (!documented.has(job)) problems.push(`job sin documentar en INTEGRATION.md: ${job}`);
  }
  if (jobs.includes('mods-tests') && /Ning[uú]n gate de\s+CI/i.test(mods)) {
    problems.push('MODS.md dice que ningun gate de CI ejecuta los mods, pero ci.yml tiene mods-tests');
  }
  const keys = /ALLOWED_KEYS\s*:\s*&\[&str\]\s*=\s*&\[([\s\S]*?)\];/.exec(envKeys);
  const hasKeys = !!keys && /"[A-Z0-9_]+"/.test(keys[1]);
  for (const phrase of ['never asks for an API key', 'no API keys', 'no\nAPI keys']) {
    if (hasKeys && install.includes(phrase)) {
      problems.push(`INSTALL.md dice «${phrase.replace('\n', ' ')}» y env_keys.rs declara ALLOWED_KEYS`);
    }
  }
  return problems;
}

let fail = 0;
const A = (c, n, d) => {
  if (c) console.log(`  [PASS] ${n}`);
  else { fail++; console.log(`  [FAIL] ${n}\n         -> ${d}`); }
};

const docs = {
  ciYml: read('.github/workflows/ci.yml'),
  integration: read('docs/INTEGRATION.md'),
  mods: read('docs/MODS.md'),
  install: read('docs/INSTALL.md'),
  envKeys: read('control-center/src-tauri/src/env_keys.rs'),
};

// 1. Arbol real.
const problems = driftProblems(docs);
A(problems.length === 0, `docs coherentes con ci.yml (${ciJobs(docs.ciYml).length} jobs) y env_keys.rs`, problems.join('; '));

// 2. Caso negativo: el guardia detecta la deriva (no es un no-op).
const sinCargo = docs.integration.replace(/^\|\s*`cargo-test`.*\n/m, '');
A(driftProblems({ ...docs, integration: sinCargo }).some((p) => p.endsWith(': cargo-test')),
  'quitar la fila cargo-test de la tabla -> «job sin documentar: cargo-test»', 'no detectado');
A(driftProblems({ ...docs, mods: 'Ningún gate de CI los ejecuta todavía' }).some((p) => p.startsWith('MODS.md')),
  'MODS.md con «Ningún gate de CI» -> detectado', 'no detectado');
A(driftProblems({ ...docs, install: 'ULTRON never asks for an API key.' }).some((p) => p.startsWith('INSTALL.md')),
  'INSTALL.md con «never asks for an API key» -> detectado', 'no detectado');
A(ciJobs('on:\n  push:\njobs:\n  a-b:\n    steps:\n      x:\n  c:\nenv:\n  d:\n').join(',') === 'a-b,c',
  'el parser solo cuenta los jobs de primer nivel del bloque jobs:', 'parser de jobs incorrecto');

console.log(fail === 0 ? '\nSELFTEST docs-ci-drift: VERDE' : `\nSELFTEST docs-ci-drift: ROJO (${fail})`);
process.exit(fail === 0 ? 0 : 1);
