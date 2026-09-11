#!/usr/bin/env node
// hooks/scripts/memory-session-resume.js — SessionStart hook.
//
// Loads a MINIMAL bounded resume (active workflows, open tasks, recent
// decisions, pinned, next action) from the canonical store via the
// `ultron-memory resume` sidecar, and injects it as additionalContext.
// FAIL-SAFE: emits empty context (never breaks the session) if the binary is
// missing or anything fails.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { runCli, projectIdFromCwd, findBinary, spawnDetached } = require('./lib/ultron-memory-cli');
const { observe, logHookError } = require('./lib/hook-obs');
// ULTRON 4 12.1: lineas de feedback de sesion (lib/session-feedback).
const { renderResumeLines: renderFeedbackLines } = require('./lib/session-feedback');
// ULTRON 4 4.2: cifra de concision de las ultimas sesiones (lib/response-meter).
const { renderResumeLine: renderMeterLine } = require('./lib/response-meter');
// ULTRON 4 8.1: resumen del indice CodeGraph del proyecto (lib/codegraph-summary).
const codegraphSummary = require('./lib/codegraph-summary');
// F-resume (2026-09-11): resumen de la sesion ANTERIOR del proyecto. Puro
// (lib/last-session.js) mas las funciones de seleccion de session-summarize-
// previous.js, que se pueden requerir aqui porque solo definen funciones —
// su trabajo real vive dentro de main(), guardado tras require.main===module.
const lastSession = require('./lib/last-session');
const sessionSummaryDelivery = require('./lib/session-summary-delivery');
const sessionSummarizer = require('./session-summarize-previous');
observe('memory-session-resume');

// HOOKS-04 (auditoria 2026-07-16): calentar el daemon de memoria DESDE
// SessionStart. Medido en orchestrate.jsonl: con daemon vivo p50=562ms, sin el
// p50=4145ms — y el 35% de los prompts caian sin daemon porque solo se
// arrancaba tras el primer MISS. spawnDetached es idempotente (sale al momento
// si ya hay uno vivo) y no bloquea el resume.
try { spawnDetached(['serve']); } catch { /* fail-safe: el resume sigue */ }

function emit(additionalContext) {
  const ctx = additionalContext || '';
  // Pilar 1: contabiliza lo que este hook inyecta al CLI (antes a ciegas).
  try { require('./lib/token-meter').meterInjection('memory-session-resume', ctx); } catch {}
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: ctx,
      },
    })
  );
}

// cat17.2 (mandamiento #12): precompact-preserve-l0.js deja el estado de trabajo
// L0 en ~/.ultron/.tmp/context.md antes de una compactacion, pero hasta ahora
// NADIE lo leia (el dato se escribia y se abandonaba). Aqui lo re-leemos en
// SessionStart y lo inyectamos como contexto, para que el scratch preservado se
// USE tras compactar. Bounded (<=2KB) + fail-safe + gate de frescura (<24h) para
// no re-inyectar un scratch viejo en sesiones nuevas no relacionadas.
const L0_SCRATCH = path.join(os.homedir(), '.ultron', '.tmp', 'context.md');
const L0_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const L0_MAX_CHARS = 2000;

function readL0Scratch(currentProject) {
  try {
    const st = fs.statSync(L0_SCRATCH);
    if (Date.now() - st.mtimeMs > L0_MAX_AGE_MS) return ''; // stale -> ignora
    const raw = fs.readFileSync(L0_SCRATCH, 'utf8').trim();
    if (!raw) return '';
    // (2026-08-10) Gate CROSS-PROJECT: el scratch declara su proyecto en el
    // header ("project: legacy-fc"); inyectarlo en una sesion de OTRO proyecto
    // es contaminacion (caso real: scratch de legacy-fc del 08-02 apareciendo
    // en ultron). Sin header o sin proyecto actual: se inyecta (compat).
    if (currentProject) {
      const m = raw.match(/^>?\s*trigger:.*?project:\s*(\S+)/m) || raw.match(/\bproject:\s*(\S+)\s*·/);
      const scratchProject = m && m[1] ? m[1].trim() : '';
      if (scratchProject && scratchProject !== currentProject) return '';
    }
    const clipped = raw.length > L0_MAX_CHARS ? raw.slice(0, L0_MAX_CHARS) + '\n[...]' : raw;
    return '\n<l0-scratch source="precompact" trust="system">\n' + clipped + '\n</l0-scratch>';
  } catch {
    return ''; // no scratch / no leible -> nada que inyectar
  }
}

// Perfil del proyecto ACTUAL (ULTRON 4 F1.4 / G9, 2026-09-03): "de que iba este
// proyecto" respondido completo. Lo mantiene el hook SessionEnd project-profile
// en cockpit/projects/<p>/profile.json (que es, stack, arquitectura, estado,
// decisiones clave; fuente llm o deterministic). Sustituye a la captura
// kind=context (context.md), que acumulaba frases sueltas y contaminacion de
// otros proyectos sin responder nunca que era el proyecto. Bounded + fail-safe.
const PROJECTS_DIR = path.join(os.homedir(), '.ultron', 'cockpit', 'projects');
const PROFILE_FIELD_MAX_CHARS = 420;
const PROFILE_MAX_DECISIONS = 5;

function readProjectProfile(projectId) {
  if (!projectId) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, projectId, 'profile.json'), 'utf8'));
    if (!doc || typeof doc !== 'object' || !doc.profile || typeof doc.profile.que_es !== 'string') return null;
    return doc;
  } catch {
    return null; // sin profile.json / ilegible -> nada que inyectar (fail-safe)
  }
}

function clipField(s) {
  const plano = String(s || '').replace(/\s+/g, ' ').trim();
  return plano.length > PROFILE_FIELD_MAX_CHARS ? plano.slice(0, PROFILE_FIELD_MAX_CHARS - 1) + '…' : plano;
}

// Lineas del bloque project_profile. Declara procedencia (fuente, fecha, HEAD) y
// avisa si el perfil es de un HEAD anterior al actual: el "estado" puede haber
// cambiado (mandamiento 13: declarar el alcance real). Las metricas memorizadas
// se filtran igual que en las decisiones.
function renderProfileLines(doc, currentHeadSha) {
  if (!doc) return [];
  const p = doc.profile;
  if (!p || !String(p.que_es || '').trim()) return [];
  const fecha = String(doc.generated_at || '').slice(0, 10) || '?';
  const fuente = doc.source === 'llm' ? 'llm' : 'deterministic';
  const sha = doc.head && doc.head.sha ? doc.head.sha : null;
  const stale = sha && currentHeadSha && sha !== currentHeadSha;
  const cab = [`project_profile (perfil del proyecto, generado ${fecha} por ${fuente}${sha ? `, head ${sha}` : ''})${stale ? ' -- de un HEAD anterior: el estado puede haber cambiado' : ''}:`];
  const out = [];
  for (const [k, v] of [['que_es', p.que_es], ['stack', p.stack], ['arquitectura', p.arquitectura], ['estado', p.estado]]) {
    const t = clipField(v);
    if (t && !isStaleMetricLine(t)) out.push(`  ${k}: ${t}`);
  }
  const decisiones = (Array.isArray(p.decisiones_clave) ? p.decisiones_clave : [])
    .map(clipField)
    .filter((d) => d && !isStaleMetricLine(d) && !isTrivialDecision(d))
    .slice(0, PROFILE_MAX_DECISIONS);
  if (decisiones.length) {
    out.push('  decisiones_clave:');
    for (const d of decisiones) out.push(`    - ${d}`);
  }
  return out.length ? cab.concat(out) : [];
}

// (2026-08-10) Gate de claims numericos: la memoria acumula metricas viejas sin
// fecha ("ULTRON is a project at 9.73/10 score" — superseded desde 06-25) y el
// resume las inyectaba como verdad. Las cifras de calidad VIVAS ya viajan en
// harnessNote (con gate de frescura 48h); una metrica memorizada sin fecha es
// peor que ninguna -> fuera de la inyeccion.
const STALE_METRIC_RES = [
  /\b\d+(?:[.,]\d+)?\s*\/\s*10\b/, // "9.73/10", "8 / 10"
  /\brecall@?\d*\s*[=:]?\s*[01][.,]\d+/i, // "recall@8=0.823"
  /\bnota\s+(?:de\s+)?\d+(?:[.,]\d+)?\b/i, // "nota 9.31"
  /\bscore\b.*\b\d/i, // "... score 9.73" / "at X score"
];

function isStaleMetricLine(line) {
  return STALE_METRIC_RES.some((re) => re.test(String(line)));
}

// (2026-08-10) Decision TRIVIAL = higiene generica de herramientas o dominio
// ajeno al proyecto; no merece un slot de los 5 del resume. Patrones acotados a
// lo observado en el corpus (audit 08-09) — el filtro de raiz vive en la captura.
const TRIVIAL_DECISION_RES = [
  // Higiene generica de tooling presentada como "decision".
  /\bcargo\s+(fmt|test|clippy)\b/i,
  /\bclippy\b/i,
  /\.gitignore\b/i,
  /\bgit\b[^.]*\bcontrol de versiones\b/i,
  /\bpruebas?\s+automatizadas?\b[^.]*\b(calidad|estabilidad)\b/i,
  // Dominio ajeno: precios/planes de otros proyectos (plan Tienda).
  /\d+\s*(?:€|eur(?:os)?\b)/i,
  /\bplan\s+["']?tienda\b/i,
];

function isTrivialDecision(summary) {
  const s = String(summary || '').trim();
  if (!s) return true; // sin texto no hay decision que mostrar
  return TRIVIAL_DECISION_RES.some((re) => re.test(s));
}

// Nota VIVA del medidor (audit 2026-06-25): el resume arrastraba una nota
// MEMORIZADA (p.ej. "9.31") que el harness en vivo desmentia (7.95). Inyectamos
// la cifra fresca de logs/kirkardo-eval.json para que el modelo no crea el numero
// viejo. Gate de frescura (<48h) + fail-safe (mand. 12: tener el dato != usarlo).
const HARNESS_JSON = path.join(os.homedir(), '.ultron', 'logs', 'kirkardo-eval.json');
const HARNESS_MAX_AGE_MS = 48 * 60 * 60 * 1000;

function readHarnessNote(jsonPath = HARNESS_JSON) {
  try {
    const st = fs.statSync(jsonPath);
    if (Date.now() - st.mtimeMs > HARNESS_MAX_AGE_MS) return ''; // stale -> no inyectar nota vieja
    const d = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    // 0.4: un run scoped (--cat=N) NO refleja la salud del sistema; no inyectar su nota
    // (el "10" del 06-25 era un run cat19 sobre el canonico).
    if (d.scoped === true) return '';
    if (typeof d.overall !== 'number' && typeof d.overall_core !== 'number') return '';
    const r2 = (n) => Math.round(n * 100) / 100;
    const lag = (Array.isArray(d.laggards) ? d.laggards : [])
      .slice(0, 4)
      .map((l) => `cat${l.cat}=${Math.round(l.nota * 10) / 10}`)
      .join(', ');
    // Metrica de salud HONESTA: all_cats_pass + laggards primero (el GOAL exige >=9.5 en
    // TODAS), luego core (cats 1-14) y overall. NO liderar con overall (diluido).
    const pass = d.all_cats_pass === true ? 'PASS' : 'FAIL';
    const nums = [
      typeof d.overall_core === 'number' ? `core ${r2(d.overall_core)}` : null,
      typeof d.overall === 'number' ? `overall ${r2(d.overall)}` : null,
    ].filter(Boolean).join(' ');
    return (
      `harness (medidor honesto, logs/kirkardo-eval.json): all_cats_pass=${pass}` +
      (nums ? ` | ${nums}` : '') +
      (lag ? ` | laggards: ${lag}` : '') +
      ' -- nota VIVA de run COMPLETO; ignora cifras memorizadas distintas.'
    );
  } catch {
    return '';
  }
}

// HEAD real precomputado (audit 2026-06-25): el resume no reflejaba branch/sha,
// asi que el modelo no podia cazar discrepancias y hacia arqueologia git al
// arrancar. Lo calculamos UNA vez aqui (3 git baratos) para que el modelo NO los
// repita. Fail-safe + timeout corto.
function readHead(cwd) {
  try {
    const o = { cwd, encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] };
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], o).trim();
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], o).trim();
    const subject = execFileSync('git', ['log', '-1', '--pretty=%s'], o).trim();
    if (!branch || !sha) return '';
    return `${branch} @ ${sha} -- ${subject}`;
  } catch {
    return '';
  }
}

const SUMMARIZE_SCRIPT = path.join(__dirname, 'session-summarize-previous.js');

/**
 * Lanza session-summarize-previous.js totalmente desacoplado: SessionStart no
 * puede esperar los 20-40s que tarda `claude -p`. Mismo patron que
 * spawnDetached() de lib/ultron-memory-cli.js (stderr a fichero, unref, fd
 * cerrado justo despues del spawn -- el hijo ya tiene su copia del handle).
 * Fail-safe: cualquier error se traga, el resume sigue igual sin el resumidor.
 */
function launchSessionSummarizer(cwd, sessionId) {
  let fd = null;
  try {
    const dir = path.join(os.homedir(), '.ultron', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fd = fs.openSync(path.join(dir, 'session-summary.stderr.log'), 'a');
    const child = spawn(
      process.execPath,
      [SUMMARIZE_SCRIPT, '--cwd', cwd, '--session', sessionId],
      { detached: true, stdio: ['ignore', 'ignore', fd], windowsHide: true }
    );
    child.on('error', () => { /* best effort */ });
    child.unref();
  } catch {
    /* fail-safe: el resume sigue igual sin el resumidor */
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* el hijo ya tiene su copia del handle */ }
    }
  }
}

/**
 * Bloque `last_session` (2026-09-11): el resumen de la sesion ANTERIOR del
 * proyecto (fichero por sesion, nunca brain.db -- decision del usuario). Si
 * ya existe se inyecta entero (acotado); si HAY UNA CANDIDATA BARATA (stat/
 * mtime, revision de codigo 2026-09-11: SessionStart NUNCA lee contenido de
 * transcripts -- eso vive en selectPreviousSession(), dentro del proceso
 * desacoplado) se lanza el resumidor en segundo plano (claude -p, ~20-40s) y
 * se avisa de que llegara en el primer prompt (memory-orchestrate.js lo
 * entrega alli si SessionStart no llego a tiempo -- ver
 * lib/session-summary-delivery.js). Fail-safe: cualquier error deja el resume
 * sin este bloque, nunca lo rompe.
 */
function computeLastSessionLines({ cwd, sessionId, transcriptPath, project }) {
  const out = [];
  try {
    const summary = lastSession.latestSummary(project, sessionId);
    if (summary) out.push(...lastSession.renderLastSessionLines(summary));
    if (!project || !sessionId) return out;
    const transcriptsDir = sessionSummarizer.transcriptsDirFor(cwd, transcriptPath);
    const cheapCandidate = sessionSummarizer.hasCheapPendingCandidate({ transcriptsDir, currentSessionId: sessionId, projectId: project });
    if (cheapCandidate) {
      sessionSummaryDelivery.writePending(sessionId);
      launchSessionSummarizer(cwd, sessionId);
      out.push(
        'last_session_pending: hay una sesion anterior sin resumir todavia -- se esta generando en segundo plano (claude -p) y llegara inyectada en el primer prompt de esta sesion.'
      );
    }
  } catch {
    /* fail-safe: el resume sigue sin el bloque last_session */
  }
  return out;
}

function render(r, profileDoc, opts = {}) {
  const out = ['<ultron-memory-resume source="system" trust="system">'];
  // Directiva de arranque (audit 2026-06-25): inyectabamos datos sin NINGUNA
  // instruccion -> el modelo quemaba tokens en arqueologia git y devolvia menus.
  out.push(
    'startup_policy: FIATE de este resume; NO ejecutes git diff/log/status para reconstruir estado salvo que sea insuficiente. EJECUTA el next_action de abajo como orden; ante ambiguedad propon UNA accion y pregunta, NO un menu.'
  );
  // cat9.3 (mand.11): si el sidecar de recall fallo, DECLARA la degradacion en vez
  // de emitir un resume que parece normal. El bloque sigue siendo util (head/nota/
  // contexto son fuentes independientes del sidecar), pero el fallo queda visible.
  if (opts.degraded) {
    out.push(
      'sidecar_status: DEGRADED -- el recall de memoria fallo (binario ultron-memory ausente/roto); este resume trae solo head/nota/contexto, NO memorias del sidecar. Rastro en hook-errors.jsonl.'
    );
  }
  if (opts.head) out.push(`head: ${opts.head}`);
  if (opts.harnessNote) out.push(opts.harnessNote);
  r = r || {};
  if (r.project_id) out.push(`project: ${r.project_id}`);
  if (Array.isArray(r.active_workflows) && r.active_workflows.length) {
    out.push(`active_workflows: ${r.active_workflows.map((w) => w.workflow_id).join(', ')}`);
  }
  if (Array.isArray(r.open_tasks) && r.open_tasks.length) {
    out.push('open_tasks:');
    for (const t of r.open_tasks.slice(0, 8)) out.push(`  - ${t.summary || ''}`);
  }
  // (2026-08-10) Filtro de decisiones TRIVIALES en el punto de inyeccion: la
  // captura automatica cuela higiene generica de herramientas ("se utiliza
  // cargo fmt para...", "usar git para control de versiones") y dominio ajeno
  // (precios "40 EUR/mes" del plan Tienda) como si fueran decisiones del
  // proyecto. El fix de raiz va en la captura (card en kanban); esta es la
  // defensa del resume — misma politica que el dedupe de context.
  if (Array.isArray(r.decisions) && r.decisions.length) {
    const meaningful = r.decisions.filter((d) => !isTrivialDecision(d.summary || ''));
    if (meaningful.length) {
      out.push('recent_decisions:');
      for (const d of meaningful.slice(0, 5)) out.push(`  - ${d.summary || ''}`);
    }
  }
  if (Array.isArray(r.pinned) && r.pinned.length) {
    out.push('pinned_memories:');
    for (const p of r.pinned.slice(0, 8)) out.push(`  - ${p.summary || ''}`);
  }
  // next_action como ORDEN, no etiqueta (audit 2026-06-25): renderizarlo como
  // dato suelto hacia que el modelo lo ignorara y devolviera un menu.
  if (r.next_action) {
    out.push(`next_action: ${r.next_action}`);
  } else if (opts.harnessNote) {
    out.push('next_action: (sin tarea fijada) -- propon a partir de los laggards del harness (arriba), NO arqueologia git.');
  }
  if (Array.isArray(r.warnings) && r.warnings.length) out.push(`warnings: ${r.warnings.join('; ')}`);
  for (const line of renderProfileLines(profileDoc, opts.headSha)) out.push(line);
  // Metrica externa (12.1): pregunta pendiente para este proyecto y % de 'si'.
  for (const line of (Array.isArray(opts.feedbackLines) ? opts.feedbackLines : [])) out.push(line);
  // Medidor de concision (4.2/7.3): una linea, solo con datos.
  if (opts.meterLine) out.push(opts.meterLine);
  // CodeGraph (8.1, pilar 2): tamano, zonas y hubs del indice, con la orden de consultarlo.
  for (const line of (Array.isArray(opts.codegraphLines) ? opts.codegraphLines : [])) out.push(line);
  // F-resume: resumen de la sesion anterior (si ya existe) y/o aviso de que
  // esta generandose en segundo plano y llegara en el primer prompt.
  for (const line of (Array.isArray(opts.lastSessionLines) ? opts.lastSessionLines : [])) out.push(line);
  out.push('</ultron-memory-resume>');
  return out.join('\n');
}

function main() {
  let cwd = process.cwd();
  let sessionId = null;
  let transcriptPath = null;
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const inp = JSON.parse(raw || '{}');
    if (inp.cwd) cwd = inp.cwd;
    sessionId = inp.session_id || inp.sessionId || null;
    transcriptPath = inp.transcript_path || inp.transcriptPath || null;
  } catch {
    /* no stdin / bad json — use process cwd */
  }
  const project = projectIdFromCwd(cwd);
  const resume = runCli(
    project ? ['resume', '--project', project] : ['resume'],
    { timeoutMs: 11000 } // colchon para cold-hit E5 post-warmup; bajar a 3000 con daemon serve
  );
  // cat9.3 (mandamiento 11: prohibido el no-op silencioso). runCli devuelve null
  // SOLO ante FALLO real del sidecar (binario ausente/no ejecutable, status!=0,
  // timeout, JSON corrupto), NUNCA por "proyecto sin memoria" (el binario sano
  // responde un objeto JSON aunque vacio). Asi que resume===null == fallo real ->
  // deja rastro accionable en hook-errors.jsonl ADEMAS del fail-safe (no inunda:
  // el vacio legitimo es un objeto, no null).
  if (resume === null) {
    const reason = findBinary()
      ? 'sidecar resume FALLO (binario presente pero status!=0 / timeout / JSON no parseable)'
      : 'sidecar resume FALLO (binario ultron-memory ausente: no instalado / ULTRON_MEMORY_BIN invalido)';
    logHookError('memory-session-resume', reason);
  }
  // cat17.2: inyecta tambien el scratch L0 preservado en la ultima compactacion
  // (aunque no haya resume del sidecar).
  const l0 = readL0Scratch(project);
  // Perfil del proyecto actual (independiente del sidecar: se inyecta aunque
  // el resume Rust falle).
  const profileDoc = readProjectProfile(project);
  const harnessNote = readHarnessNote();
  const head = readHead(cwd);
  // ULTRON 4 12.1: pregunta de feedback pendiente + cifra global (fail-safe).
  let feedbackLines = [];
  try { feedbackLines = renderFeedbackLines(project); } catch { /* sin feedback */ }
  let meterLine = '';
  try { meterLine = renderMeterLine(); } catch { /* sin medidor */ }
  let codegraphLines = [];
  try { codegraphLines = codegraphSummary.renderLines(codegraphSummary.summarize(cwd)); } catch { /* sin indice */ }
  const lastSessionLines = computeLastSessionLines({ cwd, sessionId, transcriptPath, project });
  if (!resume && !profileDoc && !harnessNote && !head && !feedbackLines.length && !codegraphLines.length && !lastSessionLines.length) {
    emit(l0);
    return;
  }
  const headSha = (head.match(/@ ([0-9a-f]+) --/) || [])[1] || null;
  emit(render(resume, profileDoc, { harnessNote, head, headSha, degraded: resume === null, feedbackLines, meterLine, codegraphLines, lastSessionLines }) + l0);
}

// Exporta readL0Scratch para tests. El bloque main() solo corre cuando el script
// se invoca directamente (como hook), nunca cuando se importa via require().
if (require.main === module) {
  try {
    main();
  } catch (e) {
    logHookError('memory-session-resume', e);
    try { emit(''); } catch { /* ignore */ }
  }
  process.exitCode = 0;
} else {
  module.exports = { readL0Scratch, readProjectProfile, renderProfileLines, render, readHarnessNote, readHead, isStaleMetricLine, isTrivialDecision, HARNESS_JSON, L0_SCRATCH, L0_MAX_AGE_MS, L0_MAX_CHARS };
}
