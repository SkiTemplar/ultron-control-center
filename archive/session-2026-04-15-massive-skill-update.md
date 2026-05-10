# Sesión 2026-04-15 — Massive Skill Update v3.0

## Objetivo
Reestructurar el sistema entero de skills de USER. Crear jerarquía formal, sincronización Cowork↔Claude Code, y permitir que las skills personales aprovechen los plugins del marketplace.

## Decisiones del usuario
1. **Sync source:** Git unificado con todo (Claude Skills + Cowork Packages)
2. **Alcance:** FULL — todas las personales acceden a no-personales y paquetes
3. **Ultron v3:** reemplaza v2 + se elimina la del plugin gamedev
4. **Mecanismo:** Skill tool directo + documentación clara en cada SKILL.md

## Trabajo ejecutado

### Diagnosticado
- 16 skills personales en Cowork mount + 23 carpetas en filesystem real Windows
- Caos de duplicados: `don-claude` vs `don-claudio`, `gestor-financiero` vs `tio-gilito`, `unity-mcp-skill` vs `unity-mcp-orchestrator`, `terry-davis.zip` basura
- 9 carpetas gamedev duplicadas (en `.claude/skills/` Y en plugin `USER-gamedev-arsenal`)
- Skills solo en Cowork: `manolo-lama`, `consolidate-memory`, `mcp-builder`, `skill-creator`, nativas (pdf, pptx, etc.)
- Skills solo en local: `ui-ux-pro-max` (recurso valioso, mantener)

### Ejecutado
- ✅ Backup ZIP completo: `skills-backup-20260415-111550.zip`
- ✅ Borrado: 4 duplicados puros + 9 carpetas gamedev personales
- ✅ Renombrado: `don-claude` → `don-claudio`
- ✅ Sync Cowork → Local: copiadas 4 skills (manolo-lama, consolidate-memory, mcp-builder, skill-creator)
- ✅ ULTRON v3 maestro escrito (~328 líneas) con 4 layers + FAST PATH ampliado + ROUTING MATRIX + Skill Registry pointer
- ✅ skill-creator v2.0 con workflow sync Cowork↔Code + checklist + Git workflow
- ✅ ARSENAL EXTENDIDO añadido a: Mike Tyson, Jordan Belfort, Alfred, Pana, Tío Gilito
- ✅ Personas con plugins ya documentados (Terry, Einstein, Don Claudio, Profesor, Repo, Manolo) verificadas
- ✅ skill-registry.md maestro creado en `C:\Users\USER\.ultron\global\`
- ✅ INDEX.md actualizado a v3.0
- ✅ Sessions log creado

### Pendiente acción manual de USER
1. **Git:** `git --version` se cuelga en su sistema. Necesita debug (probablemente git-credential-helper o un hook). Una vez arreglado, ejecutar:
   ```powershell
   cd C:\Users\USER\.claude\skills
   git init
   git add -A
   git commit -m "Estado inicial v3.0 (massive skill update)"
   ```
2. **ultron-v3 del plugin gamedev:** El SKILL.md está en `/sessions/.../mnt/.remote-plugins/plugin_01PoVMrWfFrJcxicCMQzooAX/skills/ultron-v3/SKILL.md` (read-only). Opciones:
   - Editar el plugin localmente y volver a subirlo a Cowork
   - O simplemente **desinstalar y reinstalar** el plugin sin la skill ultron-v3 (recomendado: la versión nueva en `ultron/` la sustituye con creces)
3. **Sync de skills al Cowork:** Empaquetar cada skill modificada como `.skill` y subirla con "Guardar Habilidad / Reemplazar paquete":
   - `ultron`, `skill-creator`, `manolo-lama`, `consolidate-memory`, `mcp-builder`
   - `mike-tyson`, `jordan-belfort`, `alfred`, `pana`, `tio-gilito`

## Memoria nueva consolidada
- Sistema jerárquico de 4 layers como contrato firme
- Personas pueden invocarse entre sí (no solo Ultron orquesta)
- ui-ux-pro-max es recurso de Mike, no competencia
- Skills nativas Cowork (pdf, pptx, etc.) NO se sincronizan al local (son del entorno)

---

## Sesión 2 — Tortunabo: Registro de Bugs + Análisis Técnico

### Trabajo ejecutado
- 6 bugs nuevos registrados en testing multiplayer (#B3-#B8)
- Don Claudio analizó código real: `TN_ChunkManager.cpp`, `TN_RunGameMode.cpp`, `TN_CoopFlowHUDWidget.cpp`
- Root causes identificados con referencias a líneas de código específicas
- Soluciones concretas documentadas por bug

### Memoria creada
- `C:\Users\USER\.ultron\projects\tortunabo\memory.md` — arquitectura, patrones de red, análisis de bugs
- `C:\Users\USER\.ultron\projects\tortunabo\log.md` — historial de sesiones
- `backlog-ideas-abril2026.md` — actualizado con B3-B8 y sus fixes

### Bugs registrados (ULTRON + Claude memory)
| ID | Bug | Root cause | Fix |
|----|-----|-----------|-----|
| B3 | Chunks destruidos al morir cliente | `CleanupChunks()` ignora `DeadPlayerPawns` | Teleportar pawn a `NextSpawnTransform` antes de destruir chunk |
| B4 | Puerta atravesable | `bReplicateMovement` no activo en actor puerta | `bReplicates=true` + `bReplicateMovement=true` o replicar ángulo via OnRep |
| B5 | Pelota inmóvil en cliente → snap | `SetReplicateMovement(false)` heredado del chunk | Pelota con `bReplicateMovement=true` explícito; `SetSimulatePhysics(false)` en cliente |
| B6 | Widget resultados no aparece | `ResultsOverlay` null por BindWidget mismatch | Verificar nombre exacto en BP Designer; añadir log diagnóstico |
| B7 | Victoria no aparece tras muerte+revive | Mismo que B6 + posible HUD destruido en espectador | Fix B6 primero; verificar persistencia de HUD en espectador |
| B8 | Puerta en posición incorrecta tras revive | Actor pierde relevancia en espectador | `bAlwaysRelevant = true` en actor puerta |
