# Memory tab redesign + Workdays auto-link drainer — 2026-05-26

Two-task delivery for the Control Center memory/sessions sprint.

## T1 — Memory tab live systems view

### Backend (Rust / Tauri)

New module `src-tauri/src/memory_status.rs` plus its command wrappers under
`src-tauri/src/commands/memory_status.rs`. Six new commands wired into
`lib.rs`'s `generate_handler!` block.

| Command                          | Returns               | Purpose                                                                                                                                                              |
| -------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory_status_mem0`             | `Mem0CardStatus`      | API key state (masked) + memory count for `user_id="global"` + last successful op + log path. Reuses `mem0::diagnostics_inner` and `mem0::list_all_inner`.           |
| `memory_status_ecc`              | `EccCardStatus`       | Entity count, relation count, size in bytes, source path. Delegates to existing `ecc_memory::ecc_memory_read`.                                                       |
| `memory_status_graphify`         | `GraphifyCardStatus`  | Runs `graphify --version` (with a Windows cmd.exe fallback for `.cmd` shims) and `graphify list`. Surfaces installed/version/project count and raw project list.    |
| `memory_status_files`            | `MemoryFilesCardStatus` | Walks `~/.claude/projects/*/memory/*.md` once; aggregates file count + total bytes.                                                                                |
| `memory_sync_mem0_manual`        | `SyncResult`          | Spawns `node ~/.claude/scripts/mem0-sync.js` with `ULTRON_MANUAL_SYNC=1` and captures stdout/stderr/exit/duration.                                                  |
| `memory_graphify_index(path)`    | `IndexResult`         | Runs `graphify .` with `cwd=path`. Validates path existence first.                                                                                                  |

All probes are best-effort: missing binaries / unreadable files surface as
`healthy=false` plus an `error` string. No hard failures.

### Frontend (React / TS)

Rewrote `src/components/Memory.tsx` (~1100 LOC → ~850 LOC):

- **`MemoryStatusCards`** — 4-card row with health pills (green/yellow), key
  metrics, and inline error display. Auto-refreshes every 30s and exposes a
  manual Refresh button.
- **`Mem0Diagnostics`** — Sync now / Test endpoint / Refresh log buttons. Log
  viewer shows last 20 entries from `~/.ultron/logs/mem0.jsonl` with op,
  HTTP status, latency and error excerpt.
- **`GraphifyControls`** — Path input + "Index project" button (invokes
  `memory_graphify_index`); lists known projects from `graphify list`.
- Preserved the previous Mem0 browse pane, ECC graph pane and KG editor as
  separate tabs ("Mem0 browse" / "ECC graph" / "KG editor") so existing
  workflows still work. Default landing tab is the new "Live status" board.

Design system: all colors via `var(--color-*)` tokens already used across
the rest of the Control Center. No emojis. No hardcoded API keys.

## T2 — Sessions ↔ Workdays auto-link

### Backend (Rust / Tauri)

Extended `src-tauri/src/workdays.rs` with a pending-link drainer:

- **`PendingLink`** struct = `{session_id, cwd?, timestamp?}`. Stored
  one-per-line at `~/.ultron/cockpit/workdays/_pending-links.jsonl`.
- **`append_pending_link_inner`** — atomic append; used by the Tauri
  command the hook calls when the Control Center is running.
- **`drain_pending_links_inner`** — reads the file, looks up the most
  recently-started `in_progress` workday (ranks by `start_ts DESC` with
  `created_at` fallback), links every pending session via the existing
  `link_session_inner` (idempotent on duplicates), and rewrites the file
  with anything that couldn't be linked. Returns a `DrainReport` with
  `{processed, linked, kept, errors}`.
- **`drain_pending_links_at_startup`** — called from `lib.rs`'s setup
  hook. Silent on a clean state, otherwise prints a one-line summary to
  stderr. Never aborts startup.

Three new Tauri commands wired into `commands/workdays.rs` + `lib.rs`:

| Command                              | Purpose                                                                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `workday_pending_link_record`        | Append a pending link from the frontend or CLI (used by the JS hook when it cannot find a Tauri CLI).                                       |
| `workday_drain_pending_links`        | Manual drain trigger (returns the `DrainReport`).                                                                                           |
| `workday_auto_link_session`          | One-shot append + drain. Primary entry point for the hook when the Control Center is reachable.                                              |

### Hook (Node)

`~/.claude/scripts/workday-session-linker.js` — SessionStart hook:

1. Reads `session_id` from the hook stdin payload (falls back to extracting
   it from `transcript_path`).
2. Skips non-startup sources (resume/clear/compact).
3. Tries `~/.ultron/control-center/scripts/ultron-cli.cmd` (or POSIX
   equivalent) to invoke `workday_auto_link_session`. Optional helper —
   not required for correctness, but lets the link land in <100ms when
   the Control Center is running.
4. Falls back to writing the pending JSONL line — the backend will drain
   it at next startup.
5. Logs everything to `~/.claude/logs/workday-session-linker.jsonl`.
6. Always emits an empty `additionalContext` payload and exits 0.

Registered in `~/.claude/settings.json` under `SessionStart` as a sibling
entry to `session-start-override.js` (both run; hooks array preserves the
existing one).

### UI

`src/components/Workdays/WorkdayDetail.tsx` — added a `LinkedSessionsBlock`
that lists `workday.linked_sessions` with an "Open transcript" button per
session. The button tries the three known Claude Code session-file
locations:

- `~/.claude/session-data/<id>-session.tmp`
- `~/.claude/data/sessions/<id>.jsonl`
- `~/.claude/observer/sessions/<id>.jsonl`

Falls back gracefully (shows an inline error) when no file is found.

## Verification

- `cargo check` (src-tauri): clean — one pre-existing `dead_code` warning
  on `CmdResult` (unchanged by this patch).
- `npx tsc --noEmit` (src): clean, no diagnostics emitted.

## Files touched / created

### Created

- `src-tauri/src/memory_status.rs`
- `src-tauri/src/commands/memory_status.rs`
- `~/.claude/scripts/workday-session-linker.js`
- `cockpit/diagnostics/memory-sessions-workdays-2026-05-26.md` (this file)

### Modified

- `src-tauri/src/lib.rs` — module declaration, command registration,
  startup drain call.
- `src-tauri/src/commands/mod.rs` — `pub mod memory_status;`.
- `src-tauri/src/commands/workdays.rs` — pending-link commands.
- `src-tauri/src/workdays.rs` — drainer logic + helpers.
- `src/components/Memory.tsx` — full rewrite.
- `src/components/Workdays/WorkdayDetail.tsx` — linked-sessions block.
- `~/.claude/settings.json` — SessionStart hook merged.

## Notes / follow-ups

- `ultron-cli.cmd` helper does not yet exist. The hook silently falls back
  to the pending file, which is correct behavior. If we later expose a
  thin CLI, the same hook will start using it without further changes.
- The Memory tab status cards poll every 30s. The mem0 card hits the cloud
  `/v1/memories/?user_id=global` endpoint; this is the same call the
  existing `Mem0Pane` already makes on a 30s cadence, so the total network
  budget is unchanged.
- `MemoryFilesCardStatus` walks the `~/.claude/projects/` tree on every
  card refresh. With typical project counts (<50) this stays sub-10ms; if
  it ever grows we can cache it behind a 60s TTL.
