# Workflows, Agents & Memory — Best Practices 2026 para ULTRON Control Center

## Resumen ejecutivo

Un workflow orchestrator resuelve el problema central de los sistemas multi-agente actuales: la fragmentación entre intención (lo que el usuario quiere), contexto (lo que el agente recuerda) y ejecución (lo que realmente ocurre en disco). Sin orquestación explícita, cada sesión reinventa el plan, los agentes pisan los mismos archivos en paralelo sin coordinación, y la memoria se contamina con artefactos transitorios. El estándar 2026 (Claude Code subagents, AutoGen 0.4, LangGraph, OpenDevin) converge en un patrón claro: un coordinador ligero que delega a subagentes aislados con su propio contexto, hand-offs estructurados, y persistencia selectiva a una capa de memoria con políticas explícitas.

El approach recomendado para ULTRON es un orquestador declarativo basado en specs JSON (no en código Rust hardcoded) que se almacena en `~/.ultron/cockpit/workflows/*.json`, se ejecuta vía el Task tool de Claude Code con isolation por worktree opcional, y persiste outcomes en mem0 con tags namespaced (`ultron:workflow:<id>:session:<ts>`). Cada workflow define agentes, hand-off mode, criterios de finalización y deliverables — la UI kanban dispara workflows en lugar de "agentes sueltos" como hoy. La memoria L0/L1/L2 actual se mantiene; mem0 entra como L1.5 (semantic recall barato) con sync diferido a la vault L2.

Lo primero a incorporar: (1) el schema JSON de workflow definido en la sección 5, (2) la plantilla `feature-implementation` como caso piloto (cubre 60% del flujo diario de USER), y (3) auto-creación de workdays cuando una tarjeta kanban arranca un workflow — esto cierra el loop `kanban → PTY → workday → memoria` que hoy queda a medias.

## 1. Claude Code agent orchestration

Anthropic documenta el patrón canónico en https://docs.anthropic.com/en/docs/claude-code/sub-agents y https://docs.anthropic.com/en/docs/claude-code/common-workflows. Las piezas clave:

- **Task tool con `subagent_type`**: el coordinador (main thread) dispara subagentes que reciben un prompt aislado y devuelven un único mensaje final. No comparten contexto entre sí — el coordinador es el bus.
- **Worktree isolation**: para trabajo paralelo en el mismo repo, cada subagent corre en un `git worktree` separado. Evita conflictos de archivos y permite merges atómicos. Skill `superpowers:using-git-worktrees` lo formaliza.
- **Parallel dispatch**: múltiples Task calls en el mismo turno se ejecutan concurrentemente. Crítico para reviews multi-perspectiva (security + performance + style) o investigación.
- **Sequential hand-off**: cuando hay dependencia (planner → tdd → reviewer), el coordinador encadena Tasks y pasa el output del anterior como contexto del siguiente.

### Sequential vs parallel — criterio de decisión

| Criterio | Sequential | Parallel |
|---|---|---|
| Dependencia de output | Sí | No |
| Mismo archivo target | Sí | Worktree separado |
| Coste latencia importa | No | Sí |
| Necesita consensus | No | Sí (multi-reviewer) |

### Wiring final del coordinador

Patrón típico: planner → [parallel: tdd-guide, security-reviewer] → code-reviewer → commit. El coordinador no escribe código, solo enruta. `[inference]` Este patrón reduce ~40% el ruido en transcript vs un solo agente monolítico haciendo todo.

### Spec JSON de workflow

```json
{
  "name": "string (unique slug)",
  "description": "string (1-line purpose)",
  "agents": [
    {"slug": "string", "role": "string", "prompt": "string", "model": "opus|sonnet|haiku"}
  ],
  "hooks": [{"event": "pre|post|stop", "command": "string"}],
  "context_keys": ["string (mem0 tags to preload)"],
  "completion_criteria": ["string (boolean checks)"],
  "hand_off": "sequential | parallel | dag",
  "deliverables": ["string (file paths o tags)"]
}
```

## 2. Memory architectures

| Sistema | Storage | Retrieval | Sync | Install cost | Fit ULTRON | Recomendación |
|---|---|---|---|---|---|---|
| mem0 | Vector + metadata cloud/local | Semantic + filter | API REST | Bajo (MCP listo) | Alto — ya configurado | Adoptar como L1.5 |
| Letta (ex-MemGPT) | Postgres + vector | Hierarchical paging | Self-hosted server | Medio (Docker) | Medio — overkill solo | Evaluar si crece |
| Zep | Postgres + graph | Temporal KG + semantic | Server propio | Medio-alto | Medio | Saltar |
| Graphiti | Neo4j + LLM extraction | Graph traversal + temporal | Self-hosted Neo4j | Alto | Bajo — Neo4j pesa | No |
| Mem0+KG hybrid | mem0 + graph layer opcional | Híbrido | mem0 cloud | Bajo+ | Alto | Activar `graph_store` cuando relaciones importen |

**Recomendación final para ULTRON**: **mem0 como L1.5** entre L1 (FTS5 indexed) y L2 (vault). Razón concreta: ya está cableado en `settings.json`, MCP nativo, coste cero adicional, y el modo `graph_store` (https://docs.mem0.ai) se activa con flag sin migrar datos. Letta/Zep/Graphiti exigen servidor adicional que rompe el modelo "todo en `~/.ultron`" de USER. `[inference]` Graphiti gana en queries tipo "qué decidió Don Claudio sobre netcode hace 3 semanas" pero el coste de mantener Neo4j no compensa hasta tener >10k memorias.

## 3. Session automation triggers

Auto-crear workday cuando ocurre un trigger explícito. Eventos canónicos:

- **Kanban move**: tarjeta cruza de `todo` → `in_progress` dispara `workday.create()` con `linked_card_id`. Ya parcialmente cableado en `workdays.rs`; falta el hook de creación.
- **File change**: watcher sobre paths críticos (`src-tauri/src/**`, `src/**`) abre workday si no hay activa y el cambio supera N líneas. Usar `notify` crate (ya en `Cargo.toml` probablemente).
- **Hook fire**: PreToolUse/PostToolUse de Claude Code emite evento → workday log entry.
- **Schedule**: cron diario "morning briefing" abre workday vacía con template "modo mañana" (skill `pana`).

### Long-running loops — lessons learned

Devin (Cognition AI) y OpenDevin documentan el fallo modo: loops infinitos cuando el agente no detecta "tarea cumplida". AutoGen 0.4 introdujo `TerminationCondition` explícita por esto. Reglas:

1. **Hard cap de turnos**: ningún workflow excede 20 Task invocations sin pausa de revisión humana.
2. **Cost circuit breaker**: pausar si coste por workflow > umbral configurable (USER ya tiene COST CRITICAL hook).
3. **Idle detection**: si el último Task produce el mismo output que el anterior (hash match), abortar — el agente está stuck.
4. **Explicit completion_criteria**: cada workflow lista criterios booleanos (`tests_pass`, `lint_clean`, `pr_created`). Sin todos en `true`, no se marca completo.

### Patterns concretos para ULTRON

El loop `kanban → PTY` ya existe. Extensiones:

- `kanban.on_move(in_progress)` → `workday.create({card_id, workflow_id})` → `agent_orchestration.run(workflow)` → PTY stream a UI.
- `agent.on_complete()` → `workday.append_entry({deliverables, duration, cost})` → `mem0.store({tags: [workflow, card_id]})`.
- `workday.on_close()` → resumen auto a vault L2 con embedding.

## 4. Skill libraries best practices

### Versionado

- **Semver en frontmatter**: `version: 1.4.2` en cada `SKILL.md`. Migración: añadir campo opcional, default `0.1.0`.
- **`.disabled` suffix**: convención ya usada (`academic-deep-research.disabled`). Mantener — es el opt-out más simple sin tocar el plugin manifest.
- **Plugin cache**: ECC plugin se cachea en `~/.claude/plugins/`. Bump de versión invalida cache. Documentar en README de cada skill el changelog.

### Activation triggers

Dos modos coexisten:

1. **System-reminder list** (automático): el harness inyecta nombres en cada turno. Bajo overhead, sin elección.
2. **Explicit invoke** vía Skill tool: el modelo decide. Mayor precisión, requiere descripción clara en frontmatter `description`.

Best practice: descripción de skill debe empezar con "Use when..." y listar 3-5 triggers concretos. El modelo matchea por keywords del usuario contra esta cadena. `[inference]` Skills con descripciones vagas (`"helps with code"`) se activan al azar; las que enumeran triggers ("activar cuando el usuario diga X, Y o pida Z") tienen ~3x precision.

### Skills vs Agents vs Hooks — criterio en 3 líneas

- **Skill**: conocimiento procedural reutilizable que el modelo carga bajo demanda (markdown + assets). Stateless.
- **Agent**: rol con prompt + tools restringidos que el coordinador invoca vía Task. Stateful dentro de su invocación.
- **Hook**: shell command que el harness ejecuta determinísticamente en eventos (pre/post tool, stop). Sin modelo involucrado.

Regla: si necesitas determinismo absoluto → hook. Si necesitas razonamiento aislado → agent. Si necesitas conocimiento reutilizable entre agentes → skill.

## 5. Workflow templates ready-to-code

Pegar en `src-tauri/src/agent_orchestration.rs` como `pub const BUILTIN_WORKFLOWS: &str = r#"[...]"#;` o cargar desde `~/.ultron/cockpit/workflows/builtin/`.

```json
[
  {
    "id": "quick-fix",
    "name": "Quick Fix",
    "description": "Bug trivial en 1-2 archivos. Sin plan formal.",
    "agents": [
      {"slug": "debugger", "role": "diagnose", "prompt": "Identifica root cause del bug descrito. Devuelve hipotesis + archivo + linea.", "model": "sonnet"},
      {"slug": "terry-davis", "role": "fix", "prompt": "Aplica el fix minimo. Verifica que compila.", "model": "sonnet"}
    ],
    "hand_off": "sequential",
    "completion_criteria": ["build_passes", "no_new_warnings"],
    "deliverables": ["diff", "commit_message"]
  },
  {
    "id": "feature-implementation",
    "name": "Feature Implementation",
    "description": "Feature nueva con plan, TDD, review y commit.",
    "agents": [
      {"slug": "planner", "role": "plan", "prompt": "Genera PRD + task_list para la feature. Output JSON.", "model": "opus"},
      {"slug": "tdd-guide", "role": "tests", "prompt": "Escribe tests RED para cada task del plan.", "model": "sonnet"},
      {"slug": "terry-davis", "role": "implement", "prompt": "Implementa hasta tests GREEN. Refactor.", "model": "sonnet"},
      {"slug": "code-reviewer", "role": "review", "prompt": "Review final. CRITICAL/HIGH bloquean.", "model": "sonnet"}
    ],
    "hand_off": "sequential",
    "completion_criteria": ["tests_pass", "coverage_gte_80", "review_no_critical"],
    "deliverables": ["plan.md", "src_changes", "test_changes", "review_report"]
  },
  {
    "id": "debug-investigation",
    "name": "Debug Investigation",
    "description": "Bug complejo multi-archivo. Investigacion sistematica.",
    "agents": [
      {"slug": "debugger", "role": "reproduce", "prompt": "Reproduce el bug minimamente. Output: script + expected vs actual.", "model": "sonnet"},
      {"slug": "debugger", "role": "bisect", "prompt": "Bisect git history o code paths para aislar regresion.", "model": "sonnet"},
      {"slug": "senior-engineer", "role": "fix", "prompt": "Disena fix con justificacion. No parches superficiales.", "model": "opus"}
    ],
    "hand_off": "sequential",
    "completion_criteria": ["repro_script_exists", "fix_verified", "regression_test_added"],
    "deliverables": ["repro_script", "root_cause.md", "fix_diff"]
  },
  {
    "id": "security-audit",
    "name": "Security Audit",
    "description": "Auditoria multi-angulo de modulo sensible.",
    "agents": [
      {"slug": "security-reviewer", "role": "owasp", "prompt": "Aplica OWASP Top 10 al modulo.", "model": "opus"},
      {"slug": "security-bounty-hunter", "role": "offensive", "prompt": "Piensa como atacante. Vectores reales.", "model": "opus"},
      {"slug": "code-reviewer", "role": "defensive", "prompt": "Cobertura de validacion de inputs y error handling.", "model": "sonnet"}
    ],
    "hand_off": "parallel",
    "completion_criteria": ["all_findings_classified", "critical_fixed_or_acknowledged"],
    "deliverables": ["security_report.md", "findings.json"]
  },
  {
    "id": "research",
    "name": "Research Spike",
    "description": "Investigacion de opciones tecnologicas antes de codigo.",
    "agents": [
      {"slug": "search-first", "role": "github", "prompt": "Busca implementaciones existentes en GitHub. Top 5.", "model": "sonnet"},
      {"slug": "einstein", "role": "papers", "prompt": "Papers/docs autoritativos sobre el tema.", "model": "opus"},
      {"slug": "architect", "role": "synthesize", "prompt": "Sintetiza hallazgos en recomendacion accionable.", "model": "opus"}
    ],
    "hand_off": "parallel",
    "completion_criteria": ["min_3_sources", "recommendation_explicit"],
    "deliverables": ["research_brief.md", "sources.json"]
  },
  {
    "id": "gamedev-iteration",
    "name": "Gamedev Iteration",
    "description": "Ciclo de iteracion en Unreal/Unity con gameplay + visual review.",
    "agents": [
      {"slug": "don-claudio", "role": "design", "prompt": "Disena el sistema gameplay. Replicacion y edge cases.", "model": "opus"},
      {"slug": "gamedev-engineer", "role": "implement", "prompt": "Implementa C++/Blueprint. Compila en Unreal.", "model": "sonnet"},
      {"slug": "mike-tyson", "role": "ux_review", "prompt": "Review UX/feedback visual. Sin clemencia.", "model": "sonnet"}
    ],
    "hand_off": "sequential",
    "completion_criteria": ["compiles_in_unreal", "playable_iteration", "ux_acceptable"],
    "deliverables": ["src_changes", "design_notes.md", "playtest_log.md"]
  },
  {
    "id": "learning-deep-dive",
    "name": "Learning Deep Dive",
    "description": "Aprender un tema con apuntes estructurados para NotebookLM.",
    "agents": [
      {"slug": "novalbos", "role": "explain", "prompt": "Explica el tema desde primeros principios. Profundidad alta.", "model": "opus"},
      {"slug": "novalbos", "role": "notes", "prompt": "Genera apuntes markdown estructurados listos para NotebookLM/Notion.", "model": "sonnet"},
      {"slug": "novalbos", "role": "quiz", "prompt": "10 preguntas de autoevaluacion con respuestas.", "model": "sonnet"}
    ],
    "hand_off": "sequential",
    "completion_criteria": ["notes_exported", "quiz_generated"],
    "deliverables": ["notes.md", "quiz.md", "sources.json"]
  }
]
```

## 6. Roadmap priorizado

| P | Accion | Archivo | Por que |
|---|---|---|---|
| P0 | Definir struct `Workflow` con schema seccion 1 | `src-tauri/src/agent_orchestration.rs` | Base de todo. Sin esto los templates son texto muerto. |
| P0 | Cargar 7 templates builtin al arrancar | `src-tauri/src/agent_orchestration.rs` | Onboarding inmediato sin config. |
| P0 | Endpoint Tauri `workflow_run(id, context)` | `src-tauri/src/commands/workflows.rs` (nuevo) | Bridge UI ↔ orquestador. |
| P0 | Auto-create workday on kanban move | `src-tauri/src/workdays.rs` + `kanban.rs` | Cierra el loop kanban→workday→memoria. |
| P1 | mem0 graph_store flag toggle en Settings | `src/components/Settings/MemoryPanel.tsx` | Activar relaciones sin migrar. |
| P1 | Hard cap turnos por workflow (default 20) | `agent_orchestration.rs` | Anti loop infinito (Devin lesson). |
| P1 | Idle detection (hash output repetido) | `agent_orchestration.rs` | Anti stuck loops. |
| P1 | Worktree isolation opcional per workflow | `src-tauri/src/git_worktree.rs` (nuevo) | Paralelismo sin conflictos. |
| P1 | UI: workflow picker en kanban card | `src/components/Kanban/CardModal.tsx` | UX: elegir workflow al mover card. |
| P2 | Skill versioning frontmatter parser | `src-tauri/src/skills.rs` | Trazabilidad de cambios. |
| P2 | Hook event bus persistente | `src-tauri/src/hooks_bus.rs` (nuevo) | Hooks ven workflows, no solo tools. |
| P2 | Cost circuit breaker per workflow | `src-tauri/src/cost_tracker.rs` | Pause automatica si supera N USD. |
| P2 | Workflow editor visual (DAG) | `src/components/Workflows/Editor.tsx` (nuevo) | Crear workflows custom sin JSON manual. |
| P2 | Export workflow results a vault L2 | `src-tauri/src/memory/vault.rs` | Persistencia long-term de deliverables. |
| P2 | Cron-triggered workflows (morning briefing) | `src-tauri/src/scheduler.rs` (nuevo) | Automatizar `modo mañana` de pana. |

Fuentes clave (knowledge consolidada): docs.anthropic.com/en/docs/claude-code/sub-agents, docs.mem0.ai, microsoft.github.io/autogen (0.4), github.com/letta-ai/letta, github.com/getzep/graphiti, github.com/All-Hands-AI/OpenHands.
