# Regression check 2026-05-26

Scope: all UI/Tauri changes made today, excluding Workdays (owned by another agent).

## Build status

- `npx tsc --noEmit` exit 0, no errors, no output.
- `cargo check` exit 0, single pre-existing warning (`CmdResult` dead-code in `src\commands\mod.rs:67`) unrelated to today's diff.

## Per-file status

| File | Status | Notes |
|------|--------|-------|
| src/components/projects/ProjectWorkspace.tsx | clean | Imports list (Bot, BookOpen, Clock, ExternalLink, FolderOpen, Kanban, Terminal, Notebook, History) all used. Header has only IDE + Folder buttons. No `Layers`, no `spawnRaw`. |
| src/components/Sidebar.tsx | clean | Tab union has no `ai-router`. `FEATURE_TAB_TO_KEY` has no `ai-router`. No dangling refs anywhere in src. |
| src/components/projects/ProjectAgents.tsx | clean | Button "AI configure team" renders text-only (no emoji); the modal's 🤖 marker remains intact and is intentional. |
| src/components/Agents.tsx | clean | 516 lines, Skills-pattern (TreeView/BlocksView/ViewToggle/SearchGitHubModal/InstallConfirmModal/CreateAgentModal/icons) all imported from `./library/*`. Exported as `Agents`; Library `key={tab}` remount path uses `<Library initial=...>` so no direct broken caller. |
| src/components/Sessions.tsx | clean | No `tab`/`setTab` state, no `WorkdaysPanel` import, no `tab === "sessions"` guard. JSX closed cleanly. `showInline`/`showAllSessions`/`showAdvanced` still in use inside the (display:none) Advanced section. |
| src/components/Projects.tsx | clean | No `BatchDropdown` import, no `batchToast`/`setBatchToast` state, no toast UI. Confirmed via grep across `src/`. |
| src/components/projects/ProjectTerminal.tsx | clean | `import BatchDropdown, { type BatchToast } from "./BatchDropdown"` resolves to existing `src/components/projects/BatchDropdown.tsx`. State + auto-fade + toast block render correctly inside the panel chrome. |
| src/App.tsx | clean | Settings sub-tabs not exposed via Tab union (correct: routed internally by Settings). `tab.skills` palette action still maps onto Library. No `ai-router` reference. |
| src/components/Settings/index.tsx | clean | `Section` union includes `"ai-router"`; tabs array includes the AI Router pill at index 4; render branch `section === "ai-router" && <AIRouter embedded />` wired. |
| src/components/AIRouter/index.tsx | clean | `embedded?: boolean` typed, defaults false. Both standalone and `if (embedded)` branches render. |
| src/components/system/Diagnostics.tsx | clean | `const [toolboxOpen, setToolboxOpen] = useState(true)` at line 740 — default open as requested. |
| src/components/AIRouter/AIRouterIndex.tsx | clean | `HELP_DISMISSED_KEY` + dismiss handler present; storage read is try/catch-guarded. |

## Grep audit (imports/state/refs muertos)

- `spawnRaw` -> 0 hits anywhere in `src/`.
- `Layers,` -> 0 hits.
- `setBatchToast` -> only inside `ProjectTerminal.tsx` (active state).
- `ai-router` -> only inside Settings (own subtab) and `AIRouterIndex.tsx` (localStorage key).
- `WorkdaysPanel` -> 0 hits.
- `setTab` in non-App files -> only `Catalog.tsx` (internal SearchTab state, unrelated).

## Bugs introduced

None. The cleanup is consistent: every removed symbol no longer appears anywhere, every added symbol resolves, both type-check and Rust build pass.

## Inline fixes applied

None required.

## tsc tail

```
(no output, exit 0)
```

## cargo check tail

```
warning: struct `CmdResult` is never constructed
  --> src\commands\mod.rs:67:12
   |
67 | pub struct CmdResult {
   |            ^^^^^^^^^
   |
   = note: `#[warn(dead_code)]` (part of `#[warn(unused)]`) on by default

warning: `control-center` (lib) generated 1 warning
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.44s
```

Pre-existing warning, not introduced today.
