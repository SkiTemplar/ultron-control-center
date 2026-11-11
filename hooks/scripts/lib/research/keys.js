'use strict';

/**
 * lib/research/keys.js — completa el entorno con las claves de las fuentes
 * cuando el proceso no las hereda. Settings -> API Keys las guarda con setx,
 * y un setx no llega a los procesos ya abiertos: la sesion de Claude Code (y
 * el MCP que lanza) arrastra el entorno viejo. 2026-11-08: el MCP salia sin
 * OPENALEX_API_KEY ni SEMANTIC_SCHOLAR_API_KEY aunque estaban en el registro,
 * y agotaba el presupuesto diario sin clave de OpenAlex compartido por la IP.
 * Orden: entorno del proceso > ~/.ultron/.env > HKCU\Environment (mismo
 * criterio que lib/secondary-llm.js). Nunca imprime los valores.
 *
 * Seams de test: RESEARCH_NO_USER_ENV=1 no lee ni .env ni registro;
 * RESEARCH_ENV_FILE redirige el .env.
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KEY_VARS = ['OPENALEX_API_KEY', 'OPENALEX_MAILTO', 'SEMANTIC_SCHOLAR_API_KEY', 'UNPAYWALL_EMAIL'];

function envFileValues() {
  const file = process.env.RESEARCH_ENV_FILE || path.join(os.homedir(), '.ultron', '.env');
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out; // sin .env: solo entorno y registro
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Variable de usuario persistida en HKCU\Environment, o null si no existe. */
function registryValue(name) {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = new RegExp(`^\\s*${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+?)\\s*$`, 'm').exec(out);
    return m ? m[1] : null;
  } catch {
    return null; // variable ausente: reg sale con codigo 1
  }
}

/**
 * Rellena en process.env las claves que falten. Devuelve los nombres
 * recuperados y su origen (sin valores), para diagnostico.
 */
function hydrateResearchEnv() {
  if (process.env.RESEARCH_NO_USER_ENV === '1') return [];
  const missing = KEY_VARS.filter((name) => !process.env[name]?.trim());
  if (missing.length === 0) return [];
  const fileValues = envFileValues();
  const recovered = [];
  for (const name of missing) {
    const fromFile = fileValues[name]?.trim();
    const value = fromFile || registryValue(name)?.trim();
    if (!value) continue;
    process.env[name] = value;
    recovered.push({ name, source: fromFile ? '.env' : 'registro' });
  }
  return recovered;
}

module.exports = { hydrateResearchEnv, KEY_VARS };
