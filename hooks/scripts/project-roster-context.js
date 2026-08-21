#!/usr/bin/env node
/**
 * ULTRON HOOK · project-roster-context · v1.0 (2026-08-19)
 *
 * SessionStart: inyecta en el contexto de la sesion el ROSTER de subagentes
 * del proyecto en el que se abre — los "empleados" que el chat principal puede
 * delegar con la Agent tool sin tener que descubrirlos.
 *
 * Por que existe: la Plantilla A2 vivia como una seccion de UI dentro de
 * Projects (RosterSection + modal de propuesta). El roster no se consumia en
 * ningun sitio, asi que era decoracion. La decision (2026-08-19) fue moverlo
 * a backend puro: el roster se genera solo la primera vez que se abre sesion
 * en un proyecto y se inyecta como contexto en cada arranque.
 *
 * Flujo:
 *   1. Resuelve el proyecto por `cwd` contra cockpit/projects.json (match de
 *      prefijo mas largo), con fallback a current-session.json y al basename.
 *   2. Lee cockpit/projects/<id>/agent-roster.json.
 *   3. Si no hay roster (o quedo vacio), lo genera de forma DETERMINISTA a
 *      partir del stack detectado en el proyecto y lo persiste. Sin llamada a
 *      LLM: esto corre en el arranque de cada sesion y no puede costar
 *      segundos ni tokens.
 *   4. Filtra los agentes que ya no existen en ~/.claude/agents/ — un agente
 *      fantasma no da error en Claude Code, simplemente no hace nada
 *      (KIRKARDO 11), asi que nunca se sugiere uno sin fichero.
 *   5. Emite additionalContext compacto (<= MAX_ENTRIES lineas).
 *
 * Formato del fichero (compatible con AgentRosterFile de Rust; los campos
 * extra los ignora serde):
 *   { "entries": [{ "name", "reason", "suggested_role" }],
 *     "source": "auto-deterministic", "generated_at": "<iso>" }
 *
 * Fail-safe: cualquier error -> sin output, exit 0. Nunca bloquea el arranque.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const ULTRON_ROOT = process.env.ULTRON_ROSTER_ROOT_OVERRIDE || path.join(HOME, '.ultron');
const COCKPIT = path.join(ULTRON_ROOT, 'cockpit');
const PROJECTS_JSON = path.join(COCKPIT, 'projects.json');
const PROJECTS_DIR = path.join(COCKPIT, 'projects');
const SESSION_STATE = path.join(COCKPIT, 'current-session.json');
const AGENTS_DIR = process.env.ULTRON_ROSTER_AGENTS_OVERRIDE || path.join(HOME, '.claude', 'agents');

// Tope de empleados inyectados. El roster es contexto de arranque: cada linea
// se paga en TODAS las sesiones del proyecto, asi que se corta antes de que
// compita con el resume de memoria.
const MAX_ENTRIES = 8;

// ---------------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------------

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeJsonAtomic(p, value) {
  const tmp = `${p}.tmp`;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p);
}

function norm(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// resolucion de proyecto
// ---------------------------------------------------------------------------

/**
 * Proyecto cuyo `path` es el prefijo MAS LARGO del cwd. El prefijo mas largo
 * gana para que un subproyecto anidado no quede capturado por su padre.
 */
function projectFromCwd(cwd) {
  const target = norm(cwd);
  if (!target) return '';
  const data = readJson(PROJECTS_JSON);
  const list = (data && Array.isArray(data.projects) && data.projects) || [];
  let best = '';
  let bestLen = -1;
  for (const proj of list) {
    const base = norm(proj && proj.path);
    if (!base || !proj.id) continue;
    if (target === base || target.startsWith(`${base}/`)) {
      if (base.length > bestLen) {
        bestLen = base.length;
        best = String(proj.id);
      }
    }
  }
  return best;
}

function activeProjectFromState() {
  const cfg = readJson(SESSION_STATE);
  if (!cfg) return '';
  const candidate = cfg.active_project || cfg.activeProject || cfg.ActiveProject || '';
  return String(candidate || '').trim();
}

function resolveProject(payload) {
  const fromCwd = projectFromCwd(payload && payload.cwd);
  if (fromCwd) return fromCwd;
  const explicit = activeProjectFromState();
  if (explicit) return explicit;
  const cwd = String((payload && payload.cwd) || '');
  return cwd ? path.basename(cwd).replace(/^\.+/, '').trim() : '';
}

// ---------------------------------------------------------------------------
// agentes disponibles en disco
// ---------------------------------------------------------------------------

/** Set con los agent types que EXISTEN como fichero en ~/.claude/agents/. */
function availableAgents() {
  try {
    return new Set(
      fs
        .readdirSync(AGENTS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.slice(0, -3)),
    );
  } catch (_) {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// deteccion de stack (deterministica, solo lectura de manifiestos)
// ---------------------------------------------------------------------------

// Directorios que nunca contienen el manifiesto del proyecto y si mucha
// basura que recorrer.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'target', 'dist', 'build', 'vendor',
  '.venv', 'venv', '__pycache__', '.next', 'out', 'logs', '.tmp',
]);

// Tope de directorios inspeccionados. El hook corre en el arranque de CADA
// sesion: la deteccion tiene que costar milisegundos, no un escaneo de disco.
const MAX_SCAN_DIRS = 40;

/** Señales de stack de UN directorio, volcadas en `stack`. */
function scanDir(dir, stack) {
  const at = (rel) => path.join(dir, rel);
  const has = (rel) => exists(at(rel));

  if (has('Cargo.toml')) stack.add('rust');
  if (has('go.mod')) stack.add('go');
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py')) stack.add('python');
  if (has('Dockerfile') || has('docker-compose.yml') || has('compose.yml')) stack.add('docker');
  if (has('.github/workflows')) stack.add('ci');
  if (has('Assets') && has('ProjectSettings')) stack.add('unity');
  if (has('tauri.conf.json')) stack.add('tauri');

  const pkg = readJson(at('package.json'));
  if (pkg) {
    stack.add('node');
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    if (deps.typescript || has('tsconfig.json')) stack.add('typescript');
    if (deps.react) stack.add('react');
    if (deps.next) stack.add('next');
    if (deps.vue || deps.nuxt) stack.add('vue');
    if (Object.keys(deps).some((d) => d.startsWith('@tauri-apps/'))) stack.add('tauri');
  }
}

/**
 * Tokens de stack del proyecto, mirando la raiz y hasta DOS niveles de
 * subdirectorios.
 *
 * La profundidad no es capricho: en un monorepo el manifiesto que identifica
 * el stack no esta arriba. En ULTRON, `Cargo.toml` vive en
 * `control-center/src-tauri/` y el `package.json` en `control-center/`, asi
 * que un escaneo de solo la raiz daba "python + ci" y dejaba fuera a
 * rust-engineer y typescript-pro — justo los dos empleados que importan.
 */
function detectStack(projectPath) {
  const stack = new Set();
  let budget = MAX_SCAN_DIRS;

  const walk = (dir, depth) => {
    if (budget <= 0) return;
    budget -= 1;
    scanDir(dir, stack);

    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return; // directorio ilegible: sin señal, sin ruido
    }
    if (names.some((e) => e.isFile() && e.name.endsWith('.uproject'))) stack.add('unreal');
    if (depth >= 2) return;

    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  walk(projectPath, 0);
  return [...stack];
}

// ---------------------------------------------------------------------------
// roster deterministico
// ---------------------------------------------------------------------------

// Plantilla base: vale en cualquier proyecto con codigo.
const BASELINE = [
  ['code-reviewer', 'Revision de codigo', 'revisa cualquier cambio no trivial antes de cerrarlo'],
  ['debugger', 'Diagnostico de fallos', 'primer agente ante bug, test rojo o comportamiento raro'],
  ['architect-reviewer', 'Arquitectura', 'decisiones de diseno, limites de modulo, acoplamiento'],
  ['test-automator', 'Tests', 'escribe la bateria de tests y la integra en CI'],
  ['security-auditor', 'Seguridad', 'auth, secretos, entrada de usuario, dependencias'],
];

// Stack -> especialistas. Solo agentes que existen en el catalogo real.
const STACK_AGENTS = {
  rust: [['rust-engineer', 'Rust', 'ownership, async, rendimiento del backend nativo']],
  tauri: [['rust-engineer', 'Rust / Tauri', 'comandos Tauri, IPC y backend nativo']],
  typescript: [['typescript-pro', 'TypeScript', 'tipos, generics y seguridad de tipos end-to-end']],
  react: [['react-specialist', 'React', 'patrones de componente, estado y rendimiento de UI']],
  next: [['nextjs-developer', 'Next.js', 'App Router, server components, Core Web Vitals']],
  vue: [['vue-expert', 'Vue', 'Composition API, reactividad, Nuxt']],
  python: [['python-pro', 'Python', 'codigo tipado, async y utilidades']],
  go: [['golang-pro', 'Go', 'concurrencia y servicios idiomaticos']],
  unity: [['unity-engineer', 'Unity', 'gameplay C#, escenas, packages']],
  unreal: [['unreal-engine-engineer', 'Unreal', 'gameplay C++, Blueprints, GAS, replicacion']],
  docker: [['docker-expert', 'Docker', 'imagenes, capas y seguridad de contenedor']],
  ci: [['devops-engineer', 'CI/CD', 'pipelines, releases y secretos']],
};

/**
 * Roster deterministico: especialistas del stack primero (son los que
 * distinguen a este proyecto de cualquier otro), baseline despues para
 * rellenar hasta MAX_ENTRIES.
 */
function buildRoster(stack, available) {
  const picked = new Map();
  const add = ([name, role, reason]) => {
    if (picked.size >= MAX_ENTRIES) return;
    if (!available.has(name) || picked.has(name)) return;
    picked.set(name, { name, reason, suggested_role: role });
  };

  for (const token of stack) {
    for (const spec of STACK_AGENTS[token] || []) add(spec);
  }
  for (const spec of BASELINE) add(spec);

  return [...picked.values()];
}

// ---------------------------------------------------------------------------
// contexto inyectado
// ---------------------------------------------------------------------------

function renderContext(projectId, entries, generated) {
  const lines = entries.map((e) => `- ${e.name} — ${e.suggested_role}: ${e.reason}`);
  return [
    `## Empleados del proyecto "${projectId}"`,
    '',
    'Subagentes preparados para este proyecto. Delegá con la Agent tool usando',
    'exactamente estos agent types (verificados en disco); si ninguno encaja, usa',
    'el que corresponda del catalogo general.',
    '',
    ...lines,
    '',
    generated
      ? `(roster generado automaticamente por stack; editable en ~/.ultron/cockpit/projects/${projectId}/agent-roster.json)`
      : `(roster en ~/.ultron/cockpit/projects/${projectId}/agent-roster.json)`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function run(payload) {
  const projectId = resolveProject(payload);
  if (!projectId) return null;

  const rosterPath = path.join(PROJECTS_DIR, projectId, 'agent-roster.json');
  const file = readJson(rosterPath) || {};
  const stored = Array.isArray(file.entries) ? file.entries : [];
  const available = availableAgents();
  if (available.size === 0) return null;

  // Entradas guardadas que siguen teniendo fichero de agente.
  let entries = stored
    .filter((e) => e && typeof e.name === 'string' && available.has(e.name))
    .map((e) => ({
      name: e.name,
      reason: String(e.reason || ''),
      suggested_role: String(e.suggested_role || e.name),
    }));

  let generated = false;
  if (entries.length === 0) {
    const projectPath = (() => {
      const data = readJson(PROJECTS_JSON);
      const list = (data && Array.isArray(data.projects) && data.projects) || [];
      const found = list.find((p) => p && p.id === projectId);
      return (found && found.path) || (payload && payload.cwd) || '';
    })();
    if (!projectPath || !exists(projectPath)) return null;

    entries = buildRoster(detectStack(projectPath), available);
    if (entries.length === 0) return null;
    generated = true;

    try {
      writeJsonAtomic(rosterPath, {
        entries,
        source: 'auto-deterministic',
        generated_at: new Date().toISOString(),
      });
    } catch (_) {
      /* sin persistencia: el contexto se inyecta igual, se regenerara */
    }
  }

  return renderContext(projectId, entries.slice(0, MAX_ENTRIES), generated);
}

function handle(raw) {
  let payload = {};
  try {
    payload = JSON.parse(String(raw || '').replace(/^﻿/, '')) || {};
  } catch (_) {
    payload = {};
  }
  if (payload.hook_event_name && payload.hook_event_name !== 'SessionStart') return null;

  let context = null;
  try {
    context = run(payload);
  } catch (_) {
    return null;
  }
  if (!context) return null;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  });
}

module.exports = {
  buildRoster,
  detectStack,
  handle,
  projectFromCwd,
  renderContext,
  resolveProject,
};

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => {
    raw += c;
  });
  process.stdin.on('end', () => {
    try {
      const out = handle(raw);
      if (out) process.stdout.write(`${out}\n`);
    } catch (_) {
      /* fail-safe: sin output */
    }
    process.exit(0);
  });
}
