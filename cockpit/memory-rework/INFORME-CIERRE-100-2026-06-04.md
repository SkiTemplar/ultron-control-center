# INFORME FORMAL DE CIERRE — ULTRON Memory Rework — 2026-06-04

> Producido por el prompt `specs/09-PROMPT-MEJORA-SPECS-Y-CORRECCION-100.md`.
> Reconciliación de verdad + auditoría formal de specs + contratos + threat model + plan a 100%.
> Base de evidencia: sondeo inline (git/Qdrant/sidecar/config viva) + 2 workflows paralelos
> (`w2kfy46sd`, 11 agentes, 1.18M tokens, audit por spec + threat/contratos/readiness) y
> (`wvicemkxj`, 7 agentes, diseño-a-100). HEAD verificado **`f936a66`**. CERO cambios funcionales en este informe.
>
> **Docs de verdad de referencia**: este informe + `STATE-RECONCILIATION-2026-06-04.md` + `CONTRACTS-2026-06-04.md`
> + `STATUS.md`/`04-QUOTA.md`. Todo lo demás se reconcilia contra ellos.

---

## 1. Resumen ejecutivo

**El núcleo de memoria es seguro, consistente y medible** (OLA 0/A/B/C cerradas y verificadas en runtime
real, no `cargo check`). Lo que separa al sistema del "100%" **no es el núcleo** sino tres capas:
(1) **gobernanza formal** (specs sin acceptance/tests/rollback; contratos a medio implementar),
(2) **motor avanzado** (reranker, dedupe L2-L4, contradiction/reflection cableados, router policy engine,
skills routing), y (3) **control plane + observabilidad** (doctor/repair/rollback/trace_id, lifecycle/disk CLI).

**Veredicto por spec**: los 8 specs (00-07) tienen el **cuerpo técnico mayormente correcto y evidenciado**,
pero **ninguno es un spec formal**: 0/8 cumplen el `spec_contract_check` completo (acceptance + tests +
runtime-verification + rollback). Todos son **P1** (corrección documental + formalización).

**5 hallazgos nuevos no registrados en los docs vivos** (todos con evidencia file:line):

| # | Hallazgo | Sev | Fuente |
|---|---|---|---|
| H1 | **Token OAuth `gho_…` (40 chars) HARDCODEADO en plaintext** en `~/.claude.json` (MCP `github-pat`). El spec 07 no lo ve porque solo mira `settings.json`. **Distinto** de la rotación histórica (cerrada/confirmada por USER, kanban `042636c`). | **P1 seguridad** | audit 07 |
| H2 | **`sensitivity` NUNCA se asigna en el write-path**: `classify_sensitivity()` existe y está testeado pero **0 callers** → el gate `Secret` del recall está **hueco** (nada marca Secret, así que nunca filtra). | **P1 seguridad** | threat-model |
| H3 | **`memory_unified_search` lee stores competidores** (ultron_sessions 384d + Mem0 + KG) **saltándose los gates de gobernanza** de `recall_pack`. Superficie de lectura paralela sin filtros status/scope/sensitivity. | **P1 seguridad** | threat-model |
| H4 | **No existe borrado verificable (`forget`)**: `delete_item` es SQLite-only, sin caller, no cubre Qdrant/audit/backups. Viola el contrato "borrado verificable". | **P1** | threat-model |
| H5 | **`ultron_sessions` (384d) READ-path vivo**: el WRITE se cortó (OLA I, verificado) pero `memory_unified_search` **aún la lee** en cada query (`memory_graph.rs:201`). Los docs celebran "cortado" omitiendo el read. | **P1** | 6 specs |

**Correcciones a la "verdad runtime" del propio prompt #09**: (a) la rotación de `GITHUB_TOKEN` **NO está
pendiente** — fue confirmada cerrada por USER el 2026-05-29 (`042636c`); lo abierto es H1 (hardcode nuevo
del token ya rotado). (b) `ai_tasks::judge_contradiction` **sí tiene** un caller (`contradiction.rs:105`),
aunque `contradiction.rs` en su conjunto siga huérfano de producción.

---

## 2. Estado de verdad reconciliado (runtime 2026-06-04)

| Dimensión | Verdad verificada | Evidencia |
|---|---|---|
| git | rama `fullize-2026-05-30`, HEAD **`f936a66`**, worktree limpio salvo untracked `specs/09-…md` | `git rev-parse HEAD` |
| SQLite SoT | `brain.db` 2.32MB, **943 active / 34 candidates** / 0 stale/0 deprecated/0 rejected, schema_version=2, events=1043 | `ultron-memory stats` |
| Qdrant | `ultron_memory` **943 pts / 1024d** Cosine `in_sync=true`; `ultron_catalog` **78 pts / 1024d (solo agentes)**; `ultron_sessions` **72 pts / 384d WRITE-DEAD pero leída** | Qdrant API; `reconcile --check` |
| Seguridad write-path | redaction OLA A **cableada** en `create_candidate` (service.rs:48-52) y `add_imported` (service.rs:171-174); embeddings desde texto YA redactado | service.rs; qdrant_index.rs:43-48 |
| Consistencia | content_hash (FNV-1a) + normalized_text + schema_version end-to-end + migración aditiva backfill 943/943; `reconcile --check` read-only | texthash.rs; sqlite_store.rs; bin:57 |
| Evals | recall@8=**0.9166**, secret_leak=0, stale_leak=0 | `ultron-memory eval`; evals.rs:279 |
| Limpieza P0 config viva | **APLICADA y verificada**: `mem0-sync`+`quota-capture` de-registrados, `PostToolUse=[]`, `quota-state.json` borrado, `stop-compress` upsert retirado (helpers dead-code; live==versionado). Backup en `backups/config-2026-06-04-preP0/` | settings.json; git show d3a16ff |
| Quota | **QUITADO** en `cbb2d5c` (quota_watchdog.rs -465, ai_router -82); 0 matches `quota` en src; residuos UI huérfanos (DR-09..13) | git show cbb2d5c |
| Hooks vivos | Stop=[stop-compress, kanban-update-reminder, batch-capture]; SessionStart=[load-cross-project, session-start-override, workday-session-linker, memory-session-resume]; UserPromptSubmit=[routing-dispatcher, save-user-prompt, memory-orchestrate]. **SoT fragmentada** (`~/.claude/scripts` no-versionado + `~/.ultron/hooks` versionado) | settings.json |
| Sidecar | `ultron-memory.exe` (bin/ + target/release) subcomandos resume/orchestrate/recall/stats/reindex/eval/reconcile/candidate; subcomando `candidate`→`MemoryService::create_candidate` **cableado** | ultron_memory.rs:40-99 |
| Lógica real SIN wiring de prod | `contradiction.rs` (lógica real `:69-110`, llama judge; TODO sin cablear `service.rs:67-71`), `ai_tasks.rs` (extract/rewrite sin caller; judge usado por contradiction), `reflection.rs` (`reflect`/`insights_to_candidates` reales `:75-170`, sin subcomando); `index_skills()` **inexistente** | grep src (validado Codex/Gemini) |
| Disco | ~40GB (`target` 36GB regenerable + `.fastembed_cache` ×6 ~3.5GB dup + backup 899MB) | DISK-FOOTPRINT |

---

## 3. Tratamiento de `08-AUDIT-…md` como histórico

`08` es el **prompt maestro anterior**: una lista de deseos "world-class" comprehensiva. Se trata como
**material histórico**, no fuente de verdad. Clasificación de su contenido:

- **YA HECHO (superado por OLA 0/A/B/C)**: reconciliación de estado (→ `STATE-RECONCILIATION`), inventario
  de deprecados (→ `DEPRECATION-REGISTRY` 42 artefactos), disk scan (→ `DISK-FOOTPRINT`), contratos de
  policy (→ `CONTRACTS`), secret/PII redaction write-path (OLA A), content_hash/normalized_text/schema_version
  + reconcile (OLA B), eval security gate (OLA C). Sus framings stale (HEAD `0532dee`, "primera tarea:
  comprobar si Quota existe") están **superados** y el propio doc ya lleva banner de reconciliación.
- **VÁLIDO Y NO IMPLEMENTADO (alimenta el backlog)**: SLOs/perf budgets, north-star metrics
  (precision@k/MRR/nDCG/context-waste), golden set ≥100 categorizado + negativos, outbox/CDC (vs reconcile
  ad-hoc actual), trace_id/observabilidad, control plane (doctor/repair/rollback/explain/replay), lifecycle
  manager CLI, disk manager CLI, dedupe L2-L4, contradiction/reflection wiring, supersession bitemporal,
  router policy engine (temperature/response_schema/cache/circuit/privacy), skills routing + eval, MCP audit,
  hook manifest/installer/exactly-once.
- **Acción**: mantener `08` con su banner; este informe (`09`) lo **reemplaza** como prompt operativo.
  Los riesgos de su sección 4 ("SQLite/Qdrant pueden divergir", "recall@8 0.917 con 12 queries puede estar
  sobreajustado", "auto-captura puede envenenar") **siguen vigentes** y están integrados en §7 y §11.

---

## 4. Tabla de problemas por spec

| Spec | Estado runtime | Problemas principales | Formal? | Prio |
|---|---|---|---|---|
| **00-PROMPT-CONTINUACION** | cuerpo correcto, reproducible | HEAD stale (d3a16ff→f936a66); auto-contradicción ("LIMPIO" pero trae HEAD stale); omite read-path vivo de ultron_sessions; "P0 parcial" no detalla qué falta | acc✗ test✗ run✓ rb✗ | P1 |
| **01-MEMORIA** | núcleo verificado | banner 2 commits stale; incoherencia interna eventos (1043 vs ~995); L50 "ruta legacy cortada ✅" solo write; redaction.rs doc-comment dice "uncabled" (stale vs código); no lista index_skills ni memory_health-stores | acc✗ test✓ run✗ rb✗ | P1 |
| **02-AI-ROUTER** | route() real, ~9 callers | **fila quota-guard/is_critical STALE en tabla** (orden explícita STATE-RECON:96 de quitarla); quota_watchdog.rs listado (no existe); omite ZonePolicy/privacy/circuit_breaker por nombre; ai_tasks "no enganchado" impreciso (contradiction.rs:105) | acc✗ test✗ run✗ rb✗ | P1 |
| **03-SKILLS-AGENTES** | diagnóstico CIERTO | contradice (intent-rules.yaml "huérfano" pero "reanimar como fuente única"); ai_router.rs:477 mal clasificado (es Zone config, no juez huérfano); sin namespacing/activation-policy formal con números | acc✗ test✗ run✗ rb✗ | P1 |
| **04-QUOTA** | QUITADO (banner OK) | secciones 2-3 describen en **presente** código borrado (contradicen su propio banner); no enlaza huérfanos DR-07..13; sin criterio de "retiro completo" ni rollback (git revert cbb2d5c) | acc✗ test✗ run✗ rb✗ | P1 |
| **05-HOOKS** | P0 aplicada, sidecar listo | subcomando `candidate` **ya existe** (spec lo presenta como ausente); ruta fail-safe helper mal atribuida; installer real (`install-hooks.ps1`) contradice dirección de SoT propuesta; no define HookManifest/exactly-once; omite read-path ultron_sessions | acc✗ test✗ run✓ rb✗ | P1 |
| **06-ORQUESTADOR** | orchestrate() vivo e2e | sin ancla HEAD/baseline; 10 workflows objetivo vs 7 reales sin mapeo; WorkflowState existe pero orchestrate no lo usa; sin acceptance/tests/result-contract OrchestrationContext; advisory-only (no delega) | acc✗ test✗ run✗ rb✗ | P1 |
| **07-MCPS** | autodeclarado "sin auditar" | **solo ve settings.json** (mitad del inventario); omite `~/.claude.json` donde está **H1 (token hardcodeado)**; no clasifica core/optional/dangerous/duplicate; 3 rutas github solapadas; competing store ecc-memory no formalizado | acc✗ test✗ run✗ rb✗ | P1 |

---

## 5. Mejoras obligatorias por spec (correcciones formales)

**Transversal a los 8**: añadir bloque formal `Aceptación medible + Tests + Runtime-verification + Rollback`
(o enlazar `CONTRACTS` + comandos `ultron-memory stats/eval/reconcile` con outputs esperados). Sustituir SHA
hardcoded por `HEAD = git rev-parse --short HEAD` para no quedar stale al primer commit.

- **00**: HEAD→f936a66; añadir fila "ultron_sessions: WRITE cortado / READ vivo (memory_graph.rs:201)→drain+delete"; corregir cita `service.rs:57`→`68-71`; añadir item numerado ultron_sessions drain (BLOQUEADO); detallar qué queda de "P0 parcial".
- **01**: HEAD→f936a66; unificar conteo eventos a 1043; matizar L50 a "write cortado, read pendiente"; reconciliar doc-comment stale de `redaction.rs:9-12`; listar gaps index_skills + memory_health-stores.
- **02**: **[P0-doc]** eliminar fila quota-guard/is_critical y `quota_watchdog.rs` de la tabla/arquitectura/route() (orden STATE-RECON:96); añadir callers `reflection.rs:272`, marcar ai_tasks PARCIAL; vincular a `CONTRACTS §6` (ZonePolicy); añadir items privacy-routing (bloqueante seguridad) + circuit_breaker.
- **03**: corregir clasificación `ai_router.rs:477` (Zone config); definir namespacing `skill::{plugin}:{name}` + activation-policy con umbrales numéricos; resolver contradicción intent-rules.yaml (fuente única vs borrar); declarar que activar skill NO escribe memoria.
- **04**: reescribir §2-3 en **pasado**/tachado; añadir sección "huérfanos residuales DR-07..13" con estado verificado; criterio de "retiro completo = 0 refs" + rollback `git revert cbb2d5c`; decidir archivar el spec.
- **05**: reescribir §4/5/6.1 (subcomando `candidate` ya existe → solo falta wiring del hook); reconciliar ruta helper + installer real; importar HookManifest de `CONTRACTS §5` + invariante `writer_path PROHIBIDO qdrant/mem0`; especificar exactly-once Stop→candidate; añadir política anti-poisoning (source_trust≤assistant_inferred→quarantine).
- **06**: ancla HEAD+baseline; mapeo 7→10 workflows + schema declarativo (trigger_patterns/allowed_agents/budget); golden-set routing ≥30 + activar e2e `#[ignore]`; result-contract OrchestrationContext; enlazar trace_id (`CONTRACTS §10`).
- **07**: inventario COMPLETO cruzando settings.json + `~/.claude.json` (top+project) + plugin `.mcp.json` (= `mcps.rs::list_mcps_inner`); **separar rotación histórica CERRADA de H1 (hardcode gho_)**; matriz McpPolicy por server (classification/token_scope/version_pin/writes_memory); marcar context7@latest sin pin, ecc-memory competing-store, github ×3 duplicate; test anti-secreto (literal ghp_/gho_/sk-/m0-).

---

## 6. Contratos faltantes o incompletos (vs `CONTRACTS-2026-06-04.md`)

| Contrato | Estado real (código) | Acción |
|---|---|---|
| MemoryItem: content_hash/normalized_text/schema_version | **[EXISTE]** end-to-end (OLA B) — el contrato aún los marca [ANADIR] | marcar [EXISTE]; corregir "sha256"→"FNV-1a 64-bit" (el contrato miente sobre el algoritmo) |
| MemoryItem: valid_from/valid_to | **FALTA** (0 ocurrencias) | OLA B+ aditiva: columnas + backfill `valid_from=created_at` |
| MemoryItem: source_trust/injection_policy/retention_class/provenance | **FALTA** (enum Source existe sin pesos) | `impl Source::trust_weight()`; cablear en gating active vs quarantine |
| Source Trust Model | enum sin jerarquía numérica | tipar 4 clases (1.0/0.8/0.5/0.3) + regla "≤assistant_inferred no→active sin inbox" |
| Write-path security | **secret redaction [EXISTE/cableado]**; PII/injection-scan FALTAN; **sensitivity nunca asignada (H2)** | marcar secret hecho; implementar pii_detect + prompt_injection_scan + escalar sensitivity con classify_sensitivity |
| Dedupe L0-L4 | L0/L1 implícito (content_hash columna+index, **sin lookup**); L2-L4 FALTAN | `find_by_content_hash()` consultado en create_candidate; L2-L4 = OLA E con thresholds calibrados |
| ZonePolicy (router) | Zone sin temperature/response_schema/privacy/cache/circuit_breaker | aditivo: `Zone.temperature/response_schema` + privacy gate + circuit breaker |
| Skill/Agent Manifest | `index_agents()` único; `index_skills()` **NO existe** | implementar index_skills (entity='skill', namespacing) |
| HookManifest / McpPolicy / DeprecationEntry | **0 representación en código** (fase diseño legítima) | priorizar HookManifest (cierra invariante "ningún hook escribe memoria") |
| Observabilidad trace_id | **0 archivos** | decisión transversal; quick-win: trace_id en memory_events |

---

## 7. Threat model (verificado contra código)

**Mitigaciones REALES y cableadas** (mantener, no tocar sin re-correr eval security gate):
- ✅ Redacción de secretos antes de persistir (`service.rs:48-52`, `171-174`) y antes de embeddings (índice desde texto ya redactado, `qdrant_index.rs:43-48`).
- ✅ Recall aplica gates status≠Active / cross-project / vault / sensitivity==Secret (`recall_unified.rs:130-153`, testeado).
- ✅ MemoryService único escritor del SoT; eval security gate secret_leak=0/stale_leak=0.

**Amenazas abiertas** (severidad · autónomo):

| Amenaza | Detalle | Sev | Auto |
|---|---|---|---|
| **sensitivity hueca (H2)** | `classify_sensitivity` sin caller → nada marca Secret → el gate Secret nunca filtra de verdad | P1 | ✅ (código, tras redact escalar sensitivity sobre texto original, never-downgrade) |
| **read-path sin gobernanza (H3)** | `memory_unified_search` lee ultron_sessions+Mem0+KG sin gates de recall_pack | P1 | ✗ (toca lib.rs registrado + drain) |
| **sin forget verificable (H4)** | `delete_item` solo-SQLite, sin caller, no cubre Qdrant/audit/backups | P1 | ✗ (diseño + confirmación de borrado) |
| **auto-captura → Approve (poisoning)** | candidate por defecto `recommended_action=Approve`, sin source_trust ni quarantine | P2 | ✅ (default Quarantine para hooks/tool/MCP) |
| **router sin privacy-routing** | Private/Secret pueden salir a modelos remotos (0 matches privacy en ai_router) | P2 | ✗ (política producto/seguridad) |
| **Mem0Store writable** | adaptador `writable=true` con `add()` a Mem0 remoto, aunque hook cortado | P2 | ✗ (degradar a read-only / eliminar; config) |
| **token gho_ hardcodeado (H1)** | plaintext en `~/.claude.json` github-pat | P1 | ✗ (config viva + secreto) |
| **prompt-injection persistido** | sin scanner para fuentes externas/MCP que luego se inyectan | P2 | ✅ (scanner en write-path para source_trust≤external) |

---

## 8. Workflow plan W0-W12 (estado)

| WF | Objetivo | Estado | Output |
|---|---|---|---|
| **W0** Reconciliación | verdad runtime vs docs | ✅ HECHO | §2, STATE-RECONCILIATION |
| **W1** Audit specs | 8 specs contract-check | ✅ HECHO (workflow `w2kfy46sd`) | §4-5 |
| **W2** Contratos | completitud vs código | ✅ HECHO | §6 |
| **W3** Seguridad | threat model | ✅ HECHO | §7 |
| **W4** Consistencia SQLite/Qdrant | outbox/CDC, reconcile --repair, backup/restore | 🔄 workflow `wvicemkxj` (diseño) | §11 backlog |
| **W5** Evals/golden-set | ≥100 queries categorizadas + negativos | 🔄 `wvicemkxj` | §11 |
| **W6** Retrieval/dedupe/contradiction | reranker/MMR/temporal | ⚪ readiness mapeado (W1); diseño pendiente | §11 |
| **W7** AI Router policy engine | ZonePolicy/cache/circuit/privacy | ⚪ contrato §6 listo; impl pendiente | §11 |
| **W8** Skills/orquestador | index_skills/reranker/activation | ⚪ readiness mapeado; diseño pendiente | §11 |
| **W9** Hooks | HookManifest/installer/exactly-once | 🔄 `wvicemkxj` | §11 |
| **W10** MCP audit | inventario runtime/allowlist/token | 🔄 `wvicemkxj` (H1 ya detectado) | §11 |
| **W11** Lifecycle/disco | maintenance scan/plan/apply CLI | 🔄 `wvicemkxj` | §11 |
| **W12** Control plane | doctor/repair/rollback/trace replay | 🔄 `wvicemkxj` | §11 |

> Regla: workflows read-only/diseño corren en paralelo. Wiring final, hooks vivos, settings globales, token
> rotation, mutación Qdrant y deletes **requieren confirmación**.

---

## 9. Matriz de agentes/skills recomendados

| Necesidad | Agente/skill | Output |
|---|---|---|
| Arquitectura de sistema | `senior-engineer` / `architect-reviewer` | tradeoffs + plan |
| Bugs/runtime/causa raíz | `debugger` | reproducción + fix |
| Seguridad/leaks/permisos | `code-reviewer` / `security-auditor` | findings priorizados |
| Legacy/poda sin romper | `refactoring-specialist` | plan de separación (memory_health/recall_hybrid) |
| Tipos/manifests/UI | `typescript-pro` | contratos TS, UI↔backend |
| Datasets/evals (UV) | `python-pro` | golden-set + harness |
| Git/commits seguros | `git-workflow-manager` | commit plan por ola |
| Windows/hooks/disco/paths | `powershell-5.1-expert` | dry-runs seguros |
| Docs/diagramas formales | `markdown-mermaid-writing` | specs consistentes |
| Evaluación estricta repo | `repo-evaluator` (Kirkardo) | gaps severos |

> No activar por decoración. Para olas independientes: paralelizar (p.ej. W4+W5+W9+W10 a la vez).

---

## 10. Plan por olas (orden de integración)

| Ola | Workflows | Gate de cierre | Estado |
|---|---|---|---|
| OLA 0 | W0, W1 | verdad + docs stale, sin cambios funcionales | ✅ |
| OLA A | W1, W2, W3 | specs formales + contratos + threat model | 🟡 (este informe cierra el análisis; falta editar specs) |
| OLA B | W3, W4 | redaction tests + reconcile; **+H2 sensitivity, +H4 forget** | 🟡 (B1/B3 hechos; falta outbox/forget/sensitivity) |
| OLA C | W5 | golden set ≥100 + baseline + negativos | 🟡 (gate básico hecho; falta ≥100) |
| OLA D | W6 | precision/context-waste sin leaks; reranker | ⚪ |
| OLA E | W6 | dedupe L2-L4 + contradiction + bitemporal | ⚪ |
| OLA F | W7 | ZonePolicy schema/cache/circuit/privacy | ⚪ |
| OLA G | W8 | routing eval precision@1/3 + index_skills | ⚪ |
| OLA I | W9 | Stop→candidate exactly-once + SoT única + no legacy writes | ⚪ (P0 parcial hecho) |
| OLA J | W10 | allowlist + token scope + **H1 resuelto** | ⚪ |
| OLA K/L | W11 | maintenance scan/plan/apply dry-run + rollback | ⚪ |
| OLA M | W12 | doctor/repair/explain/replay + trace_id | ⚪ |

---

## 11. Backlog priorizado P0/P1/P2/P3

### P0 — seguridad / data-loss / fuera del SoT (bloqueante)
- **P0-1** [AUTO] Escalar `sensitivity` en write-path (H2): tras `redact_in_place`, llamar `classify_sensitivity` sobre texto original, never-downgrade. Cierra el gate Secret. *(código+rebuild+eval)*
- **P0-2** [doc-AUTO] Quitar fila quota-guard/`is_critical`/`quota_watchdog.rs` de `02-AI-ROUTER` (orden STATE-RECON:96).
- **P0-3** [BLOQUEADO] H1: mover token `gho_` de `~/.claude.json` a `${GITHUB_TOKEN}` env-ref. *(config viva + secreto)*
- **P0-4** [BLOQUEADO] H3: cortar lectura de stores competidores en `memory_unified_search` (ultron_sessions/Mem0/KG sin gates). *(toca lib.rs registrado)*

### P1 — reconciliación / docs / hooks / consistencia
- **P1-1** [AUTO] Reconciliar los specs 00-07 (banners HEAD dinámico, correcciones §5, formalizar acceptance/tests/rollback).
- **P1-2** [AUTO] `find_by_content_hash()` consultado en create_candidate (L0 dedupe real).
- **P1-3** [AUTO] valid_from/valid_to aditivos (base bitemporal/supersession).
- **P1-4** [AUTO] HookManifest spec + invariante writer_path (CONTRACTS §5 → 05-HOOKS).
- **P1-5** [BLOQUEADO] H4: `MemoryService::forget(id)` cubriendo SQLite+Qdrant+audit. *(diseño + confirmación borrado)*
- **P1-6** [BLOQUEADO] H5: drain+migrar 72 pts ultron_sessions a candidates + DELETE colección + cortar read. *(destructivo)*
- **P1-7** [BLOQUEADO] Repoint hooks SoT a `~/.ultron/hooks` + dedup routers. *(settings.json global)*

### P2 — motor / policy / poda
- **P2-1** [AUTO] index_skills() + namespacing (skills compiten en routing).
- **P2-2** [AUTO] ZonePolicy: `temperature`+`response_schema` aditivos + validador JSON.
- **P2-3** [AUTO] Golden set ≥100 categorizado + negativos (secret/stale/cross-project/dup/temporal) + precision@k/MRR/nDCG/context-waste + `eval_runs` persistido.
- **P2-4** [AUTO/BLOQUEADO] Cablear contradiction::check en create_candidate (Quarantine, never auto-approve) — *requiere API keys para judge*.
- **P2-5** [AUTO] Auto-captura default Quarantine + source_trust.
- **P2-6** [AUTO] Limpiar residuos Quota UI (QuotaDot/Sidebar, ProxyControl listeners, comentarios) + descriptor hooks_admin.rs:1641.
- **P2-7** [BLOQUEADO] Degradar Mem0Store a read-only; aislar ecc-memory MCP.
- **P2-8** [BLOQUEADO] privacy-routing en AI Router (Private/Secret → local).

### P3 — avanzado / cosmético
- Reranker cross-encoder (bge-reranker-v2-m3 ONNX) tras RRF; MMR/diversidad; temporal retrieval; reflection grounded; trace_id end-to-end; multi-IA dispatch; control plane CLI; disk/lifecycle CLI; BM25/FTS5 release (vs LIKE term-OR); archivar spec 04-QUOTA.

---

## 12. Tareas autónomas seguras para HOY (reversibles por git, sin tocar config viva)

1. **Reconciliar los 8 specs 00-07** (banners HEAD dinámico, correcciones §5, bloque acceptance/tests/rollback). — edición .md
2. **P0-2**: quitar plomería Quota stale de `02-AI-ROUTER` (tabla/arquitectura/route()). — edición .md
3. **Marcar [EXISTE]** los 3 campos OLA B en `CONTRACTS` + corregir "sha256"→"FNV-1a". — edición .md
4. **P0-1 (H2)**: escalar sensitivity en write-path. — código+rebuild+eval vs 0.917
5. **P1-2**: `find_by_content_hash()` L0 dedupe. — código+rebuild+test
6. **P1-3**: valid_from/valid_to aditivos + backfill. — código+rebuild+reconcile
7. **Spec golden-set ≥100** (estructura dataset, formato JSON, generación desde brain.db sin filtrar secretos). — doc + tooling UV
8. **HookManifest spec + MCP Policy spec + Deprecation/Disk specs** formalizados. — edición .md
9. **Limpiar residuos Quota UI/Rust** (DR-09..13) — código+rebuild+tsc (reversible)

## 13. Bloqueos humanos (requieren confirmación de USER)

| # | Acción | Razón |
|---|---|---|
| B1 | **H1**: mover token `gho_` de `~/.claude.json` a env-ref | config viva + secreto |
| B2 | Consolidar 3 MCP github (settings `github` deshabilitado / `github-pat` vivo / ecc `github`); destino de gemini/railway (ruido) | config viva |
| B3 | Destino MCP `ecc memory` (competing store): desactivar vs writes_memory=bloqueado | config viva/plugin |
| B4 | **H5**: drain+migrar+DELETE colección `ultron_sessions` + cortar read | destructivo + posible pérdida |
| B5 | Repoint hooks SoT a `~/.ultron/hooks` + reapuntar settings.json + dedup routers | config global |
| B6 | Wiring Stop→candidate en hook VIVO (`~/.claude/scripts`) | config viva (la copia versionada SÍ es autónoma) |
| B7 | Mem0 definitivamente fuera vs L3 opt-in (Mem0Store writable, `~/.mem0/config.json` en disco) | decisión de producto |
| B8 | Contradiction/ai_tasks wiring: habilitar AI Router con API keys para e2e | secreto/config |
| B9 | `reconcile --repair --apply` (muta Qdrant) | destructivo (hoy in_sync, no urge) |
| B10 | Borrados de disco (~40GB: target/ + .fastembed_cache ×6 + backup 899MB) | destructivo (dry-run+confirmación) |
| B11 | privacy-routing: qué zonas son local_only y qué cuenta como secreto/PII | seguridad/producto |
| B12 | Re-implementar quota-aware routing (proxy Claude-first) vs descartar definitivamente | regla dura: no sin señal real |

---

## 14. Definition of Done global (cuantitativa)

**Documentación**: specs sin contradicciones con runtime; `08` histórico; estado actual ≠ diseño objetivo;
cada spec con acceptance+tests+runtime-verification+rollback. — *Hoy: 0/8 formales.*

**Seguridad**: no se persisten secretos/PII sin redacción (✅ secret, ✗ PII); embeddings solo sobre texto
redactado (✅); **sensitivity asignada** (✗ H2); private/secret no sale a remoto no autorizado (✗ privacy);
prompt-injection persistido se detecta/quarantina (✗); **borrado verificable** SQLite+Qdrant+logs+backups+traces (✗ H4).

**Consistencia**: SQLite=SoT (✅); Qdrant reconcilia (✅ --check; ✗ --repair); drift reparable (✗); mutaciones con dry-run (✗).

**Calidad**: golden set ≥100 (✗, hoy ~12); recall@k+precision@k+MRR+nDCG+context-waste (✗, hoy solo recall@8);
0 secret/stale/cross-project leaks (✅ en el set actual); utilidad por token (✗).

**Orquestación**: catálogo multi-entidad (✗ solo agentes); manifests normalizados (✗); routing eval precision@1/3
(✗); workflows declarativos (✗, 7 builtin); state machine persistente (🟡 existe, no usada); multi-IA governado (✗).

**Runtime**: hooks versionados+testeados (✗ SoT fragmentada); Stop→candidate (🟡 subcomando listo, hook no lo
invoca); no stores competidores escribiendo (🟡 hooks cortados, Mem0Store writable); MCPs auditados allowlist+scope (✗, H1 abierto).

**Operabilidad**: doctor/repair/rollback/explain/replay (✗); maintenance dry-run+rollback (✗).

> **No declarar "100%"** hasta que todas estas gates estén ✅ con evidencia. **Estado actual: núcleo (memoria
> segura+consistente+medible básica) ✅; gobernanza/motor/control-plane mayormente ✗.**

---

## 15. Primer checkpoint ejecutable

**Orden de ataque para HOY (autónomo, cada item = commit verificado):**

1. **Edición docs (sin riesgo)**: reconciliar specs 00-07 + P0-2 (quitar Quota stale de 02) + marcar [EXISTE] OLA B en CONTRACTS. → `git diff` limpio, sin rebuild.
2. **Código P0-1 (H2 sensitivity)**: cablear `classify_sensitivity` en create_candidate/add_imported. → `cargo test --lib memory` + `ultron-memory eval` (recall@8 ≥ 0.917, leaks=0) + rebuild release + copiar a `bin/`.
3. **Código P1-2 (L0 dedupe)** + **P1-3 (valid_from/valid_to)**: aditivos. → tests + `reconcile --check` in_sync.
4. **Specs nuevos**: golden-set ≥100 + HookManifest + MCP Policy + Deprecation/Disk como documentos formales.

**Verificación base** (tras cada cambio de memoria):
```
cargo test --manifest-path control-center/src-tauri/Cargo.toml --no-default-features --lib memory
cargo build --release --bin ultron-memory --features qdrant --manifest-path control-center/src-tauri/Cargo.toml
ultron-memory eval        # recall@8 >= 0.917 ; secret_leak=0 ; stale_leak=0
ultron-memory reconcile --check   # in_sync=true 943=943
ultron-memory stats
curl http://127.0.0.1:6333/collections/ultron_memory
```

**Rollback**: cada ola es un commit aislado (`git revert <sha>`); antes de migración/escritura masiva,
snapshot `brain.db`; binario previo en `bin/ultron-memory.exe.bak-*`.

**Bloqueos**: nada que toque `~/.claude/settings.json`, `~/.claude.json`, hooks vivos, colecciones Qdrant,
tokens, caches/backups o Mem0 se ejecuta sin confirmación explícita (§13).

---

---

## Apéndice A — Diseño implementable por stream (workflow `wvicemkxj`)

Cada stream verificado contra código (HEAD `f936a66`). Deliverables marcan `[esfuerzo|AUTO/BLOCKED]`.

### A.1 W4 — Consistencia SQLite↔Qdrant (P0)
**Hallazgo P0**: ninguna escritura que crea/edita/restaura activos indexa en Qdrant (`approve_candidate`,
`add_imported`, `edit`, `set_status(Active|Restored)`, `supersede`, `relabel` → `insert_item` SIN `index_item`);
el único propagador en caliente es `inbox.rs:172-183 retire()`. El `in_sync=true` de hoy es artefacto del
reindex post-ETL y **derivará al aprobar el primer candidate**. Mitigado parcialmente: `assemble_pack`
re-verifica `status==Active` en SQLite por hit → el riesgo es **falso-negativo** (memoria activa ausente del
denso), no inyección de contenido retirado. `qdrant_point_id` existe en schema pero nunca se rellena.
- **[S|AUTO] P0 mínimo** (cierra ~90% del riesgo): `index_item` best-effort en los 6 write-paths + `remove_item` al pasar a no-activo. `service.rs`.
- **[M|AUTO] Outbox CDC**: tabla `memory_index_outbox(canonical_id, op, content_hash idempotency-key, attempts, …)`; encolado transaccional en `insert_item`; `drain_outbox()` idempotente. `sqlite_store.rs` + nuevo `outbox.rs`.
- **[S|AUTO] content_hash+qdrant_point_id en payload Qdrant** (detección stale/payload-drift sin re-embeber). `qdrant_index.rs:22-43`.
- **[M|BLOCKED] `reconcile --repair`** `Mode{Check,Repair{dry_run}}` + clases stale/dimension/payload-drift; dry-run default, `--apply` explícito.
- **[M|BLOCKED] Backup verificado**: `wal_checkpoint(TRUNCATE)`+SHA-256+`integrity_check`; `restore_brain_db` con validación. `migrations.rs:302` + nuevo `backup.rs`.

### A.2 W5 — Golden set + evals serias (P1)
Hoy: `default_goldens()` = **12 queries hardcoded en Rust**, categoría string libre, 0 negativos. Target:
- **[M|AUTO] golden_set.json externo** ≥100 positivos categorizados (factual/decision/task/constraint/persona/temporal) + `negative_fixtures.json` (secret_leak/stale/cross_project/duplicate/temporal). `cockpit/memory-rework/evals/`.
- **[M|AUTO] `gen_golden.py` (UV)**: muestreo estratificado read-only desde brain.db, expect_ids reales.
- **[M|AUTO] `eval_metrics.rs` puro**: precision@k/recall@k/MRR/nDCG@k/context_waste_ratio (unit-testable sin Qdrant).
- **[M|AUTO] tabla `eval_runs`** (git_sha/config/model_version) + `eval-compare` con exit≠0 en regresión + `build.rs` GIT_SHA.
- **Blocker**: brain.db tiene 0 Secret/0 no-Active → los negativos deben sembrarse sintéticos en DB in-memory.

### A.3 W9 — Hooks robustos (P0/P1)
SoT fragmentada en 2 raíces vivas. Target SoT única `~/.ultron/hooks`:
- **[M|AUTO] `hooks/manifest.json`**: 10 hooks (event/command/timeout/checksum-sha256/failure_policy/writes_memory/writer_path).
- **[M|AUTO] `lib/hook-runner.js`**: wrapper común con circuit-breaker (`breaker-state.json`) + logging.
- **[M|AUTO] Stop→candidate exactly-once**: `emitCandidates()` invoca `ultron-memory candidate` por fact (dedupe por content_hash). `stop-compress-session.js` versionado.
- **[M|AUTO] test harness** con fixtures SessionStart/UserPromptSubmit/Stop.
- **[L|BLOCKED] `install-hooks.ps1` v2** atómico (backup+swap settings.json) + **repoint SoT** (config viva).

### A.4 W10 — MCP audit (P0)
Inventario runtime: **3 fuentes** (settings.json 4 + `~/.claude.json` 3 + plugin ECC 6). **H1 confirmado**:
token `gho_` literal en `~/.claude.json` github-pat. Competing store `ecc memory` (6 tools de escritura).
- **[M|AUTO] `config/mcp-policy.yaml`** (classification/canonical/duplicate_of/tool_allowlist/token_scope/writes_memory).
- **[M|AUTO] `mcp_secret_scan.py`**: detecta literales `gho_/ghp_/sk-/m0-/AKIA` no-`${VAR}` (exit≠0). + extender `mcp_health_check.py`/`mcps.rs`/`MCPs.tsx` (chip "COMPETING STORE").
- **[S|BLOCKED] `settings.json permissions.deny`** += 6 tools `mcp__plugin_ecc_memory__*` (bloquea el competing write).
- **[S|BLOCKED] H1**: rotar/mover `gho_` literal → `${GITHUB_TOKEN}`.

### A.5 W11 — Lifecycle + Disk manager (P1)
No existe CLI maintenance/deprecation/disk. Target módulo `memory/maintenance/` (registry persistente en
brain.db, no markdown):
- **[M|AUTO] registry** `deprecation_entries`+`deprecation_events` (sembrado desde los 42 del registry .md).
- **[M|AUTO] scanners read-only**: rust_dead_exports, sqlite_tablas_sin_lector, qdrant_collections_legacy, hooks_fuera_de_sot, ui_tabs_sin_backend (envuelve `deadwood_scanner.py`).
- **[L|AUTO] disk manager**: WalkDir + categorización + dedupe `.fastembed_cache` por hash; niveles 1/2/3.
- **[S|AUTO] `FASTEMBED_CACHE_PATH` canónico** (`.with_cache_dir()` en ambos InitOptions) → evita las 6 copias futuras.
- **[S|AUTO] CLI** `maintenance scan|plan|apply|restore|explain` + `disk scan|plan|apply` (dry-run-first).
- **Todos los `apply` = BLOCKED** (confirmación humana); DR-01/02/03 nunca sin `--allow-high-risk`.

### A.6 W12 — Control plane + observabilidad (P1)
Subcomandos hoy: resume/orchestrate/recall/stats/reindex/eval/reconcile/candidate. trace_id **inexistente**.
- **[L|AUTO] `ultron-memory doctor [--json]`**: módulo `memory/control/doctor.rs`, ≥9 checks (sqlite/qdrant-per-collection/reconcile/evals/hooks/sidecars/mcps/router-keys/versions) reusando `Severity` de `diagnostics_native.rs`.
- **[S|AUTO] `policy explain --prompt X`** (wrapper read-only de orchestrate+build_trace).
- **[M|BLOCKED] trace_id**: migración aditiva schema 2→3 (`memory_events.trace_id` + tabla `trace_events`) + propagación hook→orchestrator→recall→router→memory_event + `trace replay`.
- **[L/M|BLOCKED] `repair`/`rollback`** (dry-run + snapshot via VACUUM INTO + manifest) + Dashboard Health.

### A.7 UI↔backend alignment (P1)
`invoke_handler` registra **323 comandos**; frontend 166 invokes únicos. **2 invokes rotos** (`quota_get_status`).
- **[S|AUTO] FIX P0**: eliminar `QuotaDot`/`useQuotaDot` de `Sidebar.tsx:218-290` + listeners `quota:*` + comentario zombie `lib.rs:644-646`.
- **[M|AUTO] manifest UI↔backend**: clasificar 323 comandos en {live, backend-only-intencional, conservar-futura-UI, podable} con evidencia. `specs/UI-BACKEND-ALIGNMENT-MAP.md`.
- **[M|BLOCKED] poda** workday_*/kg_*/decisions_*/mem0_* (recomendación: PODAR; conservar MEMORY KERNEL).
- **[L|BLOCKED] cablear UI mínima** Memory Inbox + Retrieval Inspector (la vía "hacia UI" que justifica conservar el kernel).
- **[M|BLOCKED] cortar read `ultron_sessions`** (`memory_graph.rs:201`) antes de podar el comando + DELETE colección.

---

## Apéndice B — Validación cruzada externa (Codex + Gemini)

Por petición explícita (anti-alucinación + puntos de conexión), los 12 claims falsables de código se
enviaron a **Codex 0.134.0** y **Gemini 0.44.0** para verificación independiente (solo-lectura, sin material
secreto enviado a modelos remotos; H1 se verificó localmente).

### B.1 Gemini 3.1-pro (veredicto completo)
**12/12 claims VERIFIED. 0 alucinaciones detectadas** ("Todos los claims existen estructural y exactamente
donde se mencionan… la inteligencia del validador anterior fue sumamente precisa en el estado actual del HEAD
`f936a66`"). Evidencia independiente adicional aportada:
- **C7**: confirmó FNV-1a en `texthash.rs:31` (`FNV_OFFSET`/`FNV_PRIME`); `qdrant_point_id` se inserta NULL en el write-path (`sqlite_store.rs:384`).
- **C4**: `delete_item` solo usado en tests (`sqlite_store.rs:884,1125`), confirmando 0 callers de producción.
- **C8**: localizó el hardcode en `orchestrator.rs:141` (`search_catalog(prompt, Some("agent"), 5)`).
- **C2**: sensitivity nunca escala → todos los items caen a default Internal.

**Punto de conexión crítico (independiente)**: *cadena de privacidad rota de extremo a extremo* — C2
(sensitivity nunca→Secret) + C10 (Zone sin flag privacy) ⇒ un secreto guardado en claro en una sesión previa
podría **evadir los gates e ir expuesto en un prompt futuro hacia un proveedor Cloud** (resúmenes/diálogo guiado
por IA). Esto **refuerza P0-1 (H2) + P2-8 (privacy-routing)** como cadena única, no dos items aislados.

Otros connection-points confirmados: (1) cortar read `ultron_sessions` sin migrar rompe la vista UI que consume
`memory_unified_search`; (2) index_skills requiere `search_catalog` agnóstico de entity; (3) sin content_hash en
payload Qdrant, `reconcile` futuro hace inner-join de string en vez de comparar hashes.

> Nota operativa: Gemini sufrió 429 transitorios (capacidad `gemini-3.1-pro-preview`); reintentó con backoff y completó (exit 0).

### B.2 Codex 0.134 (gpt-5.x) — verdicto completo (más severo)
Codex verificó leyendo solo `.rs/.js` permitidos (249k tokens). Resultado: **9 VERIFIED, 2 MOSTLY/PARTIAL,
1 REFUTED/IMPRECISE** — y, valiosamente, **detectó 4 imprecisiones de caracterización en el informe** (ningún
hallazgo P0/P1 cae; son refinamientos):

- **C1-C6, C10 VERIFIED** (con file:line propios, p.ej. C6 `service.rs:135,233,270,344,366,374` solo `insert_item`).
- **C7 MOSTLY VERIFIED** — matiz: `qdrant_point_id` no se *genera* (constructor `None`, `model.rs:292`) pero `insert_item` *sí lo persiste si un caller lo trae* (`sqlite_store.rs:365`) → "nunca se rellena" es demasiado absoluto.
- **C8 MOSTLY VERIFIED** — confirmado; no pudo hacer grep global de `index_skills` por bloqueo de shell (verificado por mí y Gemini: 0 matches).
- **C9 REFUTED/IMPRECISE** — **corrección importante**: `contradiction.rs` y `reflection.rs` **NO son scaffold vacío**: tienen lógica real (`contradiction.rs:69-110` llama `ai_tasks::judge_contradiction`; `reflection.rs:75-170` tiene `reflect`/`insights_to_candidates`/ruta AI). Lo correcto: **implementados pero SIN cablear al write-path de producción** (TODO `service.rs:67-71`).
- **C11 PARTIAL/OUT-OF-SCOPE** — backend confirmado (quota fuera, sin guard); la parte UI `.tsx` (QuotaDot) no la leyó por la regla de alcance (verificada por mí: `Sidebar.tsx`).
- **C12 VERIFIED CON MATIZ** — **corrección factual**: el intent classifier **NO usa regex**; usa `p.contains(pat)` (substring), `orchestrator.rs:110-115`.

**Imprecisiones que Codex corrigió en el informe (aplicadas)**:
1. `memory_graph.rs` está en `commands/memory/`, no en `memory/`.
2. "regex" → **substring rules** (`p.contains`) en el orquestador.
3. "contradiction/reflection scaffolded" → **lógica real, sin wiring de producción**.
4. "qdrant_point_id nunca se rellena" → **no se genera, pero el store acepta persistirlo**.

### B.3 Conclusión consolidada de la validación cruzada
| Claim | Gemini | Codex | Veredicto consolidado |
|---|---|---|---|
| C1 redaction cableada | ✓ | ✓ | **CONFIRMADO** |
| C2 sensitivity nunca asignada (gate Secret hueco) | ✓ | ✓ | **CONFIRMADO (P0-1/H2)** |
| C3 unified_search lee sin gates | ✓ | ✓ | **CONFIRMADO (H3)** |
| C4 sin forget verificable | ✓ | ✓ | **CONFIRMADO (H4)** |
| C5 stop-compress upsert retirado | ✓ | ✓ | **CONFIRMADO** |
| C6 write-paths no indexan a Qdrant | ✓ | ✓ | **CONFIRMADO (P0/W4)** |
| C7 content_hash FNV-1a / qdrant_point_id | ✓ | ✓ matiz | CONFIRMADO; `qdrant_point_id` "no se genera" (no "nunca se rellena") |
| C8 index_skills inexistente | ✓ | ✓ | **CONFIRMADO** |
| C9 contradiction/reflection huérfanos | ✓ | ◑ refina | **lógica real, sin wiring** (no "scaffold vacío") |
| C10 Zone sin policy fields | ✓ | ✓ | **CONFIRMADO** |
| C11 quota fuera + residuos UI | ✓ | ◑ backend | backend CONFIRMADO; UI verificada localmente |
| C12 orchestrate advisory-only | ✓ | ✓ matiz | CONFIRMADO; intent = **substring, no regex** |

**Resultado**: **0 hallazgos P0/P1 refutados** por dos validadores externos independientes. La cadena de
seguridad (C2↔recall↔router) la marcaron **ambos** como rota de extremo a extremo. Las únicas correcciones son
de precisión de caracterización (regex→substring; scaffolded→sin-wiring; path memory_graph). **Riesgo de
alucinación en §1-§7: bajo, con doble verificación file:line.**

---

## Apéndice C — Implementación autónoma + revisión adversarial (sesión 2026-06-04)

Tras el análisis, se implementaron las tareas autónomas seguras (commits sobre `f936a66`):

| Commit | Cambio | Verificación runtime |
|---|---|---|
| `cda7a99` | **H2** sensitivity write-path (gate Secret deja de estar hueco) | 138 tests · recall 0.9166 · leaks=0 |
| `79a962c` | **W4** index_item en 6 write-paths (Qdrant deja de derivar al aprobar) | in_sync 943=943 |
| `54d9b4f` | **L0** dedupe exacto por content_hash | +2 tests |
| `4b29882` | **review-fix** (ver abajo) | 140 tests · 0.9166 · in_sync |
| `47c01da`/`09d9cd6` | docs/specs + artefactos (mcp-policy, hook-manifest, golden-set 942, UI-map, specs maintenance/control) | json/yaml/py/node OK |

**Revisión adversarial independiente** (workflow `wwn90ij2y`, 3 especialistas read-only sobre H2/W4/L0):
- **code-reviewer**: `clean` (13 observaciones, 0 bugs — precedencia Quarantine>Merge correcta, L0 parity verificada, W4 best-effort correcto).
- **security-auditor**: `issues_found` — **2 P1 reales** que la sesión introdujo, **ya cerrados en `4b29882`**:
  1. **L0 cross-project**: `content_hash` no incluía scope/project → merge entre proyectos distintos. Fix: filtro `(scope, project_id IS ?)` + test.
  2. **Redaction incompleta**: `edit`/`supersede` no redactaban y W4 ahora los indexa → secreto vía edit llegaría al embedding. + tags no redactados. Fix: redaction+sensitivity en edit/supersede + `redact_tags`.
- **artifact-reviewer**: `issues_found` — golden_set trivial (query==summary ~97.7%, no mide recall semántico) [P1 validez métrica, no integridad]; manifest SoT note (8/10 hooks corren desde `~/.claude/scripts`).

**Follow-ups diferidos** (P2/P3, no bloqueantes, registrados en kanban):
- P2: W4 indexa items `Secret` sin marcador filtrable en payload Qdrant (mitigado por gate de recall; fuga solo vía `memory_unified_search`=H3). Fix: añadir `sensitivity` al payload + filtro `must_not`.
- P2: L0 Merge no propaga `project_id` (to_item lo descarta) — añadir `proposed_project_id` a MemoryCandidate.
- P2: `risk_level` → enum `RiskLevel` (hardening; mitigado con const `SECRET_RISK_MARKER`).
- P1-validez: regenerar golden_set con paráfrasis real (queries que no compartan tokens literales con el summary).
- P2: hook manifest — distinguir `live_path` (`~/.claude/scripts`) vs `versioned_path` o migrar SoT.

**Lección**: la verificación adversarial independiente sobre el escritor único cazó 2 bugs P1 reales que ni
el autor ni los tests unitarios detectaron — confirma el patrón "cierre con auditorías independientes".
