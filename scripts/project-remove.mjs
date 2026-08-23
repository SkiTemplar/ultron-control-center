#!/usr/bin/env node
// project-remove.mjs — da de baja un proyecto del Control Center.
//
// Por que existe: el hook SessionStart `ensure-project.js` da de alta
// automaticamente los proyectos que detecta, y ninguna heuristica acierta
// siempre. Sin una baja explicita, un alta equivocada se queda para siempre
// ensuciando la pestana Projects. Este script es esa marcha atras.
//
// Uso:
//   node scripts/project-remove.mjs <id> [--board] [--dry-run]
//
//   <id>        id del proyecto en cockpit/projects.json
//   --board     borra tambien cockpit/projects/<id>/ (kanban incluido).
//               Por defecto el tablero se CONSERVA: contiene trabajo real y
//               una baja del registro no deberia destruirlo.
//   --dry-run   enseña lo que haria sin tocar nada.
//
// Escritura atomica (tmp + rename) con backup previo, igual que project-new.

import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ULTRON = join(__dirname, '..');
const REGISTRY = join(ULTRON, 'cockpit', 'projects.json');
const BOARDS = join(ULTRON, 'cockpit', 'projects');

function fail(msg) {
  console.error(`[project-remove] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { board: false, dryRun: false };
  for (const a of argv) {
    if (a === '--board') out.board = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) fail(`flag desconocido: ${a}`);
    else if (!out.id) out.id = a;
    else fail(`argumento inesperado: ${a}`);
  }
  return out;
}

function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.id) {
  console.log(`Uso: node scripts/project-remove.mjs <id> [--board] [--dry-run]

  <id>       id del proyecto en cockpit/projects.json
  --board    borra tambien el tablero cockpit/projects/<id>/ (por defecto se conserva)
  --dry-run  muestra lo que haria sin escribir nada`);
  process.exit(args.help ? 0 : 1);
}

if (!existsSync(REGISTRY)) fail(`no existe ${REGISTRY}`);

const registro = JSON.parse(readFileSync(REGISTRY, 'utf8'));
if (!Array.isArray(registro.projects)) fail(`${REGISTRY} no tiene un array "projects"`);

const entrada = registro.projects.find((p) => p.id === args.id);
if (!entrada) {
  const ids = registro.projects.map((p) => p.id).join(', ');
  fail(`no hay ningun proyecto con id "${args.id}". Ids disponibles: ${ids}`);
}

const tablero = join(BOARDS, args.id);
const tableroExiste = existsSync(tablero);

if (args.dryRun) {
  console.log(`[project-remove] DRY-RUN — no se escribe nada`);
  console.log(`  baja del registro: ${entrada.name} (${entrada.path})`);
  console.log(`  tablero: ${tableroExiste ? (args.board ? 'SE BORRARIA' : 'se conserva') : 'no existe'}`);
  process.exit(0);
}

copyFileSync(REGISTRY, `${REGISTRY}.bak`);
registro.projects = registro.projects.filter((p) => p.id !== args.id);
writeJsonAtomic(REGISTRY, registro);
console.log(`[project-remove] baja: ${entrada.name} (${entrada.path})`);

if (args.board && tableroExiste) {
  rmSync(tablero, { recursive: true, force: true });
  console.log(`[project-remove] tablero borrado: ${tablero}`);
} else if (tableroExiste) {
  console.log(`[project-remove] tablero conservado: ${tablero} (usa --board para borrarlo)`);
}
