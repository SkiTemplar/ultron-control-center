#!/usr/bin/env node
// project-create.mjs — nucleo del creador de proyectos de ULTRON.
//
// Un solo CLI consumido por tres frentes: el asistente de la pestana Projects
// (comando Tauri que hace spawn de este script), el chat de Claude Code, y
// terminal directa. Todo admite `--json` (un unico objeto JSON en stdout) o
// salida legible en espanol.
//
// La logica vive en scripts/lib/project-create/ (validacion, raices,
// plantillas, generadores, pasos de "create" y handlers por subcomando); este
// fichero es solo la entrada: parseo de argv, despacho y salida JSON/legible.
//
// Overrides para tests (nunca tocan el disco real del usuario):
//   ULTRON_PROJECT_ROOTS_OVERRIDE  ruta a project-roots.json alternativo
//   ULTRON_PROJECTS_JSON_OVERRIDE  ruta a projects.json alternativo (tambien
//                                  la respeta project-new.mjs)
//   ULTRON_BOARDS_DIR_OVERRIDE     directorio de tableros alternativo (lo
//                                  respetan project-new.mjs y kanban.mjs)
//   RESEARCH_ROOT_OVERRIDE         raiz de sesiones de investigacion (la
//                                  respeta lib/research/session.js)
//
// Subcomandos: roots | roots set | list | templates | subject new | mkdir | create
// Uso completo: node scripts/project-create.mjs --help

import { CliError } from './lib/project-create/errors.mjs';
import {
  cmdRoots, cmdRootsSet, cmdList, cmdTemplates, cmdSubjectNew, cmdMkdir, cmdCreate,
} from './lib/project-create/commands.mjs';

function parseArgs(argv, { boolFlags = [] } = {}) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (boolFlags.includes(key)) { flags[key] = true; continue; }
      const v = argv[i + 1];
      if (v === undefined) throw new CliError('BAD_ARGS', `${a} necesita un valor`);
      flags[key] = v;
      i += 1;
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

function printHuman(command, data) {
  switch (command) {
    case 'roots':
    case 'roots set':
      console.log('Raices configuradas:');
      for (const r of data.roots) {
        console.log(`  ${r.id.padEnd(14)} [${r.kind}]  ${r.exists ? 'OK   ' : 'FALTA'}  ${r.path}`);
      }
      break;
    case 'list':
      console.log(`${data.root}${data.sub ? `/${data.sub}` : ''}:`);
      for (const e of data.entries) {
        const marks = [e.isProject ? 'proyecto' : null, e.isSubject ? 'asignatura' : null].filter(Boolean).join(',');
        console.log(`  ${e.name}${marks ? `  [${marks}]` : ''}`);
      }
      console.log(`total: ${data.entries.length}`);
      break;
    case 'templates':
      for (const t of data.templates) {
        const av = t.available ? 'disponible' : `FALTAN: ${(t.requires || []).join(',') || '?'}`;
        console.log(`  ${t.id.padEnd(24)} (${t.source})  ${av}  — ${t.description || ''}`);
      }
      break;
    case 'subject new':
      console.log(`Asignatura creada: ${data.subjectPath}`);
      console.log(`Proyecto registrado: ${data.projectId}`);
      break;
    case 'mkdir':
      console.log(`Carpeta creada: ${data.path}`);
      break;
    case 'create':
      console.log(`Proyecto: ${data.projectPath}  (plantilla: ${data.template})`);
      for (const s of data.steps) console.log(`  [${s.ok ? 'ok' : 'FALLO'}] ${s.step}: ${s.message}`);
      break;
    default:
      console.log(JSON.stringify(data, null, 2));
  }
}

function handleSuccess(command, data, jsonMode) {
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, ...data }));
  } else {
    printHuman(command, data);
  }
}

function handleError(e, jsonMode) {
  const code = e.code || 'INTERNAL_ERROR';
  const message = e.message || String(e);
  if (jsonMode) {
    const payload = { ok: false, error: { code, message } };
    if (e.steps) payload.steps = e.steps;
    console.log(JSON.stringify(payload));
  } else {
    console.error(`[project-create] ERROR (${code}): ${message}`);
    if (e.steps) {
      for (const s of e.steps) console.error(`  [${s.ok ? 'ok' : 'FALLO'}] ${s.step}: ${s.message}`);
    }
  }
  process.exit(1);
}

function printHelp() {
  console.log(`Uso: node scripts/project-create.mjs <subcomando> [opciones] [--json]

Subcomandos:
  roots
  roots set --id <id> --label "<label>" --path <abs> --kind asignatura|personal
  list --root <id> [--sub <relPath>]
  templates [--kind asignatura|personal]
  subject new --root <id> --code <CODE> --name "<Nombre>"
  mkdir --root <id> [--sub <relPath>] --name <n>
  create --root <id> [--sub <relPath>] --name <Nombre> --template <id>
         [--no-git] [--no-claude-md] [--tags a,b] [--due YYYY-MM-DD] [--dry-run]

Anade --json a cualquier subcomando para obtener un unico objeto JSON en stdout.`);
}

function main() {
  const argvAll = process.argv.slice(2);
  const jsonMode = argvAll.includes('--json');
  const argv = argvAll.filter((a) => a !== '--json');
  const cmd = argv[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(cmd ? 0 : 1);
  }

  let command;
  let data;
  try {
    if (cmd === 'roots' && argv[1] === 'set') {
      command = 'roots set';
      data = cmdRootsSet(parseArgs(argv.slice(2)).flags);
    } else if (cmd === 'roots') {
      command = 'roots';
      data = cmdRoots();
    } else if (cmd === 'list') {
      command = 'list';
      data = cmdList(parseArgs(argv.slice(1)).flags);
    } else if (cmd === 'templates') {
      command = 'templates';
      data = cmdTemplates(parseArgs(argv.slice(1)).flags);
    } else if (cmd === 'subject' && argv[1] === 'new') {
      command = 'subject new';
      data = cmdSubjectNew(parseArgs(argv.slice(2)).flags);
    } else if (cmd === 'mkdir') {
      command = 'mkdir';
      data = cmdMkdir(parseArgs(argv.slice(1)).flags);
    } else if (cmd === 'create') {
      command = 'create';
      const { flags } = parseArgs(argv.slice(1), { boolFlags: ['no-git', 'no-claude-md', 'dry-run'] });
      data = cmdCreate(flags, { dryRun: !!flags['dry-run'] });
    } else {
      throw new CliError('BAD_ARGS', `subcomando desconocido: "${argv.join(' ')}". Usa --help.`);
    }
  } catch (e) {
    handleError(e, jsonMode);
    return;
  }
  handleSuccess(command, data, jsonMode);
}

main();
