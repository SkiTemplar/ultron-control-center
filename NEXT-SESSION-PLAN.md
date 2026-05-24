# Plan: Próxima Sesión — Control Center 2.0 + ECC

**Fecha de creación:** 2026-05-22  
**Estado del sistema actual:** ECC activo · Mem0 configurado · ULTRON archivado · Claudia instalada pero descartada  
**Objetivo de la sesión:** Transformar ULTRON Control Center en una GUI limpia que use ECC+Mem0 como backend, eliminando toda la infraestructura propia de ULTRON.

---

## Contexto rápido

- El backend de IA ya está migrado: **ECC** (skills/agents/hooks) + **Mem0** (memoria)
- El Control Center de ULTRON era el mejor GUI disponible, pero tiene muchas partes acopladas al stack viejo
- La idea NO es reescribir desde cero, sino **cirugía limpia**: quitar lo viejo, dejar lo bueno, añadir lo que falta

---

## Lo que se queda (no tocar)

- Kanban board de proyectos
- Vista de sesiones recientes
- Detección automática de proyectos locales
- Panel de configuración (limpiar, no eliminar)
- Onboarding (`Onboarding.tsx`)
- Sistema de notificaciones (`notify.ts`)
- Dashboard principal

---

## Lo que se elimina

- Todo el sistema de memoria Qdrant (`brain_index.py`, vault, MCP de Qdrant)
- Skills/agents del sistema ULTRON propio (sustituidos por ECC)
- Hooks de ULTRON propios (los de ECC están en `~/.claude/settings.json`)
- AI Router interno de ULTRON (ECC ya hace esto)
- Full Diagnostic de hardware (si no aporta valor sin Qdrant, retirar; si es útil, mantener)
- Tareas programadas y auto-boot de Qdrant
- Referencias al brain, vault, MCP interno

---

## Lo que se añade / mejora

### Prioridad 1 — Skills & Agentes (ECC)
- Visor de skills instaladas en `~/.claude/skills/` y `.claude/skills/`
- Visor de agentes en `~/.claude/agents/`
- Visor de rules en `~/.claude/rules/`
- Activar/desactivar skills (mover a carpeta `_disabled/`)
- Botón "Abrir skill" en editor

### Prioridad 2 — Gestión de proyectos mejorada
- El Kanban actual funciona pero necesita pulido UX (evaluación Kirkardo: 6/10)
- Auto-detectar proyectos desde directorios recientes de Claude Code
- Estado del proyecto: activo / archivado / en progreso
- Link directo a abrir sesión Claude Code en ese proyecto

### Prioridad 3 — Sesiones
- Lista de sesiones recientes (desde `~/.claude/projects/`)
- Resumen de última sesión por proyecto
- Botón "Continuar sesión" o "Nueva sesión" en proyecto

### Prioridad 4 — Memoria integrada (Mem0 + ECC graph)
- Panel de estado: Mem0 conectado / desconectado
- Búsqueda simple de memorias almacenadas
- No reemplazar Mem0, solo dar visibilidad

### Prioridad 5 — Ajustes limpios
- Mostrar plugins ECC activos/inactivos
- Editor visual de `settings.json` (modelo, idioma, permisos)
- Estado de MCPs (context7, playwright, mem0, codex)
- Hooks activos (leer de `settings.json`)

---

## Archivos clave para el agente

```
~/.ultron/                          ← raíz del proyecto
~/.ultron/control-center/           ← código del Control Center (Tauri 2 + React)
~/.ultron/plans/PLANS.json          ← backlog (schema 6.0, 7 epics, 150 items)
~/.ultron/plans/2026-05-21-roadmap-ultron-1.0.md  ← roadmap maestro anterior

~/.claude/settings.json             ← configuración ECC + Mem0 + MCPs
~/.claude/skills/                   ← skills ECC instaladas
~/.claude/agents/                   ← agentes ECC
~/.claude/rules/                    ← rules ECC
```

---

## Items del backlog v1.0-scope pendientes (del roadmap anterior)

- `cc-section-by-section-verification` — verificar 13 items en estado `revision`
- `full-diagnostic-redesign` — rediseñar diagnóstico (ahora sin Qdrant)
- `adopt-agent-browser` — integrar agent browser en CC
- `pending-items-explain-purpose` — skill manager UI
- `changelog-tab-stale` — pestaña changelog
- `kirkardo-final-1.0-gate` — gate de calidad UX (objetivo ≥9.5)
- `changelog-reset-semver-1.0` — bump a 1.0

---

## Instrucción para el agente de la próxima sesión

> "Lee este archivo completo. Luego abre `~/.ultron/control-center/` y haz un análisis exhaustivo del código. Elimina todo lo relacionado con el sistema ULTRON propio (Qdrant, brain, vault, router interno) y reimpleméntalo como GUI para ECC+Mem0 siguiendo las prioridades de este plan. Trabaja de P1 a P5. Haz commit al terminar cada prioridad. No preguntes, ejecuta."

---

## Resultado de búsqueda de alternativas GUI

Investigación completada el 2026-05-22. **Dorothy existe y es el candidato más sólido.**

### Top 3 alternativas a ULTRON Control Center

| # | Proyecto | Stars | Stack | Kanban | Skills/Agents | Hooks | Windows |
|---|---|---|---|---|---|---|---|
| 1 | [Charlie85270/Dorothy](https://github.com/Charlie85270/Dorothy) | 264 | Electron + Next.js 16 + React 19 | ✅ nativo | ✅ marketplace | ✅ lee settings.json | ✅ .exe |
| 2 | [Lexus2016/claude-code-studio](https://github.com/Lexus2016/claude-code-studio) | 98 | Web local (Node) | ✅ | ✅ | ✅ | ✅ web |
| 3 | [markes76/claude-code-gui](https://github.com/markes76/claude-code-gui) | 23 | Electron + React | ❌ | ✅ 19 páginas UI | ✅ | ✅ .exe |

### Dorothy — detalle

- Kanban con auto-asignación de tareas a agentes por skill-matching
- Proyectos múltiples con agentes aislados por proyecto
- Skills marketplace + agentes con roles
- Lee y gestiona `~/.claude/settings.json`, `CLAUDE.md`, MCP servers
- 5 MCPs propios (Kanban, Orchestrator, Telegram, Vault, Social Data)
- 35 releases, última versión 1.2.7 (Mar 2026)
- **Punto débil:** 264 estrellas (vs 21.9K de Claudia), actividad reciente incierta

### Para complementar ECC (del segundo agente)

- **[automazeio/ccpm](https://github.com/automazeio/ccpm)** — ECC skill system para GitHub Issues + worktrees paralelos
- **[paperclipai/paperclip](https://github.com/paperclipai/paperclip)** — org chart de agentes con roles, budgets y permisos
- **[rohitg00/awesome-claude-code-toolkit](https://github.com/rohitg00/awesome-claude-code-toolkit)** — curated list: 135 agentes, 176+ plugins, 26 companion apps

### Decisión recomendada para la próxima sesión

**Opción A (rápida):** Instalar y probar Dorothy primero. Si satisface, ULTRON CC queda como backup.  
**Opción B (más control):** Hacer la cirugía en ULTRON Control Center con ECC como backend (ver prioridades arriba).  
**Opción C (híbrida):** ULTRON CC 2.0 + ccpm como skill ECC para gestión de proyectos con worktrees.

---

## Stack final del sistema

| Capa | Herramienta | Estado |
|---|---|---|
| Orquestación skills/agents | ECC (`ecc@ecc`) | ✅ activo |
| Memoria | Mem0 MCP | ✅ configurado |
| Memoria local (gratuita) | ECC knowledge graph | ✅ activo |
| GUI | ULTRON Control Center 2.0 | 🔧 próxima sesión |
| MCPs auxiliares | context7, playwright, codex | ✅ activos |
