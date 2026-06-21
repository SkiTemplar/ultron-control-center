#!/usr/bin/env node
/**
 * Stop hook → recordatorio para actualizar kanban del proyecto activo.
 *
 * Detecta heurísticamente si en la última ronda el usuario pidió una tarea
 * completable (verbos de acción) Y el asistente la marcó como hecha. Si las
 * dos condiciones se cumplen, emite `hookSpecificOutput.additionalContext`
 * recordando actualizar `~/.ultron/cockpit/projects/<active>/kanban.json`
 * antes de cerrar sesión.
 *
 * Diseño:
 *   - Lee `transcript_path` de stdin (Stop hook payload de Claude Code).
 *   - Extrae los últimos 3 user messages "reales" (no system-reminder /
 *     command-name / tool_result) y la última assistant response (texto).
 *   - Heurística user: cualquier verbo de acción en imperativo/2ª persona.
 *   - Heurística assistant: marcador de finalización (completado, hecho,
 *     done, aplicado, listo, etc.) en español o inglés.
 *   - Proyecto activo: `~/.ultron/.tmp/current-session.json` →
 *     campo `active_project`; fallback a "ultron".
 *   - Timeout duro 5s. Errores y traza → `~/.claude/logs/kanban-reminder.jsonl`.
 *   - Nunca bloquea: process.exitCode siempre 0, sin output a stderr en hot path.
 *
 * Output al harness (cuando aplica):
 *   {
 *     "hookSpecificOutput": {
 *       "hookEventName": "Stop",
 *       "additionalContext": "RECORDATORIO: actualizar kanban en ..."
 *     }
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'kanban-reminder.jsonl');
const SESSION_STATE_PATH = path.join(HOME, '.ultron', '.tmp', 'current-session.json');
const KANBAN_BASE = path.join(HOME, '.ultron', 'cockpit', 'projects');
const DEFAULT_PROJECT = 'ultron';
const HARD_TIMEOUT_MS = 5000;
const MAX_USER_MESSAGES = 3;
const MAX_MESSAGE_CHARS = 1500;

// Verbos de acción que sugieren una tarea completable. Mezcla ES/EN, imperativo.
const ACTION_VERBS = [
  // Spanish (imperativo + infinitivo + 2ª persona presente)
  'implementa', 'implementar', 'implementas',
  'arregla', 'arreglar', 'arreglas',
  'añade', 'anade', 'añadir', 'anadir', 'añades', 'anades',
  'agrega', 'agregar', 'agregas',
  'crea', 'crear', 'creas',
  'actualiza', 'actualizar', 'actualizas',
  'borra', 'borrar', 'borras',
  'elimina', 'eliminar', 'eliminas',
  'corrige', 'corregir', 'corriges',
  'refactoriza', 'refactorizar', 'refactorizas',
  'configura', 'configurar', 'configuras',
  'instala', 'instalar', 'instalas',
  'integra', 'integrar', 'integras',
  'mejora', 'mejorar', 'mejoras',
  'reactiva', 'reactivar', 'reactivas',
  'deshabilita', 'deshabilitar', 'deshabilitas',
  'genera', 'generar', 'generas',
  'construye', 'construir', 'construyes',
  'commit', 'commitea', 'commitear',
  'pushea', 'pushear',
  'cambia', 'cambiar', 'cambias',
  'mueve', 'mover', 'mueves',
  'renombra', 'renombrar', 'renombras',
  'limpia', 'limpiar', 'limpias',
  'optimiza', 'optimizar', 'optimizas',
  // English
  'implement', 'implements',
  'fix', 'fixes',
  'add', 'adds',
  'create', 'creates',
  'update', 'updates',
  'delete', 'deletes',
  'remove', 'removes',
  'refactor', 'refactors',
  'configure', 'configures',
  'install', 'installs',
  'integrate', 'integrates',
  'enable', 'enables',
  'disable', 'disables',
  'build', 'builds',
  'rename', 'renames',
  'move', 'moves',
  'cleanup', 'clean',
];

// Marcadores de finalización que el asistente típicamente usa al cerrar.
const COMPLETION_MARKERS = [
  'completado', 'completada', 'completadas', 'completados',
  'aplicado', 'aplicada', 'aplicados', 'aplicadas',
  'hecho', 'hecha', 'hechos', 'hechas',
  'listo', 'lista', 'listos', 'listas',
  'terminado', 'terminada',
  'done', 'completed', 'finished', 'applied', 'finalized', 'shipped',
];

const { appendJsonl } = require('./lib/jsonl-log');
const { observe } = require('./lib/hook-obs');
observe('kanban-update-reminder');

function safeLog(entry) {
  // cat15.4: JSONL acotado (rota a 1 MiB) via helper compartido.
  appendJsonl(LOG_PATH, entry);
}

function readStdinSync() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function clamp(str, max) {
  const s = String(str == null ? '' : str);
  return s.length <= max ? s : s.slice(0, max - 3) + '...';
}

function extractContentString(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return '';
        if (typeof part === 'string') return part;
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'tool_result' && part.content) {
          return extractContentString(part.content);
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function looksSynthetic(text) {
  if (!text) return true;
  return (
    text.startsWith('<system-reminder>') ||
    text.startsWith('<command-name>') ||
    text.startsWith('[Request interrupted') ||
    text.startsWith('<local-command-stdout>')
  );
}

function parseTranscript(transcriptPath) {
  const userMessages = [];
  let lastAssistantText = '';

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { userMessages, lastAssistantText };
  }

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    safeLog({ level: 'warn', msg: 'transcript_read_failed', error: String(err && err.message) });
    return { userMessages, lastAssistantText };
  }

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }

    const message = entry.message || entry;
    const role = message && message.role;
    if (!role) continue;

    if (role === 'user' && message.content) {
      const text = extractContentString(message.content).trim();
      if (!looksSynthetic(text)) {
        userMessages.push(clamp(text, MAX_MESSAGE_CHARS));
      }
    }

    if (role === 'assistant' && message.content) {
      // Solo texto del asistente; ignoramos tool_use.
      let text = '';
      if (Array.isArray(message.content)) {
        text = message.content
          .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
          .map((p) => p.text)
          .join(' ');
      } else if (typeof message.content === 'string') {
        text = message.content;
      }
      text = text.trim();
      if (text) lastAssistantText = clamp(text, MAX_MESSAGE_CHARS * 2);
    }
  }

  return {
    userMessages: userMessages.slice(-MAX_USER_MESSAGES),
    lastAssistantText,
  };
}

function tokenize(text) {
  // Minúsculas + sin diacríticos para comparar contra listas planas.
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function userAskedActionable(userMessages) {
  if (!userMessages.length) return false;
  const verbSet = new Set(ACTION_VERBS.map((v) => v.toLowerCase()));
  for (const msg of userMessages) {
    const tokens = tokenize(msg);
    for (const t of tokens) {
      if (verbSet.has(t)) return true;
    }
  }
  return false;
}

function assistantMarkedDone(assistantText) {
  if (!assistantText) return false;
  const tokens = new Set(tokenize(assistantText));
  for (const marker of COMPLETION_MARKERS) {
    if (tokens.has(marker.toLowerCase())) return true;
  }
  return false;
}

function loadActiveProject() {
  try {
    if (!fs.existsSync(SESSION_STATE_PATH)) return DEFAULT_PROJECT;
    const raw = fs.readFileSync(SESSION_STATE_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    // Acepta variantes de capitalización (el state actual usa PascalCase).
    const candidate =
      cfg.active_project ||
      cfg.activeProject ||
      cfg.ActiveProject ||
      cfg.Active_Project ||
      '';
    const name = String(candidate || '').trim();
    return name || DEFAULT_PROJECT;
  } catch (err) {
    safeLog({ level: 'warn', msg: 'active_project_read_failed', error: String(err && err.message) });
    return DEFAULT_PROJECT;
  }
}

function buildReminder(project) {
  const kanbanPath = path.join(KANBAN_BASE, project, 'kanban.json');
  return (
    'RECORDATORIO: actualizar kanban en `' +
    kanbanPath +
    '` con esta tarea. NO cerrar sesion sin sincronizar.'
  );
}

function main() {
  const stdinRaw = readStdinSync();
  let payload = {};
  try {
    payload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (err) {
    safeLog({ level: 'warn', msg: 'stdin_parse_failed', error: String(err && err.message) });
  }

  const transcriptPath = payload.transcript_path || payload.transcriptPath || '';
  const extracted = parseTranscript(transcriptPath);

  const actionable = userAskedActionable(extracted.userMessages);
  const completed = assistantMarkedDone(extracted.lastAssistantText);

  if (!actionable || !completed) {
    safeLog({
      level: 'info',
      msg: 'no_reminder_emitted',
      reason: !actionable ? 'no_action_verb' : 'no_completion_marker',
      user_messages_seen: extracted.userMessages.length,
      session_id: payload.session_id || null,
    });
    return;
  }

  const project = loadActiveProject();
  const reminder = buildReminder(project);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: reminder,
    },
  };

  process.stdout.write(JSON.stringify(output));

  safeLog({
    level: 'info',
    msg: 'reminder_emitted',
    project,
    session_id: payload.session_id || null,
  });
}

// Watchdog: nunca pasar de HARD_TIMEOUT_MS aunque algo se enganche.
const watchdog = setTimeout(() => {
  safeLog({ level: 'warn', msg: 'watchdog_exit' });
  process.exit(0);
}, HARD_TIMEOUT_MS);
watchdog.unref();

try {
  main();
} catch (err) {
  safeLog({ level: 'error', msg: 'unhandled_exception', error: String(err && err.message) });
} finally {
  process.exitCode = 0;
}
