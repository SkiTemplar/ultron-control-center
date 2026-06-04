# SPECS DEL SISTEMA — Memoria · Skills/Agentes · AI Routing · MCPs
### Documento autocontenido para revisión por una segunda IA (2026-06-04)

> **[RECONCILIADO 2026-06-04 — ver `STATE-RECONCILIATION-2026-06-04.md`]**
> Las menciones a "Quota plomeria ya cableada (quota_watchdog.rs, try_assignment_call:1526 is_critical())"
> estan STALE: Quota fue **QUITADO** en `cbb2d5c`. El "gap 5: Quota ciega" del AI Router ya no aplica.
> HEAD real `823ed67`. Embeddings reales = **E5-Large 1024d** (bge-m3 descartado).

> Objetivo: que una IA externa, SIN acceso al repo, entienda la arquitectura real,
> el estado verificado y los gaps, y proponga mejoras. Todo está cruzado con
> evidencia `archivo:linea` y verificación en runtime. Sé crítico: buscamos el
> mejor sistema de memoria/orquestación LOCAL posible para Claude Code/agentes.

## 0. Contexto y stack
- **Producto**: ULTRON Control Center — app de escritorio **Tauri 2** (backend **Rust**, frontend **React/TS**) en `~/.ultron/`. Es el "cerebro" personal de un dev que trabaja con Claude Code.
- **Rol**: NO es un chatbot con memoria. Es un **Memory-Orchestrated Agent Runtime**: memoria canónica auditable + orquestador que enruta prompts a skills/agentes + router multi-IA. Se integra con Claude Code vía **hooks** (Node) + un **sidecar CLI** (`ultron-memory.exe`, Rust).
- **Almacenes**: SQLite (`~/.ultron/brain.db`, canónico) + Qdrant nativo (`D:\Ultron\qdrant`, índice vectorial) + FTS5 (sparse).
- **Embeddings**: MultilingualE5-Large (1024d) vía `fastembed-rs` 4.9.1 (sidecar/in-proc). `query:`/`passage:` prefijos manuales.
- **Escala real**: 943 memorias active, 34 candidates pending, ~995 eventos, 78 agentes, cientos de skills.

---

## 1. SISTEMA DE MEMORIA

### 1.1 Arquitectura (verificada)
- **SQLite = única fuente de verdad** (`memory/sqlite_store.rs`): tablas `memory_items` + `memory_events` (event-sourcing append-only) + `memory_candidates` + `memory_items_fts` (FTS5).
- **Qdrant = índice derivado, reconstruible** (`memory/qdrant_index.rs`, colección `ultron_memory`, 1024d cosine) vía `reindex_all()`. NUNCA fuente de verdad.
- **MemoryService = ÚNICO escritor persistente** (`memory/service.rs`). Hooks/agentes/CLI solo emiten `memory_candidates` o eventos. Invariante testeado.
- **Recall híbrido** (`commands/memory/recall_unified.rs::build_trace`): dense E5 (Qdrant) + sparse FTS5 → **RRF k=60** → dedup → context pack de *summaries* (no bodies) bajo budget (1500 tok) + lazy-load por id.
- **Retrieval Inspector** (`recall_inspect`): traza why-this-memory + descartados+razón + warnings.
- **Inbox de validación humana** (`commands/memory/inbox.rs`): approve/reject/edit/relabel/deprecate/quarantine/pin/history/do_not_use/stats.
- **Estados**: pending/active/rejected/stale/deprecated/quarantined/archived (enum). **Scopes**: global/user/project/repo/branch/session/workflow/agent/skill (+ `vault` en progreso).
- **Modelo rico** (`memory/model.rs`): `MemoryItem` con id/type/scope/project_id/confidence/importance/stability/**sensitivity**/source/source_session_id/supersedes/superseded_by/contradicts/derived_from/qdrant_point_id/token_estimate/access_count/last_accessed_at/last_injected_at/pinned/validated_by_user/timestamps.
- **ETL one-shot** (`memory/migrations.rs`): importa sessions(Qdrant legacy)+kg.jsonl+decisions(→candidates)+vault, idempotente, con backup + MigrationReport.

### 1.2 Lo que YA es de clase mundial
Gobernanza event-sourced con escritor único (más estricto que Mem0/Letta) · Qdrant=índice reconstruible · inbox auditable + recall_inspect · context pack just-in-time · modelo de dominio rico ya presente.

### 1.3 Hecho en esta sesión (commits en rama `fullize-2026-05-30`)
- **Ola 0 (`1a14a27`)**: gate de `sensitivity=Secret` en `build_trace` (NUNCA inyecta secretos al prompt); cortada la ruta legacy `session-recall-inject.js` (inyectaba `ultron_sessions` SIN filtro status en cada SessionStart); des-registrados `recall_semantic`/`recall_hybrid`.
- **Ola 1a (`b916c5a`)**: coseno E5 real como tie-break del RRF (antes se descartaba); FTS5 phrase→term-OR (causa raíz del "sparse=0": se citaba toda la query como frase exacta); budget del 1er item con truncado UTF-8-safe.
- Tests: 54/54 memoria, 371/372 suite. Rebuild OK.

### 1.4 GAPS de memoria (verificados en runtime — orden de impacto)
1. **Sin reranking de 2ª etapa** (cross-encoder). RRF rank-puro; el coseno solo es tie-break. SOTA (Anthropic Contextual Retrieval, Zep) gana +18-67% con rerank. → bloqueante de calidad.
2. **Contaminación de scope**: 868/943 (92%) son `imported_vault` con `scope=global, project_id=null` → entran en TODA query. Fix en progreso (re-scope a `vault`).
3. **Meta-cognición = 0** (verificado en DB: `superseded_by`=0, `contradicts`=0, `pinned`=0, `access_count`=0): sin contradiction detection (`service.rs:57` es `TODO`), sin reflection/consolidación, sin decay, sin bi-temporal (solo ingestion-time).
4. **Sin evals/golden-queries** → cualquier cambio de recall es fe ciega.
5. **Contextual Retrieval ausente**: se embebe `searchable_text` crudo, sin contexto situacional por item.
6. **KG sin explotar en retrieval** (`kg_entities`=11, `kg_relations`=8 existen, recall no los toca).
7. **Invariantes del pipeline sin test de CI** (los e2e de `build_trace` están `#[ignore]d`).
8. **Secret redaction solo en logs** (`mem0.rs`/`env_keys.rs`), no en write-path de memoria; sin deletion verificado (borrar de SQLite sin borrar el point de Qdrant deja huérfanos).
9. **Doble store legacy muerto**: `recall.rs`/`recall_hybrid.rs`/`qdrant_store.rs` (BGE-384) + `mem0.rs` coexisten (tabla legacy vacía; peso muerto, no conflicto).

---

## 2. SKILLS / AGENTES — AUTO-ROUTING

### 2.1 Cómo funciona HOY (verificado): se SUGIERE, no se activa
- **DOS routers paralelos** en `UserPromptSubmit` (`settings.json`): `routing-dispatcher.js` (keyword/regex hardcodeado: PERSONAS/PLUGINS/AGENTS con pesos trigger=100/strong=60/context=25) + `memory-orchestrate.js` (→ `ultron-memory orchestrate` → `orchestrator.rs`). Pueden emitir hints **contradictorios**.
- Ambos solo **inyectan texto** (`additionalContext`). Los hooks `UserPromptSubmit` de Claude Code **no pueden invocar tools** → la activación la decide el modelo leyendo el hint, que termina en *"ignore if wrong"*. **No determinista.**
- **El catálogo semántico (`memory/catalog.rs`, colección `ultron_catalog`) solo indexa AGENTES** (`entity="agent"` hardcodeado). Las SKILLS nunca entran al retrieval vivo.
- **Sin reranker ni `min_score`** en `search_catalog` (top-5 por coseno E5 crudo) → sesgo a agentes genéricos `ultron-docs/changelog/test/refactor` (descripciones amplias matchean todo); los especialistas (`postgres-pro`, `rust-engineer`) caen al puesto 5.
- **3 ficheros de routing de calidad HUÉRFANOS** (cero consumidores vivos): `intent-rules.yaml` (50+ reglas), `skill_graph.json`, `query-synonyms.json`. El `classify_intent` vivo solo tiene 9 reglas substring.
- Zona juez `routing-decision` existe en `ai_router.rs:477` pero el orquestador nunca la llama.

### 2.2 Diseño objetivo (del workflow `wwoac1zg1`)
Cascade determinista de 4 etapas, gobernado por UN router (el CLI Rust), reuse-over-rebuild:
1. **Reglas** (`intent-rules.yaml` como única fuente) → confidence ≥0.90 = auto-activar.
2. **Retrieval semántico multi-entidad**: `search_catalog(query, None, 30)` con agentes **+ skills** (`index_skills()` = bloqueante #1).
3. **Rerank** cross-encoder (sidecar `ultron-rerank`, bge-reranker-v2-m3) top-30→top-5 (mata el sesgo a genéricos).
4. **Umbral**: alto → hint **directivo** (`ACTIVATE NOW: Skill(x)`); medio → sugerir 2; banda ambigua → juez LLM `routing-decision`.
Además: descriptions discriminativas (cuándo-usar/cuándo-NO) en los 78 agentes + skills (la vía que Anthropic garantiza para auto-activación).

### 2.3 Gaps
Skills no indexadas · sin reranker · sin umbral/determinismo · 2 routers desincronizados · ficheros de routing huérfanos · drift de nombres (`terry-davis`→`senior-engineer`) · sin `catalog-reindex` en el CLI.

---

## 3. AI ROUTING (modelos / multi-IA)

### 3.1 Estado (verificado)
- `ai_router.rs::route(zone, prompt)` (~88KB) **SÍ gobierna ~10 callers reales** (cost_watchdog, hooks_admin, workdays, plugins_info, library, project_agents, sessions_tags) — cadena primary→fallback con providers reales (Anthropic/Groq/Gemini/DeepSeek/Ollama + CLIs), quota-guard (`is_critical`), métricas. (El comentario "solo botón Test" era stale; corregido.)
- **Proxy free-tier real** (Node `ultron-proxy.mjs`): NVIDIA NIM/OpenRouter/Groq con streaming + tool-calls + failover.
- **Quota plomería ya cableada**: `quota_watchdog.rs` (SSOT `quota-state.json`, watcher 60s, eventos `quota:critical/reset`); `try_assignment_call:1526` consulta `is_critical()` antes de cada provider.

### 3.2 Gaps
1. **El orquestador pesado ignora el router**: `delegate_task_inner` (`agent_orchestration.rs:291`) spawnea SIEMPRE `"claude"`; `pty::build_command` ya soporta `claude|codex|gemini` pero nadie elige provider → 80% del valor multi-IA sin capturar.
2. **Kernel de memoria no consume el router**: extracción vive en `stop-compress-session.js` con cascada Groq→Anthropic duplicada; dedupe solo FTS; contradiction = TODO. Las 5 tareas baratas (intent/extract/dedupe/contradiction/summarize) no pasan por el router.
3. **Sin `temperature`/`response_schema`** en `ZoneAssignment` ni wrappers → bloqueante para JSON determinista del kernel.
4. **Sin cache** por input-hash; **sin quality-gate** (fallback solo por error técnico, no por calidad); orden estático (no cost/latency/success-aware aunque las métricas existen).
5. **Quota ciega**: `claude_pct_used` es binario (0 o 99 hardcoded); detector en path equivocado (API key, no la sesión Claude Code Max OAuth); fallback a Codex manual. Fix: leer headers `anthropic-ratelimit-unified-5h/7d`.

---

## 4. MCPs (sin auditar a fondo — input para la 2ª IA)
4 servidores activos en `settings.json`: `context7` (docs), `playwright` (browser), `codex` (gpt-5.5, sandbox read-only), `github` (HTTP, `Authorization: Bearer ${GITHUB_TOKEN}`). Pendiente: auditar estado/salud, seguridad del token (hubo fuga histórica de tokens en docs, ya redactada pero rotación pendiente), y si faltan/sobran MCPs para el caso de uso (memoria/research).

---

## 5. Decisiones técnicas LOCKED
- Embeddings = MultilingualE5-Large 1024d + FTS5 + RRF k=60. **bge-m3 descartado** (fastembed 4.9.1 no lo soporta bien).
- **Mem0 FUERA** del canon (migrado vía ETL kg). ECC → ETL kg.jsonl.
- **Qdrant = índice, NUNCA SoT.** Canónico = SQLite.
- **MemoryService = único escritor.** Hooks/agentes solo candidates/eventos.
- **Backend-first**: la UI "Memory Control Center" se descartó por diseño (toda la funcionalidad está en backend+CLI+inbox).
- **Reuse-over-rebuild**: extender lo existente; los "agentes" del kernel DELEGAN a los 78 agentes reales de `~/.claude/agents`.

## 6. Preguntas abiertas para la 2ª IA (¿qué mejorarías?)
1. ¿RRF+coseno+rerank cross-encoder es la mejor fusión para 943 items multilingües locales, o conviene late-interaction (ColBERT) / score-fusion ponderada?
2. ¿Merece la pena un KG temporal (Zep/Graphiti) sobre SQLite, o el coste/beneficio no compensa a esta escala?
3. Estrategia de meta-cognición: ¿reflection por umbral de importancia (Generative Agents) vs sleep-time compute (Letta) vs consolidación por clustering? ¿Cuál para un solo usuario local?
4. ¿Cómo medir "el mejor del mundo" de forma honesta a escala 1-usuario sin LoCoMo/LongMemEval (que son multi-sesión sintéticos)? ¿Qué golden-set construir?
5. Auto-routing: ¿el hint directivo + descriptions discriminativas basta, o hace falta un mecanismo que fuerce la activación (PreToolUse / Skill programática)?
6. Quota-aware routing: ¿la mejor señal de rate-limit de Claude Max es el header `anthropic-ratelimit-unified-*`, o hay telemetría OTel mejor?
7. Riesgos de memory-poisoning en un sistema con auto-captura (Stop hook → candidates): ¿qué defensas priorizar?

## 7. Referencias del propio repo
- Plan maestro: `cockpit/memory-rework/MASTER-PLAN-CONSOLIDADO-2026-06-03.md` (10 olas).
- Outputs de los 5 workflows de auditoría: auditoría memoria, SOTA, quota, router, skills/agentes (resúmenes en `MEMORY.md` → `session-2026-06-03-audit-masterplan`).
- Biblia de reanudación: `cockpit/memory-rework/STATUS.md`.
