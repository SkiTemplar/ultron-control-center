/**
 * attempt.mjs - un intento: worktree nuevo -> motor -> alcance -> check -> commit.
 *
 * Desenlaces (`outcome` del ledger): ok | check-fail | engine-fail | no-changes
 * | timeout. Una ruptura del aislamiento (isolation.mjs) es engine-fail con motivo
 * `isolation` y corta el relevo; un cambio del checkout que no se puede atribuir
 * al motor no descarta nada: el check cuenta y queda como `isolation-suspect`.
 *
 * Lo que se valida es lo que se commitea: `tree` sale del indice antes del check
 * y, si el check cambia el worktree o el indice, el verde no vale (`tree-changed`).
 * El commit se hace de ese `tree` y su SHA va a meta.json (`merge` lo exige).
 *
 * Un intento sin cambios borra su worktree y su rama; con cambios (aunque el
 * motor fallara o el check saliera rojo) se hace commit y se conserva la rama
 * para revisarla. Con la config de git tocada no se lanza ni un `git add` mas: el
 * worktree se queda como esta para revisarlo a mano.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIEF_FILE, adapterFor, classifyProviderError, engineCommand } from './adapters.mjs';
import { UsageError, runLogged, tail } from './proc.mjs';
import { engineEnv, scrubbedEnv } from './env.mjs';
import {
  ISOLATION_SUSPECT_REASON, gitGuardChanges, gitGuardSnapshot, isolationState, mainRepoSnapshot, tamperedVerdict,
} from './isolation.mjs';
import { commitTree, dropWorktree, outOfScope, prepareWorktree, stageResult, treeDrift } from './worktree.mjs';

const CHECK_TIMEOUT_S = 900;
/** Motivo de un check que cambio lo que estaba validando. */
export const TREE_CHANGED_REASON = 'tree-changed';
/** Runners cuyo motor no puede escribir fuera del worktree (contrato, Aislamiento). */
const SANDBOXED_RUNNERS = new Set(['codex']);

/** Ejecuta el motor en el worktree y clasifica su salida. */
async function execEngine(run, st, dir, wt) {
  const adapter = adapterFor(st.runner);
  const lastFile = join(dir, 'last.md');
  const logFile = join(dir, 'engine.log');
  const engine = run.config.engines[st.id];
  const { file, args, input } = engineCommand(adapter, { id: run.id, model: st.model, wt, lastFile, prompt: run.prompt, engine });
  const env = engineEnv(run.config, st, engine);
  const r = await runLogged({ file, args }, { cwd: wt, input, logFile, timeoutS: run.timeoutS, env, watch: adapter.watch });
  const parsed = adapter.parse({ stdout: r.stdout, lastFile, logFile });
  return { ...r, ...parsed, logFile };
}

/** Desenlace del motor antes de mirar el diff, o null si el motor termino bien. */
function engineVerdict(ex) {
  if (ex.timedOut) return { outcome: 'timeout', reason: 'timeout', engineText: 'timeout' };
  if (ex.watchHit) return { outcome: 'engine-fail', reason: ex.watchHit, engineText: `abortado (${ex.watchHit})` };
  if (ex.error) return { outcome: 'engine-fail', reason: 'spawn', engineText: `no arranca (${ex.error.message})` };
  if (ex.status !== 0) {
    const reason = classifyProviderError(tail(ex.logFile, 40)) || `exit ${ex.status}`;
    return { outcome: 'engine-fail', reason, engineText: `exit ${ex.status}` };
  }
  if (ex.failReason) return { outcome: 'engine-fail', reason: ex.failReason, engineText: `exit 0 con error (${ex.failReason})` };
  return null;
}

/** Alcance y check sobre un diff con cambios. */
async function checkVerdict(run, files, dir, wt) {
  const outside = outOfScope(files, run.scope);
  if (outside.length) {
    return { outcome: 'check-fail', reason: 'scope', checkOk: false, check: { ok: false, status: 'scope', outside } };
  }
  if (!run.check) return { outcome: 'ok', reason: null, checkOk: null, check: null };
  const logFile = join(dir, 'check.log');
  // El check ejecuta codigo escrito por el motor: entorno sin ninguna key.
  const env = scrubbedEnv(run.config);
  const c = await runLogged({ shellCmd: run.check }, { cwd: wt, input: null, logFile, timeoutS: CHECK_TIMEOUT_S, env });
  const ok = c.status === 0 && !c.timedOut;
  const check = { ok, status: c.timedOut ? 'timeout' : c.status, logFile };
  return ok
    ? { outcome: 'ok', reason: null, checkOk: true, check }
    : { outcome: 'check-fail', reason: 'check', checkOk: false, check };
}

const attemptPaths = (run, attempt, first) => {
  const dir = join(run.dir, `a${attempt}`);
  return { branch: first ? `delegate/${run.id}` : `delegate/${run.id}-a${attempt}`, dir, wt: join(dir, 'wt') };
};

/** Lo que dice el motor antes de ejecutar nada de su codigo. */
function preCheckVerdict(ex, files) {
  const failed = engineVerdict(ex);
  if (failed) return { checkOk: null, check: null, ...failed };
  if (!files.length) return { outcome: 'no-changes', reason: null, checkOk: null, check: null };
  return null;
}

/** El check ejecuta codigo del motor: se compara todo otra vez, sin sandbox. */
function afterCheckVerdict(run, ctx, verdict) {
  const { guard, before, wt, files, tree } = ctx;
  const ran = { checkOk: verdict.checkOk, check: verdict.check };
  const tampered = gitGuardChanges(guard);
  if (tampered.length) return { ...tamperedVerdict(tampered), ...ran, untouchable: true };
  const iso = isolationState(run, before, { wt, files, sandboxed: false, engineFinishedClean: false });
  if (iso.broken) return { ...iso.broken, ...ran };
  const drift = treeDrift(wt, run.links, tree);
  if (drift.length && verdict.outcome === 'ok') {
    return {
      outcome: 'check-fail', reason: TREE_CHANGED_REASON, checkOk: false, suspect: iso.suspect,
      check: { ...verdict.check, ok: false, status: TREE_CHANGED_REASON, drift },
    };
  }
  return { ...verdict, suspect: iso.suspect };
}

/** Veredicto de un intento cuyo motor ya termino y cuyo resultado esta en `tree`. */
async function judge(run, st, ex, ctx) {
  const { before, wt, files, dir } = ctx;
  const early = preCheckVerdict(ex, files);
  const iso = isolationState(run, before, {
    wt, files, sandboxed: SANDBOXED_RUNNERS.has(st.runner), engineFinishedClean: early !== null && early.outcome === 'no-changes',
  });
  if (iso.broken) return iso.broken;
  if (early) return { ...early, suspect: iso.suspect };
  const verdict = await checkVerdict(run, files, dir, wt);
  if (!verdict.check || !verdict.check.logFile) return { ...verdict, suspect: iso.suspect };
  return afterCheckVerdict(run, ctx, verdict);
}

/** Registro final del intento; `extra` trae lo que cambia segun como acabo. */
function attemptResult(run, st, attempt, started, ex, verdict, extra) {
  const suspect = verdict.suspect || [];
  return {
    attempt, engine: st.id, runner: st.runner, model: st.model,
    engineText: verdict.engineText || `exit ${ex.status}`,
    ...verdict,
    reason: verdict.reason || (suspect.length ? ISOLATION_SUSPECT_REASON : null),
    suspect,
    skipReason: null,
    durationS: Math.round((Date.now() - started) / 1000),
    costUsd: ex.costUsd ?? null,
    reply: String(ex.reply || '').trim(),
    isolation: verdict.isolation || null,
    ...extra,
  };
}

/**
 * Un intento con el motor `st` (estado de availability.mjs).
 * `first` = primer intento real de la delegacion (rama `delegate/<id>`).
 */
export async function runAttempt(run, st, attempt, first) {
  const { branch, dir, wt } = attemptPaths(run, attempt, first);
  const baseSha = prepareWorktree(run.repo, run.base, wt, branch, run.links);
  writeFileSync(join(wt, BRIEF_FILE), run.prompt);
  const started = Date.now();
  const guard = gitGuardSnapshot(wt);
  const before = mainRepoSnapshot(run.repo, run.dir);
  const ex = await execEngine(run, st, dir, wt);
  const untouchable = { filesChanged: 0, branch, wt, dir, kept: false, stat: null, sha: null };
  const tampered = gitGuardChanges(guard);
  if (tampered.length) return attemptResult(run, st, attempt, started, ex, tamperedVerdict(tampered), untouchable);
  const { files, tree } = stageResult(wt, run.links, baseSha);
  const verdict = await judge(run, st, ex, { guard, before, wt, files, tree, dir });
  if (verdict.untouchable) return attemptResult(run, st, attempt, started, ex, verdict, untouchable);
  const kept = files.length > 0;
  const commit = kept ? commitTree(wt, branch, { tree, baseSha }, { title: run.title, engine: st.id, model: st.model }) : null;
  if (!kept) dropWorktree(run.repo, wt, run.links, branch);
  return attemptResult(run, st, attempt, started, ex, verdict, {
    filesChanged: files.length, branch: kept ? branch : null, wt: kept ? wt : null, dir, kept,
    stat: commit ? commit.stat : null, sha: commit ? commit.sha : null,
  });
}

/** Intento saltado (motor no disponible): solo va al ledger y al resumen. */
export function skippedAttempt(st, attempt) {
  return {
    attempt, engine: st.id, runner: st.runner, model: st.model,
    outcome: 'skipped', skipReason: st.reason, reason: st.detail,
    durationS: 0, checkOk: null, filesChanged: 0, costUsd: null, branch: null, kept: false,
  };
}

/** Primera linea de un error, sin las rutas del repo ni de la delegacion. */
function errorText(run, err) {
  const first = String(err && err.message ? err.message : err).split(/\r?\n/)[0];
  return first.split(run.repo).join('<repo>').split(run.dir).join('<dir>').slice(0, 160);
}

/**
 * Intento que lanzo una excepcion (git: worktree add, index.lock, commit sin
 * identidad...): se limpian su worktree y su rama y cuenta como engine-fail
 * con motivo `git: ...` (o `error: ...`) para que el relevo siga.
 */
export function failedAttempt(run, st, attempt, first, err) {
  const { branch, dir, wt } = attemptPaths(run, attempt, first);
  try {
    dropWorktree(run.repo, wt, run.links, branch);
  } catch (e) {
    console.error(`aviso: no se pudo limpiar el intento ${attempt} (${e.message}); usa clean ${run.id}`);
  }
  const reason = `${err instanceof UsageError ? 'git' : 'error'}: ${errorText(run, err)}`;
  return {
    attempt, engine: st.id, runner: st.runner, model: st.model,
    outcome: 'engine-fail', reason, engineText: `excepcion (${reason})`, checkOk: null, check: null,
    skipReason: null, durationS: 0, filesChanged: 0, costUsd: null,
    branch: null, wt: null, dir, kept: false, stat: null, reply: '',
  };
}
