#!/usr/bin/env node
// skill-pool.mjs — pool de skills y herramientas de terceros, activadas por
// proyecto en vez de globalmente (plan plans/2026-10-18-skill-pool.md, F1).
//
// Por qué existe: una skill global paga su descripción en el contexto de todas
// las sesiones, y un repo de terceros instalado sin revisar ejecuta código
// ajeno. La pool clona cada repo en un SHA fijado, no ejecuta nada de él y lo
// lleva a cada proyecto por junction (skill), copia (ue-plugin) o uv (python-lib).
//
// Uso:
//   node scripts/skill-pool.mjs add <owner/repo|url> --name <n> --kind skill|ue-plugin \
//        --sha <sha> [--path <subdir>] [--ref <rama>] [--license X] [--templates a,b]
//   node scripts/skill-pool.mjs add [owner/repo] --name <n> --kind python-lib --version <v>
//   node scripts/skill-pool.mjs list [--json]
//   node scripts/skill-pool.mjs show <n> [--unreviewed]
//   node scripts/skill-pool.mjs review <n> --notes "resumen" [--date YYYY-MM-DD]
//   node scripts/skill-pool.mjs link <proyecto> <n> [--unreviewed] [--uproject <ruta>]
//   node scripts/skill-pool.mjs unlink <proyecto> <n>
//   node scripts/skill-pool.mjs update <n> [--accept] [--version <v>]
//   node scripts/skill-pool.mjs doctor
//
// <proyecto> es el id de cockpit/projects.json o una ruta absoluta. La lógica
// vive en scripts/skill-pool/ (store, git, link, commands, doctor).
// Overrides para tests: ULTRON_SKILL_POOL_ROOT y ULTRON_PROJECTS_JSON.

import {
  PoolError, assertName, fail, findAnyEntry, loadPool, resolveProject,
} from './skill-pool/store.mjs';
import { linkEntry, unlinkEntry } from './skill-pool/link.mjs';
import {
  cmdAdd, cmdList, cmdReview, cmdShow, cmdUpdate,
} from './skill-pool/commands.mjs';
import { cmdDoctor } from './skill-pool/doctor.mjs';

const BOOL_FLAGS = new Set(['json', 'accept', 'unreviewed', 'help']);
const VALUE_FLAGS = new Set([
  'name', 'path', 'sha', 'kind', 'license', 'version', 'ref', 'templates', 'uproject', 'notes', 'date',
]);

const HELP = `Uso: node scripts/skill-pool.mjs <subcomando> [opciones]

  add <owner/repo|url> --name <n> --kind skill|ue-plugin --sha <sha> [--path <subdir>]
                       [--ref <rama>] [--license X] [--templates a,b]
  add [owner/repo] --name <n> --kind python-lib --version <v> [--license X]
  list [--json]                 lista la pool y tus skills propias (~/.claude/skills/_disabled)
  show <n> [--unreviewed]       imprime el SKILL.md y los ficheros de la entrada
  review <n> --notes "texto"    registra la revisión de seguridad del SHA fijado
  link <proyecto> <n>           junction, copia o uv add según el tipo (--unreviewed, --uproject);
                                una skill propia se enlaza sin SHA ni revisión
  unlink <proyecto> <n>         quita el enlace sin tocar la pool
  update <n> [--accept]         fetch y diff contra el SHA fijado; re-fija solo con --accept
  doctor                        enlaces rotos, SHA distintos y carpetas huérfanas
`;

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h') { flags.help = true; continue; }
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (BOOL_FLAGS.has(key)) { flags[key] = true; continue; }
    if (!VALUE_FLAGS.has(key)) fail(`flag desconocido: ${a}`);
    const v = argv[i + 1];
    if (v === undefined) fail(`${a} necesita un valor`);
    flags[key] = v;
    i += 1;
  }
  return { flags, positional };
}

function printResult(action, result) {
  process.stdout.write(`[skill-pool] ${action}: ${result.state} -> ${result.link}\n`);
  if (result.gitignore) process.stdout.write(`[skill-pool] .gitignore: ${result.gitignore}\n`);
}

function cmdLink({ positional, flags }) {
  const name = assertName(positional[1]);
  const project = resolveProject(positional[0]);
  const entry = findAnyEntry(loadPool(), name);
  printResult('link', linkEntry(project, entry, flags));
}

function cmdUnlink({ positional }) {
  const name = assertName(positional[1]);
  const project = resolveProject(positional[0]);
  const entry = loadPool().entries.find((e) => e.name === name);
  printResult('unlink', unlinkEntry(project, name, entry));
}

const COMMANDS = {
  add: cmdAdd,
  list: cmdList,
  show: cmdShow,
  review: cmdReview,
  link: cmdLink,
  unlink: cmdUnlink,
  update: cmdUpdate,
  doctor: cmdDoctor,
};

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
  const handler = COMMANDS[command];
  if (!handler) fail(`subcomando desconocido: ${command} (mira --help)`);
  const parsed = parseArgs(rest);
  if (parsed.flags.help) {
    process.stdout.write(HELP);
    return 0;
  }
  return handler(parsed) || 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  if (!(err instanceof PoolError)) throw err;
  process.stderr.write(`[skill-pool] ERROR: ${err.message}\n`);
  process.exitCode = 1;
}
