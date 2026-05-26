# Agents tab redesign — "Plantilla de empleados"

Date: 2026-05-26
Author: Terry (control-center 2.7.1 working tree)

## Brief

USER, verbatim:

> "gestión de skills y agentes super mejorada con proyectos gestión de agentes implementado automáticamente, como si fuese una empresa y fuese yo gestor de empleados desde la zona de agentes... Yo lo que necesito es una zona donde configurar el tipo de agentes delegar tareas que funcionen con sesiones, que se activen como los workflows, automatizaciones"
>
> "he detectado emojis y botones que no pertenecen al mismo diseño de la del sistema, como por ejemplo en agentes. hecho ese botón está mal"

## Audit of the previous `src/components/Agents.tsx`

- Emoji scan with `[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{27BF}]`: 0 matches.
- The previous viewer reused the Skills shell (TreeView / BlocksView / LibraryDetailPane). Only the `Bot` SVG icon was used. No emojis or off-theme buttons in the literal source, but the surface was not framed as "managing employees" and offered no delegate / workflow / automations affordances.

## Agent inventory available at the time of writing

- `~/.claude/agents/`: 79 markdown files (community pack + ULTRON agents).
- `~/.claude/plugins/cache/*/agents/`: discovered at runtime by `list_agents` (origin = plugin).
- Project agents picked up under `<project>/.claude/agents/` when the user opens a project.

The new view groups all of them into 9 departments (Engineering, Design, Ops, Research, Strategy, Game, Personal, Meta, Other) via regex-based classification on name + description.

## Changes

### Backend (Rust, Tauri 2)

1. New module `src-tauri/src/agent_orchestration.rs` (full file).
   - `delegate_task_inner` — spawns a Claude session via `sessions::spawn_session_inner` with `flags.agent = Some(slug)` and optional `flags.model = "claude-haiku-4-5"` when the caller flags `use_cheap_model`.
   - `list_workflows_inner` — returns the canonical seven alignments (quick / feature / debug / security / research / game / learning) as `WorkflowDefinition { id, label, description, steps[] }`. Pinned in-source so the UI works on a fresh install even when the user has vaulted the skill markdown.
   - `validate_agent_slug` — accepts `[a-z0-9_-]{1,80}`. Rejects `Foo`, `agent/etc`, `agent\bad`, `agent.md`.
   - 4 unit tests (slug validation positive + negative, workflow count, cheap-model resolver).

2. `src-tauri/src/commands/agents.rs` — added three Tauri commands:
   - `delegate_task_to_agent(request: DelegateRequest) -> SpawnResult`
   - `list_agent_workflows() -> Vec<WorkflowDefinition>`
   - `list_active_hooks() -> HooksList` (thin proxy over `hooks_admin::list_hooks_inner`).

3. `src-tauri/src/lib.rs` — registered `mod agent_orchestration` and added the three commands to `generate_handler!` (lines 20, 207-209 after the edits).

### Frontend (React + Tauri)

4. `src/components/Agents.tsx` — full rewrite (~1100 LOC). Three sub-views switchable from a single segmented toolbar:
   - **Plantilla** — agents are grouped by department with a coloured ribbon per dept. Each agent renders an ID card: DiceBear bottts avatar (`https://api.dicebear.com/7.x/bottts/svg?seed=<slug>&backgroundColor=...`), name, dept label + origin chip, description preview, placeholder performance rating (`Rating ∅`), `Delegate` button.
   - **Workflows** — one card per canonical alignment with a step chain rendered as `Step → Step → Step` (each step is a chip with a mini avatar). `Run workflow` posts to `delegate_task_to_agent` with the first agent + the rendered workflow plan as the task description.
   - **Automations** — read-only hook listing from `list_active_hooks`. Each hook gets an event badge (green when enabled, slate when disabled), source tag (user / plugin:<id>/<name>), matcher line, and a `<pre>` block with the command. `New automation` shows a toast pointing to the Hooks tab.

5. Delegation modal (`DelegateTaskModal`):
   - Textarea for the task description (max 16 KB enforced server-side).
   - Select dropdown over all agents with a TF-IDF-style suggestion that highlights the best-overlap match for the typed task.
   - Checkbox "Use cheap model (Haiku 4.5 — AI Router code-edit zone)".
   - Submit calls `delegate_task_to_agent` and toasts the result.

6. New workflow wizard (`NewWorkflowWizard`):
   - Minimal modal with label + comma-separated agent slug list.
   - Marked explicitly as a draft (toast warns the result is not yet persisted across sessions).

7. Icons: only SVG components from `library/icons.tsx` (`Bot`, `Plus`, `Search`, `Sparkles`, `Terminal`, `X`). No emojis anywhere in the file (verified with the same Unicode regex).

8. Design system: every colour comes from CSS vars (`var(--color-surface-*)`, `var(--color-text)`, `var(--color-border-strong)`, `var(--color-accent)`). Department accents are inline RGBA tokens kept as named constants for readability.

## Files touched / created

- `src-tauri/src/agent_orchestration.rs` — created (~280 lines including tests).
- `src-tauri/src/commands/agents.rs` — added imports + 3 command wrappers (lines 2-5, 53-78).
- `src-tauri/src/lib.rs` — added `mod agent_orchestration` (line 20) and 3 handler entries (lines 207-209).
- `src/components/Agents.tsx` — full rewrite (1146 lines).
- `cockpit/diagnostics/agents-redesign-2026-05-26.md` — this report.

## Verification

```
$ cd src-tauri && cargo check
warning: struct `CmdResult` is never constructed   (pre-existing, unrelated)
warning: `control-center` (lib) generated 1 warning
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.36s

$ npx tsc --noEmit
(no output — clean)
```

Both checks green. No new warnings introduced.

## ASCII mockup

```
+--------------------------------------------------------------------------+
| Plantilla            141 employees on roster   [+ New task] [+ Hire] [R] |
+--------------------------------------------------------------------------+
| [ Plantilla ]  [ Workflows ]  [ Automations ]                            |
+--------------------------------------------------------------------------+
| (All scopes) (Global) (Project) (Plugin)                                 |
| Department  [* All 141] [* Engineering 38] [* Design 6] [* Ops 9] ...    |
| [  search the roster ...                                              ]  |
+--------------------------------------------------------------------------+
|                                                                          |
|  * Engineering (38)                                                      |
|  +-----------------+ +-----------------+ +-----------------+             |
|  | [bot] terry-davis | [bot] code-rev    | [bot] debugger    |           |
|  | Engineering glo | Engineering plu   | Engineering glo   |             |
|  | Elite engineer  | Reviews diffs ... | Localiza causa ...|             |
|  | Rating (empty)  Delegate | Rating  Delegate | Rating  Delegate         |
|  +-----------------+ +-----------------+ +-----------------+             |
|                                                                          |
|  * Design (6)                                                            |
|  +-----------------+ +-----------------+                                 |
|  | [bot] mike-tyson  | [bot] ui-designer |                                |
|  +-----------------+ +-----------------+                                 |
|                                                                          |
|  * Research (5) ...                                                      |
+--------------------------------------------------------------------------+
```

Workflows view:

```
+-------- Workflows --------+
|                           |
| New feature       [ Run ] |
| New features in any ...   |
| (don-claudio) -> (terry)  |
|              -> (kirkardo)|
|                           |
| Stuck debug       [ Run ] |
| (debugger) -> (terry) ... |
|                           |
+---------------------------+
```

Automations view:

```
+- Automations -------------+
| [PreToolUse] hk_a3f1...   |
| matcher: Bash             |
| powershell -File ...      |
|                           |
| [Stop]      hk_b912...    |
| python .../audit.py       |
+---------------------------+
```

## Known gaps / next iterations

- Performance rating is hard-coded `∅`. We need a `~/.ultron/cockpit/agent-usage.jsonl` log + a small aggregator to populate it.
- `NewWorkflowWizard` does not persist. Next step: `~/.ultron/cockpit/workflows/<id>.json` + a `workflows_save` command.
- The Automations sub-tab is read-only. A future iteration could wrap `add_hook` / `toggle_hook` / `delete_hook` so the user does not have to bounce to the Hooks tab.
- DiceBear is fetched over HTTP each render. Acceptable for a desktop app on broadband, but caching to `~/.ultron/.cache/avatars/<slug>.svg` would make the grid resilient to offline boots; the fallback Bot icon already covers that case visually.

## Constraint checklist

- [x] No emojis in code (regex `[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]` returns zero matches in the new Agents.tsx).
- [x] Tailwind + CSS vars (`var(--color-*)`) used throughout — matches the rest of the Control Center.
- [x] New backend commands skeleton + wiring in `lib.rs` and `commands/mod.rs`.
- [x] `npx tsc --noEmit` green.
- [x] `cargo check` green (warning is pre-existing).
- [x] Report path: `cockpit/diagnostics/agents-redesign-2026-05-26.md`.
