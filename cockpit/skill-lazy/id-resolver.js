'use strict';
/**
 * id-resolver.js — ¿existe en disco el id que el routing quiere proponer?
 *
 * Por qué existe (2026-10-03): el dispatcher declaraba ids fijos (PLUGINS,
 * AGENTS, intent-rules, rosters) que habían dejado de existir al desinstalar
 * plugins (superpowers, agent-skills, frontend-design, playwright) o al
 * desactivar agentes (`<id>.md.disabled`). El hint sugería algo que Claude Code
 * no puede invocar: un no-op silencioso. Este módulo es la fuente única de
 * "existe" para v2/v3 (filtro al emitir) y para phantom-ids.selftest.mjs.
 *
 * Un id existe si resuelve a algo INVOCABLE hoy:
 *   - skill activa      <skills>/<id>/SKILL.md
 *   - skill lazy        <skills>/_disabled/<id>/SKILL.md (o el sufijo legacy .disabled)
 *   - skill sincronizada <skills>/synced/<org>/<id>/SKILL.md
 *   - agente activo     <agents>/<id>.md  (un `.md.disabled` NO cuenta: no se puede invocar)
 *   - agente nativo     Explore, general-purpose, Plan
 *   - `plugin:nombre`   plugin instalado (installed_plugins.json, sin `false` en
 *                       enabledPlugins) o sincronizado de claude.ai, con
 *                       skills/<nombre>/SKILL.md, agents/<nombre>.md o commands/<nombre>.md
 *
 * `_archived/` no cuenta: es el destino de las skills retiradas.
 *
 * Coste: cada id se resuelve una vez por proceso (Map), con 3-5 existsSync; los
 * índices de plugins y de skills sincronizadas se construyen solo si hace falta.
 * Nunca lanza: ante un error de E/S el id se da por inexistente.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const skillPaths = require('../../hooks/scripts/lib/skill-paths');

const BUILTIN_AGENTS = new Set(['Explore', 'general-purpose', 'Plan', 'statusline-setup']);
/** Tipos que el Agent tool puede lanzar: un hint "agent:<id>" exige uno de estos. */
const AGENT_KINDS = new Set(['agent', 'builtin-agent', 'plugin-agent']);

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch (_) {
    return false;
  }
}

function safeReadJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (_) {
    return [];
  }
}

/**
 * @param {object} [opts]
 * @param {string} [opts.claudeDir]  raíz de ~/.claude (por defecto la del usuario)
 * @param {string} [opts.skillsDir]  por defecto <claudeDir>/skills
 * @param {string} [opts.agentsDir]  por defecto <claudeDir>/agents
 * @param {string} [opts.pluginsDir] por defecto <claudeDir>/plugins
 */
function createResolver(opts = {}) {
  const claudeDir = opts.claudeDir || path.join(os.homedir(), '.claude');
  const skillsDir = opts.skillsDir || path.join(claudeDir, 'skills');
  const agentsDir = opts.agentsDir || path.join(claudeDir, 'agents');
  const pluginsDir = opts.pluginsDir || path.join(claudeDir, 'plugins');
  const settingsPath = opts.settingsPath || path.join(claudeDir, 'settings.json');

  const memo = new Map();
  let pluginRoots = null; // Map<pluginName, string[]>
  let syncedSkillRoots = null; // string[]

  function loadPluginRoots() {
    if (pluginRoots) return pluginRoots;
    pluginRoots = new Map();
    const add = (name, root) => {
      if (!pluginRoots.has(name)) pluginRoots.set(name, []);
      pluginRoots.get(name).push(root);
    };
    const enabled = (safeReadJson(settingsPath) || {}).enabledPlugins || {};
    const installed = (safeReadJson(path.join(pluginsDir, 'installed_plugins.json')) || {}).plugins || {};
    for (const [key, installs] of Object.entries(installed)) {
      if (enabled[key] === false) continue; // instalado pero apagado: no invocable
      const name = key.split('@')[0];
      for (const inst of Array.isArray(installs) ? installs : []) {
        if (inst && typeof inst.installPath === 'string') add(name, inst.installPath);
      }
    }
    for (const org of safeDirs(path.join(pluginsDir, 'synced'))) {
      for (const dir of safeDirs(path.join(pluginsDir, 'synced', org))) {
        add(dir.replace(/~g\d+$/, ''), path.join(pluginsDir, 'synced', org, dir));
      }
    }
    return pluginRoots;
  }

  function loadSyncedSkillRoots() {
    if (syncedSkillRoots) return syncedSkillRoots;
    const base = path.join(skillsDir, 'synced');
    syncedSkillRoots = safeDirs(base).map((org) => path.join(base, org));
    return syncedSkillRoots;
  }

  function resolveNamespaced(id) {
    const [ns, base] = id.split(':', 2);
    if (!ns || !base) return null;
    if (skillPaths.firstExisting(skillPaths.namespacedSkillMdCandidates(skillsDir, ns, base))) return 'skill';
    for (const root of loadPluginRoots().get(ns) || []) {
      if (safeExists(path.join(root, 'skills', base, 'SKILL.md'))) return 'plugin-skill';
      if (safeExists(path.join(root, 'agents', base + '.md'))) return 'plugin-agent';
      if (safeExists(path.join(root, 'commands', base + '.md'))) return 'plugin-command';
    }
    return null;
  }

  function resolvePlain(id) {
    if (BUILTIN_AGENTS.has(id)) return 'builtin-agent';
    if (skillPaths.firstExisting(skillPaths.skillMdCandidates(skillsDir, id))) return 'skill';
    if (safeExists(path.join(agentsDir, id + '.md'))) return 'agent';
    for (const root of loadSyncedSkillRoots()) {
      if (safeExists(path.join(root, id, 'SKILL.md'))) return 'synced-skill';
    }
    // El juez del daemon devuelve las skills de plugin por su nombre a secas
    // (frontmatter), sin el prefijo `plugin:`.
    for (const roots of loadPluginRoots().values()) {
      for (const root of roots) {
        if (safeExists(path.join(root, 'skills', id, 'SKILL.md'))) return 'plugin-skill';
      }
    }
    return null;
  }

  /** Tipo de asset al que resuelve el id, o null si es fantasma. */
  function kindOf(id) {
    const key = String(id || '').trim();
    if (!key || key.includes('/') || key.includes('\\') || key.startsWith('.')) return null;
    if (memo.has(key)) return memo.get(key);
    let kind = null;
    try {
      kind = key.includes(':') ? resolveNamespaced(key) : resolvePlain(key);
    } catch (_) {
      kind = null;
    }
    memo.set(key, kind);
    return kind;
  }

  /**
   * true si el id se puede proponer con esa etiqueta: un candidato de tipo
   * 'agent' tiene que resolver a un agente (una skill homónima no sirve: el
   * hint diría "agent:<id>" y el Agent tool no la lanza).
   */
  function isEmittable(id, candidateKind) {
    const kind = kindOf(id);
    if (kind === null) return false;
    return candidateKind === 'agent' ? AGENT_KINDS.has(kind) : true;
  }

  return {
    kindOf,
    isEmittable,
    exists: (id) => kindOf(id) !== null,
    roots: { claudeDir, skillsDir, agentsDir, pluginsDir },
  };
}

/**
 * Ids que las fuentes estáticas del routing pueden proponer, con su origen.
 * Lo usan el selftest y el inventario; el hook no lo necesita.
 *
 * @param {object} p
 * @param {object} p.v2            módulo routing-dispatcher.v2.js
 * @param {string} p.intentRulesPath
 * @param {string} p.projectsDir   cockpit/projects
 * @returns {Array<{id: string, source: string, kind: 'agent'|'skill'}>}
 */
function collectStaticIds({ v2, intentRulesPath, projectsDir }) {
  const out = [];
  const push = (id, source, kind) => out.push({ id, source, kind: kind || 'skill' });
  for (const p of v2.PERSONAS || []) push(p.id, 'v2:PERSONAS');
  for (const p of v2.PLUGINS || []) push(p.id, 'v2:PLUGINS');
  for (const a of v2.AGENTS || []) push(a.id, 'v2:AGENTS', 'agent');
  for (const id of v2.PLANNING_LAZY_SKILLS || []) push(id, 'v2:PLANNING_LAZY_SKILLS');

  let yaml = '';
  try {
    yaml = fs.readFileSync(intentRulesPath, 'utf8');
  } catch (_) { /* sin fichero: sin ids */ }
  const re = /^\s*(skill|agent):\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/gm;
  let m;
  while ((m = re.exec(yaml)) !== null) push(m[2].trim(), 'intent-rules:' + m[1], m[1] === 'agent' ? 'agent' : 'skill');

  for (const proj of safeDirs(projectsDir)) {
    const roster = safeReadJson(path.join(projectsDir, proj, 'agent-roster.json'));
    for (const e of (roster && Array.isArray(roster.entries) ? roster.entries : [])) {
      if (e && typeof e.name === 'string' && e.name.trim()) push(e.name.trim(), 'roster:' + proj, 'agent');
    }
    const pinned = safeReadJson(path.join(projectsDir, proj, 'pinned-agents.json'));
    for (const id of (pinned && Array.isArray(pinned.pinned) ? pinned.pinned : [])) {
      if (typeof id === 'string' && id.trim()) push(id.trim(), 'pinned:' + proj, 'agent');
    }
  }
  return out;
}

/** Entradas de `collectStaticIds` que no se pueden emitir (fantasma o tipo equivocado). */
function findPhantoms(entries, resolver) {
  return entries.filter((e) => !resolver.isEmittable(e.id, e.kind));
}

module.exports = { createResolver, collectStaticIds, findPhantoms, BUILTIN_AGENTS, AGENT_KINDS };
