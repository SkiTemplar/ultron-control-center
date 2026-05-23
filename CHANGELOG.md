# Changelog

<!-- v2.3.0 -->
## v2.3.0 - 2026-05-23

Errores corregidos:
- (sin cambios)

Anadido:
- (sin cambios)


<!-- v2.2.0 -->
## v2.2.0 - 2026-05-23

Errores corregidos:
- use /v1/ping/ endpoint instead of /v1/memories/?limit=1

Anadido:
- card redesign + ProjectWorkspace polish (first pass)
- drop Features, simplify Backups, multi-plugin Plugins
- rebuild around ECC + Mem0 stack
- drop Schedules+Overview, fix Apps mojibake, expand MCPs
- fix gh search + false-positive detection + contrast + live catalog


<!-- v2.1.0 -->
## v2.1.0 - 2026-05-23

Errores corregidos:
- Mem0 panel: corregido path lookup de la API key en settings.json
  (mcpServers.mem0.headers.Authorization en lugar del nested mcp.servers.*
  inexistente). La pestana Memory ahora conecta correctamente cuando la
  key esta puesta como MCP server.

Eliminado:
- Pestana Gaming (game-killer + Windows tweaks, legado del overlay ULTRON).
- Pestana Personal (profile.md / known.json / writing-style trainer del
  stack Tio Gilito).
- Modulos backend asociados: gaming.rs, personal.rs, commands/gaming.rs,
  commands/personal.rs.
- ACL scopes gaming-enum + gaming-kill de capabilities/default.json.
- Cockpit stale dirs: news, standup, trending, audits, scheduler-logs,
  tui, last-run.
- PLANS.json reseteado a sprint v2.1 (backlog ULTRON antiguo archivado en
  plans/_archived-2026-05-22-ultron-backlog.json, gitignored).

Anadido:
- Pestana Library unificada: Skills + Agents + Rules colapsados en una
  unica entrada de sidebar con sub-tabs internos. Deep links via command
  palette ("Library - Skills" / "Library - Agents" / "Library - Rules")
  abren la sub-pestana correspondiente. localStorage recuerda la ultima
  sub-tab abierta.
- Sub-tab Catalog dentro de Library: catalogo curado por dominio
  (Graphics Programming, Unreal Engine 5, AI / ML, MCP Development) con
  install de un clic via library_install_from_github al global scope.
  Filtros All / Skills / Agents y estado por item (idle / installing /
  done / error). Editable desde cockpit/curated-catalog.json.
- Backend command read_curated_catalog que sirve el JSON crudo (el
  schema puede evolucionar sin recompilar).
- 9 nuevos iconos SVG inline (Sparkle, Bot, BookOpen, Compass, Folder,
  Globe, ExternalLink, Check, AlertTriangle) en library/icons.tsx.

Polish:
- Sidebar reducido (12 -> 10 items primarios + "More" sigue intacto).
- CommandPalette navega a Library + mantiene deep links a sub-tabs.
- FeaturesSection META map reducido a los toggles que quedan vivos.
- types.ts limpio: GameProcessInfo / KillResult / KillFailure eliminados.


<!-- v2.0.0 -->
## v2.0.0 - 2026-05-23

Errores corregidos:
- (sin cambios)

Anadido:
- Phase 7 — Settings cleanup (raw first, plugins panel, MCP/Hooks polish)
- Phase 6 - PC Diagnostic native rewrite (sysinfo + wmi + AI + history + scheduled)
- P5 — agent/skill library (GitHub search + in-app create + per-project pinning)
- P4.10 wire tabs in App + projects open dispatch + migration
- P4.9 ProjectSessions sub-tab
- P4.8 ProjectContext sub-tab (CLAUDE.md editor + Mem0 panel)
- P4.7 ProjectAgents sub-tab + pinning persistence
- P4.6 ProjectTerminal sub-tab with multi-PTY bar


> Per `docs/CHANGELOG-POLICY.md`: only MAJOR / MINOR get detailed entries.
> Patches collapse into the next minor entry as a brief sweep.

## v2.0.0 — Control Center rewrite (ECC + Mem0)

**Fecha:** 2026-05-23

**BREAKING:** Reescritura completa del Control Center. ULTRON backend reemplazado por ECC (plugin Claude Code) + Mem0 (memoria cross-session). Nuevo Projects workspace con Kanban dispatch-a-agente y terminal embebida.

### Removed (mass cleanup desde v15.5.20)
- News pipeline (`news.rs`, `News.tsx`).
- Self-Improve / Stats (`self_improve.rs`, `SelfImprove.tsx`).
- AI Router interno (`ai_router.rs`, `commands/ai_router.rs`, `AiRouterSection.tsx`).
- Modos LOW/MED/HIGH/ULTRA (`mode.rs`, `ModeSection.tsx`, `ModeSwitcher.tsx`).
- Memory Qdrant + vault (`memory_graph.rs`, `memory_highlights.rs`, embedder, brain_index).
- Version drift / ultron_status / detect_gaps (scripts Python shell-out).
- Skill/Agent vault y findings (`commands/skills.rs::vault*`).
- Maintenance Qdrant kinds.
- Doctor Python script (`run_doctor` shell-out).

### Added
- **P1** Mem0 client REST nativo (Rust `reqwest` + `serde`): add/search/list/update/delete con filtros `metadata.project_id`. Nueva tab global Memory.
- **P2** Skills + Agents + Rules viewers con 3 origenes (global / per-project / plugin). Toggle on/off + abrir en editor externo.
- **P3** Embedded terminal (`portable-pty` + `xterm.js` + addons fit/webgl). Adios `wt.exe` popups.
- **P4** Projects re-arquitectura: pestanas por proyecto (browser-style), sub-tabs Board/Terminal/Agents/Context/Sessions, Kanban data model (kanban.json atomico), dispatch de cards a PTYs reales.
- **P5** Library de agents/skills: search GitHub via `gh search code`, install desde `gh api contents` (base64 decode), create in-app con frontmatter form, per-project pinning.
- **P6** PC Diagnostic nativo: `sysinfo` + `wmi` (Windows), checks rust 100%, analisis AI inline via `claude --print`, historial JSON con prune a 30, scheduled diario via `schtasks.exe` + modo headless `--run-diagnostic`.
- **P7** Settings cleanup: editor `settings.json` como default tab, panel Plugins (ECC introspection), MCP ping con latency + Test button, Hooks last-fired + toggle visual.
- **P8** Kirkardo UX rubric (>=9.5/10 target, 9.27 code-level alcanzado, walkthrough manual documentado como follow-up post-tag).

### Changed
- Sidebar default tab: Dashboard -> Projects.
- Storage root: `~/.ultron/` (sin cambios — branding ULTRON Control Center se queda).
- Auth Claude Code: OAuth de suscripcion, sin tocar.

### Migrated
- `~/.ultron/cockpit/projects.json` -> mantenido tal cual.
- Cada proyecto gana `~/.ultron/cockpit/projects/<id>/kanban.json` (auto-creado con 4 columnas vacias al primer open, idempotente).

### Risks
- Linux/macOS no testeados — la app solo se ha verificado en Windows 11.
- `gh` CLI requerido para la library (P5).
- Mem0 requiere API key en `~/.claude/settings.json`.


---

Pre-2.0 history (v15.x and earlier) archived at `docs/CHANGELOG-archive.md`.
