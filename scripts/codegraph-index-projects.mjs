#!/usr/bin/env node
// scripts/codegraph-index-projects.mjs — estado del indice CodeGraph de cada
// proyecto registrado y, con --apply, indexado de los que lo necesitan.
//
// Por que existe (auditoria 2026-10-23): el indice por proyecto solo lo crea
// ensure-project al abrir una sesion de Claude Code DENTRO del proyecto. Un
// proyecto dado de alta en el Control Center (creador, project-new o la
// pestana Projects) en el que nunca se abrio sesion no tiene indice, y en
// disco habia 15 de 37 asi. Este script rellena ese hueco bajo demanda.
//
// Uso:
//   node scripts/codegraph-index-projects.mjs            # informe, no toca nada
//   node scripts/codegraph-index-projects.mjs --apply    # indexa (secuencial)
//   node scripts/codegraph-index-projects.mjs --only id1,id2 --apply
//
// Mismo criterio que ensure-project (hooks/scripts/lib/codegraph-index.js):
// 'sin-indice' -> `codegraph init --yes`, 'incompleto' -> `codegraph index`;
// 'vacio' (indice completo sin ficheros), 'ok', 'ilegible' y la carpeta
// personal no se tocan. Carpetas inexistentes o dentro del temporal, tampoco.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { estadoIndice, accionPara } = require('../hooks/scripts/lib/codegraph-index.js');

const REGISTRY = path.join(os.homedir(), '.ultron', 'cockpit', 'projects.json');
/** Tope por proyecto: el mismo que usa la app (codegraph_init_project). */
const TIMEOUT_MS = 600_000;
const ARGS = { init: ['init', '--yes', '.'], index: ['index', '.'] };

const dentroDe = (dir, base) => {
  const d = path.resolve(dir).toLowerCase();
  const b = path.resolve(base).toLowerCase();
  return d === b || d.startsWith(`${b}${path.sep}`);
};

/**
 * Plan por proyecto: { id, path, estado, accion, motivo }. Puro salvo la
 * lectura del indice, para que el selftest lo pruebe con carpetas temporales.
 */
export function planIndexado(proyectos, { home = os.homedir(), tmpDir = os.tmpdir() } = {}) {
  return proyectos.map((p) => {
    const base = { id: p.id, path: p.path || null };
    if (!p.path) return { ...base, estado: 'sin-carpeta', accion: null, motivo: 'sin carpeta asignada' };
    if (!fs.existsSync(p.path)) return { ...base, estado: 'carpeta-inexistente', accion: null, motivo: 'la carpeta no existe' };
    if (dentroDe(p.path, tmpDir)) return { ...base, estado: 'temporal', accion: null, motivo: 'carpeta temporal' };
    const { estado, ficheros, motivo } = estadoIndice(p.path, home);
    return { ...base, estado, ficheros, accion: accionPara(estado), motivo };
  });
}

function leerRegistro() {
  const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  return Array.isArray(raw) ? raw : raw.projects || [];
}

function indexar(entrada) {
  // Con shell (codegraph es un .cmd en Windows) los argumentos se concatenan:
  // la ruta viaja como cwd y los argumentos son literales.
  const r = spawnSync('codegraph', ARGS[entrada.accion], {
    cwd: entrada.path,
    shell: true,
    windowsHide: true,
    timeout: TIMEOUT_MS,
    encoding: 'utf8',
  });
  if (r.error) return `error: ${r.error.message}`;
  if (r.status !== 0) return `fallo (codigo ${r.status}): ${String(r.stderr || r.stdout).trim().slice(-300)}`;
  const despues = estadoIndice(entrada.path).estado;
  return despues === 'ok' || despues === 'vacio' ? `ok (${despues})` : `termino pero el indice quedo ${despues}`;
}

function main(argv) {
  const apply = argv.includes('--apply');
  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx >= 0 ? new Set(String(argv[onlyIdx + 1] || '').split(',').filter(Boolean)) : null;
  const plan = planIndexado(leerRegistro()).filter((e) => !only || only.has(e.id));
  for (const e of plan) {
    const extra = e.ficheros != null ? ` ficheros=${e.ficheros}` : '';
    console.log(`${e.id.padEnd(40)} ${e.estado}${extra}${e.accion ? ` -> codegraph ${e.accion}` : ''}${e.motivo ? ` (${e.motivo})` : ''}`);
  }
  const pendientes = plan.filter((e) => e.accion);
  console.log(`\n${pendientes.length} de ${plan.length} proyectos necesitan indexado.`);
  if (!apply) {
    if (pendientes.length) console.log('Ejecutar con --apply para indexarlos (secuencial, tope 600 s por proyecto).');
    return 0;
  }
  let fallos = 0;
  for (const e of pendientes) {
    const res = indexar(e);
    if (!res.startsWith('ok')) fallos++;
    console.log(`${e.id}: ${res}`);
  }
  return fallos ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
