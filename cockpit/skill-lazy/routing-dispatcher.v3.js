#!/usr/bin/env node
/**
 * routing-dispatcher.v3.js — Semantic fallback layer over v2.
 *
 * DESIGN
 * ------
 * v3 extends v2 without modifying it.  It requires('./routing-dispatcher.v2.js')
 * for all deterministic scoring logic and adds a single new code-path:
 *
 *   When the top deterministic candidate has confidence < SEMANTIC_FALLBACK_THRESHOLD
 *   (default 0.80), v3 queries the `ultron_skills` Qdrant collection for top-3
 *   semantically similar skills and appends them as a supplementary hint.
 *
 * INTEGRATION WITH THE E5 DAEMON (2026-06-26)
 * --------------------------------------------
 * Branch B no longer spawns Python. It sends a `skill_query` over TCP loopback
 * to the resident `ultron-memory serve` daemon (the one that already keeps E5
 * warm for the orchestrator). The daemon searches `ultron_skills_lazy` (E5
 * 1024d, ALL skills incl. `.disabled`) and returns the top-N hits.
 *
 *   querySemanticSkills() -> daemonRequest({cmd:'skill_query', prompt, top})
 *
 * WHY THIS REPLACED THE embed_skills.py SUBPROCESS
 * -------------------------------------------------
 * The old path ran `uv run python embed_skills.py query` per prompt, which
 * reloads the mpnet model every process: ~10.4 s warm (measured). That blew the
 * hook's 4.5 s shared deadline, so the semantic hint was ALWAYS skipped — it was
 * retired from the hot path on 2026-06-10 for exactly this reason. The daemon
 * keeps E5 resident, so the same query is ~42 ms warm (measured), comfortably
 * inside budget. acc@3 on the harness skill-scoped cases is HIGHER with E5
 * (100% vs mpnet 91.7%).
 *
 * FAIL-SAFE: if no daemon is up (lockfile absent / connect error / timeout),
 * `daemonRequest` resolves null and the semantic hint is silently omitted — the
 * deterministic v2 routing hint is always emitted regardless.
 *
 * TIMEOUT BUDGET — SHARED DEADLINE
 * ----------------------------------
 * See WARNING comment near HOOK_DEADLINE_MS below for the full invariant.
 *   Total hook budget  : 5 000 ms (Claude Code hard limit)
 *   All async I/O      : <= 4 500 ms (HOOK_DEADLINE_MS, shared across branches)
 *   v2 deterministic   : < 50 ms
 *   Safety margin      : ~450 ms
 *
 * OUTPUT FORMAT
 * -------------
 * When semantic results are appended the additionalContext gains a section:
 *
 *   [semantic-fallback: top-3 by similarity]
 *   1. <skill-name> (score: 0.83) — <description truncated to 120 chars>
 *   2. ...
 *   3. ...
 *   (Activate with /use <skill-name> or mention its name explicitly.)
 *
 * ACTIVATION
 * ----------
 * Same as v2 — copy to ~/.claude/scripts/routing-dispatcher.js after review:
 *
 *   cp cockpit/skill-lazy/routing-dispatcher.v3.js \
 *      ~/.claude/scripts/routing-dispatcher.js
 *
 * node --check ~/.claude/scripts/routing-dispatcher.js
 *
 * BACKWARD COMPATIBILITY
 * ----------------------
 * v3 re-exports every symbol that v2 exports so existing unit-tests pass
 * unchanged.  The semantic path is an additive annotation only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
// Cliente TCP compartido del daemon E5 residente (lockfile + loopback, fail-safe).
// Reusa el transporte de memory-orchestrate en vez de re-spawnear Python por prompt.
const { daemonRequest } = require('../../hooks/scripts/lib/ultron-memory-cli.js');
const { isSystemTurnPrompt } = require('../../hooks/scripts/lib/system-turn.js');
const { decide: decideLane } = require('../../hooks/scripts/lib/fast-lane.js');

const HOME = os.homedir();

// ---------------------------------------------------------------------------
// v2 re-export (all deterministic logic lives there)
// ---------------------------------------------------------------------------
const v2 = require('./routing-dispatcher.v2.js');

/**
 * Dedupe por sesión de la inyección lazy (2026-09-06, ahorro de tokens).
 * Un SKILL.md inyectado ya vive en el contexto de la sesión: volver a
 * inyectarlo en cada prompt que repite el trigger sumaba ~1,5k tokens por
 * turno sin aportar nada. Marker en temp por session_id (mismo patrón que
 * codegraph-reminder.js). Devuelve { fresh: Map, repeated: string[] }.
 */
function splitAlreadyInjected(injected, sessionId) {
  const sid = String(sessionId || 'nosession').replace(/[^A-Za-z0-9_-]/g, '');
  const marker = path.join(os.tmpdir(), 'ultron-lazy-injected-' + sid + '.json');
  let already = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (Array.isArray(parsed)) already = parsed;
  } catch (_) { /* primer prompt de la sesión */ }
  const fresh = new Map();
  const repeated = [];
  for (const [id, body] of injected) {
    if (already.includes(id)) repeated.push(id);
    else fresh.set(id, body);
  }
  if (fresh.size > 0) {
    try {
      fs.writeFileSync(marker, JSON.stringify(already.concat(Array.from(fresh.keys()))));
    } catch (_) { /* sin marker seguimos: mejor repetir que romper */ }
  }
  return { fresh, repeated };
}

// Re-export everything from v2 so unit-tests that import v3 still pass.
Object.assign(module.exports, v2);

// HOOKS-05: v3 registra su PROPIA observacion de timing (v2 ya no observa al
// ser importado como libreria — solo cuando corre standalone).
try {
  if (require.main === module) {
    require('../../hooks/scripts/lib/hook-obs').observe('routing-dispatcher.v3');
  }
} catch { /* observability is optional; never break the hot path */ }

// ---------------------------------------------------------------------------
// Semantic fallback constants
// ---------------------------------------------------------------------------

/**
 * Confidence threshold below which the semantic fallback is triggered.
 * When the deterministic top candidate scores >= this value the extra Qdrant
 * query is skipped entirely (it would add latency for no benefit).
 */
const SEMANTIC_FALLBACK_THRESHOLD = 0.80;

/**
 * Score minimo para que una skill semantica se LLEGUE A SUGERIR. Distinto de
 * SEMANTIC_FALLBACK_THRESHOLD, que decide si se lanza la consulta: este decide
 * si el resultado merece salir por pantalla. Sin el, el hook emitia los top-N
 * de Qdrant sin filtrar y cualquier prompt arrastraba personas irrelevantes.
 * Ver la nota de calibracion en buildSemanticHint.
 */
const SEMANTIC_RELEVANCE_FLOOR = 0.82;

/**
 * Cuantas sugerencias como maximo. Si de verdad solo una skill viene a cuento,
 * ensenar cinco es ruido por diseno aunque todas pasaran el floor.
 */
const SEMANTIC_MAX_SUGGESTIONS = 2;

/**
 * Maximum prompt characters fed to the normalizer before lazy injection.
 * Mirrors v2's MAX_PROMPT_CHARS (which is not exported). Kept in sync so the
 * normalized prompt handed to v2.fetchLazySkillContent matches what v2.main()
 * would have produced.
 */
const MAX_PROMPT_CHARS = 4000;

/**
 * Hard deadline for ALL async I/O in this hook (ms from the moment mainV3 starts).
 *
 * WARNING — TIMING INVARIANT:
 *   Claude Code's UserPromptSubmit hook has a hard 5 000 ms wall-clock limit.
 *   v3 has TWO potentially expensive async branches:
 *     A) Lazy skill injection  (runs when topConfidence >= SEMANTIC_FALLBACK_THRESHOLD)
 *     B) Semantic Qdrant query (runs when topConfidence <  SEMANTIC_FALLBACK_THRESHOLD)
 *
 *   Today both thresholds equal 0.80, so A and B are mutually exclusive.
 *   BUT if either threshold is changed they could BOTH execute sequentially,
 *   potentially spending up to (lazy timeout + semantic timeout) ≈ 9 s — far
 *   exceeding the 5 s budget and causing the hook to be killed mid-flight.
 *
 *   FIX: a single shared deadline of HOOK_DEADLINE_MS is established once at
 *   the start of mainV3().  Each async branch receives only its remaining time
 *   slice (remainingMs = deadline - Date.now()).  If remaining time <= 0 the
 *   branch is skipped entirely.  This guarantees the total wall-clock cost of
 *   all I/O can never exceed HOOK_DEADLINE_MS, regardless of threshold values.
 *
 *   Budget breakdown (worst case — both branches run):
 *     v2 deterministic scoring : <  50 ms
 *     Lazy inject (branch A)   : <= remainingMs (capped, typically ~500 ms warm)
 *     Semantic query (branch B): <= remainingMs (capped, typically ~800 ms warm)
 *     Output serialisation     : <  10 ms
 *     Safety margin            : ~440 ms
 *   Total guaranteed max       : 4 500 ms  (HOOK_DEADLINE_MS)
 */
const HOOK_DEADLINE_MS = 4500;

/**
 * Default maximum milliseconds to wait for the embed_skills.py subprocess.
 * Overridden at runtime by the shared deadline — this value is only used as
 * an absolute upper bound when no deadline context is available.
 */
const SEMANTIC_TIMEOUT_MS = 8000;

/** Number of semantic candidates to request from Qdrant. */
const SEMANTIC_TOP_N = 3;

// ---------------------------------------------------------------------------
// Semantic query helper
// ---------------------------------------------------------------------------

/**
 * Query the resident E5 daemon for the top-N semantically similar skills over
 * the `ultron_skills_lazy` collection (ALL skills incl. `.disabled`).
 *
 * Sub-second warm (~42 ms measured) over a TCP loopback call to the daemon that
 * already keeps E5 resident — vs the ~10 s the old `embed_skills.py` subprocess
 * paid per prompt (reloading mpnet per process). That 10 s is why the semantic via
 * was retired from the hot path on 2026-06-10; the daemon brings it back within
 * budget. `daemonRequest` is the shared fail-safe client (lockfile + loopback);
 * if no daemon is up it resolves null and the semantic hint is simply omitted.
 *
 * @param {string} promptText  - The user prompt (truncated to 500 chars for speed).
 * @param {number} topN        - Number of results to request.
 * @param {number} [timeoutMs] - Shared-deadline remainder; bounds the daemon call
 *                               so it never exceeds the hook's total budget.
 * @returns {Promise<Array<{name:string, score:number, description:string}>|null>}
 */
async function querySemanticSkills(promptText, topN, timeoutMs) {
  const effectiveTimeout = (typeof timeoutMs === 'number' && timeoutMs > 0)
    ? timeoutMs
    : SEMANTIC_TIMEOUT_MS;
  // The daemon returns a JSON array of skill hits on success, or {error:...}.
  const resp = await daemonRequest(
    { cmd: 'skill_query', prompt: promptText.slice(0, 500), top: topN },
    effectiveTimeout,
  );
  return Array.isArray(resp) ? resp : null;
}

// ---------------------------------------------------------------------------
// Gate de intencion: dominio no es lo mismo que intencion
// ---------------------------------------------------------------------------

/**
 * Señales de que el turno es TRABAJO SOBRE CODIGO y no una consulta al dominio.
 *
 * POR QUE EXISTE (medido 2026-08-28 sobre 40 prompts reales del inbox): 19 de
 * las 57 sugerencias emitidas eran personas, y solo UNA acertaba — la que
 * llamaba a la persona por su nombre. Las demas salian por dominio: "detectar
 * fotos rectas o torcidas" sacaba a mike-tyson, "quita de Cuentame la seccion
 * de La Tienda" sacaba a terry-davis. El caso que lo resume: un bug en el
 * dashboard de finanzas invocaba a tio-gilito, que es un asesor financiero, en
 * vez de al depurador.
 *
 * La causa esta en el propio catalogo: las personas declaran `context` con
 * tokens como 'bug', 'commit', 'refactor' o '.py', asi que cuanto mas tecnico
 * es el turno, mas puntuan. Este gate invierte esa regla.
 *
 * Vocabulario deliberadamente corto y en frases/palabras completas: un gate de
 * EXCLUSION con falsos positivos te quita la persona cuando si la querias, asi
 * que solo entran señales que describen trabajo sobre el codigo sin ambiguedad.
 */
const SENALES_TRABAJO_TECNICO = [
  'bug', 'bugs', 'error', 'errores', 'falla', 'fallo', 'falta', 'crash', 'excepcion',
  'stacktrace', 'traceback', 'no funciona', 'no va', 'peta', 'roto', 'rota',
  'arregla', 'arreglar', 'corrige el', 'depura', 'debug', 'debuggear',
  'implementa', 'implementar', 'programa', 'codifica', 'refactoriza', 'refactor',
  'test', 'tests', 'testea', 'cobertura', 'compila', 'build', 'deploy', 'despliega',
  'endpoint', 'commit', 'merge', 'pull request', 'migracion', 'query', 'schema',
  'funcion', 'variable', 'dependencia', 'linter', 'excepciones',
];

/** Extensiones de fichero: nombrar un `.py` es hablar de codigo, no de dominio. */
const RE_EXTENSION = /\.(js|mjs|ts|tsx|jsx|py|rs|go|java|cs|cpp|c|h|hpp|sql|sh|ps1|json|toml|yaml|yml)\b/;

/**
 * Rutas del clasificador determinista que significan "esto es trabajo sobre el
 * codigo". Se piden al daemon (`cmd: route`, solo reglas, sin LLM ni memoria).
 */
const RUTAS_TECNICAS = new Set([
  'bug_fix', 'feature', 'refactor', 'testing', 'security', 'performance',
  'architecture_review', 'api_design', 'database', 'rust', 'python', 'typescript',
]);

/** Techo de espera del clasificador: si tarda mas, se decide solo con lexico. */
const ROUTE_TIMEOUT_MS = 300;

/**
 * `true` si el turno pide trabajo sobre el codigo.
 *
 * DOS SEÑALES, PORQUE NINGUNA BASTA SOLA (medido 2026-08-28):
 *   - El lexico de aqui abajo no ve "el umbral de caras da valores raros" ni
 *     "quita de Cuentame la seccion de La Tienda": describen sintomas y
 *     ediciones sin una sola palabra tecnica.
 *   - El clasificador del daemon SI los marca (`bug_fix` y `feature`), pero
 *     arrastra el mismo sesgo de dominio que este gate viene a corregir: "hay un
 *     bug en el dashboard de finanzas" lo rutea como `finance`.
 * Cada una tapa el agujero de la otra, asi que basta con que una diga que si.
 *
 * @param {string} promptNorm prompt ya normalizado (minusculas, sin acentos)
 * @param {string} [ruta] ruta del daemon, si se pudo consultar a tiempo
 * @returns {boolean}
 */
function pideTrabajoTecnico(promptNorm, ruta) {
  if (ruta && RUTAS_TECNICAS.has(ruta)) return true;
  if (RE_EXTENSION.test(promptNorm)) return true;
  return SENALES_TRABAJO_TECNICO.some((s) => v2.hasToken(promptNorm, s));
}

/**
 * Ruta determinista del daemon. FAIL-OPEN: sin daemon o fuera de tiempo
 * devuelve null y el gate se queda con el lexico.
 *
 * @param {string} promptText
 * @returns {Promise<string|null>}
 */
async function rutaDeterminista(promptText) {
  const resp = await daemonRequest({ cmd: 'route', prompt: promptText.slice(0, 500) }, ROUTE_TIMEOUT_MS);
  return resp && typeof resp.route === 'string' ? resp.route : null;
}

/**
 * `true` si el prompt llama a la persona por su nombre. Una invocacion
 * explicita gana SIEMPRE: "Tio Gilito, hay un bug en tus cuentas" sigue siendo
 * para Gilito aunque el turno sea tecnico.
 *
 * @param {string} promptNorm
 * @param {string} personaId
 * @returns {boolean}
 */
function invocadaPorNombre(promptNorm, personaId) {
  const persona = (v2.PERSONAS || []).find((p) => v2.normalize(p.id) === v2.normalize(personaId));
  if (!persona) return false;
  const triggers = persona.triggers || [];
  return triggers.some((t) => v2.hasToken(promptNorm, v2.normalize(t)));
}

/** `true` si ese id es una persona del catalogo. */
function esPersona(id) {
  const n = v2.normalize(id || '');
  return (v2.PERSONAS || []).some((p) => v2.normalize(p.id) === n);
}

/**
 * Quita del ranking las personas que nadie ha llamado cuando el turno es
 * trabajo sobre codigo. No toca nada mas: si el turno no es tecnico, o si la
 * persona viene invocada por su nombre, el ranking sale intacto.
 *
 * @param {Array<{id:string, kind?:string}>} candidatos
 * @param {string} prompt
 * @returns {Array} el mismo array filtrado
 */
function filtrarPersonas(candidatos, prompt) {
  const lista = Array.isArray(candidatos) ? candidatos : [];
  const promptNorm = v2.normalize(prompt);
  if (!pideTrabajoTecnico(promptNorm)) return lista;
  const fuera = [];
  const dentro = lista.filter((c) => {
    const persona = c.kind === 'persona' || esPersona(c.id);
    if (!persona) return true;
    if (invocadaPorNombre(promptNorm, c.id)) return true;
    fuera.push(c.id);
    return false;
  });
  if (fuera.length) {
    safeLogV3({ level: 'info', msg: 'gate_intencion_descarta_personas', descartadas: fuera });
  }
  return dentro;
}

/**
 * Floor propio para las personas que llegan por similitud.
 *
 * POR QUE MAS ALTO QUE EL GENERAL (0.82): sugerir una persona equivocada cuesta
 * entre 1.797 y 2.791 tokens si el determinista la inyecta, y ademas cambia el
 * registro de la respuesta. Un `python-pro` de mas es ruido barato; un
 * `mike-tyson` de mas en una pregunta de vision por computador no lo es. En la
 * bateria del 2026-08-28 las personas erroneas del denso puntuaban 0.79-0.82,
 * justo en la banda de ruido.
 */
const PERSONA_RELEVANCE_FLOOR = 0.86;

/**
 * Misma regla, aplicada a una lista de nombres (juez) o de hits con score
 * (denso). A las personas se les exige ademas el floor alto: el gate de
 * intencion solo ve señales lexicas, y "el umbral de caras da valores raros" no
 * tiene ninguna aunque sea trabajo de codigo puro.
 */
function filtrarNombresPersona(nombres, prompt) {
  const lista = Array.isArray(nombres) ? nombres : [];
  const promptNorm = v2.normalize(prompt);
  const tecnico = pideTrabajoTecnico(promptNorm);
  const fuera = [];
  const dentro = lista.filter((n) => {
    const nombre = typeof n === 'string' ? n : (n && n.name) || '';
    if (!esPersona(nombre)) return true;
    if (invocadaPorNombre(promptNorm, nombre)) return true;
    if (tecnico) {
      fuera.push(nombre);
      return false;
    }
    const score = typeof n === 'object' && typeof n.score === 'number' ? n.score : null;
    if (score !== null && score < PERSONA_RELEVANCE_FLOOR) {
      fuera.push(`${nombre}(${score.toFixed(3)})`);
      return false;
    }
    return true;
  });
  if (fuera.length) {
    safeLogV3({ level: 'info', msg: 'gate_intencion_descarta_personas', descartadas: fuera, tecnico });
  }
  return dentro;
}

/**
 * Techo propio del juez LLM. El daemon corta a los 2500 ms por su cuenta
 * (ULTRON_SKILL_LLM_TIMEOUT_MS); aqui se acota otra vez para que, si el juez
 * agota su tiempo, aun quede presupuesto del hook para el fallback denso.
 */
const JUDGE_TIMEOUT_MS = 2600;

/**
 * Skills elegidas por el juez LLM (`skill_judge` del daemon). El daemon le pasa
 * un catalogo prefiltrado por el denso (top-25) mas TODOS los slash commands de
 * plugin, que no estan en el indice: el catalogo entero costaba ~2.400 tokens
 * por consulta y con eso ningun tier gratis aguanta una jornada.
 *
 * POR QUE ANTES DEL DENSO: medido el 2026-08-27 sobre 10 prompts reales, el
 * retriever E5 acierta 4/10 en top-1 y todos sus scores caben entre 0.79 y
 * 0.84, asi que ningun umbral separa un acierto de un candidato al azar. El
 * juez, con el mismo catalogo delante, acierta 8/10 (los 2 restantes fueron
 * cortes de cuota del proveedor, no elecciones malas).
 *
 * FAIL-SAFE: sin daemon, sin clave, en cooldown o fuera de tiempo devuelve
 * null y la rama sigue con el fallback denso de siempre.
 *
 * @param {string} promptText
 * @param {number} timeoutMs
 * @returns {Promise<string[]|null>}
 */
async function judgeSkills(promptText, timeoutMs) {
  const resp = await daemonRequest(
    { cmd: 'skill_judge', prompt: promptText.slice(0, 500) },
    timeoutMs,
  );
  if (!resp || !Array.isArray(resp.skills) || resp.skills.length === 0) return null;
  return resp.skills;
}

/**
 * Hint del juez. Sin scores: el modelo elige o no elige, no hay similitud que
 * ensenar, y un numero inventado solo daria una falsa sensacion de medida.
 *
 * @param {string[]} names
 * @returns {string}
 */
function buildJudgeHint(names) {
  if (!names || names.length === 0) return '';
  const lines = ['', '[skill-match: elegidas por el juez LLM]'];
  names.forEach(function (n, i) {
    lines.push((i + 1) + '. ' + n);
  });
  lines.push('(If one fits: invoke it with the Skill tool if it is active; if it is lazy on disk, Read ~/.claude/skills/_disabled/<name>/SKILL.md instead.)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Format semantic results into a context hint block
// ---------------------------------------------------------------------------

/**
 * Build the semantic fallback hint appended after the deterministic routing hint.
 *
 * @param {Array<{name:string, score:number, description:string}>} results
 * @returns {string}
 */
function buildSemanticHint(results) {
  if (!results || results.length === 0) return '';

  // RELEVANCE FLOOR (medido 2026-07-29, 5 prompts contra el catalogo real):
  // los ACIERTOS puntuan 0.827-0.837 (tio-gilito en finanzas, mike-tyson en UI)
  // y el RUIDO techa en 0.810-0.817 (consolidate-memory en un bug de futbol,
  // jordan-belfort en una pregunta trivial). Sin filtro se emitian los 5
  // primeros de Qdrant tal cual, asi que CUALQUIER prompt sugeria personas al
  // azar con score de ruido. El corte va entre ambas bandas.
  const relevant = results
    .filter((r) => typeof r.score === 'number' && r.score >= SEMANTIC_RELEVANCE_FLOOR)
    .slice(0, SEMANTIC_MAX_SUGGESTIONS);
  if (relevant.length === 0) return '';

  const lines = [
    '',
    '[semantic-fallback: top-' + relevant.length + ' by similarity]',
  ];
  relevant.forEach(function (r, i) {
    const desc = (r.description || '').slice(0, 120).replace(/\n/g, ' ');
    const score = typeof r.score === 'number' ? r.score.toFixed(3) : '?';
    const rerank = typeof r.rerank_score === 'number' ? ' rerank=' + r.rerank_score.toFixed(3) : '';
    lines.push(
      (i + 1) + '. ' + (r.name || '?') + ' (score: ' + score + rerank + ')' +
      (desc ? ' — ' + desc : '')
    );
  });
  // RT-06 (auditoria 2026-07-16): '/use <skill>' no existe en Claude Code.
  // Instruccion honesta: Skill tool para activas, Read del SKILL.md para .disabled.
  lines.push('(If one fits: invoke it with the Skill tool if it is active; if it is lazy on disk, Read ~/.claude/skills/_disabled/<name>/SKILL.md instead.)');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Logging (reuses v2's safeLog via the module boundary)
// ---------------------------------------------------------------------------

/**
 * Safe logger that mirrors v2's safeLog shape.
 * We re-open the same log file rather than importing the private function.
 */
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'routing-dispatcher.jsonl');

// PERF-04: JSONL acotado (rota a 1 MiB) via helper compartido — mismo appender
// que usa v2 (routing-dispatcher.v2.js). Nunca lanza.
const { appendJsonl } = require('../../hooks/scripts/lib/jsonl-log');

function safeLogV3(entry) {
  appendJsonl(LOG_PATH, entry);
}

// ---------------------------------------------------------------------------
// v3 main — wraps v2 main with semantic augmentation
// ---------------------------------------------------------------------------

/**
 * Read stdin, run v2 deterministic scoring, optionally augment with semantic
 * results, emit the combined additionalContext.
 *
 * This function intentionally mirrors v2's main() structure so it can replace
 * it directly in the hook file.
 */
async function mainV3() {
  // Shared deadline: ALL async I/O in this function must finish before this
  // timestamp.  Each branch receives only the remaining slice so the combined
  // wall-clock cost is bounded to HOOK_DEADLINE_MS regardless of how many
  // branches execute (see WARNING comment near HOOK_DEADLINE_MS above).
  const hookStart = Date.now();
  const deadlineAt = hookStart + HOOK_DEADLINE_MS;

  // Advance v2's process-wide invocation counter. v3 reuses v2's lazy-injection
  // machinery (fetchLazySkillContent -> isCoolingDown / recordInjection) but
  // does NOT call v2.main(), which is the only place v2 normally bumps the
  // counter. Without this bump the counter stays at 0 across every mainV3 call
  // and the cooldown window collapses to a no-op. Harmless in production (the
  // hook is an ephemeral one-process-per-prompt invocation, so the counter and
  // _injectionHistory always start fresh) but correct for any host that reuses
  // the process. The guard keeps v3 forward/backward compatible with v2 builds
  // that predate this export.
  if (typeof v2._incrementInvocationCounter === 'function') {
    v2._incrementInvocationCounter();
  }

  /** Returns ms remaining before the shared deadline (minimum 0). */
  function remainingMs() {
    return Math.max(0, deadlineAt - Date.now());
  }

  // Replicate v2's stdin reading + payload parsing
  let stdinRaw = '';
  try {
    stdinRaw = fs.readFileSync(0, 'utf8');
  } catch (_) {
    stdinRaw = '';
  }

  let payload = {};
  try {
    payload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (_) {
    emitContextV3('');
    return;
  }

  const prompt = String(payload.prompt || payload.user_prompt || '').trim();
  if (!prompt) {
    emitContextV3('');
    return;
  }

  // Turno de SISTEMA (notificacion de tarea background): no rutear — ni
  // ranking determinista ni fallback semantico sobre XML del harness.
  if (isSystemTurnPrompt(prompt)) {
    emitContextV3('');
    return;
  }

  // Doble velocidad (2026-09-07): un ack o una continuacion corta no lleva
  // skill que rutear — ni ranking v2 ni fallback semantico ni juez LLM. Solo
  // lee el estado de la sesion; lo incrementa memory-orchestrate (el ultimo
  // hook del grupo), asi que ambos ven el mismo conteo en el mismo turno.
  const sessionIdV3 = payload.session_id || payload.sessionId || null;
  if (decideLane({ prompt, sessionId: sessionIdV3 }).lane === 'fast') {
    emitContextV3('');
    return;
  }

  // --- Step 1: Run v2 deterministic ranking (synchronous, < 50 ms) ---
  const ranked = filtrarPersonas(v2.rankCandidates(prompt), prompt);
  const top = ranked[0] || null;
  const second = ranked[1] || null;

  // HIGH_THRESHOLD is intentionally bound to SEMANTIC_FALLBACK_THRESHOLD so the
  // two cannot drift apart: branch A (lazy inject) runs when confidence >= T and
  // branch B (semantic fallback) runs when confidence < T. Sharing a single T
  // keeps A and B mutually exclusive (see the HOOK_DEADLINE_MS WARNING above).
  const HIGH_THRESHOLD = SEMANTIC_FALLBACK_THRESHOLD;
  const MED_THRESHOLD = 0.50;

  let deterministicText = '';
  const topConfidence = top ? top.confidence : 0;

  // iter-10 FASE 7: for genuinely ambiguous prompts (topConfidence < 0.50,
  // typical of vague planning requests) widen the semantic fallback so it casts
  // a broader net (TOP_N 5) at a lower effective threshold (0.65). For clearer
  // prompts the original 0.80 / TOP_N 3 behavior is preserved unchanged.
  //
  // INVARIANT: branch A (lazy) still requires topConfidence >= HIGH_THRESHOLD
  // (0.80); the effective threshold below only ever LOWERS branch B's bar for
  // conf < 0.50, so 0.50 <= effective <= 0.80 always sits below 0.80 and A/B
  // remain mutually exclusive. The shared HOOK_DEADLINE_MS budget is untouched.
  const ambiguousPrompt = topConfidence < MED_THRESHOLD;
  const effectiveSemanticThreshold = ambiguousPrompt
    ? 0.65
    : SEMANTIC_FALLBACK_THRESHOLD;
  const effectiveSemanticTopN = ambiguousPrompt ? 5 : SEMANTIC_TOP_N;

  if (top && topConfidence >= HIGH_THRESHOLD) {
    deterministicText = buildHighContextV3(top);
    safeLogV3({
      level: 'info', msg: 'high_confidence_routing',
      top: formatLabelV3(top), score: top.score, confidence: topConfidence,
    });
  } else if (top && topConfidence >= MED_THRESHOLD) {
    deterministicText = buildMediumContextV3(top, second);
    safeLogV3({
      level: 'info', msg: 'medium_confidence_routing',
      top: formatLabelV3(top),
      second: second ? formatLabelV3(second) : null,
      score: top.score, confidence: topConfidence,
    });
  } else {
    if (top) {
      safeLogV3({
        level: 'info', msg: 'low_confidence_skip',
        top: formatLabelV3(top), score: top.score, confidence: topConfidence,
      });
    } else {
      safeLogV3({ level: 'info', msg: 'no_match', prompt_chars: prompt.length });
    }
  }

  // --- Step 2: Lazy skill injection (branch A — only when high confidence) ---
  // WARNING: branch A and branch B both consume from the shared deadline.
  // If both thresholds are changed so that A and B can run sequentially, the
  // deadline still caps total I/O to HOOK_DEADLINE_MS.  If remainingMs() is
  // already 0 when a branch is reached, it is skipped entirely.
  let lazyBlock = '';
  if (topConfidence >= HIGH_THRESHOLD) {
    const lazyBudget = remainingMs();
    if (lazyBudget > 50) {  // skip if < 50 ms left — not worth the syscall
      try {
        // v2.fetchLazySkillContent uses its own internal LAZY_READ_TIMEOUT_MS
        // (5 000 ms).  Wrap with Promise.race so it cannot exceed our budget.
        // HOOKS-01: guardar el handle y limpiarlo tras el race — sin esto el
        // timer mantiene vivo el event loop hasta agotar lazyBudget (~4.5s)
        // en CADA prompt de alta confianza aunque el trabajo acabe en ~150ms.
        let lazyTimerHandle = null;
        const lazyRaceTimeout = new Promise(function (resolve) {
          lazyTimerHandle = setTimeout(function () { resolve(new Map()); }, lazyBudget);
        });
        // v2.fetchLazySkillContent(candidates, promptNorm) needs promptNorm to
        // detect planning intent (promptHasStrongPlanningKeyword) for the
        // PLANNING_LAZY_SKILLS allowlist — calling it without promptNorm
        // silently disables that allowlist. Mirror v2.main():
        // normalize(prompt).slice(0, MAX_PROMPT_CHARS).
        const promptNorm = v2.normalize(prompt).slice(0, MAX_PROMPT_CHARS);
        const injected = await Promise.race([
          v2.fetchLazySkillContent(ranked, promptNorm),
          lazyRaceTimeout,
        ]);
        if (lazyTimerHandle) clearTimeout(lazyTimerHandle);
        if (injected.size > 0) {
          const split = splitAlreadyInjected(injected, payload.session_id);
          if (split.fresh.size > 0) lazyBlock = v2.buildInjectionBlock(split.fresh);
          if (split.repeated.length > 0) {
            lazyBlock +=
              '\n[skills ya inyectadas en esta sesion (aplican, no se repiten): ' +
              split.repeated.join(', ') + ']';
          }
          safeLogV3({
            level: 'info', msg: 'lazy_skill_injected',
            skills: Array.from(split.fresh.keys()),
            repeated: split.repeated,
            elapsed_ms: Date.now() - hookStart,
          });
        }
      } catch (_err) {
        safeLogV3({ level: 'warn', msg: 'lazy_injection_failed', error: String(_err && _err.message) });
      }
    } else {
      safeLogV3({ level: 'warn', msg: 'lazy_injection_skipped_deadline', remaining_ms: lazyBudget });
    }
  }

  // --- Step 3: Semantic fallback (branch B — only when low confidence) ---
  let semanticBlock = '';
  if (topConfidence < effectiveSemanticThreshold) {
    const semBudget = remainingMs();
    if (semBudget > 50) {  // skip if < 50 ms left
      try {
        // El juez LLM decide primero; el denso queda como respaldo cuando no
        // hay proveedor, no hay clave o se agota el tiempo.
        const judged = filtrarNombresPersona(
          await judgeSkills(prompt, Math.min(semBudget, JUDGE_TIMEOUT_MS)),
          prompt,
        );
        if (judged && judged.length) {
          semanticBlock = buildJudgeHint(judged);
          safeLogV3({
            level: 'info',
            msg: 'skill_judge_hit',
            deterministic_top_id: top ? top.id : null,
            deterministic_confidence: topConfidence,
            judged: judged,
          });
        }
        const semResults = semanticBlock
          ? null
          : filtrarNombresPersona(
              await querySemanticSkills(prompt, effectiveSemanticTopN, remainingMs()),
              prompt,
            );
        if (semResults && semResults.length > 0) {
          semanticBlock = buildSemanticHint(semResults);
          safeLogV3({
            level: 'info',
            msg: 'semantic_fallback_triggered',
            // Deterministic context: what the rule-based router found (or didn't)
            deterministic_top_id: top ? top.id : null,
            deterministic_top_kind: top ? top.kind : null,
            deterministic_confidence: topConfidence,
            // Top-3 semantic candidates for diagnostic of semantic_fallback_rate
            semantic_top3: semResults.slice(0, 3).map(function (r) {
              return {
                name: r.name || '?',
                score: typeof r.score === 'number' ? parseFloat(r.score.toFixed(4)) : null,
                rerank_score: typeof r.rerank_score === 'number'
                  ? parseFloat(r.rerank_score.toFixed(4))
                  : undefined,
              };
            }),
            semantic_count: semResults.length,
            elapsed_ms: Date.now() - hookStart,
          });
        } else {
          safeLogV3({
            level: 'info', msg: 'semantic_fallback_empty',
            deterministic_confidence: topConfidence,
            elapsed_ms: Date.now() - hookStart,
          });
        }
      } catch (_err) {
        safeLogV3({ level: 'warn', msg: 'semantic_fallback_error', error: String(_err && _err.message) });
      }
    } else {
      safeLogV3({ level: 'warn', msg: 'semantic_fallback_skipped_deadline', remaining_ms: semBudget });
    }
  }

  safeLogV3({
    level: 'debug', msg: 'v3_hook_complete',
    total_elapsed_ms: Date.now() - hookStart,
    had_lazy: lazyBlock.length > 0,
    had_semantic: semanticBlock.length > 0,
  });

  // --- Assemble final output ---
  const fullText = (deterministicText + lazyBlock + semanticBlock).trim();
  emitContextV3(fullText);
}

// ---------------------------------------------------------------------------
// Output helper (identical to v2's emitContext but standalone)
// ---------------------------------------------------------------------------

function emitContextV3(text) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text || '',
    },
  };
  // Pilar 1: contabiliza lo que este hook inyecta al CLI (era el segundo mayor
  // inyector sin medir). v3 es el unico punto de emision en produccion: v2 solo
  // emite por su cuenta si se ejecuta como script principal (require.main),
  // caso que el manifest de hooks no registra — no hay doble conteo por prompt.
  try { require('../../hooks/scripts/lib/token-meter').meterInjection('routing-dispatcher', text || ''); } catch {}
  // HOOKS-01: exit explicito tras vaciar stdout — timers internos de
  // fetchLazySkillContent / querySemanticSkills no deben mantener el proceso
  // vivo hasta su deadline. El callback de write garantiza el flush del
  // payload (puede ser grande con inyeccion lazy); el listener de observe()
  // sigue disparando en process.exit.
  try {
    process.stdout.write(JSON.stringify(payload), function () { process.exit(0); });
  } catch (_) {
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Context-building helpers (mirrors of v2's private functions)
// These are duplicated here so v3 can run standalone without depending on
// v2's unexported private state (HIGH_THRESHOLD, etc.).
// ---------------------------------------------------------------------------

function formatLabelV3(c) {
  if (c.kind === 'persona') return 'persona:' + (c.persona || c.id);
  if (c.kind === 'agent')   return 'agent:' + c.id;
  return 'skill:' + c.id;
}

function buildHighContextV3(top) {
  const matchedSummary = top.matched.slice(0, 3).join(', ');
  return [
    '[auto-routing: ' + Math.round(top.confidence * 100) + '% confidence]',
    'Suggested: ' + formatLabelV3(top) + ' -- signals matched: ' + matchedSummary,
    'If this routing is wrong, ignore this hint and proceed with your judgement.',
  ].join('\n');
}

function buildMediumContextV3(top, second) {
  const lines = [
    '[auto-routing: medium confidence ~' + Math.round(top.confidence * 100) + '%]',
    'Two candidates matched the prompt:',
    '  1) ' + formatLabelV3(top) + ' (score ' + top.score + ', signals: ' + top.matched.slice(0, 2).join(', ') + ')',
  ];
  if (second) {
    lines.push('  2) ' + formatLabelV3(second) + ' (score ' + second.score + ', signals: ' + second.matched.slice(0, 2).join(', ') + ')');
  }
  lines.push('Pick the one that matches your interpretation of the request, or ignore.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  mainV3().catch(function (err) {
    safeLogV3({ level: 'error', msg: 'v3_unhandled_async', error: String(err && err.message) });
    emitContextV3('');
  }).finally(function () {
    process.exitCode = 0;
  });
}

// Exported for unit tests — includes all v2 symbols plus v3-specific ones.
module.exports.querySemanticSkills = querySemanticSkills;
module.exports.judgeSkills = judgeSkills;
module.exports.buildJudgeHint = buildJudgeHint;
module.exports.buildSemanticHint = buildSemanticHint;
module.exports.filtrarPersonas = filtrarPersonas;
module.exports.filtrarNombresPersona = filtrarNombresPersona;
module.exports.pideTrabajoTecnico = pideTrabajoTecnico;
module.exports.SEMANTIC_FALLBACK_THRESHOLD = SEMANTIC_FALLBACK_THRESHOLD;
module.exports.SEMANTIC_TIMEOUT_MS = SEMANTIC_TIMEOUT_MS;
module.exports.HOOK_DEADLINE_MS = HOOK_DEADLINE_MS;
