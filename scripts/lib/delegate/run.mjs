/**
 * run.mjs - `delegate.mjs run`: planifica, recorre la cadena con relevo y
 * escribe meta.json, result.json y el ledger.
 *
 * Relevo (solo con `--engine auto`, sin `--no-relay`): un motor no disponible
 * se salta (y se registra); fallo, timeout o sin cambios pasa al siguiente con
 * un worktree nuevo; check rojo pasa al siguiente si `relayOnCheckFail`.
 * `--engine <id>` fuerza un solo motor: si no esta disponible es un error de
 * uso (exit 3), como antes con la cuota. `--no-relay` hace un unico intento
 * real con el primer motor disponible de la cadena.
 *
 * Una excepcion dentro de un intento (git) se registra como engine-fail y el
 * relevo sigue; meta.json se reescribe tras cada intento. Una ruptura del
 * aislamiento (motivo `isolation`) corta el relevo: el repo necesita revision
 * humana antes de lanzar otro motor encima; una mera sospecha no (isolation.mjs).
 * Un check que cambia lo que valida (`tree-changed`) tambien lo corta: el defecto
 * suele ser del check y lo repetiria cualquier motor.
 *
 * Salida: 0 = un intento con cambios y check verde; 1 = check rojo sin relevo
 * posterior; 2 = ningun motor completo la tarea (vuelve a Opus); 3 = uso o git.
 */

import { randomBytes } from 'node:crypto';
import { cmdGc } from './manage.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPrompt } from './adapters.mjs';
import { engineStatus } from './availability.mjs';
import { DEFAULT_TIER, SAFE_MODEL, delegationsDir, engineOrder, isSafeModel, loadConfig } from './config.mjs';
import { recordAttempt } from './ledger.mjs';
import { TREE_CHANGED_REASON, failedAttempt, runAttempt, skippedAttempt } from './attempt.mjs';
import { UsageError, git } from './proc.mjs';
import { report } from './report.mjs';
import { ISOLATION_REASON, parsePorcelainZ } from './isolation.mjs';
import { checkLinks, parseScope } from './worktree.mjs';

const DEFAULT_TIMEOUT_S = 1800;

/** Id legible y unico aunque se lancen varias delegaciones en el mismo segundo. */
function stamp(prefix) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const safe = String(prefix).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${safe}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}-${randomBytes(2).toString('hex')}`;
}

function validateFlags(opts) {
  if (opts['no-check'] && opts.check) throw new UsageError('--check y --no-check son incompatibles');
  if (!opts['no-check'] && !opts.check) {
    throw new UsageError('--check "<comando>" es obligatorio (o --no-check explicito si el encargo no tiene verificacion)');
  }
  if (!opts.brief || !existsSync(opts.brief)) throw new UsageError('--brief <fichero> es obligatorio y debe existir');
  if (opts.model && (opts.engine || 'auto') === 'auto') throw new UsageError('--model solo vale con --engine <id> (cada motor de la cadena usa su modelo)');
  if (opts.model && !isSafeModel(opts.model)) throw new UsageError(`--model no valido (admitido ${SAFE_MODEL})`);
}

/** Todo lo que se valida antes de crear nada en disco. */
export function planRun(opts) {
  validateFlags(opts);
  const engine = opts.engine || 'auto';
  const tier = opts.tier || DEFAULT_TIER;
  const cfg = loadConfig();
  const order = engineOrder(cfg.config, { engine, tier });
  const repo = git(resolve(opts.repo || process.cwd()), ['rev-parse', '--show-toplevel']);
  checkLinks(repo, opts.link);
  if (opts.base) git(repo, ['rev-parse', '--verify', '--quiet', `${opts.base}^{commit}`]);
  const brief = readFileSync(opts.brief, 'utf8');
  const id = stamp(engine === 'auto' ? tier : engine);
  return {
    id, engine, tier, order, repo,
    auto: engine === 'auto',
    relay: engine === 'auto' && !opts['no-relay'],
    config: cfg.config, configSource: cfg.source, configNote: cfg.note,
    base: opts.base || 'HEAD',
    timeoutS: Number(opts.timeout) > 0 ? Number(opts.timeout) : DEFAULT_TIMEOUT_S,
    links: opts.link, scope: parseScope(opts.scope), check: opts.check || null,
    model: opts.model || null, force: Boolean(opts.force),
    title: (brief.split(/\r?\n/).find((l) => l.trim()) || 'tarea delegada').replace(/^#+\s*/, '').slice(0, 72),
    prompt: buildPrompt(brief, opts.check),
    dir: join(delegationsDir(), id),
  };
}

const statusOf = (run, id) => engineStatus(run.config, id, { tier: run.tier, model: run.model, force: run.force });

/** Un motor forzado y no disponible es un error de uso: no se crea nada. */
async function assertForced(run) {
  const st = await statusOf(run, run.order[0]);
  if (st.available) return st;
  if (st.reason === 'quota') throw new UsageError(`cuota casi agotada (${st.detail}); usa otro motor o --force`);
  throw new UsageError(`motor no disponible: ${st.reason} (${st.detail})`);
}

function shouldRelay(run, a) {
  if (a.outcome === 'ok' || !run.relay || a.reason === ISOLATION_REASON || a.reason === TREE_CHANGED_REASON) return false;
  return a.outcome !== 'check-fail' || run.config.relayOnCheckFail !== false;
}

/** Una excepcion en un intento no corta el relevo: cuenta como engine-fail. */
async function attemptSafely(run, st, n, first) {
  try {
    return await runAttempt(run, st, n, first);
  } catch (e) {
    return failedAttempt(run, st, n, first, e);
  }
}

async function walkChain(run, forced) {
  const attempts = [];
  for (const id of run.order) {
    const st = forced && forced.id === id ? forced : await statusOf(run, id);
    const n = attempts.length + 1;
    if (!st.available) {
      const skip = skippedAttempt(st, n);
      attempts.push(skip);
      recordAttempt(run, skip);
      writeMeta(run, attempts);
      continue;
    }
    const first = !attempts.some((x) => x.outcome !== 'skipped');
    const a = await attemptSafely(run, st, n, first);
    attempts.push(a);
    recordAttempt(run, a);
    writeMeta(run, attempts);
    if (!shouldRelay(run, a)) break;
  }
  return attempts;
}

export function exitCode(run, attempts) {
  const real = attempts.filter((a) => a.outcome !== 'skipped');
  if (real.some((a) => a.outcome === 'ok')) return 0;
  const last = real[real.length - 1];
  const noRelayAfterRed = !run.relay || run.config.relayOnCheckFail === false;
  return last && last.outcome === 'check-fail' && noRelayAfterRed ? 1 : 2;
}

/** Un intento en meta.json: `outside` solo existia en el stdout de `run`. */
function metaAttempt(a) {
  return {
    attempt: a.attempt, engine: a.engine, model: a.model, outcome: a.outcome, reason: a.reason,
    branch: a.branch, wt: a.wt, kept: a.kept, sha: a.sha || null,
    isolation: a.isolation || null, suspect: a.suspect || [],
    outside: (a.check && a.check.outside) || [],
  };
}

/** Entradas del checkout principal que el worktree deja fuera por partir de un commit. */
function dirtyEntries(repo) {
  const out = git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], { raw: true });
  return parsePorcelainZ(out).length;
}

function writeMeta(run, attempts, code = null) {
  const winner = attempts.find((a) => a.outcome === 'ok') || null;
  const lastKept = [...attempts].reverse().find((a) => a.kept) || null;
  const meta = {
    id: run.id, repo: run.repo, base: run.base, title: run.title, tier: run.tier, engine: run.engine,
    baseSha: run.baseSha, dirtyAtStart: run.dirtyAtStart,
    links: run.links, startedAt: run.startedAt, configSource: run.configSource,
    attempts: attempts.map(metaAttempt),
    winner: winner ? winner.branch : null,
    // El commit cuyo arbol paso el check: `merge` exige que la rama siga en el.
    validatedSha: winner ? winner.sha : null,
    wt: (winner || lastKept || {}).wt || null,
  };
  writeFileSync(join(run.dir, 'meta.json'), JSON.stringify(meta, null, 2));
  if (code !== null) writeFileSync(join(run.dir, 'result.json'), JSON.stringify({ code, winner: meta.winner }, null, 2));
}

export async function cmdRun(opts) {
  const run = planRun(opts);
  // Antes de crear un worktree nuevo, fuera los viejos que ya no guardan trabajo (manage.mjs, gc).
  try {
    cmdGc({}, { quiet: true });
  } catch (e) {
    console.error(`aviso: gc previo fallido (${e.message}); sigo con la delegacion`);
  }
  const forced = run.auto ? null : await assertForced(run);
  run.startedAt = new Date().toISOString();
  run.baseSha = git(run.repo, ['rev-parse', `${run.base}^{commit}`]);
  run.dirtyAtStart = dirtyEntries(run.repo);
  mkdirSync(run.dir, { recursive: true });
  writeMeta(run, []);
  const attempts = await walkChain(run, forced);
  const code = exitCode(run, attempts);
  writeMeta(run, attempts, code);
  console.log(report(run, attempts, code).join('\n'));
  return code;
}
