#!/usr/bin/env node
/**
 * UserPromptSubmit hook -> suggest a skill/persona based on the user prompt.
 *
 * v2 additions over v1 (routing-dispatcher.js):
 *   - Lazy SKILL.md injection: when a skill marked lazy_loadable scores >=0.80
 *     its SKILL.md is read from disk (async, with 5s timeout) and appended to
 *     additionalContext under a clear heading [skill-inyectada: NAME].
 *   - In-memory cooldown: a Map<skillId, invocationCount> prevents re-injecting
 *     the same skill if it was already injected in the last 2 invocations of
 *     this process (i.e. the current session's hook calls).
 *   - Graceful fallback: any read failure emits the normal routing hint without
 *     skill content; the hook never blocks the prompt.
 *   - 100% backward-compatible: all v1 logic (PERSONAS/PLUGINS/AGENTS tables,
 *     scoring, hasToken, rankCandidates, logging) is preserved unchanged.
 *
 * Reads JSON from stdin (Claude Code UserPromptSubmit hook contract):
 *   { session_id, prompt, hook_event_name, ... }
 *
 * Output (per Claude Code UserPromptSubmit hook contract):
 *   {"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
 *                           "additionalContext": "<hint>"}}
 *
 * Failure mode: any error -> silent (no additionalContext). NEVER blocks.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
// CI/test override (casilla 2.5b): when ULTRON_ROUTING_FIXTURES points at a
// fixtures tree, every candidate-discovery root resolves under it — so the
// acc@3 harness is deterministic in CI, where ~/.claude/skills and the ECC
// cache don't exist. UNSET in production => paths are byte-identical to before.
const _FIX = process.env.ULTRON_ROUTING_FIXTURES || '';
function _routeRoot(sub, realPath) {
  return _FIX ? path.join(_FIX, sub) : realPath;
}
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'routing-dispatcher.jsonl');
const SKILLS_DIR = _routeRoot('claude-skills', path.join(HOME, '.claude', 'skills'));
const REGISTRY_PATH = path.join(HOME, '.ultron', 'cockpit', 'skill-lazy', 'skills-registry.json');

// cat9.4/cat15.1: per-hook timing + error logging. Fail-safe: a missing
// module or any error must NEVER block routing (this runs on every prompt).
let _logHookError = function () {};
try {
  const _hookObs = require('../../hooks/scripts/lib/hook-obs');
  // HOOKS-05 (auditoria 2026-07-16): solo atribuir timing cuando v2 corre como
  // hook standalone. Importado como libreria por v3, la observacion la registra
  // v3 con su propio id — antes TODO el timing salia como "routing-dispatcher.v2"
  // aunque el hook registrado en settings.json es v3.
  if (require.main === module) _hookObs.observe('routing-dispatcher.v2');
  _logHookError = _hookObs.logHookError;
} catch { /* observability is optional; never break the hot path */ }

// ---------------------------------------------------------------------------
// ECC plugin path (Option B: separate index, no contamination of main ranking)
// ---------------------------------------------------------------------------

/**
 * Root of the ECC plugin skills.  apply-lazy-ecc.ps1 renames each skill
 * FOLDER to <name>.disabled, leaving SKILL.md intact inside it.
 *
 * The version segment ("2.0.0-rc.1") is discovered at runtime so the code
 * survives a plugin update.  If the cache root does not exist the ECC
 * subsystem degrades silently.
 */
const ECC_CACHE_ROOT = _routeRoot('ecc', path.join(HOME, '.claude', 'plugins', 'cache', 'ecc', 'ecc'));

/**
 * Minimum raw score (sum of W_TRIGGER/W_STRONG/W_CONTEXT hits) that an ECC
 * candidate must reach to trigger re-injection.  Intentionally lower than the
 * main HIGH_THRESHOLD (which maps 100 -> 1.0) because ECC entries are scored
 * against description words only (no curated strong[] lists).
 *
 * 70 raw  ~  one strong-level hit (W_STRONG=60) + one context hit (W_CONTEXT=25)
 *         or  two context hits + one trigger hit on the skill name itself.
 * This prevents single-word false positives while still allowing precise matches.
 */
const ECC_MATCH_MIN_RAW = 70;

const MAX_PROMPT_CHARS = 4000;
const HIGH_THRESHOLD = 0.80;
const MED_THRESHOLD = 0.50;

// ---------------------------------------------------------------------------
// Workspace autodiscovery paths
// ---------------------------------------------------------------------------

/**
 * Root of project-local skills: each subdir that contains SKILL.md is a
 * workspace skill candidate.  This is SEPARATE from ~/.claude/skills (the
 * global Claude skills dir used by lazy-injection) — it points to ULTRON's
 * own skill store under ~/.ultron/skills/.
 */
const ULTRON_SKILLS_DIR = _routeRoot('ultron-skills', path.join(HOME, '.ultron', 'skills'));

/**
 * Root of per-project rosters.  Each project may have:
 *   pinned-agents.json  → { "pinned": ["agent-id", ...] }
 *   agent-roster.json   → { "entries": [{ "name": "agent-id", ... }] }
 */
const PROJECTS_DIR = _routeRoot('projects', path.join(HOME, '.ultron', 'cockpit', 'projects'));

// Lazy injection settings
const LAZY_SCORE_THRESHOLD = 0.80;
const LAZY_READ_TIMEOUT_MS = 5000;
const LAZY_COOLDOWN_INVOCATIONS = 2;
// Cap de skills inyectadas por prompt (2026-06-23). Un prompt vago puede igualar a
// >=0.80 a 11-14 personas y arrastrar ~24k tokens de SKILL.md de golpe (audit runtime
// 2026-06-22; el dedup por-contenido no lo caza porque son archivos distintos). Nos
// quedamos con las N de mayor confianza. La persona dominante de un FAST PATH tiene el
// score mas alto -> sobrevive al cap; solo se recortan los empates de cola.
const MAX_LAZY_INJECTIONS = 3;

// iter-10 FASE 7: relaxed lazy-injection floor for a tiny allowlist of
// planning/orchestration skills when the prompt has explicit planning intent.
// Only these ids may inject in [PLANNING_LAZY_FLOOR, LAZY_SCORE_THRESHOLD).
const PLANNING_LAZY_FLOOR = 0.65;
const PLANNING_LAZY_SKILLS = new Set([
  'hiper-plans',
  'superpowers:executing-plans',
  'superpowers:dispatching-parallel-agents',
]);

/**
 * Strong planning/orchestration keywords that justify relaxing the lazy floor
 * for PLANNING_LAZY_SKILLS. All are multi-char phrases or whole words — no short
 * substrings, so no false-positive injection.
 */
const STRONG_PLANNING_KEYWORDS = [
  'escribe un plan',
  'planifica',
  'ejecuta el plan',
  'orquesta',
  'paralelo',
  'multi-agente',
  'multiagente',
];

function promptHasStrongPlanningKeyword(promptNorm) {
  for (const kw of STRONG_PLANNING_KEYWORDS) {
    if (promptNorm.includes(kw)) return true;
  }
  return false;
}

// Weights
const W_TRIGGER = 100;
const W_STRONG = 60;
const W_CONTEXT = 25;

/**
 * In-memory cooldown tracker.
 * Maps skillId -> last invocation counter when that skill was injected.
 * @type {Map<string, number>}
 */
const _injectionHistory = new Map();

/**
 * Monotonically increasing invocation counter for this process lifetime.
 * Incremented once per main() call.
 */
let _invocationCounter = 0;

/**
 * Lazy registry cache (loaded once per process).
 * @type {Array<{id: string, lazy_loadable: boolean, keep_active: boolean}>|null}
 */
let _registryCache = null;

/**
 * ECC skill index cache (Option B).
 * Loaded once per process by scanEccSkills().
 * null  = not yet loaded
 * Map   = loaded (may be empty if ECC cache missing or I/O error)
 *
 * Each entry: { skillPath: string, tokens: { triggers, strong, context } }
 * Key: normalized skill name (e.g. "accessibility", "autonomous-loops")
 *
 * @type {Map<string, {skillPath: string, tokens: {triggers: string[], strong: string[], context: string[]}}>|null}
 */
let _eccIndexCache = null;

/**
 * SKILL.md content cache (cat9.4 — lazy, module-lifetime).
 *
 * Maps absolute SKILL.md path -> file content string so that repeated reads
 * of the same file within the process (across hook invocations in the same
 * session) hit memory instead of disk.  A file is read at most once per
 * process lifetime; the result is stored even if it is an empty string so a
 * missing/empty file is not retried.  readWithTimeout still provides the
 * actual I/O + timeout; the cache wraps it.
 *
 * @type {Map<string, string>}
 */
const _skillMdCache = new Map();

// ---------------------------------------------------------------------------
// ECC-specific stop-word list (extended from the workspace stop-word list)
// ---------------------------------------------------------------------------

/**
 * Stop words for ECC token extraction.
 * Broader than the workspace list because ECC descriptions use more generic prose.
 * @type {Set<string>}
 */
const ECC_STOP_WORDS = new Set([
  'para', 'cuando', 'desde', 'sobre', 'entre', 'hasta', 'under', 'about',
  'with', 'this', 'that', 'from', 'skill', 'ultron', 'activate', 'always',
  'using', 'based', 'their', 'which', 'where', 'should', 'other', 'these',
  'those', 'there', 'after', 'before', 'without', 'within', 'across', 'into',
  'when', 'your', 'will', 'have', 'been', 'more', 'such', 'also', 'each',
  'and', 'for', 'the', 'are', 'can', 'its', 'not', 'all', 'any', 'use',
  'used', 'user', 'asks', 'needs', 'want', 'wants', 'need', 'make', 'help',
]);

/**
 * Planning-methodology bigrams (iter-10 FASE 7) promoted to strong[] when an
 * ECC skill's "When to Use" section uses this explicit planning vocabulary.
 * Normalized (lowercase, no diacritics) so comparison against whenNorm is direct.
 */
const PLANNING_METHODOLOGY_BIGRAMS = [
  'requirements analysis',
  'architecture decision',
  'spec driven',
  'phase breakdown',
  'risk assessment',
];

// ---------------------------------------------------------------------------
// PERSONAS (Layer 1) — unchanged from v1
// ---------------------------------------------------------------------------

const PERSONAS = [
  {
    id: 'terry-davis',
    persona: 'terry-davis',
    triggers: ['terry', 'terry davis', 'modo terry', 'activa a terry'],
    strong: ['debuggear', 'refactorizar', 'arquitectura de software', 'incident'],
    context: ['codigo', 'bug', 'commit', 'deploy', 'refactor', 'testing', '.cpp', '.cs', '.ts', '.py', '.rs', '.go'],
  },
  {
    id: 'don-claudio',
    persona: 'don-claudio',
    triggers: ['don claudio', 'don', 'activa al don', 'modo don'],
    strong: ['ue5', 'unreal', 'unreal engine', 'blueprint', 'gas', 'enhanced input', 'netcode', 'rollback', 'lag compensation', 'metasounds', 'nanite', 'lumen', 'chaos physics', 'ecs', 'dots'],
    context: ['unity', 'shader', 'game', 'multijugador', 'matchmaking', 'graphics', 'gamedev', 'gameplay'],
  },
  {
    id: 'mike-tyson',
    persona: 'mike-tyson',
    triggers: ['mike', 'mike tyson', 'modo mike', 'activa a mike'],
    strong: ['ux', 'design system', 'wireframe', 'design tokens', 'jerarquia visual', 'accesibilidad'],
    context: ['ui', 'diseno', 'color', 'layout', 'tipografia', 'paleta', 'landing', 'componente', 'responsive', 'dark mode'],
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
    strong: ['paper', 'literature review', 'state of the art', 'investigacion cientifica'],
    context: ['investiga', 'explica', 'ciencia', 'teoria', 'concepto', 'por que'],
  },
  {
    id: 'pana',
    persona: 'pana',
    triggers: ['pana', 'modo pana', 'modo manana', 'cierra el dia'],
    strong: ['briefing', 'blackboard', 'agenda del dia'],
    context: ['email', 'agenda', 'notion', 'spotify', 'organizacion personal', 'calendar'],
  },
  {
    id: 'tio-gilito',
    persona: 'tio-gilito',
    triggers: ['tio gilito', 'tio gilito', 'gilito'],
    strong: ['kutxabank', 'fondos de ahorro', 'limites de gasto', 'saldo actual', 'anade un gasto', 'anade un ingreso', 'reglas de ahorro'],
    context: ['gasto', 'ahorro', 'presupuesto', 'banco', 'finanzas personales', 'saldo', 'mis ahorros'],
  },
  {
    id: 'warren',
    persona: 'warren',
    triggers: ['warren'],
    strong: ['analisis fundamental', 'etf', 'cartera de inversion', 'dividendos', 'sector financiero', 'macro economico'],
    context: ['bolsa', 'inversion', 'cartera', 'acciones', 'mercado', 'compro'],
  },
  {
    id: 'repo-evaluator',
    persona: 'repo-evaluator',
    triggers: ['kirkardo', 'corrigeme el t', 'ponme nota', 'evalua mi codigo', 'gradeame'],
    strong: ['evalua', 'corrige como profesor', 'revisa mi entrega'],
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
    id: 'tolkien',
    persona: 'tolkien',
    triggers: ['tolkien', 'modo escritor', 'modo tolkien', 'escribe el libro', 'siguiente capitulo'],
    strong: ['plot hole', 'arco narrativo', 'imperio de los once grandes'],
    context: ['capitulo', 'escena', 'personaje', 'plot', 'libro', 'narrativa'],
  },
  {
    id: 'novalbos',
    persona: 'novalbos',
    triggers: ['novalbos', 'modo aprendizaje', '/learn'],
    strong: ['vulkan', 'dx12', 'cuda', 'simd', 'backprop', 'transformer', 'apuntes para notebooklm', 'apuntes de notion'],
    context: ['shader', 'opengl', 'red neuronal', 'bajo nivel', 'asm', 'compilador', 'memoria', 'concurrencia', 'gpu pipeline'],
  },
];

// ---------------------------------------------------------------------------
// PLUGINS (Layer 2) — unchanged from v1
// ---------------------------------------------------------------------------

const PLUGINS = [
  // Code review
  { id: 'pr-review-toolkit:code-reviewer',   triggers: ['code review', 'review pr', 'revisa el pr'],         strong: ['auditoria de codigo', 'pull request review'],                               context: ['code review', 'revision de codigo'] },
  { id: 'second-opinion',                    triggers: ['second opinion', 'codex review', '/second-opinion'], strong: ['external review', 'segunda opinion'],              context: ['codex', 'gemini'] },
  // Debugging / quality
  { id: 'superpowers:systematic-debugging',  triggers: ['systematic debugging'],                              strong: ['bug sin causa obvia', 'no encuentro el bug', 'debug sistematico'],          context: ['bug intermitente', 'debugging'] },
  { id: 'focused-fix',                       triggers: ['focused fix', 'haz que funcione'],                   strong: ['feature rota', 'modulo con fallos en cascada'],                            context: ['reparar feature', 'fix de modulo'] },
  // Testing
  { id: 'superpowers:test-driven-development', triggers: ['tdd', 'test-driven development'],                  strong: ['escribe los tests primero', 'red green refactor'],                         context: ['testing', 'pruebas unitarias', 'cobertura de tests'] },
  { id: 'webapp-testing',                    triggers: ['playwright', 'webapp testing', 'e2e'],               strong: ['test web app local', 'browser snapshot'],                                  context: ['e2e', 'browser testing', 'ui testing'] },
  // Feature development
  { id: 'feature-dev:feature-dev',           triggers: ['feature dev'],                                       strong: ['arquitectura de feature', 'diseno tecnico de feature'],                    context: ['nueva feature', 'diseno tecnico'] },
  // Security
  { id: 'security-scan',                     triggers: ['security scan', 'security review'],                  strong: ['cve', 'sast', 'static analysis', 'owasp'],                                 context: ['vulnerabilidades', 'auditoria seguridad'] },
  // Database / migrations
  { id: 'database-migrations',               triggers: ['database migrations', 'db migration'],               strong: ['zero-downtime migration', 'alter table', 'expand-contract', 'prisma migrate', 'alembic'], context: ['schema', 'rls', 'migracion de db'] },
  // Git / versioning
  { id: 'git-conflict-resolver',             triggers: ['git conflict', 'merge conflict', 'git bisect', 'interactive rebase'], strong: ['cherry-pick', 'core.autocrlf', 'git rerere'],        context: ['conflicto de merge', 'rebase'] },
  { id: 'commit-commands:commit',            triggers: ['commit', 'git commit'],                              strong: ['conventional commits', 'commit message'],                                  context: ['commit'] },
  // Frontend / design
  { id: 'frontend-design',                   triggers: ['frontend design'],                                   strong: ['glassmorphism', 'brutalist', 'minimalist ui'],                             context: ['componentes ui', 'estilos visuales', 'frontend'] },
  // Infrastructure
  { id: 'docker-patterns',                   triggers: ['docker', 'dockerfile', 'docker-compose'],            strong: ['multi-stage build', 'docker compose'],                                     context: ['contenedores', 'dockerfile'] },
  // MCP / hooks
  { id: 'mcp-builder',                       triggers: ['mcp builder', 'crear mcp', 'crear servidor mcp'],   strong: ['mcp server', 'servidor mcp'],                                              context: ['model context protocol', 'tool registration'] },
  { id: 'ecc:hookify',                       triggers: ['hookify', 'crea un hook'],                          strong: ['settings.json hooks', 'pretooluse', 'posttooluse', 'userpromptsubmit hook'], context: ['hooks', 'automatizaciones'] },
  // Skill / agent management
  { id: 'skill-creator:skill-creator',       triggers: ['crear skill', 'skill creator'],                     strong: ['mejorar skill', 'editar skill', 'nueva skill'],                            context: ['skill md', 'frontmatter de skill'] },
  // Memory / context
  { id: 'consolidate-memory',                triggers: ['consolida memoria', 'ordena .ultron', 'limpia el index', 'fusiona memorias'], strong: ['memory consolidation', 'memory.md'],          context: ['memoria', 'index'] },
  // Language patterns (catalog)
  { id: 'cpp-coding-standards',              triggers: ['cpp coding standards', 'c++ standards'],            strong: ['raii', 'cppcoreguidelines'],                                               context: ['c++', 'cpp'] },
  { id: 'rust-patterns',                     triggers: ['rust patterns'],                                    strong: ['borrow checker', 'lifetimes', 'tokio'],                                   context: ['rust'] },
  { id: 'python-patterns',                   triggers: ['python patterns'],                                  strong: ['async def', 'pydantic v2', 'sqlalchemy 2.0'],                             context: ['python'] },
  // Graphics / shaders
  { id: 'shader-fundamentals',               triggers: ['shader fundamentals'],                              strong: ['fragment shader', 'vertex shader', 'glsl', 'hlsl', 'metal shading language'], context: ['shader', 'rendering pipeline'] },
  // Agents / orchestration (catalog)
  { id: 'agent-architecture-audit',          triggers: ['agent architecture audit', 'audita el agente'],     strong: ['wrapper regression', 'memory pollution', '12-layer agent stack'],          context: ['agent stack', 'autonomous loops'] },
  { id: 'autonomous-loops',                  triggers: ['autonomous loops', 'loop autonomo'],                strong: ['rfc-driven multi-agent dag', 'sequential pipelines'],                      context: ['orquestacion', 'multi-agent'] },
  // Media / files
  { id: 'pdf',                               triggers: ['pdf', 'archivo pdf'],                               strong: ['merge pdf', 'split pdf', 'ocr pdf', 'fill pdf form'],                     context: ['pdf', '.pdf'] },
  { id: 'generate-image',                    triggers: ['generate image', 'genera una imagen'],              strong: ['stable diffusion', 'image generation'],                                   context: ['imagen', 'image'] },
  // Additional catalog skills
  { id: 'superpowers:brainstorming',         triggers: ['brainstorming', 'lluvia de ideas'],                 strong: ['ideation session', 'creative exploration'],                               context: ['ideas', 'brainstorm'] },
  { id: 'senior-engineer',                   triggers: ['senior engineer', 'senior mode'],                  strong: ['engineering decision', 'senior review', 'tech lead'],                     context: ['ingenieria', 'decision tecnica'] },
  // Language/stack pattern skills
  { id: 'postgres-patterns',                 triggers: ['postgres patterns'],                                strong: ['schema design postgres', 'indexing strategy', 'row level security'],       context: ['supabase'] },
  { id: 'redis-patterns',                    triggers: ['redis patterns', 'redis'],                          strong: ['distributed lock', 'rate limiting', 'pub/sub', 'cache invalidation'],     context: ['caching', 'cache'] },
  { id: 'vite-patterns',                     triggers: ['vite patterns', 'vite config', 'vite.config'],      strong: ['hmr', 'dependency pre-bundling', 'vite plugin'],                           context: ['vite'] },
  { id: 'nextjs-turbopack',                  triggers: ['turbopack'],                                        strong: ['incremental bundling', 'turbopack vs webpack', 'fs caching'],              context: ['next.js dev speed', 'bundler'] },
  { id: 'error-handling',                    triggers: ['error handling patterns'],                          strong: ['circuit breaker', 'typed errors', 'error boundaries', 'retry with backoff'], context: ['manejo de errores', 'reintentos'] },
  { id: 'deployment-patterns',               triggers: ['deployment patterns'],                              strong: ['production readiness checklist', 'health check endpoint', 'rollback strategy'], context: ['ci/cd', 'containerization'] },
  { id: 'hexagonal-architecture',            triggers: ['hexagonal architecture', 'ports and adapters'],     strong: ['dependency inversion', 'use-case orchestration', 'domain boundaries'],     context: ['hexagonal', 'puertos y adaptadores'] },
  // Testing pattern skills
  { id: 'python-testing',                    triggers: ['python testing', 'pytest patterns'],                strong: ['pytest fixtures', 'parametrize', 'pytest mocking'],                        context: ['cobertura python', 'pytest'] },
  { id: 'rust-testing',                      triggers: ['rust testing'],                                     strong: ['cargo test', 'proptest', 'property-based testing rust'],                   context: ['tests en rust'] },
  { id: 'cpp-testing',                       triggers: ['cpp testing', 'c++ testing'],                       strong: ['googletest', 'ctest', 'gtest', 'catch2'],                                 context: ['tests c++', 'sanitizers'] },
  // Docs / writing skills
  { id: 'markdown-mermaid-writing',          triggers: ['mermaid', 'mermaid diagram', 'markdown writing'],   strong: ['sequence diagram', 'flowchart diagram', 'gantt chart'],                   context: ['diagrama', 'documento tecnico'] },
  { id: 'docx',                              triggers: ['word document', 'word doc', '.docx', 'docx'],       strong: ['python-docx', 'tracked changes', 'tabla de contenidos word'],              context: ['carta formal', 'memo', 'plantilla word'] },
  { id: 'architecture-decision-records',     triggers: ['architecture decision record', 'adr'],              strong: ['record the decision', 'decision log', 'alternatives considered'],          context: ['registro de decisiones', 'decision de arquitectura'] },
  // Meta / workflow skills
  { id: 'prompt-optimizer',                  triggers: ['optimize prompt', 'optimiza el prompt', 'mejora mi prompt', 'rewrite this prompt'], strong: ['prompt optimization', 'optimized prompt'],          context: ['prompt'] },
  { id: 'token-budget-advisor',              triggers: ['token budget', 'response length', 'respuesta corta vs larga', 'ahorrar tokens'], strong: ['answer depth', 'brief answer', 'detailed answer'],        context: ['cuantos tokens', 'longitud de respuesta'] },
  { id: 'context-budget',                    triggers: ['context budget', 'audita el contexto', 'cuanto contexto', 'contexto consumen', 'auditar contexto'], strong: ['context window consumption', 'context bloat', 'context audit', 'token bloat'], context: ['ventana de contexto', 'consumo de contexto', 'cuanto contexto consumen', 'bloat de contexto'] },
  { id: 'windows-admin',                     triggers: ['windows admin'],                                    strong: ['winget install', 'scheduled task windows', 'windows service', 'windows registry'], context: ['administrador de windows', 'windows-mcp'] },
  { id: 'business-strategist',               triggers: ['business strategist'],                              strong: ['b2b saas', 'go-to-market', 'icp definition', 'market validation', 'investor deck'], context: ['estrategia de negocio', 'saas pricing'] },
  { id: 'search-first',                      triggers: ['search first', 'search-first', 'busca antes de codear', 'busca librerias', 'busca una libreria'], strong: ['research before coding', 'existing library first', 'libreria existente', 'patrones existentes'], context: ['buscar libreria existente', 'librerias existentes', 'antes de escribir codigo'] },
  { id: 'humanizer',                         triggers: ['humaniza', 'humanize', 'humanizer', 'sonar humano', 'suena humano', 'sound human'], strong: ['marcas de ia', 'signs of ai writing', 'texto generado por ia', 'ai-generated text', 'remove ai writing'], context: ['naturaliza el texto', 'estilo humano', 'escrito por ia'] },
  { id: 'council',                           triggers: ['council', 'convoca el council', 'four-voice council'], strong: ['structured disagreement', 'go/no-go call'],                              context: ['decision ambigua', 'tradeoff'] },
  { id: 'hiper-plans',                       triggers: ['hiper plan', 'hyper plan', 'hiperplan', 'plan profundo', 'deep plan', 'planifica exhaustivamente'], strong: ['spec driven plan', 'deep plan', 'escribe un plan', 'plan de implementacion', 'design doc', 'prd'],   context: ['planificacion compleja', 'plan'] },
  // Orchestration / parallel-agent planning skills (iter-10 FASE 7) — these
  // surface for planning prompts and are eligible for the relaxed lazy
  // threshold in fetchLazySkillContent (PLANNING_LAZY_FLOOR).
  { id: 'superpowers:executing-plans',       triggers: ['ejecuta el plan', 'executing plans', 'execute the plan'], strong: ['ejecuta el plan', 'execute the plan', 'implementation plan', 'plan de implementacion'], context: ['plan', 'checkpoint', 'plan execution'] },
  { id: 'superpowers:dispatching-parallel-agents', triggers: ['dispatch parallel agents', 'agentes en paralelo', 'multi-agente'], strong: ['parallel agents', 'agentes en paralelo', 'multi-agente', 'multiagente', 'dispatch agents'], context: ['orquesta', 'paralelo', 'parallel'] },
  // superpowers 5.1 workflow/quality skills (iter-10 FASE 8) — installed 2026-06-07
  { id: 'superpowers:verification-before-completion', triggers: ['verification before completion', 'verifica antes de completar'], strong: ['evidence before assertions', 'verifica antes de dar por hecho', 'confirm output before claiming'], context: ['verificacion', 'antes de completar', 'pruebas de que funciona'] },
  { id: 'superpowers:finishing-a-development-branch', triggers: ['finishing a development branch', 'cierra la rama', 'termina la rama'], strong: ['merge pr or cleanup', 'integrar el trabajo terminado', 'finishing development branch'], context: ['rama de desarrollo', 'merge', 'cierre de rama'] },
  { id: 'superpowers:requesting-code-review', triggers: ['requesting code review', 'pide una revision de codigo'], strong: ['request code review', 'verify work meets requirements', 'solicita revision antes de merge'], context: ['solicitar revision', 'antes de merge'] },
  { id: 'superpowers:receiving-code-review', triggers: ['receiving code review', 'recibe la revision de codigo'], strong: ['receiving code review feedback', 'feedback de revision de codigo', 'verify review suggestions'], context: ['feedback de review', 'aplicar revision'] },
  { id: 'superpowers:subagent-driven-development', triggers: ['subagent driven development', 'desarrollo por subagentes'], strong: ['independent tasks current session', 'ejecuta el plan con subagentes', 'subagent driven development'], context: ['subagentes', 'tareas independientes'] },
  { id: 'safety-guard',                      triggers: ['safety guard'],                                     strong: ['prevent destructive operations', 'production safety guard'],               context: ['operacion destructiva', 'autonomous safety'] },
  { id: 'frontend-design-direction',         triggers: ['frontend design direction', 'design direction'],    strong: ['product-specific design judgment', 'design direction for ui'],             context: ['direccion de diseno'] },
  { id: 'agentic-os',                        triggers: ['agentic os', 'agentic operating system'],           strong: ['kernel architecture agents', 'file-based memory agents', 'specialist agents os'], context: ['multi-agent os'] },
  { id: 'autonomous-agent-harness',          triggers: ['autonomous agent harness', 'autonomous agent system'], strong: ['self-directing agent loop', 'task queuing agent', 'scheduled operations agent'], context: ['agente autonomo continuo'] },
];

// ---------------------------------------------------------------------------
// AGENTS (Layer 3) — unchanged from v1
// ---------------------------------------------------------------------------

const AGENTS = [
  // Languages
  { id: 'rust-engineer',          triggers: ['rust-engineer'],          strong: ['rust', 'cargo', 'tokio', 'borrow checker', 'lifetimes', 'async rust', 'rustc', 'tauri backend'], context: ['memory safety', 'systems programming', '.rs'] },
  { id: 'typescript-pro',         triggers: ['typescript-pro'],         strong: ['typescript', 'tsconfig', 'type-level', 'discriminated union', 'generics avanzados'], context: ['node', '.ts', '.tsx', 'tipos'] },
  { id: 'python-pro',             triggers: ['python-pro'],             strong: ['pydantic', 'asyncio', 'type hints', 'mypy'], context: ['python', 'pytest', 'uv'] },
  { id: 'cpp-pro',                triggers: ['cpp-pro'],                strong: ['raii', 'move semantics', 'c++20', 'c++23', 'templates', 'cmake'], context: ['c++', 'cpp', '.cpp', '.hpp'] },
  { id: 'golang-pro',             triggers: ['golang-pro'],             strong: ['goroutine', 'go channels', 'golang'], context: ['microservice', 'concurrency', '.go'] },
  { id: 'javascript-pro',         triggers: ['javascript-pro'],         strong: ['vanilla js', 'esmodules', 'prototype chain', 'closure', 'event loop js'], context: ['.js', 'browser api', 'dom'] },
  { id: 'csharp-developer',       triggers: ['csharp-developer'],       strong: ['asp.net core', 'entity framework', 'linq', 'blazor', '.net 8', 'dependency injection .net'], context: ['.cs', 'c#', 'dotnet'] },
  { id: 'java-architect',         triggers: ['java-architect'],         strong: ['spring boot', 'quarkus', 'jvm tuning', 'gradle', 'maven', 'jpa hibernate'], context: ['java', '.java', 'microservices java'] },
  { id: 'kotlin-specialist',      triggers: ['kotlin-specialist'],      strong: ['kotlin coroutines', 'kotlin multiplatform', 'android jetpack', 'compose ui'], context: ['kotlin', '.kt', 'android'] },
  { id: 'swift-expert',           triggers: ['swift-expert'],           strong: ['swiftui', 'swift concurrency', 'swift actors', 'xcode', 'ios', 'macos app'], context: ['swift', '.swift', 'apple'] },
  { id: 'sql-pro',                triggers: ['sql-pro'],                strong: ['query optimization', 'window functions', 'cte', 'execution plan', 'sql tuning'], context: ['sql', 'rdbms', 'query'] },
  { id: 'graphics-programmer',    triggers: ['graphics-programmer'],    strong: ['glsl', 'hlsl', 'wgsl', 'vulkan', 'directx', 'opengl', 'render pipeline', 'pbr'], context: ['shader', 'gpu', 'rendering'] },
  { id: 'powershell-5.1-expert',  triggers: ['powershell-5.1-expert'],  strong: ['windows infra', 'rsat', 'legacy .net', 'gpo', 'active directory ps'], context: ['powershell', 'ps1', 'windows automation'] },
  { id: 'powershell-7-expert',    triggers: ['powershell-7-expert'],    strong: ['pwsh', 'cross-platform powershell', 'azure az module', 'pester'], context: ['powershell 7', 'ps7'] },
  // Frontend / UI
  { id: 'react-specialist',       triggers: ['react-specialist'],       strong: ['react 18', 'usememo', 'usecallback', 're-render', 'suspense', 'react server components'], context: ['react', 'componente', 'jsx'] },
  { id: 'nextjs-developer',       triggers: ['nextjs-developer'],       strong: ['next.js', 'app router', 'server actions', 'rsc'], context: ['vercel', 'ssr', 'core web vitals'] },
  { id: 'vue-expert',             triggers: ['vue-expert'],             strong: ['vue 3', 'composition api', 'pinia', 'nuxt', 'vue router'], context: ['vue', '.vue'] },
  { id: 'frontend-developer',     triggers: ['frontend-developer'],     strong: ['webpack', 'vite config', 'css modules', 'tailwind', 'web components'], context: ['frontend', 'html', 'css'] },
  { id: 'mobile-developer',       triggers: ['mobile-developer'],       strong: ['react native', 'flutter', 'expo', 'native modules', 'push notifications'], context: ['mobile', 'ios app', 'android app'] },
  { id: 'electron-pro',           triggers: ['electron-pro'],           strong: ['electron', 'ipc main', 'ipc renderer', 'electron forge', 'desktop app'], context: ['desktop', 'electron app'] },
  // Backend / infra
  { id: 'backend-developer',      triggers: ['backend-developer'],      strong: ['rest api', 'grpc', 'message queue', 'event driven', 'fastapi', 'express'], context: ['backend', 'api server', 'endpoints'] },
  { id: 'api-designer',           triggers: ['api-designer'],           strong: ['rest api design', 'openapi spec', 'graphql schema', 'api versioning'], context: ['endpoint', 'api'] },
  { id: 'cloud-architect',        triggers: ['cloud-architect'],        strong: ['multi-cloud', 'disaster recovery', 'cloud migration', 'well-architected'], context: ['aws', 'azure', 'gcp', 'infra'] },
  { id: 'kubernetes-specialist',  triggers: ['kubernetes-specialist'],  strong: ['kubernetes', 'k8s', 'helm chart', 'k8s operator', 'kubectl'], context: ['cluster', 'pod', 'ingress'] },
  { id: 'docker-expert',          triggers: ['docker-expert'],          strong: ['multi-stage build', 'docker compose', 'dockerfile optimization', 'container security'], context: ['docker', 'container', 'imagen docker'] },
  { id: 'terraform-engineer',     triggers: ['terraform-engineer'],     strong: ['terraform', 'hcl', 'tf state', 'terraform modules', 'iac'], context: ['infra as code', 'cloud provision'] },
  { id: 'devops-engineer',        triggers: ['devops-engineer'],        strong: ['ci cd pipeline', 'github actions', 'jenkins', 'secrets wiring', 'deployment pipeline'], context: ['devops', 'ci', 'cd', 'pipeline'] },
  { id: 'deployment-engineer',    triggers: ['deployment-engineer'],    strong: ['release automation', 'blue green deployment', 'canary release', 'rollback strategy'], context: ['deploy', 'release', 'rollout'] },
  { id: 'sre-engineer',           triggers: ['sre-engineer'],           strong: ['slo', 'sli', 'error budget', 'chaos engineering', 'on-call runbook'], context: ['reliability', 'availability', 'sre'] },
  { id: 'websocket-engineer',     triggers: ['websocket-engineer'],     strong: ['websocket', 'socket.io', 'real-time bidirectional', 'sse', 'long polling'], context: ['realtime', 'live updates', 'ws'] },
  // Database
  { id: 'postgres-pro',           triggers: ['postgres-pro'],           strong: ['postgresql', 'postgres', 'vacuum', 'wal', 'pgbouncer', 'pg_stat'], context: ['sql tuning', 'rdbms', 'replicacion'] },
  { id: 'database-administrator', triggers: ['database-administrator'], strong: ['explain analyze', 'index optimization', 'query plan', 'high availability db'], context: ['database', 'schema', 'migration'] },
  { id: 'data-engineer',          triggers: ['data-engineer'],          strong: ['etl', 'elt', 'data pipeline', 'apache spark', 'dbt', 'airflow', 'kafka'], context: ['pipeline de datos', 'ingestion', 'warehouse'] },
  // AI / ML
  { id: 'ai-engineer',            triggers: ['ai-engineer'],            strong: ['rag pipeline', 'vector db', 'fine-tuning', 'model serving', 'embeddings pipeline'], context: ['ai system', 'ml', 'inference'] },
  { id: 'llm-architect',          triggers: ['llm-architect'],          strong: ['llm system', 'context window', 'agent architecture', 'inference serving', 'multi-model'], context: ['llm', 'rag', 'prompt'] },
  { id: 'ml-engineer',            triggers: ['ml-engineer'],            strong: ['pytorch', 'tensorflow', 'model training', 'hyperparameter tuning', 'mlflow'], context: ['machine learning', 'entrenamiento', 'dataset'] },
  { id: 'mlops-engineer',         triggers: ['mlops-engineer'],         strong: ['model registry', 'feature store', 'experiment tracking', 'model drift', 'kubeflow'], context: ['mlops', 'pipeline ml', 'serving'] },
  { id: 'prompt-engineer',        triggers: ['prompt-engineer'],        strong: ['prompt design', 'chain of thought', 'few-shot', 'system prompt', 'prompt eval'], context: ['prompting', 'llm output'] },
  // Security / audit
  { id: 'security-auditor',       triggers: ['security-auditor'],       strong: ['owasp', 'auth bypass', 'sql injection', 'threat model', 'secrets leak', 'cve', 'xss', 'csrf'], context: ['security', 'auth', 'payments', 'user input', 'seguridad'] },
  { id: 'penetration-tester',     triggers: ['penetration-tester'],     strong: ['pentest', 'exploit', 'ctf', 'offensive security', 'burp suite', 'nmap'], context: ['hacking', 'vulnerability', 'red team'] },
  // Code quality / review
  { id: 'debugger',               triggers: ['debugger'],               strong: ['stack trace', 'root cause', 'test failure', 'segfault', 'panic'], context: ['bug', 'error', 'no funciona', 'crash'] },
  { id: 'performance-engineer',   triggers: ['performance-engineer'],   strong: ['bottleneck', 'profiling', 'n+1 query', 'memory leak', 'hot path'], context: ['performance', 'slow', 'optimizar', 'latency'] },
  { id: 'refactoring-specialist', triggers: ['refactoring-specialist'], strong: ['extract method', 'behavior-preserving refactor', 'reduce complexity', 'code smell'], context: ['refactor', 'cleanup', 'deuda tecnica'] },
  { id: 'architect-reviewer',     triggers: ['architect-reviewer'],     strong: ['architecture decision', 'module boundaries', 'solid violation', 'system design review'], context: ['arquitectura', 'design review'] },
  { id: 'code-reviewer',          triggers: ['code-reviewer'],          strong: ['code review checklist', 'pull request feedback', 'static analysis review'], context: ['revisar codigo', 'pr review', 'code quality'] },
  { id: 'qa-expert',              triggers: ['qa-expert'],              strong: ['test strategy', 'test pyramid', 'quality assurance', 'acceptance criteria', 'bdd'], context: ['qa', 'testing strategy', 'calidad'] },
  { id: 'test-automator',         triggers: ['test-automator'],         strong: ['test automation framework', 'ci test suite', 'test data management', 'flaky tests'], context: ['automation tests', 'test runner'] },
  { id: 'error-detective',        triggers: ['error-detective'],        strong: ['error correlation', 'cross-service errors', 'log aggregation errors', 'distributed tracing'], context: ['error tracking', 'sentry', 'logs'] },
  { id: 'legacy-modernizer',      triggers: ['legacy-modernizer'],      strong: ['strangler fig', 'incremental migration', 'modernize legacy', 'rewrite vs refactor'], context: ['legacy code', 'old system', 'migration'] },
  { id: 'dependency-manager',     triggers: ['dependency-manager'],     strong: ['cve audit', 'version conflict', 'dependency graph', 'supply chain security', 'renovate'], context: ['dependencias', 'npm audit', 'pip-audit'] },
  // Architecture / orchestration
  { id: 'microservices-architect', triggers: ['microservices-architect'], strong: ['decompose monolith', 'service mesh', 'event sourcing', 'saga pattern', 'api gateway'], context: ['microservices', 'distributed system'] },
  { id: 'fullstack-developer',    triggers: ['fullstack-developer'],    strong: ['full stack feature', 'back and front', 'end to end feature', 'monorepo fullstack'], context: ['fullstack', 'full-stack'] },
  { id: 'workflow-orchestrator',  triggers: ['workflow-orchestrator'],  strong: ['business workflow', 'workflow recovery', 'step function', 'temporal workflow'], context: ['orchestration', 'workflow', 'saga'] },
  { id: 'multi-agent-coordinator', triggers: ['multi-agent-coordinator'], strong: ['concurrent agents', 'agent state', 'agent team', 'multi-agent dag'], context: ['multi-agent', 'agent coordination'] },
  { id: 'agent-organizer',        triggers: ['agent-organizer'],        strong: ['assemble agent team', 'agent selection', 'agent delegation plan'], context: ['which agent', 'que agente usar'] },
  { id: 'cli-developer',          triggers: ['cli-developer'],          strong: ['click cli', 'argparse', 'cobra cli', 'shell completion', 'cross-platform cli'], context: ['cli', 'command line', 'terminal tool'] },
  { id: 'mcp-developer',          triggers: ['mcp-developer'],          strong: ['mcp server', 'model context protocol', 'mcp tool', 'mcp client'], context: ['mcp'] },
  { id: 'incident-responder',     triggers: ['incident-responder'],     strong: ['active breach', 'outage response', 'post-mortem', 'incident timeline'], context: ['incidente', 'outage', 'produccion caida'] },
  { id: 'documentation-engineer', triggers: ['documentation-engineer'], strong: ['docs system', 'api docs', 'tutorial structure', 'docusaurus', 'mkdocs'], context: ['documentacion', 'readme', 'docs'] },
  // Game / native / specialist
  { id: 'unity-engineer',         triggers: ['unity-engineer'],         strong: ['unity c#', 'unityscript', 'monobehaviour', 'unity ecs', 'unity packages'], context: ['unity', 'game object', 'unity scene'] },
  { id: 'unreal-engine-engineer', triggers: ['unreal-engine-engineer'], strong: ['ue5 c++', 'ue5 blueprints', 'gameplay ability system', 'niagara', 'unreal lumen'], context: ['unreal', 'ue5', 'epic games'] },
  { id: 'accessibility-tester',   triggers: ['accessibility-tester'],   strong: ['wcag', 'aria labels', 'screen reader', 'color contrast ratio', 'a11y audit'], context: ['accesibilidad', 'a11y', 'wcag'] },
  { id: 'context-manager',        triggers: ['context-manager'],        strong: ['shared state across agents', 'context synchronization', 'agent context retrieval'], context: ['shared context', 'metadata coordination'] },
  { id: 'dx-optimizer',           triggers: ['dx-optimizer'],           strong: ['developer experience', 'build times', 'feedback loop', 'dev environment optimization'], context: ['dx', 'developer satisfaction'] },
  { id: 'git-workflow-manager',   triggers: ['git-workflow-manager'],   strong: ['branching strategy', 'merge management', 'gitflow', 'release flow', 'trunk-based development'], context: ['git workflow', 'branching model'] },
  { id: 'knowledge-synthesizer',  triggers: ['knowledge-synthesizer'],  strong: ['extract patterns across agents', 'cross-workflow insights', 'organizational learning'], context: ['synthesize insights', 'agent telemetry patterns'] },
];

// ---------------------------------------------------------------------------
// Utility functions (unchanged from v1)
// ---------------------------------------------------------------------------

const { appendJsonl } = require('../../hooks/scripts/lib/jsonl-log');
const { isSystemTurnPrompt } = require('../../hooks/scripts/lib/system-turn');

function safeLog(entry) {
  // cat15.4: JSONL acotado (rota a 1 MiB) via helper compartido.
  appendJsonl(LOG_PATH, entry);
}

const _hookStart = Date.now();

function emitContext(text) {
  // Observabilidad cat9.3 (2026-06-10): latencia total del hook en cada salida.
  safeLog({ level: 'info', msg: 'v2_hook_complete', total_elapsed_ms: Date.now() - _hookStart, context_chars: (text || '').length });
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
  // Lowercase + strip diacritics so "codigo" matches "codigo".
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/**
 * Morphological aliases for planning/orchestration vocabulary (iter-10 FASE 7).
 *
 * Maps a canonical token (the key used in triggers/strong/context arrays) to the
 * set of Spanish/English surface forms that should ALSO satisfy a hasToken()
 * match for that canonical token. This lets a plugin entry keep a single
 * canonical token (e.g. 'plan') while still matching morphological variants the
 * user actually types ('planificacion', 'planificar').
 *
 * IMPORTANT: every alias listed here is a full word matched with the SAME
 * word-boundary regex as a normal token — never a short substring. This avoids
 * the historical substring catastrophe (arr->arregla, irr->irregular) because
 * the aliases are whole words ('planificacion', not 'plan' as a substring of
 * 'planificacion'). The boundary check below is applied to the ALIAS, not the
 * canonical, so 'plan' as a needle still only matches the standalone word 'plan'
 * plus the explicitly-enumerated longer aliases.
 */
const TOKEN_ALIASES = {
  plan: ['planificacion', 'planificar', 'planifica', 'planeacion', 'planear'],
  architecture: ['arquitectura', 'arquitectonico', 'arquitectonica', 'arch'],
  arch: ['arquitectura'],
  orchestrate: ['orquestar', 'orquestacion', 'orquesta', 'orchestration'],
  'hiper-plans': ['hiper-plan', 'deep-plan', 'hiperplan', 'deepplan'],
};

function _matchesWord(haystack, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Same dual-boundary rule used for plain single-word tokens.
  const re = new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i');
  return re.test(haystack);
}

function hasToken(haystack, needle) {
  // Word-boundary match for single-word tokens; substring only for multi-word phrases.
  const n = normalize(needle);
  const h = haystack;
  if (!n || !h) return false;

  // Multi-word phrase -> plain substring (spaces are natural boundaries).
  if (n.includes(' ')) {
    return h.includes(n);
  }

  // Morphological alias-matching (iter-10 FASE 7): if the canonical token has
  // registered aliases, a match on ANY alias (each a full word, boundary-checked)
  // counts as a hit. Word-boundaries are preserved for every alias — no short
  // substrings, so the arr->arregla / irr->irregular bug class cannot reappear.
  const aliases = TOKEN_ALIASES[n];
  if (aliases) {
    for (const alias of aliases) {
      const a = normalize(alias);
      if (!a) continue;
      if (a.includes(' ')) {
        if (h.includes(a)) return true;
      } else if (_matchesWord(h, a)) {
        return true;
      }
    }
  }

  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Extension tokens (".ts", ".cpp", ".rs"): the leading "." is itself the left
  // delimiter, so a filename stem before it is fine ("main.ts" matches). Only the
  // trailing side needs a boundary.
  if (n[0] === '.') {
    const re = new RegExp(escaped + '([^a-z0-9.]|$)', 'i');
    return re.test(h);
  }

  // Plain single-word token -> require alphanumeric word boundaries on both sides.
  const re = new RegExp('(^|[^a-z0-9])' + escaped + '([^a-z0-9]|$)', 'i');
  return re.test(h);
}

/**
 * Planning/orchestration intent tokens (iter-10 FASE 7). When the prompt
 * contains any of these, strong[] hits on planning-oriented entries get a
 * localized boost so planning skills surface above generic noise — WITHOUT
 * touching the global W_TRIGGER/W_STRONG/W_CONTEXT weights (which would
 * rebalance the entire ranking and regress specialist routing).
 */
const PLANNING_INTENT_TOKENS = [
  'plan ', 'planifica', 'planning', 'spec-driven', 'spec driven',
  'arquitectura', 'design doc', 'prd',
];

/** Entry ids that count as planning/orchestration for the strong[] boost. */
const PLANNING_ENTRY_ID_RE = /plan|prd|spec|hiper/i;

/** Local multiplier applied to strong[] hits of planning entries on planning prompts. */
const PLANNING_STRONG_MULTIPLIER = 1.5;

function promptHasPlanningIntent(promptNorm) {
  for (const tok of PLANNING_INTENT_TOKENS) {
    if (promptNorm.includes(tok)) return true;
  }
  return false;
}

function scoreEntry(promptNorm, entry) {
  let score = 0;
  const matched = [];

  // Localized planning boost: only the strong[] contribution of planning-oriented
  // entries is amplified, and only when the prompt signals planning intent. The
  // global weight constants are untouched so specialist ranking is unaffected.
  const planningBoost =
    promptHasPlanningIntent(promptNorm) && PLANNING_ENTRY_ID_RE.test(entry.id || '');
  const strongWeight = planningBoost
    ? Math.round(W_STRONG * PLANNING_STRONG_MULTIPLIER)
    : W_STRONG;

  for (const t of entry.triggers || []) {
    if (hasToken(promptNorm, t)) {
      score += W_TRIGGER;
      matched.push('trigger:' + t);
    }
  }
  for (const t of entry.strong || []) {
    if (hasToken(promptNorm, t)) {
      score += strongWeight;
      matched.push('strong:' + t);
    }
  }
  for (const t of entry.context || []) {
    if (hasToken(promptNorm, t)) {
      score += W_CONTEXT;
      matched.push('context:' + t);
    }
  }

  return { score, matched };
}

// ---------------------------------------------------------------------------
// Workspace autodiscovery — build extra candidates from the filesystem
// ---------------------------------------------------------------------------

/**
 * Process-lifetime cache so we pay the filesystem scan cost at most once.
 * null  = not yet loaded
 * Array = loaded (may be empty on error or empty dirs)
 * @type {Array<Object>|null}
 */
let _workspaceCandidatesCache = null;

/**
 * Extract a minimal set of scoring tokens from a SKILL.md file.
 *
 * Reads the YAML front-matter `name` and `description` fields (simple regex,
 * no YAML parser dependency) and converts them into trigger/strong/context
 * arrays compatible with scoreEntry().
 *
 * Always returns a valid object — never throws.
 *
 * @param {string} skillMdContent  Raw SKILL.md text.
 * @param {string} dirName         Fallback identifier (the subdir name).
 * @returns {{ id: string, triggers: string[], strong: string[], context: string[] }}
 */
function parseSkillMdTokens(skillMdContent, dirName) {
  let name = dirName;
  let description = '';

  try {
    // Extract `name:` from YAML front-matter (--- ... ---)
    const fmMatch = skillMdContent.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*["']?([^"'\n]+)["']?/m);
      if (nameMatch) name = nameMatch[1].trim();
      const descMatch = fm.match(/^description:\s*["']?([\s\S]*?)["']?\s*(?=\n\w|\n---|$)/m);
      if (descMatch) description = descMatch[1].replace(/\n/g, ' ').trim();
    }

    // If no front-matter description, grab first non-heading paragraph body text
    if (!description) {
      const bodyMatch = skillMdContent.replace(/^---[\s\S]*?---/, '').match(/[A-Za-z].{20,}/);
      if (bodyMatch) description = bodyMatch[0].slice(0, 200);
    }
  } catch (_) {
    // leave name=dirName, description=''
  }

  // The skill name itself is the primary trigger (normalized, spaces kept)
  const idNorm = normalize(name);
  const triggers = [idNorm];
  // Dash/underscore variant as additional trigger
  if (idNorm.includes('-') || idNorm.includes('_')) {
    triggers.push(idNorm.replace(/[-_]/g, ' '));
  }

  // Pull meaningful words (>= 5 chars) from description as context signals.
  // These are weak signals — they go into context[] (W_CONTEXT = 25), not strong[].
  const stopWords = new Set([
    'para', 'cuando', 'desde', 'sobre', 'entre', 'hasta', 'under', 'about',
    'with', 'this', 'that', 'from', 'skill', 'ultron', 'activate', 'always',
  ]);
  const contextTokens = [];
  const wordRe = /[a-z][a-z0-9]{4,}/gi;
  let m;
  const descNorm = normalize(description);
  while ((m = wordRe.exec(descNorm)) !== null) {
    const w = m[0].toLowerCase();
    if (!stopWords.has(w) && !contextTokens.includes(w) && contextTokens.length < 8) {
      contextTokens.push(w);
    }
  }

  return {
    id: normalize(name),       // normalized id — used for dedup
    _rawName: name,            // original casing for display
    triggers,
    strong: [],                // workspace skills start with no strong[] signals
    context: contextTokens,
  };
}

/**
 * Enhanced token extractor for ECC plugin skills.
 *
 * ECC SKILL.md files have only `name`, `description`, and `origin` in their
 * front-matter — no `triggers`, `strong`, or `keywords` fields.  The generic
 * parseSkillMdTokens() only pulls ≤8 context words from the description, which
 * yields scores of 25 at best and makes ECC skills un-matchable at ECC_MATCH_MIN_RAW=70.
 *
 * This function extracts richer signals:
 *
 *   strong[]: bigrams of meaningful adjacent words from the description (primary
 *             activation signal — purpose-written, concise) PLUS bigrams from the
 *             "When to Use" section (explicit activation language).  Also includes
 *             individual long words (>=6 chars) from the description.
 *             Cap: 24 entries.
 *
 *   context[]: shorter individual meaningful words (>=4 chars) from "When to Use"
 *              that are not already in strong[].  Cap: 12 entries.
 *
 *   triggers[]: the normalized skill name (e.g. "autonomous-loops") plus its
 *               space-separated variant ("autonomous loops").
 *
 * With this extractor a prompt like "make an autonomous claude code loop" hits
 * strong:"autonomous claude" (W_STRONG=60) and strong:"claude code" (W_STRONG=60)
 * for a raw score of 120, well above ECC_MATCH_MIN_RAW=70.
 *
 * The ECC index is consulted ONLY from matchBestEccSkill() — it never enters
 * rankCandidates() and cannot affect the main routing ranking.
 *
 * Always returns a valid object — never throws.
 *
 * @param {string} skillMdContent  Raw SKILL.md text.
 * @param {string} skillName       Canonical skill name (folder name with .disabled stripped).
 * @returns {{ id: string, _rawName: string, triggers: string[], strong: string[], context: string[] }}
 */
function parseEccSkillTokens(skillMdContent, skillName) {
  let description = '';
  let whenToUse = '';

  try {
    const fmMatch = skillMdContent.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/^description:\s*["']?([\s\S]*?)["']?\s*(?=\n\w|\n---|$)/m);
      if (descMatch) description = descMatch[1].replace(/\n/g, ' ').trim();
    }
    // "When to Use" section: explicit activation language — highest signal density
    const whenMatch = skillMdContent.match(/##\s*When to Use\s*\n([\s\S]*?)(?=\n##|$)/i);
    if (whenMatch) {
      whenToUse = whenMatch[1]
        .replace(/^[-*]\s*/gm, ' ')
        .replace(/\n/g, ' ')
        .trim()
        .slice(0, 800);
    }
    // Fallback: if no description, grab first prose sentence from body
    if (!description) {
      const bodyMatch = skillMdContent.replace(/^---[\s\S]*?---/, '').match(/[A-Za-z].{20,}/);
      if (bodyMatch) description = bodyMatch[0].slice(0, 200);
    }
  } catch (_) {
    // leave description='', whenToUse=''
  }

  const idNorm = normalize(skillName);
  const triggers = [idNorm];
  if (idNorm.includes('-')) triggers.push(idNorm.replace(/-/g, ' '));

  // --- strong[]: bigrams + long words from description, then bigrams from When-to-Use ---
  const strong = [];
  const seenStrong = new Set();

  function addStrong(token) {
    if (!seenStrong.has(token) && strong.length < 24) {
      seenStrong.add(token);
      strong.push(token);
    }
  }

  // Description bigrams
  const descNorm = normalize(description);
  const descWords = descNorm.match(/[a-z][a-z0-9-]{2,}/g) || [];
  for (let i = 0; i < descWords.length - 1; i++) {
    const a = descWords[i];
    const b = descWords[i + 1];
    if (!ECC_STOP_WORDS.has(a) && !ECC_STOP_WORDS.has(b)) {
      addStrong(a + ' ' + b);
    }
  }
  // Description long single words (>=6 chars)
  for (const w of descWords) {
    if (w.length >= 6 && !ECC_STOP_WORDS.has(w)) addStrong(w);
  }

  // When-to-Use bigrams (high signal: explicit activation phrasing)
  const whenNorm = normalize(whenToUse);
  const whenWords = whenNorm.match(/[a-z][a-z0-9-]{2,}/g) || [];
  for (let i = 0; i < whenWords.length - 1; i++) {
    const a = whenWords[i];
    const b = whenWords[i + 1];
    if (!ECC_STOP_WORDS.has(a) && !ECC_STOP_WORDS.has(b)) {
      addStrong(a + ' ' + b);
    }
  }

  // Planning-methodology bigrams (iter-10 FASE 7): if the When-to-Use section
  // mentions an explicit planning methodology phrase, promote it to strong[] so
  // planning ECC skills activate on prompts using that vocabulary.
  for (const phrase of PLANNING_METHODOLOGY_BIGRAMS) {
    if (whenNorm.includes(phrase)) addStrong(phrase);
  }

  // --- context[]: shorter words (>=4 chars) from When-to-Use not already in strong[] ---
  const context = [];
  const seenCtx = new Set(seenStrong);
  const ctxRe = /[a-z][a-z0-9]{3,}/g;
  let m;
  while ((m = ctxRe.exec(whenNorm)) !== null) {
    const w = m[0];
    if (!ECC_STOP_WORDS.has(w) && !seenCtx.has(w) && context.length < 12) {
      seenCtx.add(w);
      context.push(w);
    }
  }

  return {
    id: idNorm,
    _rawName: skillName,
    triggers,
    strong,
    context,
  };
}

/**
 * Scan ~/.ultron/skills/ for subdirs that contain SKILL.md and convert each
 * into a plugin-kind candidate.
 *
 * Subdirs whose name ends in '.disabled' are skipped (inactive skills).
 * Any I/O error is silently caught — returns [] on failure.
 *
 * @returns {Array<Object>}
 */
function scanUltronSkills() {
  const candidates = [];
  try {
    if (!fs.existsSync(ULTRON_SKILLS_DIR)) return candidates;
    const entries = fs.readdirSync(ULTRON_SKILLS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.endsWith('.disabled')) continue;
      // Skip the registry file itself and any non-skill dirs
      const skillMdPath = path.join(ULTRON_SKILLS_DIR, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      let content = '';
      try {
        content = fs.readFileSync(skillMdPath, 'utf8');
      } catch (_) {
        // unreadable — use dir name as fallback
      }

      const tokens = parseSkillMdTokens(content, entry.name);
      candidates.push({
        id: tokens.id,
        _rawName: tokens._rawName,
        _source: 'workspace-skill',
        triggers: tokens.triggers,
        strong: tokens.strong,
        context: tokens.context,
      });
    }
  } catch (_) {
    // directory unreadable — degrade gracefully
  }
  return candidates;
}

/**
 * Collect agent ids from all per-project roster files under cockpit/projects/.
 *
 * Supported schemas:
 *   pinned-agents.json  → { "pinned": ["agent-id", ...] }
 *   agent-roster.json   → { "entries": [{ "name": "agent-id" }] }
 *
 * Each unique agent id becomes a candidate with its id as the sole trigger.
 * Any parse/read error is silently caught per-file.
 *
 * @returns {Array<Object>}
 */
function scanProjectRosters() {
  const agentIds = new Set();
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const projectDirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true });
    for (const projDir of projectDirs) {
      if (!projDir.isDirectory()) continue;
      const projPath = path.join(PROJECTS_DIR, projDir.name);

      // pinned-agents.json
      const pinnedPath = path.join(projPath, 'pinned-agents.json');
      try {
        if (fs.existsSync(pinnedPath)) {
          const data = JSON.parse(fs.readFileSync(pinnedPath, 'utf8'));
          if (Array.isArray(data.pinned)) {
            for (const id of data.pinned) {
              if (typeof id === 'string' && id.trim()) agentIds.add(id.trim());
            }
          }
        }
      } catch (_) {}

      // agent-roster.json
      const rosterPath = path.join(projPath, 'agent-roster.json');
      try {
        if (fs.existsSync(rosterPath)) {
          const data = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
          if (Array.isArray(data.entries)) {
            for (const entry of data.entries) {
              if (entry && typeof entry.name === 'string' && entry.name.trim()) {
                agentIds.add(entry.name.trim());
              }
            }
          }
        }
      } catch (_) {}
    }
  } catch (_) {
    // projects dir unreadable — degrade gracefully
  }

  // Convert unique ids to agent-kind candidates.
  // Each agent id is also its trigger (e.g. "cpp-pro" triggers on "cpp-pro").
  return Array.from(agentIds).map(function (agentId) {
    const idNorm = normalize(agentId);
    return {
      id: agentId,              // keep original casing for display
      _source: 'project-roster',
      triggers: [idNorm, idNorm.replace(/-/g, ' ')],
      strong: [],
      context: [],
    };
  });
}

/**
 * Build and cache the workspace candidate list.
 *
 * Merges ~/.ultron/skills/ scan + project rosters, then deduplicates against
 * the hardcoded PERSONAS/PLUGINS/AGENTS arrays.  Hardcoded entries always win:
 * a workspace candidate whose id matches a hardcoded id is silently dropped.
 *
 * Result is cached in _workspaceCandidatesCache for the process lifetime.
 *
 * @returns {{ extraPlugins: Array<Object>, extraAgents: Array<Object> }}
 */
function loadWorkspaceCandidates() {
  if (_workspaceCandidatesCache !== null) return _workspaceCandidatesCache;

  try {
    // Build the set of ids already covered by hardcoded arrays (dedup guard).
    const hardcodedIds = new Set();
    for (const p of PERSONAS) hardcodedIds.add(normalize(p.id));
    for (const p of PLUGINS)  hardcodedIds.add(normalize(p.id));
    for (const a of AGENTS)   hardcodedIds.add(normalize(a.id));

    // Scan workspace skills (plugin-kind)
    const rawSkills = scanUltronSkills();
    const extraPlugins = rawSkills.filter(function (c) {
      return !hardcodedIds.has(normalize(c.id));
    });

    // Scan project rosters (agent-kind)
    const rawRoster = scanProjectRosters();
    const extraAgents = rawRoster.filter(function (c) {
      return !hardcodedIds.has(normalize(c.id));
    });

    _workspaceCandidatesCache = { extraPlugins, extraAgents };
    safeLog({
      level: 'info',
      msg: 'workspace_autodiscovery',
      extra_plugins: extraPlugins.length,
      extra_agents: extraAgents.length,
      plugin_ids: extraPlugins.map(function (c) { return c.id; }),
      agent_ids: extraAgents.map(function (c) { return c.id; }),
    });
  } catch (_err) {
    // Any unexpected error — fall back to empty extra candidates
    _workspaceCandidatesCache = { extraPlugins: [], extraAgents: [] };
    safeLog({ level: 'warn', msg: 'workspace_autodiscovery_failed', error: String(_err && _err.message) });
  }

  return _workspaceCandidatesCache;
}

function rankCandidates(prompt) {
  const promptNorm = normalize(prompt).slice(0, MAX_PROMPT_CHARS);

  // Load workspace candidates (cached after first call).
  // Failures are fully swallowed inside loadWorkspaceCandidates().
  const workspace = loadWorkspaceCandidates();

  const all = [
    ...PERSONAS.map((e) => ({ ...e, kind: 'persona' })),
    ...PLUGINS.map((e) => ({ ...e, kind: 'plugin' })),
    ...AGENTS.map((e) => ({ ...e, kind: 'agent' })),
    // Workspace-discovered candidates (additive — hardcoded already excluded by dedup)
    ...workspace.extraPlugins.map((e) => ({ ...e, kind: 'plugin' })),
    ...workspace.extraAgents.map((e) => ({ ...e, kind: 'agent' })),
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
    return 'persona:' + (c.persona || c.id);
  }
  if (c.kind === 'agent') {
    return 'agent:' + c.id;
  }
  return 'skill:' + c.id;
}

function buildHighContext(top) {
  const matchedSummary = top.matched.slice(0, 3).join(', ');
  return [
    '[auto-routing: ' + Math.round(top.confidence * 100) + '% confidence]',
    'Suggested: ' + formatCandidateLabel(top) + ' -- signals matched: ' + matchedSummary,
    'If this routing is wrong, ignore this hint and proceed with your judgement.',
  ].join('\n');
}

function buildMediumContext(top, second) {
  const lines = [
    '[auto-routing: medium confidence ~' + Math.round(top.confidence * 100) + '%]',
    'Two candidates matched the prompt:',
    '  1) ' + formatCandidateLabel(top) + ' (score ' + top.score + ', signals: ' + top.matched.slice(0, 2).join(', ') + ')',
  ];
  if (second) {
    lines.push('  2) ' + formatCandidateLabel(second) + ' (score ' + second.score + ', signals: ' + second.matched.slice(0, 2).join(', ') + ')');
  }
  lines.push('Pick the one that matches your interpretation of the request, or ignore.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ECC on-demand index (Option B) — separate from main ranking
// ---------------------------------------------------------------------------

/**
 * Discover the versioned ECC skills directory.
 *
 * Looks for the first sub-directory of ECC_CACHE_ROOT that contains a
 * "skills" sub-folder.  This makes the code resilient to version bumps
 * (e.g. "2.0.0-rc.1" -> "2.0.0-rc.2").
 *
 * Returns null if ECC_CACHE_ROOT does not exist or has no valid version dir.
 *
 * @returns {string|null}
 */
function resolveEccSkillsDir() {
  try {
    if (!fs.existsSync(ECC_CACHE_ROOT)) return null;
    const versionDirs = fs.readdirSync(ECC_CACHE_ROOT, { withFileTypes: true });
    for (const vdir of versionDirs) {
      if (!vdir.isDirectory()) continue;
      const candidate = path.join(ECC_CACHE_ROOT, vdir.name, 'skills');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch (_) {
    // ECC_CACHE_ROOT unreadable — degrade gracefully
  }
  return null;
}

/**
 * Scan the ECC skills directory and build a lightweight index.
 *
 * Handles two layouts produced by apply-lazy-ecc.ps1:
 *   Active:   skills/<name>/SKILL.md             (folder not yet disabled)
 *   Disabled: skills/<name>.disabled/SKILL.md    (folder renamed by the script)
 *
 * The skill name is derived by stripping the ".disabled" suffix from the
 * folder name so both forms are indexed under the same normalized key.
 *
 * Scoring tokens are extracted via parseEccSkillTokens() (NOT the generic
 * parseSkillMdTokens) so ECC entries get richer strong[] signals derived from
 * their description bigrams and "When to Use" sections.
 *
 * Result is cached in _eccIndexCache for the process lifetime.
 * Returns an empty Map on any error — never throws.
 *
 * DISK CACHE: On cold runs, after scanning, writes a JSON cache to
 * ~/.ultron/cockpit/skill-lazy/.ecc-index-cache.json. Subsequent process
 * invocations stat-walk the ECC directory (cheap), compare
 * {count, maxMtimeMs}, and skip the read+parse when the signature matches.
 * FAIL-SAFE: any cache error (missing, corrupt, I/O, unexpected shape) falls
 * back silently to the full re-scan — the cache is pure optimisation.
 *
 * @returns {Map<string, {skillPath: string, tokens: {triggers: string[], strong: string[], context: string[]}}>}
 */

const ECC_DISK_CACHE_PATH = path.join(HOME, '.ultron', 'cockpit', 'skill-lazy', '.ecc-index-cache.json');

/**
 * Build the invalidation signature for a given skills directory by stat-walking
 * its SKILL.md files. Uses statSync (no readFile) — cheap I/O.
 *
 * @param {string} skillsDir  Absolute path to the ECC skills directory.
 * @returns {{ count: number, maxMtimeMs: number }|null}  null if the dir is unreadable.
 */
function _buildEccSignature(skillsDir) {
  try {
    const dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
    let count = 0;
    let maxMtimeMs = 0;
    for (const entry of dirEntries) {
      if (!entry.isDirectory()) continue;
      const skillPath = path.join(skillsDir, entry.name, 'SKILL.md');
      try {
        const st = fs.statSync(skillPath);
        count++;
        if (st.mtimeMs > maxMtimeMs) maxMtimeMs = st.mtimeMs;
      } catch (_) {
        // SKILL.md missing in this folder — skip
      }
    }
    return { count, maxMtimeMs };
  } catch (_) {
    return null;
  }
}

function scanEccSkills() {
  if (_eccIndexCache !== null) return _eccIndexCache;

  _eccIndexCache = new Map();

  const skillsDir = resolveEccSkillsDir();
  if (!skillsDir) {
    safeLog({ level: 'info', msg: 'ecc_index_skipped', reason: 'cache_not_found' });
    return _eccIndexCache;
  }

  // ---- DISK CACHE: try warm path first ----------------------------------------
  try {
    const currentSig = _buildEccSignature(skillsDir);
    if (currentSig !== null) {
      let cacheHit = false;
      try {
        const raw = fs.readFileSync(ECC_DISK_CACHE_PATH, 'utf8');
        const cached = JSON.parse(raw);
        const { signature, entries } = cached;
        if (
          signature &&
          typeof signature.count === 'number' &&
          typeof signature.maxMtimeMs === 'number' &&
          signature.count === currentSig.count &&
          signature.maxMtimeMs === currentSig.maxMtimeMs &&
          Array.isArray(entries)
        ) {
          for (const [key, value] of entries) {
            _eccIndexCache.set(key, value);
          }
          cacheHit = true;
          safeLog({ level: 'info', msg: 'ecc_index_from_disk_cache', count: _eccIndexCache.size });
        }
      } catch (_) {
        // cache absent, corrupt, or unexpected shape — fall through to re-scan
      }

      if (cacheHit) return _eccIndexCache;
    }
  } catch (_) {
    // any unexpected error in the cache fast-path — fall through to re-scan
  }
  // ---- END DISK CACHE fast path ------------------------------------------------

  let scanned = 0;
  let indexed = 0;

  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      scanned++;

      // Derive the canonical skill name (strip ".disabled" suffix if present)
      const folderName = entry.name;
      const skillName = folderName.endsWith('.disabled')
        ? folderName.slice(0, -'.disabled'.length)
        : folderName;

      const skillPath = path.join(skillsDir, folderName, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      let content = '';
      try {
        content = fs.readFileSync(skillPath, 'utf8');
      } catch (_) {
        // unreadable — use folder name as fallback
      }

      const tokens = parseEccSkillTokens(content, skillName);

      _eccIndexCache.set(normalize(skillName), {
        skillPath,
        tokens,
      });
      indexed++;
    }
  } catch (_err) {
    safeLog({ level: 'warn', msg: 'ecc_index_scan_error', error: String(_err && _err.message) });
  }

  safeLog({
    level: 'info',
    msg: 'ecc_index_built',
    scanned,
    indexed,
    skills_dir: skillsDir,
  });

  // ---- DISK CACHE: persist to disk for next run (best-effort, never throws) ----
  try {
    const sigToWrite = _buildEccSignature(skillsDir);
    if (sigToWrite !== null) {
      const cachePayload = JSON.stringify({
        signature: sigToWrite,
        entries: Array.from(_eccIndexCache.entries()),
      });
      fs.writeFileSync(ECC_DISK_CACHE_PATH, cachePayload, 'utf8');
      safeLog({ level: 'info', msg: 'ecc_index_cache_written', path: ECC_DISK_CACHE_PATH });
    }
  } catch (_) {
    // write failure is non-fatal — cache will be rebuilt on the next run
  }
  // ---- END DISK CACHE write ----------------------------------------------------

  return _eccIndexCache;
}

/**
 * Find the best-matching ECC skill for a given prompt.
 *
 * Uses the same scoreEntry() logic as the main ranker but operates on the
 * separate ECC index — ECC candidates never enter rankCandidates() and
 * therefore cannot inflate or displace the main routing results.
 *
 * Only returns a result when the raw score meets ECC_MATCH_MIN_RAW, which
 * requires at minimum a meaningful combination of token hits (not a single
 * stray context word).
 *
 * @param {string} promptNorm  Already-normalized prompt (output of normalize()).
 * @returns {{ id: string, skillPath: string, score: number }|null}
 */
/**
 * Pattern identifying ECC planning/orchestration skills that qualify for the
 * lowered re-injection threshold (iter-10 FASE 7).
 *
 * "architecture" suelto NO califica: arrastraba `hexagonal-architecture` (patrón
 * de IMPLEMENTACIÓN, no planning) al floor rebajado de 50, donde verbos genéricos
 * de un prompt TDD lo cruzaban (score 60) -> falso positivo ECC (cat4.2). Solo
 * `architecture-decision`/ADR son planning real.
 */
const ECC_PLANNING_ID_RE = /plan|spec|prd|design|architecture-decision|adr/i;

/**
 * Lowered raw-score floor applied ONLY to ECC skills whose id matches
 * ECC_PLANNING_ID_RE. The global ECC_MATCH_MIN_RAW (70) stays intact so the
 * ~230 non-planning ECC skills cannot leak in at a lower bar.
 */
const ECC_PLANNING_MATCH_MIN_RAW = 50;

function matchBestEccSkill(promptNorm) {
  const index = scanEccSkills();
  if (index.size === 0) return null;

  let best = null;
  let bestScore = 0;
  let bestIsPlanning = false;

  for (const [normId, entry] of index) {
    const { score } = scoreEntry(promptNorm, entry.tokens);
    if (score > bestScore) {
      bestScore = score;
      bestIsPlanning = ECC_PLANNING_ID_RE.test(normId);
      best = { id: normId, skillPath: entry.skillPath, score };
    }
  }

  // Conditional floor: planning ECC skills clear at 50, everything else at 70.
  const floor = bestIsPlanning ? ECC_PLANNING_MATCH_MIN_RAW : ECC_MATCH_MIN_RAW;
  if (!best || bestScore < floor) return null;
  return best;
}

// ---------------------------------------------------------------------------
// v2: Lazy skill injection helpers
// ---------------------------------------------------------------------------

/**
 * Load and cache the skills registry from disk.
 * Returns null on any failure (graceful fallback).
 * @returns {Array<Object>|null}
 */
function loadRegistry() {
  if (_registryCache !== null) return _registryCache;
  try {
    const raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
    _registryCache = JSON.parse(raw);
    return _registryCache;
  } catch (_) {
    _registryCache = [];
    return null;
  }
}

/**
 * Check whether a candidate skill id is marked lazy_loadable in the registry.
 *
 * Matching strategy (namespaced ids like "superpowers:brainstorming"):
 *   1. Try the full namespaced id  → registry entry id === "superpowers:brainstorming"
 *   2. Try the base name (after ':') → registry entry id === "brainstorming"
 *   3. Try the namespace (before ':') → registry entry id === "superpowers"
 * This ensures plugin skills registered under their namespace folder are found.
 *
 * @param {string} skillId
 * @returns {boolean}
 */
function isLazyLoadable(skillId) {
  const registry = loadRegistry();
  if (!registry) return false;

  const hasColon = skillId.includes(':');
  const nsPrefix = hasColon ? skillId.split(':')[0] : null;  // "superpowers"
  const baseName = hasColon ? skillId.split(':')[1] : skillId; // "brainstorming"

  const entry = registry.find(function (r) {
    // 1. Exact full id match ("superpowers:brainstorming")
    if (r.id === skillId) return true;
    // 2. Base name match ("brainstorming")
    if (r.id === baseName) return true;
    // 3. Namespace folder match ("superpowers") — covers the namespace-level SKILL.md
    if (nsPrefix && r.id === nsPrefix) return true;
    return false;
  });
  return entry ? entry.lazy_loadable === true : false;
}

/**
 * Check cooldown: returns true if the skill was injected within the last
 * LAZY_COOLDOWN_INVOCATIONS calls and should be suppressed this round.
 * @param {string} skillId
 * @returns {boolean}
 */
function isCoolingDown(skillId) {
  const lastInjected = _injectionHistory.get(skillId);
  if (lastInjected === undefined) return false;
  return (_invocationCounter - lastInjected) < LAZY_COOLDOWN_INVOCATIONS;
}

/**
 * Record that a skill was injected in this invocation.
 * @param {string} skillId
 */
function recordInjection(skillId) {
  _injectionHistory.set(skillId, _invocationCounter);
}

/** Compare dotted version strings numerically: compareVersions("1.10.0","1.9.0") > 0. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(function (n) { return parseInt(n, 10) || 0; });
  const pb = String(b).split('.').map(function (n) { return parseInt(n, 10) || 0; });
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Locate a plugin sub-skill's own SKILL.md inside the plugin cache, picking the
 * highest installed version. Plugin skills live at:
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/<subskill>/SKILL.md
 * @param {string} nsPrefix  plugin name (e.g. "superpowers")
 * @param {string} baseName  sub-skill name (e.g. "test-driven-development")
 * @returns {string|null} absolute path, or null if not found
 */
function resolvePluginSkillMd(nsPrefix, baseName) {
  const cacheRoot = path.join(HOME, '.claude', 'plugins', 'cache');
  let marketplaces;
  try {
    marketplaces = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch (_e) {
    return null;
  }
  const found = [];
  for (const mk of marketplaces) {
    if (!mk.isDirectory()) continue;
    const pluginDir = path.join(cacheRoot, mk.name, nsPrefix);
    let versions;
    try {
      versions = fs.readdirSync(pluginDir, { withFileTypes: true });
    } catch (_e) {
      continue;
    }
    for (const v of versions) {
      if (!v.isDirectory()) continue;
      // RT-05 (auditoria 2026-07-16): no todos los plugins usan skills/<name>/
      // SKILL.md — commit-commands, feature-dev, pr-review-toolkit y code-review
      // guardan su contenido en commands/<name>.md o agents/<name>.md. Probar
      // los tres layouts reales en orden de especificidad.
      const layouts = [
        path.join(pluginDir, v.name, 'skills', baseName, 'SKILL.md'),
        path.join(pluginDir, v.name, 'commands', baseName + '.md'),
        path.join(pluginDir, v.name, 'agents', baseName + '.md'),
      ];
      for (const p of layouts) {
        if (fs.existsSync(p)) { found.push({ version: v.name, path: p }); break; }
      }
    }
  }
  if (found.length === 0) return null;
  found.sort(function (a, b) { return compareVersions(b.version, a.version); });
  return found[0].path;
}

/**
 * Resolve the SKILL.md path for a given skill id.
 *
 * Namespaced resolution ("superpowers:brainstorming"):
 *   Primary:   skills/superpowers/brainstorming/SKILL.md  (sub-skill inside namespace folder)
 *   Secondary: skills/superpowers/SKILL.md                (namespace-level catch-all)
 *
 * Non-namespaced resolution ("brainstorming"):
 *   Primary:   skills/brainstorming/SKILL.md
 *
 * Each candidate is also tried with the `.disabled` suffix that apply-lazy-skills.ps1
 * uses when deactivating a skill folder (folder renamed to `<name>.disabled`).
 *
 * @param {string} skillId
 * @returns {string}
 */
function resolveSkillMdPath(skillId) {
  const hasColon = skillId.includes(':');

  if (hasColon) {
    const [nsPrefix, baseName] = skillId.split(':', 2);
    // 1-2. Sub-skill inside ~/.claude/skills (active / disabled).
    const local = [
      path.join(SKILLS_DIR, nsPrefix, baseName, 'SKILL.md'),
      path.join(SKILLS_DIR, nsPrefix, baseName + '.disabled', 'SKILL.md'),
    ];
    for (const candidate of local) {
      if (fs.existsSync(candidate)) return candidate;
    }
    // 3. Plugin-cache sub-skill (canonical home of namespaced plugin skills como
    //    superpowers:test-driven-development). DEBE ir ANTES del catch-all de
    //    namespace: si no, un superpowers:* cae en skills/superpowers.disabled/
    //    SKILL.md (name: superpowers) y el modelo recibe el manifiesto genérico
    //    del plugin en vez de la guía pedida (cat4.1).
    const pluginPath = resolvePluginSkillMd(nsPrefix, baseName);
    if (pluginPath) return pluginPath;
    // RT-05 (auditoria 2026-07-16): catch-all de namespace ELIMINADO — para un
    // sub-skill fantasma inyectaba el manifiesto generico del plugin (contenido
    // EQUIVOCADO). Mejor no inyectar nada: el path no confirmado falla graceful.
    return local[0];
  }

  // Non-namespaced: try disabled variant first (active after apply-lazy-skills.ps1),
  // then active folder.
  const disabled = path.join(SKILLS_DIR, skillId + '.disabled', 'SKILL.md');
  if (fs.existsSync(disabled)) return disabled;
  return path.join(SKILLS_DIR, skillId, 'SKILL.md');
}

/**
 * Read a file with a hard timeout. Resolves to the file content string, or
 * null if the read fails or times out.
 * @param {string} filePath
 * @param {number} timeoutMs
 * @returns {Promise<string|null>}
 */
function readWithTimeout(filePath, timeoutMs) {
  return new Promise(function (resolve) {
    let settled = false;

    const timer = setTimeout(function () {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, timeoutMs);

    fs.promises.readFile(filePath, 'utf8').then(
      function (content) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(content);
        }
      },
      function (_err) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(null);
        }
      }
    );
  });
}

/**
 * Attempt to load SKILL.md content for a set of candidates in parallel,
 * respecting cooldown and lazy_loadable flags.
 *
 * Option B — ECC re-injection: when the main top candidate has HIGH confidence
 * AND a matching ECC skill is found (score >= ECC_MATCH_MIN_RAW), that ECC
 * skill's SKILL.md is also read and appended.  ECC candidates never enter the
 * main ranking pool — they are consulted only here, after the winner is known.
 *
 * Returns a Map<skillId, string> with only the skills successfully read.
 * Skills that fail, time out, or are on cooldown are absent from the map.
 *
 * @param {Array<{id: string, confidence: number, kind: string}>} candidates
 * @param {string} [promptNorm]  Already-normalized prompt, used for ECC lookup.
 * @returns {Promise<Map<string, string>>}
 */
async function fetchLazySkillContent(candidates, promptNorm) {
  const result = new Map();

  // iter-10 FASE 7: planning/orchestration prompts may inject a small allowlist
  // of planning skills even when their confidence sits in [PLANNING_LAZY_FLOOR,
  // LAZY_SCORE_THRESHOLD). Everything else stays gated at LAZY_SCORE_THRESHOLD.
  const planningPrompt =
    typeof promptNorm === 'string' && promptHasStrongPlanningKeyword(promptNorm);

  // Filter to skills that qualify for lazy injection
  const eligible = candidates.filter(function (c) {
    const isPlanningSkill =
      planningPrompt && PLANNING_LAZY_SKILLS.has(c.id);
    const floor = isPlanningSkill ? PLANNING_LAZY_FLOOR : LAZY_SCORE_THRESHOLD;
    if (c.confidence < floor) return false;
    if (c.kind !== 'plugin' && c.kind !== 'persona') return false; // personas y plugins tienen SKILL.md en skills/; los agents viven en agents/ (excluidos via isLazyLoadable)
    // Planning allowlist skills bypass the registry lazy_loadable gate so they
    // can be injected on-demand for explicit planning intent.
    if (!isPlanningSkill && !isLazyLoadable(c.id)) return false;
    if (isCoolingDown(c.id)) return false;
    return true;
  });

  // Cap por confianza: ordena desc y recorta la cola. El corte se LOGUEA (mandamiento
  // 11: nunca silencioso) para poder auditar que se dejo fuera. El ECC re-injection de
  // abajo es +1 condicional aparte (top confidence >=0.80, 1 solo), no entra en el cap.
  eligible.sort(function (a, b) { return b.confidence - a.confidence; });
  if (eligible.length > MAX_LAZY_INJECTIONS) {
    const droppedByCap = eligible.slice(MAX_LAZY_INJECTIONS);
    eligible.length = MAX_LAZY_INJECTIONS;
    safeLog({
      level: 'info',
      msg: 'lazy_injection_capped',
      cap: MAX_LAZY_INJECTIONS,
      kept_ids: eligible.map(function (c) { return c.id; }),
      dropped_ids: droppedByCap.map(function (c) { return c.id; }),
      dropped: droppedByCap.length,
    });
  }

  // --- Option B: ECC on-demand re-injection ---
  // Only attempted when the main top candidate is HIGH confidence and a
  // normalised prompt is available.  The ECC index is consulted on its own
  // separate path — it does not affect eligible[] above.
  let eccCandidate = null;
  const topCandidate = candidates[0] || null;
  if (
    promptNorm &&
    topCandidate &&
    topCandidate.confidence >= HIGH_THRESHOLD
  ) {
    try {
      eccCandidate = matchBestEccSkill(promptNorm);
    } catch (_) {
      // ECC lookup failure is always silent
    }
  }

  if (eligible.length === 0 && !eccCandidate) {
    // Still log the attempt so compute-metrics.py can track injection_rate = 0 cases
    safeLog({
      level: 'info',
      msg: 'lazy_injection_attempted',
      candidates: candidates.length,
      eligible: eligible.length,
      injected: 0,
      ecc_candidate: null,
    });
    return result;
  }

  // Read all eligible in parallel (single Promise.all, bounded by timeout each).
  // cat9.4: check _skillMdCache first — avoids re-reading files already loaded
  // in this process (across multiple hook invocations in the same session).
  const reads = eligible.map(async function (c) {
    const skillPath = resolveSkillMdPath(c.id);
    if (_skillMdCache.has(skillPath)) {
      return { id: c.id, content: _skillMdCache.get(skillPath) };
    }
    const content = await readWithTimeout(skillPath, LAZY_READ_TIMEOUT_MS);
    if (content !== null) _skillMdCache.set(skillPath, content);
    return { id: c.id, content };
  });

  // Append ECC read if a candidate was found and is not cooling down
  if (eccCandidate && !isCoolingDown('ecc:' + eccCandidate.id)) {
    reads.push(
      (function () {
        const eccPath = eccCandidate.skillPath;
        if (_skillMdCache.has(eccPath)) {
          return Promise.resolve({ id: 'ecc:' + eccCandidate.id, content: _skillMdCache.get(eccPath) });
        }
        return readWithTimeout(eccPath, LAZY_READ_TIMEOUT_MS).then(function (content) {
          if (content !== null) _skillMdCache.set(eccPath, content);
          return { id: 'ecc:' + eccCandidate.id, content };
        });
      })()
    );
  }

  const settled = await Promise.all(reads);

  for (const item of settled) {
    if (item.content !== null) {
      result.set(item.id, item.content);
      recordInjection(item.id);
    }
  }

  // Telemetry: log final injection outcome with {candidates, eligible, injected}
  safeLog({
    level: 'info',
    msg: 'lazy_injection_attempted',
    candidates: candidates.length,
    eligible: eligible.length,
    injected: result.size,
    injected_ids: Array.from(result.keys()),
    ecc_candidate: eccCandidate ? eccCandidate.id : null,
    ecc_score: eccCandidate ? eccCandidate.score : null,
  });

  return result;
}

/**
 * Presupuesto TOTAL de caracteres de contenido SKILL.md inyectado por prompt.
 * El cap de MAX_LAZY_INJECTIONS solo limita el NÚMERO de skills, no su tamaño:
 * un único SKILL.md grande (rust-patterns ~13.7k, ecc:django-security ~16.4k)
 * reventaba el additionalContext (cat4.6, techo 12k). La inyección lazy existe
 * para AHORRAR contexto, no para volcar 16k de golpe -> se trunca con marcador.
 */
const INJECT_CHAR_BUDGET = 10000;

/**
 * Build the injection block appended after the routing hint.
 * @param {Map<string, string>} injectedSkills
 * @returns {string}
 */
function buildInjectionBlock(injectedSkills) {
  if (injectedSkills.size === 0) return '';

  const parts = [];
  // Dedup por CONTENIDO (Pass3 2026-06-10): el candidato ECC puede entrar con
  // un id distinto pero el MISMO SKILL.md que la via eligible -> ~1.4k tokens
  // duplicados por prompt. El Map dedup por id no lo caza; esto si.
  const seenContent = new Set();
  let used = 0;
  for (const [skillId, content] of injectedSkills) {
    const trimmed = content.trim();
    if (seenContent.has(trimmed)) continue;
    seenContent.add(trimmed);

    const remaining = INJECT_CHAR_BUDGET - used;
    if (remaining <= 0) break; // presupuesto agotado -> no inyectar más skills

    let body = trimmed;
    if (body.length > remaining) {
      // Reserva ~160 chars para el marcador; trunca el cuerpo al resto.
      const cut = Math.max(0, remaining - 160);
      body =
        trimmed.slice(0, cut).trimEnd() +
        '\n\n[... SKILL.md truncado por presupuesto de contexto (' +
        trimmed.length +
        ' chars); abre el archivo completo si necesitas el resto ...]';
    }
    used += body.length;
    parts.push(
      '\n\n--- [skill-inyectada: ' + skillId + '] ---\n' +
      body +
      '\n--- [fin skill-inyectada: ' + skillId + '] ---'
    );
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Main entry point (v2: async to support lazy reads)
// ---------------------------------------------------------------------------

async function main() {
  _invocationCounter++;

  const stdinRaw = readStdinSafe();
  let payload = {};
  try {
    payload = stdinRaw ? JSON.parse(stdinRaw) : {};
  } catch (_) {
    return emitContext('');
  }

  const prompt = String(payload.prompt || payload.user_prompt || '').trim();
  if (!prompt) {
    return emitContext('');
  }

  // Turno de SISTEMA (notificacion de tarea background): no rutear — su XML
  // matchea triggers al azar e inyectaria skills sin sentido.
  if (isSystemTurnPrompt(prompt)) {
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
    return emitContext('');
  }

  // v2: attempt lazy skill injection when top candidate scores >= threshold
  // Pass promptNorm so fetchLazySkillContent can run the ECC on-demand lookup.
  const promptNorm = normalize(prompt).slice(0, MAX_PROMPT_CHARS);
  if (top.confidence >= LAZY_SCORE_THRESHOLD) {
    try {
      const injectedSkills = await fetchLazySkillContent(ranked, promptNorm);
      if (injectedSkills.size > 0) {
        const injectionBlock = buildInjectionBlock(injectedSkills);
        text = text + injectionBlock;
        safeLog({
          level: 'info',
          msg: 'lazy_skill_injected',
          skills: Array.from(injectedSkills.keys()),
          invocation: _invocationCounter,
        });
      }
    } catch (_err) {
      // Graceful fallback: injection failure does not affect the routing hint
      safeLog({ level: 'warn', msg: 'lazy_injection_failed', error: String(_err && _err.message) });
    }
  }

  emitContext(text);
}

// Only run the hook when executed directly (not when require()'d by tests).
if (require.main === module) {
  main().catch(function (err) {
    safeLog({ level: 'error', msg: 'unhandled_async', error: String(err && err.message) });
    try { _logHookError('routing-dispatcher.v2', err); } catch (_) {}
    emitContext('');
  }).finally(function () {
    process.exitCode = 0;
  });
}

// Exported for unit tests.
module.exports = {
  hasToken,
  normalize,
  scoreEntry,
  rankCandidates,
  isLazyLoadable,
  isCoolingDown,
  fetchLazySkillContent,
  buildInjectionBlock,
  // workspace autodiscovery
  loadWorkspaceCandidates,
  scanUltronSkills,
  scanProjectRosters,
  parseSkillMdTokens,
  parseEccSkillTokens,
  // ECC on-demand index (Option B)
  resolveEccSkillsDir,
  scanEccSkills,
  matchBestEccSkill,
  // expose internals for test isolation
  _injectionHistory,
  _skillMdCache,
  _resetInvocationCounter: function () { _invocationCounter = 0; },
  _resetWorkspaceCache: function () { _workspaceCandidatesCache = null; },
  _resetEccIndexCache: function () { _eccIndexCache = null; },
  _resetSkillMdCache: function () { _skillMdCache.clear(); },
  // Advance the process-wide invocation counter. Callers that reuse v2's
  // lazy-injection machinery WITHOUT going through v2.main() (e.g. v3.mainV3)
  // must call this once per logical invocation so the cooldown window
  // (isCoolingDown / recordInjection) sees a monotonically increasing counter.
  _incrementInvocationCounter: function () { return ++_invocationCounter; },
};
