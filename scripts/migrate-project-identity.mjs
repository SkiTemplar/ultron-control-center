#!/usr/bin/env node
/**
 * Migracion a identidad de proyecto por repositorio (2026-08-23).
 *
 * El project_id era el basename del cwd, asi que mover o renombrar una carpeta
 * estrenaba identidad y dejaba la memoria anterior inalcanzable: una mudanza
 * del arbol de proyectos parte cada proyecto en dos ids y vacia su recall.
 *
 * Esta migracion hace tres cosas:
 *   1. Da de alta cada repo vivo en el registro de identidad, apuntandolo al id
 *      que YA tiene los datos en brain.db (no se reescriben miles de filas).
 *   2. Fusiona los ids duplicados que dejo la mudanza.
 *   3. Traslada la auto-memoria de Claude Code a la ruta viva.
 *
 * El plan es DATOS, no codigo: vive en `cockpit/identity-migration.json`, que
 * esta fuera del repo porque contiene rutas personales. Formato:
 *
 *   {
 *     "repos":       [["PERSONAL/Proyectos/Foo", "foo"]],   // ruta relativa a ~, id canonico
 *     "merges":      [["Foo", "foo"]],                      // project_id origen -> destino
 *     "relocate":    [["a1b2c3d4", "foo"]],                 // prefijo de id de item -> project_id
 *     "memoryMoves": [["CARRERA/Viejo/Foo", "PERSONAL/Proyectos/Foo"]]
 *   }
 *
 * Seguridad: dry-run por defecto, copia de brain.db antes de escribir y ningun
 * borrado. Ejecutar con el daemon parado: brain.db tiene escritor unico.
 *
 * Uso:
 *   node scripts/migrate-project-identity.mjs            # dry-run
 *   node scripts/migrate-project-identity.mjs --apply
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const identity = require(path.join(os.homedir(), '.ultron', 'hooks', 'scripts', 'lib', 'project-identity.js'));

const APPLY = process.argv.includes('--apply');
const HOME = os.homedir();
const BRAIN = path.join(HOME, '.ultron', 'brain.db');
const PLAN_PATH = path.join(HOME, '.ultron', 'cockpit', 'identity-migration.json');

const log = (...a) => console.log(...a);

function readPlan() {
  try {
    const plan = JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
    for (const k of ['repos', 'merges', 'relocate', 'memoryMoves']) {
      if (!Array.isArray(plan[k])) plan[k] = [];
    }
    return plan;
  } catch {
    return null;
  }
}

/** Ruta absoluta a partir de una relativa al home, con separadores en cualquier estilo. */
const fromHome = (rel) => path.join(HOME, ...String(rel).split(/[\\/]+/).filter(Boolean));

/**
 * Slug de directorio de ~/.claude/projects para una ruta absoluta. Claude Code
 * colapsa a guion los separadores, los dos puntos, los guiones bajos y los
 * espacios: `C:\x\PROYECTOS_PERSONALES\Unreal Engine` -> `C--x-PROYECTOS-PERSONALES-Unreal-Engine`.
 */
const projectSlug = (p) => p.replace(/[:\\/_\s]/g, '-');

/**
 * Copia previa. Nunca sobrescribe: el script es idempotente y se re-ejecuta,
 * y una segunda pasada machacaria la copia PRE-migracion con una POST — que es
 * exactamente perder el punto de restauracion (pasado el 2026-08-23).
 */
function backup() {
  const dir = path.join(HOME, '.ultron', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const base = `brain-pre-identity-${new Date().toISOString().slice(0, 10)}`;
  let dest = path.join(dir, `${base}.db`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(dir, `${base}-${i}.db`);
  if (APPLY) fs.copyFileSync(BRAIN, dest);
  return dest;
}

function migrateRegistry(plan) {
  log('\n== Registro de identidad ==');
  for (const [rel, canonical] of plan.repos) {
    const repo = fromHome(rel);
    if (!fs.existsSync(repo)) {
      log(`  SKIP  ${canonical}: ruta inexistente`);
      continue;
    }
    if (!fs.existsSync(path.join(repo, '.git'))) {
      log(`  SKIP  ${canonical}: sin .git, seguira resolviendo por basename`);
      continue;
    }
    if (!APPLY) {
      log(`  plan  ${path.basename(repo)} -> ${canonical}`);
      continue;
    }
    // Alta: escribe ultron.projectId en .git/config y registra el repo.
    identity.resolveProjectId(repo);
    const uuid = identity.readRepoUuid(repo);
    if (!uuid) {
      log(`  FALLO ${canonical}: no se pudo fijar ultron.projectId`);
      continue;
    }
    identity.writeRegistry((reg) => {
      if (reg.repos[uuid]) reg.repos[uuid].id = canonical;
    });
    const got = identity.resolveProjectId(repo);
    log(`  ${got === canonical ? 'OK   ' : 'FALLO'} ${path.basename(repo)} -> ${got}`);
  }
}

function migrateDb(plan) {
  log('\n== brain.db ==');
  const db = new DatabaseSync(BRAIN, { readOnly: !APPLY });
  const count = (p) => db.prepare('SELECT COUNT(*) n FROM memory_items WHERE project_id = ?').get(p).n;

  for (const [from, to] of plan.merges) {
    const n = count(from);
    if (!n) {
      log(`  --    ${from}: 0 items, nada que fusionar`);
      continue;
    }
    if (APPLY) {
      db.prepare('UPDATE memory_items SET project_id = ? WHERE project_id = ?').run(to, from);
      log(`  OK    ${from} -> ${to} (${n} items, quedan ${count(from)})`);
    } else {
      log(`  plan  ${from} -> ${to} (${n} items)`);
    }
  }

  for (const [prefix, to] of plan.relocate) {
    const rows = db.prepare('SELECT id, project_id FROM memory_items WHERE id LIKE ?').all(prefix + '%');
    const pend = rows.filter((r) => r.project_id !== to);
    if (!pend.length) {
      log(`  --    ${prefix}: ya reubicado`);
      continue;
    }
    if (APPLY) {
      for (const r of pend) db.prepare('UPDATE memory_items SET project_id = ? WHERE id = ?').run(to, r.id);
      log(`  OK    ${prefix} -> ${to} (${pend.length} item)`);
    } else {
      log(`  plan  ${prefix} -> ${to} (${pend.length} item)`);
    }
  }
  db.close();
}

/**
 * Auto-memoria de Claude Code: vive en ~/.claude/projects/<slug-de-la-ruta>/,
 * asi que una mudanza la deja huerfana igual que al project_id. Se traslada a
 * la ruta viva y en el directorio viejo queda un puntero, no un borrado.
 */
function migrateMemoryDirs(plan) {
  log('\n== Auto-memoria (~/.claude/projects) ==');
  const base = path.join(HOME, '.claude', 'projects');
  for (const [relViejo, relNuevo] of plan.memoryMoves) {
    const rutaNueva = fromHome(relNuevo);
    const src = path.join(base, projectSlug(fromHome(relViejo)), 'memory');
    const dstDir = path.join(base, projectSlug(rutaNueva), 'memory');
    if (!fs.existsSync(src)) {
      log(`  --    ${path.basename(rutaNueva)}: sin memoria que mover`);
      continue;
    }
    const pend = fs
      .readdirSync(src)
      .filter((f) => f.endsWith('.md'))
      .filter((f) => !fs.existsSync(path.join(dstDir, f)));
    if (!pend.length) {
      log(`  --    ${path.basename(rutaNueva)}: ya trasladada`);
      continue;
    }
    if (!APPLY) {
      log(`  plan  ${path.basename(rutaNueva)}: ${pend.length} md`);
      continue;
    }
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of pend) fs.renameSync(path.join(src, f), path.join(dstDir, f));
    fs.writeFileSync(
      path.join(src, 'MEMORY.md'),
      `# Memory Index — RUTA ABANDONADA\n\nEste proyecto se movió de carpeta. La memoria viva está en:\n\`~/.claude/projects/${projectSlug(rutaNueva)}/memory/\`\n\nTrasladado el ${new Date().toISOString().slice(0, 10)}. No añadir nada aquí.\n`
    );
    log(`  OK    ${path.basename(rutaNueva)}: ${pend.length} md trasladados`);
  }
}

const plan = readPlan();
if (!plan) {
  log(`Sin plan de migracion en ${PLAN_PATH}. Nada que hacer.`);
  process.exit(0);
}
const dest = backup();
log(APPLY ? `APLICANDO. Copia: ${dest}` : 'DRY-RUN (usa --apply para escribir)');
migrateRegistry(plan);
migrateDb(plan);
migrateMemoryDirs(plan);
log(`\n${APPLY ? 'Migracion aplicada.' : 'Nada escrito.'} Tras aplicar: reindexar Qdrant y verificar el recall en runtime.`);
