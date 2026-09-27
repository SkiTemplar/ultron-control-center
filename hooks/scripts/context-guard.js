#!/usr/bin/env node
/**
 * context-guard.js — UserPromptSubmit. Vigila el tamano del contexto de la
 * sesion y, cuando crece demasiado, propone /compact con un foco listo para
 * copiar (Claude Code no deja a un hook ejecutar /compact).
 *
 * Por que (medicion 2026-09-26): con Opus y ventana de 1M, el 70,5 % del gasto
 * semanal eran llamadas con mas de 200k de contexto, y en 7 dias solo hubo 2
 * compactaciones automaticas. Cada turno de una sesion larga reenvia todo.
 *
 * Flujo por prompt:
 *   1. Contexto actual = usage del ultimo mensaje assistant (lib/context-size.js,
 *      solo la cola del transcript). Por debajo de WARN_AT: silencio.
 *   2. Desde WARN_AT: aviso de una linea (systemMessage) y veredicto de una LLM
 *      SECUNDARIA (Groq -> Gemini, lib/secondary-llm.js; nunca Claude) sobre si
 *      el trabajo actual necesita todo ese contexto: {compact, reason, focus}.
 *   3. compact=true -> decision:block con el tamano, la razon y `/compact <focus>`;
 *      el prompt bloqueado se guarda en disco para recuperarlo.
 *   4. Desde FORCE_AT: compact=true siempre (el foco lo pone la LLM si responde).
 *   5. Veredicto cacheado por sesion: solo se re-evalua si el contexto crece
 *      REEVAL_DELTA o mas desde la ultima evaluacion (o si bajo: hubo /compact).
 *   6. LLM caida o sin redaccion -> solo aviso (nunca se bloquea por un fallo
 *      propio), salvo por encima de FORCE_AT, donde el bloqueo no depende de ella.
 *
 * Escape: ULTRON_CONTEXT_GUARD=0 (apagado) o un prompt que empiece por `forzar:`
 * (pasa y silencia el bloqueo hasta que el contexto crezca REEVAL_DELTA mas).
 *
 * Umbrales (env): ULTRON_CONTEXT_GUARD_WARN (200000), _FORCE (500000),
 * _DELTA (40000), _LLM_MS (9000), _FAIL_COOLDOWN_MIN (10).
 * Log de cada evaluacion: ~/.ultron/logs/context-guard.jsonl.
 * Seams de test: ULTRON_CONTEXT_GUARD_STATE_DIR, ULTRON_CONTEXT_GUARD_LOG,
 * LAST_SESSION_PROJECTS_DIR.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { currentContextTokens } = require('./lib/context-size');

const HOME = os.homedir();
const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
const WARN_AT = num(process.env.ULTRON_CONTEXT_GUARD_WARN, 200000);
const FORCE_AT = num(process.env.ULTRON_CONTEXT_GUARD_FORCE, 500000);
const REEVAL_DELTA = num(process.env.ULTRON_CONTEXT_GUARD_DELTA, 40000);
const LLM_DEADLINE_MS = num(process.env.ULTRON_CONTEXT_GUARD_LLM_MS, 9000);
const FAIL_COOLDOWN_MS = num(process.env.ULTRON_CONTEXT_GUARD_FAIL_COOLDOWN_MIN, 10) * 60 * 1000;
const FORCE_PREFIX = 'forzar:';

const stateDir = () => process.env.ULTRON_CONTEXT_GUARD_STATE_DIR || path.join(HOME, '.ultron', 'run', 'context-guard');
const logPath = () => process.env.ULTRON_CONTEXT_GUARD_LOG || path.join(HOME, '.ultron', 'logs', 'context-guard.jsonl');
const summariesRoot = () => process.env.LAST_SESSION_PROJECTS_DIR || path.join(HOME, '.ultron', 'cockpit', 'projects');

const kTok = (n) => `${Math.round(n / 1000)}k`;
const safe = (id) => String(id || 'sin-sesion').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(path.join(stateDir(), `${safe(sessionId)}.json`), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(sessionId, state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const p = path.join(stateDir(), `${safe(sessionId)}.json`);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(state));
    fs.renameSync(`${p}.tmp`, p);
  } catch {
    /* best effort: sin cache se re-evalua */
  }
}

function logEval(rec) {
  try {
    require('./lib/jsonl-log').appendJsonl(logPath(), rec);
  } catch {
    /* nunca romper un prompt por el log */
  }
}

/** Bitacora (summary.md) de la sesion en curso, si el barrido ya la genero. */
function sessionBitacora(sessionId) {
  const root = summariesRoot();
  let projects = [];
  try {
    projects = fs.readdirSync(root);
  } catch {
    return '';
  }
  for (const p of projects) {
    try {
      return fs.readFileSync(path.join(root, p, 'sessions', safe(sessionId), 'summary.md'), 'utf8');
    } catch {
      /* no esta en este proyecto */
    }
  }
  return '';
}

const SYSTEM_PROMPT = [
  'Evaluas si una sesion de Claude Code puede compactarse (/compact) sin perder nada que el trabajo en curso necesite.',
  'Compactar sustituye el historial por un resumen: se pierde el detalle literal (salidas de herramientas, ficheros leidos, diffs).',
  'Recomienda compactar (compact=true) si el trabajo actual es una tarea nueva o distinta, si lo anterior esta cerrado',
  '(commit hecho, tarea terminada) o si el detalle antiguo ya no se consulta.',
  'No lo recomiendes (compact=false) si el trabajo en curso depende del detalle literal reciente: depuracion a medias,',
  'refactor multi-fichero sin cerrar, un analisis que se esta citando.',
  'Responde SOLO con JSON: {"compact": boolean, "reason": "una frase en espanol, max. 140 caracteres",',
  '"focus": "instrucciones para /compact en espanol: que conservar (tarea actual, decisiones, ficheros, pendientes), max. 300 caracteres"}.',
].join(' ');

function buildUserMessage({ tokens, prompt, bitacora, activity }) {
  const tools = Object.entries(activity.tools)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}x${v}`)
    .join(', ');
  return [
    `Contexto actual: ${tokens} tokens.`,
    ...(tokens >= FORCE_AT
      ? [`Supera ${FORCE_AT} tokens: la compactacion es OBLIGATORIA. Devuelve compact=true y un focus util para conservar el trabajo en curso.`]
      : []),
    '',
    '## Bitacora de la sesion (resumen automatico; puede estar desfasada)',
    bitacora ? bitacora.slice(0, 6000) : '(no hay)',
    '',
    '## Ultimos prompts del usuario (antiguo -> reciente)',
    ...activity.prompts.map((p, i) => `${i + 1}. ${p}`),
    '',
    '## Prompt nuevo',
    String(prompt || '').slice(0, 1500),
    '',
    '## Herramientas recientes',
    tools || '(ninguna)',
    '',
    '## Ficheros tocados recientemente',
    ...(activity.files.length ? activity.files : ['(ninguno)']),
    '',
    '## Ultimos comandos',
    ...(activity.commands.length ? activity.commands : ['(ninguno)']),
  ].join('\n');
}

const oneLine = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Veredicto de la LLM secundaria. FAIL-CLOSED en redaccion: el material sale
 * de la maquina; sin security-helpers no se envia nada.
 * @returns {Promise<{ok:true, verdict:{compact:boolean, reason:string, focus:string}, provider, model, ms}|{ok:false, error:string, ms:number}>}
 */
async function evaluate({ tokens, prompt, sessionId, transcriptPath }, llm) {
  let redact;
  try {
    redact = require('./lib/security-helpers').redactSecrets;
  } catch {
    return { ok: false, error: 'sin redaccion (fail-closed)', ms: 0 };
  }
  const { recentActivity } = require('./lib/context-size');
  const user = redact(
    buildUserMessage({ tokens, prompt, bitacora: sessionBitacora(sessionId), activity: recentActivity(transcriptPath) })
  );
  const r = await llm({ system: SYSTEM_PROMPT, user, deadlineMs: LLM_DEADLINE_MS });
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'sin respuesta', ms: (r && r.ms) || 0 };
  const j = r.json || {};
  if (typeof j.compact !== 'boolean') return { ok: false, error: 'JSON sin compact:boolean', ms: r.ms };
  return {
    ok: true,
    verdict: { compact: j.compact, reason: oneLine(j.reason, 160), focus: oneLine(j.focus, 320) },
    provider: r.provider,
    model: r.model,
    ms: r.ms,
  };
}

function saveBlockedPrompt(sessionId, prompt) {
  try {
    const dir = path.join(stateDir(), 'blocked');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${safe(sessionId)}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    fs.writeFileSync(file, String(prompt || ''), 'utf8');
    return file;
  } catch {
    return null;
  }
}

const DEFAULT_FOCUS = 'conserva la tarea en curso, las decisiones tomadas, los ficheros modificados y los pendientes';

/**
 * Decide la salida del hook para un payload de UserPromptSubmit.
 * @param {object} input  payload del hook ({session_id, transcript_path, prompt, cwd})
 * @param {{llm?: Function, now?: number}} deps  inyectables (tests)
 * @returns {Promise<object|null>} JSON de salida del hook, o null = silencio
 */
async function decide(input, deps = {}) {
  if (process.env.ULTRON_CONTEXT_GUARD === '0' || process.env.CLAUDE_NO_HOOKS === '1') return null;
  const sessionId = input && input.session_id;
  const prompt = String((input && input.prompt) || '');
  const size = currentContextTokens(input && input.transcript_path);
  if (!size || size.tokens < WARN_AT) return null; // camino caliente: silencio

  const tokens = size.tokens;
  const now = deps.now || Date.now();
  const state = readState(sessionId);
  const base = { ts: new Date(now).toISOString(), session_id: sessionId, cwd: input.cwd, tokens, source: size.source };

  if (prompt.trimStart().toLowerCase().startsWith(FORCE_PREFIX)) {
    writeState(sessionId, { ...state, override_at: tokens });
    logEval({ ...base, action: 'force' });
    return { systemMessage: `ULTRON context-guard: contexto de ${kTok(tokens)}; forzar:, bloqueo en pausa hasta +${kTok(REEVAL_DELTA)}.` };
  }

  const growth = tokens - (Number(state.evaluated_at) || 0);
  // Cruzar FORCE_AT invalida el veredicto: el de antes se pidio sin la
  // compactacion como obligatoria y su foco no sirve para /compact.
  const crossedForce = tokens >= FORCE_AT && Number(state.evaluated_at) < FORCE_AT;
  const cacheValid = state.verdict && growth >= 0 && growth < REEVAL_DELTA && !crossedForce;
  const inFailCooldown =
    !cacheValid && !crossedForce && state.failed_at && now - state.failed_at < FAIL_COOLDOWN_MS && growth >= 0 && growth < REEVAL_DELTA;

  let verdict = cacheValid ? state.verdict : null;
  let llmInfo = { cached: !!cacheValid };
  if (!cacheValid && !inFailCooldown) {
    const llm = deps.llm || require('./lib/secondary-llm').askJson;
    const r = await evaluate({ tokens, prompt, sessionId, transcriptPath: input.transcript_path }, llm);
    llmInfo = { cached: false, ok: r.ok, provider: r.provider, model: r.model, ms: r.ms, error: r.ok ? undefined : r.error };
    if (r.ok) {
      verdict = r.verdict;
      writeState(sessionId, { evaluated_at: tokens, verdict, at: now, override_at: state.override_at });
    } else {
      writeState(sessionId, { ...state, evaluated_at: tokens, verdict: null, failed_at: now });
    }
  } else if (inFailCooldown) {
    llmInfo = { cached: true, ok: false, error: 'en pausa tras fallo' };
  }

  const forced = tokens >= FORCE_AT;
  const overridden = Number.isFinite(state.override_at) && tokens - state.override_at >= 0 && tokens - state.override_at < REEVAL_DELTA;
  const wantsCompact = forced || !!(verdict && verdict.compact);

  if (wantsCompact && !overridden) {
    // Forzado con una LLM que opina que no: su razon contradiria el bloqueo.
    const reason = verdict && verdict.compact && verdict.reason ? verdict.reason : `Supera ${kTok(FORCE_AT)}.`;
    const focus = (verdict && verdict.focus) || DEFAULT_FOCUS;
    const saved = saveBlockedPrompt(sessionId, prompt);
    logEval({ ...base, action: 'block', forced, verdict, llm: llmInfo });
    return {
      decision: 'block',
      reason: [
        `ULTRON context-guard: contexto de ${kTok(tokens)}. ${reason}`.trim(),
        `/compact ${focus}`,
        saved ? `Prompt guardado en ${saved} (para enviarlo sin compactar, empieza por forzar:).` : 'Para enviarlo sin compactar, empieza por forzar:.',
      ].join('\n'),
    };
  }

  const tail = verdict
    ? verdict.compact
      ? `compactar recomendado (en pausa por forzar:): ${verdict.reason}`
      : `no hace falta compactar: ${verdict.reason}`
    : 'evaluador no disponible; valora /compact.';
  logEval({ ...base, action: 'warn', forced, overridden, verdict, llm: llmInfo });
  return { systemMessage: `ULTRON context-guard: contexto de ${kTok(tokens)} (umbral ${kTok(WARN_AT)}); ${tail}` };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch {
      finish();
    }
    setTimeout(finish, 2500).unref();
  });
}

if (require.main === module) {
  require('./lib/hook-obs').observe('context-guard');
  (async () => {
    let out = null;
    try {
      const input = JSON.parse((await readStdin()) || '{}');
      out = await decide(input);
    } catch (e) {
      try { require('./lib/hook-obs').logHookError('context-guard', e); } catch { /* ignore */ }
    }
    if (out) process.stdout.write(JSON.stringify(out), () => process.exit(0));
    else process.exit(0);
  })();
} else {
  module.exports = { decide, evaluate, buildUserMessage, WARN_AT, FORCE_AT, REEVAL_DELTA };
}
