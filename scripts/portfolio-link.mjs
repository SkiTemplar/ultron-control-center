#!/usr/bin/env node
// portfolio-link.mjs — migración de una vez: vincula las tarjetas existentes
// del tablero Portfolio (`proyectos`) con los proyectos registrados en
// cockpit/projects.json, escribiendo el campo `project` de cada tarjeta.
//
// Por defecto es un DRY RUN: imprime vinculadas / ambiguas / sin pareja y no
// escribe. Con --apply escribe por el camino de kanban.mjs (lock de fichero
// compartido con la app, tmp + rename) y deja antes una copia
// kanban.json.bak-<fecha> (se conservan las 10 últimas).
//
// Uso:
//   node scripts/portfolio-link.mjs            # dry run
//   node scripts/portfolio-link.mjs --apply    # escribe
//   node scripts/portfolio-link.mjs --verbose  # lista también las ya vinculadas
//
// Overrides (selftests): ULTRON_PROJECTS_JSON_OVERRIDE, ULTRON_BOARDS_DIR_OVERRIDE.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORTFOLIO_PROJECT_ID, boardPathFor, readBoard, writeBoardAtomic, withBoardLock,
} from './lib/portfolio-board.mjs';
import { planLinks } from './lib/portfolio-link-plan.mjs';
import { backupWithRetention, reportPruneFailures } from './lib/registry-backup.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY = process.env.ULTRON_PROJECTS_JSON_OVERRIDE || join(__dirname, '..', 'cockpit', 'projects.json');

function fail(msg) {
  console.error(`[portfolio-link] ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { apply: false, verbose: false };
  for (const a of argv) {
    if (a === '--apply') out.apply = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else fail(`flag desconocido: ${a}`);
  }
  return out;
}

function loadRegistry() {
  if (!existsSync(REGISTRY)) fail(`no existe el registro ${REGISTRY}`);
  const raw = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  if (!Array.isArray(raw.projects)) fail(`${REGISTRY} no tiene un array "projects"`);
  return raw.projects;
}

function printPlan(plan, verbose) {
  for (const { card, project, by } of plan.linked) {
    console.log(`  vincular  ${card.title}  ->  ${project}  (por ${by})`);
  }
  for (const { card, candidates, reason } of plan.ambiguous) {
    console.log(`  ambigua   ${card.title}  ->  ${candidates.join(', ')}  (${reason})`);
  }
  for (const { card } of plan.unmatched) console.log(`  sin pareja  ${card.title}`);
  if (verbose) for (const { card } of plan.already) console.log(`  ya vinculada  ${card.title}  ->  ${card.project}`);
  console.log(
    `[portfolio-link] vinculadas: ${plan.linked.length} · ambiguas: ${plan.ambiguous.length}`
      + ` · sin pareja: ${plan.unmatched.length} · ya vinculadas: ${plan.already.length}`,
  );
}

function applyPlan(file, registry) {
  reportPruneFailures('portfolio-link', backupWithRetention(file));
  return withBoardLock(file, () => {
    // Se recalcula bajo el lock: el tablero pudo cambiar desde el dry run.
    const board = readBoard(file);
    const plan = planLinks(board.cards || [], registry);
    const ts = new Date().toISOString();
    for (const { card, project } of plan.linked) {
      const live = board.cards.find((c) => c.id === card.id);
      live.project = project;
      live.updated_at = ts;
    }
    if (plan.linked.length) writeBoardAtomic(file, board);
    return plan;
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Uso: node scripts/portfolio-link.mjs [--apply] [--verbose]');
  process.exit(0);
}

const file = boardPathFor(PORTFOLIO_PROJECT_ID);
if (!existsSync(file)) fail(`no existe el tablero Portfolio (${file})`);
const registry = loadRegistry();

if (!args.apply) {
  printPlan(planLinks(readBoard(file).cards || [], registry), args.verbose);
  console.log('[portfolio-link] DRY RUN: no se ha escrito nada. Repite con --apply para escribir.');
  process.exit(0);
}

const plan = applyPlan(file, registry);
printPlan(plan, args.verbose);
console.log(`[portfolio-link] escrito: ${plan.linked.length} tarjeta(s) vinculadas en ${file}`);
