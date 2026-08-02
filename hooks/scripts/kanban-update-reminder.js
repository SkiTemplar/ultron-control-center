#!/usr/bin/env node
/**
 * Stop hook → cierre real de kanban del proyecto activo (NO solo recordatorio).
 *
 * Detecta heurísticamente si en la última ronda el usuario pidió una tarea
 * completable (verbos de acción) Y el asistente la marcó como hecha. Si las
 * dos condiciones se cumplen, ACTÚA sobre `kanban.json` (mandamiento 11: un
 * hook que solo imprime texto es un no-op de cierre) en dos niveles, en orden:
 *
 *   1) closeCompletedCards(): cierra (column_id -> role=done) cards VIVAS
 *      (doing/todo) cuyo título matchea fuerte con el asunto de un commit
 *      reciente (evidencia dura: trabajo hecho Y registrado en git). Nunca
 *      cierra por ambigüedad — cerrar la card equivocada es peor que no
 *      cerrar (ver comentario de `closeCompletedCards`).
 *   2) autoLogCompletedTask(): SOLO si (1) no cerró nada, registra la tarea
 *      recién completada como una card NUEVA ya en Done (título derivado del
 *      último mensaje de usuario). Es la contraparte segura de (1): nunca
 *      toca una card existente (cero riesgo de mis-cierre), es idempotente
 *      (id estable por sesión+texto, no duplica en Stops repetidos de la
 *      misma sesión) y deduplica contra cards ya parecidas en el board.
 *      Así el kanban queda actualizado incluso cuando no hay commit/card
 *      previa que matchee — la alternativa (no escribir nada) es el no-op
 *      que este hook existe para eliminar.
 *
 * Si ninguna de las dos acciones aplica, cae al recordatorio de texto
 * original (comportamiento previo, conservador ante ambigüedad real).
 *
 * Diseño:
 *   - Lee `transcript_path` de stdin (Stop hook payload de Claude Code).
 *   - Extrae los últimos 3 user messages "reales" (no system-reminder /
 *     command-name / tool_result) y la última assistant response (texto).
 *   - Heurística user: cualquier verbo de acción en imperativo/2ª persona.
 *   - Heurística assistant: marcador de finalización (completado, hecho,
 *     done, aplicado, listo, etc.) en español o inglés.
 *   - Proyecto: 1) `current-session.json` -> `active_project` (seleccion
 *     explicita); 2) derivado del `cwd` de la sesion; 3) fallback "ultron".
 *   - Timeout duro 5s. Errores y traza → `~/.claude/logs/kanban-reminder.jsonl`.
 *   - Nunca bloquea: process.exitCode siempre 0, sin output a stderr en hot path.
 *
 * Output al harness (cuando aplica):
 *   {
 *     "hookSpecificOutput": {
 *       "hookEventName": "Stop",
 *       "additionalContext": "BOARD ACTUALIZADO: ..." | "RECORDATORIO: ..."
 *     }
 *   }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
const ULTRON_ROOT = path.join(HOME, '.ultron');
// Umbral de cierre automatico (Jaccard de tokens sobre el asunto de commit YA
// SIN su prefijo conventional-commit). Antes era 0.7 contra el asunto crudo:
// estructuralmente inalcanzable (titulos de card largos vs asuntos cortos
// "fix(scope): ..."), asi que el cierre era un no-op de facto (cat21.1). Ahora
// 0.5 sobre el asunto LIMPIO + dos senales de ALTA PRECISION adicionales
// (cat-code/issue compartido, substring) -> dispara con precision, no por azar.
// La evidencia sigue siendo el commit (trabajo hecho Y registrado).
const CLOSE_THRESHOLD = 0.5;
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'kanban-reminder.jsonl');
// Overrides SOLO para selftest hermetico (nunca se setean en produccion): sin
// ellos el selftest tendria que leer/escribir el kanban.json y el
// current-session.json REALES del usuario, arriesgando falsos positivos (una
// seleccion de proyecto real interfiriendo) y dejando cards sinteticas en
// produccion (mismo patron que SUBAGENT_LIFECYCLE_LOG en otros hooks).
const SESSION_STATE_PATH =
  process.env.KANBAN_REMINDER_SESSION_STATE_OVERRIDE ||
  path.join(HOME, '.ultron', '.tmp', 'current-session.json');
const KANBAN_BASE =
  process.env.KANBAN_REMINDER_BASE_OVERRIDE || path.join(HOME, '.ultron', 'cockpit', 'projects');
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
const { observe, logHookError } = require('./lib/hook-obs');
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

function loadActiveProject(opts) {
  const allowDefault = !opts || opts.allowDefault !== false;
  const fallback = allowDefault ? DEFAULT_PROJECT : '';
  try {
    if (!fs.existsSync(SESSION_STATE_PATH)) return fallback;
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
    return name || fallback;
  } catch (err) {
    safeLog({ level: 'warn', msg: 'active_project_read_failed', error: String(err && err.message) });
    return fallback;
  }
}

// Deriva el proyecto del cwd de la sesion (misma convencion que el resto del
// sistema: basename del cwd sin puntos iniciales -> '.ultron' => 'ultron').
function projectFromCwd(cwd) {
  if (!cwd) return '';
  try {
    return path.basename(String(cwd)).replace(/^\.+/, '').trim();
  } catch (_) {
    return '';
  }
}

// Resuelve el tablero al que apunta el recordatorio, en orden de fiabilidad:
//   1) seleccion explicita de tablero (current-session.json -> active_project)
//   2) proyecto derivado del cwd de ESTA sesion (no asume 'ultron')
//   3) ultimo recurso: DEFAULT_PROJECT
// Antes caia SIEMPRE a 'ultron' cuando (1) no estaba poblado, mandando al
// tablero equivocado en cualquier sesion de otro proyecto.
function resolveProject(payload) {
  const explicit = loadActiveProject({ allowDefault: false });
  if (explicit) return explicit;
  const fromCwd = projectFromCwd(payload && payload.cwd);
  if (fromCwd) return fromCwd;
  return DEFAULT_PROJECT;
}

// Asuntos de commits recientes del repo en `root` (evidencia dura de trabajo
// hecho-y-registrado). Best-effort: [] ante cualquier fallo. Nunca lanza.
function recentCommitSubjects(root) {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'log', '--since=18 hours ago', '--format=%s', '-n', '40'],
      { encoding: 'utf8', timeout: 4000 },
    );
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_) {
    return [];
  }
}

// Jaccard de tokens (reusa tokenize: minusculas + sin diacriticos).
function jaccardTokens(a, b) {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Quita el prefijo conventional-commit ("feat(scope): ", "fix!: ") para que las
// palabras reales del asunto dominen el solape de tokens (el prefijo es ruido).
function cleanSubject(subject) {
  return String(subject || '').replace(/^\s*[a-z]+(\([^)]*\))?!?:\s*/i, '');
}

// Claves de ALTA PRECISION: cat-codes (cat21, cat21.4) e issue-refs (#123). Un
// commit "(cat21.4)" cierra SOLO una card que comparte exactamente esa clave en
// su titulo/tags -> cat21.4 != cat21 (especificidad evita cierres gruesos).
function extractKeys(text) {
  const keys = new Set();
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/\bcat\d+(?:\.\d+)?\b/g)) keys.add(m[0]);
  for (const m of s.matchAll(/#\d+\b/g)) keys.add(m[0]);
  return keys;
}

function sharesKey(a, b) {
  for (const k of a) if (b.has(k)) return true;
  return false;
}

// Stopwords ES/EN para el camino de COBERTURA multi-commit (ver
// multiCommitCoverageMatch). Solo particulas gramaticales sin señal
// (articulos, preposiciones cortas, pronombres) — nunca palabras de dominio.
const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'y', 'en', 'a', 'al', 'un', 'una',
  'con', 'por', 'para', 'que', 'se', 'su', 'sus', 'lo', 'le', 'via',
  'the', 'an', 'of', 'to', 'and', 'for', 'on', 'with', 'is', 'are',
]);

function significantTokenSet(text) {
  return new Set(tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

// Umbral de COBERTURA (containment) para el camino multi-commit (cat-code
// 2026-08-02): que fraccion de los tokens SIGNIFICATIVOS del titulo de la
// card aparece en la UNION de tokens de TODOS los commits recientes, en vez
// de exigir que UN commit solo cruce el Jaccard 0.5 de arriba. 0.6 (no 0.5)
// porque containment no divide por el tamaño de la union (que crece con cada
// commit añadido) y por tanto satura mas facil por azar que Jaccard -> se
// compensa con un umbral mas alto. Piso absoluto de 3 tokens MATCHEADOS
// (ademas del ratio) para que titulos cortos no cierren por 1-2 coincidencias
// sueltas, y piso de 3 tokens significativos en el propio titulo para que
// este camino ni se intente en cards de titulo trivial. Calibrado contra:
// (a) el caso real que lo motivo — "Deuda: trocear career.ts y events.ts" no
// cerraba nunca porque career.ts y events.ts se trocearon en DOS commits
// separados, ninguno cruzando el 0.5 de Jaccard por si solo — y (b) un
// dry-run de solo-lectura contra los kanban.json de TODOS los proyectos de
// cockpit/projects/ con el git log real de cada repo, para descartar falsos
// positivos antes de fijar el umbral (ver informe del debugger agent,
// 2026-08-02).
const MULTI_COMMIT_COVERAGE_THRESHOLD = 0.6;
const MULTI_COMMIT_MIN_CARD_TOKENS = 3;
const MULTI_COMMIT_MIN_MATCHED = 3;

function multiCommitCoverageMatch(cardTitle, subjects) {
  const cardTokens = significantTokenSet(cardTitle);
  if (cardTokens.size < MULTI_COMMIT_MIN_CARD_TOKENS) return false;
  const unionTokens = new Set();
  for (const s of subjects) {
    for (const t of significantTokenSet(cleanSubject(s))) unionTokens.add(t);
  }
  if (!unionTokens.size) return false;
  let matched = 0;
  for (const t of cardTokens) if (unionTokens.has(t)) matched++;
  if (matched < MULTI_COMMIT_MIN_MATCHED) return false;
  return matched / cardTokens.size >= MULTI_COMMIT_COVERAGE_THRESHOLD;
}

// (2026-07-13) Claves de FASE ("Fase 4", "fase 4.2", "phase 3"). A diferencia
// de los cat-codes, una fase acumula commits INTERMEDIOS durante dias, asi que
// compartir la clave NO basta para cerrar: el asunto debe ademas DECLARAR el
// cierre (CLOSURE_MARKER_RE). Caso real que motivo esto (sesion Tortunabo
// 2026-07-13): la card "Fase 4 — Hardening + tests (...)" quedo viva tras el
// commit "docs: Fase 4.2 hecha - Fase 4 completa" porque ni keys ni substring
// ni Jaccard matcheaban -> el resume sirvio un next_action stale 2 dias.
// Especificidad como en cat-codes: fase4.2 != fase4 (cerrar "Fase 4.3" no
// cierra la card "Fase 4").
function extractPhaseKeys(text) {
  const keys = new Set();
  const s = String(text || '').toLowerCase();
  for (const m of s.matchAll(/\b(?:fase|phase)\s*(\d+(?:\.\d+)?)\b/g)) keys.add('fase' + m[1]);
  return keys;
}

// Marcadores de cierre en el ASUNTO del commit, con \b para no matchear dentro
// de otra palabra ("autocompletado" NO es "completado").
const CLOSURE_MARKER_RE =
  /\b(completa(?:da|do)?|cerra(?:da|do)|hecha|hecho|finaliza(?:da|do)|termina(?:da|do)|done|closed)\b/i;

// Carga kanban.json de `project`. Devuelve null si no existe / no parsea
// (nunca lanza — mismo contrato defensivo que el resto del hook).
function loadKanbanDoc(project) {
  const kanbanPath = path.join(KANBAN_BASE, project, 'kanban.json');
  if (!fs.existsSync(kanbanPath)) return null;
  try {
    return { kanbanPath, doc: JSON.parse(fs.readFileSync(kanbanPath, 'utf8')) };
  } catch (_) {
    return null;
  }
}

// Escritura inmutable: nunca muta `doc` in-place, siempre construye el nuevo
// documento antes de persistir. Trailing '\n' para igualar a
// scripts/kanban.mjs saveBoard (evita diffs de formato espurios cuando ambos
// escritores tocan el mismo fichero).
function saveKanbanDoc(kanbanPath, doc) {
  fs.writeFileSync(kanbanPath, JSON.stringify(doc, null, 2) + '\n');
}

// Cierra (mueve a la columna role=done) las cards VIVAS (doing/todo) cuyo titulo
// matchea FUERTE (>=CLOSE_THRESHOLD) el asunto de un commit reciente. Escritura
// inmutable de kanban.json. Devuelve los titulos cerrados ([] si ninguno o sin
// kanban). Conservador: ante duda NO cierra (el recordatorio cubre el resto).
function closeCompletedCards(project, root) {
  const loaded = loadKanbanDoc(project);
  if (!loaded) return [];
  const { kanbanPath, doc } = loaded;
  const cols = Array.isArray(doc.columns) ? doc.columns : [];
  const doneCol = cols.find((c) => c.role === 'done');
  if (!doneCol) return [];
  const liveColIds = new Set(
    cols.filter((c) => c.role === 'doing' || c.role === 'todo').map((c) => c.id),
  );
  const subjects = recentCommitSubjects(root);
  if (!subjects.length) return [];

  const closed = [];
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  const newCards = cards.map((card) => {
    if (!liveColIds.has(card.column_id)) return card;
    const bare = String(card.title || '').replace(/^\[[^\]]*\]\s*/, '');
    if (bare.length < 8) return card; // titulos triviales no se auto-cierran
    const bareLc = bare.toLowerCase();
    const cardKeys = extractKeys(
      card.title + ' ' + (Array.isArray(card.tags) ? card.tags.join(' ') : ''),
    );
    const cardPhases = extractPhaseKeys(
      card.title + ' ' + (Array.isArray(card.tags) ? card.tags.join(' ') : ''),
    );
    const hit = subjects.some((s) => {
      // 1) ALTA PRECISION: cat-code / issue-ref compartido (commit "(cat21.4)"
      //    cierra la card cat21.4). La senal mas fuerte: trabajo etiquetado.
      if (cardKeys.size && sharesKey(extractKeys(s), cardKeys)) return true;
      // 1.5) FASE compartida + commit que DECLARA cierre ("Fase 4 completa").
      //      Un commit intermedio de la fase (sin marcador) NO cierra nada.
      if (
        cardPhases.size
        && sharesKey(extractPhaseKeys(s), cardPhases)
        && CLOSURE_MARKER_RE.test(s)
      ) return true;
      const cleaned = cleanSubject(s);
      // 2) substring: el titulo pelado aparece literal en el asunto limpio.
      if (bareLc.length >= 12 && cleaned.toLowerCase().includes(bareLc)) return true;
      // 3) fuzzy: Jaccard sobre el asunto SIN prefijo conventional-commit.
      return jaccardTokens(bare, cleaned) >= CLOSE_THRESHOLD;
    })
      // 4) COBERTURA MULTI-COMMIT (aditivo): el trabajo de una card puede
      //    repartirse en VARIOS commits que cubren cada uno solo una parte del
      //    titulo (ninguno cruza el Jaccard 0.5 de (3) por si solo) -> ver
      //    multiCommitCoverageMatch. No sustituye a (1)-(3), solo se evalua
      //    si ninguno de esos matcheo.
      || multiCommitCoverageMatch(bare, subjects);
    if (!hit) return card;
    closed.push(String(card.title || ''));
    return { ...card, column_id: doneCol.id };
  });

  if (closed.length) {
    try {
      saveKanbanDoc(kanbanPath, { ...doc, cards: newCards });
    } catch (err) {
      safeLog({ level: 'warn', msg: 'kanban_write_failed', error: String(err && err.message) });
      return [];
    }
  }
  return closed;
}

// Contraparte SEGURA de closeCompletedCards(): cuando NINGUNA card viva
// matcheo (asi que (1) no cerro nada), esto NO es licencia para quedarse en
// no-op — mandamiento 11 exige actuar o explicar por que no se puede. Como no
// hay card existente inequivoca a la que atribuir el cierre (cerrar la
// equivocada es peor que no cerrar), la accion segura es registrar la tarea
// YA HECHA como una card NUEVA directamente en Done. Nunca toca una card
// existente -> cero riesgo de mis-cierre.
//
// Salvaguardas contra ruido en el board real (esto escribe sobre
// cockpit/projects/<proyecto>/kanban.json de produccion, no un fixture):
//   - id ESTABLE = sha1(session_id + texto normalizado): reintentos/Stops
//     repetidos de la MISMA sesion sobre la MISMA peticion son idempotentes
//     (no duplican la card).
//   - dedupe: si ya existe cualquier card (viva o done) con titulo parecido
//     (>=CLOSE_THRESHOLD o cat-code/issue compartido), no se crea otra.
//   - titulos triviales (<8 chars tras limpiar) no generan card (ruido puro).
// Devuelve el titulo de la card creada, o null si no se creo ninguna.
function autoLogCompletedTask(project, extracted, payload) {
  const loaded = loadKanbanDoc(project);
  if (!loaded) return null;
  const { kanbanPath, doc } = loaded;
  const cols = Array.isArray(doc.columns) ? doc.columns : [];
  const doneCol = cols.find((c) => c.role === 'done');
  if (!doneCol) return null;

  const lastUser = extracted.userMessages[extracted.userMessages.length - 1] || '';
  const bareTitle = clamp(String(lastUser).trim(), 120);
  if (bareTitle.length < 8) return null;

  const sessionKey = String((payload && payload.session_id) || '');
  const sig = crypto
    .createHash('sha1')
    .update(sessionKey + '|' + bareTitle.toLowerCase())
    .digest('hex')
    .slice(0, 12);
  const autoId = `auto-${sig}`;

  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  if (cards.some((c) => c.id === autoId)) return null; // ya registrada (idempotente)

  const titleKeys = extractKeys(bareTitle);
  const isDuplicate = cards.some((c) => {
    const existingTitle = String(c.title || '');
    if (titleKeys.size && sharesKey(extractKeys(existingTitle), titleKeys)) return true;
    return jaccardTokens(bareTitle, existingTitle) >= CLOSE_THRESHOLD;
  });
  if (isDuplicate) return null;

  const ts = new Date().toISOString();
  const card = {
    id: autoId,
    column_id: doneCol.id,
    title: `[auto] ${bareTitle}`,
    description:
      'Auto-registrada por el Stop hook kanban-update-reminder: el asistente marco la tarea como hecha en la conversacion y ninguna card viva ni commit reciente matcheaba, asi que se registra como nueva card ya cerrada (evita el no-op de cierre, mandamiento 11).',
    agent: null,
    prompt_template: null,
    cwd: null,
    tags: ['auto-log'],
    order: cards.filter((c) => c.column_id === doneCol.id).length,
    created_at: ts,
    updated_at: ts,
    runs: [],
  };

  try {
    saveKanbanDoc(kanbanPath, { ...doc, cards: cards.concat([card]) });
  } catch (err) {
    safeLog({ level: 'warn', msg: 'kanban_autolog_write_failed', error: String(err && err.message) });
    return null;
  }
  return card.title;
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

  const project = resolveProject(payload);
  const root = (payload && payload.cwd) || ULTRON_ROOT;

  // Mandamiento 11: no solo recordar — ACTUAR. Cierra cards cumplidas (match
  // fuerte con commit reciente) antes de emitir el recordatorio para el resto.
  const closed = closeCompletedCards(project, root);

  // Si (1) no cerro nada, intenta (2) el fallback seguro: registrar la tarea
  // como card nueva ya en Done (nunca toca una card existente). Solo se
  // intenta cuando (1) no aplico, para no duplicar evidencia de la misma
  // tarea en dos sitios.
  const autoLoggedTitle = closed.length ? null : autoLogCompletedTask(project, extracted, payload);

  let context = buildReminder(project);
  if (closed.length) {
    context =
      'BOARD ACTUALIZADO: ' +
      closed.length +
      ' card(s) cerradas por match con commit reciente -> ' +
      closed.map((t) => '"' + clamp(t, 60) + '"').join(', ') +
      '. ' +
      context;
  } else if (autoLoggedTitle) {
    context =
      'BOARD ACTUALIZADO: tarea completada sin card previa que matcheara -> registrada y cerrada en Done: "' +
      clamp(autoLoggedTitle, 80) +
      '".';
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(output));

  safeLog({
    level: 'info',
    msg: closed.length ? 'cards_closed_and_reminder' : autoLoggedTitle ? 'card_auto_logged' : 'reminder_emitted',
    project,
    closed,
    auto_logged: autoLoggedTitle,
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
  logHookError('kanban-update-reminder', err);
} finally {
  process.exitCode = 0;
}
