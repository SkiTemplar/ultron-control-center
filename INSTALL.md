# ULTRON — install

> [!TIP]
> **TL;DR.** Open PowerShell (Windows) or bash (Linux), clone the repo into
> `~/.ultron`, run the installer, wait a few minutes, launch the desktop app.
> The rest of this file is for when something goes wrong.

ULTRON has three install paths; pick one.

1. **Manual installer (clone)** — clone the repo, run `install.ps1` or
   `install.sh`. **Recommended — this is the verified path.** The installer
   compiles the Control Center from source. ~5-10 minutes depending on
   whether Rust, Node, and Claude Code are already on PATH.
2. **Bootstrap one-liner** — `iwr | iex` (Windows) / `curl | bash` (Linux).
   Downloads a prebuilt binary from a GitHub Release.
   > [!NOTE]
   > **Requires a published GitHub Release.** The pipeline
   > (`.github/workflows/release.yml`, triggered by a `v*.*.*` tag) is
   > active; if the Releases page is still empty on your fork/clone, use
3. **Per-step manual** — see [`docs/INSTALL-ADVANCED.md`](docs/INSTALL-ADVANCED.md).

---

## 1. Manual installer (clone the repo) — recommended

This is the path that works today. The install root is tied to a git
checkout you can edit and PR back:

```powershell
git clone https://github.com/SkiTemplar/ultron-control-center.git $env:USERPROFILE\.ultron
cd $env:USERPROFILE\.ultron
.\install.ps1
```

Linux equivalent:

```bash
git clone https://github.com/SkiTemplar/ultron-control-center.git ~/.ultron
cd ~/.ultron
./install.sh
```

The installer is **idempotent** — rerun any time; steps that are already
done are detected and skipped. Common flags:

```powershell
.\install.ps1                  # interactive WinForms wizard (default)
.\install.ps1 -NonInteractive  # CI / unattended (accept defaults)
.\install.ps1 -Verbose         # debug what each step does
.\install.ps1 -NoApp           # skip the Tauri Control Center build
.\install.ps1 -NoDocker        # skip Qdrant (semantic recall stays off)
.\install.ps1 -Force           # re-run every step even if it looks done
```

### Component selection

Passing any component switch skips the wizard and runs a deterministic
install of ONLY the selected components (every remaining prompt takes its
non-interactive default). Without these switches nothing changes: you get
the historical wizard / CLI flow.

```powershell
.\install.ps1 -Core            # app (npm install) + memory (Qdrant,
                               # brain_index, sidecar, venv) + hooks
.\install.ps1 -All             # core + skills + tones + agents
.\install.ps1 -Skills -Agents  # a-la-carte: only those components
.\install.ps1 -Core -DryRun    # print what -Core would do; touch nothing
```

Linux equivalents: `--core`, `--all`, `--skills`, `--tones`, `--agents`,
`--dry-run` (see `./install.sh --help`).

What each component installs:

| Component | What it does |
|---|---|
| `core` | Dependency check/auto-install (git, Node 22+, Claude Code, uv, Rust), Qdrant native binary, directory layout + templates, Python venv (`uv sync`), Claude Code hooks merged into `~/.claude/settings.json` (timestamped backup first), feature flags, `brain_index` init, `ultron-memory` sidecar, `npm install` in `control-center/` (Windows; the Tauri build stays opt-in). |
| `skills` | Core skills from the repo `skills/` dir into `~/.claude/skills/` (manifest: `templates/skills-manifest.example.yaml`). Existing skill dirs are never overwritten. |
| `tones` | Verifies tone seeding. The publishable tone seeds ship compiled inside the app and the `ultron-memory` sidecar; `~/.ultron/personality.json` is auto-created from them on first run. An existing `personality.json` (local, gitignored user config) is NEVER read, copied or overwritten. |
| `agents` | Copies `agents/*.md` from the repo into `~/.claude/agents/` if the repo ships an `agents/` dir. The public repo ships none (community agents carry their own licenses), so on a fresh clone this step reports that and installs nothing; use the Agents tab catalog after first launch. |

Re-running any combination is idempotent: existing destinations and
existing user config are kept, never silently replaced.

What the installer does, end to end: preflight (OS / PowerShell / disk /
network) → git + Node 22 prerequisites → Claude Code CLI check (hard
requirement) → uv → Rust toolchain → Qdrant native binary →
directory layout → hooks merge into `settings.json` → skills picker →
agents copy → brain_index init → feature toggles → Control Center build
(`npm install` + `tauri build`, skip with `-NoApp`) → doctor health check.
Full per-step reference in
[`docs/INSTALL-ADVANCED.md`](docs/INSTALL-ADVANCED.md).

On Windows the first launch shows a SmartScreen warning (the NSIS
installer is unsigned). Click **More info → Run anyway**. Code signing is
tracked by the maintainer.

On Linux the `.AppImage` is `chmod +x` and run; the `.deb` installs with
`sudo dpkg -i ultron-control-center_<ver>_amd64.deb` (`sudo apt -f install`
finishes any missing deps).

> [!WARNING]
> **Linux build is unverified by the author.** v15.5 added the Linux path
> (`.deb`, `.AppImage`, `bootstrap.sh`, `install.sh`) and CI compiles
> cleanly on `ubuntu-22.04`, but nobody has end-to-end tested an actual
> Linux install yet. If you run this and it works (or breaks), please open
> an issue with the distro + version + log.

To uninstall:

```powershell
.\uninstall.ps1            # interactive: confirms before deleting
.\uninstall.ps1 -DryRun    # preview what would be removed
.\uninstall.ps1 -KeepBackups   # rename ~/.ultron/ instead of deleting
```

---

## 2. Bootstrap one-liner

> [!NOTE]
> This path downloads prebuilt artifacts from the latest GitHub Release.
> If the Releases page is empty (fresh fork, or no `v*.*.*` tag pushed yet),
> the one-liner fails at "fetching latest release" — use path 1 (clone)
> instead. Releases are cut by pushing a version tag; see
> el proceso de release del mantenedor.

### Windows 11 (PowerShell, no Git required)

```powershell
iwr -useb https://raw.githubusercontent.com/SkiTemplar/ultron-control-center/main/bootstrap.ps1 | iex
```

The script hits the GitHub Releases API, finds the latest `v*.*.*` tag,
downloads `ultron-system-<ver>.zip` + the NSIS installer, verifies the
SHA-256, extracts to `~/.ultron`, runs `install.ps1` and launches the
Control Center.

**Pin to a specific release** (reproducible installs):

```powershell
iwr -useb https://raw.githubusercontent.com/SkiTemplar/ultron-control-center/refs/tags/v15.7.0/bootstrap.ps1 | iex
```

### Linux x86_64 (Debian / Ubuntu / Fedora / Arch)

```bash
curl -fsSL https://raw.githubusercontent.com/SkiTemplar/ultron-control-center/main/bootstrap.sh | bash
```

`install.sh` package-manager-detects (`apt` / `dnf` / `pacman`) and may
invoke `sudo` for the system deps; everything else is per-user. WSL is
detected and warned against (use the native Windows path under WSL).

### After bootstrap

Re-run the same one-liner to upgrade — `~/.ultron-vault/` and
`~/.ultron/plans/` are preserved between releases.

---

## 3. Troubleshooting

| Symptom                                              | Fix                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `iex (irm .../install.ps1)` says "execution policy"  | `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`        |
| `winget : not recognized`                            | Install "App Installer" from Microsoft Store, then re-run    |
| `winget` install hangs or exits non-zero             | Check your network / proxy; retry; or install that dep by hand |
| Auto-installed binary not on PATH after winget       | Open a fresh PowerShell shell so the user PATH reloads       |
| `uv: not recognized` after auto-install              | Open a new shell so PATH reloads, or add `~/.local/bin`      |
| `qdrant.exe` won't start                             | Check `~/.ultron/.tmp/qdrant-native.err`. Kill stale processes: `Get-Process qdrant \| Stop-Process -Force`, then re-run `~/.ultron/scripts/qdrant/ensure-qdrant.ps1`. |
| `rustc` not on PATH right after Rust auto-install    | Open a fresh shell; if still missing, reboot once            |
| `npm install` errors on `better-sqlite3` / `keytar`  | Install Node 22+, then `Remove-Item node_modules -Recurse; npm i` |
| `tauri build` complains about Webview2               | Install Edge Webview2 runtime: <https://aka.ms/Edge/Webview2> |
| `settings.json` got mangled                          | Restore from `settings.json.bak-<timestamp>` written by the hooks step |
| Claude doesn't auto-launch hooks                     | Hooks didn't merge. Re-run `install.ps1 -Force`              |
| `/healthz` not responding on port 6333               | `ensure-qdrant.ps1` couldn't launch the binary. Verify `~/.ultron/qdrant-native/qdrant.exe` exists; if not, rerun `install.ps1 -Force`. |
| SmartScreen blocks the NSIS installer                | Click **More info → Run anyway**. The installer is unsigned. |

For deeper failures — wizard internals, per-feature opt-outs, hook list,
auto-install matrix, Linux package-manager detection, scheduled tasks,
manual uninstall — see [`docs/INSTALL-ADVANCED.md`](docs/INSTALL-ADVANCED.md).

Issue tracker: <https://github.com/SkiTemplar/ultron-control-center/issues>.
