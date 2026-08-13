// hooks/scripts/lib/ai-text-detector.js — matcher Node del detector de texto IA.
//
// MISMA fuente de verdad que el Lab del Control Center (tfg_lab.rs):
// `~/.ultron/docs/research/patrones-texto-ia.json`. Este módulo NO define
// patrones propios: ejecuta las `senales_ejecutables` (lexico/regex) que el
// catálogo declara, con la misma semántica de compilación que el Rust:
//   - "lexico" de UNA palabra  → \b<término>\b case-insensitive
//   - "lexico" multi-palabra   → contains case-insensitive
//   - "regex"                  → tal cual, ADAPTADA de sintaxis Rust a JS
//     (el catálogo escribe regex de Rust: el prefijo inline `(?i)` no existe
//     en JS y se traduce al flag 'i'; una regex intraducible se salta en
//     silencio, igual que el Rust degrada las que no compilan).
//
// Consumidor: ai-text-warn.js (hook PostToolUse) y cualquier skill que quiera
// analizar/reescribir bajo demanda.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CATALOG_PATH = path.join(
  os.homedir(), '.ultron', 'docs', 'research', 'patrones-texto-ia.json',
);

/** Cap defensivo de matches por escaneo: el aviso resume, no inventaría. */
const MAX_MATCHES = 50;
const EVIDENCE_CONTEXT = 30;

function loadCatalog(catalogPath) {
  const p = catalogPath || CATALOG_PATH;
  const raw = fs.readFileSync(p, 'utf8');
  const doc = JSON.parse(raw);
  const patrones = Array.isArray(doc && doc.patrones) ? doc.patrones : [];
  return patrones;
}

/** Traduce una regex del catálogo (sintaxis Rust) a RegExp de JS, o null. */
function toJsRegex(source) {
  let src = String(source || '');
  let flags = 'gu';
  // Rust escribe el modo case-insensitive como prefijo inline `(?i)`; JS no
  // lo soporta a nivel de patrón completo → se traduce al flag 'i'.
  if (src.startsWith('(?i)')) {
    src = src.slice(4);
    flags += 'i';
  }
  try {
    return new RegExp(src, flags);
  } catch {
    try {
      // Fallback sin flag unicode (algunos escapes de Rust chocan con 'u').
      return new RegExp(src, flags.replace('u', ''));
    } catch {
      return null; // intraducible: se degrada en silencio (mismo contrato que Rust)
    }
  }
}

function escapeForRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compila las senales_ejecutables del catálogo. Una vez por escaneo. */
function compileRules(patrones) {
  const rules = [];
  patrones.forEach((patron, idx) => {
    const senales = Array.isArray(patron && patron.senales_ejecutables)
      ? patron.senales_ejecutables
      : [];
    for (const senal of senales) {
      const tipo = (senal && senal.tipo) || '';
      const valor = (senal && senal.valor) || '';
      if (!valor) continue;
      let re = null;
      let label = '';
      if (tipo === 'lexico') {
        const esc = escapeForRegex(valor);
        const src = valor.trim().split(/\s+/).length === 1 ? `\\b${esc}\\b` : esc;
        re = toJsRegex(`(?i)${src}`);
        label = `lexico:${valor}`;
      } else if (tipo === 'regex') {
        re = toJsRegex(valor);
        const nota = (senal && senal.nota) || '';
        label = `regex:${nota || valor}`;
      } else {
        continue; // tipo desconocido: el catálogo solo define dos ejecutables
      }
      if (re) {
        rules.push({
          patternIdx: idx,
          pattern: (patron && patron.nombre) || `patron-${idx}`,
          correction: (patron && patron.correccion) || '',
          label,
          re,
        });
      }
    }
  });
  return rules;
}

/**
 * Escanea `text` contra el catálogo. Devuelve la misma forma que TfgReport:
 * { matches, patterns_hit, total_patterns_scanned, words, density_per_100w }.
 */
function scan(text, patrones) {
  const src = String(text || '');
  const cat = patrones || loadCatalog();
  const rules = compileRules(cat);
  const scannedPatterns = new Set(rules.map((r) => r.patternIdx));
  const hitPatterns = new Set();
  const matches = [];

  for (const rule of rules) {
    if (matches.length >= MAX_MATCHES) break;
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(src)) !== null) {
      if (m[0] === '') { rule.re.lastIndex++; continue; } // nunca bucle infinito
      hitPatterns.add(rule.patternIdx);
      const start = m.index;
      const end = m.index + m[0].length;
      matches.push({
        pattern: rule.pattern,
        rule: rule.label,
        evidence: src.slice(Math.max(0, start - EVIDENCE_CONTEXT), Math.min(src.length, end + EVIDENCE_CONTEXT)).trim(),
        start,
        end,
        correction: rule.correction,
      });
      if (matches.length >= MAX_MATCHES) break;
    }
  }

  const words = src.trim() ? src.trim().split(/\s+/).length : 0;
  return {
    matches,
    patterns_hit: hitPatterns.size,
    total_patterns_scanned: scannedPatterns.size,
    words,
    density_per_100w: words > 0 ? (matches.length * 100) / words : 0,
  };
}

module.exports = { loadCatalog, compileRules, scan, CATALOG_PATH };
