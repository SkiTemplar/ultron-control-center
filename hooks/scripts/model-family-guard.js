#!/usr/bin/env node
'use strict';

/**
 * model-family-guard.js — PreModelSwitch y PostModelSwitch (matcher "*").
 * Aplica la regla de modelos de ULTRON: solo la familia 5.5
 * (claude-opus-5-5, claude-sonnet-5-5 y claude-haiku-5-5, con o sin sufijo
 * [1m] o fecha).
 *
 * - PreModelSwitch: un cambio pedido con /model, el selector, /config o un
 *   set_model del SDK hacia cualquier otro modelo se DENIEGA
 *   (permissionDecision=deny) con un motivo que ve el usuario.
 * - PostModelSwitch: los cambios que Claude Code hace por su cuenta (fallback
 *   automatico, restaurar el modelo al reanudar) no pasan por PreModelSwitch y
 *   no se pueden bloquear. Si dejan la sesion fuera de la familia 5.5, avisa al
 *   usuario (systemMessage) y al modelo (additionalContext).
 *
 * SINCRONO a proposito: la decision y el aviso viajan por stdout y un hook
 * async los descartaria. Coste: un proceso node por cambio de modelo, que es
 * un evento raro. Requiere Claude Code >= 2.1.251.
 *
 * Fuera de alcance: el modelo de arranque (--model, settings) y el `model` de
 * un subagente; esos caminos los fijan los alias ANTHROPIC_DEFAULT_*_MODEL de
 * settings.json y el frontmatter de los agentes.
 *
 * Fail-open: entrada ilegible o sin to_model -> no decide (exit 0 sin salida).
 * Opt-out: ULTRON_MODEL_GUARD=0 (o CLAUDE_NO_HOOKS=1).
 */

const fs = require('fs');
const { observe, annotate, logHookError } = require('./lib/hook-obs');

const HOOK_ID = 'model-family-guard';
// Familia 5.5; el lookahead evita que "5-50" pase por "5-5".
const ALLOWED_MODEL_RE = /^claude-(?:opus|sonnet|haiku)-5-5(?![0-9])/i;
const FAMILY = 'claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5';

function isAllowedModel(model) {
  return ALLOWED_MODEL_RE.test(String(model || '').trim());
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function parsePayload(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function denyOutput(toModel) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreModelSwitch',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `ULTRON solo usa la familia 5.5 (${FAMILY}); cambio a ${toModel} denegado. ` +
        'Para saltarlo a proposito: ULTRON_MODEL_GUARD=0.',
    },
  };
}

function warnOutput(toModel, source) {
  const what = `La sesion ha pasado a ${toModel} (origen: ${source || 'desconocido'}), fuera de la familia 5.5 (${FAMILY}).`;
  return {
    systemMessage: `ULTRON model-guard: ${what} Vuelve con /model claude-opus-5-5.`,
    hookSpecificOutput: {
      hookEventName: 'PostModelSwitch',
      additionalContext: `${what} Avisa al usuario en tu siguiente respuesta; no cambies de modelo por tu cuenta.`,
    },
  };
}

/** Salida para una entrada de PreModelSwitch o PostModelSwitch; null = no decidir. Pura. */
function decide(payload, env = process.env) {
  if (env.ULTRON_MODEL_GUARD === '0' || !payload) return null;
  const event = payload.hook_event_name;
  if (event !== 'PreModelSwitch' && event !== 'PostModelSwitch') return null;
  const toModel = String(payload.to_model || '').trim();
  if (!toModel || isAllowedModel(toModel)) return null;
  return event === 'PreModelSwitch' ? denyOutput(toModel) : warnOutput(toModel, payload.source);
}

function main() {
  if (process.env.CLAUDE_NO_HOOKS === '1') return;
  observe(HOOK_ID);
  const out = decide(parsePayload(readStdinSync()));
  annotate({ decision: out ? (out.systemMessage ? 'warn' : 'deny') : 'pass' });
  if (out) process.stdout.write(JSON.stringify(out));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    try {
      logHookError(HOOK_ID, e);
    } catch {
      /* la observabilidad no rompe el hook */
    }
  }
  process.exitCode = 0;
} else {
  module.exports = { isAllowedModel, decide, ALLOWED_MODEL_RE };
}
