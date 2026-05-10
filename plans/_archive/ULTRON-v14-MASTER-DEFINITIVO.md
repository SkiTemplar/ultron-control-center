# ULTRON v14.0 "Index-First" — PLAN MAESTRO DEFINITIVO

> **Versión:** 4.5 (2026-05-05 PM) — Documento único de autoridad. Supersede todos los planes anteriores.
> **Estado:** S0 DONE · **S1 DONE → v13.4.0 "SILENT + ALERTS"** · S2 audit cerrado · S2-S6 ESPECIFICADOS
> **Pre-condición global verificada:** FTS5 OK (SQLite 3.50.4, Python 3.14.2) · brain_index.py auditado (626 notas, no 970)
> **Fixes aplicados 2026-05-04:** superpowers-mcp eliminado · Gemini configurado · hooks terminal-safe
> **⚠️ LEER §13 ANTES DE EJECUTAR CUALQUIER SPRINT** — auditoría de qué ya existe cambia el scope de S1-S5
>
> **Cambios v4.4 → v4.5 (2026-05-05 PM, sesión 6b67e2ac):**
> - **S1 cerrado como DONE**: Pilar A creado 2026-05-05 12:49-12:50 (silent_exec.py 6KB · audit_silent_exec.py 10.7KB · silent-execution-policy.md 6KB · hookify guardrail dual-path · sprint-1-final.md 4.4KB). Version bump a v13.4.0 ya aplicado en `cockpit/ultron.ps1` y `cockpit/tui.py`. Backup `~/.ultron/backups/2026-05-05-pre-S1-pilar-A/` existe.
> - **§13.5 audit `brain_index.py` cerrado**: gaps confirmados con código real (702 líneas, 26.7KB). Decisión EXTENDER (no crear ztmsi_build/query/tag paralelos como decía v4.4). DB real tiene 626 notas (no 970 — número stale en §13.6 corregido).
> - **§6/S2 Sub-pilar A reescrito**: ahora extiende `brain_index.py` con `chunks` table + `token_est` columns + `--mode chunks` query flag. NO se crean archivos paralelos. Estimación bajada de ~4h a ~3h. Sub-gap "indexar skill_manifest.json triggers" movido a S4 (donde corresponde — el manifest export es de S4).
> - **§10.1/10.2/10.7 actualizados**: próxima acción es S2 Sub-pilar A solo (no MaxTriple via MMFP, demasiado pronto). Peer review S2-A con Codex Dual 1 round directo.
> - **§14.2 naming v1.0.0**: explicitado como BLOQUEO de S5 release (no de S2-S4). Decisión que USER debe tomar antes de tag v14.0.0.
>
> **Cambios v4.5 → v4.6 (2026-05-05 PM, post-S1, decisión naming):**
> - **Naming RESUELTO:** sistema sigue siendo **ULTRON** (no rename). v14.0.0 lleva codename **"GENESIS"** como apellido de versión (patrón v13.3.0 "CLEAN HOUSE", v13.4.0 "SILENT + ALERTS"). Framing: codename evocador por release, no rebranding global. NEXUS/HERALD/APEX/KRONOS descartados.
> - **§14.2 #1 limpiado:** decisión bloqueante de naming → cerrada. S5 desbloqueado.
> - **§12.8 actualizado:** opción elegida es "mantener ULTRON + codename release". Tabla de naming queda como histórico de la decisión.
> - **§6/S5, §10, tabla sprints:** v14.0.0 ahora se referencia como **v14.0.0 "GENESIS"** (antes "MODULAR" que era descriptor placeholder).
> - S2-A despachado como subagent compacto el 2026-05-05 PM (sesión de9440c3).
>
> **Cambios v4.2 → v4.3 (2026-05-05, sesión validación interna):**
> - Path correcto: `scripts/cockpit/ultron.ps1` (no `scripts/ultron.ps1`) — corregido en TODO el plan
> - S1 Pilar B re-scoped: `alerts.py` + CLI + hook integration + docs ya existen
> - S1 Pilar A reenfocado: los 3 seed alerts son STALE/mis-atribuidos al harness, no a session-init.ps1
> - §7.5 Pre-flight: añadido paso 0 obligatorio "leer §13 + comparar con disco"
> - §7.2 MMFP: añadida nota "S1 NO usa MMFP (no existe aún) — usar shared-duet.ps1 directo"
> - §13.4 Gemini: confirmado serving id `gemini-3.1-pro` (free quota agotada, fallback a Codex/2.5)
> - §9 nuevos riesgos R10 (harness mis-attribution) + R11 (subagent ignora §13)
>
> **Cambios v4.3 → v4.4 (2026-05-05, post-Codex peer review):**
> - **Pilar B = 100% DONE**: `tests/test_alerts.py` (7 KB, 13 tests) ya existe + 13/13 PASS verificado. NO hay implementación pendiente. `write-alert.ps1` confirmado opcional.
> - **`2026-05-04-sprint-1-silent-alerts.md` marcado SUPERSEDED** (header banner añadido) para evitar que subagents lean specs stale
> - §10.2 estimaciones corregidas (Pilar B = 0 min implementación, solo verificación)
> - §14 "Plan Cerrado" actualizado a 4.4 LOCKED (no 4.2)
> - §14.2 decisiones pendientes limpiadas (ultron alerts CLI ya verified, solo queda decisión naming v1.0.0)
> - §13/Pilar A wording suavizado: "Claude Code harness/plugin layer" en vez de "Bash tool itself" (alineado con evidencia disponible)
> - Pilar A acceptance: usar `rg -P` (PCRE2) o script AST en vez de negative lookahead (que no funciona en ripgrep default)
> - Pilar A scope: `silent_exec.py` solo helper para código NUEVO, no migración bulk de 75 archivos. Migrar high-traffic scripts oportunísticamente
> - §13.4 Gemini section: separados 3 facts independientes (serving id / shared-duet alias / settings default)

---

## TABLA DE CONTENIDOS

1. [Executive Summary](#1)
2. [Diagnóstico — Root Cause Analysis](#2)
3. [Arquitectura del Sistema](#3)
4. [Criterios de Éxito](#4)
5. [Pre-condiciones y Dependencias](#5)
6. [Especificaciones de Sprint](#6)
   - [S0 — Cleanup ✅](#s0)
   - [S1 — Silent + Alerts](#s1)
   - [S2 — ZTMSI + Dispatcher](#s2)
   - [S3 — 3-Layer Memory](#s3)
   - [S4 — Skills Manifest](#s4)
   - [S5 — Doctor + MCP + Token Enforcement](#s5)
   - [S6 — Portfolio Público](#s6)
7. [Protocolos Transversales](#7)
8. [Registro de Decisiones Arquitectónicas](#8)
9. [Registro de Riesgos (Consolidado)](#9)
10. [Ejecución — Handoff](#10)

---

<a name="0"></a>
## 0. TRES PILARES FUNDAMENTALES

Estos tres principios gobiernan **toda** decisión técnica del sistema. Cualquier implementación que viole uno de ellos es incorrecta por definición, independientemente de si "funciona".

---

### PILAR I — SCRIPTS INVISIBLES

> **"Si el usuario lo ve, es un bug."**

Todo proceso que ULTRON ejecuta — hooks, scripts de cockpit, sync, health check, index rebuild — debe ser **completamente invisible**. No hay excepciones. Ni un flash de 100ms. Ni una ventana que aparece y desaparece.

**Lo que esto significa en código:**

| Contexto | Obligatorio |
|----------|-------------|
| `subprocess.Popen` / `subprocess.run` en Python | `creationflags=subprocess.CREATE_NO_WINDOW` + `capture_output=True` |
| `Start-Process` en PowerShell | `-WindowStyle Hidden -NoProfile -NonInteractive` |
| `subprocess` que spawna otro proceso | El hijo también hereda CREATE_NO_WINDOW |
| Hook en settings.json que llama PS | `-WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass` |
| Excepción única | `tui.py` — ventana intencionada, documentada, activada por el usuario |

**Enforcement activo:**
- S1: Auditoría exhaustiva + `silent_exec.py` wrapper
- S2+: Hookify guardrail permanente que bloquea `Start-Process` sin `-WindowStyle Hidden` en scripts ULTRON
- S5: `ultron doctor` detecta y reporta violaciones

---

### PILAR II — TOKEN EFFICIENCY FIRST

> **"El token es la divisa. Gastar en rutinas es quemar dinero en administración."**

ULTRON debe costar **menos** tokens que trabajar sin él. Si el sistema ULTRON consume más tokens de los que ahorra en razonamiento, es un fracaso. Cada overhead de token tiene que justificar su existencia.

**Jerarquía de decisiones:**

```
1. ¿Puede hacerlo un script determinista?     → Script. 0 tokens.
2. ¿Puede hacerlo un índice pre-computado?    → Índice. 0 tokens.
3. ¿Puede hacerlo un algoritmo (BM25, TS)?   → Algoritmo. 0 tokens.
4. ¿Requiere razonamiento real?               → Claude. Tokens justificados.
```

**Hard budgets (no negociables):**

| Capa | Límite | Qué pasa si se excede |
|------|--------|----------------------|
| L0 always-on | 200 tok | `token_budget.enforce()` trunca, preserva BLOCKING |
| L1 context packet | 600 tok | `context_packet_builder` reduce top-K chunks |
| L2 query result | 500 tok | `brain_index.py` reduce top-K |
| ULTRON overhead total/sesión | 1.500 tok | Doctor alerta, E1 criterion falla |
| Sprint subagent individual | ~2h estimados | Split en subagents más pequeños |

**Anti-patrones prohibidos:**
- Leer un archivo completo cuando solo se necesita un párrafo
- Pedir a Claude que clasifique una skill cuando Thompson Sampling + BM25 ya lo hacen
- Cargar MEMORY.md completo si L0 + context packet cubren la necesidad
- Re-indexar 626 notas cuando solo 3 cambiaron (usar `--incremental`)

---

### PILAR III — INTELIGENCIA EN SCRIPTS, NO EN PROMPTS

> **"Si un algoritmo puede hacerlo en 50ms, Claude no debería hacerlo en 2 segundos."**

ULTRON delega a algoritmos deterministas todo lo que no requiere razonamiento creativo. Claude es el **orquestador de alto nivel** — no el clasificador de keywords, no el router de skills, no el generador de índices.

**Algoritmos activos (ya en el sistema):**

| Algoritmo | Script | Qué decide |
|-----------|--------|------------|
| **BM25 / FTS5** | `brain_index.py` | Qué memoria es relevante para un query |
| **Thompson Sampling** | `routing_decide.py` | Qué skill tiene mejor historial para este contexto |
| **Decay scoring** | `decay_queue.py` | Qué notas del vault están más desactualizadas |
| **TF-IDF local** | `frontmatter_backfill.py` extendido (S2) | Qué keywords caracterizan un archivo sin leerlo Claude |
| **Token counting** | `token_budget.py` (S3) | Hard enforcement de budgets sin consultar al modelo |

**Algoritmos nuevos por añadir en S2-S3:**

| Algoritmo | Script | Qué decide |
|-----------|--------|------------|
| **BM25 a nivel chunk** | `brain_index.py` extendido | Qué PÁRRAFO (no qué archivo) es relevante |
| **Hookify pattern matching** | rules YAML | Routing de skills conocidas sin Python ni tokens |
| **Token estimation** | `brain_index.py` (añadir `token_est`) | Costo de cargar un chunk antes de decidir |

**Regla de diseño:** si estás preguntándole a Claude algo que una función Python puede responder en <100ms, la arquitectura es incorrecta.

---

<a name="1"></a>
## 1. EXECUTIVE SUMMARY

**Problema:** ULTRON consume más tokens que el modelo base (vanilla) sin entregar ventaja proporcional.
Causa raíz: hace trabajo de scripts en tiempo de inferencia. Cada "¿qué memoria cargo?", "¿qué skill uso?" es tokens quemados.

**Solución:** Mover toda la lógica de routing al nivel de scripts (zero tokens). Claude solo ejecuta — no busca.

**Arquitectura resultante:**

```
PROMPT DEL USUARIO
      │
      ▼
[UserPromptSubmit hook — <50ms, 0 tokens]
      │
      ├─ ZTMSI query ──────────────────► SQLite FTS5 (pre-built, 600+ files, paragraph-level)
      │                                         │
      │                                  Top-K chunks rankeados
      │                                  + skill candidates
      │                                         │
      ├─ manifest.cache.json ◄──────────────────┘
      │
      ▼
Context packet inyectado (≤1500 tok total overhead)
      │
      ▼
[CLAUDE recibe prompt + contexto ya resuelto]
      │
      ▼
Respuesta con skill/memoria correcta · sin buscar · sin gastar tokens extra
```

**Resultado esperado vs estado actual:**

| Métrica | v13.3.0 (hoy) | v14.0.0 (objetivo) |
|---------|--------------|-------------------|
| Overhead ULTRON/sesión | ~8,000-15,000 tok (estimado) | ≤1,500 tok always-on |
| Tiempo routing | variable (en inferencia) | <50ms (script) |
| Skills auto-activadas correctamente | <40% | ≥80% |
| Vault accesible sin exploración manual | No | Sí (ZTMSI, <100ms) |
| Sync skills nuevas | Manual (editar 3+ archivos) | Automático (frontmatter) |
| MCP failures manejadas | No (crash silencioso) | Sí (fallback + alert) |

---

<a name="2"></a>
## 2. DIAGNÓSTICO — ROOT CAUSE ANALYSIS

### 2.1 Los 5 problemas y su causa real

**Problema 1 — Token waste**
- Síntoma: sesiones que superan 150K tokens con trabajo modesto
- Causa: `context.md` + MEMORY.md + SKILL.md + múltiples archivos vault cargados upfront
- Causa raíz: no hay filtro pre-inferencia — todo entra al contexto por defecto

**Problema 2 — Vault inutilizable**
- Síntoma: ULTRON no responde preguntas usando el vault aunque la respuesta esté ahí
- Causa: 616 notas sin índice keyword navegable — buscarlas gasta más tokens que su valor
- Causa raíz: `brain_index.py` existe pero no está integrado en el flujo de sesión

**Problema 3 — Memoria dispersa**
- Síntoma: información en `~/.ultron/memory/`, `~/.ultron-vault/`, `CLAUDE.md`, `MEMORY.md`, `context.md`
- Causa: crecimiento orgánico sin arquitectura, cada versión añadió una zona nueva
- Causa raíz: nunca se definió una política de carga — todo está implícito

**Problema 4 — Skills no auto-activan**
- Síntoma: USER tiene que invocar skills manualmente siempre
- Causa: el dispatcher (v2) era un script de keywords hardcodeadas sin feedback loop
- Causa raíz: clasificación hecha en inferencia, no en pre-procesamiento

**Problema 5 — Escalabilidad imposible**
- Síntoma: añadir una skill nueva requiere editar CLAUDE.md + settings.json + SKILL.md + posiblemente hookify rules
- Causa: sin SSOT — cada componente del sistema tiene su propio registro
- Causa raíz: arquitectura aditiva (cada versión añadió su capa encima de la anterior)

### 2.2 Por qué los planes anteriores no resolvieron esto

- **v11, v12:** atacaban síntomas específicos (memory sync, skill discovery) sin cambiar la arquitectura subyacente
- **v13:** limpió cruft (S0) pero no cambió el modelo de routing
- **v14 plan v2:** identificó el dispatcher como solución pero no resolvió que el dispatcher mismo necesita routing zero-token

**El insight de v4 (este plan):** El dispatcher no debe clasificar — debe *consultar*. La clasificación ya está hecha en el índice.

---

<a name="3"></a>
## 3. ARQUITECTURA DEL SISTEMA

### 3.1 Capas

```
┌─────────────────────────────────────────────────────────────────────┐
│  CAPA 0: CLAUDE CODE SESSION                                        │
│  Modelo: claude-sonnet-4-6 (Sonnet 4.6) / Opus 4.7 para MaxDual   │
│  Context window: ~200K tokens                                       │
├─────────────────────────────────────────────────────────────────────┤
│  CAPA 1: HOOKS (Python · PowerShell)                                │
│  SessionStart → L0 gen + ZTMSI staleness check + MCP health check  │
│  UserPromptSubmit → Intent Dispatcher (<50ms, 0 tokens)             │
│  PreToolUse → MCP Resilience + auto-approve read-only               │
│  PostToolUse → routing telemetry                                    │
│  Stop → memory sync + optional doctor                               │
├─────────────────────────────────────────────────────────────────────┤
│  CAPA 2: ZTMSI (Zero-Token Memory & Skills Index)                   │
│  SQLite FTS5 · 600+ archivos · indexación a nivel párrafo          │
│  Rebuild incremental <2s · Query <50ms · 0 tokens                   │
│  Fuentes: vault + L1 memory + L2 memory + skills metadata           │
├─────────────────────────────────────────────────────────────────────┤
│  CAPA 3: MEMORIA ESTRATIFICADA                                      │
│  L0 pinned (≤200 tok, siempre) ← generate_L0.py                   │
│  L1 on-intent (≤600 tok, context packets) ← dispatcher decide      │
│  L2 queryable (≤500 tok/query, chunks) ← ZTMSI                     │
├─────────────────────────────────────────────────────────────────────┤
│  CAPA 4: SKILLS & MANIFEST                                          │
│  skills.manifest.yaml (SSOT) · manifest.cache.json (dispatcher)    │
│  Auto-discovery via KTP frontmatter · Zero-token sync              │
├─────────────────────────────────────────────────────────────────────┤
│  CAPA 5: MULTI-MODEL (Codex + Gemini Pro + Gemini Flash)            │
│  MMFP: file-based async conversations · persistentes entre sesiones │
│  Claude: orquestador · Codex: peer lógica · Gemini Pro: arquitectura│
│  Gemini Flash: validador rápido (3er modelo, ya disponible)         │
├─────────────────────────────────────────────────────────────────────┤
│  CAPA 6: OBSERVABILIDAD                                             │
│  alerts.jsonl (append-only) · dispatcher telemetry · sync events   │
│  token budget logs · mcp health · ultron doctor CLI                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 Flujo de datos — sesión típica

```
1. SessionStart hook
   ├── ZTMSI staleness check → rebuild incremental si >4h stale
   ├── generate_L0.py → ~/.ultron/.tmp/L0-pinned.md (≤200 tok)
   ├── mcp_health_check.py async → ~/.ultron/.tmp/mcp-health.json
   └── read unacked alerts → inject [BLOCKING]/[WARN] en context.md

2. USER escribe prompt

3. UserPromptSubmit hook (intent-dispatcher.py, <50ms)
   ├── slash command? → route directo (0 ZTMSI cost)
   ├── keyword exact-match en intent-rules.yaml? → route (confidence 0.95)
   ├── ZTMSI query(prompt) → top-5 chunks rankeados
   ├── manifest.cache.json lookup → skill candidates
   └── inject system note: "[ULTRON ROUTE·94%] skill | memory chunk 340tok"

4. Claude responde usando skill + memory inyectados

5. Stop hook
   ├── memory_sync.py → actualiza L1 recent-decisions.md
   ├── ZTMSI rebuild incremental (si hay nuevos archivos)
   └── doctor (opt-in) → silent scan
```

### 3.3 Árbol de archivos clave (post v14.0.0)

```
~/.claude/
├── settings.json                          ← hooks + plugins + MCP config
├── CLAUDE.md                              ← instrucciones globales (no memory)
├── skills/ultron/
│   ├── SKILL.md                           ← skill metadata (KTP tagged)
│   ├── CLAUDE.md                          ← instrucciones de skill
│   ├── hooks/
│   │   ├── intent-dispatcher.py           ← S2 (NEW)
│   │   ├── mcp-resilience.py              ← S5 (NEW)
│   │   ├── auto-approve-readonly.py       ← existing
│   │   ├── block-dangerous-bash.py        ← existing
│   │   ├── routing-telemetry.py           ← existing
│   │   ├── session-log.py                 ← existing
│   │   └── mode-trigger.py               ← existing
│   ├── scripts/
│   │   ├── ultron.ps1                     ← CLI principal
│   │   ├── shared-duet.ps1               ← MMFP extended (S2)
│   │   └── cockpit/
│   │       ├── brain_index.py             ← existing (S2: + chunks_fts + token_est + --mode chunks)
│   │       ├── frontmatter_backfill.py    ← existing (S2: + KTP fields tags/token_est/layer)
│   │       ├── generate_L0.py             ← S3 (NEW)
│   │       ├── context_packet_builder.py  ← S3 (NEW)
│   │       ├── token_budget.py            ← S3 (NEW)
│   │       ├── mcp_health_check.py        ← S5 (NEW)
│   │       ├── alerts.py                  ← existing (S1 ✅ DONE)
│   │       ├── silent_exec.py             ← existing (S1 ✅ DONE)
│   │       ├── audit_silent_exec.py       ← existing (S1 ✅ DONE)
│   │       ├── doctor.py                  ← S5 (NEW)
│   │       ├── memory_sync.py             ← existing
│   │       └── [otros scripts existentes]
│   │   # NO existirán: ztmsi_build.py / ztmsi_query.py / ztmsi_tag.py (ADR-006: extender brain_index.py)
│   └── tests/
│       ├── test_ztmsi.py                  ← S2 (NEW)
│       ├── test_intent_dispatcher.py      ← S2 (NEW)
│       └── test_doctor.py                 ← S5 (NEW)

~/.ultron/
├── index/                                 ← S2 (NEW)
│   ├── ztmsi.fts.db                       ← SQLite FTS5 principal
│   ├── manifest.cache.json                ← pre-computed routing
│   ├── memory.registry.json               ← metadata archivos indexados
│   └── .last_rebuild                      ← timestamp staleness
├── memory/
│   ├── L1/                                ← S3 (NEW)
│   │   ├── projects-active.md             ← KTP tagged
│   │   ├── skills-routing.md              ← KTP tagged
│   │   ├── recent-decisions.md            ← KTP tagged
│   │   └── system-state.md               ← KTP tagged
│   └── [existing memory files — migrar KTP tags en S2/S3]
├── .tmp/
│   ├── context.md                         ← session context (existing)
│   ├── L0-pinned.md                       ← S3 (NEW)
│   └── mcp-health.json                    ← S5 (NEW)
├── config/
│   ├── intent-rules.yaml                  ← S2 (NEW)
│   ├── mcp-fallbacks.yaml                 ← S5 (NEW)
│   └── doctor-rules.yaml                  ← S5 (NEW)
├── multimodel/                            ← S2 (NEW — MMFP)
│   ├── requests/
│   ├── responses/
│   ├── consensus/
│   └── archive/
├── skills.manifest.yaml                   ← S4 (NEW)
├── alerts.jsonl                           ← S1 (NEW)
├── scripts/alerts/
│   └── write-alert.ps1                    ← S1 (NEW)
├── hooks/
│   ├── session-init.ps1                   ← existing (extend en S1, S2, S3, S5)
│   └── stop-memory-sync.ps1              ← existing (extend en S5)
└── docs/                                  ← documentación técnica
    ├── ztmsi-schema.md                    ← S2
    ├── memory-layers.md                   ← S3
    ├── skills-manifest-schema.md          ← S4
    ├── alerts-bus.md                      ← S1
    ├── mcp-fallbacks.md                   ← S5
    └── silent-execution-policy.md        ← S1
```

---

<a name="4"></a>
## 4. CRITERIOS DE ÉXITO

Estos son los 5 criterios que determinan si v14.0.0 fue exitoso. Todos son binarios y medibles.

| # | Criterio | Definición exacta de PASS | Cómo medir | Sprint |
|---|----------|--------------------------|------------|--------|
| **E1** | Token overhead ≤5% vs vanilla | `ultron doctor --token-audit` reporta ≤1,500 tok always-on overhead | `token_budget.py` log en cada sesión; baseline vs v13.3.0 en `telemetry/v14-overhaul/` | S3 |
| **E2** | Routing correcto ≥80% de sesiones | En 10 sesiones consecutivas post-release, dispatcher propone skill correcta sin `/no-route` en ≥8 | Telemetry `dispatcher-events.jsonl` + evaluación manual de USER | S2 |
| **E3** | Vault query <100ms para 600+ archivos | `uv run python brain_index.py query "benchmark" --mode chunks --top 5` retorna en <100ms (promedio de 10 runs) | Benchmark incluido en `test_brain_index_chunks.py` | S2 |
| **E4** | MCP failures 100% manejadas | En `ultron doctor --health-check`, 0 MCPs en estado "hard fail" sin alert ni fallback message | `mcp-health.json` status + alerts.jsonl check | S5 |
| **E5** | Skill sync sin tokens | `ultron manifest sync` añade una skill nueva (con KTP frontmatter) al manifest sin intervención de Claude | Verificar en `sync-events.jsonl` que el entry tiene `source: auto-discover` | S4 |

**Criterio de release v14.0.0:** E1 + E2 + E3 deben pasar. E4 y E5 deben pasar para release.
**Criterio de rollback:** Si E1 falla en 2 sesiones consecutivas post-release → rollback a v13.4.0 y re-evaluar S2/S3.

---

<a name="5"></a>
## 5. PRE-CONDICIONES Y DEPENDENCIAS

### 5.1 Pre-condiciones globales (verificadas)

| Condición | Estado | Verificación |
|-----------|--------|-------------|
| FTS5 disponible en SQLite | ✅ OK (3.50.4) | `python -c "import sqlite3; sqlite3.connect(':memory:').execute('CREATE VIRTUAL TABLE t USING fts5(content)')"` |
| Python ≥ 3.11 | ✅ OK (3.14.2) | `python --version` |
| UV disponible | Assumed OK | `uv --version` |
| `brain_index.py` funcional | Assumed OK (S0 verified) | `uv run python brain_index.py status` |
| S0 cleanup completado | ✅ DONE 2026-05-04 | `~/.ultron/telemetry/v14-overhaul/sprint-0-final.md` |

### 5.2 Dependencias entre sprints

```
S0 ✅ ──► S1 ──► S2 ──► S3 ──► S4 ──► S5 ──► S6
           │      │      │      │
           │      │      │      └── manifest.cache.json (S4 produce, S2 usa mock)
           │      │      └── context_packet_builder usa ZTMSI (S2 dep)
           │      └── alerts.jsonl usada por ZTMSI staleness alerts (S1 dep)
           └── Pilar B (alerts) bloqueante para S2 (dispatcher puede escribir alerts)
```

**Dependencias explícitas:**

| Sprint | Requiere de S anterior | Produce para S posterior |
|--------|----------------------|--------------------------|
| S1 | S0 (suelo limpio) | alerts.jsonl (usado por S2 dispatcher crash reporting) |
| S2 | S0 + S1 (alerts infra) | ztmsi.fts.db, intent-dispatcher.py, manifest.cache.json (mock), MMFP infra |
| S3 | S2 (ZTMSI query, dispatcher) | token_budget.py, generate_L0.py, context_packet_builder.py |
| S4 | S2 (manifest.cache.json schema definido) | skills.manifest.yaml, manifest.cache.json (real, reemplaza mock) |
| S5 | S1 (alerts.jsonl), S3 (token_budget.py), S4 (manifest SSOT) | mcp-health.json, doctor.py |
| S6 | S5 (release v14.0.0 estable) | ~/.ultron-public/ repo |

### 5.3 Pre-condiciones por sprint

| Sprint | Pre-condición mínima antes de arrancar |
|--------|---------------------------------------|
| S1 | S0 DONE ✅ |
| S2 | S1 DONE ✅ + FTS5 OK ✅ + `brain_index.py` audited (§13.5) ✅ |
| S3 | S2 DONE + `brain_index.py query --mode chunks` benchmark <100ms ✅ |
| S4 | S2 DONE (schema de manifest.cache.json definido) |
| S5 | S3 DONE + S4 DONE (manifest SSOT funcional) |
| S6 | S5 DONE + versión v14.0.0 taggeada en git |

---

<a name="6"></a>
## 6. ESPECIFICACIONES DE SPRINT

**Convenciones:**
- DONE criteria: binarios (✓/✗). Si hay ambigüedad, la tarea no está suficientemente especificada.
- Paths: absolutos `C:\Users\USER\` en lugar de `~/`
- Tests: todos vía `uv run pytest` — no manualmente
- Peer review: SIEMPRE al final del sprint, antes del version bump
- Backup: SIEMPRE antes de cambios destructivos en `~/.ultron/backups/YYYY-MM-DD-pre-SN/`

---

<a name="s0"></a>
### Sprint 0 — Cleanup & Cuts ✅ DONE (2026-05-04)

**Version:** v13.2.0 → **v13.3.0 "CLEAN HOUSE"**
**Duración real:** 1 sesión
**Resultado:** 17→13 plugins, 9→8 MCPs, ~6MB cruft eliminado, 22 version touchpoints corregidos.
**Rollback:** `~/.ultron/backups/2026-05-04-pre-S0/restore.ps1` (existe)
**Telemetría:** `~/.ultron/telemetry/v14-overhaul/sprint-0-final.md`

---

<a name="s1"></a>
### Sprint 1 — Silent Execution + Alerts Bus ✅ DONE (2026-05-05)

**Version conseguida:** v13.3.0 → **v13.4.0 "SILENT + ALERTS"** ✅
**Duración real:** Pilar B verificado pre-existing (0 min impl) + Pilar A 1 subagent (~75 min)
**Plan autoritativo:** ESTA sección + §13 (auditoría existente). El archivo `2026-05-04-sprint-1-silent-alerts.md` está SUPERSEDED — NO leer.
**Estado:** ✅ DONE · ambos pilares completos · version bumpeada · 4 rounds Codex peer review aplicados
**Outcome (verificado en disco 2026-05-05 14:15):**
- Pilar B: `alerts.py` (17.6KB) + CLI + hook + docs + `tests/test_alerts.py` 13/13 PASS
- Pilar A: `silent_exec.py` (6KB) + `audit_silent_exec.py` (10.7KB) + `docs/silent-execution-policy.md` (6KB) + hookify guardrail dual-path
- Telemetría: `~/.ultron/telemetry/v14-overhaul/sprint-1-final.md` (4.4KB)
- Backup: `~/.ultron/backups/2026-05-05-pre-S1-pilar-A/`
- 3 seed alerts (a-2026-05-04-001/002/003) ack'd y documentados como harness limitations
- Versión escrita en: `cockpit/ultron.ps1:1` + `cockpit/tui.py:3`

#### Pre-flight checklist S1 (v4.4)
- [ ] Leer ESTA sección §6/S1 + §13 (audit existente) del master v4.4 — NO leer plan detallado superseded
- [ ] Verificar que `~/.ultron/hooks/session-init.ps1` existe (no tocar — funciona)
- [ ] Crear backup: `~/.ultron/backups/2026-05-05-pre-S1-pilar-A/` (snapshot scripts/cockpit/ + hooks/)
- [ ] Confirmar `uv run pytest tests/test_alerts.py -v` GREEN antes de empezar (regression baseline)

#### Pilar B — Alerts Bus ✅ DONE v4.4 (verificado 2026-05-05)

**Estado real (todo verificado):**
- ✅ `~/.ultron/alerts.jsonl` existe (6 líneas: 3 seed alerts + 3 ack-events de hoy)
- ✅ `alerts.py` (17 KB) implementado: atomic writes, msvcrt/fcntl locks, severity ladder, ack-as-events
- ✅ `alerts/archive/` directorio listo
- ✅ `docs/alerts-bus.md` (6.5 KB) completo con schema, API, integración
- ✅ `ultron alerts` CLI completo: `write|list|ack|purge|read-unacked` (en `scripts/cockpit/ultron.ps1` líneas 857+)
- ✅ SessionStart hook integration (líneas 194-222 de `~/.ultron/hooks/session-init.ps1`): lee unacked vía Start-Job timeout 4s, inyecta en context.md
- ✅ **`tests/test_alerts.py` (7 KB, 13 tests) — 13/13 PASS** (incluyendo `test_concurrent_writes_no_corruption` con 3 threads × 100 writes, `test_double_ack_is_idempotent`, `test_archive_moves_old_records`)

**Único pendiente (OPCIONAL, no bloquea v13.4.0):**
- [ ] `~/.ultron/scripts/alerts/write-alert.ps1` (helper PowerShell standalone) — `ultron alerts write` ya cubre el caso. Crear solo si surge un caso de uso real (script externo que no quiera invocar `ultron.ps1`).
- [ ] (Cosmético) Migrar 3 deprecation warnings `datetime.utcnow()` → `datetime.now(datetime.UTC)` en `test_alerts.py` líneas 38, 175, 191.

**Estimación real Pilar B: ~0 min implementación, ~5 min cleanup deprecation warnings (opcional)**

#### Pilar A — Silent Execution Audit (REENFOCADO v4.3)

**CONTEXTO CRÍTICO (2026-05-05 validation + Codex peer review):** Los 3 seed alerts (a-2026-05-04-001/002/003) son STALE o MIS-ATRIBUIDOS — TODOS ACK'D EN SESIÓN 343a817b:
- Alert 001 "Parser error línea 192 de session-init.ps1" → línea 192 actual es `Write-Host` válido. Sesión 343a817b inició OK sin el error. Probablemente bug ya fixed o nunca existió en la versión actual del hook.
- Alerts 002+003 "EEXIST mkdir session-env/<id> + plugins/data/*" → confirmado en sesión 343a817b: el error proviene del **Claude Code harness/plugin layer** (no de hooks de ULTRON). session-init.ps1 usa `New-Item -Force` (idempotente). El harness intenta crear `session-env/<sessionId>` y `plugins/data/*` durante invocaciones de tool/plugin sin chequeo previo. **NO se puede arreglar desde ULTRON — es limitación del harness/plugin layer.** (Wording suavizado tras Codex review: "Bash tool itself" era más fuerte que la evidencia disponible).

**DONE criteria:**
- [ ] ✅ **A1 priority RESUELTO** (sesión 343a817b 2026-05-05): los 3 seed alerts ack'd vía `ultron alerts ack`. `read-unacked` devuelve vacío.
- [ ] **A1 doc** (PENDIENTE en S1 ejecución): `docs/silent-execution-policy.md` documenta como limitación conocida: "Claude Code harness/plugin layer emite `EEXIST mkdir 'session-env/<id>'` y `EEXIST mkdir plugins/data/*` durante invocaciones de tool/plugin. Comportamiento del harness, no bug de ULTRON. Si aparece, ignorable. Para trabajo crítico de filesystem, preferir `PowerShell` tool sobre `Bash`."
- [ ] **A1 verificación**: si en futuras sesiones aparece "Parser error línea 192" REAL, capturar transcript completo del hook output (stderr completo) antes de re-abrir alert. Posible causa raíz: variantes regionales de PowerShell donde el carácter en posición 14 de la línea 192 (`Write-Host "[OK] Sess`) se interpreta distinto.

#### Pilar A — silent_exec.py wrapper + audit (SCOPED v4.4)

**Scope ajustado tras Codex review:** NO migrar 75 archivos en bulk (riesgo de regresión, inconsistencia con wrappers existentes como `shared-duet.ps1::Start-Hidden`, `background_tasks.py`, `job_supervisor.py`). En su lugar:

**DONE criteria:**
- [ ] `silent_exec.py` creado en `~/.claude/skills/ultron/scripts/cockpit/`: API mínima `silent_run(cmd, **kwargs)` y `silent_popen(cmd, **kwargs)` que añaden `creationflags=CREATE_NO_WINDOW` + `capture_output=True` automáticamente en Windows
- [ ] `ULTRON_DEBUG=1` env var fuerza `creationflags=0` y `capture_output=False` (debug visible)
- [ ] Doctrina: USAR `silent_exec` en código NUEVO (S2-S5). NO migrar bulk código existente — solo migrar high-traffic scripts oportunísticamente cuando se toquen por otra razón.
- [ ] Audit ligero (no exhaustivo): `audit_silent_exec.py` script que lista hits sospechosos en cockpit/ y hooks/ — output a `~/.ultron/.tmp/silent-audit.json` para revisión manual de USER (no auto-fix)
- [ ] **Acceptance regex usa `rg -P` (PCRE2)** o un script AST Python (`ast.parse` + walk buscando `subprocess.run/Popen` sin `creationflags=`). NO usar negative lookahead en ripgrep default — no funciona.
- [ ] Doc: `docs/silent-execution-policy.md` (~2-3 KB): política, lista de wrappers existentes, cuándo usar `silent_exec` vs alternativas, harness limitation noted.
- [ ] Hookify guardrail (§12.1): rule que warn-on-edit (no bloquea) si scripts ULTRON nuevos contienen `Start-Process` sin `-WindowStyle Hidden` o `subprocess.Popen` sin `creationflags=`

**Estimación real Pilar A: ~60-90 min** (audit script + wrapper + docs, sin migración bulk)

> ⚠️ **NOTA v4.4**: los criterios "exhaustivos" del scope original (inventario completo de cada script, todos los `subprocess.run`/`Start-Process` compliant, test manual de N comandos) quedan FUERA de S1 — son trabajo de "full audit" que se hace con `audit_silent_exec.py` como discovery, luego oportunísticamente migrar high-traffic. Mantenerlos aquí re-expandiría el scope.

#### Verification S1 (v4.4)

- [ ] **`audit_silent_exec.py` GREEN**: ejecutar `uv run python ~/.claude/skills/ultron/scripts/cockpit/audit_silent_exec.py` produce `~/.ultron/.tmp/silent-audit.json` parseable. El JSON es la acceptance artifact — USER decide qué scripts del JSON migrar después (no auto-fix en S1).
- [ ] Si se quiere validar via grep: usar `rg -P "Start-Process(?!.*-WindowStyle Hidden|.*-NoNewWindow)" ~/.ultron/hooks/` (con `-P` PCRE2 explícito; lookahead NO funciona sin `-P`) — pero el script AST es la referencia autoritativa.
- [ ] `uv run pytest tests/test_alerts.py -v` GREEN (regression check tras cualquier cambio)
- [ ] Sesión nueva arranca sin errores en SessionStart hook (`[OK] ULTRON session init - MODE=...` + `Session <id> ready`)
- [ ] `alerts.jsonl` no acumula nuevos warns sin acción (los 3 seed acked el 2026-05-05)

**Peer review:** Codex Dual 1 round (NO MaxDual 3 rounds — overkill para Pilar A scoped) — validar `silent_exec.py` API + `audit_silent_exec.py` cobertura
**Rollback S1:** eliminar `silent_exec.py`, `audit_silent_exec.py`, `docs/silent-execution-policy.md`, hookify rule. `alerts.jsonl` y `alerts.py` se quedan (DONE pre-S1).

---

<a name="s2"></a>
### Sprint 2 — ZTMSI + Intent Dispatcher (UNIFIED)

**Version objetivo:** v13.4.0 → **v13.5.0 "ZTMSI + DISPATCHER"**
**Estimación:** 3-4 subagents (A: ZTMSI Core, B: Dispatcher, C: MMFP + tests)
**Estado:** 📋 ESPECIFICADO — arrancar tras S1 DONE

#### Pre-flight checklist S2
- [ ] S1 DONE + `alerts.jsonl` existe
- [ ] FTS5 check: `python -c "import sqlite3; sqlite3.connect(':memory:').execute('CREATE VIRTUAL TABLE t USING fts5(content)')"` → no error ✅ (verificado 2026-05-04)
- [ ] Backup: `~/.ultron/backups/YYYY-MM-DD-pre-S2/` (settings.json + hooks/*.ps1 + cockpit/*.py)

#### Sub-pilar A — ZTMSI Core (EXTENDER `brain_index.py`, NO crear paralelo)

**⚠️ Cambio v4.5:** El plan v4.4 decía crear `ztmsi_build.py`/`ztmsi_query.py`/`ztmsi_tag.py` como archivos nuevos. Tras audit §13.5 cerrado se confirma que `brain_index.py` (702 líneas, FTS5 BM25, 626 notas, migración idempotente vía `ALTER TABLE … ADD COLUMN`) ya cubre el 80%. Crear archivos paralelos duplicaría schema, build, query, prune. **EXTENDER es la única opción correcta.**

**Propósito:** añadir indexación a nivel párrafo + token estimation a `brain_index.py`. ZTMSI es el nombre conceptual del rol; el archivo sigue siendo `brain_index.py`.

**Schema delta (todo idempotente, mismo patrón que `ALTER TABLE notes ADD COLUMN domain`):**
```sql
-- Nueva tabla virtual paralela a notes_fts (back-compat: notes_fts intacta)
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    content,
    note_id UNINDEXED,        -- back-ref a notes.id
    chunk_idx UNINDEXED,      -- 0..N orden dentro de la nota
    layer UNINDEXED,
    category UNINDEXED,
    domain UNINDEXED,
    token_est UNINDEXED,      -- len(content)//4
    tokenize='unicode61 remove_diacritics 2'
);

-- Migración idempotente sobre notes (token_est a nivel nota completa también)
ALTER TABLE notes ADD COLUMN token_est INTEGER NOT NULL DEFAULT 0;
```

**Splitter (regla de chunk):** dividir por bloques separados por `\n\n`; bloques <50 palabras se concatenan al siguiente; bloques >300 palabras se dividen por subheaders `^##` o por longitud. Encabezado del chunk siempre incluye el último heading visto (contexto).

**DONE criteria:**
- [ ] `brain_index.py build`: además de poblar `notes`/`notes_fts`, construye `chunks_fts` y rellena `notes.token_est`. Si `chunks_fts` existe → idempotente.
- [ ] `brain_index.py update`: actualiza chunks de notas modificadas (DELETE WHERE note_id=? + INSERT). Pasa los tests de incremental.
- [ ] Nueva flag `brain_index.py query "..." --mode chunks --top 5` → retorna top-K chunks con `note_path + chunk_idx + token_est + snippet + bm25` en JSON. Sin la flag (default), comportamiento legacy intacto.
- [ ] `brain_index.py stats` extendido: muestra `total_chunks`, `total_tokens_indexed`, `avg_chunk_tokens`, `avg_chunks_per_note`.
- [ ] `frontmatter_backfill.py` extendido (parte del trabajo S2-A): añade campos `tags`/`token_est`/`layer` al output de frontmatter (si no existen). NO crear `ztmsi_tag.py` nuevo.
- [ ] **Tests** (`tests/test_brain_index_chunks.py` — nuevo):
  - [ ] `test_chunks_full_build` PASS: build sobre 626 notas → ≥1500 chunks (estimado 2-3x notas), 0 errores
  - [ ] `test_chunks_incremental` PASS: modificar 1 nota → solo sus chunks re-indexados, resto unchanged
  - [ ] `test_chunks_query_perf` PASS: query con `--mode chunks` <100ms p50 (10 runs) sobre el set real
  - [ ] `test_chunks_bm25_relevance` PASS: query "ue5 blueprints" → chunks de domain=cpp-ue5 en top-3
  - [ ] `test_token_est_populated` PASS: 100% de notas y chunks tienen `token_est > 0`
  - [ ] `test_back_compat_query` PASS: `query` sin `--mode` retorna mismo formato JSON que pre-extensión (regression)
- [ ] CLI alias `ultron index ...` en `cockpit/ultron.ps1` apunta a `brain_index.py` (build/update/query/stats/inspect). Si ya existe alias → solo añadir `--mode chunks`.
- [ ] SessionStart hook extendido: si `index.db.mtime` > 4h sin update → llamar `brain_index.py update` silencioso (no full rebuild).
- [ ] Backup pre-extensión: copiar `~/.ultron/brain_index/index.db` a `~/.ultron/backups/2026-05-XX-pre-S2/` ANTES del primer build con schema nuevo.

**Sub-gap MOVIDO a S4:** "indexar `skill_manifest.json` como source de triggers/tags" sale de S2-A. Razón: ya existe `L1-skills` (SKILL.md) en discover_sources; el manifest export es trabajo de S4 (Skills Manifest). En S2 no hay valor inmediato.

**Archivos S2-A (post-audit v4.5):**
- **Modify:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\brain_index.py` — añadir `chunks_fts` schema + splitter + `--mode chunks` flag + token_est columns
- **Modify:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\frontmatter_backfill.py` — añadir campos `tags`/`token_est`/`layer`
- **Modify:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\ultron.ps1` — añadir alias `index` (si no existe) con flag `--mode chunks`
- **Modify:** `C:\Users\USER\.ultron\hooks\session-init.ps1` — añadir staleness check >4h
- **Create:** `C:\Users\USER\.claude\skills\ultron\tests\test_brain_index_chunks.py` (6 tests)
- **Create:** `C:\Users\USER\.ultron\docs\brain-index-chunks.md` (~2 KB: schema delta, splitter rules, query modes)
- **NO crear:** ~~`ztmsi_build.py`, `ztmsi_query.py`, `ztmsi_tag.py`, `~/.ultron/index/ztmsi.fts.db`~~ (eliminado de v4.4 — duplicaría brain_index.py)

**Estimación S2-A revisada:** ~3h (vs ~4h v4.4 §13.5, ~8h en v4.3 antes de audit). Despachable como **subagent único compacto** en una sesión, NO requiere split.

#### Sub-pilar B — Intent Dispatcher

**Propósito:** hook UserPromptSubmit que clasifica intent usando ZTMSI + manifest cache. Output: note inyectada al contexto antes de que Claude vea el prompt.

**Pipeline de clasificación (secuencial, short-circuit):**
```
1. ¿Prompt empieza con /comando?
   → route directo, confidence=1.0, skip todo lo demás

2. ¿Match en intent-rules.yaml (keyword exact-match)?
   → route con confidence=0.95, skip ZTMSI

3. ZTMSI query(prompt, top=5)
   + manifest.cache.json lookup(top_skills)
   → route con confidence basada en score BM25

4. ¿Ningún match confianza ≥0.70?
   → no-route, ULTRON MEDIUM default
```

**Output formato (inyectado como env var o stdin prefix — NO en el prompt del usuario):**
```
[ULTRON·94%] skill=superpowers:systematic-debugging | ctx=~/.ultron/memory/L1/ue5-state.md (340tok) | via=ztmsi
```

**DONE criteria:**
- [ ] `intent-dispatcher.py` instalado en `settings.json` como UserPromptSubmit hook
- [ ] Encadenado DESPUÉS de `mode-trigger.py` (mode-trigger primero → intent-dispatcher segundo)
- [ ] `intent-rules.yaml` contiene los 8 patrones canónicos (ver abajo)
- [ ] `manifest.cache.json` mock creado con 15+ skills y sus triggers (real en S4)
- [ ] `uv run pytest test_intent_dispatcher.py::test_8_canonical_prompts` PASS:
  - "corrígeme este bug en X" → `superpowers:systematic-debugging`
  - "diseña la arquitectura de Y" → `agent-skills:plan` + sugiere ULTRA mode
  - "cómo va el proyecto Nexus" → L1 projects-active.md loaded
  - "revísame este código" → `superpowers:requesting-code-review`
  - "haz tests para Z" → `superpowers:test-driven-development`
  - "crea un skill de A" → `skill-creator:skill-creator`
  - "investiga B en internet" → `Agent(Explore)` + WebSearch
  - "qué decidimos sobre C" → L2 `brain_index.py query "C"`
- [ ] `uv run pytest test_intent_dispatcher.py::test_fallback_graceful` PASS: si dispatcher crashea → prompt pasa sin modificación
- [ ] `uv run pytest test_intent_dispatcher.py::test_no_route_override` PASS: `/no-route test` → no dispatch
- [ ] `uv run pytest test_intent_dispatcher.py::test_performance` PASS: 100 prompts en <5000ms total (<50ms/prompt)
- [ ] Telemetry: cada dispatch → `~/.ultron/telemetry/dispatcher-events.jsonl`
- [ ] Confidence <0.70 → no-route (no forzar skill incorrecta)
- [ ] Confidence 0.70-0.85 → inject con nota "señal parcial"

**Archivos S2-B:**
- **Create:** `C:\Users\USER\.claude\skills\ultron\hooks\intent-dispatcher.py`
- **Create:** `C:\Users\USER\.ultron\config\intent-rules.yaml`
- **Create:** `C:\Users\USER\.ultron\manifest.cache.json` (mock para S2)
- **Modify:** `C:\Users\USER\.claude\settings.json` (add UserPromptSubmit: intent-dispatcher.py)
- **Create:** `C:\Users\USER\.claude\skills\ultron\tests\test_intent_dispatcher.py`

#### Sub-pilar C — MMFP Bootstrap

**Propósito:** infraestructura para conversaciones multi-modelo persistentes en archivos.

**DONE criteria:**
- [ ] `~/.ultron/multimodel/requests/`, `responses/`, `consensus/`, `archive/` creados
- [ ] README con schema YAML de request documentado
- [ ] `shared-duet.ps1` acepta flag `--async`: escribe request a MMFP en lugar de invocar inline
- [ ] Template `req-template.yaml` con todos los campos documentados
- [ ] Gemini Flash añadido como opción en `--models` (valor: `gemini-flash`)
- [ ] `ultron multimodel list` muestra requests pendientes (sin response)
- [ ] `ultron multimodel archive --older-than 7d` archiva conversaciones cerradas

**Archivos S2-C:**
- **Create:** `C:\Users\USER\.ultron\multimodel\` (estructura + README)
- **Modify:** `C:\Users\USER\.claude\skills\ultron\scripts\shared-duet.ps1` (add --async + gemini-flash)
- **Modify:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\ultron.ps1` (add `multimodel` subcommand)

**Peer review S2:** MaxTriple (Codex + Gemini Pro + Gemini Flash, 5 rounds via MMFP) — usar el propio MMFP por primera vez para reviewar S2. Validar: (a) FTS5 BM25 es suficiente vs embeddings, (b) dispatcher pipeline no tiene race conditions, (c) MMFP schema cubre casos de uso.

**Rollback S2:** eliminar `~/.ultron/index/`, remover intent-dispatcher.py de settings.json, eliminar `multimodel/`, revertir session-init.ps1 desde backup

---

<a name="s3"></a>
### Sprint 3 — 3-Layer Memory + Chunked Index

**Version objetivo:** v13.5.0 → **v13.6.0 "LAYERED MEMORY"**
**Estimación:** 2 subagents (A: L0 + token enforcement, B: L1/L2 + context packets)
**Estado:** 📋 ESPECIFICADO — requiere S2 DONE

#### Pre-flight checklist S3
- [ ] S2 DONE + `brain_index.py query --mode chunks` benchmark <100ms ✅
- [ ] `intent-dispatcher.py` funcionando (E2 criterion measurable)
- [ ] Backup: `~/.ultron/backups/YYYY-MM-DD-pre-S3/`

#### Sub-pilar A — L0 Pinned + Token Enforcement

**DONE criteria:**
- [ ] `generate_L0.py` crea `~/.ultron/.tmp/L0-pinned.md` con estructura:
  ```
  # ULTRON L0 [2026-05-04T21:00]
  👤 USER · Ing. Programación + PROGRAM_A · Stack: C++/UE5/C#/Unity/TS/Python
  🎯 Foco: [leído de ~/.ultron/memory/focus.json si existe]
  🚨 BLOCKING: [de alerts.jsonl unacked severity=blocking]
  ⚡ Modo: MEDIUM
  ```
- [ ] `token_budget.py`:
  - [ ] `measure(content: str) → int` (len//4, fast)
  - [ ] `enforce(content: str, limit: int, priority_prefix: str = None) → str` (trunca preservando priority_prefix)
  - [ ] `log(layer: str, tokens: int, limit: int)` → escribe a `~/.ultron/.tmp/token-usage.jsonl`
- [ ] `generate_L0.py` usa `token_budget.enforce(content, 200, "[BLOCKING]")`
- [ ] Test: L0 con 5 BLOCKING items → 200 tok exactos, BLOCKING items preservados, resto truncado
- [ ] Test: L0 sin blocking → ≤200 tok, contenido completo
- [ ] SessionStart hook llama `generate_L0.py` después de ZTMSI rebuild (orden: 1-ZTMSI, 2-L0, 3-alerts inject)
- [ ] `ultron focus set "Proyecto X — task Y"` → escribe `focus.json` → L0 refleja en siguiente sesión

#### Sub-pilar B — L1/L2 + Context Packets

**DONE criteria:**
- [ ] 4 archivos L1 creados con KTP frontmatter:
  - [ ] `~/.ultron/memory/L1/projects-active.md` (`tags: [project, active, status, nexus, bildyapp]`)
  - [ ] `~/.ultron/memory/L1/recent-decisions.md` (`tags: [decisions, history, sessions, architecture]`)
  - [ ] `~/.ultron/memory/L1/skills-routing.md` (`tags: [skills, routing, manifest, dispatch]`)
  - [ ] `~/.ultron/memory/L1/system-state.md` (`tags: [system, version, hooks, plugins, health]`)
- [ ] `context_packet_builder.py`:
  - [ ] `build(query: str, layer: str, max_tokens: int = 600) → str`
  - [ ] Llama `brain_index.py query --mode chunks`, toma top-K chunks que sumen ≤max_tokens
  - [ ] Formatea como bloque colapsado: `[CTX·L1·projects·340tok] ...contenido...`
  - [ ] Nunca retorna más de max_tokens (usa `token_budget.enforce`)
- [ ] Dispatcher (S2) extendido: además de skill suggestion, inyecta context packet de L1 relevante
- [ ] Test: prompt "cómo va Nexus" → context packet de `projects-active.md` en <600 tok
- [ ] Test: prompt "qué decidimos sobre el dispatcher" → context packet de `recent-decisions.md`
- [ ] Test: prompt sin match conocido → solo L0 (0 L1 cargado)
- [ ] L2 gate: solo accesible con `/deep` prefix o confidence dispatcher ≥0.90
- [ ] `brain_index.py query` (default sin `--mode chunks`) mantiene exactamente el formato JSON pre-S2 (back-compat con scripts legacy)
- [ ] Token log al final de cada sesión (Stop hook): "L0=145 L1=420 L2=0 total=565/1500tok"
- [ ] Documentación: `~/.ultron/docs/memory-layers.md` con diagrama, políticas, budgets

**Archivos S3:**
- **Create:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\generate_L0.py`
- **Create:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\token_budget.py`
- **Create:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\context_packet_builder.py`
- **Create:** `C:\Users\USER\.ultron\memory\L1\projects-active.md` (+ KTP frontmatter)
- **Create:** `C:\Users\USER\.ultron\memory\L1\recent-decisions.md`
- **Create:** `C:\Users\USER\.ultron\memory\L1\skills-routing.md`
- **Create:** `C:\Users\USER\.ultron\memory\L1\system-state.md`
- **Modify:** `C:\Users\USER\.ultron\hooks\session-init.ps1` (add L0 gen step, fix order)
- **Modify:** `C:\Users\USER\.ultron\hooks\stop-memory-sync.ps1` (add token usage log)
- **Modify:** `C:\Users\USER\.claude\skills\ultron\hooks\intent-dispatcher.py` (add context packet injection)
- **Create:** `C:\Users\USER\.ultron\docs\memory-layers.md`

**Peer review S3:** MaxDual (Codex, 3 rounds) — validar token enforcement no trunca contenido crítico

---

<a name="s4"></a>
### Sprint 4 — Skills Manifest + Script-Only Sync

**Version objetivo:** v13.6.0 → **v13.7.0 "MANIFEST"**
**Estimación:** 1-2 subagents
**Estado:** 📋 ESPECIFICADO — requiere S2 DONE (schema definido)

#### Pre-flight checklist S4
- [ ] S2 DONE + manifest.cache.json schema acordado
- [ ] Backup: `~/.ultron/backups/YYYY-MM-DD-pre-S4/`

**DONE criteria:**
- [ ] `skills.manifest.yaml` generado en `~/.ultron/skills.manifest.yaml` con schema:
  ```yaml
  - name: superpowers:systematic-debugging
    source: plugin                          # built-in|plugin|mcp|persona|hookify
    triggers: [bug, error, no funciona]     # también indexado en ZTMSI
    tags: [debugging, error-recovery]       # KTP tags
    cost_tier: medium                       # low|medium|high|ultra
    dispatcher_priority: 2                  # 1-5
    deprecated: false
    replaces: []
    last_used: 2026-05-04
    last_synced: 2026-05-04
  ```
- [ ] `registry_sync.py --auto-discover`:
  - [ ] Escanea `~/.claude/skills/*/SKILL.md` buscando frontmatter KTP
  - [ ] Skills nuevas con frontmatter → añadidas al manifest (source: auto-discover)
  - [ ] Skills en manifest sin correspondencia en disco → `deprecated: true` automático
  - [ ] 0 tokens consumidos: pure Python file scanning
  - [ ] Report en `~/.ultron/telemetry/sync-events.jsonl`
- [ ] `manifest.cache.json` (usado por dispatcher) regenerado al final de cada `ultron manifest sync`
- [ ] `ultron manifest validate` → drift report (no auto-fix)
- [ ] `ultron manifest add <skill> --source <X>` → añade al manifest
- [ ] `ultron manifest deprecate <skill>` → marca deprecated
- [ ] `ultron manifest sync` → auto-discover + rebuild cache + report
- [ ] `ultron manifest list [--deprecated] [--source plugin]` → tabla legible
- [ ] `ultron sync` (existente) extendido: incluye `registry_sync.py --auto-discover`
- [ ] JSON Schema `~/.ultron/config/skills-manifest-schema.json` definido y validado
- [ ] Test E5: crear skill nueva con KTP frontmatter → `ultron manifest sync` → aparece en manifest → 0 tokens Claude
- [ ] Documentación: `~/.ultron/docs/skills-manifest-schema.md`

**Archivos S4:**
- **Create:** `C:\Users\USER\.ultron\skills.manifest.yaml`
- **Create:** `C:\Users\USER\.ultron\config\skills-manifest-schema.json`
- **Modify:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\registry_sync.py` (add --auto-discover)
- **Modify:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\ultron.ps1` (add manifest + extend sync subcommand)
- **Create:** `C:\Users\USER\.ultron\docs\skills-manifest-schema.md`

**Peer review S4:** MaxDual (Codex, 2 rounds) — validar JSON Schema + auto-discover edge cases

---

<a name="s5"></a>
### Sprint 5 — Doctor v2 + MCP Resilience + Token Enforcement Audit

**Version objetivo:** v13.7.0 → **v14.0.0 "GENESIS" (RELEASE)**
**Estimación:** 2 subagents (A: MCP resilience, B: doctor CLI)
**Estado:** 📋 ESPECIFICADO — requiere S3 + S4 DONE

#### Pre-flight checklist S5
- [ ] S3 DONE (token_budget.py disponible)
- [ ] S4 DONE (skills.manifest.yaml como SSOT)
- [ ] Backup: `~/.ultron/backups/YYYY-MM-DD-pre-S5/`

#### Sub-pilar A — MCP Resilience

**DONE criteria:**
- [ ] `mcp-fallbacks.yaml` creado con entries para todos los MCPs en settings.json:
  - Campos: `mcp_name`, `fallback_message`, `alert_severity`, `fallback_skill` (opcional)
- [ ] `mcp_health_check.py`:
  - [ ] Lee MCPs de settings.json
  - [ ] Pings cada MCP (test call con timeout 3s)
  - [ ] Escribe `~/.ultron/.tmp/mcp-health.json`: `{"github": "ok", "supabase": "degraded", ...}`
  - [ ] Si degraded → escribe alert a `alerts.jsonl` con severity de `mcp-fallbacks.yaml`
  - [ ] Silent: 0 output si todo OK; solo log si hay degraded
- [ ] `mcp-resilience.py` hook PreToolUse:
  - [ ] Detecta si la tool es de un MCP marcado "degraded" en `mcp-health.json`
  - [ ] Si degraded → inyecta nota: `[MCP DEGRADED: github — use gh CLI directly]`
  - [ ] No bloquea el tool call — Claude puede intentarlo de todas formas con contexto
- [ ] SessionStart hook: llama `mcp_health_check.py` async (no bloquea sesión)
- [ ] `ultron doctor --health-check` incluye MCP status en reporte

#### Sub-pilar B — Doctor CLI v2

**DONE criteria (detecciones implementadas):**
- [ ] `ultron doctor` → reporte completo sin cambios
- [ ] `ultron doctor --fix` → propone cada cambio individualmente, requiere confirmación
- [ ] `ultron doctor --dry-run` → solo reporte, nunca escribe
- [ ] `ultron doctor --json` → output machine-readable
- [ ] `ultron doctor --health-check` → MCP health + ZTMSI health + L0 staleness
- [ ] **Detecciones implementadas:**
  - [ ] Orphan paths en `~/.ultron/` sin referencia en scripts activos
  - [ ] Skills/plugins instalados pero ausentes de manifest
  - [ ] Skills en manifest `deprecated: false` pero no instaladas
  - [ ] Scripts en hooks `settings.json` cuyo archivo no existe en disco
  - [ ] L0 stale (>4h sin regenerar)
  - [ ] ZTMSI stale (>4h sin rebuild)
  - [ ] Session logs >30 días
  - [ ] Backup snapshots >90 días
  - [ ] Telemetry >180 días
  - [ ] Alerts unacked `blocking` >24h
  - [ ] `alerts.jsonl` >10MB → sugiere purge
  - [ ] ULTRON token overhead >1,500 tok (token audit)
- [ ] `doctor-rules.yaml`: retention policies configurables
- [ ] `uv run pytest test_doctor.py` PASS: synthetic cases para cada detección
- [ ] Auto-doctor opt-in: `auto_doctor: true` en config → weekly scan en Stop hook silencioso

**Archivos S5:**
- **Create:** `C:\Users\USER\.ultron\config\mcp-fallbacks.yaml`
- **Create:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\mcp_health_check.py`
- **Create:** `C:\Users\USER\.claude\skills\ultron\hooks\mcp-resilience.py`
- **Create:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\doctor.py`
- **Create:** `C:\Users\USER\.ultron\config\doctor-rules.yaml`
- **Create:** `C:\Users\USER\.claude\skills\ultron\tests\test_doctor.py`
- **Modify:** `C:\Users\USER\.claude\settings.json` (add PreToolUse: mcp-resilience.py)
- **Modify:** `C:\Users\USER\.ultron\hooks\session-init.ps1` (add async mcp health check)
- **Modify:** `C:\Users\USER\.ultron\hooks\stop-memory-sync.ps1` (add auto-doctor opt-in)
- **Modify:** `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\ultron.ps1` (add doctor + health-check subcommands)

**Verificación criterios E1-E5 antes de tag v14.0.0:**
- [ ] **E1 PASS:** `ultron doctor --token-audit` reporta ≤1,500 tok always-on overhead
- [ ] **E2 PASS:** 10 sesiones · dispatcher correcto en ≥8
- [ ] **E3 PASS:** `brain_index.py query --mode chunks` benchmark <100ms
- [ ] **E4 PASS:** `ultron doctor --health-check` → 0 MCPs en hard fail sin handling
- [ ] **E5 PASS:** skill nueva auto-registrada con 0 tokens Claude

**Peer review S5:** MaxDual (Codex, 3 rounds) — validar doctor --fix no borra sin confirmación + MCP resilience no bloquea tools

**Rollback S5:** revertir settings.json (quitar mcp-resilience hook), stop-memory-sync.ps1 desde backup

**Version tag:** `git tag v14.0.0 -m "ULTRON v14.0.0 GENESIS"` (en `~/.claude/skills/ultron/` si hay git)

---

<a name="s6"></a>
### Sprint 6 — Public Portfolio Repo (post-release)

**Version objetivo:** v14.0.0 → **v14.1.0 "PORTFOLIO"**
**Pre-requisito estricto:** E1-E5 todos PASS + v14.0.0 estable en ≥2 semanas de uso real
**Estimación:** 1-2 subagents
**Estado:** 📋 ESPECIFICADO — NO arrancar hasta v14.0.0 estable

**No se detalla aquí** por excesiva distancia temporal. Referencia: plan v2 Sprint 6 completo en `2026-05-04-ultron-v14-overhaul-master.md`. Los cambios de v3 sobre ese plan:
- ZTMSI schema y KTP protocol incluidos como showcase técnico principal
- MMFP documentado como "Multi-Model Review Pattern" para portfolio
- Test: `test_publish_sanitize.py` incluye check: 0 archivos `.fts.db` en output
- Ejemplos sanitizados de `manifest.cache.json` e `intent-rules.yaml` publicados

---

<a name="7"></a>
## 7. PROTOCOLOS TRANSVERSALES

### 7.1 Keyword Tagging Protocol (KTP) — vigente desde S2

**Todo archivo nuevo** en el ecosistema ULTRON incluye este frontmatter:

```yaml
---
tags: [keyword1, keyword2, keyword3]    # OBLIGATORIO
type: memory                            # OBLIGATORIO: memory|skill|knowledge|project|decision
last_updated: 2026-05-04               # OBLIGATORIO
topics: [domain1, domain2]             # opcional: dominio semántico
priority: high                          # opcional: pinned|high|medium|low|deprecated
layer: L1                               # opcional: L0|L1|L2|vault
token_est: 340                          # NO escribir manualmente — generado por brain_index.py build
---
```

**Reglas:**
- `token_est` es calculado por `brain_index.py build` (rellena la columna `notes.token_est`), no por humanos ni por Claude
- `deprecated: true` en frontmatter → excluido del índice activo, archivado para historial
- Archivos sin frontmatter → `ultron doctor` los lista → `frontmatter_backfill.py` los procesa con campos KTP
- Scripts creados por ULTRON (cockpit, hooks) usan `frontmatter_backfill.py` para auto-generar frontmatter KTP al crear archivos nuevos

### 7.2 Multi-Model File Protocol (MMFP) — vigente desde S2

**Request schema:**
```yaml
# ~/.ultron/multimodel/requests/req-YYYYMMDD-NNN.yaml
id: req-20260504-001
session_id: <session hash>
topic: "<descripción 1 línea>"
question: |
  <pregunta detallada para los modelos>
context_files:
  - path: <absolute path>
    reason: "<por qué este archivo es relevante>"
models: [codex, gemini-pro, gemini-flash]
rounds: 3                  # para codex
priority: critical         # critical|standard|quick
created: 2026-05-04T21:00Z
status: pending            # pending|in-progress|consensus-written|archived
```

**Response schema:**
```yaml
# ~/.ultron/multimodel/responses/req-20260504-001-codex.yaml
request_id: req-20260504-001
model: codex
round: 1
assessment: pass|fail|conditional
confidence: 0.85
findings:
  - severity: critical|warning|info
    description: "<descripción>"
    suggestion: "<sugerencia concreta>"
responded: 2026-05-04T21:05Z
```

**Cuándo usar MMFP:**
- Toda decisión marcada como `priority: critical` en los sprints (S2 en adelante)
- Cualquier cambio a `settings.json` (hooks), arquitectura de índice, o schema de datos
- Code review de módulos con tests (ztmsi_build, dispatcher, doctor)

**Cuándo NO usar MMFP:**
- Tasks rutinarias (crear L1 files, escribir docs)
- Fixes de bugs confirmados con test failing → test passing
- Refactors con cobertura de tests existente

**⚠️ S1 NO usa MMFP (catch-22 evitado v4.3):** la infraestructura MMFP nace en S2-C. Para peer review de S1 usar `~/.claude/skills/ultron/scripts/shared-duet.ps1` directo (modo inline, sin `--async`). MMFP entra a partir de S2 incluido.

**Tercer modelo — Gemini Flash:**
- Rol: fast validator — detecta bugs obvios, inconsistencias de schema, errores triviales
- Cuándo: SIEMPRE como primer paso en critical reviews (antes de Codex/Gemini Pro)
- Costo: mínimo (flash). Si Gemini Flash da GREEN → proceder con Codex
- Si Gemini Flash da RED → arreglar antes de gastar Codex rounds

### 7.3 Token Budget Policy

| Capa | Hard limit | Enforcer | Acción si excede |
|------|-----------|----------|-----------------|
| L0 pinned | 200 tok | `token_budget.enforce` en `generate_L0.py` | Trunca, preserva `[BLOCKING]` |
| L1 context packet | 600 tok | `context_packet_builder.py` | Reduce top-K chunks |
| L2 query result | 500 tok | `brain_index.py query --mode chunks` | Reduce top-K |
| manifest cache inyectado | 500 tok | `registry_sync.py` | Split en múltiples lookups |
| ULTRON always-on total | 1,500 tok | `ultron doctor --token-audit` | Alert + warning |

### 7.4 Rollback Protocol (por sprint)

Antes de arrancar cada sprint:
1. `mkdir ~/.ultron/backups/YYYY-MM-DD-pre-SN/`
2. Copiar: `settings.json`, archivos a modificar, tarball de directorios a crear
3. Crear `rollback.ps1` en ese directorio con los pasos inversos exactos

Si sprint falla después de commit:
1. Ejecutar `rollback.ps1` del sprint
2. Verificar sesión arranca sin errores
3. Documentar qué falló en `~/.ultron/telemetry/v14-overhaul/sprint-N-rollback.md`
4. Revisar causa raíz antes de reintentar

### 7.5 Pre-flight Checklist Universal (antes de CUALQUIER sprint)

```
□ 0. **OBLIGATORIO: Leer §13 (auditoría de existente) + ejecutar verificación en disco:**
     - ls ~/.claude/skills/ultron/scripts/cockpit/  (inventario actual)
     - ls ~/.ultron/hooks/  (hooks PS actuales)
     - cat ~/.ultron/alerts.jsonl  (estado actual del alerts bus)
     - Para cada componente "a crear" en sprint spec: grep cockpit/ buscando si ya existe.
     Si ya existe: leer 60 primeras líneas (docstring) → decidir extender vs crear.
□ 1. Leer §0 (tres pilares) + §7 (protocolos) + sprint spec completa antes de escribir código
□ 2. Verificar pre-condiciones del sprint (tabla §5.3)
□ 3. Crear backup (§7.4) + generar rollback.ps1 ANTES de empezar (no after-the-fact)
□ 4. Confirmar: ¿qué NO tocar? (No-Touch List §10.3)
□ 5. Despachar en subagents ≤2h cada uno (token budget)
□ 6. Peer review al cierre (S1: shared-duet.ps1 directo · S2+: MMFP) antes de version bump
□ 7. Version bump SOLO después de peer review GREEN
```

---

<a name="8"></a>
## 8. REGISTRO DE DECISIONES ARQUITECTÓNICAS (ADR)

### ADR-001: SQLite FTS5 en lugar de embeddings vectoriales

**Decisión:** ZTMSI usa BM25 sobre FTS5, no vectores semánticos.

**Alternativas consideradas:**
- Embeddings OpenAI/Gemini: requieren API call por cada rebuild + cada query → tokens, latencia, costo
- FAISS local: sin API calls pero requiere modelo local de embedding, setup complejo
- Whoosh: pure Python FTS5 alternativo, pero SQLite FTS5 ya existe en brain_index.py

**Razón:** FTS5 está disponible en stdlib Python (sqlite3), brain_index.py ya lo usa (conocido), 0 tokens, 0 API calls, funciona offline, <50ms para 600 archivos. Calidad de resultados: suficiente para routing por keywords. Si en el futuro hay necesidad de semántica, puede añadirse como capa separada sobre los mismos chunks.

**Trade-off aceptado:** BM25 no entiende sinónimos ni contexto semántico. Mitigación: KTP tags manuales compensan — el autor del archivo decide los keywords relevantes.

---

### ADR-002: Dispatcher como hook UserPromptSubmit, no como skill invocada

**Decisión:** El dispatcher corre como hook automático en cada prompt.

**Alternativas consideradas:**
- Dispatcher como skill invocada manualmente: requiere que USER lo active → no resuelve el problema de auto-activación
- Dispatcher como wrapper del modelo: demasiado invasivo, rompe flujo vanilla

**Razón:** UserPromptSubmit es el único lugar donde podemos interceptar el prompt antes de que Claude lo vea, inyectar contexto, y no gastar tokens del modelo en la clasificación.

**Trade-off aceptado:** El hook corre en CADA prompt aunque no haya routing que hacer. Mitigación: short-circuit en step 1 (slash commands → 0 ZTMSI cost), max overhead <50ms incluso en worst case.

---

### ADR-003: File-based MMFP en lugar de API inline

**Decisión:** Conversaciones multi-modelo se persisten en archivos YAML, no se invocan inline.

**Alternativas consideradas:**
- Inline: `shared-duet.ps1` existente, más simple
- API directa: bloquea la sesión, desaparece al cerrar

**Razón:** Persistencia entre sesiones — si una review se interrumpe por tokens, la continuamos en otra sesión. Auditabilidad — historial completo de qué decidió cada modelo. Async — Claude puede escribir el request, hacer otra cosa, y leer la respuesta cuando esté lista.

**Trade-off aceptado:** Más complejo de implementar. Mitigación: modo inline sigue disponible en `shared-duet.ps1` sin `--async`, MMFP es opt-in para critical reviews.

---

### ADR-004: Gemini Flash como tercer validador, no Claude Haiku

**Decisión:** El tercer modelo de validación es Gemini Flash (ya disponible via MCP existente).

**Alternativas consideradas:**
- Claude Haiku: mismo proveedor, mismo billing, muy rápido
- o3-mini: mejor razonamiento pero requiere nueva API key + costos adicionales

**Razón:** Gemini Flash está disponible en el MCP Gemini existente — cero setup adicional, cero nueva auth. El valor del tercer modelo es "fast sanity check before spending expensive rounds" — Gemini Flash cumple eso.

**Trade-off aceptado:** Gemini Flash puede tener sesgos distintos a Codex (ambos vs Gemini Pro) — el objetivo del tercer modelo no es desempatar sino detectar errores obvios que ambos podrían pasar por alto.

---

### ADR-007: Aceptar subprocess startup overhead en hooks UserPromptSubmit (v4.6, 2026-05-05)

**Decisión:** S2-B `intent-dispatcher.py` se instala como hook subprocess directo (`python.exe hook.py < stdin.json`), aceptando ~80ms de OS-level Python startup en Windows. NO se construye un daemon persistente para amortizar el startup.

**Alternativas consideradas:**
- **Daemon persistente (descartada para S2-B):** un proceso Python long-running que recibe peticiones via socket/named-pipe y responde en ~3-5ms. Resuelve el overhead pero introduce: lifecycle management (start/stop/restart), race con Claude Code startup, file-locking de manifest cache, IPC robusto, restart-on-update logic. Trabajo estimado: 8-12h, complejidad operacional alta.
- **Compiled binary hook (Go/Rust):** elimina Python startup pero rompe el patrón único de Python en el codebase. Fricción de tooling alta.
- **Subprocess directo (elegido):** patrón existente (mode-trigger.py ya lo usa), zero ops complexity, deuda técnica visible y medida.

**Razón:** Las prioridades declaradas por USER (sesión de9440c3, 2026-05-05) son **potencia/capacidad sobre latencia**. Un overhead de ~160ms con dos hooks (mode-trigger + intent-dispatcher) es perceptible (>100ms) pero NO afecta a las **capabilities** del sistema — solo añade un retraso constante antes de cada respuesta. El daemon mejoraría latencia pero NO mejoraría las capacidades del routing, manifest, telemetry, etc. Construirlo ahora sería resolver un problema secundario antes de tiempo.

**Trade-off aceptado y medido:**
- Hook internal latency: <30ms p95 (cumple spec del dispatcher)
- Subprocess wall-clock latency: ~80-120ms p95 (overhead Python+OS startup)
- Total per-prompt overhead: ~80-160ms (dos hooks UserPromptSubmit)
- Test split refleja realidad: `test_performance_internal_latency` (estricto, 30ms) + `test_performance_subprocess_e2e` (calibrado a OS, 12s/100 prompts en Windows)

**Cuándo re-evaluar (criterios disparadores):**
1. **Si en S5+ hay ≥3 hooks UserPromptSubmit** (intent-dispatcher + mode-trigger + nuevo de token enforcement): el overhead total supera ~240ms → revisar daemon como parte de S5 "doctor v2 + token enforcement"
2. **Si emerge razón funcional** (no de latencia): shared state entre hooks, hot-reload de manifest, in-memory caching cross-hook → daemon pasa a tener valor que justifica complejidad
3. **Si USER cambia prioridad** y empieza a sentir el overhead como blocker para experimentar rápido

**Implicaciones para sprints posteriores:**
- S3 (3-Layer Memory): hooks adicionales evaluados con este coste en mente
- S5 (doctor v2): el doctor debe medir overhead acumulado de hooks y warning si excede umbrales
- Daemon refactor candidato natural cuando S5 añada token enforcement (3er hook)

---

### ADR-006: ZTMSI extiende `brain_index.py`, no archivo paralelo (v4.5, 2026-05-05)

**Decisión:** S2 Sub-pilar A añade `chunks_fts` table + `token_est` columns + flag `--mode chunks` directamente en `brain_index.py`. NO se crean `ztmsi_build.py`/`ztmsi_query.py`/`ztmsi_tag.py` paralelos.

**Alternativas consideradas:**
- Archivos paralelos (plan v4.4 original): namespace limpio, ZTMSI como módulo separado
- Reescritura completa: oportunidad de schema más estructurado desde cero
- **EXTENDER (elegido):** una sola fuente de verdad, migración idempotente

**Razón:** El audit §13.5 (cerrado 2026-05-05) verificó que `brain_index.py` ya implementa el 80% de ZTMSI: FTS5 con tokenizer correcto para español, schema con migración idempotente probada (`ADD COLUMN domain`), build full + incremental, query BM25, prune self-healing, WAL+read-only conn. Crear archivos paralelos duplicaría schema, build pipeline, prune logic, decay state preservation. Cada feature nueva requeriría mantenimiento doble.

**Trade-off aceptado:** `brain_index.py` crece (702 → ~900 líneas estimado). Mitigación: módulos auxiliares (`brain_chunks.py` para splitter, si crece demasiado) pueden extraerse cuando supere 1000 líneas, pero la entry point sigue siendo única.

**Implicaciones para sprints posteriores:**
- S3 context_packet_builder.py llama `brain_index.py query --mode chunks` (no a un módulo nuevo)
- S4 manifest export puede usar `brain_index.py` para indexar manifest.cache.json si surge necesidad
- S5 doctor verifica health de `brain_index.py` y su DB (un solo subsistema, no dos)

---

### ADR-005: Script-only skill sync sin confirmación de Claude

**Decisión:** Skills nuevas con KTP frontmatter se auto-registran en el manifest sin que Claude intervenga.

**Alternativas consideradas:**
- Claude confirma cada skill nueva: más control pero más tokens
- Registry scan manual: USER ejecuta cuando quiere

**Razón:** El problema raíz de la escalabilidad es que añadir una skill requiere editar múltiples archivos. Si la skill lleva su propio frontmatter, el script puede registrarla de forma determinista y verificable sin AI.

**Trade-off aceptado:** Si el frontmatter tiene un error tipográfico, se registra mal. Mitigación: JSON Schema validation en cada sync + `ultron manifest validate` para verificar.

---

<a name="9"></a>
## 9. REGISTRO DE RIESGOS (CONSOLIDADO)

Riesgos agrupados por severidad. Solo CRITICAL y HIGH documentados aquí; MEDIUM/LOW en specs de sprint.

### CRITICAL

| ID | Riesgo | Sprint | Mitigación |
|----|--------|--------|------------|
| R01 | Dispatcher misclassifica en >20% → USER se frustra más que con vanilla | S2 | Confidence threshold ≥0.70 (no-route si duda), bypass `/no-route`, telemetry para tuning continuo, E2 criterion como gate antes de release |
| R02 | Hook dispatcher crashea → bloquea TODOS los prompts | S2 | try/except global → passthrough sin modificar prompt, error loggeado en `alerts.jsonl`, sesión continúa sin routing |
| R03 | Publish sanitization falla → API key o PII en repo público | S6 | Tests bloqueantes (0 hits en grep), repo privado primero, review manual antes de flip-público |
| R04 | ZTMSI rebuild corrompe DB → Claude no tiene contexto | S2 | Build en DB temporal, swap atómico al finalizar; backup de DB en cada rebuild full |

### HIGH

| ID | Riesgo | Sprint | Mitigación |
|----|--------|--------|------------|
| R05 | FTS5 no disponible en SQLite Windows | S2 | Pre-verificado: OK (3.50.4). Fallback documentado: LIKE queries si FTS5 falla en prod |
| R06 | Token overhead excede 1,500 tok → E1 falla | S3 | `token_budget.enforce` es hard truncate (no soft warning), medido en test antes de release |
| R07 | `ultron doctor --fix` borra algo activo | S5 | Whitelist explícita en `doctor-rules.yaml`, `--confirm` por defecto en cada acción, `--dry-run` always available |
| R08 | MMFP requests se acumulan → directorio crece | S2 | Auto-archive >7d (vía `ultron multimodel archive`), doctor reporta >50 pending requests |
| R09 | S2 consume todo el token budget antes de DONE | S2 | Split en 3 subagents (A: ZTMSI, B: Dispatcher, C: MMFP+tests) cada uno ≤2h estimado |
| **R10** | Errores del harness Claude Code mis-atribuidos a hooks ULTRON → trabajo perdido "arreglando" cosas que no son nuestras | S1+ | Antes de fix: capturar transcript completo del error, reproducir, trazar al script real. EEXIST `mkdir session-env/<id>` confirmado como harness, no ULTRON (2026-05-05) |
| **R11** | Sub-agent ignora §13 y reimplementa scripts existentes (alerts.py, brain_index.py, skill_manifest.py, etc.) | TODOS | Pre-flight §7.5 paso 0 OBLIGATORIO: ls cockpit/ + grep antes de crear archivos |

---

<a name="10"></a>
## 10. EJECUCIÓN — HANDOFF

### 10.1 Estado actual (2026-05-05 PM)

```
v13.4.0 "SILENT + ALERTS" — S0 + S1 DONE ✅
  │
  └── S2 "ZTMSI + DISPATCHER" (próximo a despachar)
        Plan autoritativo: ULTRON-v14-MASTER-DEFINITIVO.md v4.5 §6/S2
        Estado:
          - Sub-pilar A: 📋 LISTO (audit cerrado, EXTENDER brain_index.py, ~3h)
          - Sub-pilar B: 📋 ESPECIFICADO (Dispatcher, requiere S2-A)
          - Sub-pilar C: 📋 ESPECIFICADO (MMFP bootstrap, independiente)
        Recomendación: dispatch S2-A solo en próxima sesión, peer review Codex Dual,
        luego decidir si S2-B/C en sesiones separadas o juntas.
```

### 10.2 Secuencia de despacho recomendada (v4.5)

```
S1 ✅ DONE (2026-05-05 → v13.4.0)

S2-A (próxima sesión, 1 subagent compacto ~3h)
  └── Extender brain_index.py: chunks_fts + token_est + --mode chunks + splitter
  └── Extender frontmatter_backfill.py: campos tags/token_est/layer
  └── Tests test_brain_index_chunks.py (6 tests)
  └── Peer review: Codex Dual 1 round (NO MaxTriple via MMFP — MMFP no existe aún)
  └── NO bump versión todavía — esperar a S2 completo

S2-B + S2-C (sesión siguiente o misma si presupuesto, ~2.5h juntos)
  └── B: intent-dispatcher.py + intent-rules.yaml + manifest.cache.json mock (~90min)
  └── C: MMFP bootstrap (~60min) — Dispatcher puede usarlo opcionalmente
  └── Peer review final S2 con Codex MaxDual 3 rounds (NO MaxTriple via MMFP — overkill al estrenarlo)
  └── Bump v13.4.0 → v13.5.0 "ZTMSI + DISPATCHER"

S3 → S4: pueden paralelizarse si hay sesiones disponibles (no dependency entre ellos)
  └── S3 (~3h) y S4 (~2h) son independientes post-S2

S5: requiere S3 y S4 completos (~3h) → v14.0.0 "GENESIS" RELEASE
  └── ✅ Naming resuelto 2026-05-05 (codename "GENESIS", sistema sigue siendo ULTRON)

S6: post-release, no urgente (~2-3h)
```

### 10.3 No-Touch List (preservar a través de TODOS los sprints)

Scripts cockpit activos (no tocar comportamiento — solo extender):
```
brain_index.py, brain_config.py
memory_sync.py, decay_queue.py, session_compactor.py
vault_migrator.py, memory_bridge.py, retention.py
telemetry.py, skill_manifest.py
launch_project.py, scan_projects.py
auto_updater.py, audit_to_pending.py
registry_sync.py (ok modificar con --auto-discover), skill_discover.py
```

Hooks que funcionan (no tocar comportamiento, solo extender via encadenamiento):
```
~/.ultron/hooks/session-init.ps1             (extend, no reescribir)
~/.ultron/hooks/stop-memory-sync.ps1         (extend, no reescribir)
~/.claude/skills/ultron/hooks/auto-approve-readonly.py
~/.claude/skills/ultron/hooks/block-dangerous-bash.py
~/.claude/skills/ultron/hooks/routing-telemetry.py
~/.claude/skills/ultron/hooks/track-knowledge-reads.py
~/.claude/skills/ultron/hooks/mode-trigger.py
~/.claude/skills/ultron/hooks/session-log.py
```

Knowledge layer: `~/.ultron-vault/` entero (616+ notas) — solo cambios estructura-respetuosos.

### 10.4 Hard Rules (carry into EVERY session)

1. **NO POPUP WINDOWS — EVER.** Cualquier script que abra ventana es un bug.
2. **Python = `uv run` únicamente.** Nunca `python script.py`, `pip install`, `python -m`.
3. **Edit tool en archivos existentes.** PowerShell 5.1 `Add-Content -Encoding utf8` causa BOM en UTF-8-no-BOM (burned in S0).
4. **No destructive ops sin backup.** Backup en `~/.ultron/backups/YYYY-MM-DD-pre-SN/` antes de cualquier sprint.
5. **Version bump SOLO post peer review GREEN.** Nunca bump antes de MaxDual/MaxTriple.
6. **MMFP para decisiones critical.** No modificar arquitectura sin registro en multimodel/.

### 10.5 Versionado

| Sprint | Versión | Nombre |
|--------|---------|--------|
| S0 ✅ | 13.3.0 | CLEAN HOUSE |
| S1 | 13.4.0 | SILENT + ALERTS |
| S2 | 13.5.0 | ZTMSI + DISPATCHER |
| S3 | 13.6.0 | LAYERED MEMORY |
| S4 | 13.7.0 | MANIFEST |
| **S5** | **14.0.0** | **GENESIS (RELEASE)** |
| S6 | 14.1.0 | PORTFOLIO |

### 10.6 Archivos de este plan

```
~/.ultron/plans/ULTRON-v14-MASTER-DEFINITIVO.md   ← este archivo (SSOT del plan)
~/.ultron/plans/2026-05-04-ultron-v14-overhaul-master.md       (plan v2, referencia histórica)
~/.ultron/plans/2026-05-04-ultron-v14-overhaul-master-v3.md    (plan v3, superado por este)
~/.ultron/plans/2026-05-04-sprint-0-cleanup.md                  (S0 detailed, DONE)
~/.ultron/plans/2026-05-04-sprint-1-silent-alerts.md            (S1 detailed, LISTO)
```

### 10.7 Checklist de primera acción en próxima sesión (v4.5)

```
□ 1. Read: ULTRON-v14-MASTER-DEFINITIVO.md §header (cambios v4.4→v4.5) + §6/S2 + §13.5/13.6
□ 2. ✅ S0 + S1 = DONE (v13.4.0). Saltar.
□ 3. Pre-flight §7.5 paso 0: ls cockpit/ + verificar `brain_index.py` mtime y `index.db` location
     - brain_index.py debe estar en `~/.claude/skills/ultron/scripts/cockpit/` (702 líneas, ~26.7KB)
     - DB en `~/.ultron/brain_index/index.db` (~14.9MB, 626 notas)
□ 4. Crear backup: `~/.ultron/backups/2026-05-XX-pre-S2/` con copia íntegra de:
     - `brain_index.py`, `frontmatter_backfill.py`, `ultron.ps1`, `session-init.ps1`
     - `index.db` completa (15MB)
□ 5. Despachar S2 Sub-pilar A SOLO (~3h):
     - Extender brain_index.py: chunks_fts + token_est columns + splitter + --mode chunks flag
     - Extender frontmatter_backfill.py: campos KTP (tags/token_est/layer)
     - Tests test_brain_index_chunks.py (6 tests, ver §6/S2)
     - Doc brain-index-chunks.md
□ 6. Verificar baseline regression: `uv run pytest tests/test_alerts.py -v` GREEN antes y después
□ 7. Peer review S2-A via shared-duet.ps1 directo (Codex Dual 1 round) — NO MMFP, NO Gemini (free tier exhausted)
□ 8. NO bump versión todavía — esperar S2-B + S2-C completos para v13.5.0

✅ DECISIÓN TOMADA 2026-05-05: codename v14.0.0 = "GENESIS"
   Sistema sigue siendo ULTRON (no rename). Apellido de versión, no rebrand.
   Decidir antes de S5 — no bloquea S2-S4.
```

---

<a name="11"></a>
## 11. FIXES INMEDIATOS (2026-05-04) — PRE-S1

Fixes aplicados en esta sesión antes de arrancar S1. No requieren sprint completo.

### 11.1 Diagnóstico MCP (estado real)

| MCP | Estado antes | Causa | Acción tomada |
|-----|-------------|-------|---------------|
| `superpowers-mcp` | ❌ Falla startup | `mcp-servers/superpowers-mcp/` nunca clonado/buildeado | **ELIMINADO** de settings.json |
| `gemini` | ❌ No existía | Nunca configurado pese a estar en CLAUDE.md | **AÑADIDO** (`@rlabs-inc/gemini-mcp`) |
| `gemini-flash` | ❌ No existía | No planificado en v13 | **AÑADIDO** (mismo package, modelo flash) |
| `github@plugin` | ✅ OK | Plugin nativo, funciona | Sin cambios |
| `codex` | ✅ OK | gpt-5.5, sandbox read-only | Sin cambios |
| `sequential-thinking` | ✅ Asumido OK | npx on-demand | Sin cambios |
| `context7` | ✅ Asumido OK | npx on-demand — MCP independiente del plugin eliminado en S0 | Sin cambios |
| `n8n-mcp` | ✅ Archivo existe | `node_modules/n8n-mcp/dist/mcp/index.js` verificado | Sin cambios |
| `playwright` | ✅ Archivo existe | `node_modules/@playwright/mcp/cli.js` verificado | Sin cambios |
| `firebase` | ✅ Asumido OK | npx on-demand | Sin cambios |
| `unity` | ⚠️ Solo funciona con Unity abierto | SSE localhost:6402 — depende de Unity editor | Sin cambios (esperado) |

### 11.2 Hook terminal flash — fix parcial aplicado

**Causa del flash:** algunos scripts dentro de `session-init.ps1` usan `Start-Process` sin `-WindowStyle Hidden`, creando procesos hijos visibles durante 1-2 segundos.

**Fix parcial aplicado ahora** (en settings.json):
```json
SessionStart: "PowerShell -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ..."
Stop: "PowerShell -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ..."
```

**Fix completo:** S1 Pilar A — auditar todos los `Start-Process` dentro de los hooks.

### 11.3 Gemini MCP — configuración

```json
"gemini": {
  "command": "npx.cmd",
  "args": ["-y", "@rlabs-inc/gemini-mcp"],
  "env": { "GEMINI_API_KEY": "${GEMINI_API_KEY}", "GEMINI_MODEL": "gemini-2.5-pro", "QUIET": "true" }
},
"gemini-flash": {
  ...mismo pero "GEMINI_MODEL": "gemini-2.5-flash"...
}
```

`GEMINI_API_KEY` ya está en variable de entorno de Usuario Windows (`AIzaSy...`) — usada automáticamente vía `${GEMINI_API_KEY}`.

**Verificar en próxima sesión:** si gemini MCP tools aparecen disponibles (buscar `ask_gemini` o similar en tool list).

---

<a name="12"></a>
## 12. REQUISITOS ADICIONALES (sesión 2026-05-04)

Requisitos recogidos durante la sesión de planificación. Se integran en los sprints correspondientes.

### 12.1 Terminal flash — zero tolerance (añade a S1)

Problema: cualquier script que abra una ventana terminal, aunque sea 1-2 segundos, interrumpe el flujo de trabajo (foco se pierde, hay que volver a hacer click).

**Adición a S1 Pilar A:**
- [ ] Inventario exhaustivo de TODOS los `Start-Process` en hooks, incluyendo llamadas anidadas (scripts que llaman a scripts)
- [ ] `session-init.ps1` auditado a nivel recursivo — cualquier `Start-Process` interno también lleva `-WindowStyle Hidden`
- [ ] Test de regresión: monitorear 5 sesiones post-S1 — si aparece cualquier ventana flash → reportar como bug crítico en alerts.jsonl
- [ ] Hookify rule: bloquear cualquier `Start-Process` sin `-WindowStyle Hidden` en scripts ULTRON (guardrail preventivo)

### 12.2 Hookify como capa declarativa del dispatcher (añade a S2)

**Hallazgo de investigación:** Hookify permite definir reglas de dispatch en archivos `.md` con frontmatter YAML, sin código Python. Usa `additionalContext` para inyectar contexto en UserPromptSubmit.

**Decisión arquitectónica:** el dispatcher S2 usa un **enfoque híbrido**:

| Capa | Tecnología | Cobertura | Tokens |
|------|-----------|-----------|--------|
| Capa 1: Reglas explícitas | **Hookify rules** (YAML en .md) | ~60% prompts — patrones conocidos | 0 |
| Capa 2: Smart routing | **ZTMSI query + manifest.cache** (Python) | ~30% prompts — routing por keyword | 0 |
| Capa 3: Fallback | Sin dispatch | ~10% prompts — ambiguos | 0 |

**Ventaja:** Hookify rules son editables sin Python, sin reiniciar Claude, con `/hookify:list` para ver activas. Las reglas simples (debug → systematic-debugging, plan → agent-skills:plan) van a hookify. Las complejas (routing por contexto del vault, memoria de proyectos) van a ZTMSI.

**Adición a S2:**
- [ ] Crear `~/.ultron/hookify-rules/` con reglas para los 8 patrones canónicos
- [ ] Hookify rules usan `additionalContext` para inyectar la skill sugerida
- [ ] `intent-dispatcher.py` solo maneja los casos que hookify no cubre (ZTMSI + manifest)
- [ ] Documentar la división: qué va a hookify, qué va a ZTMSI

### 12.3 Cockpit — prompt improvements (añade a S2)

**Problema:** los scripts del cockpit tienen prompts (especialmente en Clipboard y Session) que asumen el sistema antiguo (pre-ZTMSI). Los Updaters y búsqueda de skills usan lógica hardcodeada que debe adaptarse.

**Scripts afectados (a auditar en S2):**
- `session_compactor.py` — usa contexto de sesión, necesita conocer L0/L1/L2
- `memory_sync.py` — debe escribir archivos con KTP frontmatter en nuevas entradas
- `skill_discover.py` — debe integrarse con `registry_sync.py --auto-discover` (S4)
- `auto_updater.py` — prompts internos pueden necesitar refactoring para ZTMSI

**Adición a S2 (Pilar A — ZTMSI Core):**
- [ ] Audit de prompts en `cockpit/` scripts — tabla con: script, prompt actual, problema, propuesta
- [ ] `memory_sync.py`: nuevas entradas incluyen KTP frontmatter automáticamente (tags: [decision, session, YYYYMMDD])
- [ ] `session_compactor.py`: output comprimido se guarda en L1 formato (con frontmatter), no texto libre

### 12.4 Seguridad de keys — cloud sync (añade a S5 + S6)

**Problema:** el sistema se sube a la nube (OneDrive u otro sync). API keys no deben estar en archivos del filesystem.

**Estado actual verificado:**
- `GEMINI_API_KEY` → Variable de entorno de Usuario Windows ✅ (nunca en archivo)
- `GITHUB_TOKEN` → Credential Manager ✅ (confirmado en hook de sesión)
- `OPENAI_API_KEY` → NO configurada (Codex usa ChatGPT subscription, no API key)
- keys en settings.json → todas usan `${VAR}` interpolación, no hardcodeadas ✅

**Riesgo identificado:** archivos en `~/.ultron/` y `~/.claude/` podrían contener keys si algún script los escribió inadvertidamente.

**Adición a S5 (doctor):**
- [ ] `ultron doctor --key-scan`: grep recursivo sobre `~/.ultron/` y `~/.claude/` buscando patrones de keys:
  - `AIza[0-9A-Za-z-_]{35}` (Google API keys)
  - `ghp_[a-zA-Z0-9]{36}` (GitHub PAT)
  - `sk-[a-zA-Z0-9]{48}` (OpenAI keys)
  - `eyJ` (JWT tokens)
- [ ] Cualquier hit → BLOCKING alert + propuesta de rotación
- [ ] Correr `--key-scan` antes del primera sync a nube

**Adición a S6 (portfolio):**
- [ ] `test_publish_sanitize.py` incluye regex para todos los patrones anteriores — bloquea publish si hay hit
- [ ] `.publicignore` explícitamente excluye `*.env`, `*.env.*`, `*credentials*`, `*secrets*`

### 12.5 Sistema de Agentes — infrautilizado (añade a S2 + S5)

**Hallazgo de investigación:** Claude Code tiene features de agentes avanzadas no explotadas:
- **Agent Teams**: un "team lead" coordina "teammates" que se comunican entre sí (no solo reportan al principal)
- **SubagentStart hook**: lifecycle event que permite inyectar contexto al inicio de cada subagent
- **22 lifecycle hooks** disponibles (ULTRON usa ~7)

**Adición a S2 (Dispatcher):**
- [ ] Añadir `SubagentStart` hook: cuando se lanza un subagent, inyectarle automáticamente el L0 + manifest context relevante para su tarea declarada
- [ ] Esto evita que cada subagent tenga que "descubrir" el contexto por su cuenta (token waste actual)

**Adición a S5 (doctor):**
- [ ] `ultron doctor --agent-health`: lista qué lifecycle hooks están configurados vs disponibles
- [ ] Reporte: hooks usados (7/22) con sugerencia de cuáles añadirían valor

**Para consideración futura (post-v14.0.0):**
- Evaluar Agent Teams para sprints paralelos (S3 + S4 en paralelo con team lead ULTRON)
- Implementar `SubagentStop` hook para guardar resultados en formato L1/ZTMSI automáticamente

### 12.6 Criterio de éxito adicional E6 — experiencia de uso

**Motivación:** los 5 criterios anteriores son técnicos. Este es el criterio que realmente importa.

| # | Criterio | Definición de PASS |
|---|----------|--------------------|
| **E6** | ULTRON es una inversión positiva en el flujo real | En 2 semanas post-release v14.0.0: USER NO tiene que invocar skills manualmente en ≥7/10 sesiones, y el overhead percibido es menor que el valor recibido (evaluación subjetiva binaria) |

Este criterio es el gate final antes de S6. Si E6 falla → no publicar portfolio hasta resolver. Si pasa → publish con confianza.

### 12.7 Deferred Session — "lo hablamos mañana" (nuevo sprint S1.5 o integrar en S3)

**Motivación:** Cuando una sesión se interrumpe por tokens, tiempo, o prioridad — el contexto se pierde y la próxima sesión arranca desde cero. El `--resume` de ULTRON es la solución.

**Concepto:**
```
USER: "lo hablamos mañana"  OR  "guardemos esto para luego"  OR  "ultron defer"
→ ULTRON genera ~/.ultron/deferred/<timestamp>-<slug>.md
→ La próxima sesión (SessionStart) detecta el defer y lo inyecta como BLOCKING L0
→ Claude arranca sabiendo exactamente dónde quedó
```

**Contenido del archivo defer:**
```markdown
---
type: deferred-session
created: 2026-05-04T22:00Z
topic: "ULTRON v14 plan + MCP fixes"
priority: high
status: pending
---
# Contexto al pausar
[resumen de lo que se estaba haciendo]

# Decisiones tomadas en esta sesión
- Se eliminó superpowers-mcp (directorio nunca existió)
- Gemini configurado: gemini-3.1-pro-preview
- Plan maestro en ULTRON-v14-MASTER-DEFINITIVO.md

# Próximos pasos concretos
1. [ ] Despachar S1 (plan listo en 2026-05-04-sprint-1-silent-alerts.md)
2. [ ] Verificar gemini MCP tools disponibles en nueva sesión
3. [ ] Completar §13 auditoría antes de S2

# Contexto necesario para resumir
- Leer: ULTRON-v14-MASTER-DEFINITIVO.md §10.1 y §13
- Estado: v13.3.0, S0 done
```

**DONE criteria (sprint asignado: S3, integra con L0/L1):**
- [ ] `ultron defer "<descripción>"` → crea archivo defer con resumen AI-generado del estado actual
- [ ] `ultron defer --auto` → ULTRON detecta frases "lo hablamos mañana/luego", "defer", "guardemos" en el prompt → activa automáticamente vía hookify rule
- [ ] SessionStart hook: si existe `~/.ultron/deferred/*.md` con `status: pending` → inyectar en L0 como `[DEFERRED]` item con prioridad sobre cualquier otra cosa
- [ ] `ultron defer list` → lista sessions pendientes
- [ ] `ultron defer resolve <id>` → marca como completado
- [ ] Hookify rule: patrón `"lo hablamos (mañana|luego|después)"` → trigger `ultron defer --auto`
- [ ] Session_compactor.py extendido: genera el resumen para el defer (usa Codex si está en HIGH/ULTRA)
- [ ] Integrado con alerts.jsonl: defer pendiente >24h → alert `warn` "Hay una sesión diferida pendiente"

**Archivos:**
- **Modify:** `session_compactor.py` (add defer mode)
- **Create:** `~/.ultron/deferred/` (directorio)
- **Modify:** `session-init.ps1` (inject deferred session if pending)
- **Modify:** `ultron.ps1` (add `defer` subcommand)
- **Create:** hookify rule `~/.ultron/hookify-rules/defer-session.md`

### 12.8 Version Reset — "El Verdadero Launch" (aplica a S5/release)

**Motivación:** v14.0.0 no comunica que esto es un sistema completamente nuevo. El historial v6→v13 es baggage. Para el portfolio público y para la mentalidad interna, el true launch necesita un reset semántico.

**Decisión de naming:**

| Opción | Ventaja | Contra |
|--------|---------|--------|
| **Reset a v1.0.0** | Clean slate, semver limpio, portfolio-ready | Pierde el historial de versiones |
| **Rename + v1.0.0** | Nuevo nombre marca la ruptura claramente | Hay que actualizar todos los touchpoints |
| **v14.0.0 como estaba** | Sin trabajo extra | No comunica el nuevo paradigma |

**Decisión final 2026-05-05: MANTENER ULTRON + codename release.**

USER eligió mantener el nombre del sistema (ULTRON) y añadir un codename de versión por release siguiendo el patrón ya establecido (v13.3.0 "CLEAN HOUSE", v13.4.0 "SILENT + ALERTS"). Para v14.0.0 el codename es **"GENESIS"** — refleja que esta es la 1.0 canónica que cierra el arco Kirkardo→Modular.

Propuestas descartadas (registro histórico):
- ~~NEXUS~~ — evoca conexión entre sistemas, memoria, agentes
- ~~HERALD~~ — el que anuncia, el que enruta
- ~~APEX~~ — top del sistema, dispatcher-first
- ~~KRONOS~~ — tiempo, memoria, continuidad (greco)
- ~~ULTRON Core v1.0 "Index-First"~~ — tagline alternativo, no codename

Versionado interno se mantiene v14.0.0 (no reset a v1.0.0 — el historial v6→v13 es parte de la narrativa).

**DONE criteria (aplicar en S5 justo antes del tag de release):**
- [x] Decisión de nombre tomada por USER → **ULTRON v14.0.0 "GENESIS"** (2026-05-05)
- [ ] `~/.ultron/docs/version-touchpoints.md` actualizado con todos los puntos a cambiar (CLAUDE.md skill header, SKILL.md, scripts con `v13.x.0`, hooks que anuncian versión)
- [ ] Todos los CLAUDE.md, SKILL.md, scripts con versión hardcodeada actualizados a `v14.0.0 "GENESIS"` en un solo pass
- [ ] CHANGELOG.md crea nueva sección `v14.0.0 "GENESIS" (YYYY-MM-DD)` con resumen narrativo de todo lo construido en S0-S5 (cleanup → silent+alerts → ZTMSI → 3-layer memory → manifest → doctor)
- [ ] Git tag `v14.0.0` en `~/.claude/skills/ultron/` con mensaje `"ULTRON v14.0.0 GENESIS"`
- [ ] `context.md` y L0-pinned.md muestran `v14.0.0 "GENESIS"` en primera sesión post-tag

---

<a name="14"></a>
## 14. PLAN CERRADO — CHECKLIST FINAL

> **Versión 4.5 — 2026-05-05 PM. PLAN LOCKED para ejecución de S2.**
> **Validado:** sesión 343a817b (S1 ejecución) + sesión 6b67e2ac (S1 cierre + audit S2 cerrado)

### 14.1 Nada falta — verificación

| Área | Cubierto en | Estado |
|------|-------------|--------|
| Root cause analysis | §2 | ✅ |
| Arquitectura completa | §3 | ✅ |
| Criterios de éxito medibles (E1-E6) | §4 + §12.6 | ✅ |
| Pre-condiciones y dependencias | §5 | ✅ |
| Sprint specs binarias y completas (S0-S6) | §6 | ✅ |
| Protocolos transversales (KTP, MMFP, token, rollback) | §7 | ✅ |
| Decisiones arquitectónicas justificadas (ADR-001 a ADR-005) | §8 | ✅ |
| Riesgos CRITICAL y HIGH mitigados | §9 | ✅ |
| Handoff + no-touch list + hard rules | §10 | ✅ |
| MCP diagnostic + fixes aplicados | §11 | ✅ |
| Nuevos requisitos (terminal, hookify, cockpit, keys, agents, defer, v1.0.0) | §12 | ✅ |
| Auditoría de lo existente (no reimplementar) | §13 | ✅ |
| Tres pilares fundamentales (invisible, token, algoritmos) | §0 | ✅ |

### 14.2 Decisiones pendientes para USER — v4.5

1. ✅ ~~BLOQUEANTE para S5/v14.0.0 — Nombre del sistema.~~ **RESUELTO 2026-05-05.** Sistema sigue siendo **ULTRON**. v14.0.0 lleva codename **"GENESIS"** como apellido de versión (patrón v13.3.0 "CLEAN HOUSE", v13.4.0 "SILENT + ALERTS"). NEXUS/HERALD/APEX/KRONOS descartados. S5 desbloqueado. Ver §12.8 para registro histórico de la decisión.
2. **Reindex pre-S2** (no bloqueante): brain_index DB tiene 626 notas, plan dice 970. Ejecutar `uv run python ~/.claude/skills/ultron/scripts/cockpit/brain_index.py build` para ver número real post-rebuild. Si sigue 626, actualizar todos los docs. Si vuelve a 970, hubo orphans purgados — investigar antes de S2.
3. ✅ ~~S1 Pilar A~~ → DONE 2026-05-05 12:49 (ver §6/S1 outcome).
4. ✅ ~~S1 Pilar B~~ → DONE pre-existing (ver §6/S1 outcome).
5. ✅ ~~Gemini Flash model~~ → resuelto v4.4 (alias map en §13.4).
6. ✅ ~~ultron.ps1 alerts CLI~~ → existe en `scripts/cockpit/ultron.ps1` líneas 857+.
7. **¿Crear `write-alert.ps1`?** Opcional. `ultron alerts write` ya cubre todos los casos. Decidir solo si surge un caso de uso concreto.

### 14.3 Primera acción al abrir sesión siguiente (post-v4.5)

```
□ 1. Read §header v4.4→v4.5 changelog + §6/S2 Sub-pilar A (extender brain_index.py) + §13.5 audit cerrado
□ 2. Pre-flight §7.5 paso 0: `ls cockpit/` + verificar brain_index.py (702 líneas, 26.7KB) + DB (14.9MB)
□ 3. Backup pre-S2: copiar brain_index.py + frontmatter_backfill.py + ultron.ps1 + session-init.ps1 + index.db a `~/.ultron/backups/2026-05-XX-pre-S2/`
□ 4. (Opcional, pre-S2) ejecutar `brain_index.py build` y stats para ver count real (626 vs 970 stale)
□ 5. Despachar S2 Sub-pilar A solo (~3h): chunks_fts + token_est + --mode chunks + 6 tests + doc
□ 6. Peer review Codex Dual 1 round via shared-duet.ps1 directo
□ 7. NO bumpear versión — esperar S2-B + S2-C
```

---

<a name="13"></a>
## 13. AUDITORÍA DEL SISTEMA EXISTENTE — LO QUE YA ESTÁ CONSTRUIDO

> **⚠️ CRÍTICO.** Esta sección fue añadida tras descubrir que el cockpit tiene 70+ scripts, muchos de los cuales implementan exactamente lo que los sprints S1-S5 planeaban construir desde cero. El plan original reimplementaría trabajo existente. **Cada sprint debe EXTENDER, no REEMPLAZAR.**

### 13.1 Inventario — Estado real vs Plan original

| Script | Existe | Qué hace | Overlap con plan | Acción correcta |
|--------|--------|----------|-----------------|-----------------|
| `brain_index.py` | ✅ FTS5/BM25, **626 notas verificadas** (2026-05-05), incremental | FTS5 SQLite (unicode61 remove_diacritics 2), query top-K BM25, vault+projects+sessions+skills indexados, 5 layers, migración idempotente vía ALTER TABLE, WAL+read-only conn | **S2 ZTMSI completo (80%)** — gaps: chunks, token_est, --mode chunks query | EXTENDER (NO crear ztmsi_*.py paralelos — ver §13.5 audit) |
| `alerts.py` | ✅ Completamente implementado | append-only, atomic writes, Windows msvcrt lock, severity, ack-as-events | **S1 Pilar B completo** | INTEGRAR: hook + CLI en ultron.ps1 |
| `frontmatter_backfill.py` | ✅ Existente | Escribe kind/tier/category/last_verified en SKILL.md frontmatter | S2 KTP tagging | EXTENDER: añadir tags/layer/token_est campos KTP |
| `skill_manifest.py` | ✅ 373 skills trackeadas | Schema completo: route_edges, memory_layer, estimated_token_cost, authority | **S4 manifest completo** | EXTENDER: añadir triggers/tags KTP, export YAML |
| `routing_decide.py` | ✅ Thompson Sampling | Beta distribution routing sobre telemetría de éxito/fallo por skill | S2 dispatcher routing | INTEGRAR: dispatcher usa Thompson Sampling, no solo keywords |
| `health.py` | ✅ v10.4 | Checks Python/Node/CLIs/scripts/config/cron/disk | S5 doctor base | EXTENDER: añadir MCP health, token audit, ZTMSI staleness |
| `mcp_broker.py` | ✅ v10.6 | Allowlist, JSON-RPC validation, audit log, rate limiting, env minimization | S5 MCP resilience | EXTENDER: añadir fallback messages, mcp-health.json |
| `context_primer.py` | ✅ Existe | Genera context.md para SessionStart | S3 L0 generator | EXTENDER: añadir L0-pinned.md separado con token_budget.enforce |
| `skill_sync.py` | ✅ Existe | Sync de skills | S4 script-only sync | AUDITAR antes de S4: puede ser la base |
| `registry_sync.py` | ✅ Existe | Sincroniza 3 registros (Claude/Codex/Agents) | S4 auto-discover | EXTENDER: añadir KTP frontmatter parsing → auto-manifest |
| `secrets_manager.py` | ✅ Existe | Gestión de secrets | §12.4 key security | AUDITAR: puede cubrir el key-scan |
| `route_quality.py` + `route_quality_aggregator.py` | ✅ Existe | Telemetría de calidad de routing | S2 dispatcher telemetry | USAR: ya tiene la data que el dispatcher necesita |
| `tui.py` | ✅ 105KB, deshabilitado | TUI cockpit completa | — | No tocar — activar cuando esté listo |

### 13.2 Impacto en sprints — Delta real vs plan original

**S1 — Pilar B (Alerts Bus):** ✅ DONE 2026-05-05
- Plan original: construir desde cero (~115 min)
- Realidad: `alerts.py` + CLI + hook integration + docs + `tests/test_alerts.py` (13/13 PASS) — TODO ya implementado
- **Delta real: 0 min implementación** (verificación corrida en sesión 343a817b — 13/13 tests GREEN)
- Único pendiente opcional: `write-alert.ps1` standalone (no requerido — `ultron alerts write` cubre el caso)

**S2 — ZTMSI:**
- Plan original: SQLite FTS5 desde cero, paragraph-level
- Realidad: `brain_index.py` ya es FTS5/BM25, 626 notas (verificado in-situ), incremental, layers, ya tiene `L1-skills`
- **Gap a rellenar**: (a) chunk/paragraph level indexing, (b) skill YAML metadata indexing, (c) `token_est` per chunk
- **Delta real: ~60 min** vs ~120 min planificados para ZTMSI core

**S2 — Dispatcher:**
- Plan original: Python con keyword matching
- Realidad: `routing_decide.py` ya tiene Thompson Sampling sobre telemetría real
- `route_quality.py` ya tiene datos de qué skills funcionan bien
- **Delta real**: dispatcher llama `routing_decide.py` + `brain_index.py`, no reimplementa routing

**S2 — KTP Protocol:**
- Plan original: nuevo protocolo de frontmatter
- Realidad: `frontmatter_backfill.py` ya escribe frontmatter, pero con campos distintos
- **Delta real**: añadir campos `tags`, `token_est` a frontmatter_backfill + extender

**S4 — Manifest:**
- Plan original: construir `skills.manifest.yaml` desde cero
- Realidad: `skill_manifest.json` ya existe con 373 skills y schema completo
- **Delta real**: añadir `triggers` y `tags` KTP al schema existente + export YAML + auto-discover via KTP

**S5 — Doctor:**
- Plan original: construir `doctor.py` desde cero
- Realidad: `health.py` ya cubre checks básicos; `mcp_broker.py` ya tiene audit trail
- **Delta real**: extender `health.py` con ZTMSI staleness + token audit + MCP health desde `mcp_broker`

### 13.3 Regla de oro para implementadores

> **"Antes de crear un archivo, busca si ya existe."**
> 
> Protocolo obligatorio al inicio de cada sprint:
> 1. `ls ~/.claude/skills/ultron/scripts/cockpit/` — inventario completo
> 2. Para cada componente planificado: `grep -r "<nombre>" cockpit/` — ¿ya existe algo similar?
> 3. Si existe: leer primero 60 líneas (docstring) para entender scope
> 4. Extender o adaptar — nunca duplicar

### 13.4 Modelo Gemini — VERIFICADO 2026-05-05

- **Modelo confirmado en uso:** `gemini-3.1-pro` (verificado vía MCP query — error 429 reveló el model id real)
- **shared-duet.ps1 alias map** (líneas 31-39): `'pro' → gemini-3.1-pro-preview` (default), `'pro-2.5' → gemini-2.5-pro` (fallback legacy si quota), `'flash' → gemini-3-flash-preview`, `'flash-2.5'/'flash-lite' → 2.5 series`
- **Settings.json actual** (verificado 2026-05-05): `GEMINI_MODEL=gemini-2.5-pro` (legacy stable). Plan v4.3 confirma: para shared-duet usar default `'pro'` (= 3.1-preview); para MCP query mantener 2.5 hasta migración planeada.
- **⚠️ Free tier quota agotada en 3.1-pro** (RESOURCE_EXHAUSTED en sesión 343a817b 2026-05-05). Workaround: usar Codex (sin afectado) o Gemini 2.5 fallback (`-GeminiModel pro-2.5`) para peer reviews mientras se resuelve billing.

### 13.5 brain_index.py — AUDIT CERRADO 2026-05-05 (v4.5)

**Verificación in-situ** (sesión 6b67e2ac, 2026-05-05 14:15): brain_index.py = 702 líneas / 26.7KB / mtime 2026-05-03 12:21. DB en `~/.ultron/brain_index/index.db` = 14.9 MB con **626 notas indexadas** (no 970 — el número 970 en plan v4.4 y CLAUDE.md v13.3.0 está stale, posible reindex pendiente o cuenta histórica diferente).

**Lo que ya hace brain_index.py (validado leyendo el archivo):**
- ✅ FTS5 con tokenize='unicode61 remove_diacritics 2' (correcto para español, mejor que porter)
- ✅ Schema notes(id, path, layer, category, **domain**, title, frontmatter, content, content_chars, mtime, sha1) + notes_fts virtual + links + meta + decay_state
- ✅ 5 layers: L2-vault · L1-projects · L1-sessions · L1-skills · L1-skills-ref
- ✅ Build (full rebuild con preservación decay_state vía sidecar JSON) + update (incremental por sha1+mtime)
- ✅ Query con BM25 + snippet(12 tokens) + filtros layer/category/domain
- ✅ Migración idempotente (`ALTER TABLE … ADD COLUMN domain` con try/except OperationalError) — **mismo patrón sirve para añadir token_est sin breaking**
- ✅ WAL + read-only conn separada (no bloquea writes con queries simultáneas)
- ✅ Self-healing prune con SKIP_DIRS + valid_sources (F8 fix)
- ✅ Synonym expansion via brain_config.load_synonyms

**Gaps confirmados (validados con código real):**

| Gap | Validación | Decisión v4.5 | Trabajo |
|-----|-----------|---------------|---------|
| No hay indexación a nivel párrafo | Confirmado: `notes_fts(title, content, ...)` recibe `body` entero (línea 367-371) | EXTENDER: añadir `chunks_fts` paralela, no romper `notes_fts` | ~2h: schema + splitter + integración en upsert_note |
| No hay `token_est` por nota/chunk | Confirmado: ningún campo en SCHEMA_SQL (líneas 94-130) | EXTENDER: ALTER TABLE notes ADD COLUMN (idempotente, mismo patrón que domain) | ~30 min |
| ~~Indexar skill_manifest.json~~ | `L1-skills` ya indexa SKILL.md de cada skill dir (línea 189-199). Manifest export es trabajo de S4. | **MOVER a S4** | (sale de S2) |
| `query` retorna nota completa | Confirmado: cmd_query (línea 529) retorna 1 row por nota con snippet 200 chars. Para context packets ≤600 tok hay que retornar top-K chunks. | EXTENDER con flag `--mode chunks` (default mantiene back-compat) | ~1h |

**Estimación total S2-A revisada: ~3h** (vs ~4h v4.4, vs ~8h en v4.3 antes de audit). Despachable como subagent único.

**Decisión arquitectónica v4.5 (registrar como ADR-006):**
> S2 NO crea `ztmsi_build.py`/`ztmsi_query.py`/`ztmsi_tag.py` paralelos. ZTMSI es el nombre conceptual del rol que cumple `brain_index.py` extendido. `frontmatter_backfill.py` cubre el rol que iba a tener `ztmsi_tag.py` con campos KTP añadidos. Crear archivos paralelos duplicaría schema, build, query, prune — violación directa del Pilar III ("Inteligencia en scripts, no en prompts" + corolario implícito: no duplicar inteligencia ya escrita).

### 13.6 Estado de brain_index actual

```
Fuentes indexadas: L2-vault + L1-projects + L1-sessions (últimos 30d) + L1-skills + L1-skills-ref
DB location: ~/.ultron/brain_index/index.db (14.9 MB)
Notas: 626 (verificado in-situ 2026-05-05 14:15 — si 970 era el target, hay reindex pendiente)
FTS5: unicode61 remove_diacritics 2 (mejor que porter para español)
Layers: L1-projects | L1-sessions | L2-vault | L1-skills | L1-skills-ref
CLI: brain_index.py build | update | query | stats | inspect
Pre-S2 health: WAL activo, decay_state preservado en rebuilds, no broken wikilinks reportados
```

**Plan para S2-A:** EXTENDER `brain_index.py` con `chunks_fts` table paralela (no reemplaza `notes_fts`), añadir `token_est` columns (migración idempotente), añadir flag `--mode chunks` a query. Backup de `index.db` ANTES del primer build con schema nuevo. Tests separados en `test_brain_index_chunks.py`.

**Acción pre-S2 recomendada (no bloqueante):** decidir si correr `brain_index.py build` para reconciliar 626 → ~970 notas (si 970 era el target). Posible que falten skills nuevos o que números difieran porque `40_SKILLS/` se excluyó en F8 fix.
