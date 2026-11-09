'use strict';
/**
 * lib/motor-shell-tools.js — herramientas del motor que ejecutan shell, derivadas
 * de sus tipos (auditoria 2026-11-01). Lo usan los selftests de paridad de
 * deny-secrets y guardrails-pre: hasta entonces solo contrastaban las herramientas
 * que ya estaban en la lista, asi que una nueva (`Monitor`) quedaba fuera sin que
 * nada lo avisara.
 *
 * Los tipos los genera la CLI en `mods/<mod>/.claude-plugin/types/` y no estan
 * versionados. Sin ellos (CI sin CLI, instalacion limpia) quedan los minimos de
 * SHELL_MINIMAS. PowerShell no aparece en los tipos: su disponibilidad depende de
 * la plataforma, y por eso va en los minimos.
 */

const fs = require('fs');
const path = require('path');

const SHELL_MINIMAS = Object.freeze(['Bash', 'PowerShell', 'Monitor']);
const RAIZ_MODS = path.join(__dirname, '..', '..', '..', 'mods');
const RUTA_TIPOS = ['.claude-plugin', 'types', 'claude-code-tools', 'index.d.ts'];

/**
 * Herramientas de un `index.d.ts` cuya entrada tiene una propiedad `command`
 * dentro de `interface BuiltinToolInputs`.
 *
 * @param {string} dts
 * @returns {string[]}
 */
function herramientasShell(dts) {
  const out = [];
  let dentro = false;
  let actual = null;
  for (const linea of String(dts || '').split(/\r?\n/)) {
    if (!dentro) {
      dentro = /^\s*interface BuiltinToolInputs\s*\{/.test(linea);
      continue;
    }
    if (/^ {2}\}/.test(linea)) break;
    const herramienta = linea.match(/^ {4}(\w+): \{/);
    if (herramienta) actual = herramienta[1];
    else if (actual && /^ {6}command\??:/.test(linea)) out.push(actual);
  }
  return out;
}

/** Texto de los tipos del motor del primer mod que los tenga, o ''. */
function leerTiposDelMotor(raiz = RAIZ_MODS) {
  let mods;
  try {
    mods = fs.readdirSync(raiz);
  } catch (_) {
    return '';
  }
  for (const mod of mods) {
    try {
      return fs.readFileSync(path.join(raiz, mod, ...RUTA_TIPOS), 'utf8');
    } catch (_) {
      /* este mod no tiene tipos generados: se prueba el siguiente */
    }
  }
  return '';
}

/** Minimos mas lo que digan los tipos del motor, sin repetir. */
function herramientasShellDelMotor(raiz = RAIZ_MODS) {
  return [...new Set([...SHELL_MINIMAS, ...herramientasShell(leerTiposDelMotor(raiz))])];
}

module.exports = { SHELL_MINIMAS, herramientasShell, herramientasShellDelMotor };
