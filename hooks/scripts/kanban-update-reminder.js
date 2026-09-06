#!/usr/bin/env node
/**
 * Stop hook → cierre real de kanban del proyecto activo, sin ruido.
 *
 * v3.0 (ULTRON 4 F4.4, 2026-09-04). El hook solo actua cuando el turno que
 * termina tiene EVIDENCIA DE TRABAJO:
 *   - un tool_use Edit / Write / MultiEdit / NotebookEdit sobre un fichero
 *     dentro del cwd de la sesion, o
 *   - un `git commit` lanzado con Bash.
 *
 * Con esa evidencia hace, en este orden:
 *   1. closeCompletedCards(): mueve a role=done las cards VIVAS (doing/todo)
 *      cuyo titulo matchea fuerte el asunto de un commit reciente (trabajo
 *      hecho Y registrado en git). Nunca cierra por ambiguedad. Si cierra
 *      algo lo anuncia como "BOARD ACTUALIZADO" (sin cooldown).
 *   2. Si no cerro nada pero el tablero tiene tarjetas In Progress
 *      (role=doing), emite UN recordatorio que las nombra (titulo + id) con
 *      el comando exacto para cerrarlas; cooldown por sesion
 *      (KANBAN_REMINDER_COOLDOWN_MIN, 30 min por defecto).
 *   3. Sin tarjeta In Progress: silencio.
 *
 * Sin evidencia de trabajo en el turno: silencio absoluto, diga lo que diga
 * el asistente. Las heuristicas v1/v2 (verbo de accion del usuario + marcador
 * de "hecho" del asistente) se retiraron: median 47 recordatorios en 29
 * sesiones con 0 cierres reales, y en proyectos personales acababan en cards
 * `kanban.mjs add` que nadie habia pedido (audit 2026-09-04).
 *
 * Tablero: 1) `current-session.json` -> `active_project`; 2) el id que
 * `cockpit/projects.json` registra para el cwd; 3) basename del cwd SOLO si
 * ese tablero existe. Sin tablero resoluble no se cae a "ultron": un cwd sin
 * registro no debe recibir avisos del tablero de otro proyecto.
 *
 * Timeout duro 5 s. Errores y traza -> `~/.claude/logs/kanban-reminder.jsonl`.
 * Nunca bloquea: exitCode 0 siempre, sin stderr en el hot path.
 *
 * Output al harness (solo cuando aplica):
 *   { "hookSpecificOutput": { "hookEventName": "Stop",
 *       "additionalContext": "BOARD ACTUALIZADO: ..." | "KANBAN <proyecto>: ..." } }
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const HOME = os.homedir();
// Umbral de cierre automatico (Jaccard de tokens sobre el asunto de commit YA
// SIN su prefijo conventional-commit). Antes era 0.7 contra el asunto crudo:
// estructuralmente inalcanzable (titulos de card largos vs asuntos cortos
// "fix(scope): ..."), asi que el cierre era un no-op de facto (cat21.1). Ahora
// 0.5 sobre el asunto LIMPIO + dos senales de ALTA PRECISION adicionales
// (cat-code/issue compartido, substring) -> dispara con precision, no por azar.
const CLOSE_THRESHOLD = 0.5;
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'kanban-reminder.jsonl');
// Overrides SOLO para selftest hermetico (nunca se setean en produccion): sin
// ellos el selftest tendria que leer/escribir el kanban.json y el
// current-session.json REALES del usuario.
const SESSION_STATE_PATH =
  process.env.KANBAN_REMINDER_SESSION_STATE_OVERRIDE ||
  path.join(HOME, '.ultron', '.tmp', 'current-session.json');
const KANBAN_BASE =
  process.env.KANBAN_REMINDER_BASE_OVERRIDE || path.join(HOME, '.ultron', 'cockpit', 'projects');
const PROJECTS_REGISTRY_PATH =
  process.env.KANBAN_REMINDER_PROJECTS_OVERRIDE ||
  path.join(HOME, '.ultron', 'cockpit', 'projects.json');
const HARD_TIMEOUT_MS = 5000;
// Cola del transcript que se inspecciona (2 MiB): el turno que termina esta
// al final; un turno mas largo que esto se trata entero como "el turno".
const TRANSCRIPT_TAIL_BYTES = 2 * 1024 * 1024;
// Herramientas cuyo uso sobre un fichero del proyecto es evidencia de trabajo.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// `git commit` en un comando Bash (no dentro de un pipe/`&&` posterior que lo
// mencione de paso: basta con que el comando lleve `git ... commit`).
const GIT_COMMIT_RE = /\bgit\b[^\n|;&]*\bcommit\b/;
const COOLDOWN_MIN = (() => {
  const raw = process.env.KANBAN_REMINDER_COOLDOWN_MIN;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();
const MAX_CARDS_IN_REMINDER = 3;
const MAX_TITLE_CHARS = 70;

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

// Compara rutas de forma tolerante: separadores unificados, sin barra final y
// sin distinguir mayusculas (Windows).
const BARRA_WINDOWS = String.fromCharCode(92);
const BARRA_URL = '/';

function normalizePath(p) {
  if (!p) return '';
  try {
    const unificada = path.resolve(String(p)).split(BARRA_WINDOWS).join(BARRA_URL);
    return unificada.replace(/[/]+$/, '').toLowerCase();
  } catch (_) {
    return '';
  }
}

function isUnder(filePath, rootPath) {
  const f = normalizePath(filePath);
  const r = normalizePath(rootPath);
  if (!f || !r) return false;
  return f === r || f.startsWith(r + BARRA_URL);
}

function readTranscriptTail(transcriptPath) {
  let fd = null;
  try {
    const size = fs.statSync(transcriptPath).size;
    const start = Math.max(0, size - TRANSCRIPT_TAIL_BYTES);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fd = fs.openSync(transcriptPath, 'r');
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      // Se descarta la primera linea, casi seguro partida.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } catch (err) {
    safeLog({ level: 'warn', msg: 'transcript_read_failed', error: String(err && err.message) });
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* nada */ }
    }
  }
}

// Frontera de turno: cualquier entrada `user` que no sea un tool_result, sea
// humana o de sistema (task-notification, system-reminder de un hook). Un
// turno de sistema tambien tiene su propio Stop: si el trabajo del turno
// humano anterior se contara otra vez, el mismo commit cerraria (o volveria a
// cerrar) cards en cada Stop hasta salir de la ventana de 18 h (visto el
// 2026-09-06 con la tarjeta del corte por valor).
function isPromptEntry(message) {
  if (!message || message.role !== 'user' || !message.content) return false;
  return !(
    Array.isArray(message.content)
    && message.content.some((p) => p && p.type === 'tool_result')
  );
}

// Evidencia de trabajo del turno que termina: tool_use de edicion sobre un
// fichero del cwd, o `git commit` por Bash, contados SOLO despues del ultimo
// prompt (humano o de sistema). Devuelve { edits, commits, entries }.
function parseTurnWork(transcriptPath, cwd) {
  const result = { edits: 0, commits: 0, entries: 0 };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return result;

  const entries = [];
  for (const line of readTranscriptTail(transcriptPath).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch (_) {
      // linea partida o basura: se ignora
    }
  }
  result.entries = entries.length;

  let lastPrompt = -1;
  for (let i = 0; i < entries.length; i++) {
    const message = entries[i].message || entries[i];
    if (isPromptEntry(message)) lastPrompt = i;
  }

  for (let i = lastPrompt + 1; i < entries.length; i++) {
    const message = entries[i].message || entries[i];
    if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || part.type !== 'tool_use' || !part.name) continue;
      const input = part.input || {};
      if (EDIT_TOOLS.has(part.name)) {
        const file = input.file_path || input.notebook_path || '';
        if (!file || !cwd || isUnder(file, cwd)) result.edits++;
      } else if (part.name === 'Bash' && typeof input.command === 'string') {
        if (GIT_COMMIT_RE.test(input.command)) result.commits++;
      }
    }
  }
  return result;
}

function tokenize(text) {
  // Minusculas + sin diacriticos para comparar contra listas planas.
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function loadActiveProject() {
  try {
    if (!fs.existsSync(SESSION_STATE_PATH)) return '';
    const raw = fs.readFileSync(SESSION_STATE_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    // Acepta variantes de capitalizacion (el state actual usa PascalCase).
    const candidate =
      cfg.active_project ||
      cfg.activeProject ||
      cfg.ActiveProject ||
      cfg.Active_Project ||
      '';
    return String(candidate || '').trim();
  } catch (err) {
    safeLog({ level: 'warn', msg: 'active_project_read_failed', error: String(err && err.message) });
    return '';
  }
}

// Id que el Control Center tiene registrado para este directorio. Es la unica
// fuente que sabe que `.../LaundryClubFolder/laundry-club-next` es el proyecto
// "laundry-club".
function projectFromRegistry(cwd) {
  const objetivo = normalizePath(cwd);
  if (!objetivo) return '';
  try {
    if (!fs.existsSync(PROJECTS_REGISTRY_PATH)) return '';
    const raw = JSON.parse(fs.readFileSync(PROJECTS_REGISTRY_PATH, 'utf8'));
    const proyectos = Array.isArray(raw) ? raw : (raw && raw.projects) || [];
    for (const proyecto of proyectos) {
      if (proyecto && proyecto.id && normalizePath(proyecto.path) === objetivo) {
        return String(proyecto.id).trim();
      }
    }
  } catch (err) {
    safeLog({ level: 'warn', msg: 'projects_registry_read_failed', error: String(err && err.message) });
  }
  return '';
}

// Basename del cwd sin puntos iniciales ('.ultron' => 'ultron').
function projectFromCwd(cwd) {
  if (!cwd) return '';
  try {
    return path.basename(String(cwd)).replace(/^\.+/, '').trim();
  } catch (_) {
    return '';
  }
}

function kanbanPathFor(project) {
  return path.join(KANBAN_BASE, project, 'kanban.json');
}

// Resuelve el tablero, en orden de fiabilidad: seleccion explicita, registro
// del cockpit para el cwd, basename del cwd (solo si el tablero existe).
// Devuelve { project, source } o null: sin tablero resoluble no se avisa.
function resolveProject(payload) {
  const explicit = loadActiveProject();
  if (explicit) return { project: explicit, source: 'explicit' };
  const cwd = payload && payload.cwd;
  const fromRegistry = projectFromRegistry(cwd);
  if (fromRegistry) return { project: fromRegistry, source: 'registry' };
  const fromCwd = projectFromCwd(cwd);
  if (fromCwd && fs.existsSync(kanbanPathFor(fromCwd))) return { project: fromCwd, source: 'cwd' };
  return null;
}

// Commits recientes del repo en `root` (evidencia dura de trabajo
// hecho-y-registrado) como { ts (epoch s), subject }. Best-effort: [] ante
// cualquier fallo. Nunca lanza.
function recentCommits(root) {
  try {
    const out = execFileSync(
      'git',
      ['-C', root, 'log', '--since=18 hours ago', '--format=%ct%x09%s', '-n', '40'],
      { encoding: 'utf8', timeout: 4000 },
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        if (tab < 0) return { ts: 0, subject: line };
        return { ts: Number(line.slice(0, tab)) || 0, subject: line.slice(tab + 1).trim() };
      })
      .filter((c) => c.subject);
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
// multiCommitCoverageMatch). Solo particulas gramaticales sin señal.
const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'de', 'del', 'y', 'en', 'a', 'al', 'un', 'una',
  'con', 'por', 'para', 'que', 'se', 'su', 'sus', 'lo', 'le', 'via',
  'the', 'an', 'of', 'to', 'and', 'for', 'on', 'with', 'is', 'are',
]);

function significantTokenSet(text) {
  return new Set(tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t)));
}

// Umbral de COBERTURA (containment) para el camino multi-commit (cat-code
// 2026-08-02): fraccion de los tokens SIGNIFICATIVOS del titulo de la card
// que aparece en la UNION de tokens de TODOS los commits recientes. 0.6 (no
// 0.5) porque containment satura mas facil por azar que Jaccard. Piso de 3
// tokens MATCHEADOS y de 3 tokens significativos en el titulo. Calibrado
// contra el caso real "Deuda: trocear career.ts y events.ts" (dos commits) y
// un dry-run sobre los kanban.json de todos los proyectos (2026-08-02).
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

// (2026-07-13) Claves de FASE ("Fase 4", "fase 4.2", "phase 3"). Una fase
// acumula commits INTERMEDIOS durante dias, asi que compartir la clave NO
// basta para cerrar: el asunto debe ademas DECLARAR el cierre
// (CLOSURE_MARKER_RE). Especificidad como en cat-codes: fase4.2 != fase4.
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
  const kanbanPath = kanbanPathFor(project);
  if (!fs.existsSync(kanbanPath)) return null;
  try {
    return { kanbanPath, doc: JSON.parse(fs.readFileSync(kanbanPath, 'utf8')) };
  } catch (_) {
    return null;
  }
}

// Escritura inmutable: nunca muta `doc` in-place. Trailing '\n' para igualar
// a scripts/kanban.mjs saveBoard (evita diffs de formato espurios).
function saveKanbanDoc(kanbanPath, doc) {
  fs.writeFileSync(kanbanPath, JSON.stringify(doc, null, 2) + '\n');
}

// Memoria de cierres automaticos, al lado del kanban.json
// (cockpit/projects/<id>/kanban.auto-close.json): { [cardId]: { at, by } }
// con `at` en epoch segundos y `by` el asunto del commit. Vive FUERA de la
// card porque el Control Center reescribe las cards con un struct cerrado
// (kanban/types_model.rs) y perderia cualquier campo extra.
function autoClosePathFor(kanbanPath) {
  return path.join(path.dirname(kanbanPath), 'kanban.auto-close.json');
}

function readAutoClosed(autoClosePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(autoClosePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

// Escribe la memoria quedandose solo con las cards que siguen en el tablero.
function saveAutoClosed(autoClosePath, map, cards) {
  const ids = new Set(cards.map((c) => c.id));
  const pruned = Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)));
  try {
    fs.writeFileSync(autoClosePath, JSON.stringify(pruned, null, 2) + '\n');
  } catch (err) {
    safeLog({ level: 'warn', msg: 'auto_close_write_failed', error: String(err && err.message) });
  }
}

function liveColumnIds(cols) {
  return new Set(cols.filter((c) => c.role === 'doing' || c.role === 'todo').map((c) => c.id));
}

// Cierra (mueve a la columna role=done) las cards VIVAS (doing/todo) cuyo titulo
// matchea FUERTE (>=CLOSE_THRESHOLD) el asunto de un commit reciente. Escritura
// inmutable de kanban.json. Devuelve los titulos cerrados ([] si ninguno o sin
// kanban). Conservador: ante duda NO cierra.
function closeCompletedCards(loaded, root) {
  if (!loaded) return [];
  const { kanbanPath, doc } = loaded;
  const cols = Array.isArray(doc.columns) ? doc.columns : [];
  const doneCol = cols.find((c) => c.role === 'done');
  if (!doneCol) return [];
  const liveColIds = liveColumnIds(cols);
  const commits = recentCommits(root);
  if (!commits.length) return [];
  const nowEpoch = Math.floor(Date.now() / 1000);
  const autoClosePath = autoClosePathFor(kanbanPath);
  const autoClosed = readAutoClosed(autoClosePath);
  const autoClosedNext = {};

  const closed = [];
  const cards = Array.isArray(doc.cards) ? doc.cards : [];
  const newCards = cards.map((card) => {
    if (!liveColIds.has(card.column_id)) return card;
    const bare = String(card.title || '').replace(/^\[[^\]]*\]\s*/, '');
    if (bare.length < 8) return card; // titulos triviales no se auto-cierran
    // Idempotencia: una card que este hook ya cerro y alguien REABRIO solo
    // puede volver a cerrarse por un commit POSTERIOR a aquel cierre. Sin
    // esto, el mismo commit la volvia a cerrar en cada Stop durante 18 h.
    const closedAt = Number((autoClosed[card.id] || {}).at) || 0;
    const candidates = closedAt ? commits.filter((c) => c.ts > closedAt) : commits;
    if (!candidates.length) return card;
    const subjects = candidates.map((c) => c.subject);
    const bareLc = bare.toLowerCase();
    const tagText = Array.isArray(card.tags) ? card.tags.join(' ') : '';
    const cardKeys = extractKeys(card.title + ' ' + tagText);
    const cardPhases = extractPhaseKeys(card.title + ' ' + tagText);
    const single = subjects.find((s) => {
      // 1) ALTA PRECISION: cat-code / issue-ref compartido.
      if (cardKeys.size && sharesKey(extractKeys(s), cardKeys)) return true;
      // 1.5) FASE compartida + commit que DECLARA cierre ("Fase 4 completa").
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
    });
    // 4) COBERTURA MULTI-COMMIT (aditivo): varios commits que cubren cada uno
    //    una parte del titulo. Solo si ninguno de (1)-(3) matcheo.
    const hit = single !== undefined || multiCommitCoverageMatch(bare, subjects);
    if (!hit) return card;
    closed.push(String(card.title || ''));
    autoClosedNext[card.id] = { at: nowEpoch, by: single !== undefined ? single : subjects[0] };
    return { ...card, column_id: doneCol.id };
  });

  if (closed.length) {
    try {
      saveKanbanDoc(kanbanPath, { ...doc, cards: newCards });
      saveAutoClosed(autoClosePath, { ...autoClosed, ...autoClosedNext }, newCards);
    } catch (err) {
      safeLog({ level: 'warn', msg: 'kanban_write_failed', error: String(err && err.message) });
      return [];
    }
  }
  return closed;
}

// Tarjetas en columnas role=doing (In Progress), tras el cierre.
function doingCards(project) {
  const loaded = loadKanbanDoc(project);
  if (!loaded) return [];
  const cols = Array.isArray(loaded.doc.columns) ? loaded.doc.columns : [];
  const doingIds = new Set(cols.filter((c) => c.role === 'doing').map((c) => c.id));
  const cards = Array.isArray(loaded.doc.cards) ? loaded.doc.cards : [];
  return cards.filter((c) => doingIds.has(c.column_id));
}

function cooldownMarkerPath(sessionId) {
  return path.join(os.tmpdir(), `ultron-kanban-reminder-${String(sessionId).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

// true si el recordatorio de texto ya se emitio hace menos de COOLDOWN_MIN en
// esta sesion. Sin session_id o con cooldown 0 nunca frena.
function inCooldown(sessionId) {
  if (!sessionId || COOLDOWN_MIN <= 0) return false;
  try {
    const marker = cooldownMarkerPath(sessionId);
    if (!fs.existsSync(marker)) return false;
    const last = JSON.parse(fs.readFileSync(marker, 'utf8')).last_reminder_ts;
    const elapsedMs = Date.now() - Date.parse(last || 0);
    return Number.isFinite(elapsedMs) && elapsedMs < COOLDOWN_MIN * 60 * 1000;
  } catch (_) {
    return false;
  }
}

function markReminder(sessionId) {
  if (!sessionId || COOLDOWN_MIN <= 0) return;
  try {
    fs.writeFileSync(cooldownMarkerPath(sessionId), JSON.stringify({ last_reminder_ts: new Date().toISOString() }));
  } catch (_) {
    // best-effort: sin marcador solo se pierde el cooldown
  }
}

function buildReminder(project, cards) {
  const shown = cards.slice(0, MAX_CARDS_IN_REMINDER)
    .map((c) => `"${clamp(c.title, MAX_TITLE_CHARS)}" (${c.id})`)
    .join(', ');
  const extra = cards.length > MAX_CARDS_IN_REMINDER ? ` y ${cards.length - MAX_CARDS_IN_REMINDER} mas` : '';
  const first = cards[0];
  return (
    `KANBAN ${project}: In Progress -> ${shown}${extra}. ` +
    `Si este turno la cierra: node ~/.ultron/scripts/kanban.mjs mv ${project} "${first.id}" done. ` +
    'Si la avanza, actualiza su descripcion. Si no aplica, ignora.'
  );
}

function emit(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Stop', additionalContext: context },
  }));
}

function main() {
  const stdinRaw = readStdinSync();
  let payload = {};
  try {
    payload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (err) {
    safeLog({ level: 'warn', msg: 'stdin_parse_failed', error: String(err && err.message) });
  }
  const sessionId = payload.session_id || null;
  const cwd = (payload && payload.cwd) || '';

  const transcriptPath = payload.transcript_path || payload.transcriptPath || '';
  const work = parseTurnWork(transcriptPath, cwd);
  if (work.edits === 0 && work.commits === 0) {
    safeLog({ level: 'info', msg: 'silent', reason: 'no_work_in_turn', entries: work.entries, session_id: sessionId });
    return;
  }

  const resolved = resolveProject(payload);
  if (!resolved) {
    safeLog({ level: 'info', msg: 'silent', reason: 'no_project', cwd: cwd || null, session_id: sessionId });
    return;
  }
  const { project, source } = resolved;

  // ACTUAR solo con evidencia dura: cierra las cards cuyo titulo matchea un
  // commit reciente del repo de la sesion.
  const closed = cwd ? closeCompletedCards(loadKanbanDoc(project), cwd) : [];
  if (closed.length) {
    emit(
      'BOARD ACTUALIZADO: ' + closed.length + ' card(s) cerradas por match con commit reciente -> ' +
      closed.map((t) => '"' + clamp(t, 60) + '"').join(', ') + '.',
    );
    safeLog({ level: 'info', msg: 'cards_closed', project, source, closed, work, session_id: sessionId });
    return;
  }

  const doing = doingCards(project);
  if (!doing.length) {
    safeLog({ level: 'info', msg: 'silent', reason: 'no_doing_cards', project, source, work, session_id: sessionId });
    return;
  }
  if (inCooldown(sessionId)) {
    safeLog({ level: 'info', msg: 'silent', reason: 'cooldown', project, source, session_id: sessionId });
    return;
  }

  emit(buildReminder(project, doing));
  markReminder(sessionId);
  safeLog({
    level: 'info',
    msg: 'reminder_emitted',
    project,
    source,
    doing: doing.map((c) => c.id),
    work,
    session_id: sessionId,
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
