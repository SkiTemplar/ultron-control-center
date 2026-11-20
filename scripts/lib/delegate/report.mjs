/**
 * report.mjs - resumen corto de `run`: una linea por motor (intentado o
 * saltado) y el detalle del intento decisivo (el verde o el ultimo real).
 */

import { tail } from './proc.mjs';

const REPLY_MAX_CHARS = 900;
const LIST_MAX = 20;

/** Lista recortada: un commit en el principal puede tocar cientos de entradas (la completa va a meta.json). */
const listed = (items) => `${items.slice(0, LIST_MAX).join(', ')}${items.length > LIST_MAX ? ` … y ${items.length - LIST_MAX} mas` : ''}`;

/** Aviso de `run`: el worktree parte de un commit y deja fuera lo no commiteado. */
function baseLine(run) {
  const left = run.dirtyAtStart ? ` · AVISO: ${run.dirtyAtStart} entrada(s) sin commitear del checkout principal se quedan fuera; el motor y el check trabajan sin ellas` : '';
  return `base: ${run.base} (${String(run.baseSha).slice(0, 10)})${left}`;
}

/** Cuantos ficheros dejo el motor sin recoger, en palabras. */
const reviewCount = (r) => (r.filesChanged === null ? 'ficheros sin contar (git no responde)' : `${r.filesChanged} fichero(s) cambiado(s)`);

function keptLabel(a) {
  if (a.review) return ` · worktree ${a.wt} conservado SIN commit (excepcion tras el motor en la fase ${a.review.phase}; ${reviewCount(a.review)}; revisalo a mano)`;
  if (a.kept) return ` · rama ${a.branch} conservada`;
  return a.wt ? ` · worktree ${a.wt} conservado (config de git tocada; sin commit)` : ' · worktree borrado (sin cambios)';
}

function attemptLine(a) {
  const head = `intento ${a.attempt} · ${a.engine} (${a.model ?? '?'})`;
  if (a.outcome === 'skipped') return `${head} · saltado: ${a.skipReason} (${a.reason})`;
  const mins = Math.round(a.durationS / 60);
  const why = a.reason && a.outcome !== 'ok' ? ` [${a.reason}]` : '';
  return `${head} · ${a.outcome}${why} · motor ${a.engineText} · ${mins} min${keptLabel(a)}`;
}

/** Intento con el trabajo del motor sin recoger: lo que hay y que hacer con el. */
function reviewLines(run, a) {
  const r = a.review;
  const files = r.files.length ? `: ${listed(r.files)}` : '';
  return [
    `rama: ninguna (git fallo al recoger el trabajo del motor) · worktree: ${a.wt}`,
    `cambios: ${reviewCount(r)} SIN commit en el worktree${files}`,
    `AVISO: el worktree NO se ha borrado y ${r.filesChanged === 0 ? 'el relevo ha seguido (sin cambios que perder)' : 'el relevo se ha cortado para no repetir la tarea con otro motor'}. Revisalo a mano: git -C "${a.wt}" status; recoge lo que sirva y despues node scripts/delegate.mjs clean ${run.id}`,
  ];
}

function checkLines(run, a) {
  if (a.check && a.check.status === 'scope') {
    return [`check: FALLA (scope) · fuera del alcance (${run.scope.join(', ')}): ${a.check.outside.join(', ')}`];
  }
  if (a.check && a.check.drift) {
    return [`check: FALLA (tree-changed) · ha salido bien pero ha cambiado lo que validaba; el commit lleva el arbol anterior al check. Si son artefactos del propio check, que los ignore .gitignore: ${listed(a.check.drift)}`];
  }
  if (a.check) {
    const lines = [`check: ${a.check.ok ? 'OK' : `FALLA (${a.check.status})`} · ${run.check}`];
    if (!a.check.ok) lines.push(tail(a.check.logFile, 8));
    return lines;
  }
  if (!run.check) return ['check: sin comando (--no-check)'];
  if (a.review) return [`check: no se ejecuto (git fallo antes, en la fase ${a.review.phase})`];
  return ['check: no se ejecuto (el motor fallo o no cambio nada)'];
}

/** Ficheros del checkout principal que cambiaron durante el intento (isolation.mjs). */
function isolationLines(a) {
  if (a.isolation && a.isolation.length) {
    return [`AISLAMIENTO ROTO: el motor escribio fuera del worktree (no se ha revertido nada; revisalo a mano): ${listed(a.isolation)}`];
  }
  if (a.suspect && a.suspect.length) {
    return [`AISLAMIENTO SOSPECHOSO: el repo principal cambio durante el intento y no se puede atribuir al motor (la actividad de la sesion da lo mismo); el resultado del check vale, comprueba que estos ficheros son tuyos: ${listed(a.suspect)}`];
  }
  return [];
}

function resultLine(a, code) {
  if (code === 0) return `resultado: OK con ${a.engine}`;
  if (code === 1) return `resultado: CHECK ROJO con ${a.engine}`;
  if (a.review) return `resultado: el motor ${a.engine} termino, pero git fallo al recoger su trabajo (${a.reason}); queda en el worktree para revisarlo a mano (vuelve a Opus)`;
  return 'resultado: ningun motor completo la tarea (vuelve a Opus)';
}

function changeLines(run, a) {
  if (a.review) return reviewLines(run, a);
  return [
    a.kept ? `rama: ${a.branch} · worktree: ${a.wt}` : `rama: ninguna (intento ${a.attempt} sin cambios)`,
    a.stat ? `cambios:\n${a.stat}` : 'cambios: ninguno (el delegado no modifico nada)',
  ];
}

function detailLines(run, a, code) {
  const reply = a.reply || '';
  const lines = [
    resultLine(a, code),
    ...changeLines(run, a),
    ...checkLines(run, a),
    ...isolationLines(a),
    `respuesta del delegado:\n${reply.slice(0, REPLY_MAX_CHARS)}${reply.length > REPLY_MAX_CHARS ? ' […]' : ''}`,
  ];
  if (a.costUsd !== null && a.costUsd !== undefined) lines.push(`coste: ${a.costUsd} USD`);
  return lines;
}

function nextSteps(run, attempts, code) {
  const review = attempts.filter((a) => a.review && a.review.filesChanged !== 0).map((a) => a.wt);
  const pending = review.length ? `worktrees SIN commit para revisar a mano (clean los borra): ${review.join(', ')} · ` : '';
  if (code === 0) {
    return `${pending}fusionar: node scripts/delegate.mjs merge ${run.id} · descartar: node scripts/delegate.mjs clean ${run.id}`;
  }
  const kept = attempts.filter((a) => a.kept && a.branch).map((a) => a.branch);
  const branches = kept.length ? `ramas conservadas para revisar: ${kept.join(', ')} · ` : '';
  return `${pending}${branches}limpiar: node scripts/delegate.mjs clean ${run.id}`;
}

export function report(run, attempts, code) {
  const source = run.configSource === 'file' ? 'config: fichero' : `config: valor por defecto (${run.configNote})`;
  const lines = [`delegate ${run.id} · tier ${run.tier} · ${run.relay ? 'relevo activo' : 'sin relevo'} · ${source}`, baseLine(run)];
  lines.push(...attempts.map(attemptLine));
  const real = attempts.filter((a) => a.outcome !== 'skipped');
  const decisive = real.find((a) => a.outcome === 'ok') || real[real.length - 1];
  if (decisive) lines.push(...detailLines(run, decisive, code));
  else lines.push('resultado: ningun motor disponible (vuelve a Opus)');
  lines.push(`logs: ${run.dir}`);
  lines.push(nextSteps(run, attempts, code));
  return lines;
}
