/**
 * post-engine.mjs - excepciones de git dentro de un intento (auditoria del
 * 2026-11-08, hallazgo 15). Una excepcion posterior al motor (recoger el
 * resultado o hacer el commit) conserva el worktree con el trabajo, lo marca
 * `kept` sin rama con `review` en meta.json y no pasa el relevo; una previa al
 * motor (preparar el worktree) limpia como siempre y el relevo sigue. Los dos
 * primeros casos fallan sin el arreglo. Lo ejecuta scripts/delegate.selftest.mjs.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRIEF, DELEG, REPO, ROOT, branchExists, check, delegate, idOf, ledgerOf, run, worktreeCount } from './harness.mjs';

const metaOf = (id) => JSON.parse(readFileSync(join(DELEG, id, 'meta.json'), 'utf8'));
const enginesOf = (id) => ledgerOf(id).filter((e) => e.engine).map((e) => [e.engine, e.outcome]);

/** Comprobaciones comunes de un intento conservado tras una excepcion posterior al motor. */
function assertKeptForReview(r, phase) {
  assert.equal(r.code, 2, r.out);
  const id = idOf(r.out);
  assert.deepEqual(enginesOf(id), [['codex', 'engine-fail']], 'con trabajo sin recoger no se lanza el siguiente motor');
  const [a] = metaOf(id).attempts;
  assert.equal(a.kept, true);
  assert.equal(a.branch, null, 'no hay rama con el trabajo');
  assert.ok(a.wt && existsSync(join(a.wt, 'hecho.txt')), 'el worktree sigue con el trabajo del motor');
  assert.equal(a.review.phase, phase);
  assert.match(a.review.reason, /^git: /);
  assert.equal(a.review.wt, a.wt);
  assert.equal(a.review.filesChanged, 1);
  assert.deepEqual(a.review.files, ['hecho.txt']);
  assert.equal(metaOf(id).wt, a.wt, 'meta.json apunta al worktree que hay que revisar');
  assert.ok(r.out.includes(a.wt), 'el resumen da la ruta del worktree');
  assert.match(r.out, /SIN commit/);
  assert.match(r.out, /relevo se ha cortado/);
  assert.ok(r.out.includes(`clean ${id}`), 'el resumen da el siguiente paso');
  return { id, wt: a.wt };
}

/** Hook post-checkout que falla una sola vez: `git worktree add` sale con 1. */
function failNextCheckout() {
  const marker = join(ROOT, 'fail-checkout.marker');
  const hook = join(REPO, '.git', 'hooks', 'post-checkout');
  const m = marker.replace(/\\/g, '/');
  writeFileSync(hook, `#!/bin/sh\nif [ -f "${m}" ]; then rm "${m}"; exit 1; fi\nexit 0\n`);
  writeFileSync(marker, '');
  return () => rmSync(hook, { force: true });
}

export async function postEngineTests() {
  await run('excepcion de git al recoger el resultado (index.lock) -> worktree conservado, kept sin rama y sin relevo', () => {
    const before = worktreeCount();
    const r = delegate(['run', '--tier', 'complex', '--brief', BRIEF, '--no-check'], 'codex:lock,*:write');
    const { id, wt } = assertKeptForReview(r, 'stage');
    assert.match(delegate(['list']).out, /worktree sin commit para revisar a mano/);
    assert.equal(delegate(['gc', '--days', '0']).code, 0);
    assert.ok(existsSync(join(wt, 'hecho.txt')), 'gc no borra un worktree con trabajo sin revisar');
    assert.equal(delegate(['clean', id]).code, 0);
    assert.equal(existsSync(wt), false, 'clean borra el worktree conservado');
    assert.equal(branchExists(`delegate/${id}`), false, 'y la rama que creo worktree add');
    assert.equal(worktreeCount(), before);
  });

  await run('excepcion de git en commit-tree (identidad vacia) tras el check verde -> worktree conservado y sin relevo', () => {
    const r = delegate(['run', '--tier', 'complex', '--brief', BRIEF, '--check', check(0)], 'write', { GIT_AUTHOR_NAME: '' });
    const { id } = assertKeptForReview(r, 'commit');
    assert.equal(metaOf(id).attempts[0].outcome, 'engine-fail');
    assert.match(r.out, /check: OK/, 'el check verde se informa aunque el commit falle');
    assert.equal(delegate(['clean', id]).code, 0);
  });

  await run('excepcion de git al preparar el worktree (antes del motor) -> se limpia y el relevo sigue', () => {
    const restore = failNextCheckout();
    try {
      const r = delegate(['run', '--tier', 'complex', '--brief', BRIEF, '--no-check']);
      assert.equal(r.code, 0, r.out);
      const id = idOf(r.out);
      const lines = ledgerOf(id);
      assert.deepEqual(lines.map((e) => [e.engine, e.outcome]), [['codex', 'engine-fail'], ['agy', 'ok']]);
      assert.match(lines[0].reason, /^git: /);
      const [a] = metaOf(id).attempts;
      assert.equal(a.kept, false);
      assert.equal(a.review, null);
      assert.equal(existsSync(join(DELEG, id, 'a1', 'wt')), false, 'el worktree del intento roto se borra');
      assert.equal(branchExists(`delegate/${id}`), false, 'el intento roto no deja rama');
      assert.equal(delegate(['clean', id]).code, 0);
    } finally {
      restore();
    }
  });
}
