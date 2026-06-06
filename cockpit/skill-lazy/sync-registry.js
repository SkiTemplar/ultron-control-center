#!/usr/bin/env node
/**
 * sync-registry.js — Generate/update skills-registry.json from routing-dispatcher.v2.js.
 *
 * Reads the PERSONAS, PLUGINS, and AGENTS arrays declared in the dispatcher and
 * produces a complete registry entry for every id that appears there, including
 * all namespaced plugin ids (superpowers:*, ecc:*, codex:*, agent-skills:*, etc.).
 *
 * Classification rules
 * --------------------
 * keep_active = true  : entry already existed in the registry with keep_active=true
 *                       (the 10 complex skills loaded at every SessionStart).
 * lazy_loadable = true: all other entries — injected on-demand when confidence >= 0.80.
 * lazy_loadable = false: entries explicitly forced false in the FORCE_INACTIVE list below.
 *
 * The script is ADDITIVE + PRESERVING:
 *   - Existing registry entries are preserved (their token_estimate, keep_active, etc.).
 *   - Entries absent from the registry are added with sensible defaults.
 *   - Entries that exist in the registry but are NOT in the dispatcher are left untouched
 *     (they may come from manual additions or future catalogs).
 *
 * Usage:
 *   node sync-registry.js [--dry-run]
 *
 * Options:
 *   --dry-run   Print the would-be registry to stdout instead of writing to disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const REGISTRY_PATH = path.join(HOME, '.ultron', 'cockpit', 'skill-lazy', 'skills-registry.json');
const DISPATCHER_PATH = path.join(HOME, '.ultron', 'cockpit', 'skill-lazy', 'routing-dispatcher.v2.js');
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const PLUGINS_CACHE = path.join(HOME, '.claude', 'plugins', 'cache');

const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Skills that should never be lazy-loaded (always keep_active=false AND
// lazy_loadable=false). These are already present as keep_active entries in
// the existing registry; listing them here ensures sync never flips them.
// ---------------------------------------------------------------------------
const FORCE_KEEP_ACTIVE = new Set([
  'ultron', 'docx', 'pdf', 'ui-ux-pro-max', 'senior-engineer',
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
// Extract PERSONAS / PLUGINS / AGENTS from the dispatcher source.
// Uses a simple regex to avoid a full AST parse.
// ---------------------------------------------------------------------------
function extractIdsFromDispatcher() {
  const src = fs.readFileSync(DISPATCHER_PATH, 'utf8');

  // Match all id: '...' values inside the three arrays.
  const idRe = /\bid:\s*['"]([^'"]+)['"]/g;
  const ids = [];
  let m;
  while ((m = idRe.exec(src)) !== null) {
    ids.push(m[1]);
  }
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Estimate token count from SKILL.md file size (bytes / 4 ≈ tokens).
// Returns 0 when the file cannot be found.
// ---------------------------------------------------------------------------
function estimateTokens(skillId) {
  const hasColon = skillId.includes(':');

  if (hasColon) {
    const [nsPrefix, baseName] = skillId.split(':', 2);
    // Try namespace sub-skill paths first, then namespace-level SKILL.md
    const candidates = [
      path.join(SKILLS_DIR, nsPrefix, baseName, 'SKILL.md'),
      path.join(SKILLS_DIR, nsPrefix, baseName + '.disabled', 'SKILL.md'),
      path.join(SKILLS_DIR, nsPrefix, 'SKILL.md'),
      path.join(SKILLS_DIR, nsPrefix + '.disabled', 'SKILL.md'),
    ];
    // Also check plugin cache paths
    for (const pluginDir of fs.readdirSync(PLUGINS_CACHE).map(d => path.join(PLUGINS_CACHE, d))) {
      try {
        for (const pkgDir of fs.readdirSync(pluginDir)) {
          for (const ver of fs.readdirSync(path.join(pluginDir, pkgDir))) {
            const sp = path.join(pluginDir, pkgDir, ver, 'skills', baseName, 'SKILL.md');
            const spDisabled = path.join(pluginDir, pkgDir, ver, 'skills', baseName + '.disabled', 'SKILL.md');
            candidates.push(sp, spDisabled);
          }
        }
      } catch (_) {
        // ignore unreadable dirs
      }
    }
    for (const c of candidates) {
      try { return Math.round(fs.statSync(c).size / 4); } catch (_) {}
    }
    return 0;
  }

  // Non-namespaced
  const candidates = [
    path.join(SKILLS_DIR, skillId, 'SKILL.md'),
    path.join(SKILLS_DIR, skillId + '.disabled', 'SKILL.md'),
  ];
  for (const c of candidates) {
    try { return Math.round(fs.statSync(c).size / 4); } catch (_) {}
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Resolve the canonical path string stored in the registry.
// Uses ~/.claude/skills/<namespace>/<base> for namespaced, else skills/<id>.
// ---------------------------------------------------------------------------
function resolveRegistryPath(skillId) {
  if (skillId.includes(':')) {
    const [nsPrefix, baseName] = skillId.split(':', 2);
    return `~/.claude/skills/${nsPrefix}/${baseName}`;
  }
  return `~/.claude/skills/${skillId}`;
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

  for (const id of dispatcherIds) {
    const isKeepActive = FORCE_KEEP_ACTIVE.has(id);
    const tokenEstimate = estimateTokens(id);
    const regPath = resolveRegistryPath(id);

    if (merged.has(id)) {
      // Entry exists — update path/token_estimate if stale, but never flip keep_active
      const prev = merged.get(id);
      const next = Object.assign({}, prev);
      if (tokenEstimate > 0 && next.token_estimate !== tokenEstimate) {
        next.token_estimate = tokenEstimate;
        updated++;
      }
      if (next.path !== regPath) {
        next.path = regPath;
        updated++;
      }
      merged.set(id, next);
    } else {
      // New entry — add with defaults
      const entry = {
        id,
        name: id,
        path: regPath,
        token_estimate: tokenEstimate,
        requires_skill_tool: false,
        lazy_loadable: !isKeepActive,
        keep_active: isKeepActive,
      };
      merged.set(id, entry);
      added++;
    }
  }

  return { entries: [...merged.values()], added, updated, total: merged.size };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
function main() {
  const { entries, added, updated, total } = buildRegistry();

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
      `\n[dry-run] total=${total} added=${added} updated=${updated}\n`
    );
    return;
  }

  fs.writeFileSync(REGISTRY_PATH, json, 'utf8');
  process.stdout.write(
    JSON.stringify({ ok: true, total, added, updated, path: REGISTRY_PATH }) + '\n'
  );
}

main();
