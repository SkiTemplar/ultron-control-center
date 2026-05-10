---
type: roadmap
date: 2026-05-03
target: ULTRON v13.0 → v14.0
goal: subir nota Kirkardo de 6.0 a 9.5/10
predecessor_audits:
  - kirkardo-total-2026-05-03.md (AM, 4.4/10)
  - kirkardo-total-v2-2026-05-03.md (PM, 6.0/10)
  - ULTRON-v13.0-arch-01-ssot.md (blueprint AM)
estimated_effort: 6-10 semanas
sprints: 5
---

# ULTRON Roadmap to 9.5/10

> Combina Camino A (incremental ARCH-01 + closure) + Camino B (radical Gemini SOTA: sandbox + code graph). Los dos auditores externos (Codex + Gemini) coinciden: ARCH-01 SSOT es bloqueante y código load-bearing huérfano (route_quality.py:155-196) es deuda crítica.

---

## Estado punto de partida (2026-05-03 PM, post-v12.6 closure)

| Métrica | Valor |
|---|---|
| Nota global | **6.0/10** Aprobado_con_reservas |
| pending_actions abiertos | 3: ARCH-01, OPS-01, LRN-01 |
| pending_actions resueltos hoy | SEC-01, SEC-02, LIST-FIX |
| settings.json:132 skipDangerous | ✅ false |
| gitleaks 8.30.1 | ✅ instalado (winget) |
| .ultron/.tmp.driveupload | ✅ purgado |
| history.jsonl.bak | ✅ deleted |
| Vault `.gitleaks.toml` | ✅ synced from cockpit |
| Tokens cloud | ✅ 4 críticos rotados (Anthropic + OpenAI + Supabase + Google) |
| OAuth opcionales (Notion/Linear/Slack/Figma/EGnyte) | pending — riesgo aceptado |
| Gemini 3-pro-preview en Triple Mode | ✅ shared-duet.ps1:30,208 alias resolution |

**Brecha a 9.5:** 3.5 puntos. Distribución estimada por sprint:

| Sprint | Lift | Notes |
|---|---|---|
| Sprint 1 (v12.6 final + Gemini 3) | +0.3 | hook tests + cleanup tail |
| Sprint 2 (v13.0 ARCH-01 + path resolver) | +1.2 | bottleneck #1 |
| Sprint 3 (v13.0 OPS-01 + secret manager) | +0.7 | reliability + cap removal |
| Sprint 4 (v13.1 LRN-01 telemetry → routing) | +0.7 | bottleneck #2 |
| Sprint 5 (v14.0 sandbox + code graph) | +0.6 | radical Gemini path |
| **Total** | **+3.5** | **9.5/10** |

---

## SPRINT 1 — v12.6 "Containment" final (esta semana, 1-2 días)

**Goal:** Cerrar v12.6 al 100%. Lift +0.3 → 6.3/10.

### Tasks

- [x] Cleanup post-rotación (delete .bak + purge .tmp.driveupload + sync gitleaks.toml + commit vault + resolve SEC-01 + D3 + gitleaks install) — **DONE este session**
- [x] shared-duet.ps1 alias `pro` → `gemini-3.1-pro-preview` — **DONE este session**
- [ ] **Hook test corpus** (Codex priority FIX-2):
  - `tests/hooks/test_block_dangerous_bash.py` con 30+ malicious strings
  - `tests/hooks/test_auto_approve_readonly.py` con 20 sensitive paths + 10 WebFetch denylist
  - `tests/hooks/stop_memory_sync.Tests.ps1` con timeout/race scenarios
  - Target coverage: 0% → 80%
  - Effort: 4-6h
- [ ] **M-MED-3 brain_index SKIP_PATTERNS Path.parts fix** (1h)
- [ ] **M-LOW-1 memory_bridge.py:329 wikilink_re fix** (30min)
- [ ] **stop-memory-sync.ps1 session_compactor wrap** `Start-Job + Wait-Job -Timeout 60` (1h)
- [ ] **session-init.ps1 timeouts** subprocess + git push (mover push-queue a deferred background_tasks daily, 1-2h)
- [ ] **Gemini 3 ad-hoc CLI fix:** crear PowerShell function en `$PROFILE`:
  ```powershell
  function gem3 {
      gemini -m gemini-3.1-pro-preview --approval-mode plan @args
  }
  function gemflash {
      gemini -m gemini-3-flash-preview --approval-mode plan @args
  }
  ```
  Más: test alternative env var `GEMINI_MODEL=gemini-3.1-pro-preview`. Si CLI lo respeta, añadir a $PROFILE.

### Acceptance criteria

- pending_actions list muestra solo ARCH-01/OPS-01/LRN-01 abiertos.
- `pwsh tests/hooks/...` pasa todos los tests.
- session-init.ps1 < 200ms wall clock (vs hoy variable por subprocess + git).
- `gem3 "test"` ejecuta con gemini-3.1-pro-preview transparentemente.

### Output

- ~/.claude/skills/ultron/tests/hooks/ (nuevo dir, 4-5 archivos test)
- Hook tests CI gate documentado en `~/.claude/skills/ultron/CLAUDE.md`
- Updated $PROFILE con gem3/gemflash functions

---

## SPRINT 2 — v13.0 "Foundation" parte 1: ARCH-01 SSOT contractual (1-2 semanas)

**Goal:** UN canonical schema, UN writer, contratos enforced. Lift +1.2 → 7.5/10.

**Bottleneck eliminado:** SKL 5.6 → 8.0, ARCH 5.0 → 8.0, COCKPIT 6.4 → 7.5.

### Tasks

- [ ] **F12 Path resolver primero** (1d) — bloqueante para todo lo demás
  - `~/.claude/skills/ultron/scripts/cockpit/ultron_paths.py`: lee `~/.ultron/paths.json`, expone constantes (ULTRON_HOME, COCKPIT, VAULT, CLAUDE_HOME, TMP, BRAIN_INDEX_DB, etc.). Env vars como override.
  - `~/.claude/skills/ultron/scripts/ultron-paths.ps1`: dot-source equivalent.
  - Migrate cockpit Python scripts: import `from ultron_paths import *` reemplazando `Path.home() / ...`.
  - **Cierra _categorize_skills.py:458 hardcode automáticamente.**
  - Acceptance: 0 hardcoded `C:\Users\USER` en codebase (grep test).

- [ ] **F2 Frontmatter contract + CI gate** (3d)
  - Schema: `name`, `description≤200`, `kind: persona|plugin|skill|agent|meta`, `tier: L1|L2|L3`, `category: <enum>`, `last_verified: YYYY-MM-DD`.
  - Writer: `cockpit/skill_manifest_validate.py` que recorre `~/.claude/skills/*/SKILL.md`, valida, lista violaciones.
  - Backfill: `cockpit/frontmatter_backfill.py` que lee `skill_manifest.json` y escribe campos missing en cada SKILL.md (idempotente).
  - CI gate: `cockpit/skill_manifest.py rebuild` falla si `validate` retorna issues.
  - Acceptance: 100% SKILL.md con frontmatter completo (vs 0/30 hoy).

- [ ] **FIX-3 SSOT consolidación** (3-4d)
  - Designar `skill_manifest.json` como único canonical writer.
  - Borrar `~/.ultron/skills-registry.json` — derive `registries[]` de `present_in[]` del manifest. Adaptar `registry_sync.py` para leer del manifest, escribir solo cache derivado.
  - Borrar `~/.ultron/agent_manifest.json` — merge en `skill_manifest.json` con `kind:agent`.
  - `claude_exclusive` flag al manifest schema; remove hardcoded set en `registry_sync.py:50-58`.
  - **Personas en manifest:** las 14 con `kind:persona, id estable`. Generadores derivan:
    - `routing-tables.md` ← `cockpit/skill_manifest_to_routing_md.py`
    - `routing-telemetry.py:PERSONAS` ← `cockpit/skill_manifest_to_routing_telemetry.py` (genera el set Python)
    - `skill_manifest.py:_ULTRON_PERSONAS` ← compute en runtime de manifest
    - `tui.py:1140 LAYER1_PERSONAS` ← compute en runtime
  - Hook ya NO hardcodea. Caso `Kirkardo`/`kirkardo` duplicate desaparece (manifest tiene canonical name `repo-evaluator`).
  - Acceptance: grep `PERSONAS` en codebase retorna 1 sitio (manifest), generadores leen de ahí.

### Acceptance criteria global Sprint 2

- 1 manifest, 1 writer, 1 persona list, 1 path resolver.
- `skill_manifest_validate.py` retorna 0 issues.
- `_categorize_skills.py:458` hardcode eliminado.
- ARCH-01 marked `resolved` en pending_actions.
- Re-audit Kirkardo SKL → 8.0, ARCH → 8.0, COCKPIT → 7.5.

### Output

- ~/.claude/skills/ultron/scripts/cockpit/{ultron_paths.py, skill_manifest_validate.py, frontmatter_backfill.py, skill_manifest_to_routing_md.py, skill_manifest_to_routing_telemetry.py}
- ~/.ultron/paths.json
- skill_manifest.json (schema extendido con personas + agents + claude_exclusive)
- DELETED: skills-registry.json, agent_manifest.json
- Updated: registry_sync.py, _categorize_skills.py, routing-telemetry.py, tui.py:1140, skill_manifest.py:42

---

## SPRINT 3 — v13.0 "Foundation" parte 2: OPS-01 + Secret Manager + Hook AST (1-2 semanas)

**Goal:** Reliability + cap removal. Lift +0.7 → 8.2/10.

### Tasks

- [ ] **F1 Secret Manager CLI integration** (3d)
  - Decisión: Doppler vs `op` (1Password CLI) vs Hashicorp Vault. Recomendación: **Doppler** (mejor DX, free tier suficiente single-user).
  - `cockpit/secrets_loader.py` (replace existing PowerShell version): lee Doppler config + cachea env vars en sesión.
  - `.credentials.json` migrate: extract todos los OAuth tokens + clientSecrets a Doppler. Encrypt local copy con DPAPI o delete si Doppler es source of truth.
  - PowerShell `$PROFILE` invoca secrets_loader on shell start.
  - Acceptance: `.credentials.json` < 1KB (solo metadata, no tokens). VAULT cap removed.

- [ ] **OPS-01 Stop pipeline idempotente** (6-10h)
  - `stop-memory-sync.ps1` refactor: dispatcher con timeout global 30s wall clock.
  - Phase A en `Start-Job` paralelo: memory_bridge + brain_index + route_quality_aggregator + decay_queue + consistency-check (nuevo). `Wait-Job -Timeout 15`. Si timeout → kill + log + exit 0.
  - Phase B secuencial pero acotada: vault sync → push → compactor con timeout propio 15s.
  - **File lock en `current-session.json`:** Windows native `LockFileEx` o lock-file `.lock` con stale detection 5s.
  - **track-knowledge-reads.py + mode-trigger.py:** atomic temp-file-rename pattern para current-session.json.
  - Acceptance: Stop hook < 30s wall clock (vs ~30-60s hoy). HOOKS test corpus pasa concurrent scenarios.

- [ ] **F13 block-dangerous-bash AST con bashlex** (1d)
  - Replace regex con `bashlex` AST parsing. Detecta:
    - command substitution `$(...)`, backticks, process substitution `<(...)`
    - heredoc, eval con strings dinámicos
    - inline interpreter `python -c`, `node -e`, `perl -e`
    - exfil pipes (`| nc`, `| curl -X POST`)
    - base64 decode loops
  - Mantener legacy regex como fallback si bashlex falla parse.
  - Acceptance: 5 categorías bypass del v2 audit ahora bloqueadas.

- [ ] **F14 consistency-check rename + Stop wiring** (4h)
  - Rename `~/.claude/skills/ultron/scripts/consistency-check.py` → `consistency_check.py` (Python convention).
  - Add a Stop Phase A (paralelo). Si retorna issues → escribe a `~/.ultron/cockpit/news/ALERTS.md` + `pending_actions.py add --severity high --source consistency_check`.
  - Acceptance: SI-CRIT-4 closed.

### Acceptance criteria global Sprint 3

- `.credentials.json` < 1KB, tokens en Doppler.
- Stop hook < 30s wall clock garantizado.
- OPS-01 + LRN-01 (parcial) marked `resolved`.
- Re-audit VAULT → 8.5, HOOKS → 7.5, SLF → 7, PERF → 8.

### Output

- Doppler config + secrets manifest documentado en `~/.ultron/secrets-manifest.md`
- `cockpit/secrets_loader.py` (Python)
- Refactored `stop-memory-sync.ps1` con timeout global + Start-Job parallel
- `block-dangerous-bash.py v3.0` con bashlex
- `consistency_check.py` (renamed) wired

---

## SPRINT 4 — v13.1 "Self-Improving" telemetry → routing (1-2 semanas)

**Goal:** Sistema "mide y aprende". Lift +0.7 → 8.9/10.

### Tasks

- [ ] **F3 Bandit routing Thompson sampling** (3-4d)
  - `cockpit/route_quality.py:155-196 resolve_conflict()` — ya existe la lógica. Falta consumer.
  - Mode files: añadir a `mode-high.md` y `mode-ultra.md` § ROUTING:
    > "Cuando hay 2+ personas candidatas con priority similar, consultar `~/.ultron/skill_cache/route_quality.json`. Aplicar Thompson Sampling con floor 0.1 (preferir edge con `successes/runs > 0.7` AND `runs > 5`, fallback exploración 0.1)."
  - Implementar runtime helper: `cockpit/routing_decide.py` que el orchestrator llama con (persona_candidates, task_signal). Retorna seleccionada + confidence.
  - Telemetría feedback: routing-telemetry.py PostToolUse log de outcome (success/fail) → route_quality_aggregator computa actualización Thompson posterior.
  - Acceptance: SI-CRIT-2 + SKL-CRIT-4 closed. route_quality.py:155-196 deja de ser dead-code.

- [ ] **F11 pending_actions auto-write desde Kirkardo** (1d)
  - `cockpit/audit_index.py build` → además de INDEX.json, parsear cada audit reciente extrayendo "Top FIX críticos" + "pending" → `pending_actions.py add` automatizado.
  - Hash de detect-already-existing FIX (no duplicates).
  - Acceptance: futuros Kirkardo runs pueblan queue sin manual feed.

- [ ] **F11.5 DLQ disciplina enforced** (1d)
  - SessionStart hook: si pending_actions tiene critical/blocking action con age>24h → marca current-session.json `requiresAttention: true`.
  - mode-*.md actualizado: si requiresAttention, primer paso del flow es resolver o explicit defer con justificación.
  - Acceptance: nunca más 0/5 in_progress. Cada session toca al menos 1 pending action o documenta defer.

- [ ] **F11.6 skill-discovery → ingest pipeline** (1d)
  - `cockpit/skill_discover.py ingest`: lee `smart_analysis/converter_*.json`, añade entradas a manifest con `kind:candidate, tier:pending`.
  - `cockpit/background_tasks.py`: añadir `skill-discovery-scan` daily trigger.
  - Acceptance: SI-CRIT-5 closed. smart_analysis output deja de ser huérfano.

### Acceptance criteria Sprint 4

- LRN-01 marked `resolved`.
- Routing decisions usan route_quality (logged).
- pending_actions queue tiene state transitions reales (in_progress/resolved/notes con history).
- Re-audit SLF → 8.5, SKL → 8.5.

### Output

- `cockpit/{routing_decide.py, audit_to_pending.py, skill_discover.py:ingest}`
- Updated mode-high.md + mode-ultra.md (ROUTING section)
- Updated routing-telemetry.py (outcome reporting hook)

---

## SPRINT 5 — v14.0 "Sandboxed" radical Gemini path (3-4 semanas)

**Goal:** SOTA-grade security + code intelligence. Lift +0.6 → 9.5/10.

### Tasks (parcial — pueden hacerse selective)

- [ ] **F17 Sandbox execution (Docker)** (1-2 semanas)
  - Decommission `block-dangerous-bash.py` como primary defense (deja como tripwire diagnóstico).
  - Crear contenedor Docker minimal (alpine) con bind-mount read-only de workspace + tmpfs writable scratch.
  - Tool calls Bash routed via `docker exec` en contenedor desechable per session.
  - Tool calls Edit/Write: validar path está dentro de workspace antes de pasar a tool nativo.
  - Acceptance: malicious bash strings ejecutan SIN tocar host filesystem. Hook Security D → B+ per Gemini.

- [ ] **F18 Code graph (LSP/SCIP)** (1-2 semanas)
  - Augment FTS5 brain_index con language server backend.
  - Para Python: integrar pyright/jedi via LSP. Para TS: tsserver. Para C++/UE5: clangd.
  - `cockpit/code_graph.py`: query "find references", "definitions", "call hierarchy".
  - brain_index sigue para text search; code_graph para semantic.
  - Acceptance: Repo Knowledge D → A per Gemini.

- [ ] **F19 Structured output validation (Pydantic Instructor)** (3-5d)
  - Wrap Codex/Gemini calls que devuelven JSON con `Instructor` + Pydantic models.
  - Reemplaza regex parsing (`auto_updater.py:201` style) con tipos validados.
  - Acceptance: 0 silent parse failures en pipeline.

- [ ] **F20 (opcional) State-machine execution (LangGraph)** (1-2 semanas)
  - Reemplaza Stop hook PowerShell + Python script chain con LangGraph state machine.
  - Nodes: Phase A jobs (paralelo), Phase B jobs (secuencial), error recovery, retry.
  - Beneficio: introspection visual + retry estructurado + cycle detection.
  - **CAVEAT:** alta disrupción. Defer salvo si rest of v14.0 está listo.

### Acceptance criteria Sprint 5

- Docker sandbox activo en Bash tool calls.
- LSP code graph queryable desde brain_index.
- Pydantic Instructor en Codex/Gemini structured returns.
- Re-audit final: nota objetivo 9.5/10.

---

## Resumen ejecutivo del plan

| Sprint | Duración | Lift | Nota objetivo | Bottleneck eliminado |
|---|---|---|---|---|
| 1 v12.6 final + Gemini 3 | 1-2 días | +0.3 | 6.3 | tail cleanup |
| 2 v13.0 ARCH-01 + paths | 1-2 sem | +1.2 | 7.5 | SSOT, persona frag |
| 3 v13.0 OPS + Secret Mgr | 1-2 sem | +0.7 | 8.2 | reliability + .credentials cap |
| 4 v13.1 telemetry routing | 1-2 sem | +0.7 | 8.9 | dead consumer |
| 5 v14.0 sandbox + LSP | 3-4 sem | +0.6 | 9.5 | SOTA security + code intel |
| **Total** | **6-10 sem** | **+3.5** | **9.5** | — |

**Ruta crítica:** Sprint 1 → 2 → 3 son secuenciales (Sprint 2 depende de path resolver de Sprint 1; Sprint 3 OPS-01 depende de SSOT de Sprint 2 para no romper consumers).

**Sprint 4 puede paralelizar parcialmente con Sprint 3.**

**Sprint 5 puede saltarse selectivamente** — solo F17 (Docker sandbox) si quieres llegar exactly a 9.0; F17+F18 a 9.3; full a 9.5.

---

## Riesgos del plan + mitigaciones

| Riesgo | Mitigación |
|---|---|
| ARCH-01 SSOT migration rompe consumers existentes | Sprint 2 incluye F12 path resolver primero (foundational). SSOT migration en sub-PRs incrementales con rollback per cada borrado de manifest. |
| Doppler subscription cost | Free tier soporta single-user. Alternative: 1Password `op` (paid pero ya tienes 1Pass) o Hashicorp Vault self-hosted (free pero ops overhead). |
| LangGraph (F20) disruption | Marcado opcional. Skip si LSP + sandbox suficientes para 9.5. |
| Gemini 3-pro-preview quota limits | Triple Mode tiene fallback en shared-duet `pro-2.5` alias. Si capacity error, falla a 2.5-pro. |
| User discipline en DLQ (F11.5) | SessionStart hook fuerza acknowledgment. mode-*.md primer step requiere action o defer documentado. No depende de willpower. |

---

## Acciones inmediatas post-aprobación de este plan

1. **HOY (~30 min):** Sprint 1 task `Hook test corpus` skeleton — crear `~/.claude/skills/ultron/tests/hooks/` con 3 archivos test stubs (test_block_dangerous_bash.py, test_auto_approve_readonly.py, stop_memory_sync.Tests.ps1). Marca el inicio de la disciplina TDD.

2. **HOY (~10 min):** Añadir `gem3` y `gemflash` PowerShell functions a `$PROFILE`. Test directo: `gem3 "Hi"` debe responder con gemini-3.1-pro-preview.

3. **MAÑANA:** Sprint 1 tasks restantes (M-MED-3 + M-LOW-1 + Stop timeout + session-init purity).

4. **Esta semana:** Comenzar Sprint 2 con F12 path resolver (1 día).

5. **Re-audit cadence:** Kirkardo Total cada 2 semanas (al final de cada sprint major). Track nota delta. Si un sprint no entrega el lift previsto, root-cause en pending_actions antes de avanzar.

---

## Gemini 3.x adoption summary

| Surface | Default | How to use |
|---|---|---|
| ULTRON Triple Mode (shared-duet.ps1) | `gemini-3.1-pro-preview` | Transparente — `pro` alias resuelve auto |
| ULTRON Triple Mode flash variant | `gemini-3-flash-preview` | `--gemini-model flash` |
| Direct CLI ad-hoc | `gemini-2.5-pro` (CLI hardcoded) | `gemini -m gemini-3.1-pro-preview -p "..."` o `gem3` function |
| Settings.json `model` field | NOT respected (CLI ignores) | Set anyway for forward-compat |

**Fallbacks si capacity error:**
- shared-duet.ps1 → manual override `--gemini-model pro-2.5`
- Direct CLI → `gemini -m gemini-2.5-pro -p "..."`

**Conocido:** `gemini-3-pro` (sin `-preview`) → 404. Solo `gemini-3.1-pro-preview` y `gemini-3-flash-preview` válidos en 0.40.1.

---

**Plan generado por Claude Opus 4.7 sobre evidencia kirkardo-total-v2 + Codex critique + Gemini SOTA.**
**Próximo Kirkardo Total: post-Sprint 2 (~2 semanas), target 7.5/10.**
