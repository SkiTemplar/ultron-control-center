# ULTRON Cockpit (v12.4)

Project Manager + Mission Control layer de ULTRON.
TUI: `ultron tui` — Projects · News · Scheduler · Health · MCPs · AutoUpdater (Kirkardo only) · Skills Map & Sync

## Estructura

```
~/.ultron/cockpit/
├── projects.json         # Registry de proyectos (auto-discovered + manual edits)
├── ide-mappings.json     # Override map de IDE per-project / per-path
├── brain-config.json     # Tunables centralizados (mode_ttl, decay, etc.)
├── query-synonyms.json   # FTS5 synonym overrides (merged with built-ins)
├── news/
│   ├── news_YYYYMMDD-HHMMSS.html  # Daily AI news — HTML5 dark periódico
│   ├── ALERTS.md         # Breaking changes (auto-load próxima sesión)
│   └── seen.json         # Dedup hash
├── audits/               # Kirkardo audit reports (kirkardo-audit-YYYY-MM-DD.md + nota.md)
├── proposals/            # L2 AutoUpdater proposals (legacy, not surfaced in TUI v12.4)
├── bridge-index.json     # CC project memories bridge index
└── scheduler-logs/       # Output del Task Scheduler
    └── scan_projects.log
```

## Views del TUI (v12.4)

| Key | View | Descripción |
|---|---|---|
| `1` | Projects | Registry de proyectos con IDE launcher |
| `2` | News | Newsletter HTML5 dark periódico generado vía Gemini |
| `3` | Scheduler | Tareas programadas Windows Task Scheduler |
| `4` | Health | Verificación de subsistemas CORE |
| `5` | MCPs | Catálogo e instalación de MCP servers |
| `u` | AutoUpdater | Kirkardo Review — audit HIGH y ULTRA Triple |
| `v` | Changelog | Historial de versiones ULTRON |
| `f` | Skills | Skills Map (Layer 0/1/2) + Sync + Búsqueda + Crear |

## AutoUpdater — Kirkardo (v12.4)

El AutoUpdater solo expone 2 botones de clipboard prompt:
- **Kirkardo Review — Claude HIGH**: audit L1+L2, hallazgos priorizados, sin aplicar cambios.
- **Kirkardo ULTRA Triple — Gemini + Codex peers**: architectural review con 3 AIs, devil advocate.

> No hay botones scan/rank/propose/apply en el TUI. Esos flujos están marcados como LEGACY en `auto_updater.py`.

## Skills Map & Sync (view `f`)

- Layer 0 Meta: ultron, skill-creator, consolidate-memory, mcp-builder
- Layer 1 Personalidades: 14 specialists (senior-engineer, gamedev-engineer, ui-designer, etc.)
- Layer 2 Subskills: engineering, security, testing, UI, game, AI platform, workflow
- Botones: Buscar GitHub, Buscar Gemini, Sincronizar Skills, Actualizar todas, Crear nueva

## Comandos

```powershell
# TUI
ultron tui

# Health check
uv run python ~/.claude/skills/ultron/scripts/cockpit/health.py

# Skills manifest
uv run python ~/.claude/skills/ultron/scripts/cockpit/skill_manifest.py status
uv run python ~/.claude/skills/ultron/scripts/cockpit/skill_manifest.py rebuild
uv run python ~/.claude/skills/ultron/scripts/cockpit/skill_manifest.py constitutions

# Registry sync
uv run python ~/.claude/skills/ultron/scripts/cockpit/registry_sync.py health
uv run python ~/.claude/skills/ultron/scripts/cockpit/registry_sync.py propagate --dry-run
uv run python ~/.claude/skills/ultron/scripts/cockpit/registry_sync.py include-agents

# Route quality
uv run python ~/.claude/skills/ultron/scripts/cockpit/route_quality.py status

# Background tasks
uv run python ~/.claude/skills/ultron/scripts/cockpit/background_tasks.py list

# Scan projects
uv run python ~/.claude/skills/ultron/scripts/cockpit/scan_projects.py
```

> **Deprecated (v12.2.2):** `activity.jsonl` (Activity tracker) · `auth-vault.dpapi` (Auth Vault DPAPI)
> These modules were removed from the TUI and are no longer maintained.
