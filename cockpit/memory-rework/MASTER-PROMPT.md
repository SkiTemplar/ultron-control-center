# MASTER-PROMPT — Rework Memory-Orchestrated Agent Runtime

> Guardado 2026-06-03 · rama `fullize-2026-05-30` · prompt original de USER
> (redactado con ayuda de un chat externo). Este archivo es la referencia
> canónica del rework para que sobreviva a compactaciones de contexto.

---

## REFINAMIENTOS VINCULANTES (steering de USER, sesión 2026-06-03)

Estos overrides tienen prioridad sobre el texto del prompt externo de abajo:

1. **Prompt externo = punto de partida, NO biblia.** Lo escribió un chat externo.
   Donde diga "crear de cero" algo que ya existe en ULTRON, prevalece mi criterio:
   EXTENDER lo existente, no duplicar. (Evitar el "capa sobre capa".)

2. **BACKEND-FIRST. Frontend al mínimo indispensable.** La FASE de UI (Memory
   Control Center: Dashboard, Explorer 15-filtros, Detail con diffs, Retrieval
   Inspector, Workflow/Skill/Agent Registry UI, Audit Log UI, Settings) es OVERKILL
   — la mayoría no se usará. Toda capacidad nace en **backend + CLI + logs
   estructurados**; solo sube a UI lo que un humano DEBE tocar.
   - Frontend que sobrevive: (a) **inbox de validación de candidates** reusando el
     patrón Accept/Reject de `decisions.rs`; (b) **estado de memoria** donde ya está
     (`MemoryStatusCard`). Retrieval Inspector = salida a log/fichero, no pestaña.

3. **TRIGGER = "Ultron" (fijo).** El orquestador se activa solo con "Ultron". Las
   frases del prompt ("lanza el orquestador", "orquestador", "sigue con la memoria",
   golden prompts) son SINÓNIMOS que enrutan al mismo trigger Ultron, no keywords
   nuevas. Mantener `skill ultron` / `ultron-orchestrator` como única puerta.

4. **Reúso concreto verificado** (no reconstruir): GUI = Control Center Tauri 2 +
   React ya existe; Skill/Agent Registry = `Library.tsx` + `agents.rs`; Workflow
   Center = `workflow_runs.rs` + `commands/workflows/`; ModelRouter = `ai_router.rs`
   + `AIRouter/`; Audit/Cost/Hooks = `event_log.rs`/`cost_watchdog.rs`/`hooks_admin.rs`.
   Construcción NUEVA real = solo el **modelo canónico de memoria con gobernanza**
   (`brain.db` hoy es tabla plana sin status/eventos/candidates).

---

## Taxonomía de clasificación (de la 1ª versión del prompt — usar en la auditoría)

Cada componente del sistema actual se clasifica como:
- **GOOD**: conservar casi igual.
- **WRAP**: envolver detrás de interfaz.
- **MIGRATE**: migrar datos y reemplazar.
- **REWRITE**: reescribir completamente.
- **REMOVE**: eliminar.
- **UNKNOWN**: requiere más análisis.

Tabla de auditoría (formato pedido):
`Componente | Ubicación | Función actual | Problemas | Valor real | Mantener | Reescribir | Eliminar | Migrar datos | Decisión`

Estructura objetivo del Memory Kernel (de la 1ª versión; adaptar a Rust/Tauri real):
```
memory_kernel/
  core/      memory_service · memory_retriever · memory_writer · memory_validator ·
             memory_deduplicator · contradiction_detector · context_builder ·
             session_manager · event_log
  indexing/  qdrant_index · keyword_index · embedding_service · reranker
  orchestration/ orchestrator · workflow_selector · workflow_runner ·
                 agent_selector · skill_selector
  routing/   model_router · routing_policies · cost_tracker · cache
  hooks/     session_start · user_prompt_submit · pre_tool_use · post_tool_use ·
             stop · session_end
  ui/        (RECORTADO por refinamiento #2 — solo inbox + status)
  cli/       memory_commands · workflow_commands · skill_commands · agent_commands
  migrations/ import_mem0 · import_ecc · import_qdrant · normalize_memory
  tests/     retrieval_tests · memory_write_tests · workflow_tests · routing_tests
```

---

## PROMPT ORIGINAL (verbatim — versión "copia y pega", FASE 0–20)

Actúa como arquitecto principal de sistemas agentic, memoria LLM, Claude Code, orquestación de Workflows, recuperación híbrida, optimización extrema de tokens, diseño de agentes, skills, hooks, UI de validación y migraciones seguras.

Tu misión es analizar mi sistema actual de memoria/orquestación/agentes/skills/Workflows y modificarlo para convertirlo en el sistema más avanzado, robusto y eficiente posible ejecutándose localmente en mi PC, preservando lo que ya funciona y reemplazando solo lo que esté mal diseñado, duplicado, opaco, caro en tokens o difícil de validar.

Contexto actual conocido:
- Estoy usando Qdrant actualmente.
- Estoy usando Mem0.
- Estoy usando algo llamado ECC memory o ECC relacionado con Claude Code/agentes/memoria, pero debes verificar en el repo qué significa exactamente. No asumas.
- Tengo una GUI de gestión.
- Quité la sección visual de memoria porque no parecía aportar, pero quiero que evalúes si debe volver rediseñada como centro de control real de memoria.
- Tengo un sistema de AI Routing que usa diferentes modelos vía APIs para ahorrar tokens.
- Estoy trabajando con memoria, orquestación de Workflows, skills y agentes.
- Quiero que al abrir cualquier sesión se pueda acceder, editar, validar, aprobar, desaprobar, corregir, versionar y auditar memoria actualizada en sesiones anteriores.
- Quiero que al mencionar al orquestador, el sistema sepa qué agente lanzar, qué skill usar, qué memoria recoger, qué memoria actualizar, qué escribir, qué cambiar y qué Workflow ejecutar.
- Objetivo prioritario: máxima calidad con el mínimo gasto posible de tokens.
- No quiero una demo superficial. Quiero una arquitectura real, escalable, observable, editable, validable y mantenible.

Principio rector:
No construyas un chatbot con memoria. Construye un Memory-Orchestrated Agent Runtime.

El sistema final debe funcionar así:

User input
  -> Hook layer
  -> Intent/router barato
  -> Project/session detector
  -> Workflow selector
  -> Agent selector
  -> Skill selector
  -> Memory retriever
  -> Context pack compacto
  -> Ejecución controlada
  -> Event log
  -> Extracción de memoria candidata
  -> Dedupe/merge/conflict detection
  -> UI de validación
  -> Escritura canónica
  -> Reindexado en Qdrant

Reglas absolutas:
1. No uses Qdrant como source of truth. Qdrant debe ser índice de recuperación, no la verdad canónica.
2. La verdad canónica debe estar en una base local auditable: SQLite, Postgres, DuckDB o la base ya existente si es adecuada.
3. Toda memoria persistente debe ser editable, versionada, auditable y reversible.
4. Ningún agente salvo el Memory Agent debe escribir memoria persistente directamente.
5. Otros agentes solo pueden emitir eventos o memory_candidates.
6. Nunca inyectes memoria cruda masiva al prompt por defecto.
7. Recupera primero handles/IDs/resúmenes compactos, y carga detalle solo bajo demanda.
8. La UI de memoria debe mostrar exactamente qué se cargó en cada turno y por qué.
9. La memoria debe poder aprobarse, rechazarse, editarse, fusionarse, dividirse, fijarse, deprecarse o marcarse como errónea.
10. Los Workflows deben ser entidades de primera clase, no prompts sueltos.
11. El AI Routing debe integrarse en memoria, extracción, clasificación, compresión, reranking y validación.
12. Todo debe estar instrumentado con métricas: tokens, latencia, coste, recall, precisión, duplicados, memorias rechazadas, memorias obsoletas, rutas elegidas y Workflows ejecutados.
13. No rompas el sistema actual sin migración, compatibilidad o rollback.
14. Trabaja con evidencia del código real. No inventes arquitectura existente.
15. Cada cambio debe tener motivo técnico claro.

FASE 0 — Modo de trabajo seguro

Antes de modificar:
- Inspecciona estructura del proyecto.
- Detecta stack, lenguaje, framework, base de datos, servicios, colas, UI, hooks, scripts, MCPs, carpetas de Claude Code, agentes, skills y Workflows.
- Localiza configuración de Qdrant.
- Localiza integración de Mem0.
- Localiza integración de ECC memory o ECC.
- Localiza el AI Routing.
- Localiza el sistema actual de GUI.
- Localiza cualquier event log, session store, memory store, vector store, cache, prompt builder, context builder, workflow runner, agent registry y skill registry.
- Localiza tests existentes.
- Localiza documentación interna.
- Localiza `.claude`, `CLAUDE.md`, hooks, commands, agents, skills, MCP config o equivalentes.
- No borres nada.
- No hagas refactor masivo antes de entender el flujo.
- Crea un plan incremental.
- Si el proyecto usa Git, trabaja en una rama nueva tipo `memory-kernel-upgrade` o equivalente.
- Si no hay Git, crea backups de archivos críticos antes de modificar.

Entrega primero un diagnóstico técnico con:
- Mapa de arquitectura actual.
- Flujo actual de memoria.
- Flujo actual de orquestación.
- Flujo actual de Workflows.
- Flujo actual de agentes.
- Flujo actual de skills.
- Flujo actual de hooks.
- Flujo actual de AI Routing.
- Flujo actual de GUI.
- Qué partes parecen funcionar.
- Qué partes están duplicadas.
- Qué partes son opacas.
- Qué partes gastan tokens innecesarios.
- Qué partes pueden causar memoria falsa, memoria obsoleta o contradicciones.
- Qué partes deben conservarse.
- Qué partes deben envolverse detrás de interfaces.
- Qué partes deben migrarse.
- Qué partes deben eliminarse solo después de compatibilidad.

FASE 1 — Auditoría profunda del sistema actual

Analiza el sistema actual y genera una tabla como esta:

Componente | Ubicación | Responsabilidad actual | Problemas | Riesgo | Reutilizar/Refactor/Reemplazar | Acción propuesta

Debes cubrir como mínimo:
- Qdrant collections actuales.
- Payloads actuales.
- Embeddings actuales.
- Dense vectors.
- Sparse vectors si existen.
- Búsqueda híbrida si existe.
- Filtros por payload.
- Mem0 usage.
- ECC usage.
- Session storage.
- Long-term memory.
- Short-term memory.
- Episodic memory.
- Semantic memory.
- Procedural memory.
- Skills.
- Agents.
- Workflows.
- Hook handlers.
- Prompt construction.
- Context injection.
- Summarization.
- Memory extraction.
- Memory update.
- Memory deletion.
- Deduplication.
- Contradiction handling.
- Validation flow.
- GUI.
- AI Routing.
- Logs.
- Tests.
- Config.
- Secrets handling.
- Error handling.

Investiga especialmente:
- Si Mem0 está guardando memoria duplicada con Qdrant.
- Si Mem0 es source of truth o solo extractor/retriever.
- Si Qdrant está guardando contenido canónico que debería estar en DB.
- Si las memorias tienen IDs estables.
- Si las memorias tienen versionado.
- Si las memorias tienen estado: pending, active, rejected, deprecated, stale.
- Si las memorias tienen confidence.
- Si las memorias tienen importance.
- Si las memorias tienen scope.
- Si las memorias tienen project_id.
- Si las memorias tienen source_session_id.
- Si las memorias tienen created_at/updated_at.
- Si existen relaciones supersedes/contradicts/derived_from.
- Si hay forma de explicar por qué una memoria fue recuperada.
- Si hay forma de saber qué memoria entró en el prompt.
- Si hay forma de aprobar/desaprobar cambios.
- Si hay memory poisoning posible.
- Si hay datos sensibles inyectándose sin control.
- Si el AI Routing puede clasificar y extraer memoria con modelos baratos.

FASE 2 — Arquitectura objetivo

Diseña e implementa un sistema llamado conceptualmente Memory Kernel o Agentic Memory Kernel.

Arquitectura objetivo:

Memory Kernel
├── Hook Layer
├── Intent Router
├── Project Detector
├── Workflow Selector
├── Agent Selector
├── Skill Selector
├── Memory Retriever
├── Context Builder
├── Execution Event Bus
├── Memory Candidate Extractor
├── Memory Deduplicator
├── Contradiction Detector
├── Memory Validator
├── Memory Writer
├── Qdrant Indexer
├── Session Summarizer
├── Workflow State Store
├── Skill Registry
├── Agent Registry
├── Audit Log
├── Metrics Collector
└── Memory Control Center UI

El diseño debe separar:
- Source of truth.
- Vector/search index.
- Runtime context.
- Event log.
- UI validation.
- Workflow state.
- Skill registry.
- Agent registry.
- Model routing.

Patrón obligatorio:
Event Sourcing + Materialized Memory Views + Hybrid Retrieval + Human Validation.

Esto significa:
1. Todo cambio relevante genera eventos append-only.
2. Las memorias activas son vistas materializadas validadas.
3. Qdrant indexa la vista materializada, no reemplaza la DB canónica.
4. El modelo recibe context packs compactos, no dumps de memoria.
5. El usuario puede inspeccionar y corregir memoria.
6. Las memorias conflictivas van a inbox.
7. Las memorias de alta confianza y bajo riesgo pueden autoaprobarse solo si la política lo permite.
8. Todo puede auditarse y revertirse.

FASE 3 — Modelo de datos canónico

Implementa o adapta un modelo equivalente a este. Si el proyecto ya tiene modelos parecidos, migra y extiende sin duplicar innecesariamente.

MemoryItem:
- id
- type: preference | fact | decision | constraint | task | workflow_state | codebase_fact | skill | agent_note | session_summary | error_resolution | architecture | tool_usage | user_profile
- scope: global | user | project | repo | branch | session | workflow | agent | skill
- project_id
- repo_id
- branch
- workflow_id
- agent_id
- skill_id
- user_id
- title
- summary
- content
- content_json
- tags
- status: pending | active | rejected | stale | deprecated | quarantined | archived
- confidence: 0.0-1.0
- importance: 0.0-1.0
- stability: temporary | durable | permanent
- sensitivity: public | internal | private | secret
- source: user_explicit | assistant_inferred | tool_observed | code_observed | workflow_generated | imported_mem0 | imported_ecc | manual_ui
- source_session_id
- source_event_ids
- validated_by_user
- validated_at
- created_at
- updated_at
- expires_at
- supersedes
- superseded_by
- contradicts
- derived_from
- qdrant_point_id
- token_estimate
- access_count
- last_accessed_at
- last_injected_at

MemoryEvent:
- id
- event_type: created | updated | approved | rejected | edited | merged | split | deprecated | restored | contradicted | retrieved | injected | exported | imported
- memory_id
- before_json
- after_json
- actor: user | memory_agent | workflow_agent | system | migration
- source_session_id
- source_turn_id
- reason
- confidence
- created_at

MemoryCandidate:
- id
- proposed_type
- proposed_scope
- proposed_summary
- proposed_content
- proposed_content_json
- source_event_ids
- source_session_id
- confidence
- importance
- risk_level
- duplicate_candidates
- contradiction_candidates
- recommended_action: approve | reject | edit | merge | supersede | quarantine
- status: pending | approved | rejected | edited | merged | quarantined
- created_at

Session:
- id
- project_id
- started_at
- ended_at
- user_goal
- detected_intents
- workflows_used
- agents_used
- skills_used
- memories_retrieved
- memories_injected
- memory_candidates_created
- files_touched
- commands_run
- summary_short
- summary_long
- unresolved_tasks
- token_usage
- cost_estimate

WorkflowDefinition:
- id
- name
- description
- trigger_patterns
- intent_routes
- required_agents
- allowed_agents
- required_skills
- allowed_tools
- required_memory_types
- states
- transitions
- entry_conditions
- exit_conditions
- validation_rules
- memory_read_policy
- memory_write_policy
- token_budget
- risk_level
- enabled

WorkflowRun:
- id
- workflow_id
- session_id
- state
- current_step
- started_at
- updated_at
- completed_at
- status
- inputs
- outputs
- memory_reads
- memory_writes
- tool_calls
- errors
- next_actions

Skill:
- id
- name
- description
- trigger_patterns
- input_schema
- output_schema
- body
- examples
- tool_permissions
- required_context
- token_cost_estimate
- risk_level
- status
- version
- usage_count
- success_rate
- last_used_at

Agent:
- id
- name
- role
- description
- system_prompt_ref
- allowed_tools
- allowed_workflows
- allowed_skills
- memory_read_policy
- memory_write_policy
- model_policy
- token_budget
- status
- version

FASE 4 — Qdrant como índice híbrido avanzado

Revisa cómo se usa Qdrant actualmente y mejóralo.

Objetivo:
- Qdrant debe indexar memorias activas, skills, agentes, workflows, sesiones resumidas, decisiones y codebase facts.
- Debe usar payloads ricos.
- Debe permitir filtros por project_id, scope, type, status, confidence, importance, updated_at, workflow_id, agent_id, skill_id, tags y sensitivity.
- Debe soportar recuperación híbrida si el stack lo permite: dense + sparse.
- Debe usar búsqueda multietapa si es posible: candidate retrieval barato -> reranking -> context pack.
- Debe devolver primero handles compactos, no documentos completos.

Payload mínimo recomendado en Qdrant:
{
  "entity": "memory | skill | agent | workflow | session | codebase_fact",
  "canonical_id": "...",
  "type": "...",
  "scope": "...",
  "project_id": "...",
  "repo_id": "...",
  "workflow_id": "...",
  "agent_id": "...",
  "skill_id": "...",
  "status": "active",
  "confidence": 0.93,
  "importance": 0.82,
  "validated_by_user": true,
  "sensitivity": "internal",
  "tags": ["..."],
  "summary": "...",
  "token_estimate": 84,
  "updated_at": "...",
  "created_at": "..."
}

Implementa una capa QdrantIndexService:
- upsert_memory(memory)
- delete_memory_index(memory_id)
- search_memories(query, filters, limit)
- search_skills(query, filters, limit)
- search_agents(query, filters, limit)
- search_workflows(query, filters, limit)
- hybrid_search(...)
- reindex_all()
- reindex_project(project_id)
- explain_result(result)

No expongas Qdrant directamente al orquestador. El orquestador debe hablar con MemoryRetriever/SkillSelector/WorkflowSelector.

FASE 5 — Retrieval mínimo en tokens

Implementa un flujo de recuperación por etapas:

Etapa A — Determinística:
- Detectar proyecto actual.
- Detectar repo/branch.
- Detectar sesión.
- Detectar usuario.
- Detectar si el prompt menciona memoria, workflow, agente, skill, bug, refactor, arquitectura, UI, testing, migración o investigación.
- Recuperar pinned memories.
- Recuperar active workflow state.
- Recuperar preferencias globales validadas.
- Recuperar constraints del proyecto.

Etapa B — Búsqueda barata:
- Keyword/BM25/FTS si existe.
- Payload filters.
- Búsqueda por tags.
- Matching por trigger_patterns de workflows, agents y skills.

Etapa C — Qdrant:
- Dense search.
- Sparse search si está disponible.
- Hybrid fusion.
- Top N candidatos.
- No cargar body completo salvo necesidad.

Etapa D — Reranking:
Score recomendado:
final_score =
  0.25 * intent_match
+ 0.20 * semantic_score
+ 0.15 * keyword_score
+ 0.15 * project_match
+ 0.10 * workflow_relevance
+ 0.05 * importance
+ 0.05 * confidence
+ 0.05 * recency
+ 0.05 * user_validated_boost
- 0.20 * stale_penalty
- 0.25 * contradiction_penalty
- 0.30 * rejected_or_deprecated_penalty
- 0.15 * sensitivity_penalty_if_not_needed

Etapa E — Context Pack:
El LLM solo debe recibir:
- Route.
- Workflow seleccionado.
- Agente seleccionado.
- Skills seleccionadas.
- Memorias compactas relevantes.
- Estado actual de workflow.
- Restricciones operativas.
- Warnings de memoria.
- IDs para lazy-load si necesita detalle.

Formato recomendado:

<ORCHESTRATION_CONTEXT compact="true">
route: "..."
project_id: "..."
session_id: "..."
workflow:
  id: "..."
  name: "..."
  state: "..."
  next_step: "..."
agent:
  id: "..."
  name: "..."
  reason: "..."
skills:
  - id: "..."
    name: "..."
    reason: "..."
memories:
  - id: "..."
    type: "decision"
    summary: "..."
    confidence: 0.94
    importance: 0.86
    validated: true
    reason: "..."
constraints:
  - "Minimizar tokens"
  - "No escribir memoria persistente fuera del Memory Agent"
warnings:
  - "Hay memorias contradictorias pendientes de validación"
lazy_load_available:
  - memory_id: "..."
token_budget:
  memory_context_max_tokens: 1200
  skill_context_max_tokens: 500
  workflow_context_max_tokens: 500
</ORCHESTRATION_CONTEXT>

Presupuesto recomendado inicial:
- Clasificación/routing: 100-300 tokens.
- Contexto de memoria normal: máximo 800-1500 tokens.
- Contexto de memoria complejo: máximo 2500 tokens.
- Skills: máximo 300-800 tokens.
- Workflow state: máximo 300-700 tokens.
- Nunca exceder presupuesto sin logging explícito.

FASE 6 — AI Routing integrado con memoria

Analiza mi AI Routing actual y extiéndelo.

Debe poder seleccionar modelos distintos para:
- intent_classification
- project_detection
- workflow_selection
- agent_selection
- skill_selection
- memory_retrieval_query_rewrite
- memory_candidate_extraction
- memory_deduplication
- contradiction_detection
- session_summarization
- context_compression
- final_reasoning
- code_generation
- code_review
- test_generation

Política recomendada:
- Usar modelos baratos/locales para clasificación, extracción JSON simple, resumen corto y query rewriting.
- Usar embeddings locales o baratos para retrieval.
- Usar modelo fuerte solo para razonamiento complejo, contradicciones difíciles, arquitectura y decisiones de código importantes.
- Cachear resultados por input hash + project_id + route.
- Registrar coste estimado por tarea.
- Implementar fallback si un modelo falla.
- Aplicar JSON schema strict donde sea posible.
- No usar modelo grande para decidir algo que puede resolverse con reglas, triggers, filtros o metadata.

Define ModelPolicy:
{
  "task": "memory_candidate_extraction",
  "preferred_model": "...",
  "fallback_model": "...",
  "max_tokens": 800,
  "temperature": 0,
  "requires_json_schema": true,
  "cache_ttl_seconds": 86400
}

FASE 7 — Workflows como núcleo de orquestación

Rediseña o implementa la orquestación alrededor de Workflows.

Regla:
El orquestador debe seleccionar primero el Workflow y luego agente/skills/memoria en función del Workflow.

Workflows mínimos:
1. session_resume_workflow
2. user_prompt_orchestration_workflow
3. memory_review_workflow
4. code_change_workflow
5. bug_fix_workflow
6. architecture_decision_workflow
7. skill_generation_workflow
8. agent_selection_workflow
9. context_compression_workflow
10. memory_migration_workflow

Cada Workflow debe tener: definición declarativa, triggers, estados, transiciones,
agentes permitidos, skills permitidas, herramientas permitidas, memoria requerida,
política de escritura, presupuesto de tokens, tests.

FASE 8 — Agentes

Orchestrator Agent: decide Workflow/agente/skills, pide context pack, NO escribe memoria persistente.
Memory Agent: ÚNICO autorizado para crear/update/delete/deprecate memoria persistente; deduplica, detecta contradicciones, prepara candidatos, aplica políticas, escribe eventos, reindexa Qdrant.
Workflow Agent: gestiona WorkflowDefinitions y WorkflowRuns; estado y next_step.
Skill Agent: busca/propone/evalúa skills.
Coding Agent: cambia código.
Review Agent: revisa cambios y riesgos.
Test Agent: ejecuta o propone tests.
Security Agent: revisa comandos/paths/secretos/permisos; puede bloquear.
Compression Agent: resume sesiones/traces; nunca elimina eventos canónicos.

FASE 9 — Hooks

SessionStart: detectar proyecto/repo/branch, crear session_id, cargar perfil mínimo +
active workflow state + últimas decisiones; NO cargar todo el historial.
UserPromptSubmit: capturar prompt, clasificar intención (router barato), seleccionar
Workflow/agente/skills, recuperar memoria mínima, construir context pack, registrar
qué memoria se inyectó y por qué.
PreToolUse: permisos, bloquear comandos peligrosos, validar paths, registrar intención.
PostToolUse: registrar resultado/archivos/errores, extraer codebase facts candidatos,
actualizar workflow run; sin escritura persistente directa (solo evento/candidate).
Stop: extraer memory_candidates, deduplicar, mandar a inbox o autoaprobar según política.
SessionEnd: resumen estructurado, tareas abiertas, workflow state, candidates, token/cost.
PreCompact/PostCompact: guardar resumen estructurado antes; verificar no pérdida después.
FileChanged / SubagentStart / SubagentStop: codebase facts / registrar agente + output.

FASE 10 — UI: Memory Control Center
[RECORTADA por refinamiento vinculante #2 — backend-first. Solo: inbox de validación
reusando decisions.rs + estado de memoria en MemoryStatusCard. El resto (Dashboard,
Memory Inbox completo, Memory Explorer, Memory Detail, Retrieval Inspector, Workflow
Center, Skill Registry UI, Agent Registry UI, Audit Log, Settings) -> CLI + logs.]

FASE 11 — Políticas de memoria

Guardar memoria solo si: es durable, accionable, específica, cambia decisiones futuras,
no duplicada, fuente clara, no contradice memoria activa sin marcar conflicto, sin
secretos, scope correcto.
No guardar: texto genérico, explicaciones comunes, logs largos, mensajes triviales,
pensamientos intermedios, código temporal, contexto efímero, inferencias débiles sin validar.
Autoaprobar solo: observaciones técnicas de bajo riesgo de código, session summaries
estructurados, tool usage facts no sensibles, workflow state, tareas abiertas alta confianza.
Nunca autoaprobar: preferencias personales importantes, decisiones de arquitectura
críticas, cambios que contradigan memoria existente.
Mandar a inbox: preferencias, decisiones de arquitectura, convenciones, conflictos,
skills/agentes/workflows nuevos, cambios de política, baja confianza, sensible, deprecaciones.

FASE 12 — Mem0 y ECC

No elimines Mem0 ni ECC sin análisis.
Mem0: detectar uso (extractor/store/retriever/personalization/wrapper); si funciona
encapsular tras MemoryProvider; si duplica con Qdrant evitar doble escritura; si opaca
export/migration; no debe ser única verdad canónica.
ECC: determinar qué es exactamente; si aporta hooks/skills/persistence/optimización
integrar; si duplica capa adaptadora; si memoria no auditable migrar/limitar; comandos
útiles a Workflows. No asumir significado.
Interfaces: MemoryProvider · VectorIndexProvider · WorkflowProvider · SkillProvider ·
AgentProvider · RoutingProvider.

FASE 13 — Migración

Migration workflow: exportar (Mem0/ECC/Qdrant/DB/files) -> normalizar a MemoryItem ->
dedupe -> contradicciones -> scopes -> project_id -> confidence -> importance ->
eventos imported -> dudosas a pending -> activar solo claras -> reindex Qdrant ->
reporte -> rollback.
Reporte: total importado, activas, pendientes, rechazadas auto, duplicadas,
conflictivas, sin proyecto, sensibles, errores.

FASE 14 — APIs/servicios

MemoryService · MemoryRetriever · ContextBuilder · WorkflowService · SkillService ·
AgentService · RoutingService · AuditService · MetricsService (ver prompt original para
firmas de método completas).

FASE 15 — Tests y evaluación

Tests mínimos: memoria rechazada no se inyecta; deprecated no se inyecta salvo petición;
pending no es verdad; aprobada aparece en búsqueda; editada actualiza Qdrant; deprecada
desaparece de recuperación normal; contradictoria va a inbox; context pack respeta
presupuesto; workflow/agent/skill correctos seleccionados; AI Routing usa modelos
baratos para clasificación; Memory Agent único escritor; SessionStart no carga todo;
UserPromptSubmit produce context pack compacto; Stop genera candidates; UI aprueba/
rechaza/edita; migración no pierde IDs ni fuente; reindex Qdrant funciona; retrieval
inspector explica resultados.
Golden queries: "sigue con lo de la memoria" · "lanza el orquestador" · "modifica el
workflow de skills" · "recuerda cómo decidimos guardar memoria" · "usa el agente de
review" · "actualiza la decisión de arquitectura" · "qué quedó pendiente en la sesión
anterior" · "no uses esa memoria, estaba mal" · "crea una skill para esto" · "continúa
con el bug que arreglamos ayer".
Métricas: precision@k, recall@k, memoria útil/inútil inyectada, tokens de context pack,
coste de routing, latencia de retrieval, tasa aprobación/rechazo, duplicados,
contradicciones, errores de scope, false memories, stale memories used, workflow
selection accuracy.

FASE 16 — Observabilidad

Logging estructurado para: route/workflow/agent/skills selected, memories retrieved/
injected/discarded, candidates generated/approved/rejected, token budgets, model
selected/fallback, Qdrant query/filters, reranking score, UI actions, workflow
transitions. Visible desde UI o CLI.

FASE 17 — CLI

memory search/inbox/approve/reject/edit/deprecate/history/explain/reindex/migrate/stats
workflow list/active/show/run/history
skill list/search/approve/reject
agent list/show
router stats/costs

FASE 18 — Documentación

MEMORY_KERNEL.md · MEMORY_ARCHITECTURE.md · WORKFLOWS.md · AGENTS.md · SKILLS.md ·
AI_ROUTING.md · QDRANT_INDEXING.md · MEMORY_UI.md · MIGRATION_REPORT.md · OPERATIONS.md
(qué existe, por qué, cómo se usa/testea/depura, decisiones, tradeoffs, pendientes).

FASE 19 — Acceptance Criteria

1. SessionStart carga contexto mínimo útil, no todo el historial.
2. "orquestador" (=> "Ultron") selecciona Workflow/agente/skills/memoria relevantes.
3. El sistema explica por qué recuperó cada memoria.
4. Muestra qué memoria entró en el prompt.
5. (UI recortada) aprobar/editar/rechazar/fusionar/deprecar/auditar memoria — vía inbox+CLI.
6. Rechazadas/deprecadas no se inyectan por defecto.
7. Qdrant sincronizado con memoria canónica.
8. Mem0/ECC integrados o migrados explícitamente.
9. AI Routing participa en tareas baratas para reducir coste.
10. Solo Memory Agent escribe memoria persistente.
11. Workflows gestionables y auditables.
12. Token budgets respetados.
13-20. Tests, logs, docs, migration report, rollback, no pérdida de memoria, no stores
duplicados sin razón, usable desde CLI y/o GUI.

FASE 20 — Formato de salida durante el trabajo

1. Diagnóstico basado en código (arquitectura, flujo, problemas, riesgos, oportunidades).
2. Plan de implementación (fases, archivos, módulos, migraciones, tests, riesgos).
3. Implementación incremental (resumen de archivos + razón tras cada bloque).
4. Validación (tests existentes + nuevos, lint/checks, resultados).
5. Resultado final (qué quedó, cómo usar, cómo abrir UI, validar memoria, retrieval
   inspector, reindex Qdrant, migrar Mem0/ECC, pendientes).

Criterio de calidad: implementar > recomendar abstracto; migración segura + tests +
explicación técnica; arquitectura limpia, auditable, extensible y económica en tokens.

---

## Notas de prioridad (del prompt original)

Prioridad real: 1) Arquitectura correcta · 2) Mínimo gasto de tokens · 3) Memoria
editable/validable · 4) Orquestación fiable · 5) Workflows explícitos · 6) Agentes con
responsabilidades claras · 7) Skills reutilizables · 8) Observabilidad · 9) Tests ·
10) Migración segura de datos útiles.

NO priorizar: compatibilidad innecesaria · mantener Mem0/ECC/GUI por costumbre ·
parches rápidos · inyección masiva de contexto · memoria opaca · prompts gigantes ·
agentes que escriben memoria sin control · workflows implícitos escondidos en prompts.
