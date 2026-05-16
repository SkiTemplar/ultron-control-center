# ULTRON manual install (fallback)

If `install.ps1` aborts at any step, follow this guide to finish by hand.
The full polished walkthrough lives in [`docs/INSTALL.md`](docs/INSTALL.md);
this file is the dry, copy-pasteable checklist you reach for when the
bootstrap installer breaks.

## Quick path (the happy one)

```powershell
# from a fresh PowerShell window (NO admin):
git clone https://github.com/SkiTemplar/ultron.git $env:USERPROFILE\.ultron
cd $env:USERPROFILE\.ultron
.\install.ps1               # interactive
.\install.ps1 -NonInteractive   # CI / unattended
.\install.ps1 -Verbose      # debug what each step is doing
.\install.ps1 -NoApp -NoDocker  # bare-bones, no Tauri build, no Qdrant
```

`install.ps1` is **idempotent**: run it again any time, it skips steps
that are already done.

## What each step does, manually

### 1. Preflight

| Check     | Manual command                                              |
| --------- | ----------------------------------------------------------- |
| OS        | `(Get-CimInstance Win32_OperatingSystem).Caption`           |
| PS ver    | `$PSVersionTable.PSVersion`                                 |
| RAM       | `(Get-CimInstance Win32_OperatingSystem).TotalVisibleMemorySize / 1MB` |
| Disk free | `(Get-PSDrive C).Free / 1GB`                                |
| Internet  | `Test-NetConnection github.com -InformationLevel Quiet`     |

If RAM < 8 GB or disk < 5 GB free, ULTRON will run but you may hit
swap and stalls during embedding rebuilds.

### 2. Claude Code CLI (hard requirement)

```powershell
claude --version
```

If missing:

```powershell
npm install -g @anthropic/claude-code
# or follow https://docs.claude.com/en/docs/claude-code
claude login   # one-time browser sign-in to your Claude.ai subscription
```

### 3. uv (Python)

```powershell
uv --version
# if missing:
irm https://astral.sh/uv/install.ps1 | iex
# open a new shell so PATH reloads
```

### 4. Docker Desktop (optional, for Qdrant)

```powershell
docker --version
docker info     # daemon must answer
```

If you don't have Docker: download from
<https://www.docker.com/products/docker-desktop/>. ULTRON runs without
it, only semantic recall over the vault is disabled.

### 5. Qdrant container

```powershell
docker pull qdrant/qdrant:latest
docker run -d --name qdrant -p 6333:6333 `
  -v "${env:USERPROFILE}\.ultron\qdrant-data:/qdrant/storage" `
  qdrant/qdrant
# verify
curl http://localhost:6333/healthz
```

To rerun on a stopped container: `docker start qdrant`.

### 6. Directory layout

```powershell
$dirs = @(
  "$env:USERPROFILE\.ultron",
  "$env:USERPROFILE\.ultron\cockpit",
  "$env:USERPROFILE\.ultron\plans",
  "$env:USERPROFILE\.ultron\skills",
  "$env:USERPROFILE\.ultron\scripts",
  "$env:USERPROFILE\.ultron\brain_index",
  "$env:USERPROFILE\.ultron\.tmp",
  "$env:USERPROFILE\.ultron\personal",
  "$env:USERPROFILE\.ultron-vault",
  "$env:USERPROFILE\.claude\skills"
)
$dirs | ForEach-Object { New-Item -ItemType Directory -Path $_ -Force | Out-Null }
```

### 7. Claude Code hooks

ULTRON ships hook definitions in `templates/settings-hooks.json`. Merge
them into `~/.claude/settings.json` by hand if the installer's merge
step fails:

1. Open `templates\settings-hooks.json` and replace every `{USERPROFILE}`
   with your home path using forward slashes
   (`C:/Users/yourname`).
2. Open `$env:USERPROFILE\.claude\settings.json`. Back it up first:
   `Copy-Item $env:USERPROFILE\.claude\settings.json $env:USERPROFILE\.claude\settings.json.bak`
3. Replace (or add) the `"hooks"` key with the content from the template.
   Leave every other key alone (`permissions`, `mcpServers`, `model`,
   `theme`, plugins, etc.).
4. Restart Claude Code.

Hook list ULTRON registers:

| Phase            | Matcher                       | Script                                |
| ---------------- | ----------------------------- | ------------------------------------- |
| SessionStart     | (all)                         | `scripts/hooks/session-init.ps1`      |
| PreToolUse       | `Read\|Glob\|Grep\|WebFetch\|WebSearch` | `scripts/hooks/auto-approve-readonly.py` |
| PreToolUse       | `Bash`                        | `scripts/hooks/block-dangerous-bash.py` |
| PreToolUse       | `mcp__.*`                     | `scripts/hooks/mcp-resilience.py`     |
| PreToolUse       | `Skill`                       | `scripts/hooks/skill_integrity_check.py` |
| PostToolUse      | `Skill\|Agent`                | `scripts/hooks/routing-telemetry.py`  |
| PostToolUse      | `Skill`                       | `scripts/hooks/prompt-feedback-capture.py` |
| PostToolUse      | `Read`                        | `scripts/hooks/track-knowledge-reads.py` |
| Stop             | (all)                         | `session-log.py` + `stop-memory-sync.ps1` + `session-cleanup.ps1` |
| UserPromptSubmit | (all)                         | `mode-trigger.py` + `intent-dispatcher.py` + `auto-recall.py` |

### 8. Skills

`templates\skills-manifest.example.yaml` lists which skills are
**core** (default ON) and which are **personal** (opt-in, default OFF).
To install a skill manually:

```powershell
# Personal skill that lives in the repo:
Copy-Item -Recurse $env:USERPROFILE\.ultron\skills\<name> `
                   $env:USERPROFILE\.claude\skills\<name>
```

Skip skills you don't want — Claude Code only loads what's in
`~/.claude/skills/`.

### 9. brain_index

```powershell
uv run python $env:USERPROFILE\.ultron\scripts\cockpit\brain_index.py build
```

If your vault is empty (fresh install) skip this — the desktop app
runs the first build on its own once you start adding notes.

### 10. Control Center (Tauri app)

```powershell
cd $env:USERPROFILE\.ultron\control-center
npm install
npm run tauri dev      # development
npm run tauri build    # production binary (10-30 min on first build)
```

Prerequisites: **Node 22+** and **Rust stable** (`rustup default stable`).

### 11. Health check

```powershell
uv run python $env:USERPROFILE\.ultron\scripts\cockpit\doctor.py
```

Exit codes: `0` clean, `1` warnings only, `2` blocking findings.

### 12. Scheduled tasks — "Catch up if missed" (Phase 8)

ULTRON registers Windows scheduled tasks with the `ULTRON-` prefix
(brain-rebuild, alerts, integrity, etc.). The Control Center's **System**
tab exposes an "Edit schedule" modal with a **Catch up if missed**
toggle. When enabled, the task is updated via:

```powershell
Set-ScheduledTask -TaskName ULTRON-* `
    -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable)
```

`StartWhenAvailable` is the Windows Task Scheduler knob that tells the
service: *if the trigger fires while the PC is off, asleep, or
hibernated, run the task as soon as the PC comes back online* (within
the standard 72-hour window Task Scheduler keeps a missed trigger
queued). Without it, missed triggers are silently dropped — which is
the default and why a laptop that was closed at 9 am never sees the
9 am brain rebuild.

The toggle is per-task. To inspect the current state from a shell:

```powershell
(Get-ScheduledTask -TaskName 'ULTRON-brain-rebuild').Settings.StartWhenAvailable
```

The UI also shows a "Next run" line computed in-browser, plus a
collapsed **Advanced** section with the equivalent cron expression
(read-only — the backend currently consumes Daily / Weekly Monday /
AtLogon only, not free-form cron).

## Common failures and fixes

| Symptom                                              | Fix                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `iex (irm .../install.ps1)` says "execution policy"  | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`        |
| `uv: not recognized` after auto-install              | Open a new shell so PATH reloads, or add `~/.local/bin`      |
| `docker info` hangs                                  | Docker Desktop is not running. Launch it and re-run step 5.  |
| `npm install` errors on `better-sqlite3` / `keytar`  | Install Node 22+, then `Remove-Item node_modules -Recurse; npm i` |
| `tauri build` complains about Webview2               | Install Edge Webview2 runtime: <https://aka.ms/Edge/Webview2> |
| `settings.json` got mangled                          | Restore from `settings.json.bak-<timestamp>` written by step 7 |
| Claude doesn't auto-launch hooks                     | Hooks didn't merge. Re-run step 7 manually.                  |
| `qdrant` container exists but stopped                | `docker start qdrant` (the installer is non-destructive)     |

## Uninstall

The bootstrap installer does **not** remove anything. To roll back:

```powershell
# stop + drop qdrant
docker stop qdrant; docker rm qdrant

# restore Claude settings backup
Copy-Item $env:USERPROFILE\.claude\settings.json.bak-* `
          $env:USERPROFILE\.claude\settings.json -Force

# remove ULTRON data and repo (DANGEROUS - takes your vault with it)
Remove-Item -Recurse -Force $env:USERPROFILE\.ultron
Remove-Item -Recurse -Force $env:USERPROFILE\.ultron-vault
```

Or use the canonical uninstaller that backs everything up first:

```powershell
.\scripts\uninstall.ps1            # interactive
.\scripts\uninstall.ps1 -Yes       # unattended
```

## Where to get help

- Architecture and feature docs: `README.md`
- Polished install walkthrough:   `docs/INSTALL.md`
- Hook & telemetry reference:     `scripts/hooks/README.md`
- Issue tracker:                  <https://github.com/SkiTemplar/ultron/issues>
