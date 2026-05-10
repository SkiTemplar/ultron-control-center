# Sprint 1 — Silent Execution + Alerts Bus · Detailed Plan

> ⚠️ **SUPERSEDED 2026-05-05 — DO NOT EXECUTE THIS FILE**
>
> Esta spec quedó stale. La validación 2026-05-05 (sesión 343a817b + Codex peer review) descubrió que:
> - Pilar B está 100% DONE (alerts.py + CLI + hook + docs + test_alerts.py 13/13 PASS) — implementarlo de cero sería destructivo
> - Los 3 seed alerts son STALE/mis-atribuidos al harness Claude Code, no a hooks ULTRON — "fix" en hooks pierde tiempo
> - Pilar A scope reducido: solo `silent_exec.py` wrapper + audit ligero + docs, sin migración bulk
>
> **Spec autoritativa actual:** `ULTRON-v14-MASTER-DEFINITIVO.md` v4.4 § Sprint 1.
> Cualquier subagent: ignorar este archivo, leer master v4.4 directamente.
>
> ---

**Date:** 2026-05-04 (SUPERSEDED 2026-05-05)
**Version target:** v13.3.0 → v13.4.0 "SILENT + ALERTS"
**Mode:** Subagent-Driven (one implementer agent for both pillars, sequencing B → A; then Codex MaxDual peer review).

---

## Surface Inventory (discovered 2026-05-04)

- `~/.ultron/hooks/` → 2 PS1 (session-init.ps1, stop-memory-sync.ps1)
- `~/.claude/skills/ultron/hooks/` → 6 Python hooks (block-dangerous-bash, auto-approve-readonly, mode-trigger, routing-telemetry, session-log, track-knowledge-reads)
- `~/.claude/skills/ultron/scripts/` → 3 PS1 (init-memory, new-project, register_wake_triggers, ultron-paths, shared-duet) + 4 Python (memory-audit, skill-discovery, persona-benchmark-runner, routing-test-runner, consistency-check, consistency_check)
- `~/.claude/skills/ultron/scripts/cockpit/` → ~75 Python files + ultron.ps1, install-scheduler.ps1, desktop-shortcut.ps1, register_wake_triggers.ps1
- **Total surface:** ~95 scripts to audit

**Known bugs flagged in compact (2026-05-04):**
- `~/.ultron/hooks/session-init.ps1:192` parser error (Carácter: 14) — at session resume hook
- EEXIST mkdir on `C:\Users\USER\.claude\session-env\<SessionId>` (idempotency missing)
- EEXIST mkdir on `C:\Users\USER\.claude\plugins\data\agent-skills-addy-agent-skills`
- EEXIST mkdir on `C:\Users\USER\.claude\plugins\data\superpowers-superpowers-marketplace`

These are the canonical first alerts to write to alerts.jsonl as test data.

---

## Sequencing

```
1. Pilar B (alerts bus) FIRST
   └→ creates writers + readers + CLI before anything tries to use them
2. Pilar A (silent execution audit + fixes)
   └→ fixes session-init can use alerts to report what got fixed
3. Verification
   └→ end-to-end test: start fresh session → no popups → alerts pre-loaded
4. Codex MaxDual peer review (3 rounds)
5. Version bump v13.3.0 → v13.4.0
6. Sprint close report
```

---

## Pilar B — Alerts Bus

### B1. Schema + storage (15 min)

Create `~/.ultron/alerts.jsonl` empty file. Schema doc at `~/.ultron/docs/alerts-bus.md`:

```jsonl
{"id":"a-2026-05-04-001","ts":"2026-05-04T18:23:11Z","severity":"blocking","source":"session-init.ps1","message":"...","tags":["hook"],"ack":false,"ack_ts":null}
```

ID format: `a-YYYY-MM-DD-NNN` (3-digit counter resets per day, computed from existing entries).

Severity ladder: `info` < `warn` < `blocking`. Default surface threshold: `warn`.

### B2. Python helper (`alerts.py`) (25 min)

`~/.claude/skills/ultron/scripts/cockpit/alerts.py`:

```python
"""Append-only alerts bus. Silent. Idempotent."""
def write(severity: str, source: str, message: str, tags: list[str] | None = None) -> str:
    """Append one alert to ~/.ultron/alerts.jsonl. Returns the id. Atomic via O_APPEND."""

def read_unacked(severity_min: str = "info", limit: int | None = None) -> list[dict]:
    """Read tail entries with ack=false and severity >= severity_min."""

def ack(alert_id: str) -> bool:
    """Append a NEW line {id, ack:true, ack_ts:...} as ack-marker (don't rewrite existing)."""

def archive_older_than(days: int = 30) -> int:
    """Move old entries to ~/.ultron/alerts/archive/YYYY-MM.jsonl. Returns count moved."""
```

**Concurrency:** use `os.O_APPEND` + atomic single-line writes. POSIX guarantees atomicity for writes ≤ PIPE_BUF (4096 bytes); Windows Python uses native append with similar semantics. Test: 3 threads × 100 writes → 300 lines, no corruption.

**Acks-as-events** (NOT mutate): an `ack(id)` writes a NEW line `{"id":"<same>","ack":true,"ack_ts":"..."}`. `read_unacked` folds: an alert is unacked if its latest line has `ack:false`. This avoids file-rewrite (no race, no truncation risk).

### B3. PowerShell helper (`write-alert.ps1`) (10 min)

`~/.ultron/scripts/alerts/write-alert.ps1`:

```powershell
param(
    [Parameter(Mandatory)][ValidateSet('info','warn','blocking')][string]$Severity,
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Message,
    [string[]]$Tags = @()
)
$ErrorActionPreference = 'Stop'
$alertsFile = Join-Path $env:USERPROFILE '.ultron\alerts.jsonl'
# ... atomic append using [System.IO.File]::AppendAllText with FileMode.Append
```

Silent execution (no console output unless `-Verbose`). Returns the alert id on stdout.

### B4. SessionStart hook integration (15 min)

Extend `~/.ultron/hooks/session-init.ps1` to call alerts read + inject into context.md AFTER existing primer logic:

```powershell
# Read top 5 unacked warn+blocking alerts, format into context.md
$alertsOutput = uv run python "$ultronScriptsCockpit/alerts.py" --read-unacked --severity-min warn --limit 5 --format markdown 2>$null
if ($LASTEXITCODE -eq 0 -and $alertsOutput) {
    Add-Content -Path $contextMd -Value "`n## ⚠ Pending Alerts`n$alertsOutput"
}
```

`alerts.py` gets a `--cli` mode for this.

### B5. CLI commands in `ultron.ps1` (15 min)

Add to `~/.claude/skills/ultron/scripts/cockpit/ultron.ps1`:

```
ultron alerts list [--severity blocking|warn|info] [--unacked] [--limit N]
ultron alerts ack <id>
ultron alerts purge --older-than 30d
ultron alerts write -s warn -m "..." [-t tag1,tag2]   # convenience for manual testing
```

All silent (`-WindowStyle Hidden` on any subprocess), JSON output supported via `--json`.

### B6. Tests (`test_alerts.py`) (20 min)

`~/.claude/skills/ultron/tests/test_alerts.py`:
- `test_write_returns_id` → format `a-YYYY-MM-DD-NNN`
- `test_concurrent_writes_no_corruption` → 3 threads × 100 → 300 valid JSON lines
- `test_ack_makes_unacked_false` → write → ack → read_unacked returns empty
- `test_severity_filter` → write info+warn+blocking → read_unacked(severity_min=warn) returns 2
- `test_archive_moves_old` → write with mocked old ts → archive → main file shrinks

Run via `uv run pytest tests/test_alerts.py -v`.

### B7. Documentation (`alerts-bus.md`) (10 min)

`~/.ultron/docs/alerts-bus.md`:
- Schema spec
- Severity ladder + surface defaults
- Helper API (Python + PS)
- CLI commands
- Concurrency model
- Retention policy
- Integration points: SessionStart, Doctor (S5), any script

### B8. Migration: existing hook errors as alerts (5 min)

After helpers exist, write 3 startup alerts to seed the bus:

```
write -s warn -s session-init.ps1 -m "Parser error at line 192 (Carácter 14) on session resume — see Sprint 1 fix"
write -s warn -s session-start-hook -m "EEXIST mkdir session-env/<id> — idempotency missing"
write -s warn -s session-start-hook -m "EEXIST mkdir plugins/data/* — idempotency missing"
```

These get acked at end of Pilar A when fixed.

**Pilar B total: ~115 min**

---

## Pilar A — Silent Execution Audit

### A1. Fix known hook bugs FIRST (20 min)

**A1.1 — `session-init.ps1` line 192 parser error.** Read full file; identify root cause (likely encoding issue with `Carácter: 14` referring to BOM or accented char in line, or earlier syntax issue surfacing at line 192 statement). Fix. Validate by running hook standalone:
```
powershell -NoProfile -File "C:\Users\USER\.ultron\hooks\session-init.ps1" -SessionId test-fix-2026-05-04
echo $LASTEXITCODE   # should be 0
```

**A1.2 — EEXIST mkdir idempotency.** Find every `mkdir` / `New-Item -ItemType Directory` / Python `os.mkdir` / `pathlib.Path.mkdir` that fails on existing. Fix pattern:
- PowerShell: `New-Item -ItemType Directory -Force -Path $p | Out-Null` (the `-Force` makes idempotent)
- Python: `Path(p).mkdir(parents=True, exist_ok=True)`

Specific paths to fix:
- `C:\Users\USER\.claude\session-env\<id>` — find which script creates this
- `C:\Users\USER\.claude\plugins\data\<plugin-name>` — find which script creates this

Likely culprits: hooks in `~/.claude/skills/ultron/hooks/` (Python) or `session-init.ps1`. Grep for `session-env` and `plugins\\data` to locate.

After fix: `write-alert -s info -m "EEXIST mkdir bug fixed in <file>:<line>"` and ACK the original warn alert.

### A2. Audit all PowerShell scripts (30 min)

Grep all `*.ps1` for these patterns and fix:
- `Start-Process` without `-WindowStyle Hidden` or `-NoNewWindow` → ADD `-WindowStyle Hidden`
- `cmd.exe /c` → replace with native PS or document why kept
- `start ` invocations → audit
- `& "$exe"` calls without redirection → audit (most are fine; flag only if known to popup)

Files in scope:
- `~/.ultron/hooks/session-init.ps1`, `stop-memory-sync.ps1`
- `~/.claude/skills/ultron/scripts/*.ps1` (3 files: init-memory, new-project, register_wake_triggers, ultron-paths, shared-duet)
- `~/.claude/skills/ultron/scripts/cockpit/*.ps1` (4 files: ultron, install-scheduler, desktop-shortcut, register_wake_triggers)

For each fix, write an `info` alert: `"silent-fix: <file>:<line> — <pattern>"`.

### A3. Audit all Python scripts (30 min)

Grep all `*.py` for:
- `subprocess.run(` / `subprocess.Popen(` without `creationflags=subprocess.CREATE_NO_WINDOW` (Windows) → ADD
- `os.system(` → flag (likely opens cmd window) → replace with subprocess silent
- `subprocess.call(` legacy → audit

Critical files (high traffic):
- `~/.claude/skills/ultron/hooks/*.py` (6 hooks — these run ON EVERY SESSION)
- `~/.claude/skills/ultron/scripts/cockpit/auto_updater.py`, `memory_sync.py`, `session_compactor.py`, `brain_index.py` (frequently invoked)
- `~/.claude/skills/ultron/scripts/cockpit/tui.py` (interactive — NEEDS console; mark as exception in policy)

Lower-priority cockpit scripts (75 files) → bulk pattern fix via grep + sed-equivalent (Python regex), one commit.

### A4. Add `ULTRON_DEBUG` env var (10 min)

Helper module `~/.claude/skills/ultron/scripts/cockpit/silent_exec.py`:

```python
"""Silent subprocess wrapper. Honors ULTRON_DEBUG=1 env var."""
import os, subprocess, sys

def run(cmd, **kwargs):
    """Run subprocess silently by default. If ULTRON_DEBUG=1, show window."""
    debug = os.environ.get('ULTRON_DEBUG') == '1'
    if not debug and sys.platform == 'win32':
        kwargs.setdefault('creationflags', subprocess.CREATE_NO_WINDOW)
    if not debug:
        kwargs.setdefault('capture_output', True)
    return subprocess.run(cmd, **kwargs)
```

Document in policy. New scripts MUST use this; old ones migrated opportunistically (don't rewrite all 75 cockpit scripts now — that's S5 doctor-detected work).

### A5. Documentation (`silent-execution-policy.md`) (15 min)

`~/.ultron/docs/silent-execution-policy.md`:
- Hard rule statement (no popups, ever)
- Patterns for PowerShell, Python, Bash
- `ULTRON_DEBUG=1` escape hatch
- `silent_exec.run()` helper API
- **Exception list**: scripts that LEGITIMATELY need a console (tui.py interactive cockpit, manual-debug scripts) — explicitly enumerated, not silenced
- How to test: end-to-end smoke `claude "Ultron, status"` → 0 windows
- Integration with alerts bus: any silent failure must write an alert

### A6. Smoke test (10 min)

End-to-end manual test:
1. Start fresh Claude Code session → observe NO console window flash
2. Run `claude "Ultron, status"` → no popup
3. Run `ultron sync` from PowerShell → no popup (output to terminal is fine; popup window is forbidden)
4. Run any cockpit script via `uv run python ...` → no popup
5. Verify all 3 startup alerts ACKed (Pilar B alerts.jsonl shows them resolved)

If ANY popup appears: STOP, investigate, fix, re-test.

**Pilar A total: ~115 min**

---

## Verification & Close (45 min)

### V1. Acceptance grep

Run final grep for residual issues:
```
grep -r "Start-Process" --include="*.ps1" -L "WindowStyle Hidden\|NoNewWindow\|Start-Job"  # should return empty
grep -r "subprocess.run\|subprocess.Popen" --include="*.py" -L "CREATE_NO_WINDOW\|capture_output"  # should be minimal, only legitimate exceptions
grep -rn "os.mkdir\|Path.*mkdir(" --include="*.py" | grep -v "exist_ok=True"  # should return empty (all idempotent)
grep -rn "New-Item.*-ItemType Directory" --include="*.ps1" | grep -v "\-Force"  # should return empty
```

### V2. Codex MaxDual peer review

Run `~/.claude/skills/ultron/scripts/shared-duet.ps1` with:
- `-Peers codex`
- `-Mode review`
- `-Rounds 3`
- Input: diff of S1 changes + this plan + alerts-bus.md + silent-execution-policy.md
- Validate: (a) no popups in any script, (b) alerts.jsonl resists concurrent writes, (c) hook errors actually fixed (re-run session-init to verify), (d) silent_exec.py wrapper is sound, (e) ack-as-events model handles edge cases

### V3. Version bump

- `~/.claude/skills/ultron/SKILL.md` → v13.3.0 (CLEAN HOUSE) → v13.4.0 (SILENT + ALERTS)
- `~/.claude/skills/ultron/mode-{ultra,high,medium,low,learn}.md` headers → v13.4.0 (SILENT + ALERTS)
- `~/.claude/skills/ultron/CLAUDE.md` banner → v13.4.0
- `~/.claude/skills/ultron/scripts/cockpit/tui.py` (5 strings) → v13.4.0
- `~/.claude/skills/ultron/scripts/cockpit/ultron.ps1` line 1 → v13.4.0
- `~/.claude/CLAUDE.md` line 1 → v13.4
- `~/.ultron/INDEX.md` + `~/.ultron/MEMORY.md` headers → v13.4
- Update `~/.ultron/docs/version-touchpoints.md` with any NEW touchpoints discovered (alerts.py, write-alert.ps1, silent_exec.py)

### V4. Changelog + sprint-1-final report

Append v13.4.0 entry to `~/.claude/skills/ultron/references/changelog.md`. Use Edit tool ONLY (no Add-Content with -Encoding utf8 — preserves no-BOM encoding).

Write `~/.ultron/telemetry/v14-overhaul/sprint-1-final.md` with:
- Status: DONE
- Pilar A summary: N silent-fixes applied, hook bugs resolved
- Pilar B summary: alerts bus operational, concurrent-write tests passing
- Drift caught
- Open issues for S2-S5
- POST baseline (just confirm telemetry baseline file path; do NOT regenerate)

### V5. Master plan checkboxes

Tick all `- [ ]` in master plan § Sprint 1 → `- [x]`.

---

## DONE Criteria (from master, restated as exit checklist)

**Pilar A:**
- [ ] Inventario en `silent-execution-policy.md` con tabla scripts × ¿abre ventana?
- [ ] Auditoría subprocess.run/Popen completa
- [ ] Auditoría Start-Process completa
- [ ] session-init.ps1:192 fixed
- [ ] EEXIST idempotency fixed
- [ ] Test manual: 0 ventanas en flujo normal
- [ ] `ULTRON_DEBUG=1` env var documentado
- [ ] Documentación published

**Pilar B:**
- [ ] alerts.jsonl + esquema documentado
- [ ] write-alert.ps1 + alerts.py operativos
- [ ] SessionStart hook lee unacked y los inyecta en context.md
- [ ] CLI `ultron alerts list/ack/purge` funcional
- [ ] Retención 30d documentada (impl en B; consume en S5)
- [ ] Migración: 3 hook errors registrados como alerts iniciales
- [ ] Test concurrent writes: 0 corruptions
- [ ] Documentación published

**Cierre:**
- [ ] Codex MaxDual GREEN-LIGHT
- [ ] Version bumped v13.3.0 → v13.4.0 "SILENT + ALERTS"
- [ ] Changelog + sprint-1-final.md + master plan checkboxes ✓

---

## Anti-patterns (do NOT)

- DON'T touch ~/.ultron-vault/ (knowledge layer, frozen)
- DON'T touch backups/ or telemetry/ (frozen records)
- DON'T rewrite tui.py interactive cockpit (legitimate console exception)
- DON'T mutate alerts.jsonl entries — append-only is the contract
- DON'T add features beyond Pilar A+B scope (no fancy alert UI, no email integration, no Slack)
- DON'T skip the smoke test (V1) — it's the only thing that catches popup regressions

---

## Estimate

- Pilar B: ~115 min
- Pilar A: ~115 min
- Verification + Codex: ~45 min
- **Total: ~4-5 hours of agent work** (one focused session, single implementer subagent)
