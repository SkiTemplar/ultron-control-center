#!/usr/bin/env node
// hooks/scripts/lib/token-meter.js — mide el coste en tokens que un hook INYECTA
// al Claude Code CLI via additionalContext.
//
// Pilar 1 del GOAL (ahorro de tokens): hasta ahora los hooks de memoria sumaban
// input al CLI cada prompt SIN medirlo (gasto a ciegas; el audit runtime 2026-06-22
// lo marco HIGH). Aqui se contabiliza cada bloque inyectado para poder afirmar/refutar
// ahorro NETO con datos, no con claims. El ai_router NO rutea el CLI (mandamiento 13),
// asi que este es el unico frente donde el coste del CLI es observable.
//
// Estimacion = chars/4 (heuristica estandar para prosa; no es el tokenizador real de
// Anthropic, se declara como `est_tokens`). Fail-safe: NUNCA rompe el hook.

'use strict';

const os = require('os');
const path = require('path');
const { appendJsonl } = require('./jsonl-log');

const TOKENS_LOG = path.join(os.homedir(), '.ultron', 'logs', 'hook-tokens.jsonl');

/** Estimacion de tokens desde nº de chars (chars/4, prosa). */
function estimateTokens(chars) {
  return Math.ceil((Number(chars) || 0) / 4);
}

/**
 * Registra el coste de la inyeccion de un hook en hook-tokens.jsonl.
 * @param {string} hook  nombre del hook (p.ej. 'memory-orchestrate')
 * @param {string} additionalContext  el bloque que el hook inyecta al CLI
 * @returns {{chars:number, est_tokens:number}}
 */
function meterInjection(hook, additionalContext) {
  const chars = typeof additionalContext === 'string' ? additionalContext.length : 0;
  const est_tokens = estimateTokens(chars);
  appendJsonl(TOKENS_LOG, { hook, chars, est_tokens });
  return { chars, est_tokens };
}

module.exports = { meterInjection, estimateTokens, TOKENS_LOG };
