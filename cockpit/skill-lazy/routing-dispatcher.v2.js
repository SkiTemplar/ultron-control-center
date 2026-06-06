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
const LOG_PATH = path.join(HOME, '.claude', 'logs', 'routing-dispatcher.jsonl');
const SKILLS_DIR = path.join(HOME, '.claude', 'skills');
const REGISTRY_PATH = path.join(HOME, '.ultron', 'cockpit', 'skill-lazy', 'skills-registry.json');

const MAX_PROMPT_CHARS = 4000;
const HIGH_THRESHOLD = 0.80;
const MED_THRESHOLD = 0.50;

// Lazy injection settings
const LAZY_SCORE_THRESHOLD = 0.80;
const LAZY_READ_TIMEOUT_MS = 5000;
const LAZY_COOLDOWN_INVOCATIONS = 2;

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
    id: 'profesor-fisica',
    persona: 'profesor-fisica',
    triggers: ['profesor de fisica', 'profesor fisica', 'modo fisica'],
    strong: ['cinematica', 'solido rigido', 'examen fisica', 'momento angular', 'tensor de inercia'],
    context: ['fisica', 'dinamica', 'colisiones', 'mecanica', 'energia'],
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
    id: 'manolo-lama',
    persona: 'manolo-lama',
    triggers: ['manolo lama', 'manolo-lama'],
    strong: ['champions league', 'la liga', 'partido de futbol'],
    context: ['futbol', 'gol', 'champions', 'liga', 'deportes'],
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
  { id: 'second-opinion',                    triggers: ['second opinion', 'codex review', 'gemini review', '/second-opinion'], strong: ['external review', 'segunda opinion'],              context: ['codex', 'gemini'] },
  // Debugging / quality
  { id: 'superpowers:systematic-debugging',  triggers: ['systematic debugging'],                              strong: ['bug sin causa obvia', 'no encuentro el bug', 'debug sistematico'],          context: ['bug intermitente', 'debugging'] },
  { id: 'focused-fix',                       triggers: ['focused fix', 'haz que funcione'],                   strong: ['feature rota', 'modulo con fallos en cascada'],                            context: ['reparar feature', 'fix de modulo'] },
  // Testing
  { id: 'superpowers:test-driven-development', triggers: ['tdd', 'test-driven development'],                  strong: ['escribe los tests primero', 'red green refactor'],                         context: ['testing', 'pruebas unitarias', 'cobertura de tests'] },
  { id: 'webapp-testing',                    triggers: ['playwright', 'webapp testing', 'e2e'],               strong: ['test web app local', 'browser snapshot'],                                  context: ['e2e', 'browser testing', 'ui testing'] },
  { id: 'mutation-testing',                  triggers: ['mutation testing', 'mutantes en tests'],             strong: ['mutation score', 'stryker', 'pitest', 'mutpy'],                            context: ['test calidad', 'test robustez'] },
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
  { id: 'superpowers:context-window-manager', triggers: ['context window manager', 'gestiona el contexto'], strong: ['context compression', 'context budget'],                                  context: ['contexto', 'tokens'] },
  { id: 'data-analyst',                      triggers: ['data analyst', 'analiza los datos'],               strong: ['pandas analysis', 'exploratory data analysis', 'data visualization', 'seaborn'], context: ['datos', 'csv', 'dataframe'] },
  { id: 'technical-writer',                  triggers: ['technical writer', 'redacta documentacion'],       strong: ['api reference docs', 'technical writing', 'changelog generation'],        context: ['documentacion tecnica', 'docs'] },
  { id: 'product-manager',                   triggers: ['product manager', 'pm mode'],                      strong: ['product roadmap', 'user story', 'acceptance criteria pm', 'prd'],         context: ['producto', 'roadmap', 'features'] },
  { id: 'senior-engineer',                   triggers: ['senior engineer', 'senior mode'],                  strong: ['engineering decision', 'senior review', 'tech lead'],                     context: ['ingenieria', 'decision tecnica'] },
  { id: 'superpowers:code-review',           triggers: ['superpowers code review'],                         strong: ['automated code quality gate', 'superpowers review'],                      context: ['review automatico'] },
  { id: 'superpowers:research',              triggers: ['research mode', '/research'],                       strong: ['literature search', 'technical research', 'state of the art research'], context: ['investigar', 'buscar informacion'] },
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
  { id: 'context-budget',                    triggers: ['context budget', 'audita el contexto'],             strong: ['context window consumption', 'context bloat', 'context audit'],            context: ['ventana de contexto', 'consumo de contexto'] },
  { id: 'windows-admin',                     triggers: ['windows admin'],                                    strong: ['winget install', 'scheduled task windows', 'windows service', 'windows registry'], context: ['administrador de windows', 'windows-mcp'] },
  { id: 'business-strategist',               triggers: ['business strategist'],                              strong: ['b2b saas', 'go-to-market', 'icp definition', 'market validation', 'investor deck'], context: ['estrategia de negocio', 'saas pricing'] },
  { id: 'search-first',                      triggers: ['search first', 'search-first', 'busca antes de codear'], strong: ['research before coding', 'existing library first'],                   context: ['buscar libreria existente'] },
  { id: 'council',                           triggers: ['council', 'convoca el council', 'four-voice council'], strong: ['structured disagreement', 'go/no-go call'],                              context: ['decision ambigua', 'tradeoff'] },
  { id: 'hiper-plans',                       triggers: ['hiper plan', 'hyper plan', 'hiperplan', 'plan profundo', 'deep plan', 'planifica exhaustivamente'], strong: ['spec driven plan', 'deep plan'],   context: ['planificacion compleja'] },
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
  // Lowercase + strip diacritics so "codigo" matches "codigo".
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
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

function scoreEntry(promptNorm, entry) {
  let score = 0;
  const matched = [];

  for (const t of entry.triggers || []) {
    if (hasToken(promptNorm, t)) {
      score += W_TRIGGER;
      matched.push('trigger:' + t);
    }
  }
  for (const t of entry.strong || []) {
    if (hasToken(promptNorm, t)) {
      score += W_STRONG;
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
    // Candidates in priority order
    const candidates = [
      // 1. Sub-skill path: skills/superpowers/brainstorming/SKILL.md
      path.join(SKILLS_DIR, nsPrefix, baseName, 'SKILL.md'),
      // 2. Sub-skill disabled: skills/superpowers/brainstorming.disabled/SKILL.md
      path.join(SKILLS_DIR, nsPrefix, baseName + '.disabled', 'SKILL.md'),
      // 3. Namespace-level active: skills/superpowers/SKILL.md
      path.join(SKILLS_DIR, nsPrefix, 'SKILL.md'),
      // 4. Namespace folder disabled: skills/superpowers.disabled/SKILL.md
      path.join(SKILLS_DIR, nsPrefix + '.disabled', 'SKILL.md'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    // Fall back to namespace folder even if not confirmed to exist (will fail gracefully)
    return candidates[0];
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
 * Returns a Map<skillId, string> with only the skills successfully read.
 * Skills that fail, time out, or are on cooldown are absent from the map.
 *
 * @param {Array<{id: string, confidence: number, kind: string}>} candidates
 * @returns {Promise<Map<string, string>>}
 */
async function fetchLazySkillContent(candidates) {
  const result = new Map();

  // Filter to skills that qualify for lazy injection
  const eligible = candidates.filter(function (c) {
    if (c.confidence < LAZY_SCORE_THRESHOLD) return false;
    if (c.kind !== 'plugin' && c.kind !== 'persona') return false; // personas y plugins tienen SKILL.md en skills/; los agents viven en agents/ (excluidos via isLazyLoadable)
    if (!isLazyLoadable(c.id)) return false;
    if (isCoolingDown(c.id)) return false;
    return true;
  });

  if (eligible.length === 0) {
    // Still log the attempt so compute-metrics.py can track injection_rate = 0 cases
    safeLog({
      level: 'info',
      msg: 'lazy_injection_attempted',
      candidates: candidates.length,
      eligible: eligible.length,
      injected: 0,
    });
    return result;
  }

  // Read all eligible in parallel (single Promise.all, bounded by timeout each)
  const reads = eligible.map(async function (c) {
    const skillPath = resolveSkillMdPath(c.id);
    const content = await readWithTimeout(skillPath, LAZY_READ_TIMEOUT_MS);
    return { id: c.id, content };
  });

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
  });

  return result;
}

/**
 * Build the injection block appended after the routing hint.
 * @param {Map<string, string>} injectedSkills
 * @returns {string}
 */
function buildInjectionBlock(injectedSkills) {
  if (injectedSkills.size === 0) return '';

  const parts = [];
  for (const [skillId, content] of injectedSkills) {
    parts.push(
      '\n\n--- [skill-inyectada: ' + skillId + '] ---\n' +
      content.trim() +
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
  if (top.confidence >= LAZY_SCORE_THRESHOLD) {
    try {
      const injectedSkills = await fetchLazySkillContent(ranked);
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
  // expose internals for test isolation
  _injectionHistory,
  _resetInvocationCounter: function () { _invocationCounter = 0; },
  // Advance the process-wide invocation counter. Callers that reuse v2's
  // lazy-injection machinery WITHOUT going through v2.main() (e.g. v3.mainV3)
  // must call this once per logical invocation so the cooldown window
  // (isCoolingDown / recordInjection) sees a monotonically increasing counter.
  _incrementInvocationCounter: function () { return ++_invocationCounter; },
};
