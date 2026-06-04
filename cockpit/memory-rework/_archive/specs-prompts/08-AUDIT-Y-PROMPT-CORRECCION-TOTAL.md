# AUDIT Y PROMPT DE CORRECCION TOTAL - ULTRON MEMORY REWORK

> **[RECONCILIADO 2026-06-04 - ver `../STATE-RECONCILIATION-2026-06-04.md`]** OLA 0 ejecutada.
> El conflicto de Quota (seccion 1, lineas 11/173) YA esta resuelto en codigo: Quota fue QUITADO en `cbb2d5c`;
> la "primera tarea: comprobar si Quota existe" es innecesaria. HEAD real `823ed67` (no `0532dee`).
> `workflow-runs.db` esta en `cockpit/`, no en `~/.ultron/`. SQLite/Qdrant hoy CONSISTENTES (943=943).

Fecha: 2026-06-04
Base leida: `00-PROMPT-CONTINUACION.md`, specs `01..07`, `../STATUS.md`, `../STATUS-SISTEMAS-2026-06-04.md`, `../MASTER-PLAN-CONSOLIDADO-2026-06-03.md`.

## 1. Audit del sistema: lo que falta incluso plantear

### Veredicto
El plan actual arregla piezas reales: recall, reranking, AI router, hooks, skills y multi-IA. Pero sigue siendo un plan de "motor" mas que un plan de "sistema operativo de memoria". Para ser el mejor sistema de memoria/routing/skills no basta con mejorar retrieval: faltan contratos de datos, gobierno, evaluacion continua, seguridad de escritura, control plane, observabilidad, reversibilidad, y una capa de politica formal que gobierne todos los subsistemas.

Hay tambien una inconsistencia documental importante: `00-PROMPT-CONTINUACION.md` y `STATUS-SISTEMAS-2026-06-04.md` hablan de Quota como si siguiera en codigo, pero `04-QUOTA.md` dice que el sistema de porcentaje fue retirado en commit `cbb2d5c` y que hoy no existe en el codigo. El primer paso de cualquier correccion seria resolver esa verdad de estado antes de implementar.

## 2. Huecos transversales

### 2.1 No hay definicion operacional de "mejor del mundo"
Faltan SLOs y metricas de aceptacion por subsistema. El plan usa porcentajes aproximados, pero no define puertas cuantitativas.

Falta implementar:
- North-star metrics: precision@k, recall@k, MRR, nDCG, context-waste-ratio, hallucination-reduction-rate, time-to-resume, time-to-correct-memory, duplicate-rate, contradiction-catch-rate, stale-memory-rate.
- SLOs runtime: latencia p50/p95 de SessionStart, UserPromptSubmit, Stop, recall, rerank, route.
- Error budgets: cuanto puede fallar un hook antes de auto-disable, cuanto puede subir la latencia antes de degradar.
- Definition of Done por ola: tests, e2e, datos reales, rollback, metrica antes/despues.

### 2.2 Falta un contrato de datos canonico de verdad
SQLite es SoT, correcto. Pero el plan no define suficientemente las reglas de identidad, versionado, linaje y consistencia entre SQLite y Qdrant.

Falta implementar:
- `schema_version` y migraciones versionadas con rollback verificado.
- `normalized_text`, `content_hash`, `semantic_cluster_id`, `canonical_entity_ids`.
- Outbox/CDC: cada escritura en SQLite emite evento indexable; Qdrant se actualiza desde una cola idempotente, no por llamadas ad hoc.
- Exactly-once o at-least-once con idempotencia para indexado Qdrant.
- Reconciler periodico SQLite vs Qdrant: missing points, orphan points, dimension drift, payload drift, deleted-but-still-indexed.
- Transacciones: candidato + evento + indice deben tener estado observable si el indice falla.
- Backup/restore testado: restaurar brain.db + reindex Qdrant + comparar checksums/metricas.
- Politica VACUUM/ANALYZE/WAL para SQLite local con crecimiento real.

### 2.3 Dedupe insuficiente
El plan habla de dedupe FTS y dedupe semantico, pero falta un sistema serio de entity resolution.

Falta implementar:
- Deduplicacion por capas: exact hash, normalized hash, shingling/MinHash, SimHash, embedding similarity, entity-aware match.
- Clusters persistentes de duplicados, no solo lista `duplicate_candidates`.
- Merge plan explicable: campos que gana cada item, provenance preservada, rollback posible.
- Umbrales calibrados por dataset, no constantes magicas.
- "Near duplicate but not duplicate": memorias similares con distinta validez temporal o scope no deben fusionarse.
- Deteccion de duplicados multi-idioma y para prompts con ruido.

### 2.4 Seguridad de memoria y anti-poisoning esta incompleta
Hay gate de `Secret` en recall, pero la seguridad de write-path y ingestion sigue abierta.

Falta implementar:
- Secret/PII detector antes de escribir SQLite y antes de generar embeddings.
- Redaccion irreversible para embeddings: no basta con esconder en recall si el secreto ya fue vectorizado.
- Borrado verificable: SQLite, Qdrant, backups, logs, JSONL de delegaciones, hook transcripts.
- Source trust model: user_explicit > tool_observed > assistant_inferred > external/imported.
- Quarantine por defecto para fuentes externas, baja confianza, tool output no confiable y contenido con prompt injection.
- Detector de prompt injection en memorias que luego se inyectan.
- Capability labels: memoria que puede influir routing, memoria solo informativa, memoria nunca inyectable.
- Audit trail de acceso: quien recupero que memoria, cuando, por que query y en que pack.
- Cifrado at-rest opcional para `brain.db`, backups y logs sensibles.

### 2.5 Falta feedback loop real
Inbox existe, pero no hay bucle de aprendizaje con telemetria y correccion.

Falta implementar:
- Botones/acciones: useful, wrong, stale, duplicate, sensitive, should-have-recalled, should-not-have-injected.
- Estos eventos deben alimentar scoring, decay, evals y thresholds.
- Memoria negativa: "no uses X", "X ya no aplica", "este agente fallo para este intent".
- Aprendizaje de routing: intent -> skill/agente/modelo que funciono, con decay y confianza.
- Revision periodica de items con alta injection-rate y baja utilidad.

### 2.6 Falta observabilidad de sistema
Hay metricas sueltas, no observabilidad unificada.

Falta implementar:
- Trace_id por turno: hook -> orchestrator -> recall -> route -> agent -> memory events.
- OpenTelemetry o formato JSONL unico para spans.
- Dashboard minimo: recall latency, hook failures, router fallbacks, cache hits, eval drift, Qdrant sync health.
- Structured errors con taxonomy: provider_error, schema_error, timeout, policy_block, quota_block, index_stale, corrupt_memory.
- Replay tool: dado un trace_id, reconstruir que contexto se inyecto y por que.

### 2.7 Falta control plane
El sistema tiene muchas piezas pero no un panel de mando operativo.

Falta implementar:
- `ultron doctor`: salud de SQLite, Qdrant, hooks, sidecars, MCPs, router keys, versions, permissions.
- `ultron repair`: reindex, reconcile, reinstall hooks, rotate/log check, clear caches.
- `ultron rollback`: volver a snapshot anterior de brain.db/config/hooks.
- `ultron policy explain`: explicar por que se eligio memoria/modelo/agente.
- Version manifest de binarios, hooks, schema y config activa.

## 3. Audit por subsistema

### 3.1 Memoria
El nucleo esta bien orientado: SQLite como SoT, Qdrant derivado, MemoryService unico escritor, inbox, eventos, recall inspect. Lo que falta no es solo reranker; falta convertirlo en un sistema gobernado de conocimiento.

Falta implementar:
- Contextual retrieval por item antes de embeber, con `document_context` versionado y regenerable.
- Query planning: detectar si la query pide decision, tarea, constraint, persona, archivo, proyecto, tiempo, o workflow.
- Retrieval multi-stage: lexical recall, dense recall, graph expansion, rerank, policy filter, diversity/MMR.
- MMR/diversidad para evitar 8 memorias casi iguales.
- Multi-hop retrieval real: memoria -> entidad -> decisiones relacionadas -> tareas abiertas.
- Temporal retrieval: valid_from/valid_to, as-of queries, stale-by-default si contradicho.
- Memory blocks siempre inyectados: identidad, preferencias, reglas duras, proyectos activos, read-only.
- Pack composer por objetivo: no mismo pack para bugfix, planning, review, writing, git.
- Precision control: top-k dinamico por confidence y token budget, no fijo.
- Token value scoring: utilidad esperada por token.
- Contradiction engine con severidad: conflict, supersedes, correction, temporal update, scope mismatch.
- Reflection grounded: toda reflexion debe citar source_ids y ser candidate, nunca active directo.
- Golden set serio: minimo 100-300 queries, categorias, negativos, cross-project, stale, secret, duplicate, temporal.
- Evaluacion de precision, no solo recall@8. Un sistema que recuerda mucho pero mete ruido falla.

### 3.2 AI Router
El router necesita dejar de ser fallback estatico y convertirse en policy engine medible.

Falta implementar:
- Modelo formal de capacidades por provider/modelo: JSON mode, tools, context, vision, code, latency, cost, reliability, local/remote, privacy.
- Policy DSL: zona -> constraints -> candidates -> selection objective.
- Prompt adapters por provider: Anthropic/OpenAI/Gemini/CLI no se comportan igual.
- Structured output validator con retry/escalation por schema_error.
- Circuit breakers por provider/modelo/zona.
- Cache con invalidacion: TTL, project scope, schema version, model version, prompt version.
- Quality sampling: juez o golden tasks para comparar barato vs fuerte.
- Bandit simple o scoring dinamico con success_rate, latency p95, malformed_rate, cost, quota.
- Budget reservation: guardar Claude para tareas heavy/critical sin depender solo de rate-limit.
- Backpressure: si free-tier falla o esta lento, no encadenar 6 timeouts.
- Privacy routing: memorias private/secret nunca salen a modelos remotos no autorizados.

### 3.3 Skills y agentes
El mayor hueco: "auto-activar" depende de la plataforma. Si los hooks solo inyectan texto, el sistema no activa, persuade. Eso hay que tratarlo como limitacion de producto, no como detalle.

Falta implementar:
- Skill/agent manifest normalizado: id, description, when_to_use, when_not_to_use, inputs, outputs, tools, permissions, conflicts, prerequisites, examples, tests.
- Namespacing robusto: plugin:name, persona:name, local:name, agent:name.
- Reindex de skills multi-fuente con version/hash.
- Descripciones discriminativas generadas/revisadas automaticamente.
- Conflict resolver: que pasa si `senior-engineer`, `debugger` y `typescript-pro` compiten.
- Activation policy: directiva fuerte, sugerencia, o no-op segun confidence.
- Histeresis/cooldown: evitar activar 5 skills por prompt.
- Procedural memory: que skill/agente funciono para que intent y proyecto.
- Eval de routing: dataset de prompts -> expected skill/agent, precision@1, precision@3, false positive rate.
- Plataforma: documentar que se puede forzar realmente en Codex/Claude y que solo puede sugerirse.

### 3.4 Orquestador
Hoy es pipeline. Para ser sistema operativo necesita scheduler, state machine y contratos.

Falta implementar:
- Workflow definition schema: triggers, inputs, outputs, allowed_agents, allowed_skills, model_zones, memory_policy, budget, stop conditions.
- State machine persistente: planned, running, waiting_user, waiting_tool, failed, cancelled, completed.
- Idempotency keys por step.
- Cancellation/resume/retry por step.
- Human approval gates: antes de escribir memoria, borrar, rotar tokens, lanzar agentes externos, tocar configs vivas.
- Blackboard tipado, no solo XML/texto.
- Dependency graph entre agentes: parallelizable vs sequential.
- Result contracts: cada agente devuelve structured result + evidence + confidence.
- Score de utilidad de delegacion: no delegar si el coste/latencia supera valor esperado.
- Post-run learning: actualizar procedural memory y eval traces.

### 3.5 Hooks
Los hooks son parte critica del runtime, no scripts auxiliares.

Falta implementar:
- SoT unico versionado con install/uninstall/upgrade atomico.
- Hook manifest: event, command, timeout, env, version, checksum, failure_policy.
- Timeouts adaptativos y warm sidecars.
- Exactly-once capture para Stop: evitar duplicados si se reintenta.
- Circuit breaker: auto-disable hook si falla N veces.
- Prompt budget guard: no inyectar contexto si excede limite o si ya hay contexto equivalente.
- Hook test harness con fixtures de SessionStart/UserPromptSubmit/Stop/PostToolUse.
- Security: hooks no deben leer/escribir stores legacy ni secretos fuera del policy engine.

### 3.6 Quota
El spec esta en conflicto. Si el sistema fue quitado, no debe seguir en el prompt como tarea activa sin reconciliar estado.

Falta decidir:
- Opcion A: no reintroducir quota hasta tener proxy Claude-first real y aceptado.
- Opcion B: implementar "budget-aware routing" sin depender de headers Max: tareas light siempre free/local, heavy Claude/Codex segun policy.
- Opcion C: proxy Claude-first invasivo con rollback y fail-open/fail-closed definido.

Falta implementar si se retoma:
- Senal real, no porcentaje inventado.
- Politica soft-constrained.
- Fallback automatico con confirmacion si implica cambiar sesion.
- Tests de no tumbar sesion si proxy falla.

### 3.7 MCPs
El spec dice "sin auditar"; para un sistema world-class esto es un bloqueo.

Falta implementar:
- MCP inventory real desde config activa.
- Healthcheck por servidor.
- Tool allowlist y permission model por MCP.
- Token scope audit y rotacion.
- Log de tool calls MCP con trace_id.
- Clasificacion: core, optional, dangerous, duplicate.
- Deteccion de memory MCP competing store: cualquier MCP que escriba memoria debe estar bloqueado o pasar por MemoryService.
- Version pinning y supply-chain review de servidores stdio/npm.

### 3.8 Lifecycle / Deprecation Manager
El sistema no tiene un gestor automatico de deprecados. Hay deuda repartida: logs viejos, scripts huerfanos, rutas legacy, stores competidores, sidecars antiguos, configuraciones vivas fuera de git, tablas vacias, colecciones Qdrant antiguas, UI tabs obsoletas, comandos muertos y caches sin TTL. Esto no se arregla con una limpieza manual puntual; necesita un subsistema permanente.

Falta implementar:
- Registro canonico `deprecation_registry`: artefacto, tipo, owner, ruta, motivo, replacement, estado, first_seen, last_seen, deadline, risk, cleanup_action, rollback_action.
- Estados explicitos: `active`, `deprecated`, `shadowed`, `quarantined`, `pending_delete`, `deleted`, `restored`.
- Scanner automatico por dominios: backend Rust, frontend TS/React, hooks Node, scripts PS1/Python, MCP config, Qdrant collections, SQLite tables, caches, logs, sidecars, generated artifacts.
- Politicas de retencion: logs por dias/tamano, traces por sensibilidad, eval runs, backups, hook outputs, provider responses, Qdrant snapshots, UI caches.
- Detectores de deuda: archivos sin referencias, comandos no registrados, hooks no instalados, configs duplicadas, tablas sin lectores, colecciones Qdrant no usadas, features UI sin backend vivo, backend commands sin UI/CLI, scripts que escriben fuera del MemoryService.
- Modo `plan` y modo `apply`: nunca borrar directo sin dry-run, snapshot y rollback.
- Allowlist/denylist: no tocar secretos, bases vivas, backups recientes, migrations, fixtures necesarios, ni datos auditables sin retention policy.
- Integracion con `ultron doctor`: health de deprecados, deuda por severidad, deadlines vencidos.
- Integracion con `ultron repair`: archivar, comprimir, rotar, borrar seguro, reindexar, reinstalar hooks.
- Integracion con UI: panel "Maintenance" con deprecated artifacts, logs/caches, size by category, dry-run, approve cleanup, rollback.
- Tests con fixtures: archivo referenciado no se borra, legacy no referenciado se marca, log viejo se rota, Qdrant collection legacy se propone para delete pero no se borra sin confirmacion.

Contratos minimos:
- Ningun artefacto pasa de `pending_delete` a `deleted` sin backup/snapshot o prueba de que es regenerable.
- Todo delete debe emitir evento auditado con trace_id.
- La limpieza debe ser idempotente.
- La limpieza no puede romper `ultron-memory eval`, `reconcile`, hooks vivos ni startup de la UI.
- Logs con secretos deben ir a redaction/quarantine antes que a compresion normal.

### 3.9 Disk Footprint: ULTRON ocupa ~40 GB
Medicion local hecha el 2026-06-04 sobre `C:\Users\USER\.ultron`:

| Ruta | Tamano aprox. | Lectura tecnica |
|---|---:|---|
| `control-center` | 34.1 GB | Causa principal |
| `control-center/src-tauri/target` | 30.7 GB | Build artifacts Rust/Tauri regenerables |
| `target/debug` | 23.3 GB | Debug build, deps, incremental, PDB/lib enormes |
| `target/release` | 7.4 GB | Release build, deps y build outputs |
| `control-center/src-tauri/.fastembed_cache` | 2.2 GB | Modelo E5 duplicado |
| `.fastembed_cache` | 2.2 GB | Modelo E5 canonico probable |
| `control-center/.fastembed_cache` | 0.9 GB | Cache duplicada adicional |
| `.venv` | 0.87 GB | Python env local |
| `.uv-cache-rescue` | 0.78 GB | Cache UV rescue |
| `backups` | 0.90 GB | Backup `pre-v14.9` concentra casi todo |
| `qdrant_storage` | 0.38 GB | Datos vectoriales reales; no es el problema |

Top extensiones dentro de `src-tauri/target`:
- `.rlib`: ~7.0 GB.
- `.pdb`: ~6.9 GB.
- `.lib`: ~5.6 GB.
- `.rmeta`: ~2.9 GB.
- `.exe`: ~2.25 GB.

Diagnostico:
- El problema no es la memoria canonica ni Qdrant. Es acumulacion de artefactos Rust/Tauri y caches duplicadas de modelos.
- `target/` es regenerable, pero borrarlo degrada el siguiente build porque recompila todo. Debe limpiarse por politica, no a mano sin contexto.
- Las caches `.fastembed_cache` estan duplicadas en varias rutas. El sistema necesita una unica cache canonica configurada por env/path y una politica de dedupe/retention.
- Los backups son pequenos comparados con `target`, pero necesitan rotacion generacional.

Falta implementar:
- `ultron maintenance disk-scan`: top dirs, top files, build artifacts, caches, logs, backups, model caches, Qdrant, SQLite.
- Politica de limpieza por categoria:
  - Build artifacts Rust/Tauri: safe-to-delete si no hay build activo; dry-run; limpiar `target/debug/incremental` primero; limpiar `target/debug` si se acepta recompilar.
  - Release artifacts: conservar ultimo release usable; borrar deps/build antiguos solo con confirmacion.
  - Model caches: canonicalizar `FASTEMBED_CACHE_PATH` o equivalente; detectar duplicados por hash; conservar una copia; eliminar duplicados solo tras verificar.
  - Python/UV caches: limpiar archives antiguos y entornos no referenciados.
  - Backups: rotacion generacional con minimo N recientes + snapshots marcados protected.
  - Logs/traces: TTL + redaction/quarantine si contienen secretos.
- UI Maintenance debe mostrar "Disk Footprint" con:
  - total por categoria.
  - recuperable seguro.
  - recuperable con coste de rebuild.
  - no tocar.
  - acciones: dry-run, clean debug incremental, clean duplicate model cache, rotate logs, rotate backups.

Acceptance minima:
- El sistema puede explicar por que `.ultron` pesa 40 GB sin inspeccion manual.
- El sistema puede proponer liberar espacio en niveles:
  - Nivel 1: logs/caches temporales antiguos, bajo riesgo.
  - Nivel 2: `target/debug/incremental`, duplicados comprobados de modelos, caches UV antiguas.
  - Nivel 3: `target/debug` completo, `target/release` antiguo, backups grandes.
- Ninguna limpieza se ejecuta sin dry-run y confirmacion si afecta build outputs, models, backups o datos.
- Despues de limpiar, `doctor`, `eval`, `reconcile --check` y build smoke siguen pasando o se documenta que hace falta rebuild.

## 4. Riesgos tecnicos que un experto de datos marcaria

- SQLite y Qdrant pueden divergir sin un outbox/reconciler.
- Borrar de SQLite no equivale a borrar de Qdrant, backups, logs ni embeddings ya emitidos.
- Un recall@8 de 0.917 con 12 queries no prueba calidad; puede estar sobreajustado.
- LIKE term-OR es funcional pero no ranking lexical serio; BM25/tokenizer/stopwords deben arreglarse.
- Reranking sin precision tests puede subir scores y bajar utilidad por token.
- Dedupe semantico con umbral fijo puede fusionar hechos temporales distintos.
- Reflection sin grounding crea memoria sintetica no verificable.
- Auto-captura Stop puede envenenar el sistema con inferencias del asistente.
- Skills routing sin evaluacion genera falsos positivos molestos y el usuario lo apagaria.
- Provider routing sin schema validation convierte errores baratos en corrupcion cara.
- Hooks con timeout corto fallan silenciosamente: el usuario cree que hay memoria cuando no hay.
- MCPs con tokens amplios son superficie de ataque y fuga.
- Sin Lifecycle Manager, la deuda vuelve: cada hook viejo, tabla muerta, log sensible o UI zombie acaba compitiendo con el sistema canonico.
- Sin Disk Footprint Manager, `target/`, PDBs, libs, caches de modelos y backups duplicados vuelven a inflar `.ultron` por encima de 40 GB.

## 5. Prompt maestro para corregir todas las facetas

Copiar y pegar el siguiente prompt a la IA que vaya a continuar. Esta version es intencionalmente estricta: obliga a reconciliar verdad, crear contratos, implementar mantenimiento automatico, medir calidad, proteger datos y limpiar deprecados sin romper runtime.

```text
Actua como arquitecto principal, auditor de sistemas de datos y maintainer senior de runtime de agentes. Retomamos ULTRON, un Memory-Orchestrated Agent Runtime local para Codex/Claude/Codex CLI/Gemini, rama `fullize-2026-05-30`, HEAD documentado `0532dee`, carpeta `cockpit/memory-rework/`.

OBJETIVO
No quiero una mejora parcial ni un batch cosmetico. Quiero convertir ULTRON en un sistema de memoria, routing, skills/agentes, hooks, MCPs, UI, backend, mantenimiento y multi-IA de nivel maximo: gobernado, medible, seguro, reversible, observable, autolimpiable y verificable en runtime real.

Tu tarea es corregir TODAS las facetas:
- Memoria canonica y recall.
- Dedupe, contradiction, reflection, temporalidad y lifecycle.
- AI Router y policy engine multi-provider.
- Auto-routing de skills/agentes.
- Orquestador y workflows.
- Hooks y sidecars.
- MCPs y seguridad de herramientas externas.
- UI y backend commands.
- Logs, caches, stores legacy, scripts deprecados y configuraciones vivas.
- Control plane: doctor, repair, rollback, explain, trace replay.

DOCUMENTOS A LEER ANTES DE TOCAR CODIGO, EN ESTE ORDEN
1. `cockpit/memory-rework/specs/00-PROMPT-CONTINUACION.md`
2. `cockpit/memory-rework/STATUS.md`
3. `cockpit/memory-rework/MASTER-PLAN-CONSOLIDADO-2026-06-03.md`
4. `cockpit/memory-rework/STATUS-SISTEMAS-2026-06-04.md`
5. `cockpit/memory-rework/specs/01-MEMORIA.md`
6. `cockpit/memory-rework/specs/02-AI-ROUTER.md`
7. `cockpit/memory-rework/specs/03-SKILLS-AGENTES.md`
8. `cockpit/memory-rework/specs/04-QUOTA.md`
9. `cockpit/memory-rework/specs/05-HOOKS.md`
10. `cockpit/memory-rework/specs/06-ORQUESTADOR.md`
11. `cockpit/memory-rework/specs/07-MCPS.md`
12. `cockpit/memory-rework/specs/08-AUDIT-Y-PROMPT-CORRECCION-TOTAL.md`

REGLAS DURAS
- No redisenes desde cero si ya existe una pieza util. Reuse-over-rebuild.
- SQLite `~/.ultron/brain.db` es la fuente de verdad. Qdrant es indice derivado reconstruible.
- `MemoryService` es el unico escritor persistente de memoria. Hooks, agentes, MCPs, UI, routers y scripts solo emiten candidates/eventos o llaman al servicio.
- Ninguna memoria pasa a `active` sin politica explicita. Auto-captura va a candidate/quarantine segun confianza.
- No escribas secretos en SQLite, Qdrant, logs, backups ni embeddings. Redacta antes de persistir/indexar.
- No borres artefactos sin dry-run, snapshot/rollback o prueba de regenerabilidad.
- Cada cambio debe ser verificable con tests y, cuando toque runtime, con datos reales.
- Cada ola debe ser commiteable por separado, con rollback claro.
- Si hay conflicto entre documentos, no lo ignores: crea primero una nota de reconciliacion de estado y ajusta el plan.
- UV para Python. No uses `python -m`, `pip install` ni `python script.py`; usa `uv run ...` y `uv pip ...`.
- ASCII puro en `.ps1` y `.rs` si el repo ya lo exige.
- No introduzcas otro store de memoria. Cualquier memoria externa/MCP legacy debe ser bloqueada, migrada o tratada como fuente importada hacia `MemoryService`.
- No declares "done" con cargo check solamente. Necesito tests, evals o runtime proof segun el cambio.

MODO DE EJECUCION NOCTURNA
Voy a dejar este trabajo corriendo toda la noche. Opera en modo agente autonomo persistente:
- No pares tras el analisis. Ejecuta, verifica, documenta y continua con la siguiente unidad segura.
- Lanza multiples workflows/agentes en paralelo cuando sean independientes: auditoria de disco, auditoria de hooks, auditoria MCP, auditoria UI/backend, evals, inventory de deprecados, y reconciliacion SQLite/Qdrant.
- Usa patron Wave -> Checkpoint -> Wave:
  - Wave 1: solo lectura e inventario en paralelo.
  - Checkpoint 1: sintetiza hallazgos, riesgos, prioridades y bloqueos.
  - Wave 2: implementaciones seguras y no destructivas.
  - Checkpoint 2: tests, runtime proof, docs/status.
  - Wave 3: siguientes tareas desbloqueadas.
- Crea archivos nuevos de analisis cuando sirvan para paralelizar. El wiring final en configs vivas, hooks globales, borrados, rotaciones de token y acciones irreversibles requiere confirmacion explicita.
- Si una tarea queda bloqueada por permisos, secretos, app abierta, Qdrant caido, token rotation o borrado destructivo, documenta el bloqueo y continua con otra tarea independiente.
- No esperes input para decisiones de bajo riesgo si hay una opcion conservadora clara.
- No inventes estado. Si no puedes verificar algo, marcalo como `unverified`.
- Mantén un log de progreso en `cockpit/memory-rework/NIGHT-RUN-YYYY-MM-DD.md` con: timestamp, workflow, accion, evidencia, resultado, siguiente paso.

PRIORIZACION OBLIGATORIA
- P0: seguridad, no data loss, secretos, corrupcion, stores competidores, escrituras fuera del SoT.
- P1: reconciliacion de estado, disk footprint, deprecados, hooks vivos, backups, rollback.
- P2: consistencia SQLite/Qdrant, outbox/reconciler, eval baseline, trace/replay.
- P3: retrieval avanzado, dedupe, contradiction, temporalidad, reflection.
- P4: AI Router, skills/agentes, orquestador multi-IA.
- P5: UI polish. La UI solo va antes si es necesaria para operar mantenimiento/health.

STOP CONDITIONS
Para esa unidad concreta, detente y pasa a otra tarea independiente si ocurre cualquiera:
- `brain.db` y Qdrant divergen y no hay snapshot o plan de repair seguro.
- Una accion podria borrar datos no regenerables.
- Una accion requiere rotar tokens, tocar secretos o modificar config viva global.
- Qdrant no responde y la tarea depende de Qdrant.
- La app ULTRON bloquea rebuild y no se puede cerrar sin el usuario.
- Un test de seguridad falla: secret leak, stale leak, cross-project leak, rejected/deprecated injection.
- Una migracion no tiene rollback.
- La limpieza de disco no puede distinguir cache regenerable de dato canonico.

NO-DATA-LOSS CONTRACT
- Antes de migraciones, deletes, cleanup o rewrites de stores: snapshot o backup verificable.
- Todo borrado debe tener dry-run, lista de paths/rows/collections afectados, motivo, riesgo y rollback.
- Todo delete persistente emite evento auditado.
- Ningun backup protected se borra.
- Ninguna cache de modelo se borra si no existe cache canonica verificada o si el sistema depende de esa ruta.
- No se borra `qdrant_storage`, `brain.db`, `workflow-runs.db`, hooks vivos ni settings globales sin confirmacion explicita.

THREAT MODEL MINIMO
Debes proteger contra:
- Secret leakage a SQLite, Qdrant, logs, backups, traces, provider prompts y embeddings.
- Memory poisoning por Stop hooks, MCPs, tool output, assistant_inferred y contenido importado.
- Prompt injection persistido dentro de memorias que luego se inyectan.
- MCP tool abuse o servidores con tokens amplios.
- Modelo remoto recibiendo private/secret data.
- Hooks o scripts escribiendo directo a stores legacy.
- UI mostrando acciones destructivas sin dry-run/confirmacion.
- Cache/model/log duplicado creciendo sin TTL.

PERFORMANCE BUDGETS INICIALES
Si no existen mediciones mejores, usa estos presupuestos iniciales y ajustalos tras medir:
- SessionStart memory resume: p95 <= 2.5s, hard timeout <= 5s.
- UserPromptSubmit orchestration: p95 <= 3.5s, hard timeout <= 8s.
- Recall sin reranker: p95 <= 800ms con Qdrant warm.
- Recall con reranker: p95 <= 2.5s o fallback sin rerank.
- Stop hook candidate extraction: hard timeout <= 15s, fail-safe no-op.
- Disk scan: p95 <= 30s para resumen; deep scan puede ser job background.
- Context pack: max 1500 tokens por defecto salvo policy explicita.
- Injected memories: max dinamico por utilidad/token; evita top-k fijo si hay ruido.

IMPLEMENTATION RFC POR OLA
Antes de tocar codigo en cada ola, escribe un mini RFC en el log nocturno:
- Objetivo.
- Archivos afectados.
- Cambios de schema/config.
- Riesgos.
- Rollback.
- Tests.
- Runtime verification.
- Impacto esperado en disco/memoria/latencia.
- Que se hara en paralelo y que requiere wiring manual.

PRIMERA TAREA: RECONCILIACION DE VERDAD
Antes de implementar:
1. Verifica branch, HEAD, estado git y archivos modificados.
2. Comprueba si Quota existe o fue retirado: `04-QUOTA.md` dice que se quito en `cbb2d5c`, mientras otros docs aun lo tratan como vivo. Decide y documenta el estado real.
3. Verifica que Qdrant esta arriba y que `ultron_memory` existe.
4. Verifica que `brain.db` tiene items/candidates/eventos esperados.
5. Verifica que hooks vivos apuntan a la SoT esperada.
6. Verifica que UI y backend commands estan alineados: comandos Tauri vivos, tabs visibles, handlers reales, rutas muertas.
7. Inventaria logs, caches, backups, Qdrant collections, SQLite tables, sidecars, scripts legacy, MCPs y config files.
8. Produce `cockpit/memory-rework/STATE-RECONCILIATION-YYYY-MM-DD.md` con: verdad actual, docs stale, riesgos, artefactos deprecados, decisiones bloqueantes y plan ajustado.

DEFINITION OF WORLD-CLASS DONE
No declares terminado hasta cumplir:
- Evals reproducibles con dataset >=100 queries: recall@k, precision@k, MRR, nDCG, context-waste-ratio, secret-leak tests, stale-memory tests, duplicate tests, temporal tests, cross-project tests.
- Observabilidad con trace_id por turno: hook -> orchestrator -> recall -> router -> agent -> memory event.
- Reconciler SQLite/Qdrant: detecta y repara missing/orphan/stale points.
- Write-path seguro: secret/PII redaction antes de SQLite/Qdrant/logs.
- Dedupe multicapa: exact, normalized, shingle/SimHash o MinHash, embedding, entity-aware.
- Contradiction/supersession bitemporal: valid_from/valid_to, source_ids, rollback.
- AI Router con schema validation, temperature, response_schema, cache, selector dinamico, circuit breakers y privacy routing.
- Skills/agentes con catalogo multi-entidad, manifests normalizados, reranker, umbrales, conflictos, cooldown y eval de routing.
- Orquestador con workflow schema, state machine persistente, idempotency, retry/cancel/resume, blackboard tipado y human gates.
- Hooks con manifest, installer, tests, timeout/circuit breaker, exactly-once Stop->candidate y SoT unica.
- MCPs auditados: health, allowlist, token scopes, version pinning, no competing memory store.
- Lifecycle/Deprecation Manager: detecta, clasifica, archiva, rota, limpia y revierte artefactos obsoletos en backend, UI, hooks, logs, caches, stores, MCPs y sidecars.
- Disk Footprint Manager: explica y reduce el uso de disco de `.ultron` con dry-run, politicas por categoria y rollback cuando aplique.
- Doctor/repair/rollback/explain/trace commands para operar el sistema sin adivinar.

ARQUITECTURA OBJETIVO MINIMA
Implementa o deja especificado con contracts claros:

1. Memory Core
- `memory_items`, `memory_events`, `memory_candidates` siguen siendo canonicos.
- Agregar si falta: `schema_version`, `normalized_text`, `content_hash`, `semantic_cluster_id`, `valid_from`, `valid_to`, `retention_class`, `injection_policy`, `source_trust`.
- No se indexa en Qdrant contenido no redactado.
- Todo item tiene provenance suficiente: source, source_ids, source_session_id, derived_from, confidence, sensitivity.

2. Index Consistency
- SQLite escribe outbox indexable.
- Qdrant consume outbox con idempotency key.
- `ultron-memory reconcile --check` detecta missing/orphan/stale/dimension/payload drift.
- `ultron-memory reconcile --repair` repara con dry-run previo.

3. Evaluation
- `ultron-memory eval` debe producir JSON y tabla persistida `eval_runs`.
- Metrics minimas: recall@k, precision@k, MRR, nDCG, context_waste, secret_leak_count, stale_leak_count, duplicate_merge_error_count, latency p50/p95.
- Cada cambio de retrieval/router/routing compara contra baseline.

4. Lifecycle / Deprecation Manager
- Crear registro canonico de deprecados y retencion.
- Escanear backend, UI, hooks, logs, caches, Qdrant, SQLite, MCPs, sidecars, configs.
- Dry-run obligatorio.
- Borrado solo con snapshot/rollback o regenerabilidad probada.
- Integrar con UI "Maintenance" y CLI `ultron maintenance`.

5. Disk Footprint Manager
- `ultron maintenance disk-scan` explica el tamano de `.ultron` por categoria.
- Categorias minimas: rust_target_debug, rust_target_release, rust_incremental, pdb_symbols, model_cache, python_env, uv_cache, backups, logs, qdrant, sqlite, node_modules, dist.
- Politicas minimas:
  - `target/debug/incremental`: limpiable con confirmacion; coste: recompilacion parcial.
  - `target/debug`: limpiable con confirmacion fuerte; coste: recompilacion pesada.
  - `target/release`: conservar ultimo release/binario instalado; limpiar restos antiguos con confirmacion.
  - `.fastembed_cache`: detectar duplicados por hash/model id; conservar cache canonica; borrar duplicados solo tras prueba.
  - backups: rotacion generacional; no borrar protected.
  - logs/traces: TTL y redaction.
- UI Maintenance debe mostrar recuperable seguro, recuperable con coste de rebuild y no-tocar.

6. AI Router
- Zones con temperature, response_schema, privacy policy, cache policy, timeout, retry, providers, fallback.
- Validator de schema con retry/escalation.
- Selector dinamico por capability, key availability, privacy, latency, success, malformed rate, cost/quota.
- Circuit breakers y backpressure.

7. Skills/Agents
- Catalogo multi-entidad con manifests normalizados.
- Reranker y thresholds.
- Conflict resolver y cooldown.
- Procedural memory de que funciono por intent/proyecto.
- Eval de routing con expected skill/agent.

8. Orchestrator
- Workflows declarativos con triggers, allowed_agents, allowed_skills, model_zones, memory_policy, budget y stop conditions.
- State machine persistente.
- Blackboard tipado.
- Result contracts con evidence/confidence.
- Human gates para acciones sensibles.

9. Hooks
- SoT unica versionada.
- Hook manifest con event, command, timeout, env, checksum, failure policy.
- Stop -> candidate via sidecar, nunca Qdrant/Mem0 directo.
- Circuit breaker y tests con fixtures.

10. MCPs
- Inventory, health, allowlist, token scopes, version pinning.
- Bloquear stores de memoria competidores.
- Rotar tokens comprometidos.

11. UI/Backend
- Ningun tab visible sin backend vivo.
- Ningun backend command sin owner, tests y UI/CLI decision.
- Panel Maintenance: deprecados, logs, caches, dry-run cleanup, rollback.
- Panel Health: Qdrant sync, eval drift, hook status, router status, MCP status.

PLAN DE IMPLEMENTACION OBLIGATORIO
Implementa por olas. No saltes una ola si su output bloquea las siguientes.

OLA 0 - Reconciliacion, inventario y mapa de riesgo
- Leer docs y codigo afectado.
- Producir `STATE-RECONCILIATION-YYYY-MM-DD.md`.
- Inventariar artifacts vivos/deprecados: Rust modules, Tauri commands, React tabs, Node hooks, scripts, MCPs, Qdrant collections, SQLite tables, logs, caches, sidecars, config files.
- Medir disk footprint de `C:\Users\USER\.ultron`: top directories, top files, build artifacts, model caches, backups, logs, Qdrant y SQLite.
- Resolver el conflicto de Quota en docs vs codigo.
- Acceptance:
  - Documento de verdad actual creado.
  - Tabla de deprecados inicial con owner/risk/replacement.
  - Tabla de disk footprint creada con categorias y riesgo de limpieza.
  - No hay cambios funcionales todavia.

OLA A - Seguridad, contratos y policy schemas
- Reconciliar docs vs codigo.
- Crear metricas/SLOs por subsistema y Definition of Done por ola.
- Definir schema de policy y manifest: memory policy, router policy, skill/agent manifest, hook manifest, MCP policy.
- Implementar secret/PII detector en write-path antes de embeddings.
- Implementar source trust model y quarantine por defecto para fuentes externas/baja confianza.
- Implementar prompt-injection detector para memorias que podrian inyectarse.
- Acceptance:
  - Tests de no persistir ni indexar secretos.
  - Fuentes externas/baja confianza entran en quarantine.
  - Policy schemas versionados.
  - Docs reconciliados.

OLA B - Consistencia de datos
- Implementar outbox/CDC desde SQLite para indexado Qdrant.
- Implementar reconciler SQLite/Qdrant y comando `ultron-memory reconcile`.
- Implementar schema_version, normalized_text, content_hash, semantic_cluster_id.
- Implementar backup/restore testado y checksums.
- Acceptance:
  - Borrar/reindex/restaurar produce indices consistentes.
  - Orphan/missing/stale points detectados.
  - `reconcile --check` no modifica; `reconcile --repair` exige dry-run/confirmacion.

OLA C - Evals serias antes de tocar ranking
- Crear golden set >=100 queries categorizadas.
- Medir recall@k, precision@k, MRR, nDCG, context waste, secret leak, stale leak, cross-project leak, duplicate false merge, temporal correctness.
- Guardar eval_runs con git_sha/config/model versions.
- Acceptance:
  - Baseline reproducible.
  - Comparacion automatica antes/despues.
  - Cualquier cambio de retrieval falla si filtra secret/stale/cross-project.

OLA D - Retrieval de clase alta
- Arreglar BM25/FTS5 real o integrar lexical ranking equivalente.
- Implementar contextual retrieval versionado.
- Implementar RRF + reranker cross-encoder + MMR/diversidad.
- Implementar query planning y pack composer por tarea.
- Implementar KG 1-hop solo si mejora evals, no por estetica.
- Acceptance:
  - Precision/context-waste mejoran sin regression de recall critico.
  - No hay regression de secret/stale/cross-project.
  - Latencia p95 queda dentro del SLO definido o hay degradacion controlada.

OLA E - Dedupe, contradiction y ciclo de vida
- Dedupe multicapa con clusters persistentes.
- Contradiction engine conectado a `create_candidate`.
- Supersession bitemporal con valid_from/valid_to.
- Reflection grounded con source_ids y candidate-only.
- Decay/stale sweep con pinned/validated protected.
- Acceptance:
  - Duplicados reales se agrupan sin fusionar hechos temporales distintos.
  - Contradicciones se quarantinan, nunca auto-approve.
  - Temporal queries funcionan.
  - Reflection siempre cita source_ids y entra como candidate.

OLA F - AI Router como policy engine
- `temperature` y `response_schema` en zones y wrappers.
- Validacion de JSON/schema con retry/escalation.
- Cache por hash con TTL/versionado.
- Selector dinamico por capability/cost/latency/success/quota/privacy.
- Circuit breakers y backpressure.
- Privacy routing: private/secret no sale a modelos remotos no autorizados.
- Acceptance:
  - Tareas memory-extract/contradict/query-rewrite devuelven JSON valido o escalan.
  - Cache hit medible.
  - Provider roto abre circuit breaker.
  - Metricas registradas por zone/model/provider.

OLA G - Skills/agentes auto-routing serio
- Indexar skills y agentes con manifest normalizado.
- Reanimar `intent-rules.yaml` como SoT o sustituirlo por policy declarativa.
- Reranker de catalogo + thresholds + conflict resolver + cooldown.
- Procedural memory: intent/proyecto -> skill/agente que funciono.
- Eval de routing con prompts etiquetados.
- Acceptance:
  - precision@1/3 supera baseline.
  - Especialistas vencen genericos en casos etiquetados.
  - Falsos positivos y multi-activaciones quedan bajo umbral.
  - Se documenta que puede forzarse y que solo puede sugerirse segun plataforma.

OLA H - Orquestador operativo
- Workflow schema declarativo con triggers, allowed_agents, allowed_skills, model_zones, memory_policy, budgets.
- State machine persistente con retry/cancel/resume.
- Blackboard tipado y result contracts por agente.
- Human gates para acciones sensibles.
- Multi-IA dispatch real a Claude/Codex/Gemini via policy.
- Acceptance:
  - Workflow puede pausarse, reanudarse, fallar y recuperarse sin perder estado.
  - Cada step tiene idempotency key.
  - Delegaciones paralelas respetan dependencies.

OLA I - Hooks robustos
- SoT unica en `~/.ultron/hooks`.
- Installer/uninstaller/upgrade atomico.
- Hook manifest con checksum, timeout, env, failure_policy.
- Stop hook escribe candidates via `ultron-memory candidate`, nunca Qdrant/Mem0 directo.
- Circuit breaker y test harness.
- Acceptance:
  - Hooks probados con fixtures.
  - Stop es idempotente.
  - Hook failure no rompe la sesion.
  - No hay stores legacy vivos ni escrituras directas a Qdrant/Mem0.

OLA J - MCP audit
- Inventario real de MCPs activos.
- Healthcheck, allowlist, token scope audit, version pinning.
- Bloquear MCP memory competing store salvo que pase por MemoryService.
- Rotar tokens comprometidos.
- Acceptance:
  - `ultron doctor` reporta MCP health/security.
  - No hay token literal.
  - MCPs peligrosos o duplicados quedan disabled/quarantined.

OLA K - Lifecycle / Deprecation Manager
- Crear `deprecation_registry` persistente.
- Crear scanners:
  - Rust/backend: modules, commands, features, dead exports, legacy recall paths.
  - UI: tabs/components sin backend, backend commands sin UI/CLI, stale feature flags.
  - Hooks/scripts: scripts no instalados, scripts vivos fuera de SoT, direct writes a stores.
  - Data: SQLite tables vacias/no leidas, Qdrant collections legacy, old backups, eval runs, caches.
  - Logs: logs viejos, logs grandes, logs con secretos, hook outputs, provider responses.
  - MCPs/sidecars: servers no usados, sidecars antiguos, config duplicada.
- Crear politicas de retention por categoria:
  - security/audit logs: conservar segun sensibilidad, redacted.
  - traces: TTL corto si contienen prompt/model output.
  - eval runs: conservar resumidos, comprimir detalles antiguos.
  - backups: rotacion generacional.
  - caches: TTL por schema/model/version.
- Crear comandos:
  - `ultron maintenance scan`
  - `ultron maintenance plan`
  - `ultron maintenance apply --confirm`
  - `ultron maintenance restore <snapshot>`
  - `ultron maintenance explain <artifact>`
- Crear UI Maintenance:
  - lista de deprecados por severidad.
  - logs/caches por tamano.
  - dry-run diff.
  - aprobar limpieza.
  - rollback.
- Acceptance:
  - Dry-run lista que se borraria y por que.
  - Nada se borra sin snapshot/rollback o regenerabilidad probada.
  - Logs viejos se rotan/comprimen segun policy.
  - Logs con secretos se quarantinan/redactan.
  - UI muestra estado real y no permite acciones destructivas sin confirmacion.
  - Tests prueban idempotencia y no borrado de artefactos referenciados.

OLA L - Disk Footprint Manager
- Crear `ultron maintenance disk-scan`.
- Crear `ultron maintenance disk-plan`.
- Crear `ultron maintenance disk-apply --confirm`.
- Clasificar espacio por categoria:
  - Rust/Tauri target debug/release/incremental.
  - PDB/lib/rlib/rmeta/exe grandes.
  - Model caches `.fastembed_cache`.
  - Python envs y UV caches.
  - Node modules/dist.
  - Qdrant/SQLite.
  - logs/traces/backups.
- Implementar recomendaciones por nivel:
  - Nivel 1: logs antiguos, temp/caches con TTL vencido.
  - Nivel 2: incremental Rust, caches duplicadas verificadas, UV archives antiguos.
  - Nivel 3: target debug/release, backups grandes no protected.
- UI Maintenance -> Disk Footprint:
  - mostrar total actual.
  - mostrar liberable por nivel.
  - mostrar coste: safe, rebuild-required, risky.
  - boton dry-run.
  - boton apply con confirmacion.
  - boton rollback si aplica.
- Acceptance:
  - El sistema explica los ~40 GB actuales.
  - Detecta `control-center/src-tauri/target` como causa principal.
  - Detecta caches E5 duplicadas.
  - No borra Qdrant/SQLite/model cache canonica/backups protected.
  - Despues de limpieza de nivel 1/2, `doctor` sigue verde.

OLA M - Control plane, UI Health y cleanup final
- `ultron doctor`, `ultron repair`, `ultron rollback`, `ultron policy explain`, `ultron trace replay`.
- Dashboard minimo de health/metrics:
  - SQLite/Qdrant sync.
  - eval drift.
  - hook status.
  - router status.
  - MCP status.
  - deprecation debt.
  - disk footprint.
- Cleanup controlado de recall legacy, qdrant_store 384, Mem0, scripts huerfanos, UI zombie.
- Acceptance:
  - Un operador puede diagnosticar, reparar, limpiar, revertir y explicar el sistema sin leer codigo.
  - Startup UI/backend sigue verde.
  - `eval`, `reconcile`, `doctor` y hooks smoke pasan.

FORMATO DE TRABAJO
Para cada ola:
1. Lee archivos afectados.
2. Declara hipotesis, riesgos, rollback y acceptance.
3. Implementa cambios pequenos.
4. Ejecuta tests relevantes.
5. Ejecuta verificacion runtime si aplica.
6. Compara metricas contra baseline.
7. Actualiza docs/status si la verdad cambio.
8. Commit por unidad cerrada.

COMANDOS DE VERIFICACION BASE
- `cargo test --no-default-features --lib memory`
- `cargo build --release --bin ultron-memory --features qdrant`
- `ultron-memory eval`
- `ultron-memory reconcile --check`
- `ultron doctor`
- `ultron maintenance scan`
- `ultron maintenance plan`
- `ultron maintenance disk-scan`
- `ultron maintenance disk-plan`
- `curl http://127.0.0.1:6333/collections/ultron_memory`
- Para Python: `uv run pytest ...`

OUTPUT ESPERADO
Primero entrega:
- Reconciliacion de estado.
- Lista de docs stale.
- Inventario de deprecados y retention gaps.
- Diagnostico de por que `.ultron` ocupa ~40 GB y plan de reduccion seguro.
- Plan ajustado por olas con acceptance.
- Riesgos que requieren decision humana.
- Plan de workflows paralelos para la noche: nombre, objetivo, inputs, outputs, riesgos, dependencia.
- Primer checkpoint con que se puede ejecutar sin supervision y que queda bloqueado por confirmacion.

Luego implementa en orden. No afirmes que esta terminado sin pruebas. Si una decision requiere acceso a secretos, cierre de app, proxy invasivo, rotacion de token, borrado irreversible o modificacion de config viva, pide confirmacion explicita.
```

## 6. Recomendacion ejecutiva

No empieces por reranker ni por UI bonita. Empieza por verdad, contratos, seguridad y mantenimiento. El reranker mejora ranking; no arregla corrupcion, secretos, duplicados, memoria falsa, hooks fragiles, skills mal activadas ni basura deprecada acumulandose.

Orden recomendado:
1. Reconciliacion de estado y docs.
2. Inventario de deprecados/logs/caches/stores legacy.
3. Disk footprint scan: explicar los ~40 GB y separar seguro/rebuild/riesgo.
4. Secret/PII write-path + anti-poisoning.
5. Outbox/reconciler SQLite-Qdrant.
6. Evals >=100 + trace_id.
7. Lifecycle/Deprecation Manager con dry-run y rollback.
8. Disk Footprint Manager integrado en Maintenance UI.
9. Stop->candidate + hooks SoT.
10. Contradiction/dedupe/reflection.
11. Reranker y contextual retrieval.
12. Router policy engine.
13. Skills/agents eval + activation policy.
14. MCP audit + control plane + UI Maintenance/Health.
