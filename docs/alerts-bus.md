# ULTRON Alerts Bus

> Persistent, append-only alert channel for any silent ULTRON script that needs to surface state to the user without spawning a console window.

**Introduced:** v13.4.0 (Sprint 1, 2026-05-04 — "SILENT + ALERTS").

---

## Why

Sprint 1 silenced every ULTRON script (no popups, ever). A silenced script that hits an error has no way to scream — by design. The alerts bus is the safe, persistent channel that replaces console output for events the user actually needs to see.

---

## Storage

| Path | Role |
|---|---|
| `~/.ultron/alerts.jsonl` | Append-only log of all events (writes + acks) |
| `~/.ultron/alerts/archive/YYYY-MM.jsonl` | Monthly archives produced by `purge` |
| `~/.ultron/alerts.jsonl.lock` | Sidecar OS-level lock used during write/ack |

The main file is **append-only**. Acks are NEW lines, not mutations of existing entries. `archive_older_than()` is the single legitimate rewriter of the main file.

---

## Schema

```jsonl
{"id":"a-2026-05-04-001","ts":"2026-05-04T18:23:11Z","severity":"warn","source":"session-init.ps1","message":"Parser error at line 192","tags":["hook"],"ack":false,"ack_ts":null}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Format `a-YYYY-MM-DD-NNN`. 3-digit counter resets per day. |
| `ts` | string | ISO 8601 UTC, second precision (`Z` suffix). |
| `severity` | enum | `info` < `warn` < `blocking` |
| `source` | string | Originating script/component name |
| `message` | string | Human summary, single line preferred |
| `tags` | string[] | Optional free-form labels |
| `ack` | bool | False at write time. `true` means a later ack-line exists. |
| `ack_ts` | string \| null | Timestamp of the ack-line (folded view only) |

### Ack-as-event line

```jsonl
{"id":"a-2026-05-04-001","ts":"2026-05-04T19:00:00Z","ack":true,"ack_ts":"2026-05-04T19:00:00Z"}
```

This is a separate jsonl line referring to the same id. The fold logic in `read_unacked` collapses both into a single live state.

---

## Severity ladder

```
info  — informational, surfaces only on demand
warn  — surfaces in SessionStart context.md by default
blocking — surfaces and prefixed [BLOCKING] (USER's CLAUDE.md protocol)
```

Default surface threshold for SessionStart injection is **`warn`**.

---

## Concurrency model

A single ULTRON session may have multiple writers concurrently (Python helper from a hook + PowerShell helper from a script + cockpit subprocess). Two layers of protection:

1. **In-process**: `threading.Lock` makes the (read-counter, append) sequence atomic across threads inside one Python process.
2. **Cross-process**: a sidecar OS-level lock (`msvcrt.locking` on Windows, `fcntl.flock` on POSIX) guards the same critical section across processes. 5-second timeout — if the lock can't be acquired (e.g. dead process holding it), we degrade to in-process lock only rather than block startup.

Empirical: 3-thread × 100-write stress test in `test_alerts.py::test_concurrent_writes_no_corruption` lands exactly 300 valid JSON lines with monotonic ids.

---

## Retention

- Default: **30 days** in main file. Older entries → monthly archive.
- Triggered by:
  - Manual `ultron alerts purge --older-than 30d`
  - S5 `ultron doctor` (planned) when alerts.jsonl > 10 MB or unacked-`blocking` > 24h

Archive files are also append-only. Purge is idempotent.

---

## Python API

```python
from alerts import write, ack, read_unacked, archive_older_than

aid = write("warn", "session-init.ps1", "EEXIST mkdir", tags=["hook", "idempotency"])
# returns "a-2026-05-04-002"

unacked = read_unacked(severity_min="warn", limit=5)
# list[dict] sorted by ts ascending

ack(aid)  # returns True if id existed, False otherwise

archive_older_than(days=30)  # returns count moved
```

---

## PowerShell helper

```powershell
& "$env:USERPROFILE\.ultron\scripts\alerts\write-alert.ps1" `
    -Severity warn `
    -Source 'session-init.ps1' `
    -Message 'EEXIST mkdir' `
    -Tags @('hook','idempotency')
# emits the assigned id on stdout
```

Silent by default. `-Verbose` prints diagnostic info. Atomic single-line append via `[System.IO.File]::Open(..., FileMode.Append, FileAccess.Write, FileShare.ReadWrite)`.

---

## CLI commands

All exposed under `ultron alerts <subcommand>` (wrapper in `ultron.ps1`) or directly:

```bash
uv run python ~/.claude/skills/ultron/scripts/cockpit/alerts.py <subcommand>
```

| Subcommand | Description |
|---|---|
| `write -s <sev> --source <name> -m <msg> [-t a,b]` | Append one alert |
| `read-unacked [--severity-min warn] [--limit N] [--format markdown\|json\|table]` | Read tail of unacked alerts (used by SessionStart hook) |
| `list [--severity X] [--unacked] [--limit N] [--format json\|table]` | Browse all alerts (folded state) |
| `ack <id>` | Append an ack record for the given id |
| `purge [--older-than 30d]` | Move old records to monthly archive |

### `--format markdown` (used by SessionStart hook)

Renders alerts as a compact bullet list ready to paste into `~/.ultron/.tmp/context.md`:

```markdown
- **[WARN]** `session-init.ps1` — Parser error at line 192 _(id: a-2026-05-04-001)_
```

---

## Integration points

| Caller | Mode | Severity gate |
|---|---|---|
| **SessionStart hook** (`~/.ultron/hooks/session-init.ps1`) | reads via `alerts.py read-unacked --severity-min warn --limit 5 --format markdown`, appends to `context.md` after primer | warn+ |
| **S5 ultron doctor** (planned) | scans for unacked `blocking` >24h, oversized file | all |
| **Any silent script** | imports `alerts.py` or shells out to `write-alert.ps1` | n/a |

---

## Edge cases handled

- **Malformed lines**: reader skips silently (doctor will flag corruption later).
- **Double ack**: idempotent — appending a second ack-line for the same id leaves the folded state acked.
- **Ack of unknown id**: returns `False` (Python) / exit 1 (CLI). No write happens.
- **Lock timeout**: degrades to in-process lock; never blocks the caller.
- **Cross-day timestamps**: id counter resets on UTC date change, not per-process.

---

## Anti-patterns — DO NOT

- DO NOT mutate existing lines in `alerts.jsonl` — append-only is the contract.
- DO NOT call `read_unacked` with `severity_min` outside `info`/`warn`/`blocking`.
- DO NOT use the bus for high-volume telemetry (>1k events/session). Use `~/.ultron/telemetry/` for that.
- DO NOT echo the alert text to the console — the bus is the channel; the user reads it via context.md or `ultron alerts list`.
