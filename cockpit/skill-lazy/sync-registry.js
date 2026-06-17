#!/usr/bin/env node
/**
 * sync-registry.js — Generate/update skills-registry.json from routing-dispatcher.v2.js
 *                    + filesystem discovery of unregistered skills and agents.
 *
 * TWO sources of truth are merged in order:
 *
 *   1. Dispatcher (routing-dispatcher.v2.js)
 *      The existing PERSONAS/PLUGINS/AGENTS arrays.  Same logic as before:
 *      every id found there is ensured to exist in the registry.
 *
 *   2. Filesystem scan (NEW)
 *      Walks THREE directories for assets that exist on disk but are absent
 *      from the registry:
 *
 *        ~/.claude/skills/<name>/SKILL.md          (active skill)
 *        ~/.claude/skills/<name>.disabled/SKILL.md (disabled skill)
 *        ~/.claude/agents/<name>.md                (active agent)
 *        ~/.claude/agents/<name>.md.disabled       (disabled agent)
 *        ~/.ultron/skills/<name>/SKILL.md          (ultron workspace skill)
 *
 *      Newly discovered assets are registered with lazy_loadable=true,
 *      keep_active=false, and a "detected_from_fs" marker so the UI can
 *      distinguish auto-detected entries from dispatcher-declared ones.
 *
 * Classification rules
 * --------------------
 * keep_active = true  : entry was already in the registry with keep_active=true
 *                       OR it is in FORCE_KEEP_ACTIVE.
 * lazy_loadable = true: all other entries — injected on-demand when confidence >= 0.80.
 *
 * The script is ADDITIVE + PRESERVING + PRUNING:
 *   - Existing registry entries are preserved (token_estimate, keep_active, etc.).
 *   - Entries absent from the registry are added with sensible defaults.
 *   - Entries whose resolved path no longer exists on disk are PRUNED
 *     (phantom skills/agents). FORCE_KEEP_ACTIVE ids are never pruned.
 *
 * Usage:
 *   node sync-registry.js [--dry-run] [--detect-only]
 *
 * Options:
 *   --dry-run      Print the would-be registry to stdout instead of writing to disk.
 *   --detect-only  Print a JSON list of newly-detected assets to stdout, then exit.
 *                  Does NOT modify the registry file.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const REGISTRY_PATH = path.join(HOME, '.ultron', 'cockpit', 'skill-lazy', 'skills-registry.json');
const DISPATCHER_PATH = path.join(HOME, '.ultron', 'cockpit', 'skill-lazy', 'routing-dispatcher.v2.js');
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const AGENTS_DIR = path.join(HOME, '.claude', 'agents');
const ULTRON_SKILLS_DIR = path.join(HOME, '.ultron', 'skills');
const PLUGINS_CACHE = path.join(HOME, '.claude', 'plugins', 'cache');

const DRY_RUN = process.argv.includes('--dry-run');
const DETECT_ONLY = process.argv.includes('--detect-only');

// ---------------------------------------------------------------------------
// Skills that should always be keep_active (loaded at every SessionStart).
// Listing them here prevents sync from ever flipping their flag to false.
// ---------------------------------------------------------------------------
const FORCE_KEEP_ACTIVE = new Set([
  'ultron', 'skill-creator', 'docx', 'pdf', 'ui-ux-pro-max', 'senior-engineer',
  'continuous-learning-v2', 'gamedev-engineer', 'business-strategist',
  'ui-designer', 'hiper-plans',
]);

// ---------------------------------------------------------------------------
// Load existing registry (keyed by id for fast lookup)
// ---------------------------------------------------------------------------
function loadExistingRegistry() {
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    const arr = JSON.parse(raw);
    const map = new Map();
    for (const entry of arr) {
      map.set(entry.id, entry);
    }
    return map;
  } catch (_) {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Extract PERSONAS / PLUGINS / AGENTS ids from the dispatcher source.
// Uses a simple regex to avoid a full AST parse.
// ---------------------------------------------------------------------------
function extractIdsFromDispatcher() {
  let src;
  try {
    src = fs.readFileSync(DISPATCHER_PATH, 'utf8');
  } catch (_) {
    return [];
  }
  const ids = [];
  let m;
  const reSingle = /\bid:\s*'([^']+)'/g;
  const reDouble = /\bid:\s*"([^"]+)"/g;
  while ((m = reSingle.exec(src)) !== null) ids.push(m[1]);
  while ((m = reDouble.exec(src)) !== null) ids.push(m[1]);
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Estimate token count from SKILL.md file size (bytes / 4 approx tokens).
// Returns 0 when the file cannot be found.
// ---------------------------------------------------------------------------
function estimateTokens(skillId) {
  const hasColon = skillId.includes(':');

  if (hasColon) {
    const [nsPrefix, baseName] = skillId.split(':', 2);
    const candidates = [
      path.join(SKILLS_DIR, nsPrefix, baseName, 'SKILL.md'),
      path.join(SKILLS_DIR, nsPrefix, baseName + '.disabled', 'SKILL.md'),
      path.join(SKILLS_DIR, nsPrefix, 'SKILL.md'),
      path.join(SKILLS_DIR, nsPrefix + '.disabled', 'SKILL.md'),
    ];
    try {
      for (const pluginDir of fs.readdirSync(PLUGINS_CACHE).map(d => path.join(PLUGINS_CACHE, d))) {
        try {
          for (const pkgDir of fs.readdirSync(pluginDir)) {
            for (const ver of fs.readdirSync(path.join(pluginDir, pkgDir))) {
              const sp = path.join(pluginDir, pkgDir, ver, 'skills', baseName, 'SKILL.md');
              const spD = path.join(pluginDir, pkgDir, ver, 'skills', baseName + '.disabled', 'SKILL.md');
              candidates.push(sp, spD);
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
    for (const c of candidates) {
      try { return Math.round(fs.statSync(c).size / 4); } catch (_) {}
    }
    return 0;
  }

  const candidates = [
    path.join(SKILLS_DIR, skillId, 'SKILL.md'),
    path.join(SKILLS_DIR, skillId + '.disabled', 'SKILL.md'),
    path.join(ULTRON_SKILLS_DIR, skillId, 'SKILL.md'),
  ];
  for (const c of candidates) {
    try { return Math.round(fs.statSync(c).size / 4); } catch (_) {}
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Estimate token count for an agent .md file.
// ---------------------------------------------------------------------------
function estimateAgentTokens(agentId) {
  const candidates = [
    path.join(AGENTS_DIR, agentId + '.md'),
    path.join(AGENTS_DIR, agentId + '.md.disabled'),
  ];
  for (const c of candidates) {
    try { return Math.round(fs.statSync(c).size / 4); } catch (_) {}
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Resolve the canonical path string stored in the registry.
// ---------------------------------------------------------------------------
function resolveRegistryPath(skillId) {
  if (skillId.includes(':')) {
    const [nsPrefix, baseName] = skillId.split(':', 2);
    return `~/.claude/skills/${nsPrefix}/${baseName}`;
  }
  return `~/.claude/skills/${skillId}`;
}

// ---------------------------------------------------------------------------
// Filesystem discovery — walk the three skill/agent directories and return
// every asset that is not yet present in the registry.
//
// Each result: { id, registryPath, tokenEstimate, source, disabled }
//   source: 'claude-skill' | 'claude-agent' | 'ultron-skill'
// ---------------------------------------------------------------------------
function scanFilesystemAssets(existingRegistry) {
  const detected = [];

  // --- ~/.claude/skills/<name>[.disabled]/SKILL.md ---
  try {
    for (const entry of fs.readdirSync(SKILLS_DIR)) {
      const fullPath = path.join(SKILLS_DIR, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      const isDisabled = entry.endsWith('.disabled');
      const id = isDisabled ? entry.slice(0, -9) : entry;
      if (existingRegistry.has(id)) continue;
      const skillMd = path.join(fullPath, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      detected.push({
        id,
        registryPath: `~/.claude/skills/${id}`,
        tokenEstimate: Math.round(fs.statSync(skillMd).size / 4),
        source: 'claude-skill',
        disabled: isDisabled,
      });
    }
  } catch (_) {}

  // --- ~/.claude/agents/<name>.md[.disabled] ---
  try {
    for (const entry of fs.readdirSync(AGENTS_DIR)) {
      const fullPath = path.join(AGENTS_DIR, entry);
      if (!fs.statSync(fullPath).isFile()) continue;
      let id = null;
      let disabled = false;
      if (entry.endsWith('.md.disabled')) {
        id = entry.slice(0, -12);
        disabled = true;
      } else if (entry.endsWith('.md')) {
        id = entry.slice(0, -3);
      }
      if (!id || id.toLowerCase() === 'readme') continue;
      if (existingRegistry.has(id)) continue;
      detected.push({
        id,
        registryPath: `~/.claude/agents/${id}.md`,
        tokenEstimate: Math.round(fs.statSync(fullPath).size / 4),
        source: 'claude-agent',
        disabled,
      });
    }
  } catch (_) {}

  // --- ~/.ultron/skills/<name>/SKILL.md ---
  try {
    for (const entry of fs.readdirSync(ULTRON_SKILLS_DIR)) {
      const fullPath = path.join(ULTRON_SKILLS_DIR, entry);
      if (!fs.statSync(fullPath).isDirectory()) continue;
      if (existingRegistry.has(entry)) continue;
      const skillMd = path.join(fullPath, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      detected.push({
        id: entry,
        registryPath: `~/.ultron/skills/${entry}`,
        tokenEstimate: Math.round(fs.statSync(skillMd).size / 4),
        source: 'ultron-skill',
        disabled: false,
      });
    }
  } catch (_) {}

  return detected;
}

// ---------------------------------------------------------------------------
// Existence check — report whether an entry's asset is physically present
// ANYWHERE on disk. The stored `path` is NOT trusted to be accurate (many
// agent entries carry a synthetic ~/.claude/skills/<id> path even though the
// asset lives in ~/.claude/agents/<id>.md), so the union of every known
// location is probed. The prune pass removes an entry only when its id
// resolves to no file at all — i.e. a true phantom.
//
// Candidate locations probed for any id:
//   ~/.claude/skills/<id>/SKILL.md            (active skill)
//   ~/.claude/skills/<id>.disabled/SKILL.md   (disabled skill)
//   ~/.ultron/skills/<id>/SKILL.md            (ultron workspace skill)
//   ~/.claude/agents/<id>.md                  (active agent)
//   ~/.claude/agents/<id>.md.disabled         (disabled agent)
// Additionally, for namespaced plugin ids (e.g. "superpowers:brainstorm"),
// the plugin cache is probed for the base name as a skill, command, or agent:
//   ~/.claude/skills/<ns>/<base>[.disabled]/SKILL.md
//   <plugin-cache>/*/*/*/skills/<base>[.disabled]/SKILL.md
//   <plugin-cache>/*/*/*/commands/<base>.md   (command-style plugin)
//   <plugin-cache>/*/*/*/agents/<base>.md     (agent-style plugin)
// ---------------------------------------------------------------------------
function entryExistsOnDisk(entry) {
  const id = entry.id;

  const candidates = [
    path.join(SKILLS_DIR, id, 'SKILL.md'),
    path.join(SKILLS_DIR, id + '.disabled', 'SKILL.md'),
    path.join(ULTRON_SKILLS_DIR, id, 'SKILL.md'),
    path.join(AGENTS_DIR, id + '.md'),
    path.join(AGENTS_DIR, id + '.md.disabled'),
  ];

  if (id.includes(':')) {
    const [nsPrefix, baseName] = id.split(':', 2);
    candidates.push(path.join(SKILLS_DIR, nsPrefix, baseName, 'SKILL.md'));
    candidates.push(path.join(SKILLS_DIR, nsPrefix, baseName + '.disabled', 'SKILL.md'));
    try {
      for (const pluginDir of fs.readdirSync(PLUGINS_CACHE).map(d => path.join(PLUGINS_CACHE, d))) {
        try {
          for (const pkgDir of fs.readdirSync(pluginDir)) {
            for (const ver of fs.readdirSync(path.join(pluginDir, pkgDir))) {
              const base = path.join(pluginDir, pkgDir, ver);
              candidates.push(path.join(base, 'skills', baseName, 'SKILL.md'));
              candidates.push(path.join(base, 'skills', baseName + '.disabled', 'SKILL.md'));
              candidates.push(path.join(base, 'commands', baseName + '.md'));
              candidates.push(path.join(base, 'agents', baseName + '.md'));
            }
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  return candidates.some(c => fs.existsSync(c));
}

// ---------------------------------------------------------------------------
// Build the merged registry
// ---------------------------------------------------------------------------
function buildRegistry() {
  const existing = loadExistingRegistry();
  const dispatcherIds = extractIdsFromDispatcher();

  // Start with all existing entries (preserve manual additions)
  const merged = new Map(existing);

  let added = 0;
  let updated = 0;

  // Pass 1 — dispatcher-declared ids
  for (const id of dispatcherIds) {
    const isKeepActive = FORCE_KEEP_ACTIVE.has(id);
    const tokenEstimate = estimateTokens(id);
    const regPath = resolveRegistryPath(id);

    if (merged.has(id)) {
      const prev = merged.get(id);
      const next = Object.assign({}, prev);
      let changed = false;
      if (tokenEstimate > 0 && next.token_estimate !== tokenEstimate) {
        next.token_estimate = tokenEstimate;
        changed = true;
      }
      if (next.path !== regPath) {
        next.path = regPath;
        changed = true;
      }
      if (changed) {
        merged.set(id, next);
        updated++;
      }
    } else {
      merged.set(id, {
        id,
        name: id,
        path: regPath,
        token_estimate: tokenEstimate,
        requires_skill_tool: false,
        lazy_loadable: !isKeepActive,
        keep_active: isKeepActive,
      });
      added++;
    }
  }

  // Pass 2 — filesystem scan for assets absent from the registry
  const detected = scanFilesystemAssets(merged);
  for (const asset of detected) {
    const isKeepActive = FORCE_KEEP_ACTIVE.has(asset.id);
    merged.set(asset.id, {
      id: asset.id,
      name: asset.id,
      path: asset.registryPath,
      token_estimate: asset.tokenEstimate,
      requires_skill_tool: false,
      lazy_loadable: !isKeepActive,
      keep_active: isKeepActive,
      detected_from_fs: asset.source,
      fs_disabled: asset.disabled,
    });
    added++;
  }

  // Pass 3 — prune entries whose resolved path no longer exists on disk.
  // FORCE_KEEP_ACTIVE ids are never pruned (core skills loaded every session;
  // a transient fs hiccup must not drop them). Everything else must resolve to
  // a real SKILL.md / agent .md(.disabled) / plugin-cache asset to survive.
  let pruned = 0;
  const prunedIds = [];
  for (const [id, entry] of [...merged.entries()]) {
    if (FORCE_KEEP_ACTIVE.has(id)) continue;
    if (!entryExistsOnDisk(entry)) {
      merged.delete(id);
      pruned++;
      prunedIds.push(id);
    }
  }

  return {
    entries: [...merged.values()],
    added,
    updated,
    detected: detected.length,
    detectedIds: detected.map(a => a.id),
    pruned,
    prunedIds,
    total: merged.size,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  // --detect-only: just print what would be discovered, no writes
  if (DETECT_ONLY) {
    const existing = loadExistingRegistry();
    const detected = scanFilesystemAssets(existing);
    process.stdout.write(JSON.stringify(detected, null, 2) + '\n');
    return;
  }

  const { entries, added, updated, detected, detectedIds, pruned, prunedIds, total } = buildRegistry();

  // Sort: keep_active first, then alphabetical by id
  entries.sort(function (a, b) {
    if (a.keep_active && !b.keep_active) return -1;
    if (!a.keep_active && b.keep_active) return 1;
    return a.id.localeCompare(b.id);
  });

  const json = JSON.stringify(entries, null, 2) + '\n';

  if (DRY_RUN) {
    process.stdout.write(json);
    process.stderr.write(
      `\n[dry-run] total=${total} added=${added} updated=${updated} detected_from_fs=${detected} pruned=${pruned}\n`
    );
    if (detected > 0) {
      process.stderr.write(`[dry-run] newly detected: ${detectedIds.join(', ')}\n`);
    }
    if (pruned > 0) {
      process.stderr.write(`[dry-run] pruned (missing on disk): ${prunedIds.join(', ')}\n`);
    }
    return;
  }

  fs.writeFileSync(REGISTRY_PATH, json, 'utf8');
  process.stdout.write(
    JSON.stringify({ ok: true, total, added, updated, detected, pruned, path: REGISTRY_PATH }) + '\n'
  );
}

main();
