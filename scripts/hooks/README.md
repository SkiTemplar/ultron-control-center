# ULTRON Hooks

Hooks are wired into `~/.claude/settings.json` automatically by the installer.
The single source of truth is
[`../../templates/settings-hooks.json`](../../templates/settings-hooks.json);
`install.ps1` / `install.sh` merge that template into the user settings
non-destructively (with backup). The token `{USERPROFILE}` expands to the
user's home (forward-slash form) at install time.

> The runtime is **Node-first**: most hooks are JavaScript under
> `hooks/scripts/*.js` and run with `node`. Two Python hooks survive and run
> with `uv run python`. `tests/test_hooks_template.py` asserts that every
> script the template references actually exists in the repo, so the template
> can never again wire a missing script (which would block every prompt/tool).

To override or disable a hook for your account, edit `~/.claude/settings.json`
directly — the merge step preserves user-added entries.

---

## Active hooks (by event)

All paths are relative to `~/.ultron/` unless noted.

### SessionStart

| Script | Purpose |
|---|---|
| `hooks/scripts/ensure-qdrant.js` | Cold-start safety net: probes `localhost:6333/healthz` and launches the native Qdrant binary if it is down (fire-and-forget). |
| `hooks/scripts/memory-warmup.js` | Starts the memory daemon so the E5 model stays resident across the session. |
| `hooks/scripts/load-cross-project-memory.js` | Loads cross-project memory relevant to the current working directory. |
| `hooks/scripts/session-start-override.js` | Injects the session resume / initial context block. |
| `hooks/scripts/memory-session-resume.js` | Hermes-style recall: open tasks, recent decisions, warnings. |

### UserPromptSubmit

| Script | Purpose |
|---|---|
| `cockpit/skill-lazy/routing-dispatcher.v2.js` | Lazy skill/agent routing: injects the matching skill on-demand from the prompt. |
| `hooks/scripts/save-user-prompt.js` | Persists the user prompt for the capture pipeline. |
| `hooks/scripts/memory-orchestrate.js` | Prefetch / orchestrate: relevant memories, step plans, delegation hints. |

### PreToolUse

| Script | Matcher | Purpose |
|---|---|---|
| `hooks/scripts/deny-secrets.js` | `Read\|Edit\|Write\|NotebookEdit\|Bash` | Blocks reads/writes that would touch secrets (`.env`, credentials) via `permissionDecision: deny`. Node since 2026-08-11. |
| `hooks/scripts/codegraph-reminder.js` | `Read\|Grep` | Reminds to consult the CodeGraph index before reading code files. |

### PostToolUse / SubagentStop / PreCompact

| Script | Event | Purpose |
|---|---|---|
| `hooks/scripts/posttoolfail-capture.js` | PostToolUse | Captures tool failures as memory candidates. |
| `hooks/scripts/subagent-harvest.js` | SubagentStop | Harvests subagent results into memory. |
| `hooks/scripts/precompact-preserve-l0.js` | PreCompact | Preserves L0 (pinned) memory before context compaction. |

### Stop / SessionEnd / Notification

| Script | Event | Purpose |
|---|---|---|
| `hooks/scripts/stop-compress-session.js` | Stop | Compresses the session into memory candidates. |
| `hooks/scripts/kanban-update-reminder.js` | Stop | Reminds to sync the project kanban. |
| `hooks/scripts/batch-capture.js` | Stop | Batch-captures pending memory candidates. |
| `hooks/scripts/qdrant-mirror-sync.js` | Stop | Syncs the SQLite → Qdrant mirror. |
| `scripts/cockpit/route_quality_aggregator.py` | Stop | Aggregates the day's routing-quality telemetry. |
| `hooks/scripts/session-end-summary.js` | SessionEnd | Writes a short end-of-session summary. |
| `hooks/scripts/notify-relay.js` | Notification | Relays Claude Code notifications to the desktop. |

The one surviving Python hook (`route_quality_aggregator.py`) runs via
`uv run python`; everything else runs via `node` (deny-secrets was ported to
Node on 2026-08-11 to drop the ~200ms `uv` startup from the per-tool-call
hot path).

---

## Qdrant boot helpers (not Claude Code hooks)

`ensure-qdrant.js` is a real SessionStart hook (above). The native-binary
launcher scripts and the logon scheduled task live under `scripts/qdrant/`:
`ensure-qdrant.ps1` / `ensure-qdrant.sh`, `qdrant-notify.ps1`,
`qdrant-bootcheck-hidden.vbs`, `install-qdrant-bootcheck.ps1`. These back the
`ULTRON-QdrantBoot` Windows scheduled task that runs at user logon; they are
not `settings.json` hooks.

---

## Add or override a hook

The hook spec lives in `~/.ultron/templates/settings-hooks.json`. After editing
it, re-run `install.ps1` (idempotent) or merge it manually into
`~/.claude/settings.json`. A new Node hook follows the pattern:

```json
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "node {USERPROFILE}/.ultron/hooks/scripts/<your-hook>.js", "timeout": 10 }
        ]
      }
    ]
  }
}
```

Hook scripts read JSON from stdin and exit 0 unless they intentionally block
(exit 2 = hard refusal, surfaced to the model as stderr). If you add a script,
make sure `tests/test_hooks_template.py` still passes (it checks the template
only references scripts that exist).

## Test a hook locally

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"test.txt"}}' \
  | node ~/.ultron/hooks/scripts/deny-secrets.js
```

---

## References

- [Hooks reference (Claude Code)](https://code.claude.com/docs/en/hooks)
- `~/.ultron/templates/settings-hooks.json` — the authoritative hook spec
