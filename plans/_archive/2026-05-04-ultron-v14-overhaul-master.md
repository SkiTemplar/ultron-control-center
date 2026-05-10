# ULTRON v14.0 "Modular" — Master Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement each sprint task-by-task. This is a **master plan**; each sprint will spawn its own detailed implementation plan when activated. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reescribir ULTRON de un sistema monolítico-aditivo a una arquitectura modular dispatcher-first — eliminando 50-100K tokens/sesión de waste, automatizando skill routing, consolidando memoria en 3 capas explícitas, y purgando cruft acumulado a través de las versiones v6.x → v13.2.

**Architecture:** UserPromptSubmit hook clasifica intent del usuario → suggest skill (dispatcher pattern). Memoria estratificada: **L0 pinned** (~200 tok always loaded), **L1 on-intent** (cargada bajo demanda por dispatcher según topic), **L2 queryable** (brain_index FTS5, on-demand only). Skills/plugins gobernados por `skills.manifest.yaml` único — fuente de verdad. Self-healing via `ultron doctor` CLI con confirmación.

**Tech Stack:** Python 3.11 (cockpit scripts via `uv`), PowerShell 7 (hooks Windows), YAML (manifest + hookify rules), FTS5 SQLite (brain_index ya existente), Claude Code hooks API (UserPromptSubmit / PreToolUse / PostToolUse / SessionStart / Stop).

**Versioning:** v13.2.0 → **v14.0.0** (breaking change: removes deprecated plugins, restructures memory layout).

**Convention for sub-plans:** When sprint S<N> starts, spawn detailed plan at `~/.ultron/plans/2026-MM-DD-sprint-<N>-<slug>.md` following `superpowers:writing-plans` format con tasks de 2-5 minutos y código exacto.

---

## Sprint Overview

| # | Sprint | ROI | Coste | Peer Review | Bloqueante para |
|---|--------|-----|-------|-------------|-----------------|
| 0 | Cleanup & Cuts ✅ | Alto | 1-2 sesiones | MaxDual | S2 (suelo limpio antes de dispatcher) |
| 1 | Silent Execution + Alerts Bus | Medio (UX) | 1-2 sesiones | MaxDual | S5 (alerts source) |
| 2 | **Intent Dispatcher (CORE)** | **Crítico** | 2-3 sesiones | **MaxTriple** | S3, S4 |
| 3 | 3-Layer Memory | Alto | 2 sesiones | MaxDual | S4 |
| 4 | Skills Manifest YAML | Medio | 1-2 sesiones | MaxDual | S5 |
| 5 | ultron doctor v2 (+ alerts surface) | Medio | 1 sesión | MaxDual | S6 |
| 6 | Public Portfolio Repo | Bajo (estratégico) | 1-2 sesiones | MaxDual | — |

**Estimación total:** 9-13 sesiones distribuibles según ritmo. Release final v14.0.0 al cierre de S5; v14.1.0 al cierre de S6 (publicación).

---

## Sprint 0 — Cleanup & Cuts ✅ DONE (2026-05-04)

**Goal:** Eliminar cruft confirmado por agentes Explore, desinstalar plugins redundantes, remover MCP `memory`. Suelo limpio antes de construir.

**Status:** Closed 2026-05-04. Version bumped v13.2.0 (TRUST FIX) → **v13.3.0 (CLEAN HOUSE)**. Codex peer review GREEN-LIGHT. See `~/.ultron/telemetry/v14-overhaul/sprint-0-final.md`.

### DONE criteria

- [x] Backup snapshot creado en `~/.ultron/backups/2026-05-04-pre-S0/` (settings.json + tarball cruft a borrar)
- [x] Carpetas borradas:
  - [x] `~/.ultron/_knowledge-deprecated-v12.5/`
  - [x] `~/.ultron/archive/v6.x-legacy/`
  - [x] `~/.ultron/archive/deprecated-memory-system/`
  - [x] `~/.ultron/.tmp.driveupload/` (26 archivos)
  - [x] `~/.ultron/archive/skill_installs/20260430-coding-sync/` (~80 MB)
  - [x] `~/.ultron/archive/cleanup-2026-05-02/` `.bak/.bak2/.bak3` files
  - [x] `~/.ultron/hooks/push-async.log`
  - [x] **(B.5)** `~/.ultron/knowledge/` legacy folder — hash-verified byte-identical with vault L2 (18 files SHA256 match), zipped to `knowledge-legacy.zip` then deleted
- [x] Plugins desinstalados (via `claude` CLI o `settings.json` direct edit):
  - [x] `claude-mem@thedotmack`
  - [x] `pensyve@major7apps-pensyve`
  - [x] `code-simplifier@claude-plugins-official`
  - [x] `context7@claude-plugins-official`
- [x] MCP `memory` server removido de `~/.claude/settings.json` (líneas 168-174 actuales)
- [x] **(E + E.5)** Orphan marketplace refs purgadas; `subagent-routing.md:33` corregido; changelog wording fix.
- [x] **(F)** Version bump v13.2.0 → v13.3.0 "CLEAN HOUSE" + `~/.ultron/docs/version-touchpoints.md` inventory creado. Drift "CORE v12.5" en cockpit `tui.py` corregido.
- [x] Verificación post-cleanup:
  - [x] Nueva sesión Claude Code arranca sin errores
  - [x] `ultron sync` ejecuta sin warnings
  - [x] `brain_index.py status` reporta DB intacta
- [x] Métrica baseline registrada: tokens cacheados/sesión PRE y POST cleanup → guardada en `~/.ultron/telemetry/v14-overhaul/sprint-0-baseline-pre.json` + `sprint-0-baseline-post.json`

### Files

- **Modify**: `C:\Users\USER\.claude\settings.json` (remove `enabledPlugins` entries + `mcpServers.memory`)
- **Delete**: paths listados en DONE criteria bajo `.ultron/`
- **Create**: `C:\Users\USER\.ultron\backups\2026-05-04-pre-S0\` (snapshot)
- **Create**: `C:\Users\USER\.ultron\plans\2026-05-04-sprint-0-cleanup.md` (detailed plan when sprint starts)
- **Create**: `C:\Users\USER\.ultron\telemetry\v14-overhaul\sprint-0-baseline.json`

### Risks

| Risk | Mitigation |
|------|------------|
| Plugin still referenced by some skill not yet detected | Backup `settings.json` + `Grep` for plugin name across `~/.claude/skills/` antes de desinstalar |
| `claude-mem` orphan files en user data | Scan `~/.claude/plugins/data/claude-mem*` post-uninstall |
| MCP `memory` removal afecta Claude Desktop | Verificar que solo está en Claude Code `settings.json`, no en `%APPDATA%\Claude\claude_desktop_config.json` |
| Métrica baseline contaminada (sesión sin trabajo real) | Medir promedio de 3 sesiones consecutivas pre y post |

### Peer Review

**MaxDual** (Codex, 1-3 rounds) al cierre del sprint. Validate: ¿algún plugin/MCP eliminado se usa en algún script no detectado?

---

## Sprint 1 — Silent Execution + Alerts Bus

**Goal:** Dos pilares acoplados — (A) garantizar que ningún script ULTRON abra ventanas visibles, y (B) construir un canal de alertas persistente que sustituya cualquier comunicación urgente que un script silencioso ya no puede gritar al usuario.

**Porqué juntos:** un script silenciado SIN canal de alertas es un script ciego — si pasa algo crítico, nadie se entera. Los dos sub-pilares se diseñan a la vez.

### Pilar A — Silent Execution Audit

**DONE criteria:**

- [ ] Inventario completo: tabla en `~/.ultron/docs/silent-execution-policy.md` con cada script + cómo se ejecuta + ¿abre ventana?
- [ ] Auditoría `subprocess.run()` en `scripts/cockpit/*.py` → todos usan `capture_output=True` o `stdout=subprocess.DEVNULL` Y `creationflags=subprocess.CREATE_NO_WINDOW` cuando spawnean subprocesos en Windows
- [ ] Auditoría `Start-Process` en `*.ps1` → todos usan `-WindowStyle Hidden` o `-NoNewWindow` (preferir `Start-Job` para background)
- [ ] **Fix conocido**: `~/.ultron/hooks/session-init.ps1:192` parser error (visto en compact 2026-05-04)
- [ ] **Fix conocido**: EEXIST mkdir en `session-env/` y `plugins/data/*` (idempotencia faltante en hooks de SessionStart)
- [ ] `ultron.ps1` dispatcher: ejecuciones manuales no abren consola visible (testing manual)
- [ ] Test manual: ejecutar `ultron sync`, `ultron doctor`, `ultron memory query` → ninguna ventana
- [ ] Env var `ULTRON_DEBUG=1` introducida → fuerza output visible cuando se necesita debugging
- [ ] Documentación: política escrita en `~/.ultron/docs/silent-execution-policy.md`

### Pilar B — Alerts Bus (persistent alert channel)

**Concepto:** archivo append-only `~/.ultron/alerts.jsonl` donde cualquier script/hook puede escribir avisos. SessionStart hook lee unacked alerts y los inyecta en `context.md` como `[BLOCKING]`/`[WARN]`/`[INFO]`. Resuelve el caso "script silencioso quiere avisar de algo importante".

**DONE criteria:**

- [ ] Esquema definido en `~/.ultron/docs/alerts-bus.md`:
  ```jsonl
  {"id":"a-2026-05-04-001","ts":"2026-05-04T18:23:11Z","severity":"blocking|warn|info","source":"session-init.ps1","message":"...","tags":["hook","sync"],"ack":false}
  ```
- [ ] Helper PowerShell: `~/.ultron/scripts/alerts/write-alert.ps1 -Severity warn -Source <name> -Message "..."` (silent, atómico append, fail-safe)
- [ ] Helper Python: `~/.claude/skills/ultron/scripts/cockpit/alerts.py` con `write(severity, source, message, tags=[])` y `read_unacked(severity_min='info')`
- [ ] SessionStart hook extendido: lee alerts unacked → inyecta top-N en `~/.ultron/.tmp/context.md` con prefijo claro
- [ ] CLI commands en `ultron.ps1`:
  - [ ] `ultron alerts list [--severity blocking|warn|info] [--unacked]`
  - [ ] `ultron alerts ack <id>` (marca como resuelto, NO borra)
  - [ ] `ultron alerts purge --older-than 30d` (archivo a `~/.ultron/alerts/archive/YYYY-MM.jsonl`)
- [ ] Retención: alerts >30 días auto-archivados (referenciado por S5 doctor, implementado aquí)
- [ ] Migración: hook errors ya conocidos (EEXIST + parser error) reportados al alerts.jsonl como caso de estreno
- [ ] Test: writer concurrente desde 3 scripts → 0 corrupciones (lock o append atómico)
- [ ] Documentación: `~/.ultron/docs/alerts-bus.md` con ejemplo de uso, severidades, retention, integración con doctor

### Files

**Pilar A (Silent):**
- **Modify (potential)**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\*.py` (añadir `capture_output=True` + `CREATE_NO_WINDOW`)
- **Modify (potential)**: `C:\Users\USER\.ultron\hooks\*.ps1` (añadir `-WindowStyle Hidden`, fix idempotencia mkdir)
- **Modify**: `C:\Users\USER\.ultron\hooks\session-init.ps1` (fix línea 192 + EEXIST + extend para leer alerts)
- **Modify (potential)**: `C:\Users\USER\.claude\skills\ultron\scripts\ultron.ps1`
- **Create**: `C:\Users\USER\.ultron\docs\silent-execution-policy.md`

**Pilar B (Alerts):**
- **Create**: `C:\Users\USER\.ultron\alerts.jsonl` (append-only, vacío inicial)
- **Create**: `C:\Users\USER\.ultron\scripts\alerts\write-alert.ps1`
- **Create**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\alerts.py`
- **Modify**: `C:\Users\USER\.claude\skills\ultron\scripts\ultron.ps1` (add `alerts` subcommand)
- **Create**: `C:\Users\USER\.ultron\docs\alerts-bus.md`

**Plan detallado:**
- **Create**: `C:\Users\USER\.ultron\plans\2026-MM-DD-sprint-1-silent-alerts.md`

### Risks

| Risk | Mitigation |
|------|------------|
| Script sí necesita output visible (debugging interactivo) | Env var `ULTRON_DEBUG=1` para forzar ventana on-demand |
| `Start-Job` ya silencioso → falsos positivos en audit | Patrón claro: cambiar solo `Start-Process`, no `Start-Job` |
| Capturar `stderr` puede ocultar errores reales | **alerts bus** es la mitigation — stderr crítico va a alerts.jsonl |
| Alerts bus se inunda (ruido) | Severidad mínima `info`, dispatcher solo surface `warn`+`blocking` por defecto |
| Concurrent writes corrompen alerts.jsonl | File lock o append atómico (POSIX `O_APPEND` / Windows file lock) |
| Alerts ack flag se pierde tras compact/sync | `ack` es parte del JSON, persiste; archivo append-only sin reescritura |

### Peer Review

**MaxDual** al cierre. Validar especialmente que (a) ningún script abre ventana, (b) alerts.jsonl resiste writes concurrentes, (c) hook errors actuales (EEXIST/parser) realmente quedan resueltos.

---

## Sprint 2 — Intent Dispatcher (CORE) ⚡

**Goal:** UserPromptSubmit hook que clasifica intent del usuario → propone/inyecta la skill correcta antes de que Claude responda. **Pieza arquitectónica clave del overhaul.** Este sprint mata los problemas #1 (token waste por load-everything) y #2 (no auto-trigger).

### DONE criteria

- [ ] `intent-dispatcher.py` instalado y wired en `~/.claude/settings.json` UserPromptSubmit
- [ ] Lógica de clasificación: keywords + slash commands + contexto sesión + manifest lookup
- [ ] Output JSON estandarizado:
  ```json
  {
    "suggested_skill": "superpowers:systematic-debugging",
    "confidence": 0.85,
    "reason": "keywords: 'bug', 'no funciona'",
    "memory_layer_to_load": "L1/recent-decisions.md",
    "fallback": "ULTRON MEDIUM"
  }
  ```
- [ ] Hookify rules YAML en `~/.ultron/config/intent-rules.yaml` editables sin tocar Python
- [ ] **8 test prompts canónicos** clasifican correctamente (passing en `test_intent_dispatcher.py`):
  - [ ] "corrígeme este bug en X" → `superpowers:systematic-debugging` o `terry-davis`
  - [ ] "diseña la arquitectura de Y" → `agent-skills:plan` + sugiere ULTRA mode
  - [ ] "cómo va el proyecto Nexus" → ULTRON memory wake-up (L1 projects-active)
  - [ ] "revísame este código" → `superpowers:requesting-code-review`
  - [ ] "haz tests para Z" → `superpowers:test-driven-development`
  - [ ] "crea un skill de A" → `skill-creator:skill-creator`
  - [ ] "investiga B en internet" → `Agent(Explore)` + WebSearch
  - [ ] "qué decidimos sobre C" → ULTRON `brain_index.py query "C"`
- [ ] Performance: hook completa en **<200ms** (medido con `time.perf_counter`)
- [ ] **Fallback graceful**: si dispatcher crashea, prompt pasa al modelo sin modificación (try/except global → return passthrough)
- [ ] Confidence reporting: surface `[routing: ~80% X — señal parcial con Y]` cuando confianza 60-80%
- [ ] Override: usuario puede desactivar dispatch con flag `/no-route` en su prompt
- [ ] Telemetry: cada dispatch loggeado en `~/.ultron/telemetry/dispatcher-events.jsonl`

### Files

- **Create**: `C:\Users\USER\.claude\skills\ultron\hooks\intent-dispatcher.py`
- **Create**: `C:\Users\USER\.ultron\config\intent-rules.yaml` (hookify rules)
- **Modify**: `C:\Users\USER\.claude\settings.json` (add UserPromptSubmit hook entry — encadenado con `mode-trigger.py` existente)
- **Modify**: `C:\Users\USER\.claude\skills\ultron\hooks\routing-telemetry.py` (add dispatch events)
- **Create**: `C:\Users\USER\.claude\skills\ultron\tests\test_intent_dispatcher.py` (8 canonical tests + fallback test + perf test)
- **Create**: `C:\Users\USER\.ultron\plans\2026-MM-DD-sprint-2-dispatcher.md`

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Misclassification** → wrong skill surfaced → USER se frustra MÁS | **CRITICAL** | Confidence threshold ≥70%, fallback graceful, easy bypass `/no-route`, telemetry para tuning |
| Performance regression — cada prompt paga el cost | High | Target <200ms estricto, caché de classification por prompt fingerprint |
| Rules YAML drift vs Python logic | Medium | Tests automatizados (8 canónicos + cualquiera nuevo añadido) |
| Hook crash → bloquea TODO prompt | **CRITICAL** | Try/except global, log error a `~/.ultron/logs/dispatcher-errors.log`, return passthrough sin modificar prompt |
| Conflicto con `mode-trigger.py` existente | Medium | Encadenar: mode-trigger primero (registra modo) → intent-dispatcher después (sugiere skill) |

### Peer Review

**MaxTriple (Codex + Gemini, 5 rounds)** — esto es la decisión IRREVERSIBLE de la arquitectura. Si el dispatcher tiene un bug de diseño, todos los pilares posteriores heredan el problema. Codex valida lógica + perf; Gemini valida design vs alternativas (e.g., "¿deberías usar embeddings en lugar de keywords?").

---

## Sprint 3 — 3-Layer Memory

**Goal:** Estratificar la memoria en 3 capas explícitas con políticas de carga claras. Eliminar el "load everything" implícito que infla el contexto a 150K+ tokens.

### DONE criteria

- [ ] **L0 pinned** generator: `generate_L0.py` produce `~/.ultron/.tmp/L0-pinned.md` (≤200 tokens) conteniendo:
  - Identidad USER (1 línea)
  - Foco actual (proyecto activo + tarea)
  - BLOCKING items (si los hay)
  - Modo recomendado (LOW/MED/HIGH)
- [ ] L0 regenerado en SessionStart hook (extender `session-init.ps1` actual)
- [ ] **L1 on-intent**: dispatcher (Sprint 2) decide qué L1 file cargar según intent
- [ ] L1 topics canónicos creados (auto-poblados por scripts existentes):
  - [ ] `~/.ultron/memory/L1/projects-active.md` ← lee de `cockpit/projects.json`
  - [ ] `~/.ultron/memory/L1/skills-routing.md` ← lee de manifest (S4 dependency, mock por ahora)
  - [ ] `~/.ultron/memory/L1/recent-decisions.md` ← lee de últimas 10 sesiones
  - [ ] `~/.ultron/memory/L1/system-state.md` ← versión, hooks status, plugins activos
- [ ] **L2 queryable**: `brain_index.py query` ya es L2 — añadir gate explícito "solo se invoca por dispatcher o petición usuario"
- [ ] Test medible: sesión sin trigger especial carga **solo L0 (~200 tok)** → verificar vs baseline Sprint 0
- [ ] Test: prompt "qué decidimos sobre X" → dispatcher carga `L1/recent-decisions.md` → responde sin tocar L2
- [ ] Test: prompt "busca en knowledge sobre Y" → dispatcher invoca L2 brain_index
- [ ] Documentación: `~/.ultron/docs/memory-layers.md` con políticas de carga, refresh, gates

### Files

- **Create**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\generate_L0.py`
- **Create**: `C:\Users\USER\.ultron\memory\L1\projects-active.md` (+ generator)
- **Create**: `C:\Users\USER\.ultron\memory\L1\skills-routing.md`
- **Create**: `C:\Users\USER\.ultron\memory\L1\recent-decisions.md`
- **Create**: `C:\Users\USER\.ultron\memory\L1\system-state.md`
- **Modify**: `C:\Users\USER\.ultron\hooks\session-init.ps1` (add L0 generation step)
- **Modify**: `intent-dispatcher.py` (Sprint 2) — add L1 routing logic
- **Modify**: `C:\Users\USER\.claude\skills\ultron\CLAUDE.md` (replace "load context.md" with explicit L0/L1/L2 protocol)
- **Create**: `C:\Users\USER\.ultron\docs\memory-layers.md`
- **Create**: `C:\Users\USER\.ultron\plans\2026-MM-DD-sprint-3-memory.md`

### Risks

| Risk | Mitigation |
|------|------------|
| L0 staleness (foco actual desactualizado) | Regen on every SessionStart + comando `ultron focus <X>` para forzar update |
| L1 misrouting (dispatcher carga L1 incorrecto) | Telemetry + fallback a L2 query si L1 no responde a la pregunta |
| Migración de current `INDEX.md` (L1 hot legacy) | Keep `INDEX.md` como L1 master pointer; granular L1 files cargan según intent específico |
| Tokens L0 desbordan 200 | Hard limit en generator + truncate con prioridad: BLOCKING > foco > resto |

### Peer Review

**MaxDual** al cierre.

---

## Sprint 4 — Skills Manifest YAML (Single Source of Truth)

**Goal:** `skills.manifest.yaml` como fuente única de verdad. Cambias un skill → tocas 1 archivo, no decenas.

### DONE criteria

- [ ] `skills.manifest.yaml` generado desde estado actual (extender `skill_manifest.py` existente)
- [ ] Schema definido y validado contra JSON Schema:
  ```yaml
  - name: superpowers:writing-plans
    source: plugin              # built-in | plugin | mcp | persona | hookify
    triggers: [planning, plan, design]
    cost_tier: medium           # low | medium | high | ultra
    dispatcher_priority: 2      # 1-5 per S0 hierarchy
    deprecated: false
    replaces: []                # list of skill names this supersedes
    last_used: 2026-05-04
  ```
- [ ] `intent-dispatcher.py` (Sprint 2) refactor: lee del manifest, no de SKILL.md hardcoded
- [ ] `registry_sync.py` valida manifest vs estado real (skills installed) en cada sync — reporta drift
- [ ] CLI commands añadidos a `ultron.ps1`:
  - [ ] `ultron manifest validate` → drift report (no auto-fix)
  - [ ] `ultron manifest add <skill> --source <X> --priority <N>`
  - [ ] `ultron manifest deprecate <skill> [--replaced-by <Y>]`
  - [ ] `ultron manifest list [--deprecated] [--source <X>]`
- [ ] Documentación: `~/.ultron/docs/skills-manifest-schema.md`
- [ ] Migración: `SKILL.md` de ULTRON ahora referencia manifest en lugar de duplicar info (single source enforced)

### Files

- **Create**: `C:\Users\USER\.ultron\skills.manifest.yaml`
- **Create**: `C:\Users\USER\.ultron\config\skills-manifest-schema.json` (JSON Schema)
- **Modify**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\skill_manifest.py` (output canonical YAML + schema validation)
- **Modify**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\registry_sync.py` (validate against manifest)
- **Modify**: `intent-dispatcher.py` (Sprint 2) → read priorities/triggers from manifest
- **Modify**: `C:\Users\USER\.claude\skills\ultron\SKILL.md` (replace hardcoded skill lists with manifest refs)
- **Modify**: `C:\Users\USER\.claude\skills\ultron\scripts\ultron.ps1` (add `manifest` subcommand)
- **Create**: `C:\Users\USER\.ultron\docs\skills-manifest-schema.md`
- **Create**: `C:\Users\USER\.ultron\plans\2026-MM-DD-sprint-4-manifest.md`

### Risks

| Risk | Mitigation |
|------|------------|
| Manifest drift (real state ≠ manifest) | Validate cada sync + warn user; exit code != 0 si drift detected |
| YAML anchor/alias complexity → ilegible | Keep schema flat, no usar refs, máx 2 niveles nesting |
| Breaking scripts que leen SKILL.md directo | Keep SKILL.md como vista estable derivada del manifest (genera on update) |
| Manifest se vuelve enorme (>1000 lines) | Split por source: `skills.manifest.yaml` + `plugins.manifest.yaml` + `mcps.manifest.yaml` si necesario |

### Peer Review

**MaxDual** al cierre.

---

## Sprint 5 — ultron doctor v2 (Self-Healing)

**Goal:** CLI command `ultron doctor` que escanea cruft, valida manifest, audita hooks, reporta y propone cuts con confirmación. Self-healing real, no autodestructivo.

### DONE criteria

- [ ] CLI: `ultron doctor` → reporte completo (cruft scan + manifest drift + hooks audit + L0/L1 staleness)
- [ ] CLI: `ultron doctor --fix` → propone cambios → pide confirmación cada uno → aplica
- [ ] CLI: `ultron doctor --dry-run` → solo reporte, no cambios
- [ ] CLI: `ultron doctor --json` → output machine-readable
- [ ] **Detecciones implementadas:**
  - [ ] Orphan paths (`.ultron/` carpetas sin referencia en scripts activos)
  - [ ] Skills/plugins instalados pero ausentes de manifest (Sprint 4 dep)
  - [ ] Skills en manifest pero no instaladas
  - [ ] Scripts referenciados en hooks (`settings.json`) pero archivo no existe
  - [ ] L0 stale (>4h)
  - [ ] L1 files staler than configured threshold
  - [ ] Session logs >30 días
  - [ ] Backup snapshots >90 días
  - [ ] Telemetry files >180 días
  - [ ] **Alerts bus health** (S1 dep): unacked `blocking` alerts >24h sin atender → reportar; alerts.jsonl >10MB → sugerir `purge --older-than 30d`
- [ ] Output formato: tabla coloreada (PowerShell host) o JSON (`--json`)
- [ ] Reglas configurables en `~/.ultron/config/doctor-rules.yaml` (retention policies, cruft patterns)
- [ ] Integración cron-like: opt-in via flag `auto_doctor: true` en config → trigger semanal en Stop hook (silencioso, solo reporta si encuentra issues)
- [ ] Tests: `test_doctor.py` con casos sintéticos (orphan path, manifest drift, stale memory)

### Files

- **Create**: `C:\Users\USER\.claude\skills\ultron\scripts\cockpit\doctor.py`
- **Modify**: `C:\Users\USER\.claude\skills\ultron\scripts\ultron.ps1` (add `doctor` subcommand)
- **Create**: `C:\Users\USER\.ultron\config\doctor-rules.yaml`
- **Create**: `C:\Users\USER\.claude\skills\ultron\tests\test_doctor.py`
- **Modify** (potential): `~/.ultron/hooks/stop-memory-sync.ps1` (auto-doctor trigger opt-in)
- **Create**: `C:\Users\USER\.ultron\plans\2026-MM-DD-sprint-5-doctor.md`

### Risks

| Risk | Mitigation |
|------|------------|
| **False positive: borra algo activo** | `--confirm` por defecto, `--dry-run` available, `--fix` gates each change individually |
| Slow scan en repos grandes | Caché de hashes, scan incremental, `--quick` flag para audit superficial |
| Cron trigger interrumpe trabajo | Opt-in solo, runs via Stop hook (al cerrar sesión, no durante), silencioso si todo OK |
| Detección de orphan paths borra archivos del usuario por error | Whitelist explícita en `doctor-rules.yaml` para paths protegidos |

### Peer Review

**MaxDual** al cierre. Validar especialmente que `--fix` no borra nada sin confirmación + que el whitelist es respetado.

---

## Sprint 6 — Public Portfolio Repo (post-release)

**Goal:** Publicar un mirror sanitizado de ULTRON en un repo público de GitHub para portfolio profesional. Sin keys, sin rutas personales, sin transcripts privados, sin info sensible — pero conservando la arquitectura, skills, hooks, scripts y plans para que sea evidencia tangible del sistema.

**Pre-requisito:** S5 cerrado (release v14.0.0 estable). No tiene sentido publicar mid-overhaul.

### DONE criteria

- [ ] **Sanitization spec** documentada en `~/.ultron/docs/public-publish-policy.md`:
  - Lista exhaustiva de qué incluir vs qué strippear
  - Reglas de find-replace (paths, keys, emails, nombres reales, UUIDs sesión)
  - Whitelist explícita de archivos OK para publicar
- [ ] **`.publicignore`** definido en `~/.ultron/config/publicignore.txt` (sintaxis estilo `.gitignore`):
  - `settings.json` con keys reales (publica un `settings.example.json` sanitizado)
  - `~/.ultron/memory/` (memorias personales)
  - `~/.claude/projects/*/` (transcripts JSONL — todos)
  - `~/.ultron/telemetry/` (UUIDs + métricas personales)
  - `~/.ultron/backups/` (backups con datos reales)
  - `~/.ultron-vault/` (vault Obsidian — opcional, decidir)
  - `~/.ultron/.tmp/`, `~/.ultron/.tmp.driveupload/`
  - `~/.ultron/alerts.jsonl` y `alerts/archive/`
  - Cualquier `*.bak*`, `*.log`
- [ ] **Publish script** `~/.ultron/scripts/publish/publish-public.ps1`:
  - Idempotente (re-ejecutable sin destruir trabajo)
  - **Silent execution** (cumple política S1 — `-WindowStyle Hidden`, no popups)
  - Steps: (1) mkdir `~/.ultron-public/`, (2) mirror copy con `.publicignore`, (3) find-replace pass: `C:\Users\USER\` → `${ULTRON_HOME}`, `user@example.com` → `<email>`, API keys → `<your-api-key>`, GitHub username → `<your-gh>`, (4) generar `settings.example.json` desde `settings.json` real strippeando keys, (5) generar `README.md` portfolio, (6) `git init` + commit
  - **Dry-run mode** `--dry-run` muestra qué se publicaría sin escribir
  - Checksum/diff report al final: cuántos archivos publicados, cuántos skipped, cuántos sanitized
- [ ] **Sanitization tests** `~/.claude/skills/ultron/tests/test_publish_sanitize.py`:
  - Genera output → grep para `USER` (case-insensitive), API key patterns (`sk-`, `AIza`, `ghp_`, `OPENAI_API_KEY`), email real, paths absolutos Windows → debe ser 0 hits
  - **Critical**: tests deben fallar el publish si encuentran cualquier match
- [ ] **Portfolio README** `~/.ultron-public/README.md` (Markdown rico, screenshots OK):
  - Pitch en 3 líneas: "ULTRON is a personal AI orchestrator built on Claude Code that..."
  - Architecture diagram (puede ser ASCII o Mermaid)
  - Sprint history (resumen de v6 → v14, lecciones aprendidas)
  - Tech stack badges (Python, PowerShell, YAML, FTS5, Claude Code hooks)
  - Highlight sprints como showcase: dispatcher pattern (S2), 3-layer memory (S3), manifest single-source (S4), self-healing doctor (S5)
  - Disclaimer: "this is a personal config — clone for inspiration, not as drop-in install"
  - Link al master plan público (auto-publicado)
  - License: MIT o Apache-2.0
- [ ] **GitHub repo creado** (`SkiTemplar/ultron-public` o similar) — privado primero, review manual de 1-2 sesiones, luego flip a público
- [ ] **Auto-republish opcional**: hook Stop o cron-like (S5 doctor extension) — **opt-in**, NO por defecto. Re-publica solo si `~/.ultron/.publish-state` indica diff vs último publish
- [ ] **CI workflow simple** en repo público: `.github/workflows/sanity.yml` que valida sintaxis de hooks YAML/JSON/Python — demuestra rigor
- [ ] **License + Code of Conduct + Security policy** files en repo
- [ ] **Versionado**: tag `v14.1.0` al primer publish exitoso

### Files

- **Create**: `C:\Users\USER\.ultron\docs\public-publish-policy.md` (spec)
- **Create**: `C:\Users\USER\.ultron\config\publicignore.txt`
- **Create**: `C:\Users\USER\.ultron\scripts\publish\publish-public.ps1`
- **Create**: `C:\Users\USER\.ultron\scripts\publish\sanitize.py` (find-replace engine via `uv run`)
- **Create**: `C:\Users\USER\.claude\skills\ultron\tests\test_publish_sanitize.py`
- **Create**: `C:\Users\USER\.ultron-public\` (output mirror, gitignored del workspace personal)
- **Create**: `C:\Users\USER\.ultron\plans\2026-MM-DD-sprint-6-public.md`

### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Leak de API key o secreto a repo público** | **CRITICAL** | Sanitization tests bloquean publish si encuentran cualquier patrón sospechoso; manual review pre-flip-público; private repo primero |
| **Leak de PII** (emails, nombres, paths) | **CRITICAL** | Tests grep estrictos; whitelist explícita; review manual antes de flip-public |
| **Leak de session transcripts** (.jsonl con conversaciones privadas) | **CRITICAL** | `.publicignore` excluye `~/.claude/projects/` entero; test verifica zero `.jsonl` en output |
| Re-publish overwriteo trabajo del repo público (si edito allí directamente) | Medium | `publish-public.ps1` siempre push a branch `auto/sync` con PR, nunca merge automático |
| Repo público quema mi tiempo respondiendo issues | Low | README dice claramente "personal config, no drop-in support"; issue template canalizando |
| ULTRON pierde su edge competitivo si todo está público | Low | Es portfolio, no producto; el "edge" es el uso continuado + memoria personal, no el código |
| `.publicignore` se desactualiza tras nuevos sprints | Medium | Test `test_publish_sanitize.py` corre en cada publish + en S5 doctor scan |

### Peer Review

**MaxDual** + **manual security review** (USER lee los primeros 100 commits del repo público antes de flip-público). Criterio bloqueante: 0 keys + 0 PII + 0 paths reales en grep.

---

## Cross-Cutting Conventions

**Backups:** Cada sprint crea snapshot en `~/.ultron/backups/2026-MM-DD-pre-S<N>/` antes de cualquier cambio destructivo. Snapshot contiene: settings.json, archivos a modificar, tarball de archivos a borrar.

**Telemetry:** Todos los sprints loggean a `~/.ultron/telemetry/v14-overhaul/sprint-<N>.jsonl` para post-mortem y métricas comparables (tokens/sesión PRE vs POST).

**Versioning bumps:** Al cierre de cada sprint:
- S0 → 13.3.0 ✅ (CLEAN HOUSE — done 2026-05-04)
- S1 → 13.4.0 (SILENT + ALERTS)
- S2 → 13.5.0 (DISPATCHER)
- S3 → 13.6.0 (LAYERED MEMORY)
- S4 → 13.7.0 (MANIFEST)
- **S5 → 14.0.0 (release final — MODULAR)**
- **S6 → 14.1.0 (post-release publication — PORTFOLIO)**

Changelog actualizado en `~/.claude/skills/ultron/references/changelog.md`.

**Rollback:** Cada sprint tiene `rollback.ps1` en su backup folder. One-shot revert.

**No-Touch List** (preservar a través de TODOS los sprints — verificado en Sprint 0 diagnóstico):

Scripts cockpit verificados (✅ en CAPACIDADES ACTIVAS v13.1.0):
- `brain_index.py`, `brain_config.py`
- `memory_sync.py`, `decay_queue.py`, `session_compactor.py`
- `vault_migrator.py`, `memory_bridge.py`, `retention.py`
- `telemetry.py`, `skill_manifest.py`
- `launch_project.py`, `scan_projects.py`
- `auto_updater.py`, `audit_to_pending.py`
- `registry_sync.py`, `skill_discover.py`

Hooks que ya funcionan (no tocar comportamiento, solo extender):
- `~/.ultron/hooks/session-init.ps1`
- `~/.ultron/hooks/stop-memory-sync.ps1`
- `~/.claude/skills/ultron/hooks/auto-approve-readonly.py`
- `~/.claude/skills/ultron/hooks/block-dangerous-bash.py`
- `~/.claude/skills/ultron/hooks/routing-telemetry.py`
- `~/.claude/skills/ultron/hooks/track-knowledge-reads.py`
- `~/.claude/skills/ultron/hooks/mode-trigger.py`
- `~/.claude/skills/ultron/hooks/session-log.py`

Knowledge layer:
- `~/.ultron-vault/` entero (538 notas, canonical) — solo cambios estructura-respetuosos

---

## Self-Review (post-write)

**1. Spec coverage** — los 11 problemas reportados (9 originales + 2 añadidos en revisión 2026-05-04):

| # | Problema | Sprint que lo resuelve |
|---|----------|------------------------|
| 1 | Token waste (66% subagents, 65% >150K) | S2 (dispatcher) + S3 (3-layer memory) |
| 2 | ULTRON no auto-trigger | S2 (dispatcher es exactamente esto) |
| 3 | ultron-vault no auto-update | S3 (L1 explícito) + S5 (doctor scan) |
| 4 | `.ultron/` carpetas antiguas | S0 ✅ (cleanup) + S5 (doctor recurrente) |
| 5 | Sincronización caótica | S4 (manifest único) |
| 6 | Memoria no aplicada | S3 (capas explícitas con políticas) |
| 7 | "fix X" no busca skill | S2 (dispatcher) |
| 8 | Scripts abren pestañas | S1 (silent audit — pilar A) |
| 9 | No self-healing/organizing | S5 (doctor v2) + S3 (auto-regen L0/L1) |
| 10 | **Scripts silenciosos no pueden avisar de errores críticos** | **S1 (alerts bus — pilar B)** |
| 11 | **Sin showcase público del trabajo (portfolio)** | **S6 (public portfolio repo)** |

**2. Placeholder scan**: ✅ No hay TBD/TODO/"implement later". Cada DONE criterion es verificable.

**3. Type/name consistency**:
- ✅ `intent-dispatcher.py` consistente en S2/S3/S4
- ✅ `skills.manifest.yaml` consistente en S4/S5
- ✅ `alerts.jsonl` + `alerts.py` + `write-alert.ps1` consistente en S1/S5
- ✅ Paths absolutos `C:\Users\USER\` en lugar de mix `~/` (mejor para Windows tools)
- ✅ Sprint numbering S0-S6 consistente

---

## Execution Handoff

**Estado actual (2026-05-04):** Sprint 0 cerrado en v13.3.0 "CLEAN HOUSE". Plan v2 ampliado con alerts bus (S1) y Sprint 6 (Public Portfolio Repo).

**Próximo paso:** Sprint 1 — Silent Execution + Alerts Bus.

**Modo de ejecución para S1-S6:** **Subagent-Driven** (`superpowers:subagent-driven-development`) — cada sprint lanza su propio plan detallado en `~/.ultron/plans/2026-MM-DD-sprint-N-<slug>.md` y se ejecuta task-by-task con peer review (MaxDual o MaxTriple según tabla overview) al cierre.

**Versionado release:**
- v13.3.0 ✅ (S0 — CLEAN HOUSE)
- v13.4.0 → v13.7.0 (S1-S4, releases internas)
- **v14.0.0** (S5 — release final MODULAR)
- **v14.1.0** (S6 — PORTFOLIO público post-release)

**Cambios clave en plan v2 (2026-05-04):**
- Sprint 1 ahora tiene 2 pilares acoplados: Silent Execution + Alerts Bus persistente
- Sprint 5 doctor extiende para validar alerts unacked >24h
- Sprint 6 nuevo: publicación sanitizada del repo en GitHub para portfolio profesional
- Self-Review actualizado con problemas #10 (alerts) y #11 (portfolio)
