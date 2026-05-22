# Control Center 2.0 — Design Spec

**Fecha:** 2026-05-23
**Estado:** Draft → User review
**Sesión origen:** brainstorm conversacional con USER (2026-05-22/23)
**Commits relacionados:** Fase 0a en `a9c48d5` (News, Self-Improve, Full Diagnostic eliminados); resto pending

---

## 1. Contexto

ULTRON, el stack de orquestación propio del usuario, ha sido archivado por inestabilidad y bajo testing. Su reemplazo en el backend de IA:

- **Plugin ECC** (`ecc@ecc`) — skills, agents, hooks de Claude Code, todo gestionado bajo `~/.claude/`.
- **Mem0** vía MCP — memoria cross-session, API key configurada en `~/.claude/settings.json`.
- **Claude Code CLI** — la suscripción del usuario, autenticación OAuth ya operativa.

El **Control Center** (Tauri 2 + React 19 + TypeScript + Tailwind v4, v15.5.20, ~67 ficheros Rust + ~50 componentes React + 17 tabs) sigue funcionando en Windows 11 pero arrastra acoplamiento profundo al stack viejo: sistema de memoria Qdrant + vault, AI Router interno, scripts Python en `~/.ultron/scripts/`, Full Diagnostic con probe de Qdrant, pipeline de News, telemetría Self-Improve. Necesita cirugía.

Evaluadas como alternativas a la cirugía: Dorothy (Charlie85270, solo macOS arm64, no soporta Windows ni P1-P5), Claudia/opcode (21.9K ★, sin build Windows desde oct 2025), TOKENICODE (Tauri 2 pero sin Kanban ni editor de settings), claude-code-studio (web-local, sin agents/rules). Ninguna supera "hacer la cirugía en el Control Center existente". Decisión: **cirugía**.

## 2. Objetivos

### Goals

1. Eliminar todo código ULTRON-only sin sustituto vital en ECC / Mem0.
2. Reorientar el frontend como cliente de ECC + Mem0 + Claude Code CLI.
3. Re-arquitecturar **Projects** como pestañas-por-proyecto con workspace propio (Kanban dispatch-a-agente + terminal embebida + agentes per-project + context Mem0).
4. Embedder Claude Code en la app (PTY + xterm.js) usando la auth de suscripción — cero `wt.exe` popups para el trabajo de proyecto.
5. Biblioteca de agentes/skills con descubrimiento desde GitHub, creación in-app, y per-project pinning.
6. Mantener y mejorar el **PC Diagnostic** (checks nativos Rust, AI analysis in-app, historial, scheduled opcional).
7. Sustituir el stack de memoria Qdrant por panel Mem0 (global + per-project context).

### Non-goals

- Reescribir Claude Code (usamos su CLI vía PTY).
- Reemplazar el knowledge graph de ECC (es global; no se surface per-project).
- Tocar la auth de Claude Code (sigue OAuth de suscripción).
- Mantener compatibilidad con scripts en `~/.ultron/scripts/cockpit/`.
- Cambiar el storage root `~/.ultron/` (no rebrand en esta fase).
- Mantener el modo LOW/MED/HIGH/ULTRA de ULTRON.

### Diferenciador

Ninguna GUI existente (Claudia, Dorothy, opcode, TOKENICODE, claude-code-studio, Cursor) combina **Kanban que dispara agentes + terminal embebida + biblioteca editable de agents/skills + per-project**. Eso es la propuesta de valor.

---

## 3. Arquitectura visible

### 3.1 Concepto en una frase

El Control Center deja de ser un launcher (un sitio que abre `wt.exe`) y se convierte en el **espacio de trabajo** de Claude Code: una sola ventana donde abres proyectos como pestañas, mueves cards de un Kanban a "In Progress", y el agente correspondiente arranca en la terminal embebida de esa pestaña.

### 3.2 Arquitectura de información

**Sidebar (recortada vs. actual):**
- Dashboard
- **Projects** (default tab al arrancar, en lugar de Dashboard)
- Skills
- Agents
- Memory (rewrite: panel Mem0 global)
- Sessions
- System (con PC Diagnostic dentro)
- Settings

Eliminadas del sidebar (versus actual): News, Self-Improve/Stats (ya removidas en 0a), Plans (se queda revisable), Changelog (drawer), Personal (se queda), Gaming (gated).

**Pestañas de proyecto** (sobre el área principal, estilo navegador):
- Pestaña fija "Projects" — la home: lista + filtros + auto-detección + Kanban global de proyectos por status (active/archived/in-progress).
- Pestañas que aparecen al abrir un proyecto. `×` cierra (con prompt si hay PTY vivo). Drag para reordenar. `Ctrl+Tab` para alternar. Estado vivo (PTY, scroll, focus) preservado mientras la pestaña existe.

**Sub-vistas dentro de cada pestaña de proyecto** (tabs finos, top):
- **Board** (default) — Kanban de cards.
- **Terminal** — vista full-screen del PTY activo (cuando colapsas el Board).
- **Agents** — agentes asignables al proyecto + acceso a la biblioteca global.
- **Context** — editor de `CLAUDE.md` del proyecto + memorias Mem0 filtradas por `project_id`.
- **Sessions** — lista de sesiones pasadas de Claude Code para este proyecto.

### 3.3 Layout default del workspace

Board ocupa la mayoría del viewport; terminal embebida como split horizontal inferior colapsable (estilo VS Code integrated terminal). Click en una card "In Progress" → la terminal de abajo enfoca esa PTY.

```
┌─ Projects │ my-game ×  another ×  + ─────────────────┐
│ [Board]  Terminal  Agents  Context  Sessions         │
│ ──────────────────────────────────────────────────── │
│  Backlog        In Progress       Blocked     Done   │
│  ┌──────────┐   ┌──────────┐                         │
│  │ Add login│   │ Refactor │                         │
│  │ <Bot> sec│   │ <Bot> rust                         │
│  └──────────┘   │ ● live   │                         │
│  ┌──────────┐   └──────────┘                         │
│  │ Doc API  │                                        │
│  │ <Bot> doc│                                        │
│  └──────────┘                                        │
│ ──────────────────────────────────────────────────── │
│ ▾ Terminal · refactor-rust · claude/opus-4-7         │
│ > [claude session running...]                        │
└──────────────────────────────────────────────────────┘
```

Iconos via Lucide (Bot, Folder, Play, Terminal, ...). Cero emojis. Paleta: las CSS vars actuales (`--color-surface-*`, `--color-accent`, dark theme ULTRON).

### 3.4 Quick actions toolbar

En la cabecera de cada pestaña de proyecto, una toolbar derecha con botones one-shot (heredan los chips actuales): Open in IDE, Open folder, Spawn raw Claude/Codex/Gemini session. Estos NO son tareas Kanban — son acciones inmediatas sin lifecycle.

---

## 4. Modelo de datos del Kanban

### 4.1 Storage

Un fichero por proyecto: `~/.ultron/cockpit/projects/<project_id>/kanban.json`. Escritura atómica (tmp + rename), patrón estándar del backend Tauri.

### 4.2 Tipos Rust

```rust
struct KanbanBoard {
    project_id: String,
    columns: Vec<Column>,            // user-renameable, default 4
    cards: Vec<Card>,
    default_agent: Option<String>,   // slug del agent file (ej. "ecc:rust-reviewer")
    default_prompt_template: Option<String>,
    schema_version: u32,
}

struct Column {
    id: String,                      // ulid
    name: String,
    order: u32,
}

struct Card {
    id: String,                      // ulid
    column_id: String,
    title: String,
    description: String,             // markdown
    agent: Option<String>,           // override del default
    prompt_template: Option<String>, // template con {var} substitutions
    cwd: Option<String>,             // override del path del proyecto
    tags: Vec<String>,
    order: u32,                      // dentro de la columna
    created_at: String,              // RFC3339
    updated_at: String,
    runs: Vec<CardRun>,
}

struct CardRun {
    session_id: String,              // matchea ~/.claude/projects/<slug>/<id>.jsonl
    started_at: String,
    ended_at: Option<String>,
    status: RunStatus,
    exit_code: Option<i32>,
}

enum RunStatus { Running, Completed, Killed, Failed }
```

### 4.3 Reglas de dispatch

- **Card → In Progress (drag o doble-click)**: backend resuelve `agent = card.agent.or(project.default_agent)`; lanza `claude` (provider del proyecto) en una PTY nueva con `--agent <slug>` si hay agente, cwd y prompt materializado. Crea `CardRun { status: Running }`. Eventos PTY se canalizan al frontend (`pty:data:<sessionId>`).
- **Card → Done después de Running**: prompt al usuario "¿matar la sesión activa?". Sí → kill PTY + `status: Killed`. No → PTY sigue, card cambia estado pero la sesión queda viva.
- **Card → Blocked**: estado humano, sin efecto técnico.
- **Re-ejecutar**: una card puede tener N `runs`. UI: botón "Run again" en el detalle.

### 4.4 Drag-and-drop

Frontend usa HTML5 drag-and-drop (Tauri lo soporta tras `dragDropEnabled` arreglado en `12fd27a`). UI optimista — mueve la card visualmente, llama al backend, rollback si el invoke falla.

### 4.5 Comandos Tauri

```
kanban_load({ projectId }) -> KanbanBoard
kanban_save({ projectId, board })
kanban_create_card({ projectId, columnId, partial })
kanban_update_card({ projectId, cardId, patch })
kanban_move_card({ projectId, cardId, targetColumnId, order })  // dispara dispatch
kanban_delete_card({ projectId, cardId })
kanban_dispatch_card({ projectId, cardId }) -> sessionId   // alternativa explícita
```

---

## 5. Terminal embebida

### 5.1 Stack técnico

- **Backend Rust:** crate `portable-pty` (wezterm-team, maduro, cross-platform). Spawn de `claude` / `codex` / `gemini` en una PTY. Threads de I/O sobre `master_reader` → canalizados a frontend vía Tauri events.
- **Frontend:** `xterm` + `xterm-addon-fit` + `xterm-addon-webgl`. Tema custom matching las CSS vars dark del Control Center.

### 5.2 Modelo

```rust
struct PtySession {
    id: String,                 // ulid
    project_id: String,
    card_id: Option<String>,    // None si es session libre (quick action)
    provider: String,           // "claude" | "codex" | "gemini"
    started_at: String,
    status: PtyStatus,
    pty: PtyChild,              // portable-pty handle
}

enum PtyStatus { Running, Exited(i32), Killed }
```

### 5.3 Comandos Tauri

```
pty_spawn({ projectId, cardId?, provider, agent?, cwd, prompt? }) -> sessionId
pty_write({ sessionId, data })             // keystrokes (binary str)
pty_resize({ sessionId, rows, cols })
pty_kill({ sessionId })
pty_list({ projectId }) -> [PtySessionSummary]
```

### 5.4 Eventos hacia frontend

```
pty:data:<sessionId>   payload: { data: base64 }    // stdout/stderr chunks
pty:exit:<sessionId>   payload: { exit_code: i32 }
```

### 5.5 Multi-terminal por proyecto

Un sub-tab-bar interno aparece dentro del sub-tab "Terminal" cuando hay >1 PTY activo en el proyecto. Cada tab muestra: agente activo, card asociada (si la hay), estado, runtime.

### 5.6 Ciclo de vida

- **Cerrar pestaña de proyecto**: dialogue "Tienes N sesiones vivas. ¿Matarlas o background?". Background = la PTY sigue viva, pero sin UI suscrita; reconecta si reabres la pestaña.
- **Cerrar app**: hook `on_close` mata todas las PTYs vivas (con confirmación si alguna está corriendo).
- **Scrollback persistente**: opcional, off por defecto. Activable per-card si quieres replay completo.

### 5.7 Auth

`claude` CLI usa la auth de suscripción del user (OAuth) sin tocar el código. La PTY hereda el entorno del proceso Tauri, que hereda del shell del usuario.

---

## 6. Biblioteca de agentes/skills

### 6.1 Orígenes

| Origen | Path | Editable | Indicador UI |
|---|---|---|---|
| Global | `~/.claude/agents/*.md`, `~/.claude/skills/*/SKILL.md` | sí | (default) |
| Per-project | `<project_path>/.claude/agents/*.md`, `<project_path>/.claude/skills/` | sí | chip `project` |
| Plugin ECC | `~/.claude/plugins/cache/.../agents/` | no | chip `plugin` |

### 6.2 UI

**Sub-tab "Agents" dentro de cada proyecto** + tab global "Agents" en sidebar. Ambos comparten componente, con filtro de scope.

- Lista con búsqueda por nombre/descripción/tools.
- Filtros: scope (global / project / plugin), tools usados.
- Fila: nombre, descripción 1-line, tools (chips), botones `Edit`, `Use in card`, `Duplicate`, `Delete` (delete solo no-plugin).

### 6.3 Crear in-app

Botón "+ New agent" → modal con editor de frontmatter + body markdown. Validador:
- `name` required (kebab-case, único).
- `description` required (1-2 líneas).
- `tools` opcional (lista).

Target picker: `global` o `<project>`.

### 6.4 Buscar en GitHub

Botón "Search GitHub" → modal con input. Backend:

```
agents_search_github({ query, limit: 30 }) -> Vec<RemoteAgent>
```

Implementación: `gh search code "<query> path:.claude/agents extension:md"` via `gh` CLI (token del user, ya autenticado como `SkiTemplar`). Rate limit: 30 req/min — debounce 500ms + cache 10min por query.

Resultados muestran: repo, autor, estrellas, preview del frontmatter, total de tools.

Botón **Install** → modal:
- Target scope: global / project.
- Validador de colisión: si ya existe, prompt para sobrescribir o renombrar.

```
agents_install_from_github({ owner, repo, path, target_scope, target_name? })
```

### 6.5 Skills

Estructura paralela. Tab global "Skills" + sub-tab del proyecto. Mismos orígenes (global / project / plugin). Búsqueda GitHub idem (`path:.claude/skills extension:md` o búsqueda en `SKILL.md`).

### 6.6 Per-project pinning

`~/.ultron/cockpit/projects/<project_id>/pinned-agents.json`:
```json
{ "pinned": ["ecc:rust-reviewer", "ecc:django-reviewer"] }
```

El picker de agente en cards muestra primero los pinneados, después el resto en orden alfabético.

---

## 7. Memory + Mem0

### 7.1 Tab global "Memory" del sidebar

Reescribe `Memory.tsx` (que era Qdrant/brain/vault).

Contenido:
- **Estado de Mem0**: conectado / desconectado (test del MCP), latencia, API key visible (masked) con botón "Update" → abre `settings.json` con scroll a la sección `mem0`.
- **Búsqueda transversal**: input → invoca el cliente Mem0 vía MCP. Resultados como cards con highlight de matches.
- **Acciones globales**: "Export memorias", "Limpiar memorias del proyecto X".

### 7.2 Sub-tab "Context" dentro de cada proyecto

- **CLAUDE.md editor** (top): si existe `<project_path>/CLAUDE.md` o `<project_path>/.claude/CLAUDE.md`, editor markdown inline (textarea con preview lateral). Save atómico.
- **Mem0 panel**: lista de memorias filtradas por `project_id = <project_id>`. Backend invoca Mem0 con filtro. Cada memoria: contenido, fecha, score si aplica.
- **Add memoria manual**: botón para añadir una memoria taggeada con el proyecto sin tener que abrir Claude.

### 7.3 No exposición del knowledge graph de ECC

ECC tiene su propio MCP de memoria (entities/relations). Es **global** — no se filtra por proyecto. Decisión: no surfacearlo en la GUI. Si el user quiere usarlo lo hace desde una sesión de Claude. La GUI no es client de ese grafo.

---

## 8. PC Diagnostic rediseñado

### 8.1 Ubicación

Sigue dentro del tab System del sidebar, en una sub-tab "PC Diagnostic" propia.

### 8.2 Checks nativos (sustituyen `run_doctor` Python shell-out)

| Categoría | Implementación |
|---|---|
| CPU / RAM / top processes / uptime | crate `sysinfo` |
| Disk space + SMART (best-effort) | `sysinfo` + `windows-rs` para SMART |
| Event Log (System + Application, ≥ Warning, últimas 24h) | `wmi` crate o `windows-rs` (EvtQuery) |
| OS info | `tauri-plugin-os` |
| Network connectivity | TCP connect a 1.1.1.1:443 con timeout 2s |
| App-specific: integridad de `projects.json`, `claude` / `codex` / `gemini` en PATH, estado MCP Mem0 | comandos propios |

### 8.3 UI

- Botón "Run diagnostic" → spinner → cards (una por categoría), severidad por color: ok / warn / error.
- Botón "Analyse with AI" → invoca `diagnose_with_ai` que llama `claude --print` con el reporte JSON como input (caso de uso inline VÁLIDO: no interactivo, output corto, no requiere I/O del user). Salida markdown se renderiza inline en una vista de panel lateral.
- **Excepción confirmada al "nunca uso inlines"**: el user aprobó este caso porque es read-only y el output es bounded.

### 8.4 Historial

Cada run persiste a `~/.ultron/cockpit/diagnostics/<ISO-timestamp>.json`. Lista de pasados con: fecha, resumen 1-línea, badge severidad máxima. Click → vista completa con diff vs. previo.

Retención: últimos 30 runs (configurable). Auto-prune al exceder.

### 8.5 Scheduled (opcional)

Checkbox "Run daily at HH:MM" en la sub-tab. Backend:
- Registra una tarea en Windows Task Scheduler vía `schtasks.exe /create` (sobrevive a reinicios; no hilo eterno).
- La tarea invoca el binario del Control Center con flag `--run-diagnostic` (modo headless).
- Si el run programado detecta deltas críticos (events nuevos nivel ≥ Error, disco <10%, RAM >85%, MCP Mem0 down) → emite alerta a `alerts.jsonl` → aparece en Notifications.

---

## 9. Audit ULTRON: qué se quita / queda

Aplicado el criterio del usuario: **default REMOVE**, mantener solo si vital sin sustituto ECC/Mem0.

| Pieza | Sustituto / Razón | Verdicto |
|---|---|---|
| News (`news.rs`, `News.tsx`) | sin valor en ECC | REMOVED (0a) |
| Self-Improve/Stats (`self_improve.rs`, `SelfImprove.tsx`) | depende del AI Router; sin valor en ECC | REMOVED (0a) |
| Full Diagnostic (`full_diagnostic.rs`) | sub-componentes valiosos se quedan en PC Diagnostic | REMOVED (0a); piezas migran |
| AI Router (`ai_router.rs`, `commands/ai_router.rs`, `AiRouterSection.tsx`) | Claude Code Task tool + per-card agent | REMOVE (0b) |
| Qdrant memory + brain_index + vault | Mem0 + ECC knowledge graph | REMOVE (P1) |
| `memory_graph.rs`, `memory_highlights.rs` | parte del stack Qdrant | REMOVE (P1) |
| Mode LOW/MED/HIGH/ULTRA (`mode.rs`, `ModeSection`, `ModeSwitcher`) | redundante con FeaturesSection | REMOVE (0c) |
| `version_drift.rs` | era multi-componente ULTRON | REMOVE (0c) |
| `ultron_status` (shell a `ultron.ps1`) | Dashboard ya muestra estado | REMOVE (0c) |
| `run_detect_gaps` (Python script) | Backlog del Kanban es el nuevo "pending" | REMOVE (0c); badge sidebar pasa a contar Backlog |
| `run_doctor` shell-out a Python | checks nativos Rust | REPLACE (P6) |
| Skill/Agent vault + findings (`commands/skills.rs`, `commands/agents.rs`) | `/ecc:security-scan` si se quiere escanear | REMOVE (0c) |
| `maintenance.rs` (kinds Qdrant) | dead post-P1 | REMOVE kinds Qdrant (0c); audit resto |
| `button_prompts.rs` (catálogo) | editor de templates es UX valioso | KEEP catálogo, REMOVE solo el campo `zone` (0b) |
| PC Diagnostic (`run_diagnose`, `diagnose_with_ai`) | sin equivalente ECC | KEEP + IMPROVE (P6) |
| Storage `~/.ultron/` para projects/plans/alerts/etc. | hay que persistir; rebrand no decidido | KEEP path |
| Branding "ULTRON Control Center" | cosmético, no decidido | KEEP por ahora |

---

## 10. Plan de migración por fases

17 commits aprox, 9 fases. Cada fase deja el árbol compilando (`cargo check` + `tsc --noEmit` verdes).

| # | Fase | Scope | User-visible | Commits |
|---|---|---|---|---|
| 0a ✓ | Removal — News/Self-Improve/Full Diagnostic | (hecho `a9c48d5`) | menos cruft | 1 |
| 0b | AI Router removal + decouple (mcps, system_diagnose, Dashboard, Notifications, button-prompts) | menos cruft | 1 |
| 0c | Mode, version_drift, ultron_status, run_detect_gaps, vault/findings, maintenance kinds Qdrant | menos cruft | 1 |
| 1 | Memory → Mem0 (delete Qdrant backend; new global Memory tab) | Mem0 funcional en app | 2 |
| 2 | Skills + Agents + Rules viewers (scope global/project/plugin, toggle on/off, abrir editor) | "veo y gestiono" | 1 |
| 3 | Embedded terminal (portable-pty + xterm.js + comandos pty_*) | adiós wt.exe popups | 2 |
| 4 | **Projects re-architecture** (tabs por proyecto, workspace con sub-tabs, Kanban data model, dispatch) | abro proyecto, trabajo dentro | 3-4 |
| 5 | Library de agentes/skills (gh search code, install modal, in-app editor, per-project pinning) | "instalo agentes desde GitHub sin salir" | 2 |
| 6 | PC Diagnostic rediseñado (checks nativos, AI in-app, historial, scheduled) | diagnóstico moderno | 2 |
| 7 | Settings cleanup (promover editor settings.json, estado plugins ECC, MCPs, hooks unificado) | Settings deja de ser cajón | 1 |
| 8 | Kirkardo gate (UX rubric ≥9.5), changelog reset SemVer, tag `v2.0.0` | release | 1 |

### Orden de dependencias

- **0b** debe ir antes de **P3** (button-prompts decoupled requerido para los nuevos call-sites de spawn).
- **0c** puede ir en paralelo con 0b en un mismo día de trabajo.
- **P1** (Memory→Mem0) es independiente de P2-P5 pero conviene pronto para quitar dead code masivo.
- **P3** (terminal) debe ir antes de **P4** (Projects workspace usa la terminal embebida).
- **P5** (library + GitHub search) puede solapar con P4 si se hace por subagentes paralelos.
- **P6** (PC Diagnostic) usa el `claude --print` inline — independiente de P3/P4.

### Cadencia de tags

Tags intermedios opcionales por fase (`v2.0.0-alpha.N`) si te apetece. Tag estable `v2.0.0` solo al cerrar P8 (Kirkardo gate ≥9.5). Política de release ya validada: tag solo en stable milestones.

---

## 11. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| Compilación rota mid-fase | `cargo check` + `tsc --noEmit` antes de cada commit. Sub-commits dentro de cada fase si la superficie es amplia. |
| `features.json` legacy con keys borrados (`news`, `self_improve`, `mode`) | serde ignora unknown fields (default behavior); frontend usa spread `{ ...ALL_ENABLED, ...f }`. Patrón ya aplicado en 0a. |
| `~/.ultron/cockpit/*` JSONs viejos | Loaders idempotentes: ignore unknown + fill missing con default. Aplicar consistentemente a kanban.json, pinned-agents.json, project metadata. |
| Bundle size con `portable-pty` + `xterm` + `sysinfo` + `wmi` | +~3MB total. Aceptable para Tauri desktop (binario actual ~15MB). |
| `gh search code` rate limit (30 req/min) | Debounce input 500ms + cache 10min por query. Indicador "rate-limited, retry en Xs" si el server responde 429. |
| Mem0 API caída | Panel falla gracefully ("Mem0 no responde" + retry). Búsquedas con timeout 5s. NO bloquea resto de UI. |
| PTY processes huérfanos al cerrar app | `on_close` Tauri hook: matar todos los PTYs vivos con confirmación si alguno está activo. Timeout 5s, después kill -9. |
| Drag-and-drop nativo Tauri conflicts | Ya resuelto en `12fd27a` (dragDropEnabled). El nuevo Kanban hereda el fix. |
| User cierra accidentalmente una pestaña con PTY corriendo | Confirmación con tres opciones: Cancel / Background (PTY sigue) / Kill. |
| Migración de proyectos existentes a la nueva estructura (kanban.json vacío + sub-folders) | Migration script en P4: lee `projects.json` actual y crea `~/.ultron/cockpit/projects/<id>/kanban.json` con board vacío (default 4 columns). Idempotente. |

---

## 12. Decisiones cerradas (registro)

Tomadas durante el brainstorm 2026-05-22/23:

1. **Ejecución de agentes**: terminal embebida (PTY + xterm.js), auth de suscripción Claude Code. NO inlines (excepto PC Diagnostic AI analysis, caso bounded).
2. **Kanban cards = tareas que disparan agente** (no notas Trello-style).
3. **Layout**: pestañas por proyecto (estilo navegador), no master-detail ni full-screen takeover.
4. **Agente por card**: default de proyecto + override por card; biblioteca expandible vía GitHub search y creación in-app.
5. **Mode LOW/MED/HIGH/ULTRA**: REMOVE.
6. **Branding**: "ULTRON Control Center" se queda por ahora. Rebrand opcional posterior con script de migración 1-shot.
7. **Storage root**: `~/.ultron/` se queda.
8. **Companion visual**: declinado. Texto + dark ULTRON aesthetic + Lucide icons (no emojis).
9. **Implementación**: subagentes paralelos donde sea seguro (creación de ficheros nuevos), wiring final por el agente principal.
10. **PC Diagnostic**: KEEP + IMPROVE (no se elimina aunque venga de la era ULTRON).

---

## 13. Open items / future work

- **Mem0 schema de `project_id`**: confirmar cómo Mem0 quiere el tag (campo custom? user_id compuesto?). Doc check al implementar P1.
- **`gh search code` paginación**: limitar primer fetch a 30; añadir "load more" si hace falta.
- **xterm webgl renderer en Tauri**: validar perf en Windows con dark theme (algunos drivers Intel iGPU tienen issues con WebGL contextos múltiples). Fallback al canvas renderer si detecta problemas.
- **Rebrand opcional**: cuando el user decida, script de migración `~/.ultron/` → `~/.cc/` (o equivalente). Update tauri.conf.json, Cargo.toml, package.json, instalador.
- **Kirkardo rubric**: definir los criterios exactos del gate ≥9.5 al cerrar P7, antes de empezar P8.
- **Backup/restore del workspace de proyectos**: exportar/importar `~/.ultron/cockpit/projects/` (incluye boards, pinned-agents). Post-v2.0.

---

## 14. Glosario

- **PTY**: pseudo-terminal. Pareja master/slave que permite a un proceso (terminal) comunicarse con otro proceso (shell, CLI) como si fuese una terminal real.
- **xterm.js**: librería JS que renderiza un terminal en el browser/Tauri webview a partir de un stream de bytes ANSI.
- **ECC**: Everything Claude Code, el plugin instalado en `~/.claude/plugins/`.
- **Mem0**: servicio cloud de memoria cross-session, accedido vía MCP.
- **Card dispatch**: el acto de mover una card del Kanban a "In Progress" → arrancar la sesión de agente correspondiente.
- **Per-project**: scope que aplica solo dentro de un proyecto específico (carpeta `<project_path>/.claude/`).

---

**Próximo paso:** invocar la skill `superpowers:writing-plans` para generar el plan de implementación detallado por fase, ejecutable por subagentes paralelos.
