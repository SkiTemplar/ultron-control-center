# SPEC FULL — ORQUESTADOR "Ultron" (ULTRON)
### Autocontenido para revisión por IA externa · 2026-06-04

## 1. Propósito
Backend que mapea un prompt → intent → workflow → agentes-especialistas-reales → memorias → context pack, con reuse-over-rebuild (DELEGA a los ~78 agentes reales de `~/.claude/agents`, no reinventa). Trigger = "Ultron" (frases vagas = sinónimos al mismo trigger).

## 2. Arquitectura (archivos)
- `orchestrator.rs` — `orchestrate(prompt, project) -> OrchestrationContext`: intent (reglas regex bilingües, NO LLM) → workflow (7 builtin de agent_orchestration) → delegate_agents (E5 sobre catálogo) → recall (recall_pack) → constraints + warnings + budget.
- `agent_orchestration.rs` (58KB) — 7 workflows builtin (`list_workflows_inner`), `delegate_task_inner` (spawnea agente via pty), blackboard XML, delegations.jsonl, validate_agent_slug, ghost-agent saneados.
- `workflow_loader.rs` — YAML `~/.ultron/cockpit/workflows/`.
- `workflow_runs.rs` — WorkflowRun CRUD + WorkflowState (state_json).
- `memory/catalog.rs` — catálogo agentes E5.
- `config/intent-rules.yaml` — reglas regex→skill (HUÉRFANO, no consumido).
- Expuesto vía CLI `ultron-memory orchestrate` + hook memory-orchestrate.js.

## 3. STATUS FULL: 🟡
| Aspecto | Estado | Evidencia |
|---|---|---|
| orchestrate() cableado e2e | ✅ | CLI + hook; verificado (route/agentes/memorias reales) |
| Intent classification | 🟡 regex (9 reglas), no LLM | orchestrator.rs:110; intent-rules.yaml (50+) huérfano |
| Workflow selection | 🟡 | 7 builtin; sin trigger_patterns propios |
| Agent selection (delegate) | 🟡 sesgado a genéricos | search_catalog top-5 coseno crudo, sin reranker |
| Skills en selección | 🔴 | catálogo solo agentes |
| DELEGA a agentes reales (no reinventa) | ✅ | reuse-over-rebuild; ghost agents saneados |
| WorkflowRun + WorkflowState persistido | ✅ estructura | workflow_runs.rs; falta persistir runs por step |
| Constraints/WorkflowState en el contexto | 🟡 | constraints hardcoded (orchestrator.rs:160-164), no desde memoria |
| routing-decision (juez LLM) integrado | 🔴 | zona existe (ai_router.rs:477), orchestrator no la llama |

## 4. QUÉ FALTA (priorizado)
1. **Juez LLM para intent ambiguo**: cuando classify_intent="general", llamar `route("routing-decision")` (temp0, JSON {intent,zone_id,confidence}); reglas para lo claro, LLM barato para lo ambiguo.
2. **Reranker** en delegate_agents + **skills en catálogo** (ver spec 03).
3. **model_plan** en OrchestrationContext (zona+provider+rationale, traza explicable).
4. **Constraints desde memoria** (list_active_of_type Constraint) en vez de strings fijos; recuperar WorkflowState en resume.
5. **Workflows con trigger_patterns/allowed_agents/allowed_skills/budget propios** (entidades de 1ª clase declarativas).
6. **Despacho multi-IA** (ver spec 02): delegate_task_inner elige provider por zona.

## 5. Los 10 workflows objetivo (del Master Plan)
session_resume · user_prompt_orchestration · memory_review · code_change · bug_fix · architecture_decision · skill_generation · agent_selection · context_compression · memory_migration. Hoy: 7 builtin genéricos.

## 6. Preguntas para la IA
- ¿Workflows declarativos (YAML) con state machine vs builtin en Rust — qué da mejor mantenibilidad a esta escala?
- ¿Intent: reglas+LLM-fallback es óptimo, o todo-LLM con cache?
