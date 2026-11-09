/**
 * quota.mjs - cuota y saldo de los motores, y lectura de keys.
 *
 * - codex / agy: hooks/scripts/lib/engine-usage.js (sin lanzar agy: solo su
 *   cache de 30 min). Bloquea una ventana >= QUOTA_MAX_PCT.
 * - DeepSeek (modelo `deepseek/...`): GET https://api.deepseek.com/user/balance
 *   con cache de 10 min en .tmp; `is_available: false` bloquea con motivo quota.
 *   Sin dato (red caida, respuesta rara) no bloquea: lo dice la nota.
 * - Keys: process.env y, en Windows, la variable de usuario de HKCU\Environment
 *   (un `setx` no llega a los procesos ya abiertos).
 *
 * Seams de test: ULTRON_DELEGATE_USAGE (JSON en el formato de engine-usage.js
 * para codex y agy; null = sin dato), ULTRON_DELEGATE_BALANCE (JSON con la
 * respuesta de /user/balance; null = sin dato), ULTRON_DELEGATE_NO_REGISTRY=1
 * (no mira HKCU).
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ULTRON_HOME, cacheDir } from './config.mjs';

const require = createRequire(import.meta.url);
export const QUOTA_MAX_PCT = 95;
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
const BALANCE_TTL_MS = 10 * 60000;
const BALANCE_TIMEOUT_MS = 8000;
const WINDOW_NAMES = { five_hour: '5h', seven_day: 'weekly' };

function readEngineUsage(runner) {
  const fake = process.env.ULTRON_DELEGATE_USAGE;
  if (fake) return JSON.parse(readFileSync(fake, 'utf8'));
  const eu = require(join(ULTRON_HOME, 'hooks', 'scripts', 'lib', 'engine-usage.js'));
  return runner === 'codex' ? eu.readCodexUsage() : eu.readAgyUsage({ allowSpawn: false, maxCacheMs: 30 * 60000 });
}

/**
 * Cuota de un motor de suscripcion (codex/agy): `{ usedPct, window, kind }` de
 * la ventana mas gastada del grupo del modelo, o null sin dato.
 */
export function engineQuota(runner, model) {
  if (runner !== 'codex' && runner !== 'agy') return null;
  let e;
  try {
    e = readEngineUsage(runner);
  } catch {
    return null;
  }
  if (!e || e.status !== 'ok' || !Array.isArray(e.windows) || !e.windows.length) return null;
  const family = String(model).split('-')[0].toLowerCase();
  const own = e.windows.filter((w) => w.group && w.group.toLowerCase().includes(family));
  const scope = (own.length ? own : e.windows.filter((w) => w.group === e.windows[0].group)).filter((w) => w.usedPct !== null);
  if (!scope.length) return null;
  const top = scope.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
  return { usedPct: Math.round(top.usedPct), window: WINDOW_NAMES[top.kind] || top.kind, kind: top.kind };
}

/** Texto de bloqueo por cuota (formato historico del delegador), o null. */
export function quotaBlockText(engineId, quota) {
  if (!quota || quota.usedPct < QUOTA_MAX_PCT) return null;
  return `${engineId}: ventana ${quota.kind} al ${quota.usedPct} %`;
}

const registryCache = new Map();

/** Valor de una variable de usuario en HKCU\Environment ('' si no esta). */
function readUserRegistry(name) {
  if (process.platform !== 'win32' || process.env.ULTRON_DELEGATE_NO_REGISTRY === '1') return '';
  if (registryCache.has(name)) return registryCache.get(name);
  const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true });
  const m = r.status === 0 ? (r.stdout || '').match(new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.*)$`, 'm')) : null;
  const value = m ? m[1].trim() : '';
  registryCache.set(name, value);
  return value;
}

/** Key de un motor: process.env o la variable de usuario; '' si falta. */
export function readKey(name) {
  if (!name) return '';
  return String(process.env[name] || '').trim() || readUserRegistry(name);
}

/** Saldo normalizado `{ currency, total, available }` de la respuesta de /user/balance. */
export function normalizeBalance(body) {
  if (!body || typeof body !== 'object' || typeof body.is_available !== 'boolean') return null;
  const infos = Array.isArray(body.balance_infos) ? body.balance_infos : [];
  const info = infos.find((b) => b && b.currency === 'USD') || infos[0] || {};
  return { currency: info.currency || null, total: info.total_balance ?? null, available: body.is_available };
}

function readBalanceCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return Date.now() - c.fetchedAtMs < BALANCE_TTL_MS ? c.body : undefined;
  } catch {
    return undefined;
  }
}

function writeBalanceCache(file, body) {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify({ fetchedAtMs: Date.now(), body }));
    renameSync(`${file}.${process.pid}.tmp`, file);
  } catch {
    /* la cache es opcional */
  }
}

/** Saldo de DeepSeek o null sin dato. Solo se pregunta con la key presente. */
export async function deepseekBalance(key) {
  const fake = process.env.ULTRON_DELEGATE_BALANCE;
  if (fake) return normalizeBalance(JSON.parse(readFileSync(fake, 'utf8')));
  const file = join(cacheDir(), 'deepseek-balance.json');
  const cached = readBalanceCache(file);
  if (cached !== undefined) return normalizeBalance(cached);
  try {
    const res = await fetch(BALANCE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(BALANCE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json();
    writeBalanceCache(file, body);
    return normalizeBalance(body);
  } catch {
    return null;
  }
}

/** true si el motor paga por saldo de DeepSeek (modelo `deepseek/...`). */
export const usesDeepseekBalance = (runner, model) => runner === 'opencode' && /^deepseek\//.test(String(model));
