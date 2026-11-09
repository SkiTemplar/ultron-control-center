/**
 * ledger.mjs - registro append-only de delegaciones (cockpit/delegations.jsonl).
 *
 * Contrato: docs/delegacion-contrato.md, seccion 2. Una linea por
 * intento (incluidos los motores saltados) y una por desenlace (`final`).
 * `repo` es el nombre de la carpeta, nunca la ruta absoluta (repo publico).
 * Campo extra respecto al contrato: `reason` (motivo del desenlace del intento:
 * `scope`, `check`, `exit N`, `quota`, `auth`, `retry-exhausted`, `too-large`,
 * `context`, `timeout`, `tree-changed`, `isolation`, `isolation-suspect`… o null).
 * `isolationSuspect`: cuantas entradas del checkout cambiaron sin poder atribuirlas
 * al motor (solo el numero: las rutas van a meta.json, no a este registro).
 * Pasos sin desenlace: `{ts, id, stage, …}` (hoy solo `squash-prepared`, de
 * `merge`; ver squash.mjs). Los lectores del ledger (app y uso por motor) solo
 * miran `final` y las lineas con `engine`, asi que la ignoran.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { ledgerPath } from './config.mjs';

function append(entry) {
  const file = ledgerPath();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

/** Linea de un intento con el orden de campos del contrato. */
export function attemptEntry(run, a) {
  return {
    ts: new Date().toISOString(),
    id: run.id,
    attempt: a.attempt,
    engine: a.engine,
    runner: a.runner,
    model: a.model,
    tier: run.tier,
    outcome: a.outcome,
    skipReason: a.skipReason ?? null,
    durationS: a.durationS ?? 0,
    checkOk: a.checkOk ?? null,
    filesChanged: a.filesChanged ?? 0,
    costUsd: a.costUsd ?? null,
    branch: a.branch ?? null,
    title: run.title,
    repo: basename(run.repo),
    reason: a.reason ?? null,
    isolationSuspect: (a.suspect || []).length,
  };
}

export const recordAttempt = (run, a) => append(attemptEntry(run, a));

/** Desenlace (`merged` | `discarded`). `merged` solo cuando el commit del squash existe. */
export const recordFinal = (id, final) => append({ ts: new Date().toISOString(), id, final });

/** Paso intermedio sin desenlace (`squash-prepared`) con sus datos. */
export const recordStage = (id, stage, extra = {}) => append({ ts: new Date().toISOString(), id, stage, ...extra });

/** Lineas del ledger de una delegacion (las ilegibles se ignoran). */
export function readEntries(id) {
  const file = ledgerPath();
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((e) => e && e.id === id);
}

/** Desenlace ya registrado de una delegacion, o null. */
export const finalOf = (id) => readEntries(id).find((e) => e.final)?.final ?? null;

/** Ultimo paso intermedio (`stage`) registrado de una delegacion, o null. */
export const lastStageOf = (id) => readEntries(id).filter((e) => typeof e.stage === 'string').at(-1) ?? null;
