/**
 * manage.mjs - `list`, `clean`, `merge` y `status` del delegador.
 *
 * - `merge <id>`: exige arbol principal limpio y base ancestro de HEAD, hace
 *   `git merge --squash` de la rama verde (sin commit), registra el paso
 *   `squash-prepared` y borra los worktrees; las ramas se quedan hasta `clean`.
 *   `final: merged` llega cuando existe el commit (`settleSquash` en
 *   squash.mjs, que comprueban `merge`, `list`, `clean` y `gc`).
 * - `clean <id>`: borra worktrees (tambien los huerfanos `aN/wt`), ramas
 *   `delegate/<id>*` y logs; registra `final: discarded` salvo que la
 *   delegacion ya tenga desenlace (o el squash ya tenga commit: `merged`). Con
 *   el squash preparado y sin commit se niega. meta.json se valida en
 *   cleanup.mjs.
 * - `status [--json]`: disponibilidad de cada motor (contrato, seccion 3).
 * - `gc [--days N] [--dry-run]`: borra (como `clean`) las delegaciones
 *   terminadas hace mas de N dias (2 por defecto) que ya no guardan trabajo:
 *   fusionadas, descartadas o sin ninguna rama. Una rama conservada (verde o
 *   para revisar) sin desenlace no se toca; se avisa. `run` lo lanza al empezar
 *   para que no se acumulen. Las ramas se comprueban en el repo: meta.json puede
 *   nombrar una que ya no existe.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { engineStatus, publicStatus } from './availability.mjs';
import { ID_PATTERN, delegationDir, dropAll, isOwnBranch, readMeta } from './cleanup.mjs';
import { allEngineIds, delegationsDir, loadConfig } from './config.mjs';
import { finalOf, recordFinal } from './ledger.mjs';
import { UsageError, git } from './proc.mjs';
import { SQUASH_PREPARED, prepareSquash, settleSquash } from './squash.mjs';

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null);

const DAY_MS = 86_400_000;
export const GC_DAYS = 2;

function delegationIds() {
  const root = delegationsDir();
  return existsSync(root) ? readdirSync(root).filter((d) => ID_PATTERN.test(d) && existsSync(join(root, d, 'meta.json'))) : [];
}

/**
 * Ids que `gc` puede borrar. Pura: `entries` = { id, finishedMs (null = en
 * curso o abortada), final, winner, kept (ramas conservadas que existen) }.
 */
export function gcCandidates(entries, nowMs, days = GC_DAYS) {
  return entries
    .filter((e) => e.finishedMs !== null && nowMs - e.finishedMs >= days * DAY_MS && (e.final || !holdsWork(e)))
    .map((e) => e.id);
}

/** Guarda trabajo sin revisar: rama verde o conservada que sigue existiendo. */
const holdsWork = (e) => Boolean(e.winner) || (e.kept || []).length > 0;

/**
 * Comprobador `(repo, rama) -> existe` para una pasada de `gc` o `list`, con una
 * sola llamada a git por repo: `run` lanza `gc` cada vez. Un repo que ya no existe
 * no tiene ramas.
 */
function branchChecker() {
  const byRepo = new Map();
  return (repo, branch) => {
    if (!byRepo.has(repo)) {
      const refs = git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/delegate/'], { allowFail: true });
      byRepo.set(repo, new Set(refs.split(/\r?\n/)));
    }
    return byRepo.get(repo).has(branch);
  };
}

/** settleSquash sin abortar el listado: un repo que ya no existe no es motivo para parar. */
function settleQuietly(id, m) {
  try {
    return settleSquash(id, m);
  } catch (e) {
    console.error(`aviso: no se pudo comprobar el squash de ${id} (${e.message})`);
    return null;
  }
}

function gcEntry(id, branchAlive) {
  const result = join(delegationsDir(), id, 'result.json');
  let winner = null;
  let kept = [];
  try {
    const m = readMeta(id);
    winner = m.winner && branchAlive(m.repo, m.winner) ? m.winner : null;
    kept = (m.attempts || []).filter((a) => a.kept && a.branch && branchAlive(m.repo, a.branch)).map((a) => a.branch);
    if (!finalOf(id)) settleQuietly(id, m);
  } catch (e) {
    console.error(`gc: meta.json de ${id} no se puede leer (${e.message}); sin ramas que proteger`);
  }
  return { id, finishedMs: existsSync(result) ? statSync(result).mtimeMs : null, final: finalOf(id), winner, kept };
}

/** Un `clean` que se niega (squash sin commit) no corta el resto del gc. */
function cleanForGc(id) {
  try {
    cmdClean(id, { quiet: true });
  } catch (e) {
    console.error(`gc: ${id} no se borra (${e.message})`);
  }
}

export function cmdGc(opts = {}, { quiet = false } = {}) {
  const days = opts.days === undefined ? GC_DAYS : Number(opts.days);
  if (!Number.isFinite(days) || days < 0) throw new UsageError(`--days ${opts.days}: debe ser un numero >= 0`);
  const branchAlive = branchChecker();
  const entries = delegationIds().map((id) => gcEntry(id, branchAlive));
  const doomed = gcCandidates(entries, Date.now(), days);
  for (const id of doomed) {
    if (opts['dry-run']) console.log(`gc: se borraria ${id}`);
    else cleanForGc(id);
  }
  const kept = entries.filter((e) => holdsWork(e) && !e.final && !doomed.includes(e.id));
  if (!quiet || doomed.length) {
    const verb = opts['dry-run'] ? 'se borrarian' : 'borradas';
    console.log(`gc: ${doomed.length} delegacion(es) ${verb}${kept.length ? `; ${kept.length} con rama sin fusionar ni descartar: ${kept.map((e) => e.id).join(', ')}` : ''}.`);
  }
  return 0;
}

/** Rama verde tal como esta en el repo, no como la recuerda meta.json. */
function winnerLabel(m, branchAlive) {
  if (!m.winner) return 'sin rama verde';
  return branchAlive(m.repo, m.winner) ? m.winner : `rama desaparecida (${m.winner})`;
}

export function cmdList() {
  const root = delegationsDir();
  const ids = delegationIds();
  if (!ids.length) {
    console.log('Sin delegaciones.');
    return 0;
  }
  const branchAlive = branchChecker();
  for (const id of ids.sort()) {
    const m = readMeta(id);
    const res = readJson(join(root, id, 'result.json'));
    const squash = finalOf(id) ? null : settleQuietly(id, m);
    const final = finalOf(id) || (squash ? `${SQUASH_PREPARED} (${squash})` : null);
    const state = res ? `exit ${res.code}` : 'en curso o abortada';
    const engines = (m.attempts || []).filter((a) => a.outcome !== 'skipped').map((a) => `${a.engine}:${a.reason ? `${a.outcome}[${a.reason}]` : a.outcome}`).join(' ');
    console.log(`${id} · ${state}${final ? ` · ${final}` : ''} · ${winnerLabel(m, branchAlive)} · ${engines || '-'} · ${m.title}`);
  }
  return 0;
}

export function cmdClean(id, { quiet = false } = {}) {
  if (!id) throw new UsageError('uso: delegate.mjs clean <id>');
  const m = readMeta(id);
  // Antes de borrar las ramas: sin ellas ya no se puede saber si el squash tiene commit.
  if (!finalOf(id) && settleSquash(id, m) === 'pending') {
    throw new UsageError(`la delegacion ${id} tiene el squash preparado sin commit en ${m.repo}: haz el commit (queda merged) o deshazlo (git reset) antes de clean`);
  }
  const branches = dropAll(id, m, true);
  rmSync(delegationDir(id), { recursive: true, force: true });
  const final = finalOf(id);
  if (!final) recordFinal(id, 'discarded');
  if (!quiet) console.log(`Delegacion ${id} eliminada (worktrees, ramas ${branches.join(', ') || 'ninguna'} y logs)${final ? `; desenlace ya registrado: ${final}` : '; registrada como discarded'}.`);
  return 0;
}

function mergeBranch(m, opts) {
  const own = (m.attempts || []).map((a) => a.branch).filter(Boolean);
  const branch = opts.branch || m.winner;
  if (!branch) throw new UsageError(`la delegacion ${m.id} no tiene rama verde; ramas conservadas: ${own.join(', ') || 'ninguna'} (usa --branch <rama> para fusionar una a sabiendas)`);
  if (!own.includes(branch) || !isOwnBranch(m.id, branch)) {
    throw new UsageError(`--branch ${branch} no es de la delegacion ${m.id} (${own.join(', ') || 'sin ramas'})`);
  }
  return { branch, sha: assertValidatedSha(m, branch) };
}

/**
 * El nombre de la rama es mutable: se fusiona el commit registrado al terminar
 * el intento, el que tiene el arbol validado. Devuelve su SHA o lanza UsageError.
 */
function assertValidatedSha(m, branch) {
  const attempt = (m.attempts || []).find((a) => a.branch === branch);
  const expected = branch === m.winner ? m.validatedSha : attempt && attempt.sha;
  if (!expected) throw new UsageError(`la delegacion ${m.id} no registra el SHA de ${branch} (es anterior a esta comprobacion o el intento no hizo commit): vuelve a delegar o fusionala a mano`);
  const current = git(m.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  if (current !== expected) {
    throw new UsageError(`la rama ${branch} ya no apunta al commit validado (${String(expected).slice(0, 10)}, ahora ${current.slice(0, 10)}): no se fusiona; revisala a mano`);
  }
  return expected;
}

export function cmdMerge(id, opts = {}) {
  if (!id) throw new UsageError('uso: delegate.mjs merge <id> [--branch <rama>]');
  const m = readMeta(id);
  const prior = finalOf(id) ? null : settleSquash(id, m);
  const final = finalOf(id);
  if (final) throw new UsageError(`la delegacion ${id} ya tiene desenlace: ${final}`);
  if (prior === 'pending') {
    throw new UsageError(`la delegacion ${id} ya tiene el squash preparado sin commit en ${m.repo}: haz el commit o deshazlo (git reset)`);
  }
  const { branch, sha } = mergeBranch(m, opts);
  prepareSquash(id, m.repo, branch, sha);
  dropAll(id, m, false);
  const suspect = (m.attempts || []).find((a) => a.branch === branch)?.suspect || [];
  if (suspect.length) console.log(`AVISO: durante ese intento cambiaron ${suspect.length} entrada(s) del checkout sin poder atribuirlas al motor; lista en meta.json (attempts[].suspect).`);
  writeFileSync(join(delegationDir(id), 'meta.json'), JSON.stringify({ ...m, squashPreparedAt: new Date().toISOString(), mergedBranch: branch }, null, 2));
  console.log([
    `Squash de ${branch} preparado en ${m.repo}: SIN commit (revisa \`git diff --cached\` y haz el commit; los hooks del repo corren entonces).`,
    `Ledger: ${SQUASH_PREPARED}; pasa a merged cuando el commit exista (lo comprueban list, gc, clean y merge).`,
    'Worktrees borrados; las ramas siguen hasta `node scripts/delegate.mjs clean ' + id + '`.',
  ].join('\n'));
  return 0;
}

function statusLine(s) {
  const quota = s.quota ? ` · cuota ${s.quota.usedPct} % (${s.quota.window})` : '';
  const balance = s.balance ? ` · saldo ${s.balance.total ?? '?'} ${s.balance.currency ?? ''} (${s.balance.available ? 'disponible' : 'no disponible'})` : '';
  const key = s.keyPresent === null ? '' : ` · key ${s.keyPresent ? 'presente' : 'ausente'}`;
  const state = s.available ? 'disponible' : `NO (${s.reason}: ${s.detail})`;
  return `${s.id.padEnd(16)} ${String(s.runner).padEnd(9)} ${String(s.model)} · ${state}${key}${quota}${balance}`;
}

export async function cmdStatus(opts = {}) {
  const cfg = loadConfig();
  const ids = allEngineIds(cfg.config);
  const statuses = await Promise.all(ids.map((id) => engineStatus(cfg.config, id)));
  if (opts.json) {
    console.log(JSON.stringify({ chain: cfg.config.chain, engines: statuses.map(publicStatus), configSource: cfg.source }));
    return 0;
  }
  const source = cfg.source === 'file' ? `config: ${cfg.path}` : `config: valor por defecto ${cfg.path} (${cfg.note})`;
  console.log([`cadena: ${cfg.config.chain.join(' -> ')}`, source, ...statuses.map(statusLine)].join('\n'));
  return 0;
}
