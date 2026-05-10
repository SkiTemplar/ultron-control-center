---
name: warn-non-silent-subprocess
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: \\\.claude\\skills\\ultron\\.*\.(py|ps1)$|\\\.ultron\\hooks\\.*\.(py|ps1)$
  - field: new_text
    operator: regex_match
    pattern: subprocess\.Popen\(|subprocess\.run\(|Start-Process\b
---

ULTRON Pillar I guardrail — silent execution check

You are editing an ULTRON file (under `.claude/skills/ultron/` or `.ultron/hooks/`)
and the new content contains a subprocess call. Before saving, verify:

**Python (`subprocess.run` / `subprocess.Popen`):**
- Pass `creationflags=CREATE_NO_WINDOW` on Windows (or import from `silent_exec`).
- For new code, prefer `from silent_exec import silent_run, silent_popen` —
  the wrapper handles the flag plus output capture for you.

**PowerShell (`Start-Process`):**
- Pass either `-WindowStyle Hidden` or `-NoNewWindow`. Never both omitted.
- For PowerShell hooks, also use `-NoProfile -NonInteractive` when launching `pwsh`/`powershell`.

**Why this matters:** any non-silent subprocess can flash a console window
during a Claude Code session — Pillar I = zero terminal flash.

**Reference:**
- Wrapper: `~/.claude/skills/ultron/scripts/cockpit/silent_exec.py`
- Policy:  `~/.ultron/docs/silent-execution-policy.md`
- Audit:   `uv run python ~/.claude/skills/ultron/scripts/cockpit/audit_silent_exec.py --print`

This is a WARN, not a block — proceed if you have already verified the call
is safe (e.g. caller-supplied `creationflags`, multi-line call where the flag
appears on a different line, or test fixture).

<!-- HOOKIFY DISCOVERY (v4.4 fix):
This file is the SOURCE-OF-TRUTH version for ULTRON. The hookify plugin
discovers rules from `.claude/hookify.<name>.local.md` (not from
`~/.ultron/hookify-rules/`), so the active copy lives at:
  ~/.claude/hookify.silent-exec-guardrail.local.md
Edit THIS file (under ULTRON), then `Copy-Item` to ~/.claude/ to publish.
Both should stay byte-identical. Tracked in ULTRON master plan §6/S1. -->
