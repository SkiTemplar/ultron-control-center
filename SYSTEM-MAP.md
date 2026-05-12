# ULTRON SYSTEM MAP — pinned routes (load at session start)

> Index estable de rutas del sistema ULTRON, para no buscar (gastar tokens) cada vez.
> Objetivo: ≤1k tokens. Última actualización: 2026-05-12 (v15.0b — skill-vault, dual-mode v2).
> Comandos: `ultron <cmd> --help` · catálogo completo: `~/.ultron/docs/ULTRON-GENESIS-CAPABILITIES.md`

## VERSION
- SSOT version: v14.9.0 GENESIS [verify: uv run python C:\Users\USER\.ultron\scripts\cockpit\version_propagate.py --check] [expect: OK]

## CORE — cockpit
- Dispatcher PS1:        `~/.ultron/scripts/cockpit/ultron.ps1`  ·  TUI: `tui.py`
- Cockpit Python tools:  `~/.ultron/scripts/cockpit/*.py` (brain_index, registry_sync, context_primer, doctor, embed_vault, embed_skills, skill_vault, osint_footprint, gemini-peer …)
- Cockpit data:          `~/.ultron/cockpit/{audits,news,standup,DASHBOARD.md,changelog.ndjson}`  ·  Icons: `~/.ultron/cockpit/icons/{01-10}-*.ico`

## MEMORY — 3+1 layers + Qdrant
- L0 hot context:        `~/.ultron/.tmp/context.md`  ·  L0 system map: este archivo  [verify: if exist "%USERPROFILE%\.ultron\SYSTEM-MAP.md" echo OK] [expect: OK]
- L1 brain index (FTS5): `~/.ultron/brain_index/index.db` [verify: if exist "%USERPROFILE%\.ultron\brain_index\index.db" echo OK] [expect: OK]
- L2 vault local:        `~/.ultron-vault/...`  ·  Archive (indexed): `~/.ultron/archive/`
- L3 remote:             `github.com/SkiTemplar/ultron-memory` (push automático en HIGH+)
- Qdrant (semántico):    contenedor `ultron-qdrant`, datos en `D:\Qdrant\data`. Colecciones: `ultron_vault` (notas), `ultron_skills` (skills active+plugin+vaulted con `state`). Sync vía Stop hook (`embed_vault.py` / `embed_skills.py`). Recall: `ultron recall "<q>"` (híbrido) · auto-recall hook (UserPromptSubmit). [verify: curl -sf http://localhost:6333/healthz]
- Skill-vault:           `~/.ultron/skill-vault/` (334 skills fuera del contexto · `INDEX.json` · `ultron skills vault search|restore|stats|merge-candidates`)
- Per-project memory:    `~/.claude/projects/<encoded-path>/memory/`  ·  Per-project context: `<project>/.claude/context.md`

## CLAUDE — config + skills
- Global CLAUDE.md:      `~/.claude/CLAUDE.md`  ·  Settings: `~/.claude/settings.json` (hooks · MCP · permissions)
- Skills activas:        `~/.claude/skills/<name>/SKILL.md` (~46) · mirror `~/.agents/skills/` · vault `~/.ultron/skill-vault/` (~334)
- ULTRON skill spec:     `~/.claude/skills/ultron/{SKILL.md,protocols.md,memory.md,mode-*.md,references/*}`
- Hooks:                 `~/.ultron/scripts/hooks/{session-init,stop-memory-sync,session-cleanup}.ps1` + `*.py` (auto-recall, intent-dispatcher, routing-telemetry, …)

## INFRA — peers / externos
- Codex (peer):          plugin oficial `codex@openai-codex` (`codex-plugin-cc`). Auth = suscripción ChatGPT. Modelo pin en `~/.codex/config.toml` (`gpt-5.5` / `high`). Comandos `/codex:review|adversarial-review|rescue`. Legacy: `~/.ultron/scripts/_legacy/shared-duet.ps1` (deprecado). [verify: codex --version] [expect: \d+\.\d+]
- Gemini (peer):         CLI vía OAuth/suscripción (sin `GEMINI_API_KEY`). Helper `~/.ultron/scripts/gemini-peer.ps1` → output a `.md`.
- GitHub MCP:            `github-pat` en settings.json [verify: claude mcp list] [expect: github-pat.*Connected]
- Qdrant MCP:            `uvx mcp-server-qdrant` [verify: claude mcp list] [expect: qdrant.*Connected]
- Docker:                Docker Desktop autostart (HKCU\...\Run) [verify: docker ps --filter "name=qdrant" --format "{{.Status}}"] [expect: ^Up]
- UV (Python):           SIEMPRE `uv run python <script>` · `uv pip install` (nunca raw python) [verify: uv --version] [expect: uv \d+]
- Backup task:           UltronBackup-Weekly, lunes 09:00 [verify: powershell -NoProfile -Command "(Get-ScheduledTask -TaskName UltronBackup-Weekly).State"] [expect: Ready]

## USER — workspace
- Home: `C:\Users\USER\`  ·  Projects scan: `~/Documents/`, `~/Desktop/`, `~/source/`  ·  Registry: `~/.ultron/cockpit/projects.json`
- Proyectos activos: ver `~/.ultron/.tmp/context.md` § PROYECTOS ACTIVOS
