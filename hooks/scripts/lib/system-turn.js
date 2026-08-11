#!/usr/bin/env node
/**
 * system-turn.js — deteccion de turnos de SISTEMA compartida por los hooks.
 *
 * Por que existe (bug 2026-08-12): las notificaciones de tareas background de
 * Claude Code atraviesan el pipeline de hooks como si fueran prompts humanos —
 * el orquestador ruteo el XML de una notificacion a route=game inyectando
 * skills sin sentido, y el Stop hook del kanban registro una card titulada con
 * el XML crudo. Este modulo corta ese ruido en origen: los hooks hacen
 * early-exit cuando el "prompt" del turno es en realidad un mensaje de sistema.
 *
 * Conservador POR DISENO: ante duda devuelve false. Un falso positivo
 * silenciaria los hooks para un prompt humano real — eso es peor que dejar
 * pasar el ruido. Solo matchean los shapes exactos conocidos (case-sensitive,
 * tal cual llegan del harness). Sin dependencias externas.
 *
 * Exporta: isSystemTurnPrompt.
 */

'use strict';

// Ventana donde debe aparecer <task-notification> para contar como turno de
// sistema: las notificaciones reales llevan el tag al principio; un prompt
// humano largo que lo mencione mas adelante NO debe matchear.
const TASK_NOTIFICATION_WINDOW_CHARS = 500;

// Shapes exactos (case-sensitive) de los turnos de sistema del harness.
const SYSTEM_NOTIFICATION_PREFIX = '[SYSTEM NOTIFICATION - NOT USER INPUT]';
const SYSTEM_REMINDER_PREFIX = '<system-reminder>';
const TASK_NOTIFICATION_TAG = '<task-notification>';

/**
 * True si `text` es el prompt de un turno de SISTEMA (notificacion de tarea
 * background, o turno que es SOLO un system-reminder), tras strip de BOM y
 * trim. Cualquier otro caso (incluido input no-string o vacio) => false.
 *
 * @param {unknown} text  Prompt tal cual llega en el payload del hook.
 * @returns {boolean}
 */
function isSystemTurnPrompt(text) {
  if (typeof text !== 'string') return false;
  const t = text.replace(/^﻿/, '').trim();
  if (!t) return false;
  if (t.startsWith(SYSTEM_NOTIFICATION_PREFIX)) return true;
  if (t.startsWith(SYSTEM_REMINDER_PREFIX)) return true;
  if (t.slice(0, TASK_NOTIFICATION_WINDOW_CHARS).includes(TASK_NOTIFICATION_TAG)) return true;
  return false;
}

module.exports = { isSystemTurnPrompt };
