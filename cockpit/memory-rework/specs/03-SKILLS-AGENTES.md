# SPEC FULL — AUTO-ROUTING de SKILLS / AGENTES (ULTRON)
### Autocontenido para revisión por IA externa · 2026-06-04

## 1. Propósito
Que ULTRON enrute y ACTIVE automáticamente la skill o el agente óptimo según el prompt, con ESPECIALISTAS (no general-purpose), de forma fiable y trazable.

## 2. Arquitectura (archivos)
- Hooks UserPromptSubmit (settings.json): `routing-dispatcher.js` (keyword/regex hardcodeado: PERSONAS/PLUGINS/AGENTS, pesos trigger=100/strong=60/context=25) + `memory-orchestrate.js` (→ `ultron-memory orchestrate` → orchestrator.rs).
- `orchestrator.rs` — intent (regex) → workflow → `catalog::search_catalog` (E5) → delegate_agents.
- `memory/catalog.rs` — catálogo `ultron_catalog` (E5). `catalog.rs:133` indexa `entity="agent"` (SOLO agentes).
- Ficheros de routing: `config/intent-rules.yaml` (50+ reglas), `skill_graph.json`, `query-synonyms.json` — HUÉRFANOS (cero consumidores vivos).
- ~78 agentes en `~/.claude/agents/`, cientos de skills en `~/.claude/skills/` + plugins.

## 3. STATUS FULL: 🔴 HOY SE SUGIERE, NO SE ACTIVA
| Aspecto | Estado | Evidencia |
|---|---|---|
| Activación | 🔴 no determinista | hooks inyectan texto ("ignore if wrong"); el modelo decide; los hooks UserPromptSubmit NO pueden invocar tools |
| Dos routers paralelos | 🔴 | routing-dispatcher.js + memory-orchestrate.js, pueden contradecirse |
| Catálogo: skills | 🔴 NO indexadas | catalog.rs:133 entity="agent"; skills nunca compiten en retrieval |
| Reranker / umbral | 🔴 | search_catalog top-5 coseno crudo, sin min_score → sesgo a genéricos ultron-docs/changelog/test/refactor |
| Especialistas | 🔴 | postgres-pro/rust-engineer caen al puesto 5 |
| intent-rules.yaml / skill_graph.json | 🔴 huérfanos | grep: cero consumidores; classify_intent vivo solo 9 reglas substring |
| routing-decision (juez LLM) | 🔴 | existe ai_router.rs:477, nadie lo llama |
| catalog-reindex en CLI | 🔴 | ultron_memory.rs reindex = solo memoria |

## 4. Diseño objetivo (workflow `wwoac1zg1`): cascade determinista 4 etapas
```
prompt
 -> ENRIQUECER (query-synonyms.json + contexto proyecto)
 E1 REGLAS (intent-rules.yaml, fuente única)  -> conf>=0.90: AUTO-ACTIVAR
 E2 RETRIEVAL semántico (catalog multi-entidad agentes+skills, E5, top-30)
 E3 RERANK (cross-encoder bge-reranker-v2-m3) -> top-5; boost especialista
 E4 UMBRAL: alto -> hint DIRECTIVO "ACTIVATE NOW: Skill(x)"; medio -> sugerir 2; ambiguo -> juez routing-decision
```

## 5. QUÉ FALTA (priorizado)
1. **`index_skills()`** (BLOQUEANTE #1): indexar skills (3 fuentes que skills.rs ya enumera) en `ultron_catalog` con entity="skill" + kind(persona/technical/meta) + id namespaced. Cambiar orchestrator a `search_catalog(query, None, 30)` (agentes+skills).
2. **Reranker** (BLOQUEANTE #2, comparte sidecar con memoria): rerankear top-30 del catálogo vs intent → especialistas baten genéricos.
3. **Hint directivo + un solo router** (#3): en alta confianza, hint imperativo trazable; matar el scoring de routing-dispatcher.js, dejar memory-orchestrate como único.
4. **Descriptions discriminativas** en los 78 agentes + skills (cuándo-usar/cuándo-NO) — la vía que Anthropic garantiza para auto-activación.
5. Reanimar intent-rules.yaml como fuente única + `catalog-reindex` en el CLI.

## 6. Preguntas para la IA
- ¿RAG-over-tools (cientos de skills) con reranker basta, o hace falta un mecanismo que FUERCE la activación (PreToolUse / Skill programática)?
- ¿Umbral auto-activar vs sugerir: qué confianza es segura para auto sin falsos positivos molestos?
- ¿Memoria procedural (qué especialista funcionó por intent, de workflow_runs) para mejorar el routing con el tiempo?
