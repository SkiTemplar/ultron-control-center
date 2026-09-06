#!/usr/bin/env node
/**
 * ULTRON HOOK · guardrails-post · v1.0
 *
 * PostToolUse (Write|Edit). Avisa —nunca bloquea— cuando el texto recien
 * escrito rompe una norma que solo se puede juzgar sobre el contenido:
 *
 *   tono-fuera-del-chat : registro coloquial o deformacion grafica en un
 *                         artefacto que puede leer un tercero. CLAUDE.md lo
 *                         prohibe expresamente: los tonos visten la
 *                         conversacion con el usuario y nada mas.
 *   conteos-en-skill    : numeros concretos de skills/agentes dentro de la
 *                         skill ULTRON. Envejecen mal y ya hubo que retirarlos;
 *                         los sirve el Control Center leyendo disco.
 *
 * POR QUE AVISA Y NO BLOQUEA: las dos son heuristicas sobre prosa. Un bloqueo
 * con falso positivo frena trabajo legitimo sin apelacion; un aviso deja la
 * decision al modelo con la norma delante, que es justo lo que faltaba.
 *
 * SINCRONO A PROPOSITO: un hook `async` corre fire-and-forget y su stdout se
 * descarta, asi que el aviso no llegaria nunca (misma razon que ai-text-warn).
 *
 * Fail-safe total: cualquier error -> exit 0 sin salida. Jamas rompe un Write.
 */

'use strict';

const path = require('path');

const { detectForPrompt } = require('./lib/tone-detect.js');

// Solo cuando corre como hook (ver guardrails-pre).
if (require.main === module) {
  try {
    require('./lib/hook-obs.js').observe('guardrails-post');
  } catch (_) { /* la observabilidad jamas rompe un hook */ }
}

/** Rutas donde el registro coloquial o los conteos son legitimos. */
const RUTAS_EXCLUIDAS = [
  '/.claude/projects/',        // memoria del asistente
  '/docs/research/',           // catalogos que citan señales a proposito
  '/scratchpad/',
  '/node_modules/',
  '/.tmp/',
  '/personality.json',         // el catalogo de tonos ES la lista de señales
  '/hooks/scripts/lib/',       // tone-detect y su corpus de prueba
  '/benchmarks/',              // corpus de prompts reales del usuario
];

/**
 * CLAUDE.md (global y de la skill) documentan los tonos con ejemplos escritos
 * en ese mismo registro. Analizarlos daria un aviso en cada edicion.
 */
const BASENAMES_EXCLUIDOS = new Set(['claude.md', 'agents.md', 'gemini.md', 'personality.json']);

/** La skill ULTRON prohibe conteos concretos en su propio texto. */
const RAIZ_SKILL_ULTRON = '/.claude/skills/ultron/';
const RE_CONTEO = /\b\d{2,4}\s+(skills?|agentes?|agents?|personas?)\b/gi;

function leerStdin() {
  const fs = require('fs');
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

/** Solo el texto NUEVO: el aviso debe apuntar a lo que se acaba de escribir. */
function textoNuevo(toolName, input) {
  if (!input) return '';
  if (toolName === 'Write') return String(input.content || '');
  if (toolName === 'Edit') return String(input.new_string || '');
  return '';
}

function normalizaRuta(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

function excluida(rutaNorm) {
  if (!rutaNorm) return true;
  if (RUTAS_EXCLUIDAS.some((r) => rutaNorm.includes(r))) return true;
  return BASENAMES_EXCLUIDOS.has(path.basename(rutaNorm));
}

/**
 * @param {string} ruta
 * @param {string} texto
 * @returns {string[]} avisos, vacio si el texto esta limpio
 */
function analiza(ruta, texto) {
  const avisos = [];
  const rutaNorm = normalizaRuta(ruta);
  if (excluida(rutaNorm) || !texto.trim()) return avisos;

  const tono = detectForPrompt(texto);
  if (tono && tono.id && tono.id !== 'ultron') {
    avisos.push(
      `tono "${tono.id}" detectado en ${path.basename(rutaNorm)} (${tono.reason || 'señales del texto'}). ` +
      'Los tonos visten SOLO la conversacion con el usuario: en codigo, docs, commits, ' +
      'PRs y cualquier artefacto que lea un tercero va el registro tecnico con ortografia completa.',
    );
  }

  if (rutaNorm.includes(RAIZ_SKILL_ULTRON)) {
    const conteos = texto.match(RE_CONTEO);
    if (conteos && conteos.length) {
      avisos.push(
        `conteo concreto en la skill ULTRON: ${[...new Set(conteos)].slice(0, 3).join(', ')}. ` +
        'Esos numeros envejecen mal y ya hubo que retirarlos; los sirven las pestañas ' +
        'Skills/Agents del Control Center leyendo disco.',
      );
    }
  }

  return avisos;
}

function main() {
  let data;
  try {
    data = JSON.parse(String(leerStdin() || '').replace(/^﻿/, ''));
  } catch (_) {
    return;
  }
  if (!data || data.hook_event_name !== 'PostToolUse') return;

  const toolName = data.tool_name || '';
  if (toolName !== 'Write' && toolName !== 'Edit') return;

  const input = data.tool_input || {};
  const avisos = analiza(input.file_path || '', textoNuevo(toolName, input));
  if (!avisos.length) return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          '[ULTRON guardrails] ' + avisos.join(' | ') +
          ' — corrigelo en el fichero antes de seguir.',
      },
    }) + '\n',
  );
}

module.exports = { analiza, textoNuevo, excluida };

if (require.main === module) {
  try {
    main();
  } catch (exc) {
    process.stderr.write(`guardrails-post: ${exc}\n`);
  }
  process.exit(0);
}
