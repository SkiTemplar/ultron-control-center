# Projects redesign — wireframe textual y orden de build (2026-05-29)

Spec de ejecución para el rediseño completo del módulo Projects. Sintetiza 8
cards del kanban en un único target coherente. Cumple el gate de Semana 2/3 del
plan v2.14 ("wireframe textual aprobado — gate obligatorio") sin recompilar:
USER revisa la DIRECCIÓN aquí (texto) y el resultado visual al final.

Cards cubiertas: card-ux-projects-dashboard-minimalista, -remove-top-tabs,
-remove-technical-zone, -move-buttons, card-ux-kanban-restore-functional,
card-ux-sessions-remove-tags, card-ux-sessions-plus-button, card-ux-routing-refactor.

## Estado actual (verificado en el código)

- `Projects.tsx` (ProjectsPane) = módulo top-level: lista de proyectos + acciones.
- `ProjectWorkspace.tsx` = vista por-proyecto: header (nombre + quick actions) +
  **barra de sub-tabs** (vía `state/ProjectsTabsContext`) que conmuta entre los
  paneles. ESTA barra de sub-tabs es la "zona técnica de 3 pestañas" + parte de
  los "top tabs" a eliminar.
- Paneles que YA existen como componentes (se recomponen, no se reescriben):
  `ProjectBoard` (kanban), `ProjectAgents` (roster), `ProjectSessions`,
  `ProjectContext` (grafo/árbol memoria), `ProjectNotes`, `ProjectTimeline`,
  `ProjectTerminal` (con su `TabsBar` interno de terminales).
- `App.tsx` routing = switch gigante (≈501-534) con props dinámicas por tab.

## Target: dashboard de proyecto tipo IDE (paneles, NO scroll-page)

Confirmado por USER 2026-05-28: paneles colapsables/resizables tipo IDE con
splits, NO una notion-page de scroll único.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ HEADER proyecto: ‹nombre›   [Open IDE] [Run Batch] [⋯]      (sin sub-tabs)  │
├───────────────┬───────────────────────────────────┬────────────────────────┤
│ IZQUIERDA      │ CENTRO (principal, flex-1)         │ DERECHA                │
│ (resizable)    │                                    │ (resizable, colapsable)│
│                │  ┌─ Terminal IA (xterm) ─────────┐ │  ┌─ Kanban ──────────┐ │
│ • Agent roster │  │ ProjectTerminal               │ │  │ ProjectBoard      │ │
│   (ProjectAgents)│ │ (tabs de terminal internos)   │ │  │ Backlog/InProg/   │ │
│                │  └───────────────────────────────┘ │  │ Blocked/Done DnD  │ │
│ • Sessions     │  ┌─ (split inferior opcional) ───┐ │  └───────────────────┘ │
│   (ProjectSessions│ │ Git recientes / Notes / Ctx   │ │  ┌─ Context viewer ──┐ │
│   sin tags)    │  └───────────────────────────────┘ │  │ ProjectContext    │ │
└───────────────┴───────────────────────────────────┴────────────────────────┘
```

Paneles (cada uno colapsable, estado persistido): Terminal IA · Agent roster ·
Kanban · Sessions · Git recientes · Notes · Context viewer. Layout por defecto:
terminal al centro (foco), kanban+context a la derecha, roster+sessions a la
izquierda, git/notes en split inferior o como panel colapsado por defecto.

## Arquitectura de componentes

- **NUEVO `ProjectDashboard.tsx`**: el shell. Compone los paneles existentes en
  un grid de splits resizables. Cada panel envuelto en un `<DashboardPanel>`
  (título + botón colapsar + contenido). NO reescribe los paneles: los monta.
- **NUEVO `DashboardPanel.tsx`**: wrapper genérico {title, actions?, collapsed,
  onToggle, children}. Header con chevron colapsar + slot de acciones (aquí van
  Run Batch en el panel Sessions, Open IDE en el header del proyecto).
- **Resize/persistencia**: evaluar `react-resizable-panels` (si no añade peso
  excesivo) o splits flex con drag-handles propios + `min-w-0`/`overflow-hidden`
  (lección de card-ux-workdays-responsive). Estado (colapsado + tamaños) en
  `~/.ultron/cockpit/projects/<id>/dashboard-layout.json` vía un comando backend
  `project_dashboard_layout_load/save` (o localStorage como MVP, migrable luego).
- **`ProjectWorkspace.tsx`**: deja de renderizar la barra de sub-tabs; renderiza
  `<ProjectDashboard projectId=... />`. ProjectsTabsContext se reduce/elimina.
- **`router.ts` (NUEVO, card-ux-routing-refactor)**: `TABS: TabDef[]` con
  {id, label, icon, group}. App.tsx consume el array para el Sidebar; el RENDER
  se mantiene como render-map `Record<Tab, () => ReactNode>` (las props son
  dinámicas: alerts, onNavigate, key/initial de Library, etc.) — NO forzar
  defaultProps estáticos donde no aplican.

## Orden de build (incremental, cada paso tsc-verde, sin recompilar la app)

1. **routing-refactor** (foundation, bajo riesgo): extraer `TABS` metadata + un
   render-map a `src/lib/router.ts`; App.tsx consume ambos. Comportamiento 1:1.
2. **DashboardPanel.tsx** + **ProjectDashboard.tsx** (shell con paneles fijos,
   sin resize todavía) montando los componentes existentes. Feature flag
   `projects_dashboard_v2` (features.rs) para poder activar/desactivar.
3. **Persistencia** de colapso/tamaños (layout.json o localStorage).
4. **Resize** (drag handles) — lo más frágil visualmente; hacerlo tras tener el
   shell estable.
5. **kanban-restore-functional**: verificar/forzar columnas Backlog/InProgress/
   Blocked/Done + drag-drop en ProjectBoard dentro del panel.
6. **move-buttons**: Run Batch → header del panel Sessions; Open IDE → header del
   proyecto. Quitar la zona técnica aislada.
7. **remove-technical-zone** + **remove-top-tabs**: eliminar la sub-tab bar de
   ProjectWorkspace (ya reemplazada por el dashboard) + ProjectsTabsContext.
8. **sessions-remove-tags**: quitar UI de tags en ProjectSessions/Sessions
   (cards, input, filtros). Backend sessions-tags.jsonl queda (lo usa auto-tag).
9. **sessions-plus-button**: botón '+' crear-proyecto solo en esquina sup-der de
   cada session card; eliminar otros botones de crear proyecto.
10. **auto-tag-cwd FE** (ya hay backend: TagEntry.project): badge de proyecto por
    sesión (reemplaza los tags manuales eliminados) + filtro por badge.

## Riesgos / mitigaciones

- Blast radius alto (routing + workspace). Mitigación: feature flag
  `projects_dashboard_v2`; el camino viejo (sub-tabs) queda hasta validar.
- Resize es lo menos verificable a ciegas → último paso, con `min-w-0`/overflow
  disciplinados (lección workdays-responsive).
- NO marcar las cards Done hasta confirmación visual de USER (toda la surface
  Projects cambia; review visual entero al final, sin recompilar hasta acabar).

## Decisión pendiente (no bloqueante para empezar por el paso 1)

¿`react-resizable-panels` (dep nueva, ~6KB, robusta) o splits propios? MVP puede
arrancar con paneles colapsables de tamaño fijo (pasos 1-3) sin decidir esto;
el resize (paso 4) es donde importa.
