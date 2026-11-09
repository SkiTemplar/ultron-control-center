/**
 * availability.mjs - disponibilidad de un motor: la fuente unica de `status` y
 * del relevo de `run`.
 *
 * Orden de los motivos (el primero que aplica): disabled (no esta en `engines`,
 * `enabled: false`, runner desconocido o modelo fuera de la lista blanca
 * SAFE_MODEL, o `envMap` con un destino que no es `*_API_KEY`/`*_TOKEN`)
 * -> not-installed (el CLI no se puede lanzar sin shell desde el
 * PATH) -> missing-key (`keyEnv` vacio) -> quota (ventana >= 95 % o saldo
 * de DeepSeek no disponible).
 */

import { adapterFor } from './adapters.mjs';
import { SAFE_MODEL, engineConfig, isSafeModel, modelFor } from './config.mjs';
import { envMapProblem } from './env.mjs';
import { onPath } from './proc.mjs';
import { deepseekBalance, engineQuota, quotaBlockText, readKey, usesDeepseekBalance } from './quota.mjs';

/** El motor falso de los tests sustituye a todos los CLI: cuenta como instalado. */
const isInstalled = (adapter) => Boolean(process.env.ULTRON_DELEGATE_FAKE_ENGINE) || onPath(adapter.bin);

function unavailable(base, reason, detail) {
  return { ...base, available: false, reason, detail };
}

/**
 * Estado del motor `id`. `opts.tier` y `opts.model` eligen el modelo;
 * `opts.force` ignora la cuota.
 * @returns {Promise<{id,runner,model,enabled,installed,keyPresent,quota,balance,available,reason,detail,key}>}
 */
export async function engineStatus(config, id, opts = {}) {
  const e = engineConfig(config, id);
  const runner = e ? e.runner ?? null : null;
  const adapter = runner ? adapterFor(runner) : null;
  const model = e ? modelFor(config, id, opts.tier, opts.model) : null;
  const base = {
    id, runner, model, enabled: Boolean(e && e.enabled !== false && adapter),
    installed: adapter ? isInstalled(adapter) : false,
    keyPresent: e && e.keyEnv ? readKey(e.keyEnv) !== '' : null,
    quota: null, balance: null, available: true, reason: null, detail: null, key: '',
  };
  if (!e) return unavailable(base, 'disabled', `${id}: no esta en engines`);
  if (!adapter) return unavailable(base, 'disabled', `${id}: runner desconocido (${runner})`);
  if (e.enabled === false) return unavailable(base, 'disabled', `${id}: enabled false`);
  if (!isSafeModel(model)) return unavailable(base, 'disabled', `${id}: modelo no valido (${JSON.stringify(model)}; admitido ${SAFE_MODEL})`);
  const mapProblem = envMapProblem(e);
  if (mapProblem) return unavailable(base, 'disabled', `${id}: ${mapProblem}`);
  if (!base.installed) return unavailable(base, 'not-installed', `${id}: '${adapter.bin}' no esta en el PATH (o su shim .cmd no se reconoce)`);
  if (base.keyPresent === false) return unavailable(base, 'missing-key', `${id}: falta la variable ${e.keyEnv}`);
  base.key = e.keyEnv ? readKey(e.keyEnv) : '';
  return withQuota(base, opts);
}

async function withQuota(base, opts) {
  const quota = engineQuota(base.runner, base.model);
  const balance = usesDeepseekBalance(base.runner, base.model) ? await deepseekBalance(base.key) : null;
  const next = { ...base, quota: quota ? { usedPct: quota.usedPct, window: quota.window } : null, balance };
  if (opts.force) return next;
  const block = quotaBlockText(base.id, quota);
  if (block) return unavailable(next, 'quota', block);
  if (balance && balance.available === false) {
    return unavailable(next, 'quota', `${base.id}: saldo no disponible (${balance.total ?? '?'} ${balance.currency ?? ''})`.trim());
  }
  return next;
}

/** Ficha publica de `status --json` (contrato, seccion 3): sin `detail` ni `key`. */
export function publicStatus(s) {
  return {
    id: s.id,
    runner: s.runner,
    model: s.model,
    enabled: s.enabled,
    installed: s.installed,
    keyPresent: s.keyPresent,
    quota: s.quota,
    balance: s.balance,
    available: s.available,
    reason: s.reason,
  };
}
