/**
 * config.mjs - configuracion del delegador.
 *
 * Contrato: docs/delegacion-contrato.md, seccion 1. Dos ficheros:
 * - cockpit/ai-router/delegation.json: la del usuario (la edita la pestana AI
 *   Router; ignorada por git);
 * - cockpit/ai-router/delegation.default.json: el valor por defecto versionado
 *   (el mismo que incrusta el backend de Rust).
 * Si la del usuario falta, no parsea o no tiene la forma minima, se usa la
 * default y la salida lo dice (`source: 'default'` y `note`). Una default rota
 * es un error de uso: no hay otra copia en codigo que pueda divergir.
 *
 * Seams de test: ULTRON_DELEGATE_CONFIG (fichero del usuario),
 * ULTRON_DELEGATE_DEFAULT_CONFIG (fichero por defecto), ULTRON_DELEGATE_DIR
 * (base de las delegaciones), ULTRON_DELEGATE_LEDGER.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError } from './proc.mjs';

export const ULTRON_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const RUNNERS = Object.freeze(['codex', 'agy', 'opencode', 'claude']);
export const TIERS = Object.freeze(['complex', 'standard', 'trivial']);
export const DEFAULT_TIER = 'standard';

/**
 * Modelo admitido: lista blanca (sin comillas, espacios ni metacaracteres de
 * shell) y primer caracter alfanumerico, para que un modelo como `--share` o
 * `-c` no se lea como una opcion del CLI del motor.
 */
export const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
export const isSafeModel = (m) => typeof m === 'string' && SAFE_MODEL.test(m);

export const configPath = () => process.env.ULTRON_DELEGATE_CONFIG || join(ULTRON_HOME, 'cockpit', 'ai-router', 'delegation.json');
export const defaultConfigPath = () =>
  process.env.ULTRON_DELEGATE_DEFAULT_CONFIG || join(ULTRON_HOME, 'cockpit', 'ai-router', 'delegation.default.json');
export const delegationsDir = () => process.env.ULTRON_DELEGATE_DIR || join(ULTRON_HOME, '.tmp', 'delegations');
export const ledgerPath = () => process.env.ULTRON_DELEGATE_LEDGER || join(ULTRON_HOME, 'cockpit', 'delegations.jsonl');
export const cacheDir = () => join(ULTRON_HOME, '.tmp');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Motivo por el que la configuracion leida no sirve, o null si tiene la forma minima. */
function shapeProblem(cfg) {
  if (!isObject(cfg)) return 'no es un objeto JSON';
  if (!Array.isArray(cfg.chain) || !cfg.chain.every((id) => typeof id === 'string')) return '`chain` no es una lista de ids';
  if (!isObject(cfg.engines)) return '`engines` no es un objeto';
  if (cfg.tiers !== undefined && !isObject(cfg.tiers)) return '`tiers` no es un objeto';
  return null;
}

/**
 * Configuracion efectiva: `{ config, source: 'file'|'default', path, note }`.
 * `note` explica por que se uso el valor por defecto (null si vino del fichero).
 */
export function loadConfig() {
  const path = configPath();
  const user = readConfigFile(path);
  if (user.config) return { config: user.config, source: 'file', path, note: null };
  const defPath = defaultConfigPath();
  const def = readConfigFile(defPath);
  if (!def.config) throw new UsageError(`la configuracion por defecto no sirve: ${def.problem}`);
  return { config: def.config, source: 'default', path: defPath, note: user.problem };
}

/** `{ config }` si el fichero existe y tiene la forma minima, o `{ problem }`. */
function readConfigFile(path) {
  if (!existsSync(path)) return { problem: `no existe ${path}` };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { problem: `${path} no parsea (${e.message})` };
  }
  const problem = shapeProblem(parsed);
  return problem ? { problem: `${path}: ${problem}` } : { config: parsed };
}

/** Ficha de un motor, o null si no esta en `engines`. */
export function engineConfig(config, id) {
  const e = config.engines[id];
  return isObject(e) ? e : null;
}

/** Modelo efectivo: --model > tierModels[tier] > model. */
export function modelFor(config, id, tier, override) {
  if (override) return override;
  const e = engineConfig(config, id) || {};
  const byTier = isObject(e.tierModels) ? e.tierModels[tier] : undefined;
  return byTier || e.model || null;
}

/** Ids de motores: los de `chain` en orden y despues los de `engines` que no estan en la cadena. */
export function allEngineIds(config) {
  const extra = Object.keys(config.engines).filter((id) => !config.chain.includes(id));
  return [...new Set([...config.chain, ...extra])];
}

/**
 * Orden de intento. `engine` distinto de 'auto' fuerza un solo motor; con
 * 'auto' se recorre `chain` desde `tiers[tier].start` dando la vuelta (sin
 * `tiers[tier]`, desde `chain[0]`). Un `start` que no esta en `chain` es un
 * error de uso: antes arrancaba en `chain[0]` (el motor caro) sin avisar.
 */
export function engineOrder(config, { engine = 'auto', tier = DEFAULT_TIER } = {}) {
  if (!TIERS.includes(tier)) throw new UsageError(`--tier debe ser ${TIERS.join('|')}`);
  if (engine !== 'auto') {
    if (!engineConfig(config, engine)) {
      throw new UsageError(`--engine ${engine}: no esta en la configuracion (motores: ${allEngineIds(config).join(', ')}, o auto)`);
    }
    return [engine];
  }
  const chain = [...new Set(config.chain)];
  if (!chain.length) throw new UsageError('la cadena de motores (`chain`) esta vacia');
  const start = isObject(config.tiers) && isObject(config.tiers[tier]) ? config.tiers[tier].start : null;
  if (start != null && !chain.includes(start)) {
    throw new UsageError(`tiers.${tier}.start = ${JSON.stringify(start)} no esta en chain (${chain.join(', ')})`);
  }
  const at = Math.max(0, chain.indexOf(start));
  return [...chain.slice(at), ...chain.slice(0, at)];
}
