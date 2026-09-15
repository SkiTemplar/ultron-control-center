#!/usr/bin/env node
/**
 * security-helpers.js — helpers de seguridad compartidos por los hooks.
 *
 * Extraidos de mem0-sync.js (borrado 2026-06-08) porque stop-compress-session.js
 * los requeria y el require roto degradaba los helpers a stubs permanentemente
 * (hallazgo Kirkardo Pass1 2026-06-10, C5). Sin dependencias externas.
 *
 * Exporta: redactSecrets, loadOptOut, isOptedOut, detectProjectName, setLogger.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

// Logger inyectable: por defecto silencioso (los hooks no deben ensuciar
// stdout/stderr); el consumidor puede inyectar su safeLog para no perder
// avisos como "regex de opt-out invalida".
let logFn = () => {};
function setLogger(fn) {
  if (typeof fn === 'function') logFn = fn;
}

// ---------------------------------------------------------------------------
// Redaccion de secretos — espejo (ampliado con IBAN/JWT/Luhn) de los patrones
// de scripts/cockpit/secrets_scanner.py.
// ---------------------------------------------------------------------------

function luhnValid(digits) {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const SECRET_PATTERNS = [
  // Bloques PEM primero (multi-linea, antes que los single-line).
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI (incl. sk-proj-/sk-ant-) y sk- genericas
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // GitHub PAT / OAuth / refresh / server
  /m0-[A-Za-z0-9_-]{20,}/g, // Mem0 (legacy)
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /xox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AIza[0-9A-Za-z_-]{30,}/g, // Google API key
  /(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /whsec_[A-Za-z0-9]{16,}/g, // Stripe webhook secret
  /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, // SendGrid
  /(?:SK|AC)[0-9a-fA-F]{32}/g, // Twilio
  /dop_v1_[a-f0-9]{64}/g, // DigitalOcean
  /(?:secret_[A-Za-z0-9]{40,}|ntn_[A-Za-z0-9]{20,})/g, // Notion
  /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g, // IBAN
];

function redactSecrets(input) {
  let s = String(input == null ? '' : input);
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, '[REDACTED]');
  }
  // Cadenas tipo tarjeta: solo si pasan Luhn (evita comerse timestamps/ids).
  s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
    const digits = m.replace(/[ -]/g, '');
    return luhnValid(digits) ? '[REDACTED]' : m;
  });
  return s;
}

// ---------------------------------------------------------------------------
// Opt-out por proyecto — proyectos financieros NUNCA salen a un LLM cloud,
// aunque el usuario no haya creado el fichero de config.
// ---------------------------------------------------------------------------

const OPT_OUT_PATH = path.join(HOME, '.ultron', '.mem0-opt-out.json');
const DEFAULT_OPT_OUT_PROJECTS = ['bank', 'finanzas', 'finance'];
const DEFAULT_OPT_OUT_CWD_PATTERNS = [
  '[\\\\/](bank|finanzas|finance|tax|payroll|salary|nomina|hacienda)[\\\\/-]',
];

function loadOptOut() {
  let projects = DEFAULT_OPT_OUT_PROJECTS.slice();
  let cwdPatterns = DEFAULT_OPT_OUT_CWD_PATTERNS.slice();
  try {
    const cfg = JSON.parse(fs.readFileSync(OPT_OUT_PATH, 'utf8'));
    if (Array.isArray(cfg.projects)) {
      projects = projects.concat(cfg.projects.map((p) => String(p)));
    }
    if (Array.isArray(cfg.cwd_patterns)) {
      // concat (no overwrite): los patrones del usuario SUMAN a los defaults.
      cwdPatterns = cwdPatterns.concat(cfg.cwd_patterns.map((p) => String(p)));
    }
  } catch (_) {
    // Sin fichero (o malformado) — los defaults siguen aplicando.
  }
  return {
    projects: projects.map((p) => p.toLowerCase()),
    cwd_patterns: cwdPatterns,
  };
}

function isOptedOut(project, cwd, optOut) {
  const proj = String(project || '').toLowerCase();
  if (optOut.projects.includes(proj)) return true;
  const c = String(cwd || '');
  for (const pat of optOut.cwd_patterns) {
    try {
      if (new RegExp(pat, 'i').test(c)) return true;
    } catch (err) {
      // No crashear el hook por una regex mala del usuario, pero SI avisar —
      // un skip silencioso daria falsa sensacion de opt-out.
      logFn({ level: 'warn', msg: 'invalid_cwd_pattern', pattern: pat, error: String(err && err.message) });
    }
  }
  return false;
}

function detectProjectName(cwd) {
  if (!cwd) return 'unknown';
  return path.basename(cwd);
}

module.exports = {
  redactSecrets,
  loadOptOut,
  isOptedOut,
  detectProjectName,
  setLogger,
};
