# Installing ULTRON v15.4

ULTRON is a personal control center: a Tauri desktop app plus a Python toolkit
that orchestrates Claude Code, Codex, and Gemini through their official CLIs.
It runs entirely on your machine and uses your existing subscriptions — no
API keys, no cloud services, no admin rights.

## One-line install

```bash
# Windows (PowerShell 5+)
git clone https://github.com/SkiTemplar/ultron.git
cd ultron
./scripts/install.ps1
```

```bash
# macOS / Linux (bash)
git clone https://github.com/SkiTemplar/ultron.git
cd ultron
chmod +x scripts/install.sh
./scripts/install.sh
```

The installer is **idempotent** — re-running it is safe. It accepts an
optional `-NonInteractive` (PowerShell) or `--non-interactive` (bash) flag
that takes all defaults, useful for CI.

## What the installer does

The installer performs the following steps, printing a clear `checking ...`
line before each one and an `ok` / `warn` / `fail` line after. On a hard
failure it prints the offending command, a suggested fix, and exits with a
non-zero code.

1. **Preflight.** Confirms a supported host (Windows 10+ for `install.ps1`,
   Linux or macOS for `install.sh`), PowerShell 5+ or bash 3.2+, and that
   `github.com` is reachable.
2. **Dependency probe.** Reports whether `rustc`, `node` (v22+), `uv`, and
   `claude` are on `PATH`, and the optional `codex` and `gemini` CLIs. The
   installer never auto-installs anything — it points you at the official
   documentation and exits if a required tool is missing.
3. **Directory tree.** Creates `~/.ultron/` with subdirectories `cockpit/`,
   `plans/`, `skills/`, `scripts/`, `brain_index/`, `.tmp/`, and `personal/`.
   Existing directories are left untouched.
4. **Claude skills wiring.** If `~/.claude/skills` already exists it is left
   alone; otherwise an empty directory is created so the desktop app can
   find it.
5. **Python sync.** Runs `uv sync` at the repo root.
6. **Node sync.** Runs `npm install` inside `control-center/`.
7. **Feature toggles.** The visual wizard (or CLI fallback) asks per
   optional module (News, Gaming, Personal, Schedules, Self-improve,
   Notifications, Usage, Sessions, Projects, Plans) and writes your
   choices to `~/.ultron/cockpit/features.json`. The desktop app reads
   this file at startup to decide which optional tabs to expose. You
   can flip toggles later from **Settings → Features**, or re-run
   `install.ps1` to physically purge a module's files.

## What you need ahead of time

| Tool        | Minimum version | Required? | Link                                            |
| ----------- | --------------- | --------- | ----------------------------------------------- |
| Rust        | stable          | yes       | https://rustup.rs                               |
| Node.js     | 22+             | yes       | https://nodejs.org                              |
| uv          | latest          | yes       | https://docs.astral.sh/uv                       |
| Claude CLI  | latest          | yes       | https://docs.claude.com/en/docs/claude-code     |
| Codex CLI   | latest          | optional  | https://github.com/openai/codex                 |
| Gemini CLI  | latest          | optional  | https://github.com/google-gemini/gemini-cli     |

You sign in to each CLI once (`claude`, `codex`, `gemini`) using your existing
subscription. ULTRON never asks for an API key.

## Feature toggles

When the installer prompts you for optional features, the defaults are:

```
News digest        [y/N]   default N  (costs Gemini tokens)
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
  "news": false,
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

1. Download the newest installer from
   `https://github.com/SkiTemplar/ultron/releases/latest`.
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

If you would prefer to vet the source yourself, the build is fully
reproducible from the public GitHub Actions workflow at
`.github/workflows/release.yml`. Every release artifact is built on a
GitHub-hosted runner from a tagged commit and signed there with the
project's updater key.

## Uninstall

Run the matching uninstall script. It moves any backups out of the way
before removing `~/.ultron/`. It never touches `~/.claude/`.

```powershell
# Windows
./scripts/uninstall.ps1

# Add -Yes to skip the confirmation prompt
./scripts/uninstall.ps1 -Yes
```

```bash
# macOS / Linux
./scripts/uninstall.sh

# Add --yes to skip the confirmation prompt
./scripts/uninstall.sh --yes
```

After uninstall, backups (if any) live at
`$HOME/.ultron-backup-<timestamp>/`. You can delete that directory by hand
once you have copied out anything you want to keep.
