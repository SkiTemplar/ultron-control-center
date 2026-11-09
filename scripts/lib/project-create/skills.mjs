// skills.mjs — skills de la pool de terceros (scripts/skill-pool.mjs) que se
// enlazan al crear un proyecto (plan 2026-10-18-skill-pool, F3).
//
// La pool se consulta SIEMPRE como proceso hijo (`skill-pool.mjs list --json`
// y `skill-pool.mjs link <id> <n>`): es la unica dueña de pool.json, de los
// clones fijados por SHA y de las junctions, y este modulo no duplica nada de
// eso salvo la regla de "revisada" para elegir las sugeridas por defecto.
//
// Contrato:
//   --skills a,b   enlaza exactamente esas (deben existir y ser kind "skill")
//   --skills none  no enlaza ninguna
//   (sin flag)     las entradas kind "skill" revisadas cuyo `templates`
//                  incluya la plantilla elegida
// Un `link` que falla NO aborta la creacion: queda como paso con ok=false.

import { spawnSync } from 'node:child_process';
import { CliError } from './errors.mjs';
import { ULTRON, SKILL_POOL_CLI } from './paths.mjs';

const SKILL_KIND = 'skill';
const NONE_VALUE = 'none';
const CONDITION_WORDS = 14;
const SPAWN_TIMEOUT_MS = 30_000;

function poolEnv() {
  // skill-pool.mjs prioriza ULTRON_PROJECTS_JSON sobre
  // ULTRON_PROJECTS_JSON_OVERRIDE; si hay override, ambos CLIs deben mirar el
  // mismo registro que acaba de escribir project-new.mjs.
  const override = process.env.ULTRON_PROJECTS_JSON_OVERRIDE;
  return override ? { ...process.env, ULTRON_PROJECTS_JSON: override } : process.env;
}

function runPool(args) {
  return spawnSync(process.execPath, [SKILL_POOL_CLI, ...args], {
    encoding: 'utf8', cwd: ULTRON, env: poolEnv(), timeout: SPAWN_TIMEOUT_MS,
  });
}

function processFailure(r) {
  if (r.error) return r.error.message;
  if (r.status !== 0) return (r.stderr || r.stdout || '').trim() || `salio con codigo ${r.status}`;
  return null;
}

/** Entradas de la pool tal cual las devuelve `skill-pool list --json`. */
export function loadPoolEntries() {
  const r = runPool(['list', '--json']);
  const failure = processFailure(r);
  if (failure) throw new CliError('POOL_UNAVAILABLE', `skill-pool list fallo: ${failure}`);
  let parsed;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    throw new CliError('POOL_UNAVAILABLE', `skill-pool list no devolvio JSON: ${e.message}`);
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new CliError('POOL_UNAVAILABLE', 'skill-pool list no devolvio un array "entries"');
  }
  return parsed.entries;
}

/** Misma regla que skill-pool/store.mjs: la revision cubre el SHA fijado. */
function isReviewed(entry) {
  return Boolean(entry.review && entry.review.sha && entry.review.sha === entry.sha);
}

function isSuggestedFor(entry, templateId) {
  return Boolean(templateId) && Array.isArray(entry.templates) && entry.templates.includes(templateId);
}

/** Primeras palabras de las notas de revision, para una linea de condiciones. */
export function summarizeNotes(notes) {
  const words = String(notes || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const head = words.slice(0, CONDITION_WORDS).join(' ');
  return words.length > CONDITION_WORDS ? `${head}…` : head;
}

// --- subcomando "skills" -------------------------------------------------------

export function cmdSkills(flags) {
  const templateId = flags.template || null;
  const skills = loadPoolEntries()
    .filter((e) => e.kind === SKILL_KIND)
    .map((e) => ({
      name: e.name,
      license: e.license || null,
      reviewed: isReviewed(e),
      suggested: isSuggestedFor(e, templateId),
      conditions: summarizeNotes(e.review && e.review.notas),
    }));
  return { template: templateId, skills };
}

// --- plan de "create" ------------------------------------------------------------

/** null = sin flag (defecto de plantilla); [] = none; lista sin duplicados. */
export function parseSkillsFlag(value) {
  if (value === undefined) return null;
  const raw = String(value).trim();
  if (raw === NONE_VALUE) return [];
  const names = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (!names.length) throw new CliError('BAD_ARGS', '--skills necesita una lista a,b o "none"');
  return names;
}

function planFromTemplate(templateId) {
  let entries;
  try {
    entries = loadPoolEntries();
  } catch (e) {
    // Sin --skills explicito, una pool ilegible no impide crear el proyecto,
    // pero queda como paso fallido en la salida.
    return { names: [], source: 'template', warning: e.message, skipped: [] };
  }
  const suggested = entries.filter((e) => e.kind === SKILL_KIND && isSuggestedFor(e, templateId));
  return {
    names: suggested.filter(isReviewed).map((e) => e.name),
    source: 'template',
    warning: null,
    skipped: suggested.filter((e) => !isReviewed(e)).map((e) => e.name),
  };
}

function planFromList(names) {
  const byName = new Map(loadPoolEntries().map((e) => [e.name, e]));
  const unknown = names.filter((n) => !byName.has(n));
  if (unknown.length) {
    throw new CliError('BAD_ARGS', `--skills: no están en la pool: ${unknown.join(', ')} (mira: skill-pool list)`);
  }
  const notSkill = names.filter((n) => byName.get(n).kind !== SKILL_KIND);
  if (notSkill.length) {
    const detail = notSkill.map((n) => `${n} (${byName.get(n).kind})`).join(', ');
    throw new CliError('BAD_ARGS', `--skills: al crear solo se enlazan entradas kind "skill"; enlaza a mano con skill-pool link: ${detail}`);
  }
  return { names, source: 'explicit', warning: null, skipped: [] };
}

/**
 * Decide qué skills se enlazarán. Se llama ANTES de tocar el disco: un
 * --skills con nombres desconocidos o de otro tipo aborta sin crear nada.
 */
export function planSkills(flags, templateId) {
  const requested = parseSkillsFlag(flags.skills);
  if (requested === null) return planFromTemplate(templateId);
  if (!requested.length) return { names: [], source: 'none', warning: null, skipped: [] };
  return planFromList(requested);
}

// --- pasos de "create" ---------------------------------------------------------

function summaryMessage(plan, dryRun) {
  const origin = { explicit: '--skills', template: 'sugeridas por la plantilla', none: '--skills none' }[plan.source];
  const list = plan.names.length ? plan.names.join(', ') : 'ninguna';
  const verb = dryRun ? 'se enlazarían' : 'se enlazan';
  const skipped = plan.skipped.length ? `; sin revisar, no se enlazan: ${plan.skipped.join(', ')}` : '';
  return `${verb} (${origin}): ${list}${skipped}`;
}

function linkSkill(projectId, name) {
  const r = runPool(['link', projectId, name]);
  const failure = processFailure(r);
  if (failure) throw new Error(failure);
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  return lines[0] || 'enlazada';
}

/**
 * Añade a `steps` un resumen y un paso `skill:<n>` por skill. Nunca lanza:
 * cada fallo de `link` (o de lectura de la pool) queda con ok=false.
 * Devuelve [{ name, ok, message }] para el campo `skills` de la salida.
 */
export function applySkillPlan(steps, plan, projectId, dryRun) {
  if (plan.warning) {
    steps.push({ step: 'skills', ok: false, message: `no se pudo leer la pool: ${plan.warning}` });
    return [];
  }
  steps.push({ step: 'skills', ok: true, message: summaryMessage(plan, dryRun) });
  return plan.names.map((name) => {
    let outcome;
    if (dryRun) {
      outcome = { name, ok: true, message: `se enlazaría "${name}" con skill-pool link` };
    } else {
      try {
        outcome = { name, ok: true, message: linkSkill(projectId, name) };
      } catch (e) {
        outcome = { name, ok: false, message: `skill-pool link falló: ${e.message || String(e)}` };
      }
    }
    steps.push({ step: `skill:${name}`, ok: outcome.ok, message: outcome.message });
    return outcome;
  });
}
