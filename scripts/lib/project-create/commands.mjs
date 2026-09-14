// commands.mjs — un handler por subcomando del CLI. Reexporta cmdRoots,
// cmdRootsSet y cmdTemplates (viven en roots.mjs y templates.mjs porque
// comparten estado con ese modulo) y define aqui list, subject new, mkdir y
// create, que son los que orquestan varios modulos a la vez.

import {
  existsSync, mkdirSync, writeFileSync, readdirSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { CliError } from './errors.mjs';
import {
  validateName, validateSubSegments, resolveWithinRoot, slugify, DUE_DATE_RE,
} from './validation.mjs';
import {
  loadRoots, loadRegistrySafe, ensureRootPathExists, findRoot,
} from './roots.mjs';
import { resolveTemplate, copyTemplateFiles, isBinaryAvailable } from './templates.mjs';
import { runGenerator } from './generators.mjs';
import {
  runStep, runProjectNew, addKanbanCard, setSocraticUni, runResearchSessionNew,
  buildClaudeMd, buildTags, findContainingSubjectProject,
} from './steps.mjs';

export { cmdRoots, cmdRootsSet } from './roots.mjs';
export { cmdTemplates } from './templates.mjs';

// --- list --------------------------------------------------------------------

const PROJECT_MARKERS = ['.git', 'CMakeLists.txt', 'package.json', 'pyproject.toml', 'Cargo.toml'];

function isSkippedDir(name) {
  if (name.startsWith('.')) return true;
  if (name === 'node_modules' || name === 'build') return true;
  if (/^cmake-build-/.test(name)) return true;
  return false;
}

function looksLikeProject(dir) {
  return PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)));
}

export function cmdList(flags) {
  if (!flags.root) throw new CliError('BAD_ARGS', 'list requiere --root <id>');
  const raw = loadRoots();
  const root = findRoot(raw, flags.root);
  const sub = flags.sub || '';
  const baseDir = resolveWithinRoot(root.path, sub);
  if (!existsSync(baseDir)) throw new CliError('NOT_FOUND', `no existe en disco: ${baseDir}`);

  const registry = loadRegistrySafe();
  const registeredPaths = new Set(registry.projects.map((p) => resolve(p.path)));

  const entries = readdirSync(baseDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !isSkippedDir(d.name))
    .map((d) => {
      const full = join(baseDir, d.name);
      const relPath = sub ? `${sub}/${d.name}` : d.name;
      const isProject = looksLikeProject(full) || registeredPaths.has(resolve(full));
      const isSubject = root.kind === 'asignatura' && !sub;
      return { name: d.name, relPath, isDir: true, isProject, isSubject };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return { root: root.id, sub, entries };
}

// --- subject new ---------------------------------------------------------

export function cmdSubjectNew(flags) {
  const { root: rootId, code, name } = flags;
  if (!rootId || !code || !name) {
    throw new CliError('BAD_ARGS', 'subject new requiere --root --code --name');
  }
  validateName(code);
  validateName(name);
  const raw = loadRoots();
  const root = findRoot(raw, rootId);
  if (root.kind !== 'asignatura') {
    throw new CliError('BAD_ROOT_KIND', `la raiz "${rootId}" no es de tipo "asignatura" (es "${root.kind}")`);
  }
  ensureRootPathExists(root);

  const dirName = `${code} — ${name}`; // em-dash con espacios, como las carpetas existentes
  const subjectPath = resolveWithinRoot(root.path, dirName);
  if (existsSync(subjectPath)) throw new CliError('ALREADY_EXISTS', `ya existe: ${subjectPath}`);

  mkdirSync(subjectPath, { recursive: true });
  for (const sub of ['apuntes', 'codigo', 'trabajos']) {
    mkdirSync(join(subjectPath, sub), { recursive: true });
  }

  const projectId = slugify(dirName);
  const tags = `asignatura,${code.toLowerCase()}`;
  runProjectNew(['--name', dirName, '--path', subjectPath, '--id', projectId, '--tags', tags]);
  setSocraticUni(projectId); // raiz "asignatura" -> modo socratico universitario

  return { subjectPath, projectId };
}

// --- mkdir -----------------------------------------------------------------

export function cmdMkdir(flags) {
  const { root: rootId, name } = flags;
  const sub = flags.sub || '';
  if (!rootId || !name) throw new CliError('BAD_ARGS', 'mkdir requiere --root y --name');
  validateName(name);
  const raw = loadRoots();
  const root = findRoot(raw, rootId);
  ensureRootPathExists(root);

  const relTarget = sub ? `${sub}/${name}` : name;
  const target = resolveWithinRoot(root.path, relTarget);
  if (existsSync(target)) throw new CliError('ALREADY_EXISTS', `ya existe: ${target}`);
  mkdirSync(target, { recursive: true });
  return { path: target };
}

// --- create ------------------------------------------------------------------

export function cmdCreate(flags, { dryRun }) {
  const { root: rootId, name, template: templateId } = flags;
  const sub = flags.sub || '';
  if (!rootId || !name || !templateId) {
    throw new CliError('BAD_ARGS', 'create requiere --root --name --template (--sub es opcional)');
  }
  if (flags.due && !DUE_DATE_RE.test(flags.due)) {
    throw new CliError('BAD_ARGS', `--due debe tener formato YYYY-MM-DD, recibido: ${flags.due}`);
  }
  validateName(name);
  validateSubSegments(sub);

  const raw = loadRoots();
  const root = findRoot(raw, rootId);
  ensureRootPathExists(root);

  const template = resolveTemplate(templateId);
  if (!template) throw new CliError('TEMPLATE_NOT_FOUND', `plantilla desconocida: ${templateId}`);

  const relTarget = sub ? `${sub}/${name}` : name;
  const projectPath = resolveWithinRoot(root.path, relTarget);
  if (existsSync(projectPath)) throw new CliError('ALREADY_EXISTS', `ya existe: ${projectPath}`);

  const vars = {
    name,
    name_lower: name.toLowerCase().replace(/\s+/g, '_'),
    year: String(new Date().getFullYear()),
    subject: sub ? sub.split('/')[0] : '',
  };
  const steps = [];
  const filesCreated = [];
  const projectId = slugify(name);

  try {
    runStep(steps, 'mkdir', dryRun, `crearia la carpeta ${projectPath}`, () => {
      mkdirSync(projectPath, { recursive: true });
      return `carpeta creada: ${projectPath}`;
    });

    runStep(steps, 'template', dryRun, `aplicaria la plantilla "${template.id}" (${template.source})`, () => {
      if (template.source === 'local') {
        const filesDir = join(template.dir, 'files');
        if (existsSync(filesDir)) copyTemplateFiles(filesDir, projectPath, vars, filesCreated);
        return `plantilla local "${template.id}" aplicada (${filesCreated.length} fichero(s))`;
      }
      const missing = (template.requires || []).filter((bin) => !isBinaryAvailable(bin));
      if (missing.length) throw new Error(`faltan binarios requeridos: ${missing.join(', ')}`);
      runGenerator(template.id, projectPath, vars.name_lower);
      return `generador "${template.id}" ejecutado`;
    });

    if (template.id === 'trabajo-entrega') {
      runStep(steps, 'trabajo-marker', dryRun, 'crearia el marcador .ultron-trabajo.json', () => {
        const marker = {
          version: 1,
          tipo: 'trabajo-entrega',
          protegidas: ['borrador', 'entrega'],
          asignatura: root.kind === 'asignatura' && sub ? sub.split('/')[0] : null,
          creado: new Date().toISOString(),
        };
        const p = join(projectPath, '.ultron-trabajo.json');
        writeFileSync(p, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
        filesCreated.push(p);
        return '.ultron-trabajo.json creado (protegidas: borrador, entrega)';
      });
    }

    runStep(steps, 'git-init', dryRun, flags['no-git'] ? 'se omitiria (--no-git)' : 'git init', () => {
      if (flags['no-git']) return 'omitido (--no-git)';
      const r = spawnSync('git', ['init'], { cwd: projectPath, encoding: 'utf8' });
      if (r.error) throw new Error(`git no se pudo ejecutar: ${r.error.message}`);
      if (r.status !== 0) throw new Error(`git init fallo: ${(r.stderr || r.stdout || '').trim()}`);
      return 'git init';
    });

    runStep(steps, 'claude-md', dryRun, flags['no-claude-md'] ? 'se omitiria (--no-claude-md)' : 'crearia CLAUDE.md', () => {
      if (flags['no-claude-md']) return 'omitido (--no-claude-md)';
      const p = join(projectPath, 'CLAUDE.md');
      writeFileSync(p, buildClaudeMd(name, template), 'utf8');
      filesCreated.push(p);
      return 'CLAUDE.md creado';
    });

    const tags = buildTags(template.id, root, flags.tags);
    runStep(steps, 'register', dryRun, `se registraria como "${projectId}" (tags: ${tags.join(',')})`, () => {
      runProjectNew(['--name', name, '--path', projectPath, '--id', projectId, '--tags', tags.join(',')]);
      return `registrado como "${projectId}" (tags: ${tags.join(',')})`;
    });

    if (root.kind === 'asignatura') {
      runStep(steps, 'socratic', dryRun, `marcaria "${projectId}" con socratic=uni`, () => {
        setSocraticUni(projectId);
        return `socratic=uni aplicado a "${projectId}"`;
      });
    }

    if (template.id === 'trabajo-entrega') {
      runStep(steps, 'research-session', dryRun, 'crearia una sesion de investigacion', () => {
        const out = runResearchSessionNew(name);
        return `sesion de investigacion: ${out.id ?? '(sin id)'}`;
      });

      runStep(steps, 'kanban-card', dryRun, 'anadiria tarjeta al kanban de la asignatura contenedora (si esta registrada)', () => {
        const registry = loadRegistrySafe();
        const subject = findContainingSubjectProject(root, sub, registry);
        if (!subject) return 'omitido: la asignatura contenedora no esta registrada como proyecto en ULTRON';
        const title = flags.due ? `Entrega: ${name} (vence ${flags.due})` : `Entrega: ${name}`;
        addKanbanCard(subject.id, title, `Ruta: ${projectPath}`);
        return `tarjeta anadida al kanban de "${subject.id}"`;
      });
    }
  } catch (e) {
    throw new CliError('STEP_FAILED', e.message || String(e), { steps });
  }

  return {
    projectPath, projectId, template: template.id, steps, filesCreated,
  };
}
