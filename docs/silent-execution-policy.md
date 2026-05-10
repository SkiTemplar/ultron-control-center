# Silent Execution Policy

> Sprint 1 Pilar A · v13.4.0 SILENT + ALERTS · Status: ACTIVE
> Wrapper: `~/.claude/skills/ultron/scripts/cockpit/silent_exec.py`
> Audit:   `~/.claude/skills/ultron/scripts/cockpit/audit_silent_exec.py`

## Why

ULTRON Pillar I = **zero terminal flash, ever.** Every popup window during a
Claude Code session is a UX bug — it steals focus, breaks immersion, and on
Windows it can race with the agent's own subprocess output.

The root cause is well-known: on Windows `subprocess.run` / `subprocess.Popen`
will spawn a new console window whenever the child is a console application
and `creationflags=CREATE_NO_WINDOW` is not passed. Same story with
PowerShell `Start-Process` without `-WindowStyle Hidden` (or `-NoNewWindow`).

These flags are easy to forget. This policy + the `silent_exec` wrapper makes
"silent by default" the path of least resistance for new code.

## The wrapper

For **NEW** code (Sprint S2-S5 deliverables, new hooks, new cockpit scripts):

```python
from silent_exec import silent_run, silent_popen

# Drop-in replacement for subprocess.run
result = silent_run(["git", "status"], text=True)
print(result.stdout)

# Drop-in replacement for subprocess.Popen
proc = silent_popen(["long-running-task"])
```

Behaviour on Windows (default):
- Adds `creationflags=CREATE_NO_WINDOW` ONLY if the caller did not supply
  `creationflags` at all (caller-wins, including explicit `creationflags=0`).
- Adds `capture_output=True` for `silent_run`, or `stdout=PIPE, stderr=PIPE` for
  `silent_popen` — only when the caller did not set any of `capture_output` /
  `stdout` / `stderr`.
- For `silent_popen`, `capture_output=True` is translated to `stdout=PIPE,
  stderr=PIPE` BEFORE any other branch (Popen does not accept `capture_output`
  natively); `capture_output=False`/`None` is silently dropped.
- **Caller-supplied kwargs always win** — the wrapper only fills gaps.

Behaviour on POSIX: passthrough (with `capture_output=True` default for `run`).

## Existing wrappers — do NOT migrate

These files implement their own silent-execution patterns. **Leave them alone.**
Migrating to `silent_exec` would risk regressions and add no value:

| File | Pattern | Reason to leave alone |
|------|---------|------------------------|
| `~/.claude/skills/ultron/scripts/shared-duet.ps1` | `Start-Hidden` PowerShell helper for Codex/Gemini calls | Battle-tested, PowerShell-side |
| `~/.claude/skills/ultron/scripts/cockpit/background_tasks.py` | Local `_WIN_HIDDEN = subprocess.CREATE_NO_WINDOW` constant | Same idea, already silent |
| `~/.claude/skills/ultron/scripts/cockpit/job_supervisor.py` | DETACHED_PROCESS / async child supervisor | Different lifecycle model (long-lived background) |

`silent_exec` is for **new** code paths only. The audit script (below) flags
older call sites for opportunistic migration when those files are touched for
other reasons.

## PowerShell rules

- **Hooks:** always invoke PowerShell with `-WindowStyle Hidden -NoProfile -NonInteractive`.
- **Start-Process:** always pass either `-WindowStyle Hidden` or `-NoNewWindow`.
  Never both omitted.
- **Idempotent mkdir:** use `New-Item -ItemType Directory -Path X -Force`.
  `-Force` makes it a no-op when the dir already exists (no error, no popup).
- **Console redirects:** prefer pipes (`|`) and `Out-Null` over `Start-Process`
  for short-lived shell-outs.

## Audit tool

```powershell
# Discovery — writes JSON only, no console flash
uv run python ~/.claude/skills/ultron/scripts/cockpit/audit_silent_exec.py

# Same plus a human-readable summary table
uv run python ~/.claude/skills/ultron/scripts/cockpit/audit_silent_exec.py --print

# CI gating — exit 1 if any hits
uv run python ~/.claude/skills/ultron/scripts/cockpit/audit_silent_exec.py --exit-on-hits
```

Output JSON: `~/.ultron/.tmp/silent-audit.json`

```json
{
  "scanned_at": "2026-05-05T...",
  "stats": { "py_files": 72, "ps1_files": 2, "py_hits": 3, "ps1_hits": 0 },
  "hits": [
    { "file": "...", "line": 42, "kind": "subprocess.run",
      "snippet": "...", "missing": ["capture_output", "creationflags", "stdout"] }
  ]
}
```

**Coverage:**
- Python: AST scan of `scripts/cockpit/*.py` and `hooks/*.py` for `subprocess.run`/`Popen`
  calls missing all of `creationflags=`, `capture_output=`, and `stdout=`.
- PowerShell: regex scan of `~/.ultron/hooks/*.ps1` for `Start-Process` without
  `-WindowStyle Hidden` and without `-NoNewWindow`.

**Allowlist** (skipped — these have intentional console behaviour or are
test/wrapper scaffolding): `tui.py`, `silent_exec.py`, `audit_silent_exec.py`,
`test_*.py`.

The audit is a **discovery signal**, not a gate. USER decides which hits
to migrate. There is **no auto-fix** in S1.

## Known harness limitation

Claude Code harness/plugin layer emits `EEXIST mkdir 'session-env/<id>'` and
`EEXIST mkdir plugins/data/*` during tool/plugin invocations. This is harness
behavior, NOT an ULTRON bug — `session-init.ps1` uses `New-Item -Force`
(idempotent). Ignorable. For critical filesystem work, prefer the `PowerShell`
tool over `Bash`.

## ULTRON_DEBUG=1 — debug visibility

When diagnosing a hung child or unclear failure, set `ULTRON_DEBUG=1` in your
shell. Both `silent_run` and `silent_popen` will:
- Skip `creationflags=CREATE_NO_WINDOW`
- Skip the default output capture (stdout/stderr stream live to your console)

```powershell
# Windows PowerShell
$env:ULTRON_DEBUG = "1"
uv run python ~/.claude/skills/ultron/scripts/cockpit/some_script.py
$env:ULTRON_DEBUG = $null   # restore silent default

# POSIX
ULTRON_DEBUG=1 uv run python ~/.claude/skills/ultron/scripts/cockpit/some_script.py
```

Truthy values: `1`, `true`, `yes`, `on` (case-insensitive). Anything else =
silent default.

## See also

- `~/.ultron/docs/alerts-bus.md` — Sprint 1 Pilar B (already DONE)
- `~/.ultron/plans/ULTRON-v14-MASTER-DEFINITIVO.md` §6/S1 — authoritative spec
- `~/.claude/skills/ultron/scripts/cockpit/silent_exec.py` — wrapper source
- `~/.claude/skills/ultron/scripts/cockpit/audit_silent_exec.py` — audit source
