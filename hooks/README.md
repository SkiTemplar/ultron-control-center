# ULTRON — Hooks de Claude Code (copia-fuente versionada)

Estos son los hooks que integran ULTRON con Claude Code. Claude Code los
ejecuta desde `~/.claude/scripts/` y `~/.claude/hooks/`, **fuera** de este
repo. Esta carpeta es la **copia-fuente canónica** para que no se pierdan si
se borra `~/.claude` (antes solo existían ahí, sin control de versiones).

## Instalación

```powershell
powershell -ExecutionPolicy Bypass -File hooks\install-hooks.ps1
# opcional: registrar la tarea programada de Workdays (cada 15 min)
powershell -ExecutionPolicy Bypass -File hooks\install-hooks.ps1 -RegisterTask
```

El script solo copia los `.js` a `~/.claude/`. No toca `settings.json`: los
hooks resuelven rutas con `os.homedir()`, no hardcodean nada.

## Inventario

### `scripts/` (invocados desde settings.json)

| Hook | Evento | Propósito |
|------|--------|-----------|
| `stop-compress-session.js` | Stop | Comprime la sesión a hechos → Qdrant (`ultron_sessions`) **y** produce `decisions-pending.jsonl` para el panel Decisions (gate importance ≥ 0.5) |
| `mem0-sync.js` | Stop | Sincroniza mensajes + archivos a Mem0 cloud; exporta los helpers de seguridad (redactSecrets / isOptedOut) |
| `session-recall-inject.js` | SessionStart | Recall semántico: top-K hits de Qdrant vía `ultron-embed.exe` |
| `load-cross-project-memory.js` | SessionStart | Inyecta el índice de `MEMORY.md` de proyectos recientes |
| `session-start-override.js` | SessionStart | Fallback de resumen de sesión previa por nombre de proyecto |
| `workday-session-linker.js` | SessionStart | Auto-enlaza la sesión al Workday en curso (`_pending-links.jsonl` si el backend está offline) |
| `routing-dispatcher.js` | UserPromptSubmit | Sugiere skill/persona por intención del prompt |
| `save-user-prompt.js` | UserPromptSubmit | Archiva cada prompt en el inbox diario |
| `kanban-update-reminder.js` | Stop | Sugiere actualizar el kanban al detectar tarea completada |

### `hooks/`

| Hook | Disparo | Propósito |
|------|---------|-----------|
| `quota-capture.js` | PostToolUse | Detecta avisos de cuota Claude → `quota-state.json` (AI Router salta proveedores si cuota crítica) |
| `workday-auto-update.js` | Tarea Windows 15 min | Escribe actividad git + kanban moves al workday JSON (sin HTTP, funciona offline) |

## Nota de mantenimiento

Si editas un hook en `~/.claude/`, **copia el cambio aquí** (o re-ejecuta el
flujo inverso) para no perderlo. La fuente de verdad operativa sigue siendo
`~/.claude/` — esta carpeta es el respaldo versionado.
