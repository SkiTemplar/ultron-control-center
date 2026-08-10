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
const { execFileSync } = require('child_process');
const { runCli, projectIdFromCwd, findBinary, spawnDetached } = require('./lib/ultron-memory-cli');
const { observe, logHookError } = require('./lib/hook-obs');
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

// Contexto del proyecto ACTUAL (peticion 2026-06-22: NO un overview de todos los
// proyectos al arrancar, sino que el sistema sepa de ESTE proyecto cuando se
// trabaja en el). El Stop hook (stop-compress) acumula en
// cockpit/projects/<p>/context.md "que es este proyecto y en que se trabaja";
// aqui inyectamos SOLO el del proyecto actual. Bounded + fail-safe.
const PROJECTS_DIR = path.join(os.homedir(), '.ultron', 'cockpit', 'projects');
const CONTEXT_MAX_CHARS = 1200;

function readProjectContext(projectId) {
  if (!projectId) return '';
  try {
    const raw = fs.readFileSync(path.join(PROJECTS_DIR, projectId, 'context.md'), 'utf8').trim();
    if (!raw) return '';
    return raw.length > CONTEXT_MAX_CHARS ? raw.slice(0, CONTEXT_MAX_CHARS) + '\n[...]' : raw;
  } catch {
    return ''; // sin context.md / ilegible -> nada que inyectar (fail-safe)
  }
}

// Dedupe + cap de las lineas de project_context. El Stop hook acumula en
// context.md frases casi identicas ("ULTRON es Rust+Tauri" x6); inyectarlas todas
// es ruido. Defensa en el punto de inyeccion (la captura duplicada se trata aparte).
const CONTEXT_MAX_LINES = 6;
const JACCARD_DUP = 0.5;

// (2026-08-10, audit 08-09) Dedupe MULTILINGUE: el corpus mezcla ES/EN y los
// gemelos cruzados sobrevivian al Jaccard puro ("ULTRON es un sistema personal"
// + "ULTRON is a personal AI OS" + "ULTRON es un proyecto de AI" = 3 lineas).
// Canon minimo ES->EN de los tokens que de verdad aparecen en context.md; no es
// un traductor, es un normalizador de vocabulario para comparar conjuntos.
const ES_EN_CANON = {
  es: 'is', son: 'are', un: 'a', una: 'a', el: 'the', la: 'the', los: 'the', las: 'the',
  de: 'of', del: 'of', y: 'and', con: 'with', para: 'for', en: 'in',
  sistema: 'system', proyecto: 'project', ia: 'ai', memoria: 'memory',
  pruebas: 'tests', codigo: 'code',
};
// Palabras funcion (ya canonizadas a EN) que no aportan contenido al dedupe.
const CTX_STOPWORDS = new Set(['is', 'are', 'a', 'the', 'of', 'and', 'with', 'for', 'in', 'at']);

function normCtx(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // sin tildes: "ejecución" == "ejecucion"
    .replace(/[`*#_~]/g, '')
    .replace(/[/,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Tokens de CONTENIDO canonizados (ES->EN, sin stopwords) para comparar lineas.
function contentTokens(s) {
  return new Set(
    normCtx(s)
      .split(' ')
      .filter(Boolean)
      .map((t) => ES_EN_CANON[t] || t)
      .filter((t) => !CTX_STOPWORDS.has(t))
  );
}

function jaccardCtx(a, b) {
  const A = contentTokens(a);
  const B = contentTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  // Lineas cortas (<=5 tokens de contenido): coeficiente de solapamiento
  // (inter/min) — con conjuntos pequenos el Jaccard castiga una sola palabra
  // distinta y los gemelos ES/EN no colapsaban jamas.
  const minSize = Math.min(A.size, B.size);
  if (minSize <= 5) return inter / minSize;
  return inter / (A.size + B.size - inter);
}

// (2026-08-10) Gate de claims numericos: context.md acumula metricas viejas sin
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

// Lineas unicas (sin near-duplicados ni metricas memorizadas), capadas a maxLines.
function dedupeContextLines(text, maxLines = CONTEXT_MAX_LINES) {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
    .filter((l) => !isStaleMetricLine(l));
  const kept = [];
  for (const line of lines) {
    if (kept.some((k) => normCtx(k) === normCtx(line) || jaccardCtx(k, line) > JACCARD_DUP)) continue;
    kept.push(line);
    if (kept.length >= maxLines) break;
  }
  return kept;
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

function render(r, projectContext, opts = {}) {
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
  if (projectContext) {
    const ctxLines = dedupeContextLines(projectContext);
    if (ctxLines.length) {
      out.push('project_context (que es este proyecto / en que andas — captura automatica):');
      for (const line of ctxLines) out.push(`  - ${line}`);
    }
  }
  out.push('</ultron-memory-resume>');
  return out.join('\n');
}

function main() {
  let cwd = process.cwd();
  try {
    const raw = fs.readFileSync(0, 'utf8');
    const inp = JSON.parse(raw || '{}');
    if (inp.cwd) cwd = inp.cwd;
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
  // Contexto del proyecto actual (independiente del sidecar: se inyecta aunque
  // el resume Rust falle).
  const projectContext = readProjectContext(project);
  const harnessNote = readHarnessNote();
  const head = readHead(cwd);
  if (!resume && !projectContext && !harnessNote && !head) {
    emit(l0);
    return;
  }
  emit(render(resume, projectContext, { harnessNote, head, degraded: resume === null }) + l0);
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
  module.exports = { readL0Scratch, readProjectContext, render, dedupeContextLines, readHarnessNote, readHead, isStaleMetricLine, isTrivialDecision, jaccardCtx, HARNESS_JSON, L0_SCRATCH, L0_MAX_AGE_MS, L0_MAX_CHARS };
}
