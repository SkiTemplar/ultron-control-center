# ULTRON manual install (fallback)

If `install.ps1` aborts at any step, follow this guide to finish by hand.
The full polished walkthrough lives in [`docs/INSTALL.md`](docs/INSTALL.md);
this file is the dry, copy-pasteable checklist you reach for when the
bootstrap installer breaks.

## Quick path (the happy one)

`install.ps1` is **zero-friction**: it auto-installs every missing
dependency via `winget` (Git, Node 22 LTS, Claude Code, Rust, uv),
asking once per dependency. It also downloads the **native Qdrant
Windows binary** straight from the official GitHub release — no
Docker, no daemon, no container. Decline and you fall back to the
manual steps below.

```powershell
# from a fresh PowerShell window (NO admin needed for winget user-scope):
git clone https://github.com/SkiTemplar/ultron.git $env:USERPROFILE\.ultron
cd $env:USERPROFILE\.ultron
.\install.ps1                   # visual wizard (WinForms checkboxes) - default
.\install.ps1 -Cli              # legacy CLI prompts (Read-Host per step)
.\install.ps1 -NonInteractive   # CI / unattended, auto-Y to every install
.\install.ps1 -Verbose          # debug what each step is doing
.\install.ps1 -NoApp            # no Tauri build (faster, headless)
.\install.ps1 -NoDocker         # skip Qdrant — semantic recall stays off
```

`install.ps1` is **idempotent**: run it again any time, it skips steps
that are already done. Dependencies already on PATH are auto-detected
and never reinstalled.

### Visual wizard (default)

On first run, `install.ps1` opens a WinForms window with one checkbox per
optional component, grouped into Core (greyed, always installed), Memory,
Claude Code integration, Optional UI (Tauri build is **off by default** —
it's a 3-5 min Rust compile), and Optional features. Your choices are
saved to `~/.ultron/cockpit/install-profile.json`, so re-runs pre-check
the same boxes.

- `-Cli`            — skip the wizard, use the old Read-Host prompts.
- `-NonInteractive` — skip the wizard AND every prompt; use defaults.
- `-Force`          — skip the wizard; run every idempotent step anyway.

The wizard is `scripts/cockpit/install-wizard.ps1` — same script you can
run standalone with `-DryRun` to preview the dialog without writing
anything.

### Auto-install matrix

| Dependency        | Installed via                                  | Skipped when            |
| ----------------- | ---------------------------------------------- | ----------------------- |
| Git               | `winget install Git.Git`                       | already on PATH         |
| Node 22 LTS       | `winget install OpenJS.NodeJS.LTS`             | `node -v` >= v22        |
| Claude Code CLI   | `npm install -g @anthropic-ai/claude-code`     | `claude --version` works|
| uv (Python)       | `irm https://astral.sh/uv/install.ps1 \| iex`  | `uv --version` works    |
| Rust + cargo      | `winget install Rustlang.Rustup` + `rustup default stable` | `-NoApp` flag or `rustc` on PATH |
| Qdrant (native)   | downloads `qdrant-x86_64-pc-windows-msvc.zip` v1.18.0 from GitHub releases, extracts to `~/.ultron/qdrant-native/` | `-NoDocker` flag (historical name) or `qdrant.exe` already at path |

**Caveats:**

- Auto-install needs `winget` (Windows App Installer). If you're on
  Windows older than 10 1809 or stripped App Installer, the script
  detects this and prints manual download links.
- `winget` installs at user scope, so **no UAC elevation** is required
  unless you've globally locked down installs.
- After winget finishes, the installer refreshes the session `PATH`
  from registry so the rest of the run can find the new binaries.
- **No Docker.** ULTRON stopped depending on Docker in v15.0.2. The
  Qdrant binary runs as a child process of `ensure-qdrant.ps1`, which
  the SessionStart hook + a Windows scheduled task keep alive. No
  daemon, no Docker Desktop window in the tray.
- **Rust** install may print a notice that a reboot is required to
  finish wiring up the MSVC linker. The installer surfaces this — it
  doesn't force a reboot.

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

### 0a. git (auto-installed)

```powershell
git --version
# if missing:
winget install Git.Git --silent --accept-source-agreements --accept-package-agreements
```

### 0b. Node 22 LTS (auto-installed, prereq for Claude Code + Tauri)

```powershell
node --version    # need >= v22
# if missing or older:
winget install OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
# open a new shell so PATH reloads, or:
$env:Path = [Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [Environment]::GetEnvironmentVariable("Path","User")
```

### 2. Claude Code CLI (hard requirement, auto-installed)

```powershell
claude --version
```

If missing (the installer runs this automatically once Node is in place):

```powershell
npm install -g @anthropic-ai/claude-code
# or follow https://docs.claude.com/en/docs/claude-code
claude login   # one-time browser sign-in to your Claude.ai subscription
```

### 3. uv (Python, auto-installed)

```powershell
uv --version
# if missing:
irm https://astral.sh/uv/install.ps1 | iex
# open a new shell so PATH reloads
```

### 3b. Rust toolchain (auto-installed unless -NoApp)

```powershell
rustc --version
# if missing:
winget install Rustlang.Rustup --silent --accept-source-agreements --accept-package-agreements
rustup default stable
```

Rust is needed for `tauri build` (step 10). On a fresh install Windows
may print a notice that the MSVC linker needs a **reboot** to fully
register — the installer surfaces this but does not force the reboot.

### 4. Qdrant (native Windows binary, no Docker)

```powershell
# Download the official release zip
$zip = "$env:TEMP\qdrant-windows.zip"
Invoke-WebRequest `
  "https://github.com/qdrant/qdrant/releases/download/v1.18.0/qdrant-x86_64-pc-windows-msvc.zip" `
  -OutFile $zip

# Extract into ~/.ultron/qdrant-native/
$target = Join-Path $env:USERPROFILE ".ultron\qdrant-native"
Expand-Archive -LiteralPath $zip -DestinationPath $target -Force
Remove-Item $zip
```

Minimal config file (`~/.ultron/qdrant-native/config/production.yaml`):

```yaml
storage:
  storage_path: ./storage
  snapshots_path: ./snapshots

service:
  host: 127.0.0.1
  http_port: 6333
  grpc_port: 6334

log_level: INFO
```

Boot is handled by `~/.ultron/scripts/hooks/ensure-qdrant.ps1` — it
launches `qdrant.exe` hidden on SessionStart and on user logon via the
`ULTRON-QdrantBoot` scheduled task. Verify it's serving:

```powershell
Invoke-WebRequest http://localhost:6333/healthz
# should return 200 OK
```

Skip this step with `install.ps1 -NoDocker` (the flag name is
historical; ULTRON has not used Docker since v15.0.2). Semantic recall
over the vault is then disabled; everything else works.

### 5. Directory layout

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

### 8b. Agents

`install.ps1` mirrors the skills flow for autonomous subagents under
`~/.claude/agents/`. It always copies the 9 ULTRON first-party agents
(`ultron-arch`, `ultron-changelog`, `ultron-context`, `ultron-docs`,
`ultron-metadata`, `ultron-perf`, `ultron-refactor`, `ultron-security`,
`ultron-test`). It then offers to install the 15 community agents
already downloaded under `~/.ultron/agents/community/` (`architect-reviewer`,
`code-reviewer`, `context-manager`, `debugger`, `legacy-modernizer`,
`mcp-developer`, `multi-agent-coordinator`, `powershell-7-expert`,
`python-pro`, `react-specialist`, `refactoring-specialist`,
`rust-engineer`, `security-auditor`, `test-automator`,
`typescript-pro`). Decline and you can install them one by one later
from the Agents tab in the Control Center.

To install an agent by hand:

```powershell
Copy-Item $env:USERPROFILE\.ultron\agents\community\<name>.md `
          $env:USERPROFILE\.claude\agents\<name>.md
```

Then, optionally, index the agent descriptions into Qdrant so the
AI Router and the Agents tab can do semantic search across them:

```powershell
uv run python $env:USERPROFILE\.ultron\scripts\cockpit\embed_agents.py index
```

This step is optional. If you skip it, agents still load — only the
semantic search across agent descriptions stays off.

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
| `winget : not recognized`                            | Install "App Installer" from Microsoft Store, then re-run    |
| `winget` install hangs or exits non-zero             | Check your network / proxy; retry; or install that dep by hand |
| Auto-installed binary not on PATH after winget       | Open a fresh PowerShell shell so the user PATH reloads       |
| `uv: not recognized` after auto-install              | Open a new shell so PATH reloads, or add `~/.local/bin`      |
| `qdrant.exe` won't start                             | Check `~/.ultron/.tmp/qdrant-native.err`. Kill stale processes: `Get-Process qdrant \| Stop-Process -Force`, then re-run `~/.ultron/scripts/hooks/ensure-qdrant.ps1`. |
| `rustc` not on PATH right after Rust auto-install    | Open a fresh shell; if still missing, reboot once            |
| `npm install` errors on `better-sqlite3` / `keytar`  | Install Node 22+, then `Remove-Item node_modules -Recurse; npm i` |
| `tauri build` complains about Webview2               | Install Edge Webview2 runtime: <https://aka.ms/Edge/Webview2> |
| `settings.json` got mangled                          | Restore from `settings.json.bak-<timestamp>` written by step 6 |
| Claude doesn't auto-launch hooks                     | Hooks didn't merge. Re-run step 6 manually.                  |
| `/healthz` not responding on `6333`                  | `ensure-qdrant.ps1` couldn't launch the binary. Verify `~/.ultron/qdrant-native/qdrant.exe` exists; if not, rerun `install.ps1 -Force`. |

## Uninstall

The bootstrap installer does **not** remove anything. To roll back:

```powershell
# stop the native Qdrant process (if running)
Get-Process qdrant -ErrorAction SilentlyContinue | Stop-Process -Force

# unregister the scheduled task that re-boots it on logon
& $env:USERPROFILE\.ultron\scripts\hooks\install-qdrant-bootcheck.ps1 uninstall

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
