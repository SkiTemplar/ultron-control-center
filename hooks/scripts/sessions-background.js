#!/usr/bin/env node
// hooks/scripts/sessions-background.js — Stop hook.
//
// Un Bash o un Monitor lanzados con `run_in_background` cierran el turno en
// cuanto arrancan: la sesion de ULTRON Sessions queda `idle` (punto gris)
// aunque siga esperando a un proceso. La API de mods no expone esa lista; el
// hook Stop si (`background_tasks`, `session_crons`). Este hook la reenvia al
// puente de la sesion (`POST /v1/background`), que la guarda en
// `SessionInfo.backgroundTasks` y el punto pasa a «segundo plano».
//
// Cuando el proceso termina, la CLI despierta a la sesion, abre otro turno y
// al cerrarlo vuelve a pasar por aqui con la lista ya sin el: una lista vacia
// tambien se manda, porque es la que limpia el estado.
//
// LIMITE: si una tarea se mata desde /tasks sin que la CLI abra turno, el
// estado se queda hasta el siguiente Stop o hasta que la sesion se cierre o
// se reinicie (la app la limpia entonces).
//
// Solo actua en sesiones lanzadas por Sessions (ULTRON_PUENTE_URL,
// ULTRON_PUENTE_TOKEN y ULTRON_SESION_ID) y solo contra loopback.
// Opt-out: CLAUDE_NO_HOOKS=1 o SESSIONS_BACKGROUND_DISABLED=1.
//
// FAIL-SAFE: un fallo no puede tocar el turno (hook async, sin salida).

const { observe, logHookError } = require('./lib/hook-obs');

const ROUTE = '/v1/background';
const LOCAL_URL = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d{1,5})?(?:\/\S*)?$/i;
const MAX_ITEMS = 32;
const MAX_TEXT = 300;
const TIMEOUT_MS = 3000;

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{ url: string, token: string, sesionId: string } | null}
 */
function configFrom(env) {
  if (env.CLAUDE_NO_HOOKS === '1' || env.SESSIONS_BACKGROUND_DISABLED === '1') return null;
  const url = (env.ULTRON_PUENTE_URL || '').trim().replace(/\/+$/, '');
  const token = (env.ULTRON_PUENTE_TOKEN || '').trim();
  const sesionId = (env.ULTRON_SESION_ID || '').trim();
  if (!url || !token || !sesionId || !LOCAL_URL.test(url)) return null;
  return { url, token, sesionId };
}

const clip = (v) => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : undefined);

/** Lista recortada: solo los campos que lee `puente_fondo.rs`. */
function pick(list, fields) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((x) => x && typeof x === 'object')
    .slice(0, MAX_ITEMS)
    .map((x) => {
      const out = {};
      for (const f of fields) {
        const v = typeof x[f] === 'boolean' ? x[f] : clip(x[f]);
        if (v !== undefined) out[f] = v;
      }
      return out;
    });
}

/**
 * @param {any} input entrada del hook Stop
 * @param {string} sesionId
 */
function bodyFrom(input, sesionId) {
  return {
    sesionId,
    backgroundTasks: pick(input && input.background_tasks, ['id', 'type', 'status', 'description', 'command']),
    sessionCrons: pick(input && input.session_crons, ['id', 'schedule', 'recurring', 'prompt']),
  };
}

/** Una CLI sin `background_tasks` en el Stop no da informacion: no se manda nada. */
function hasPayload(input) {
  return Boolean(input) && (Array.isArray(input.background_tasks) || Array.isArray(input.session_crons));
}

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  const config = configFrom(process.env);
  if (config === null) return;
  const raw = await readStdin();
  const input = raw ? JSON.parse(raw) : null;
  if (!hasPayload(input)) return;
  const response = await fetch(`${config.url}${ROUTE}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyFrom(input, config.sesionId)),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`puente respondio ${response.status} en ${ROUTE}`);
}

if (require.main === module) {
  observe('sessions-background');
  main().catch((err) => logHookError('sessions-background', err));
}

module.exports = { configFrom, bodyFrom, hasPayload };
