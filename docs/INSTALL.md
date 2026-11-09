# Installing ULTRON Control Center (app v15.8.0+ · core v15.7.x)

ULTRON is a personal control center: a Tauri desktop app plus a Python toolkit
that orchestrates Claude Code and Codex through their official CLIs.
It runs on your machine without admin rights. Claude Code and Codex use your
existing subscriptions through their CLIs, so they need no API key. The app's
AI Router (zones chat/summarize/utility/light: groq as primary, Gemini in the
cloud as fallback) does use optional API keys; without them those features
have no provider.

## Recommended path — clone the repo

This is the verified path today: clone the repo and let the installer
compile the Control Center from source.

```powershell
# Windows (PowerShell 5+)
git clone https://github.com/SkiTemplar/ultron-control-center.git $env:USERPROFILE\.ultron
cd $env:USERPROFILE\.ultron
.\install.ps1
```

```bash
# Linux (bash)
git clone https://github.com/SkiTemplar/ultron-control-center.git "$HOME/.ultron"
cd "$HOME/.ultron"
./install.sh
```

The installer is **idempotent** — re-running it is safe. It accepts an
optional `-NonInteractive` flag (PowerShell) / `--non-interactive` flag
(bash) that takes all defaults, useful for CI.

> [!NOTE]
> Linux x86_64 (Debian / Ubuntu / Fedora / Arch) is supported from core v15.5.
> macOS is an explicit non-goal. The Windows-only maintenance commands
> (NSIS uninstaller, CrashDumps cleanup, Recycle Bin) are hidden from the
> UI on Linux; the rest of the system works the same.

## Bootstrap one-liner (when a Release is published)

The one-liners, the pinned-tag variant and what they download are in
[`INSTALL.md` §2](../INSTALL.md#2-bootstrap-one-liner) at the repo root,
which is the canonical install guide; this page is the longer walkthrough of
what the installer does and how to recover. In short: the release lags
`main` (latest release v15.7.0 from 2026-07-18 as of 2026-10-23, app 15.8.0 on
`main`), and the public mirror has no Releases yet, so the clone path above is
the one to use.

## What the installer does

The installer performs the following steps, printing a clear `checking ...`
line before each one and an `ok` / `warn` / `fail` line after. On a hard
failure it prints the offending command, a suggested fix, and exits with a
non-zero code.

1. **Preflight.** Confirms a supported host (Windows 10+ for `install.ps1`,
   Linux for `install.sh`), PowerShell 5+ or bash 3.2+, enough RAM/disk, and
   that `github.com` is reachable.
2. **Prerequisites.** Probes `git`, `node` (v22+), `rustc`, `uv`, and
   `claude` (a hard requirement), plus the optional `codex`
   CLI. Missing tools are auto-installed where possible (winget on Windows;
   apt/dnf/pacman on Linux). If a required tool cannot be installed
   automatically, it points you at the official documentation and exits.
3. **Qdrant.** Downloads the native Qdrant binary (no Docker) into
   `~/.ultron/qdrant-native/`. Skipped with `-NoDocker` — semantic recall
   then stays off.
4. **Directory layout.** Creates `~/.ultron/` with subdirectories
   (`cockpit/`, `plans/`, `skills/`, `scripts/`, `brain_index/`, `.tmp/`,
   `personal/`) and wires `~/.claude/skills`. Existing directories are left
   untouched.
5. **Hooks.** Merges the Claude Code lifecycle hooks into
   `~/.claude/settings.json` (a timestamped `.bak` is written first).
6. **Skills picker.** Installs the core skill set into `~/.claude/skills/`
   and prompts to opt into the personal/community ones.
7. **brain_index.** Initializes the SQLite FTS5 memory index.
8. **Feature toggles.** The visual wizard (or CLI fallback) asks per
   optional module (Gaming, Personal, Schedules, Self-improve,
   Notifications, Usage, Sessions, Projects, Plans) and writes your
   choices to `~/.ultron/cockpit/features.json`. The desktop app reads
   this file at startup to decide which optional tabs to expose. Opted-out
   modules are physically purged; flip toggles later from
   **Settings → Features**.
9. **Control Center build.** `npm install` + `tauri build` inside
   `control-center/`, on by default. Skipped with `-NoApp`. A cold build takes
   up to ~25 minutes and needs the MSVC linker, which the installer offers to
   install. If it fails, the installer ends with exit 1.
10. **Doctor.** Runs `scripts/cockpit/doctor.py` to verify the install end
    to end.

## What you need ahead of time

| Tool        | Minimum version | Required? | Link                                            |
| ----------- | --------------- | --------- | ----------------------------------------------- |
| Rust        | stable          | yes       | https://rustup.rs                               |
| Node.js     | 22+             | yes       | https://nodejs.org                              |
| uv          | latest          | yes       | https://docs.astral.sh/uv                       |
| Claude CLI  | latest          | yes       | https://docs.claude.com/en/docs/claude-code     |
| Codex CLI   | latest          | optional  | https://github.com/openai/codex                 |

You sign in to each CLI once (`claude`, `codex`) using your existing
subscription; Claude Code and Codex need no API key. The app's AI Router
(zones chat/summarize/utility/light: groq as primary, Gemini in the cloud as
fallback) does use optional API keys, set in Settings → API Keys or in
`~/.ultron/.env`; without them those features have no provider. (The Gemini
CLI was dropped on 2026-06-19 when Google ended its free-tier OAuth; Gemini is
still reachable as a cloud fallback in the AI Router via an API key.)

## Feature toggles

When the installer prompts you for optional features, the defaults are:

```
Gaming utilities   [Y/n]   default Y
Personal section   [Y/n]   default Y
Schedules          [Y/n]   default Y
Self-improve       [Y/n]   default Y
Notifications      [Y/n]   default Y  (toast/tray alerts + pending-actions panel)
Usage tracking     [y/N]   default N  (Anthropic API plans only)
Sessions archive   [Y/n]   default Y  (session replay + highlights + compactor)
Project manager    [Y/n]   default Y  (project editor + scan + notes)
Plans & goals      [y/N]   default N  (power-user lifecycle tracker)
```

Press Enter at any prompt to take the default. Your choices land in
`~/.ultron/cockpit/features.json`:

```json
{
  "gaming": true,
  "personal": true,
  "schedules": true,
  "self_improve": true,
  "notifications": true,
  "usage": false,
  "sessions": true,
  "projects": true,
  "plans": false,
  "memory": true,
  "mcps": true,
  "skills": true,
  "hooks": true
}
```

You can edit this file by hand at any time and restart the desktop app to
apply the changes — or use **Settings → Features** in the Control Center
to flip toggles live. Unchecking a checkbox in the installer wizard
**also deletes the implementing scripts** (see the `optOutManifest` table
in `INSTALL.md`); the in-app panel is a runtime-only toggle.

## Launching the app

After the installer finishes:

```bash
cd control-center
npx tauri dev
```

The first launch compiles the Rust binary, which takes a few minutes; later
launches are near-instant.

## Troubleshooting

### `node --version` reports older than v22

The control-center frontend depends on Vite 7 and React 19, both of which
require Node 22+. Install Node 22 from https://nodejs.org or via `nvm`:

```bash
nvm install 22
nvm use 22
```

Re-run the installer.

### `uv: missing`

`uv` is the Python package manager used throughout the project. Install it
following https://docs.astral.sh/uv — on Windows it ships as a single
executable that needs to be on `PATH`:

```powershell
# Windows, per-user install (no admin required)
irm https://astral.sh/uv/install.ps1 | iex
# Open a fresh shell so PATH is reloaded
```

```bash
# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### `claude: missing` or `claude --version` errors

The Claude Code CLI must be installed and on `PATH`. Follow the official
guide at https://docs.claude.com/en/docs/claude-code. After installation,
sign in once:

```bash
claude login
```

If `claude` is installed but not found by the installer, your shell hasn't
picked up the new `PATH`. Open a fresh terminal and re-run.

## Auto-update behavior

Starting with v15.2.0 the desktop app ships with a built-in auto-updater
(Tauri's official `tauri-plugin-updater`). It checks for a newer release on
startup and, if one is available, downloads and installs it silently the
next time you launch the app.

How it works in practice:

- On launch, the app fetches `latest.json` from the GitHub Releases feed.
  No personal data is sent — only an HTTP GET to a public URL.
- If the remote version is newer than the installed version, the app
  prompts you once. On confirmation, it downloads the signed installer in
  the background.
- The next launch applies the update with Windows' `passive` install mode:
  the installer flashes briefly with a progress bar but never blocks you on
  prompts.
- The update is cryptographically signed with the project's Tauri updater
  key. An update with a bad or missing signature is refused — there is no
  way to push a malicious update from a forked repo or a typo-squatted
  domain.

### Disabling auto-update

Open the app and go to **Settings -> General -> "Check for updates on
startup"** and toggle it off. The app then never reaches out for updates
and you can update manually whenever you like by downloading the installer
from the GitHub Releases page and re-running it.

### Manual update

You can always update by hand:

1. Download the newest installer from the Releases page of the repository
   you installed from (`/releases/latest`). With a clone install, `git pull`
   plus `npm run build:app` in `control-center/` does the same from source.
2. Run it. The installer detects the existing install and upgrades in
   place without touching your `~/.ultron/` data directory.

### Windows SmartScreen warning

ULTRON ships self-signed for v15.2.0 because EV (Extended Validation) code
signing certificates cost several hundred dollars per year and this project
is free and open source. The practical consequence:

- The first time you run the installer Windows SmartScreen will pop a blue
  "Windows protected your PC" dialog and refuse to launch the binary
  unattended.
- Click **More info**, then **Run anyway**. The installer is a normal NSIS
  setup.exe; you can verify its integrity by checking the SHA-256 listed
  on the release page.
- Subsequent updates installed by the auto-updater inherit the same
  trust state — you only see the SmartScreen prompt on the very first
  install. The auto-updater verifies updates against the embedded Tauri
  public key, not via SmartScreen reputation.

If you would prefer to vet the source yourself, the release build is
defined by the GitHub Actions workflow at
`.github/workflows/release.yml.disabled`. The pipeline is **currently
disabled** (no releases are published yet); enable it to build every
artifact on a GitHub-hosted runner from a tagged commit, signed there with
the project's updater key.

## Linux specifics (core v15.5+)

A few things that differ from the Windows path. All paths assume a
single-user install — `install.sh` never writes outside `$HOME`,
`~/.local/`, or (with `sudo` for the package-manager step) the system
package database.

### File layout

| Asset | Linux location |
|---|---|
| Desktop binary (AppImage) | `~/.local/bin/ultron-control-center` (renamed from the downloaded `.AppImage`, marked `+x`) |
| Desktop binary (.deb install) | `/usr/bin/ultron-control-center` (laid down by `dpkg`) |
| `.desktop` launcher | `~/.local/share/applications/ultron-control-center.desktop` — picked up by GNOME / KDE / XFCE menus on next session |
| Qdrant native binary | `~/.ultron/qdrant-native/qdrant` (Linux ELF, not the `.exe` from the Windows release) |
| Qdrant config | `~/.ultron/qdrant-native/config/production.yaml` (same shape as Windows) |
| Skills / agents / hooks | `~/.claude/skills/`, `~/.claude/agents/`, hook scripts referenced by `~/.claude/settings.json` |
| Vault & state | `~/.ultron-vault/`, `~/.ultron/` — identical to Windows |

### What runs and what doesn't

Maintenance commands are gated per-OS. The `pc-*` quick actions are
Windows-only (`#[cfg(target_os = "windows")]`) and fail with an
unknown-kind error elsewhere. The cross-platform ones (`skill-security-audit`,
`registry-sync`, `mcp-health`, `deadwood-scan`, `doctor-fix`,
`weekly-backup` with its bash variant) behave the same; see
`docs/COMMANDS.md` §2.

Hooks: every Claude Code hook ULTRON registers is a Node script under
`hooks/scripts/` and runs identically on Linux (`install.sh` merges
`templates/settings-hooks.json` with `{USERPROFILE}` expanded to `$HOME`).
The Qdrant boot helper has a bash sibling (`scripts/qdrant/ensure-qdrant.sh`),
but it is not a hook.

### Removing ULTRON on Linux

A scripted `uninstall.sh` for the Linux flow ships since v2.7.1
(`scripts/uninstall.sh`). The manual three-liner still works if you prefer
it hands-on:

```bash
# Remove the desktop app (AppImage install)
rm -f ~/.local/bin/ultron-control-center
rm -f ~/.local/share/applications/ultron-control-center.desktop

# OR remove the .deb install
sudo apt remove ultron-control-center      # Debian / Ubuntu
sudo dpkg -r ultron-control-center         # any distro that has dpkg

# Remove all ULTRON state (DANGEROUS — takes your vault with it)
rm -rf ~/.ultron ~/.ultron-vault
```

This leaves `~/.claude/` untouched, mirroring the Windows uninstaller's
behaviour. Back up `~/.ultron-vault/` first if you want to keep your
notes.

## Uninstall

Run the matching uninstall script. It moves any backups out of the way
before removing `~/.ultron/`. It never touches `~/.claude/`.

```powershell
# Windows
./scripts/uninstall.ps1

# Add -Yes to skip the confirmation prompt
./scripts/uninstall.ps1 -Yes
```

On Linux, run `./scripts/uninstall.sh` (shipped since v2.7.1), or follow
the manual removal steps in the **Linux specifics** section above.

After uninstall, backups (if any) live at
`$HOME/.ultron-backup-<timestamp>/`. You can delete that directory by hand
once you have copied out anything you want to keep.
