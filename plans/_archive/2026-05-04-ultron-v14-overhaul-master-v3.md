# ULTRON v14.0 "Index-First" — Master Plan v3

> **Cambios desde v2 (2026-05-04):** Sesión de feedback reveló 5 problemas no resueltos por el plan anterior. Esta versión añade ZTMSI como fundación arquitectónica, redefine S2, añade un tercer modelo validador, MCP resilience, y afinamiento de los criterios de éxito. S0 y S1 no cambian.

---

## Problema raíz (diagnóstico honesto)

El plan v2 atacaba síntomas. Esta sesión reveló la causa real:

**ULTRON hace trabajo de script en tiempo de AI.** Cada vez que Claude necesita saber "¿qué memoria es relevante?" o "¿qué skill debo usar?", gasta tokens haciéndolo en tiempo de inferencia. La solución no es un dispatcher más inteligente — es mover esa lógica **fuera del tiempo de AI completamente**.

Cinco problemas confirmados:

| # | Problema | Causa raíz | Fix propuesto |
|---|----------|------------|---------------|
| 1 | Token waste masivo | Memory routing hecho en inferencia, no en scripts | ZTMSI: índice pre-computado por scripts |
| 2 | Vault no sirve en la práctica | Sin índice de keywords, Claude no puede navegar 616 notas eficientemente | ZTMSI indexa vault + L1 + L2 |
| 3 | Memoria dispersa, no sincronizada | Múltiples zonas sin fuente de verdad ni sync protocol | Keyword tagging + script-only sync |
| 4 | Skills no se auto-activan | Dispatcher hardcoded, no lee estado real del sistema | Dispatcher lee ZTMSI en <50ms |
| 5 | Escalabilidad imposible | Añadir skill/memoria = modificar CLAUDE.md + settings.json + SKILL.md manualmente | Skills self-register via frontmatter |

---

## Criterios de Éxito (v3 — medibles)

| Criterio | Target | Cómo medirlo |
|---|---|---|
| **Token overhead vs vanilla** | ≤5% overhead total (L0 always-on) | `telemetry.py` baseline v13.3.0 vs v14.0.0 |
| **Razonamiento vs vanilla** | Subjetivo: USER confirma mejor routing en ≥8/10 sesiones | Evaluación manual durante 2 semanas post-release |
| **Escala de memoria** | Query sobre 600+ archivos en <100ms | `uv run python brain_index.py benchmark` |
| **MCP resilience** | 100% graceful fallback cuando un MCP falla | `ultron doctor --health-check` reporta 0 hard failures |
| **Multi-model saturation** | Codex + Gemini Pro + Gemini Flash en toda decisión crítica | Dispatch telemetry: 0 critical sprints sin peer review |

---

## Arquitectura v3 — Tres Fundaciones

Antes de los sprints, los tres principios que los gobiernan:

---

### Fundación 1 — ZTMSI (Zero-Token Memory & Skills Index)

**Concepto:** Índice invertido pre-computado en SQLite FTS5. Scripts lo construyen y mantienen. Claude **nunca** gasta tokens en "¿qué archivo debo leer?". En cambio, un script resuelve esa pregunta en <50ms antes de que Claude vea el prompt.

```
~/.ultron/index/
  ztmsi.fts.db          ← SQLite FTS5 principal (keywords → file paths + chunks)
  manifest.cache.json   ← pre-computed skill routing table (rebuilt from skills.manifest.yaml)
  memory.registry.json  ← metadata de todos los archivos indexados (path, type, last_indexed, token_est)
  .last_rebuild         ← timestamp para staleness check
```

**Cycle de vida:**
1. Cualquier archivo en `~/.ultron/memory/`, `~/.ultron-vault/`, `~/.claude/skills/` cambia → `ultron index rebuild --incremental` (triggered por hook o manualmente)
2. Rebuild incremental: solo re-indexa archivos con mtime > `.last_rebuild` → tipicamente <2s
3. Rebuild completo: `ultron index rebuild --full` → ~15-30s para 600 archivos
4. SessionStart hook verifica si index es stale (>4h o mtime vault > index) → si stale, rebuild incremental silencioso

**Query:**
```bash
ultron index query "unreal engine blueprints"
# → [{"path": "~/.ultron-vault/ue5/blueprints.md", "score": 0.94, "preview": "..."},
#     {"path": "~/.ultron/memory/L1/ue5-state.md", "score": 0.81, "preview": "..."}]
```

**Indexación a nivel párrafo:** No solo archivos completos. Cada párrafo de ≥50 palabras se indexa como chunk separado con back-ref al archivo. Esto permite retornar solo el párrafo relevante, no el archivo entero — reducción radical de tokens al cargar contexto.

**Zero-token guarantee:** `ultron index query` es pure Python sobre SQLite. 0 llamadas a AI, 0 tokens.

---

### Fundación 2 — Keyword Tagging Protocol (KTP)

Todo archivo en el ecosistema ULTRON lleva frontmatter YAML machine-readable:

```yaml
---
tags: [ue5, blueprints, c++, game-dev]          # keywords para ZTMSI
topics: [rendering, physics, networking]         # dominio semántico
priority: high                                   # pinned | high | medium | low | deprecated
type: knowledge                                  # memory | skill | knowledge | project | decision
layer: L1                                        # L0 | L1 | L2 | vault
last_updated: 2026-05-04
token_est: 340                                   # estimado de tokens si se carga completo
---
```

**Reglas:**
- Archivos sin frontmatter válido → `ultron doctor` los reporta como "untagged" → propone auto-tag basado en contenido
- Scripts añaden tags automáticamente cuando crean archivos nuevos (via `ztmsi_tag.py`)
- El `token_est` es calculado por el script de indexación, no escrito manualmente
- `deprecated: true` en frontmatter → excluido del índice activo, pero archivado para historial

**Auto-tag script:** `ultron index auto-tag <file>` — usa keywords del contenido para generar frontmatter inicial. El usuario confirma o edita. **No gasta tokens de sesión**: es un script separado invocado en CLI.

---

### Fundación 3 — Multi-Model File Protocol (MMFP)

**Problema actual:** Codex/Gemini se invocan inline (bloqueante, desaparece al cerrar sesión). La propuesta del usuario — "conversaciones continuas de archivos" — resuelve esto.

**Estructura:**
```
~/.ultron/multimodel/
  requests/
    req-<session>-<seq>.yaml     ← Claude escribe la pregunta
  responses/
    req-<session>-<seq>-codex.yaml    ← Codex responde
    req-<session>-<seq>-gemini-pro.yaml  ← Gemini Pro responde
    req-<session>-<seq>-gemini-flash.yaml ← Gemini Flash (3er modelo: validación rápida)
  consensus/
    req-<session>-<seq>.md      ← Claude sintetiza respuesta final
  archive/                      ← conversaciones >30d auto-archivadas
```

**Request schema:**
```yaml
# req-20260504-001.yaml
id: req-20260504-001
session: sprint-2-design
question: |
  Evalúa este diseño de ZTMSI: [...]
context_files:
  - ~/.ultron/plans/2026-05-04-ultron-v14-overhaul-master-v3.md
  - ~/.ultron/index/ztmsi-design.md
models: [codex, gemini-pro, gemini-flash]
priority: critical    # critical | standard | quick
created: 2026-05-04T21:00:00Z
```

**Tercer modelo — Gemini Flash:**
- Ya disponible via mismo MCP (no setup nuevo)
- Rol: validación rápida (¿tiene bugs obvios? ¿hay inconsistencias?), no análisis profundo
- Invocado en TODOS los critical decisions como fast validator antes de Codex/Gemini Pro
- Costo: mínimo (flash), valor: detecta errores triviales antes de gastar Codex rounds

**Beneficios del protocolo de archivo:**
1. Conversaciones persisten entre sesiones — releer el historial de revisiones es gratis
2. Sin API calls bloqueantes — Claude escribe el request, invoca los modelos async, sigue trabajando
3. Audit trail completo de todas las decisiones críticas
4. Las respuestas pueden reutilizarse si el mismo problema reaparece

**Invocación simplificada en `shared-duet.ps1`:** el script ya existente se extiende para escribir al MMFP en lugar de invocar inline cuando se pasa flag `--async`.

---

## Sprint Overview (actualizado v3)

| # | Sprint | ROI | Coste | Peer Review | Bloqueante para |
|---|--------|-----|-------|-------------|-----------------|
| 0 | Cleanup & Cuts ✅ | Alto | 1-2 sesiones | MaxDual | S2 (suelo limpio) |
| 1 | Silent Execution + Alerts Bus | Medio (UX) | 1-2 sesiones | MaxDual | S5 (source de alerts) |
| **2** | **ZTMSI + Intent Dispatcher (UNIFIED)** | **Crítico** | **2-3 sesiones** | **MaxTriple** | **S3, S4, S5** |
| 3 | 3-Layer Memory + Chunked Index | Alto | 2 sesiones | MaxDual | S4 |
| 4 | Skills Manifest + Script-Only Sync | Medio | 1-2 sesiones | MaxDual | S5 |
| 5 | ultron doctor v2 (+ MCP resilience + token enforcement) | Medio-alto | 1-2 sesiones | MaxDual | S6 |
| 6 | Public Portfolio Repo | Bajo (estratégico) | 1-2 sesiones | MaxDual | — |

**Estimación total:** 9-14 sesiones. Release final v14.0.0 al cierre de S5; v14.1.0 al cierre de S6.

---

## Sprint 0 — Cleanup & Cuts ✅ DONE (2026-05-04)

Sin cambios vs plan v2. Cerrado, v13.3.0 "CLEAN HOUSE". Ver `~/.ultron/telemetry/v14-overhaul/sprint-0-final.md`.

---

## Sprint 1 — Silent Execution + Alerts Bus

Sin cambios vs plan v2. Plan detallado en `~/.ultron/plans/2026-05-04-sprint-1-silent-alerts.md`. **Listo para despachar.**

**Nota v3:** alerts.jsonl es usado por ZTMSI en S2 (index staleness alerts) y por MCP resilience en S5 — la infra de S1 es load-bearing para ambos.

---

## Sprint 2 — ZTMSI + Intent Dispatcher (UNIFIED) ⚡

**Goal (v3, rediseñado):** Construir el Zero-Token Index como fundación + el dispatcher como capa AI-facing sobre él. El dispatcher de v2 era un script Python con keyword hardcodeadas. El de v3 es una consulta a ZTMSI + un lookup en `manifest.cache.json`. Velocidad: de ~200ms (v2) a <50ms (v3). Token cost: de N tokens (v2) a **0 tokens** (v3, solo el resultado del query llega a Claude).

**Dos sub-pilares acoplados:**

### Pilar A — ZTMSI Core (índice)

**DONE criteria:**

- [ ] SQLite FTS5 schema definido y documentado en `~/.ultron/docs/ztmsi-schema.md`
- [ ] `ztmsi_build.py` — builder/updater:
  - [ ] `--full`: indexa todos los archivos del ecosistema desde cero
  - [ ] `--incremental`: solo archivos con mtime > `.last_rebuild`
  - [ ] `--path <dir>`: indexa un directorio específico (para tests)
  - [ ] Performance: `--full` en <30s para 600 archivos; `--incremental` en <2s típico
  - [ ] Parsea frontmatter KTP (Fundación 2) si existe; fallback: extrae keywords del contenido
  - [ ] Indexa a nivel párrafo (chunks ≥50 palabras, back-ref a archivo padre)
  - [ ] Registra `token_est` por archivo/chunk (len(content)//4, rápido)
- [ ] `ztmsi_query.py` — query engine:
  - [ ] Input: string query + optional filters (`--type memory`, `--layer L1`, `--tag ue5`)
  - [ ] Output: JSON rankeado `[{path, chunk_preview, score, token_est, tags}]`
  - [ ] Top-K configurable (default 5)
  - [ ] BM25 ranking (nativo FTS5)
  - [ ] Performance: <50ms para 600 archivos
- [ ] `ztmsi_tag.py` — auto-tagger:
  - [ ] Input: archivo sin frontmatter o frontmatter incompleto
  - [ ] Output: frontmatter sugerido (keywords del TF-IDF del contenido)
  - [ ] Modo `--dry-run`: muestra sugerencia sin escribir
  - [ ] Modo `--apply`: aplica con confirmación
  - [ ] **No invoca AI** — pure Python TF-IDF sobre corpus local
- [ ] CLI commands en `ultron.ps1`:
  - [ ] `ultron index rebuild [--full|--incremental]`
  - [ ] `ultron index query "<text>" [--type X] [--layer X] [--top N]`
  - [ ] `ultron index auto-tag <path> [--dry-run|--apply]`
  - [ ] `ultron index stats` (archivos indexados, chunks, tamaño DB, última rebuild)
- [ ] Hook: SessionStart verifica staleness de index → rebuild incremental si stale (>4h o vault mtime > index mtime) → silencioso

### Pilar B — Intent Dispatcher sobre ZTMSI

**DONE criteria:**

- [ ] `intent-dispatcher.py` instalado como hook UserPromptSubmit
- [ ] Lógica de clasificación (secuencial, short-circuit):
  1. **Slash command explícito** → route directo (zero ambiguity, cero ZTMSI cost)
  2. **Keyword exact-match** en `intent-rules.yaml` → route con confianza 0.95
  3. **ZTMSI query** sobre el prompt → `manifest.cache.json` para skill mapping
  4. **Fallback**: ULTRON MEDIUM, no route
- [ ] `intent-rules.yaml` — reglas editables sin Python:
  - Mantiene los 8 canonical patterns del v2 plan
  - Se carga en memoria al inicio de sesión (no re-parsed per prompt)
- [ ] `manifest.cache.json` — lookup table skill → triggers (generado por S4 manifest, mock en S2):
  ```json
  {"superpowers:systematic-debugging": {"triggers": ["bug", "error", "no funciona", "falla"], "cost": "medium"}}
  ```
- [ ] Output del dispatcher (inyectado como system note, NO en el prompt del usuario):
  ```
  [ULTRON ROUTE · 94%] superpowers:systematic-debugging | memory: L1/ue5-state.md (340 tok)
  ```
- [ ] Performance: <50ms total (ZTMSI query + manifest lookup + output format)
- [ ] **Fallback graceful**: try/except global → passthrough sin modificar prompt si dispatcher crashea
- [ ] Override: `/no-route` en prompt del usuario desactiva dispatch para ese prompt
- [ ] Telemetry: cada dispatch loggeado en `~/.ultron/telemetry/dispatcher-events.jsonl`
- [ ] Test: 8 canonical prompts clasifican correctamente; 2 edge cases no crashean; perf <50ms (pytest + `time.perf_counter`)

### Pilar C — MMFP Bootstrap (Multi-Model File Protocol infra)

- [ ] Estructura de directorios `~/.ultron/multimodel/` creada con `README.md` de schema
- [ ] `shared-duet.ps1` extendido: flag `--async` escribe request a MMFP en lugar de invocar inline
- [ ] Template de request YAML documentado
- [ ] Gemini Flash añadido como tercer modelo en el protocol (`--models codex,gemini-pro,gemini-flash`)

### Files

- **Create**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\ztmsi_build.py`
- **Create**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\ztmsi_query.py`
- **Create**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\ztmsi_tag.py`
- **Create**: `C:\Users\USER\.ultron\index\` (dir, empty DB created by first build)
- **Create**: `C:\Users\USER\.ultron\config\intent-rules.yaml`
- **Create**: `C:\Users\USER\.ultron\manifest.cache.json` (mock para S2, real en S4)
- **Create**: `C:\Users\USER\.claude\skills\ultron\hooks\intent-dispatcher.py`
- **Modify**: `C:\Users\USER\.claude\settings.json` (add UserPromptSubmit hook — after mode-trigger.py)
- **Modify**: `C:\Users\USER\.ultron\hooks\session-init.ps1` (add ZTMSI staleness check)
- **Modify**: `C:\Users\USER\.claude\skills\ultron\scripts\shared-duet.ps1` (add --async flag + MMFP)
- **Create**: `C:\Users\USER\.ultron\multimodel\` + `README.md`
- **Create**: `C:\Users\USER\.ultron\docs\ztmsi-schema.md`
- **Create**: `C:\Users\USER\.claude\skills\ultron\tests\test_ztmsi.py` (build + query + perf)
- **Create**: `C:\Users\USER\.claude\skills\ultron\tests\test_intent_dispatcher.py` (8 canonical + 2 edge + perf)
- **Create**: `C:\Users\USER\.ultron\plans\2026-MM-DD-sprint-2-ztmsi-dispatcher.md`

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| FTS5 no disponible en SQLite de Windows | High | Verificar en S0 pre-check; fallback: LIKE queries si FTS5 ausente (lento pero funcional) |
| **Misclassification → USER frustradu** | **CRITICAL** | Confidence ≥70%, siempre mostrable como "sugerencia", bypass `/no-route`, telemetry para tuning |
| ZTMSI rebuild lento (>30s full) | Medium | `--incremental` cubre 99% casos; `--full` solo post-cleanup |
| Dispatcher crashea → bloquea TODO prompt | **CRITICAL** | try/except global → passthrough; log a alerts.jsonl |
| Frontmatter KTP no adoptado en vault | Medium | `ztmsi_tag.py --apply` + doctor scan en S5 reporta archivos sin tags |
| MMFP requests se acumulan sin procesar | Low | `ultron doctor` reporta requests >24h sin response; auto-archive >7d |

### Peer Review

**MaxTriple (Codex + Gemini Pro + Gemini Flash, 5 rounds)** — decisión irreversible de arquitectura. Gemini Pro valida diseño vs alternativas (embeddings vs keywords, SQLite vs Whoosh vs FAISS). Codex valida lógica + performance. Gemini Flash detecta bugs obvios antes del review profundo.

---

## Sprint 3 — 3-Layer Memory + Chunked Index

**Goal (v3 mejorado):** Las 3 capas del v2 plan + integración con ZTMSI (S2 dep). Ahora la "memoria" no se carga en bloques de archivo — se carga en **chunks relevantes del párrafo exacto que responde la pregunta**. Reducción de tokens: 60-80% vs carga-archivo-completo.

**DONE criteria:**

- [ ] **L0 pinned** (≤200 tok, siempre) — sin cambios vs v2:
  - [ ] `generate_L0.py` produce `~/.ultron/.tmp/L0-pinned.md`
  - [ ] Identidad USER (1 línea) + foco actual + BLOCKING items + modo recomendado
  - [ ] Regenerado en SessionStart hook (después de ZTMSI rebuild)
  - [ ] Hard truncate si supera 200 tokens (BLOCKING items tienen prioridad)
- [ ] **L1 on-intent** — mejorado vs v2:
  - [ ] Dispatcher (S2) decide qué L1 cargar vía ZTMSI query, no hardcoded
  - [ ] L1 topics canónicos (archivos con KTP frontmatter):
    - [ ] `~/.ultron/memory/L1/projects-active.md` (frontmatter: `tags: [project, active, status]`)
    - [ ] `~/.ultron/memory/L1/skills-routing.md` (frontmatter: `tags: [skills, routing, manifest]`)
    - [ ] `~/.ultron/memory/L1/recent-decisions.md` (frontmatter: `tags: [decisions, sessions, history]`)
    - [ ] `~/.ultron/memory/L1/system-state.md` (frontmatter: `tags: [system, version, hooks, health]`)
  - [ ] **NUEVO: context packet** — dispatcher no carga archivo completo, carga los top-3 chunks ZTMSI del L1 más relevante (≤500 tok vs ≤2000 tok archivo completo)
  - [ ] Token budget L1: ≤600 tok total (context packet, nunca archivo completo sin justificación)
- [ ] **L2 queryable** — mejorado vs v2:
  - [ ] `brain_index.py` sigue siendo L2 (alias: `ultron index query`)
  - [ ] Gate explícito: solo accessible via dispatcher explicit trigger o `/deep` prefix en prompt
  - [ ] Resultados L2 también en context packet format (top-3 chunks, ≤500 tok)
  - [ ] Vault (`~/.ultron-vault/`, 616+ notas): indexado en ZTMSI como L2 items
- [ ] **`token_budget.py`** — hard enforcement (NUEVO):
  - [ ] `token_budget.measure(content) → int` (len//4 estimado, fast)
  - [ ] `token_budget.enforce(content, limit, priority_prefix="[BLOCKING]") → str` (trunca, preserva priority)
  - [ ] Usado por generate_L0.py y context packet builder
  - [ ] Logs budget usage: `"L0=145/200, L1=420/600, L2=0 → ULTRON overhead = 565 tok"`
- [ ] Test: sesión sin trigger especial carga **solo L0 (~145 tok)** — verificar vs baseline S0
- [ ] Test: prompt "qué decidimos sobre blueprints ue5" → dispatcher carga context packet de L1/vault ≤600 tok
- [ ] Test: prompt "/deep qué sabe ULTRON de blueprints" → L2 query, chunks del vault, ≤500 tok
- [ ] Documentación: `~/.ultron/docs/memory-layers.md` + políticas de carga + token budgets

### Files (adicionales a v2)

- **Create**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\token_budget.py`
- **Modify**: `generate_L0.py` (usar `token_budget.enforce`)
- **Create**: `context_packet_builder.py` (lógica de top-K chunks para L1/L2)
- **Modify**: `intent-dispatcher.py` (S2) — add context packet injection alongside skill suggestion

---

## Sprint 4 — Skills Manifest + Script-Only Sync

**Goal (v3 mejorado):** `skills.manifest.yaml` sigue siendo la SSOT. La mejora clave vs v2: **skill self-registration**. Cualquier skill nueva con frontmatter KTP correcto es detectada automáticamente por `registry_sync.py` en el siguiente sync — sin necesidad de editar el manifest manualmente. Escala sin coste de tokens.

**DONE criteria (cambios vs v2):**

- [ ] `skills.manifest.yaml` — schema extendido con KTP compatibility:
  ```yaml
  - name: superpowers:systematic-debugging
    source: plugin
    triggers: [bug, error, no funciona, falla, arreglar]    # ← también en ZTMSI
    cost_tier: medium
    dispatcher_priority: 2
    tags: [debugging, error-recovery, diagnosis]            # ← NUEVO: ZTMSI tags
    deprecated: false
    replaces: []
    last_used: 2026-05-04
    last_synced: 2026-05-04                                 # ← NUEVO: sync timestamp
  ```
- [ ] **Script-only sync protocol** (NUEVO — key improvement):
  - [ ] `registry_sync.py --auto-discover`: escanea `~/.claude/skills/*/SKILL.md` buscando frontmatter KTP
  - [ ] Skills nuevas con frontmatter válido → añadidas al manifest automáticamente (sin AI)
  - [ ] Skills existentes en manifest pero no en disco → marcadas `deprecated: true` automáticamente
  - [ ] **Zero tokens**: sync completo sin invocar Claude, puro Python file scanning
  - [ ] Trigger: `ultron sync` (ya existente) → extiende para incluir `registry_sync.py --auto-discover`
  - [ ] Report: `~/.ultron/telemetry/sync-events.jsonl` (qué se añadió/deprecó/cambió)
- [ ] `manifest.cache.json` (usado por dispatcher S2) regenerado al final de cada sync
- [ ] CLI commands (sin cambios vs v2 excepto):
  - [ ] `ultron manifest sync` → ejecuta auto-discover + report + rebuild cache
  - [ ] `ultron manifest list --unsynced` → skills en disco sin frontmatter (candidatos a auto-tag)

### Files (adicionales a v2)

- **Modify**: `registry_sync.py` (add `--auto-discover` mode + frontmatter parsing)
- **Modify**: `ultron.ps1` (extend `sync` subcommand to call `registry_sync.py --auto-discover`)

---

## Sprint 5 — ultron doctor v2 (+ MCP Resilience + Token Enforcement)

**Goal (v3 mejorado):** El doctor de v2 más dos pilares nuevos: (C) MCP resilience — manejo de fallos en servidores MCP externos — y (D) verificación de token enforcement — garantía de que el sistema no sobrepasa sus propios budgets.

### Pilar C — MCP Resilience (NUEVO en v3)

**Motivación:** Claude Code tiene múltiples MCP servers (GitHub, Spotify, Gmail, Supabase, etc.). Cuando uno falla (network, auth expired, server down), actualmente Claude falla sin contexto. Esto bloquea el flujo.

**DONE criteria:**

- [ ] `mcp-fallbacks.yaml` definido en `~/.ultron/config/mcp-fallbacks.yaml`:
  ```yaml
  github:
    fallback_message: "GitHub MCP unavailable — use gh CLI directly"
    fallback_skill: null
    alert_severity: warn
  supabase:
    fallback_message: "Supabase MCP unavailable — check connection or use supabase CLI"
    fallback_skill: null
    alert_severity: warn
  spotify:
    fallback_message: "Spotify MCP unavailable — skip music operations"
    fallback_skill: null
    alert_severity: info
  ```
- [ ] `mcp-resilience.py` hook PreToolUse:
  - [ ] Detecta tool calls que van a MCPs conocidos
  - [ ] Si el MCP está marcado como `degraded` en `~/.ultron/.tmp/mcp-health.json` → inyecta fallback message + escribe alert
  - [ ] **No bloquea la herramienta** — Claude puede intentar el call de todas formas, pero tiene contexto de lo que puede pasar
- [ ] `mcp-health-check.py` → script ejecutable desde `ultron doctor --health-check`:
  - [ ] Pings cada MCP server configurado en `settings.json`
  - [ ] Escribe resultados a `~/.ultron/.tmp/mcp-health.json`
  - [ ] Silencioso si todo OK; escribe alert si MCP degraded
- [ ] `ultron doctor --health-check` incluye MCP health en output
- [ ] SessionStart hook: ejecuta `mcp-health-check.py` (async, <3s timeout por MCP) → resultado disponible antes del primer prompt

### Pilar D — Token Enforcement Audit (NUEVO en v3)

**DONE criteria:**

- [ ] `ultron doctor --token-audit` → ejecuta una sesión simulada y mide overhead ULTRON:
  - [ ] Mide L0 size (debe ser ≤200 tok)
  - [ ] Mide manifest.cache.json size (debe ser ≤500 tok cuando inyectado)
  - [ ] Mide context.md size (debe ser ≤400 tok per CLAUDE.md spec)
  - [ ] Reporta overhead total estimado: "ULTRON always-on overhead: 1,100 tok/sesión"
  - [ ] Alerta si cualquier capa excede su budget
- [ ] Integración cron: `auto_doctor: true` en config → token audit semanal, alerta si overhead creció >20%

### Files (adicionales a v2)

- **Create**: `C:\Users\USER\.ultron\config\mcp-fallbacks.yaml`
- **Create**: `C:\Users\USER\.claude\skills\ultron\hooks\mcp-resilience.py`
- **Create**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\mcp_health_check.py`
- **Modify**: `doctor.py` (add MCP health check + token audit sub-commands)
- **Modify**: `session-init.ps1` (add async mcp-health-check call)

---

## Sprint 6 — Public Portfolio Repo (post-release)

Sin cambios estructurales vs plan v2. Añadir al checklist:

- [ ] ZTMSI schema y KTP protocol incluidos en repo público (son el showcase técnico más valioso)
- [ ] MMFP protocol documentado como "Multi-Model Review Pattern" para portfolio
- [ ] Ejemplos sanitizados de `manifest.cache.json` y `intent-rules.yaml` en repo
- [ ] Test `test_publish_sanitize.py` incluye check: 0 archivos `.fts.db` en output (contienen rutas personales)

---

## Protocols (Cross-Cutting)

### Keyword Tagging Standard (KTP) — aplicable desde S2

Todo archivo nuevo creado por scripts ULTRON incluye frontmatter KTP. Archivos existentes migrados progresivamente por `ztmsi_tag.py`. Doctor en S5 reporta archivos sin tags.

Campos obligatorios: `tags`, `type`, `last_updated`
Campos opcionales: `topics`, `priority`, `layer`, `token_est`

### Multi-Model File Protocol (MMFP) — activo desde S2

Toda decisión con `severity: critical` en el plan usa MMFP:
1. Claude escribe request YAML a `~/.ultron/multimodel/requests/`
2. Claude invoca Codex + Gemini Pro + Gemini Flash (3 modelos)
3. Claude lee responses y escribe consensus en `~/.ultron/multimodel/consensus/`
4. Consensus file persiste — reutilizable en sesiones futuras

### Token Budget Policy — activo desde S3

| Capa | Hard limit | Enforcer |
|------|-----------|----------|
| L0 pinned | 200 tok | `generate_L0.py` via `token_budget.enforce` |
| L1 context packet | 600 tok | `context_packet_builder.py` |
| L2 query result | 500 tok | `ztmsi_query.py` |
| manifest.cache.json (inyectado) | 500 tok | `registry_sync.py` (split si excede) |
| ULTRON total always-on | 1,500 tok | `doctor --token-audit` (weekly check) |

---

## Problem → Sprint Mapping (v3)

| # | Problema reportado | Sprint que lo resuelve |
|---|-------------------|-----------------------|
| 1 | Token waste masivo | **S2 (ZTMSI)** + S3 (context packets) |
| 2 | Vault inutilizable en práctica | **S2 (ZTMSI indexa vault)** + S3 (L2 chunked) |
| 3 | Memoria dispersa | S3 (3-layer) + **S2 (KTP tags unifican)** |
| 4 | Skills no auto-activan | **S2 (dispatcher sobre ZTMSI)** |
| 5 | Imposible escalar (sync manual) | **S4 (script-only auto-discover)** |
| 6 | MCP failures bloquean flujo | **S5 (MCP resilience)** |
| 7 | Multi-model solo inline | **S2 (MMFP bootstrap)** |
| 8 | Scripts abren ventanas | S1 (silent audit) |
| 9 | Self-healing / doctor | S5 (doctor v2) |
| 10 | Scripts no pueden alertar de errores | S1 (alerts bus) |
| 11 | Sin portfolio público | S6 |

---

## Cross-Cutting Conventions (sin cambios vs v2 excepto adiciones)

**Versioning:**
- S0 → 13.3.0 ✅ CLEAN HOUSE
- S1 → 13.4.0 (SILENT + ALERTS)
- **S2 → 13.5.0 (ZTMSI + DISPATCHER)**
- S3 → 13.6.0 (LAYERED MEMORY + CHUNKED INDEX)
- S4 → 13.7.0 (MANIFEST + SCRIPT SYNC)
- **S5 → 14.0.0 (MODULAR + MCP RESILIENCE + TOKEN ENFORCEMENT)**
- S6 → 14.1.0 (PORTFOLIO)

**No-Touch List:** sin cambios vs v2 (ver lista completa en plan v2).

**Hard rules portadas desde S0:**
1. NO POPUP WINDOWS — EVER
2. Python = uv only
3. Edit tool only en archivos existentes (BOM issue en PS5.1)
4. No destructive ops sin backup

---

## Self-Review v3

**¿Qué añade v3 que no tenía v2?**

1. **ZTMSI** — el hash/árbol de memoria que propuso USER, implementado como FTS5 SQLite con indexación por párrafo
2. **Keyword Protocol** — protocolo estándar de frontmatter, auto-sync sin tokens
3. **MMFP + Gemini Flash** — tercer modelo, conversaciones persistentes en archivos
4. **Context packets** — carga párrafos relevantes, no archivos completos (-60-80% tokens)
5. **Script-Only sync** — skills se auto-registran, 0 tokens de mantenimiento
6. **MCP resilience** — fallos de MCPs manejados con fallback graceful
7. **Hard token enforcement** — budgets por capa con truncation real, no solo logging
8. **5 criterios de éxito medibles** — antes era vago

**¿Qué complejidad añade?**

3 módulos Python nuevos (`ztmsi_build.py`, `ztmsi_query.py`, `ztmsi_tag.py`) + 2 hooks (`mcp-resilience.py`, dispatcher mejorado) + estructura MMFP + `token_budget.py`. Todo esto **reemplaza** lógica que antes estaba distribuida en docenas de archivos y CLAUDE.md. Complejidad neta: **menor que v2** porque consolida.

**¿Cuándo ejecutar?**

Próximo paso: S1 (plan ya existe). S2 es el sprint de inversión alta — si sale bien, S3-S4 son consecuencias naturales. Si S2 falla, mantiene S1 como mejora standalone.

---

## Execution Handoff (v3)

**Estado actual (2026-05-04):** S0 cerrado, v13.3.0. Plan v3 escrito.

**Próximo paso:** Despachar S1 (`~/.ultron/plans/2026-05-04-sprint-1-silent-alerts.md`).

**Recomendación de split para S1:** Despachar en 2 subagents (Pilar B primero — Alerts Bus, luego Pilar A — Silent Execution) para mantener presupuesto de tokens bajo control.

**S2 necesita:** Verificación de FTS5 disponible en SQLite Windows antes de empezar (test rápido: `python -c "import sqlite3; conn = sqlite3.connect(':memory:'); conn.execute('CREATE VIRTUAL TABLE t USING fts5(content)')"` — si no lanza error, FTS5 OK).

**Archivos creados en v3:**
- `~/.ultron/plans/2026-05-04-ultron-v14-overhaul-master-v3.md` ← este archivo
