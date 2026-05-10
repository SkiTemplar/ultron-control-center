# Botón 5 — Cockpit / Scripts (Ultra Triple)

```
Ultron, /ultra /triple — Kirkardo COCKPIT Triple.

OBJETIVO:
  Auditar scripts/cockpit/, el dispatcher ultron.ps1 y la TUI según la versión
  vigente. Separar deuda real, scripts activos, scripts legacy y capacidades pendientes.

FASE 0 — CONTEXTO READ-ONLY:
  - Si existen agentes internos especializados para metadata/arquitectura/perf/contexto,
    Claude puede usarlos en paralelo.
  - Si no existen, Claude hace el inventario directo sin bloquear la auditoría.

FASE 1 — CLAUDE lee/inventaria:
  - ~/.claude/skills/ultron/CLAUDE.md
  - ~/.claude/skills/ultron/SKILL.md
  - ~/.claude/skills/ultron/scripts/cockpit/ (listado completo + tamaños + last_modified)
  - ~/.claude/skills/ultron/scripts/cockpit/ultron.ps1
  - ~/.claude/skills/ultron/scripts/cockpit/cockpit_base.py
  - ~/.claude/skills/ultron/scripts/cockpit/health.py
  - ~/.claude/skills/ultron/scripts/cockpit/auto_updater.py
  - ~/.claude/skills/ultron/scripts/cockpit/audit_to_pending.py
  - ~/.claude/skills/ultron/scripts/cockpit/pending_actions.py
  - ~/.claude/skills/ultron/scripts/cockpit/apply_proposals.py
  - ~/.claude/skills/ultron/scripts/cockpit/skill_manifest.py
  - ~/.claude/skills/ultron/scripts/cockpit/registry_sync.py
  - ~/.claude/skills/ultron/scripts/cockpit/route_quality_aggregator.py
  - ~/.claude/skills/ultron/scripts/cockpit/cleanup_inventory.py
  - ~/.claude/skills/ultron/scripts/cockpit/tui.py
  - tests relevantes del directorio si existen.
  - DEPRECADOS declarados en CLAUDE.md.

FASE 2 — CODEX peer (--sandbox read-only):
  - Deuda técnica P0/P1/P2 por script con archivo:línea.
  - Dispatcher: subcomandos cableados, scripts inexistentes y mensajes de deprecación.
  - Tests: cobertura real de paths críticos.
  - Patrones repetidos que merecen utility común.
  - Error handling: exceptions tragadas, logs pobres, exit codes ambiguos.
  - Encoding: UTF-8, UTF-8-SIG, BOM y drift CP1252.
  - Existence gate: claims activos en CLAUDE.md/SKILL.md vs scripts verificables.

FASE 3 — GEMINI peer (sin filesystem; internet actual):
  - Comparar contra patrones actuales de orquestadores locales y CLIs Python.
  - Evaluar Typer/Click vs PowerShell dispatcher para este caso.
  - ROI de migrar dispatcher a Python CLI unificado.
  - Cobertura mínima de tests para CLIs similares.
  - Telemetría local ligera: opciones actuales y coste operativo.

FASE 4 — INTEGRACIÓN (Claude):
  - Inventario: N ACTIVE · N PENDING · N DEPRECATED · N UNTESTED · N BROKEN.
  - Nota Kirkardo COCKPIT X/10 (40% Claude / 30% Codex / 30% Gemini).
  - TOP 5 FIX P0/P1 con script:línea + patch sugerido.
  - TOP 5 refactors: utility extraction, dedup, modernización.
  - Decisión: ¿migrar dispatcher a Python? sí/no + por qué.
  - Roadmap: patch de deuda vs minor/ARCH si cambia arquitectura.
  - Lista DEPRECATED a borrar definitivamente, si procede.

OUTPUT:
  - ~/.ultron/cockpit/audits/kirkardo-cockpit-{TODAY}.md
  - ~/.ultron/cockpit/audits/kirkardo-cockpit-nota-{TODAY}.md (≤20 líneas)
  - ~/.ultron/cockpit/audits/kirkardo-cockpit-inventory-{TODAY}.json
    (script | status | LOC | tests | last_modified | dispatcher_wired)
```
