#!/usr/bin/env node
/**
 * UserPromptSubmit hook → suggest a skill/persona based on the user prompt.
 *
 * Reads JSON from stdin (Claude Code UserPromptSubmit hook contract):
 *   { session_id, prompt, hook_event_name, ... }
 *
 * Matches `prompt` against two routing tables sourced from
 * ~/.claude/skills/ultron/references/routing-tables.md:
 *   - Layer 1: 14 personas (terry-davis, don-claudio, mike-tyson, ...)
 *   - Layer 2: ~50 plugin skills
 *
 * Confidence model (deterministic, no LLM):
 *   - score = sum(weight per matched signal)
 *     - explicit-trigger word ("terry", "don claudio", "mike tyson", ...): 100
 *     - strong domain token (UE5, Unreal, shader, RLS, GAS, ...): 60
 *     - generic context token (UI, código, deploy, ...): 25
 *   - confidence = clamp(score / 100, 0, 1)
 *   - ≥0.80 → emit a single "Suggested skill" hint
 *   - 0.50–0.79 → emit two top candidates
 *   - <0.50 → silent (no additionalContext)
 *
 * Output (per Claude Code UserPromptSubmit hook contract):
 *   {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
 *                           "additionalContext": "<hint>"}}
 *
 * Failure mode: any error → silent (no additionalContext). NEVER blocks.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'routing-dispatcher.jsonl');
const MAX_PROMPT_CHARS = 4000;
const HIGH_THRESHOLD = 0.80;
const MED_THRESHOLD = 0.50;

// Weights
const W_TRIGGER = 100;
const W_STRONG = 60;
const W_CONTEXT = 25;

/**
 * Persona signals (Layer 1).
 * Each entry: { id, persona, triggers, strong, context }
 *   triggers: exact-match invocations (case-insensitive substring with word boundary)
 *   strong:   high-signal domain tokens
 *   context:  weak / shared tokens
 */
const PERSONAS = [
  {
    id: 'terry-davis',
    persona: 'terry-davis',
    triggers: ['terry', 'terry davis', 'modo terry', 'activa a terry'],
    strong: ['debuggear', 'refactorizar', 'arquitectura de software', 'incident'],
    context: ['código', 'bug', 'commit', 'deploy', 'refactor', 'testing', '.cpp', '.cs', '.ts', '.py', '.rs', '.go'],
  },
  {
    id: 'don-claudio',
    persona: 'don-claudio',
    triggers: ['don claudio', 'don', 'activa al don', 'modo don'],
    strong: ['ue5', 'unreal', 'unreal engine', 'blueprint', 'gas', 'enhanced input', 'netcode', 'rollback', 'lag compensation', 'metasounds', 'nanite', 'lumen', 'chaos physics', 'ecs', 'dots'],
    context: ['unity', 'shader', 'game', 'multijugador', 'matchmaking', 'PROGRAM_A', 'PROGRAM_B', 'gameplay'],
  },
  {
    id: 'mike-tyson',
    persona: 'mike-tyson',
    triggers: ['mike', 'mike tyson', 'modo mike', 'activa a mike'],
    strong: ['ux', 'design system', 'wireframe', 'design tokens', 'jerarquía visual', 'accesibilidad'],
    context: ['ui', 'diseño', 'color', 'layout', 'tipografía', 'paleta', 'landing', 'componente', 'responsive', 'dark mode'],
  },
  {
    id: 'jordan-belfort',
    persona: 'jordan-belfort',
    triggers: ['jordan', 'jordan belfort', 'modo jordan'],
    strong: ['monetizar', 'pricing', 'pitch', 'gtm', 'go-to-market', 'modelo de negocio', 'proyecciones de ingresos'],
    context: ['negocio', 'clientes', 'ventas', 'b2b', 'inversores', 'competidores', 'nicho'],
  },
  {
    id: 'einstein',
    persona: 'einstein',
    triggers: ['einstein', 'modo einstein'],
    strong: ['paper', 'literature review', 'state of the art', 'investigación científica'],
    context: ['investiga', 'explica', 'ciencia', 'teoría', 'concepto', 'por qué'],
  },
  {
    id: 'pana',
    persona: 'pana',
    triggers: ['pana', 'modo pana', 'modo mañana', 'cierra el día'],
    strong: ['briefing', 'blackboard', 'agenda del día'],
    context: ['email', 'agenda', 'notion', 'spotify', 'organización personal', 'calendar'],
  },
  {
    id: 'profesor-fisica',
    persona: 'profesor-fisica',
    triggers: ['profesor de física', 'profesor fisica', 'modo física'],
    strong: ['cinemática', 'sólido rígido', 'examen física', 'momento angular', 'tensor de inercia'],
    context: ['física', 'dinámica', 'colisiones', 'mecánica', 'energía'],
  },
  {
    id: 'tio-gilito',
    persona: 'tio-gilito',
    triggers: ['tío gilito', 'tio gilito', 'gilito'],
    strong: ['kutxabank', 'fondos de ahorro', 'límites de gasto', 'saldo actual', 'añade un gasto', 'añade un ingreso', 'reglas de ahorro'],
    context: ['gasto', 'ahorro', 'presupuesto', 'banco', 'finanzas personales', 'saldo', 'mis ahorros'],
  },
  {
    id: 'warren',
    persona: 'warren',
    triggers: ['warren'],
    strong: ['análisis fundamental', 'etf', 'cartera de inversión', 'dividendos', 'sector financiero', 'macro económico'],
    context: ['bolsa', 'inversión', 'cartera', 'acciones', 'mercado', '¿compro'],
  },
  {
    id: 'repo-evaluator',
    persona: 'repo-evaluator',
    triggers: ['kirkardo', 'corrigeme el t', 'ponme nota', 'evalua mi código', 'gradeame'],
    strong: ['evalúa', 'corrige como profesor', 'revisa mi entrega'],
    context: ['corrige', 'nota', 'entrega', 'repo'],
  },
  {
    id: 'alfred',
    persona: 'alfred',
    triggers: ['alfred', 'modo alfred'],
    strong: ['matar proceso', 'kill process', 'registro de windows', 'schtasks', 'tareas programadas'],
    context: ['proceso', 'powershell', 'driver', 'carpeta local', 'windows', 'sistema operativo', 'archivo', 'capturas de pantalla'],
  },
  {
    id: 'manolo-lama',
    persona: 'manolo-lama',
    triggers: ['manolo lama', 'manolo-lama'],
    strong: ['champions league', 'la liga', 'partido de fútbol'],
    context: ['fútbol', 'gol', 'champions', 'liga', 'deportes'],
  },
  {
    id: 'tolkien',
    persona: 'tolkien',
    triggers: ['tolkien', 'modo escritor', 'modo tolkien', 'escribe el libro', 'siguiente capítulo'],
    strong: ['plot hole', 'arco narrativo', 'imperio de los once grandes'],
    context: ['capítulo', 'escena', 'personaje', 'plot', 'libro', 'narrativa'],
  },
  {
    id: 'novalbos',
    persona: 'novalbos',
    triggers: ['novalbos', 'modo aprendizaje', '/learn'],
    strong: ['vulkan', 'dx12', 'cuda', 'simd', 'backprop', 'transformer', 'apuntes para notebooklm', 'apuntes de notion'],
    context: ['shader', 'opengl', 'red neuronal', 'bajo nivel', 'asm', 'compilador', 'memoria', 'concurrencia', 'gpu pipeline'],
  },
];

/**
 * Layer 2 plugin skills.
 * Subset of routing-tables.md most likely to trigger from natural prompts.
 */
const PLUGINS = [
  {
    id: 'pr-review-toolkit:code-reviewer',
    triggers: ['code review', 'review pr', 'revisa el pr'],
    strong: ['auditoría de código', 'pull request review'],
    context: ['code review', 'revisión de código'],
  },
  {
    id: 'superpowers:systematic-debugging',
    triggers: ['systematic debugging'],
    strong: ['bug sin causa obvia', 'no encuentro el bug', 'debug sistemático'],
    context: ['bug intermitente', 'debugging'],
  },
  {
    id: 'superpowers:test-driven-development',
    triggers: ['tdd', 'test-driven development'],
    strong: ['escribe los tests primero', 'red green refactor'],
    context: ['testing', 'pruebas unitarias', 'cobertura de tests'],
  },
  {
    id: 'feature-dev:feature-dev',
    triggers: ['feature dev'],
    strong: ['arquitectura de feature', 'diseño técnico de feature'],
    context: ['nueva feature', 'diseño técnico'],
  },
  {
    id: 'frontend-design',
    triggers: ['frontend design'],
    strong: ['glassmorphism', 'brutalist', 'minimalist ui'],
    context: ['componentes ui', 'estilos visuales', 'frontend'],
  },
  {
    id: 'mcp-builder',
    triggers: ['mcp builder', 'crear mcp', 'crear servidor mcp'],
    strong: ['mcp server', 'servidor mcp'],
    context: ['model context protocol', 'tool registration'],
  },
  {
    id: 'skill-creator:skill-creator',
    triggers: ['crear skill', 'skill creator'],
    strong: ['mejorar skill', 'editar skill', 'nueva skill'],
    context: ['skill md', 'frontmatter de skill'],
  },
  {
    id: 'ecc:hookify',
    triggers: ['hookify', 'crea un hook'],
    strong: ['settings.json hooks', 'pretooluse', 'posttooluse', 'userpromptsubmit hook'],
    context: ['hooks', 'automatizaciones'],
  },
  {
    id: 'focused-fix',
    triggers: ['focused fix', 'haz que funcione'],
    strong: ['feature rota', 'módulo con fallos en cascada'],
    context: ['reparar feature', 'fix de módulo'],
  },
  {
    id: 'database-migrations',
    triggers: ['database migrations', 'db migration'],
    strong: ['zero-downtime migration', 'alter table', 'expand-contract', 'prisma migrate', 'alembic'],
    context: ['schema', 'rls', 'migración de db'],
  },
  {
    id: 'security-scan',
    triggers: ['security scan', 'security review'],
    strong: ['cve', 'sast', 'static analysis', 'owasp'],
    context: ['vulnerabilidades', 'auditoría seguridad'],
  },
  {
    id: 'second-opinion',
    triggers: ['second opinion', 'codex review', 'gemini review', '/second-opinion'],
    strong: ['external review', 'segunda opinión'],
    context: ['codex', 'gemini'],
  },
  {
    id: 'webapp-testing',
    triggers: ['playwright', 'webapp testing', 'e2e'],
    strong: ['test web app local', 'browser snapshot'],
    context: ['e2e', 'browser testing', 'ui testing'],
  },
  {
    id: 'git-conflict-resolver',
    triggers: ['git conflict', 'merge conflict', 'git bisect', 'interactive rebase'],
    strong: ['cherry-pick', 'core.autocrlf', 'git rerere'],
    context: ['conflicto de merge', 'rebase'],
  },
  {
    id: 'docker-patterns',
    triggers: ['docker', 'dockerfile', 'docker-compose'],
    strong: ['multi-stage build', 'docker compose'],
    context: ['contenedores', 'dockerfile'],
  },
  {
    id: 'consolidate-memory',
    triggers: ['consolida memoria', 'ordena .ultron', 'limpia el index', 'fusiona memorias'],
    strong: ['memory consolidation', 'memory.md'],
    context: ['memoria', 'index'],
  },
  {
    id: 'cpp-coding-standards',
    triggers: ['cpp coding standards', 'c++ standards'],
    strong: ['raii', 'cppcoreguidelines'],
    context: ['c++', 'cpp'],
  },
  {
    id: 'rust-patterns',
    triggers: ['rust patterns'],
    strong: ['borrow checker', 'lifetimes', 'tokio'],
    context: ['rust'],
  },
  {
    id: 'python-patterns',
    triggers: ['python patterns'],
    strong: ['async def', 'pydantic v2', 'sqlalchemy 2.0'],
    context: ['python'],
  },
  {
    id: 'shader-fundamentals',
    triggers: ['shader fundamentals'],
    strong: ['fragment shader', 'vertex shader', 'glsl', 'hlsl', 'metal shading language'],
    context: ['shader', 'rendering pipeline'],
  },
  {
    id: 'agent-architecture-audit',
    triggers: ['agent architecture audit', 'audita el agente'],
    strong: ['wrapper regression', 'memory pollution', '12-layer agent stack'],
    context: ['agent stack', 'autonomous loops'],
  },
  {
    id: 'autonomous-loops',
    triggers: ['autonomous loops', 'loop autónomo'],
    strong: ['rfc-driven multi-agent dag', 'sequential pipelines'],
    context: ['orquestación', 'multi-agent'],
  },
  {
    id: 'pdf',
    triggers: ['pdf', 'archivo pdf'],
    strong: ['merge pdf', 'split pdf', 'ocr pdf', 'fill pdf form'],
    context: ['pdf', '.pdf'],
  },
  {
    id: 'generate-image',
    triggers: ['generate image', 'genera una imagen'],
    strong: ['stable diffusion', 'image generation'],
    context: ['imagen', 'image'],
  },
  {
    id: 'commit-commands:commit',
    triggers: ['commit', 'git commit'],
    strong: ['conventional commits', 'commit message'],
    context: ['commit'],
  },
];

/**
 * Layer 3 — technical specialist AGENTS (fullize 2026-06-01).
 * These map a clear technical domain to the SPECIALIST agent on disk
 * (~/.claude/agents/) so ULTRON delegates to the right brain instead of a
 * general-purpose agent. Domain tokens are `strong` so a precise tech match
 * (e.g. "tokio async rust") outranks a generic persona context token.
 */
const AGENTS = [
  { id: 'rust-engineer', triggers: ['rust-engineer'], strong: ['rust', 'cargo', 'tokio', 'borrow checker', 'lifetimes', 'async rust', 'rustc', 'tauri backend'], context: ['memory safety', 'systems programming', '.rs'] },
  { id: 'typescript-pro', triggers: ['typescript-pro'], strong: ['typescript', 'tsconfig', 'type-level', 'discriminated union', 'generics avanzados'], context: ['node', '.ts', '.tsx', 'tipos'] },
  { id: 'python-pro', triggers: ['python-pro'], strong: ['pydantic', 'asyncio', 'type hints', 'mypy'], context: ['python', 'pytest', 'uv'] },
  { id: 'react-specialist', triggers: ['react-specialist'], strong: ['react 18', 'usememo', 'usecallback', 're-render', 'suspense', 'react server components'], context: ['react', 'componente', 'jsx'] },
  { id: 'nextjs-developer', triggers: ['nextjs-developer'], strong: ['next.js', 'app router', 'server actions', 'rsc'], context: ['vercel', 'ssr', 'core web vitals'] },
  { id: 'cpp-pro', triggers: ['cpp-pro'], strong: ['raii', 'move semantics', 'c++20', 'c++23', 'templates', 'cmake'], context: ['c++', 'cpp', '.cpp', '.hpp'] },
  { id: 'golang-pro', triggers: ['golang-pro'], strong: ['goroutine', 'go channels', 'golang'], context: ['microservice', 'concurrency', '.go'] },
  { id: 'security-auditor', triggers: ['security-auditor'], strong: ['owasp', 'auth bypass', 'sql injection', 'threat model', 'secrets leak', 'cve', 'xss', 'csrf'], context: ['security', 'auth', 'payments', 'user input', 'seguridad'] },
  { id: 'debugger', triggers: ['debugger'], strong: ['stack trace', 'root cause', 'test failure', 'segfault', 'panic'], context: ['bug', 'error', 'no funciona', 'crash'] },
  { id: 'performance-engineer', triggers: ['performance-engineer'], strong: ['bottleneck', 'profiling', 'n+1 query', 'memory leak', 'hot path'], context: ['performance', 'slow', 'optimizar', 'latency'] },
  { id: 'postgres-pro', triggers: ['postgres-pro'], strong: ['postgresql', 'postgres', 'vacuum', 'wal', 'pgbouncer', 'pg_stat'], context: ['sql tuning', 'rdbms', 'replicacion'] },
  { id: 'database-administrator', triggers: ['database-administrator'], strong: ['explain analyze', 'index optimization', 'query plan', 'high availability db'], context: ['database', 'schema', 'migration'] },
  { id: 'cloud-architect', triggers: ['cloud-architect'], strong: ['multi-cloud', 'disaster recovery', 'cloud migration', 'well-architected'], context: ['aws', 'azure', 'gcp', 'infra'] },
  { id: 'kubernetes-specialist', triggers: ['kubernetes-specialist'], strong: ['kubernetes', 'k8s', 'helm chart', 'k8s operator', 'kubectl'], context: ['cluster', 'pod', 'ingress'] },
  { id: 'ai-engineer', triggers: ['ai-engineer'], strong: ['rag pipeline', 'vector db', 'fine-tuning', 'model serving', 'embeddings pipeline'], context: ['ai system', 'ml', 'inference'] },
  { id: 'llm-architect', triggers: ['llm-architect'], strong: ['llm system', 'context window', 'agent architecture', 'inference serving', 'multi-model'], context: ['llm', 'rag', 'prompt'] },
  { id: 'mcp-developer', triggers: ['mcp-developer'], strong: ['mcp server', 'model context protocol', 'mcp tool', 'mcp client'], context: ['mcp'] },
  { id: 'refactoring-specialist', triggers: ['refactoring-specialist'], strong: ['extract method', 'behavior-preserving refactor', 'reduce complexity', 'code smell'], context: ['refactor', 'cleanup', 'deuda tecnica'] },
  { id: 'architect-reviewer', triggers: ['architect-reviewer'], strong: ['architecture decision', 'module boundaries', 'solid violation', 'system design review'], context: ['arquitectura', 'design review'] },
  { id: 'api-designer', triggers: ['api-designer'], strong: ['rest api design', 'openapi spec', 'graphql schema', 'api versioning'], context: ['endpoint', 'api'] },
];

function safeLog(entry) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
      'utf8'
    );
  } catch (_) {
    // never throw
  }
}

function emitContext(text) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: text || '',
    },
  };
  try {
    process.stdout.write(JSON.stringify(payload));
  } catch (_) {
    // ignore
  }
}

function readStdinSafe() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function normalize(s) {
  // Lowercase + strip diacritics so "código" matches "codigo".
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

function hasToken(haystack, needle) {
  // Word-boundary match for single-word tokens; substring only for multi-word phrases.
  //
  // Anchoring ALL single-word tokens (not just short ones) to word boundaries
  // prevents false positives: "react"⊄"reaccion", "commit"⊄"commitment",
  // "testing"⊄"attesting", "design"⊄"designado", "shader"⊄"shaderboard".
  // Multi-word phrases ("don claudio", "design tokens") still use substring,
  // since their internal spaces already act as boundaries.
  const n = normalize(needle);
  const h = haystack;
  if (!n || !h) return false;

  // Multi-word phrase → plain substring (spaces are natural boundaries).
  if (n.includes(' ')) {
    return h.includes(n);
  }

  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Extension tokens (".ts", ".cpp", ".rs"): the leading "." is itself the left
  // delimiter, so a filename stem before it is fine ("main.ts" matches). Only the
  // trailing side needs a boundary that excludes "." and alphanumerics, so ".ts"
  // does NOT match inside ".tsx" or ".ts2".
  if (n[0] === '.') {
    const re = new RegExp(escaped + '([^a-z0-9.]|$)', 'i');
    return re.test(h);
  }

  // Plain single-word token → require alphanumeric word boundaries on both sides.
  const re = new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i');
  return re.test(h);
}

function scoreEntry(promptNorm, entry) {
  let score = 0;
  const matched = [];

  for (const t of entry.triggers || []) {
    if (hasToken(promptNorm, t)) {
      score += W_TRIGGER;
      matched.push(`trigger:${t}`);
    }
  }
  for (const t of entry.strong || []) {
    if (hasToken(promptNorm, t)) {
      score += W_STRONG;
      matched.push(`strong:${t}`);
    }
  }
  for (const t of entry.context || []) {
    if (hasToken(promptNorm, t)) {
      score += W_CONTEXT;
      matched.push(`context:${t}`);
    }
  }

  return { score, matched };
}

function rankCandidates(prompt) {
  const promptNorm = normalize(prompt).slice(0, MAX_PROMPT_CHARS);
  const all = [
    ...PERSONAS.map((e) => ({ ...e, kind: 'persona' })),
    ...PLUGINS.map((e) => ({ ...e, kind: 'plugin' })),
    ...AGENTS.map((e) => ({ ...e, kind: 'agent' })),
  ];

  const scored = all
    .map((entry) => {
      const { score, matched } = scoreEntry(promptNorm, entry);
      return {
        kind: entry.kind,
        id: entry.id,
        persona: entry.persona || null,
        score,
        matched,
        confidence: Math.max(0, Math.min(1, score / 100)),
      };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored;
}

function formatCandidateLabel(c) {
  if (c.kind === 'persona') {
    return `persona:${c.persona || c.id}`;
  }
  if (c.kind === 'agent') {
    return `agent:${c.id}`;
  }
  return `skill:${c.id}`;
}

function buildHighContext(top) {
  const matchedSummary = top.matched.slice(0, 3).join(', ');
  return [
    `[auto-routing: ${Math.round(top.confidence * 100)}% confidence]`,
    `Suggested: ${formatCandidateLabel(top)} — signals matched: ${matchedSummary}`,
    'If this routing is wrong, ignore this hint and proceed with your judgement.',
  ].join('\n');
}

function buildMediumContext(top, second) {
  const lines = [
    `[auto-routing: medium confidence ~${Math.round(top.confidence * 100)}%]`,
    `Two candidates matched the prompt:`,
    `  1) ${formatCandidateLabel(top)} (score ${top.score}, signals: ${top.matched.slice(0, 2).join(', ')})`,
  ];
  if (second) {
    lines.push(`  2) ${formatCandidateLabel(second)} (score ${second.score}, signals: ${second.matched.slice(0, 2).join(', ')})`);
  }
  lines.push('Pick the one that matches your interpretation of the request, or ignore.');
  return lines.join('\n');
}

function main() {
  const stdinRaw = readStdinSafe();
  let payload = {};
  try {
    payload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (_) {
    // No payload → no hint.
    return emitContext('');
  }

  const prompt = String(payload.prompt || payload.user_prompt || '').trim();
  if (!prompt) {
    return emitContext('');
  }

  const ranked = rankCandidates(prompt);
  if (ranked.length === 0) {
    safeLog({ level: 'info', msg: 'no_match', prompt_chars: prompt.length });
    return emitContext('');
  }

  const top = ranked[0];
  const second = ranked[1] || null;

  let text = '';
  if (top.confidence >= HIGH_THRESHOLD) {
    text = buildHighContext(top);
    safeLog({
      level: 'info',
      msg: 'high_confidence_routing',
      top: formatCandidateLabel(top),
      score: top.score,
      confidence: top.confidence,
    });
  } else if (top.confidence >= MED_THRESHOLD) {
    text = buildMediumContext(top, second);
    safeLog({
      level: 'info',
      msg: 'medium_confidence_routing',
      top: formatCandidateLabel(top),
      second: second ? formatCandidateLabel(second) : null,
      score: top.score,
      confidence: top.confidence,
    });
  } else {
    safeLog({
      level: 'info',
      msg: 'low_confidence_skip',
      top: formatCandidateLabel(top),
      score: top.score,
      confidence: top.confidence,
    });
  }

  emitContext(text);
}

// Only run the hook when executed directly (not when require()'d by tests).
if (require.main === module) {
  try {
    main();
  } catch (err) {
    safeLog({ level: 'error', msg: 'unhandled', error: String(err && err.message) });
    emitContext('');
  }
  process.exitCode = 0;
}

// Exported for unit tests (regression coverage of hasToken word boundaries).
module.exports = { hasToken, normalize, scoreEntry, rankCandidates };
