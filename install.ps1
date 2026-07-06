<#
.SYNOPSIS
  ULTRON one-shot bootstrap installer (root entrypoint, Windows / PowerShell).

.DESCRIPTION
  This is the "iex (irm .../install.ps1)" entrypoint a new user runs from a
  fresh shell. It is hardened, idempotent, defensive and verbose-capable.

  Flow:
    1.  Preflight     - OS, PowerShell, RAM, disk, internet
    2.  Claude Code   - hard requirement; refuse to continue if missing
    3.  uv            - auto-install if missing
    4.  Qdrant        - native Windows binary, no Docker, into ~/.ultron/qdrant-native/
    5.  Dir layout    - ~/.ultron, ~/.ultron-vault, ~/.claude/skills
    7.  Hooks         - merge templates/settings-hooks.json into settings.json
    8.  Skills picker - install core skills, prompt one-by-one for personal
    8c. Feature flags - writes ~/.ultron/cockpit/features.json (visibility)
    8d. Opt-out purge - delete files for unchecked wizard features (v15.3.5+)
    9.  brain_index   - initialize SQLite FTS5 index
    10. Control Center- npm install + tauri build (optional, -NoApp skips)
    11. Verification  - run scripts/cockpit/doctor.py if present

  Every step is idempotent: re-running is safe. Each step is wrapped in
  its own try/catch and is allowed to fail without aborting the whole run
  unless the failure is fatal (Claude Code missing, disk < 5 GB).

  This script DOES NOT touch control-center source code, never asks for
  API keys, and never requires admin / UAC elevation.

.PARAMETER NonInteractive
  Skip all y/N prompts and accept defaults. Suitable for CI.

.PARAMETER NoApp
  Skip the control-center build (steps 10). Useful on machines without
  Rust toolchain or for headless installs.

.PARAMETER NoDocker
  Skip the Qdrant native binary step. Semantic recall over the vault is
  then disabled. The flag name is historical — ULTRON has not used
  Docker since v15.0.2; Qdrant runs as a native Windows binary fetched
  from the official GitHub releases.

.PARAMETER InstallRoot
  Override the install root. Defaults to "$env:USERPROFILE\.ultron".

.PARAMETER Force
  Re-run idempotent steps even if their sentinel says they completed.
  Also skips the visual wizard.

.PARAMETER Gui
  Open the visual installer wizard (WinForms checkboxes). This is the
  default behaviour when no flag is given; -Gui is here for symmetry
  with -Cli and so scripts can be explicit.

.PARAMETER Cli
  Force the legacy CLI flow (Read-Host prompts per step). Use this on
  hosts where WinForms is unavailable (PS Server Core) or when you want
  every choice scripted/scrollable.

.EXAMPLE
  # Standard one-liner from a fresh shell - opens the visual wizard:
  iex (irm https://raw.githubusercontent.com/SkiTemplar/ultron/main/install.ps1)

.EXAMPLE
  # Skip the wizard, ask each question in the terminal:
  .\install.ps1 -Cli

.EXAMPLE
  # CI / unattended:
  .\install.ps1 -NonInteractive -NoApp

.NOTES
  v15.5.14: the former scripts/install.ps1 + scripts/install.sh inner
  installers (552 + 484 lines, last touched for v15.2 / "v15.2.0" banner)
  were retired to _legacy/install-pre-v15.4.{ps1,sh}. This root script now
  handles the npm install inline (Build-ControlCenter), so there is exactly
  ONE entry point per platform: install.ps1 (Windows) and install.sh
  (Linux). The legacy copies are kept for archaeology only — do not invoke.
#>

[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [switch]$NoApp,
    [switch]$NoDocker,
    [switch]$Force,
    # Visual installer wizard (WinForms). Default ON. -Cli forces the legacy
    # CLI Read-Host flow that this script always had. -NonInteractive also
    # skips the wizard (no prompts at all). -Gui is here for symmetry and
    # to make the flag explicit in scripts; behaviour is identical to the
    # default.
    [switch]$Gui,
    [switch]$Cli,
    [string]$InstallRoot = (Join-Path $env:USERPROFILE ".ultron"),
    # CC-13 hardening: opt-in multi-user host lockdown. When set, the
    # installer breaks ACL inheritance on $InstallRoot and grants Full
    # Control only to the current user. Default OFF — single-user laptops
    # have no exposure (the home directory already inherits per-user
    # SIDs), and locking the tree breaks scenarios where another local
    # account legitimately needs to read the brain index (e.g. shared
    # household laptop). Set this when ~/.ultron will hold secrets you
    # don't want other Windows accounts on the same machine to read.
    [switch]$LockdownAcl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------------
# Constants and state
# ----------------------------------------------------------------------
$Script:VersionFallback = "v15.6.0"
$Script:RepoRoot        = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
$Script:Warnings        = New-Object System.Collections.Generic.List[string]
$Script:Errors          = New-Object System.Collections.Generic.List[string]
$Script:StepsOK         = New-Object System.Collections.Generic.List[string]
$Script:StepsSkipped    = New-Object System.Collections.Generic.List[string]
$Script:VerboseOn       = $PSBoundParameters.ContainsKey("Verbose") -or $VerbosePreference -ne "SilentlyContinue"
# Selections hashtable from Show-InstallWizard. Empty means "no wizard
# was run" (CLI/NonInteractive mode) - downstream steps then use their
# legacy defaults.
$Script:Selections      = @{}
# Where the wizard reads/writes its profile so re-runs remember choices.
$Script:ProfilePath     = Join-Path $env:USERPROFILE ".ultron\cockpit\install-profile.json"

# ----------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------
function Write-Banner {
    Write-Host ""
    Write-Host "======================================================="
    Write-Host " ULTRON installer (root) $Script:VersionFallback"
    Write-Host " https://github.com/SkiTemplar/ultron"
    Write-Host "======================================================="
    Write-Host ""
    Write-Host " Auto-install enabled: missing dependencies (git, Node,"
    Write-Host " Claude Code, Rust, uv) will be installed via winget"
    Write-Host " unless you decline at the prompt."
    Write-Host " No admin / UAC elevation needed for winget user-scope."
    Write-Host ""
    if ($NonInteractive) { Write-Host "(non-interactive: auto-accepting all installs)" }
    if ($Script:VerboseOn) { Write-Host "(verbose mode)" }
}

function Write-Step { param([string]$Msg) Write-Host ("[ STEP ] " + $Msg) }
function Write-OK   { param([string]$Msg) Write-Host ("  ok    " + $Msg); $Script:StepsOK.Add($Msg) | Out-Null }
function Write-Skip { param([string]$Msg) Write-Host ("  skip  " + $Msg); $Script:StepsSkipped.Add($Msg) | Out-Null }
function Write-Warn2 { param([string]$Msg) Write-Host ("  warn  " + $Msg); $Script:Warnings.Add($Msg) | Out-Null }
function Write-Fail { param([string]$Msg) Write-Host ("  fail  " + $Msg); $Script:Errors.Add($Msg) | Out-Null }
function Write-Info { param([string]$Msg) Write-Host ("        " + $Msg) }
function Write-V    { param([string]$Msg) if ($Script:VerboseOn) { Write-Host ("    .   " + $Msg) } }

function Confirm-YesNo {
    param(
        [string]$Question,
        [bool]$Default = $false
    )
    if ($NonInteractive) { return $Default }
    $label = if ($Default) { "Y/n" } else { "y/N" }
    $ans = Read-Host -Prompt ("  " + $Question + " [" + $label + "]")
    if (-not $ans) { return $Default }
    switch -Regex ($ans.Trim().ToLower()) {
        "^(y|yes)$" { return $true }
        "^(n|no)$"  { return $false }
        default     { return $Default }
    }
}

# ----------------------------------------------------------------------
# Selection helper: read a boolean choice from the wizard result.
#
# Steps that have a wizard checkbox call Get-Choice with the id and a
# fallback. If the wizard ran and the id is present, that wins. Otherwise
# we fall through to the caller's default — which is the legacy behaviour
# this script had before the wizard existed. This is how the same step
# functions transparently work in -Cli, -NonInteractive, and -Gui modes
# without forking the codepaths.
# ----------------------------------------------------------------------
function Get-Choice {
    param(
        [string]$Id,
        [bool]$Default
    )
    if ($Script:Selections -and $Script:Selections.ContainsKey($Id)) {
        return [bool]$Script:Selections[$Id]
    }
    return $Default
}

# ----------------------------------------------------------------------
# Visual installer wizard (WinForms checkboxes).
#
# Invokes scripts/cockpit/install-wizard.ps1 in the same PowerShell
# session and stores the returned selection hashtable on $Script:Selections.
# The wizard's job is to ASK; the actual install work stays in the
# step functions below, which just call Get-Choice to decide whether to
# run.
#
# Persistence: the result is written to ~/.ultron/cockpit/install-profile.json
# so the next re-run pre-checks whatever the user picked last time.
#
# Bypass rules:
#   -NonInteractive : skip wizard entirely, use built-in defaults
#   -Cli            : skip wizard, fall back to the legacy Read-Host prompts
#   -Force          : skip wizard, run every step (override defaults)
#   otherwise       : open the wizard (default behaviour, even without -Gui)
# ----------------------------------------------------------------------
function Show-InstallWizard {
    if ($NonInteractive -or $Cli -or $Force) {
        $mode = if ($NonInteractive) { "non-interactive" } elseif ($Cli) { "cli" } else { "force" }
        Write-Skip ("install wizard (mode: " + $mode + ")")
        return
    }

    $wizard = Join-Path $Script:RepoRoot "scripts\cockpit\install-wizard.ps1"
    if (-not (Test-Path -LiteralPath $wizard)) {
        Write-Warn2 "install-wizard.ps1 missing - falling back to CLI prompts"
        return
    }

    # Load previous profile, if any. Corrupt JSON is silently discarded.
    $prev = @{}
    if (Test-Path -LiteralPath $Script:ProfilePath) {
        try {
            $raw = Get-Content -LiteralPath $Script:ProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $raw.PSObject.Properties) {
                if ($p.Name -notmatch '^_') { $prev[$p.Name] = $p.Value }
            }
        } catch {
            Write-V ("previous install profile corrupt - ignoring: " + $_.Exception.Message)
        }
    }

    Write-Step "0. install wizard (choose what to install)"
    try {
        $result = & $wizard -PreviousProfile $prev -Version $Script:VersionFallback
    } catch {
        Write-Warn2 ("wizard failed (" + $_.Exception.Message + ") - falling back to CLI prompts")
        return
    }

    if (-not $result -or $result.Count -eq 0) {
        Write-Host ""
        Write-Host "Installer cancelled by user."
        exit 130
    }

    $Script:Selections = $result

    # Persist for next run.
    try {
        $dir = Split-Path -Parent $Script:ProfilePath
        if (-not (Test-Path -LiteralPath $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        ($result | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $Script:ProfilePath -Encoding UTF8
        Write-V ("install profile saved -> " + $Script:ProfilePath)
    } catch {
        Write-Warn2 ("could not save install profile: " + $_.Exception.Message)
    }

    # Build-ControlCenter, Install-QdrantNative, Set-FeatureFlags etc. all
    # read from $Script:Selections via Get-Choice. We deliberately do NOT
    # rewrite $NoApp / $NoDocker — those legacy CLI flags are still
    # respected at their own check points, and inferring them from the
    # wizard would muddle precedence rules.
    $picked = ($Script:Selections.Keys | Where-Object { $_ -notmatch '^_' -and $Script:Selections[$_] }).Count
    Write-OK ("wizard: " + $picked + " items selected")
}

# ----------------------------------------------------------------------
# Helpers: winget detection + idempotent package install + PATH refresh
# ----------------------------------------------------------------------
function Update-SessionPath {
    # After a winget install, refresh PATH from registry so the rest of
    # this same PowerShell session can find the new binaries.
    try {
        $machine = [System.Environment]::GetEnvironmentVariable("Path","Machine")
        $user    = [System.Environment]::GetEnvironmentVariable("Path","User")
        $merged  = ($machine, $user | Where-Object { $_ }) -join ";"
        if ($merged) { $env:Path = $merged }
    } catch {
        Write-V ("PATH refresh skipped: " + $_.Exception.Message)
    }
}

function Test-WingetAvailable {
    if (Get-Command "winget" -ErrorAction SilentlyContinue) { return $true }
    Write-Warn2 "winget (App Installer) not found on this machine."
    Write-Info  "Auto-install needs winget. Install 'App Installer' from"
    Write-Info  "the Microsoft Store, OR install missing dependencies"
    Write-Info  "manually using the URLs printed by each step, then re-run."
    return $false
}

function Test-WingetInstalled {
    param([string]$PackageId)
    try {
        $out = & winget list --id $PackageId --exact --accept-source-agreements 2>$null
        if ($LASTEXITCODE -eq 0 -and $out -match [regex]::Escape($PackageId)) { return $true }
    } catch { }
    return $false
}

function Install-WingetPackage {
    param(
        [string]$PackageId,
        [string]$FriendlyName,
        [string]$ProbeCmd = "",
        [bool]$RequireConfirm = $true,
        [bool]$DefaultYes = $true
    )
    if (-not (Test-WingetAvailable)) { return $false }

    if (Test-WingetInstalled -PackageId $PackageId) {
        Write-V ("$FriendlyName already registered with winget (" + $PackageId + ")")
        Update-SessionPath
        return $true
    }

    if ($RequireConfirm) {
        $ok = Confirm-YesNo -Question ("Install $FriendlyName automatically via winget?") -Default $DefaultYes
        if (-not $ok) {
            Write-Skip ("$FriendlyName declined by user")
            return $false
        }
    }

    Write-Info ("installing $FriendlyName ($PackageId) - this can take a few minutes...")
    try {
        & winget install --id $PackageId --exact --silent `
            --accept-source-agreements --accept-package-agreements `
            --disable-interactivity 2>&1 | ForEach-Object { Write-V $_ }
        $code = $LASTEXITCODE
        # winget exit codes: 0 = ok, 0x8A150011 / -1978335215 = no upgrade available (already installed)
        if ($code -ne 0 -and $code -ne -1978335215) {
            Write-Warn2 ("winget install $PackageId exited $code")
            return $false
        }
    } catch {
        Write-Warn2 ("winget install $PackageId failed: " + $_.Exception.Message)
        return $false
    }

    Update-SessionPath

    if ($ProbeCmd) {
        if (Get-Command $ProbeCmd -ErrorAction SilentlyContinue) {
            Write-OK ("$FriendlyName installed (" + $ProbeCmd + " on PATH)")
            return $true
        } else {
            Write-Warn2 ("$FriendlyName installed but '$ProbeCmd' not on PATH yet. A new shell may be required.")
            return $true
        }
    }
    Write-OK ("$FriendlyName installed")
    return $true
}

# ----------------------------------------------------------------------
# Step 0a: git (needed to clone ultron-skills + general dev hygiene)
# ----------------------------------------------------------------------
function Test-OrInstall-Git {
    Write-Step "0a. git"
    if (Get-Command "git" -ErrorAction SilentlyContinue) {
        try {
            $ver = (& git --version 2>$null)
            Write-OK ("git " + $ver)
            return $true
        } catch {
            Write-Warn2 "git on PATH but --version failed"
            return $true
        }
    }
    Write-Warn2 "git not on PATH."
    $installed = Install-WingetPackage -PackageId "Git.Git" -FriendlyName "Git" -ProbeCmd "git"
    if ($installed -and (Get-Command "git" -ErrorAction SilentlyContinue)) {
        Write-OK ("git " + (& git --version 2>$null))
        return $true
    }
    Write-Warn2 "git remains unavailable. Some optional steps (community skills) will be skipped."
    return $false
}

# ----------------------------------------------------------------------
# Step 0b: Node 22 LTS (prerequisite for Claude Code CLI + tauri build)
# ----------------------------------------------------------------------
function Test-OrInstall-Node {
    Write-Step "0b. Node.js 22 LTS"
    $node = Get-Command "node" -ErrorAction SilentlyContinue
    if ($node) {
        try {
            $verStr = (& node --version 2>$null)  # e.g. v22.4.0
            $major  = [int]([regex]::Match($verStr, '^v(\d+)').Groups[1].Value)
            if ($major -ge 22) {
                Write-OK ("node " + $verStr)
                return $true
            }
            Write-Warn2 ("node " + $verStr + " is older than v22. Auto-upgrade via winget.")
        } catch {
            Write-Warn2 "node detected but --version failed; will attempt reinstall"
        }
    } else {
        Write-Warn2 "node not on PATH."
    }
    $installed = Install-WingetPackage -PackageId "OpenJS.NodeJS.LTS" -FriendlyName "Node.js 22 LTS" -ProbeCmd "node"
    if ($installed -and (Get-Command "node" -ErrorAction SilentlyContinue)) {
        Write-OK ("node " + (& node --version 2>$null))
        return $true
    }
    Write-Warn2 "Node 22 LTS missing. Claude Code install and Tauri build will fail."
    return $false
}

# ----------------------------------------------------------------------
# Step 1: preflight
# ----------------------------------------------------------------------
function Test-Preflight {
    Write-Step "1. preflight"

    # OS detection
    try {
        $isWin = $true
        if ($PSVersionTable.PSVersion.Major -ge 6 -and -not $IsWindows) {
            $isWin = $false
        }
        if (-not $isWin) {
            Write-Fail "non-Windows host. Use install.sh on Linux."
            throw "Unsupported OS"
        }
        $caption = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption
        if ($caption) {
            Write-V "OS: $caption"
            if ($caption -match "Windows (7|8|XP)" -or $caption -notmatch "Windows (10|11|Server)") {
                Write-Warn2 "Windows < 10 detected ('$caption'). Untested."
            } else {
                Write-OK "Windows host"
            }
        } else {
            Write-OK "Windows host (CIM unavailable, assuming OK)"
        }
    } catch {
        Write-Fail ("OS check failed: " + $_.Exception.Message)
        throw
    }

    # PS version
    $psv = $PSVersionTable.PSVersion
    if ($psv.Major -lt 5) {
        Write-Fail "PowerShell $psv is too old. Install 5.1+ or 7+."
        throw "PowerShell version"
    }
    Write-OK ("PowerShell " + $psv)

    # RAM (warn-only)
    try {
        $totalKb = (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).TotalVisibleMemorySize
        if ($totalKb) {
            $gb = [math]::Round($totalKb / 1MB, 1)
            if ($gb -lt 8) {
                Write-Warn2 ("RAM " + $gb + " GB (recommended >= 8 GB)")
            } else {
                Write-OK ("RAM " + $gb + " GB")
            }
        }
    } catch { Write-V "RAM probe skipped" }

    # Disk (hard block at <5 GB free on system drive)
    try {
        $drive = (Get-Item -LiteralPath $env:USERPROFILE).PSDrive
        $freeGb = [math]::Round($drive.Free / 1GB, 1)
        if ($freeGb -lt 5) {
            Write-Fail ("Only $freeGb GB free on $($drive.Name): - need >= 5 GB.")
            throw "Disk space"
        }
        Write-OK ("disk " + $freeGb + " GB free on " + $drive.Name + ":")
    } catch {
        Write-Warn2 ("disk probe failed: " + $_.Exception.Message)
    }

    # Internet
    try {
        $ok = Test-Connection -ComputerName "github.com" -Count 1 -Quiet -ErrorAction Stop
        if ($ok) {
            Write-OK "github.com reachable"
        } else {
            Write-Warn2 "github.com unreachable (Test-Connection negative)"
        }
    } catch {
        Write-Warn2 ("internet check failed: " + $_.Exception.Message)
    }
}

# ----------------------------------------------------------------------
# Step 2: Claude Code (hard requirement)
# ----------------------------------------------------------------------
function Test-ClaudeCode {
    Write-Step "2. Claude Code CLI"
    $cmd = Get-Command "claude" -ErrorAction SilentlyContinue
    if ($cmd) {
        try {
            $ver = & claude --version 2>$null | Select-Object -First 1
            Write-OK ("claude $ver")
            return
        } catch {
            Write-Warn2 ("claude found at " + $cmd.Source + " but --version failed")
            return
        }
    }

    Write-Warn2 "Claude Code CLI not on PATH."

    # Claude Code is a hard requirement, but we can install it if npm is here.
    $npm = Get-Command "npm" -ErrorAction SilentlyContinue
    if (-not $npm) {
        Write-Fail "npm not on PATH. Node install (step 0b) must have failed."
        Write-Info ""
        Write-Info "Manual recovery:"
        Write-Info "  winget install OpenJS.NodeJS.LTS --silent"
        Write-Info "  (open new shell)"
        Write-Info "  npm install -g @anthropic-ai/claude-code"
        Write-Info ""
        exit 2
    }

    $doIt = Confirm-YesNo -Question "Install Claude Code CLI now via 'npm install -g @anthropic-ai/claude-code'?" -Default $true
    if (-not $doIt) {
        Write-Fail "Claude Code CLI is REQUIRED. Aborting."
        Write-Info ""
        Write-Info "Manual install:"
        Write-Info "  npm install -g @anthropic-ai/claude-code"
        Write-Info "  claude login"
        Write-Info ""
        Write-Info "Then re-run this installer."
        exit 2
    }

    Write-Info "running: npm install -g @anthropic-ai/claude-code (may take 1-3 min)"
    try {
        & npm install -g "@anthropic-ai/claude-code" 2>&1 | ForEach-Object { Write-V $_ }
        $code = $LASTEXITCODE
        if ($code -ne 0) {
            Write-Fail "npm install -g @anthropic-ai/claude-code exited $code"
            exit 2
        }
    } catch {
        Write-Fail ("npm install failed: " + $_.Exception.Message)
        exit 2
    }

    Update-SessionPath
    # npm global bin may be at %APPDATA%\npm — make sure session PATH includes it
    $npmPrefix = (& npm config get prefix 2>$null)
    if ($npmPrefix -and (Test-Path -LiteralPath $npmPrefix)) {
        if ($env:Path -notlike "*$npmPrefix*") { $env:Path = $env:Path + ";" + $npmPrefix }
    }

    if (Get-Command "claude" -ErrorAction SilentlyContinue) {
        $ver = & claude --version 2>$null | Select-Object -First 1
        Write-OK ("claude $ver (just installed)")
        Write-Info "Run 'claude login' once to authenticate against your Claude.ai subscription."
    } else {
        Write-Fail "claude installed but not on PATH. Open a fresh shell and re-run this installer."
        exit 2
    }
}

# ----------------------------------------------------------------------
# Step 3: uv (auto-install if missing)
# ----------------------------------------------------------------------
function Test-OrInstall-Uv {
    Write-Step "3. uv (Python package manager)"
    if (Get-Command "uv" -ErrorAction SilentlyContinue) {
        $ver = (& uv --version 2>$null) -join " "
        Write-OK ("uv " + $ver)
        return
    }
    # CC-05 hardening: switched from `iex (irm astral.sh/uv/install.ps1)` (no
    # signature/hash check, RCE-via-MITM in unsafe network) to winget, which
    # signs packages and is the same trust root we use for git/node/rust here.
    Write-Warn2 "uv missing. Attempting auto-install via winget (astral-sh.uv)"
    $installed = Install-WingetPackage -PackageId "astral-sh.uv" -FriendlyName "uv" -ProbeCmd "uv"
    if (-not $installed) {
        Write-Fail "uv install via winget skipped or failed."
        Write-Info "Install manually from https://docs.astral.sh/uv and re-run."
        throw "uv install"
    }
    Update-SessionPath
    # winget drops the binary under %LOCALAPPDATA%\Microsoft\WinGet\Links — already on PATH.
    # Fall back to ~/.local/bin in case a previous standalone install put it there.
    $env:Path = $env:Path + ";" + (Join-Path $env:USERPROFILE ".local\bin")
    if (Get-Command "uv" -ErrorAction SilentlyContinue) {
        $ver = (& uv --version 2>$null) -join " "
        Write-OK ("uv " + $ver + " (just installed)")
    } else {
        Write-Warn2 "uv installed but not on PATH yet. Open a fresh shell and re-run."
        # Don't hard-throw — winget reported success; new shell will see it.
    }
}

# ----------------------------------------------------------------------
# Step 3b: Rust toolchain (prerequisite for Tauri build / control-center)
# ----------------------------------------------------------------------
function Test-OrInstall-Rust {
    Write-Step "3b. Rust toolchain (rustup + cargo)"
    if ($NoApp) { Write-Skip "skipped via -NoApp (no Tauri build needed)"; return $false }

    if (Get-Command "rustc" -ErrorAction SilentlyContinue) {
        try {
            $ver = (& rustc --version 2>$null)
            Write-OK ("rustc " + $ver)
            return $true
        } catch {
            Write-Warn2 "rustc on PATH but --version failed"
        }
    }
    Write-Warn2 "Rust toolchain not on PATH. Tauri build (step 10) needs it."
    $installed = Install-WingetPackage -PackageId "Rustlang.Rustup" -FriendlyName "Rust (rustup)" -ProbeCmd "rustup"
    if (-not $installed) {
        Write-Warn2 "Rust install skipped or failed. Tauri build will be unavailable."
        return $false
    }
    Update-SessionPath
    # rustup installer adds %USERPROFILE%\.cargo\bin
    $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
    if ((Test-Path -LiteralPath $cargoBin) -and ($env:Path -notlike "*$cargoBin*")) {
        $env:Path = $env:Path + ";" + $cargoBin
    }
    if (Get-Command "rustup" -ErrorAction SilentlyContinue) {
        try {
            & rustup default stable 2>&1 | ForEach-Object { Write-V $_ }
        } catch {
            Write-Warn2 ("rustup default stable failed: " + $_.Exception.Message)
        }
    }
    if (Get-Command "rustc" -ErrorAction SilentlyContinue) {
        Write-OK ("rustc " + (& rustc --version 2>$null) + " (just installed)")
        Write-Info "NOTE: Rust install may require a reboot to fully integrate the MSVC linker on first install."
        return $true
    }
    Write-Warn2 "Rust installed but rustc not on PATH yet. A fresh shell (or reboot) may be required."
    return $false
}

# ----------------------------------------------------------------------
# (Removed v15.5.10 / review R6 #2)
#
# The Test-Docker + Initialize-Qdrant functions used to provision Qdrant
# via Docker Desktop. They have been replaced by Install-QdrantNative
# (below) since v15.0.2, which downloads the native Windows binary
# straight from qdrant/qdrant releases — no daemon, no container.
#
# The dead Docker functions were still defined in this script even though
# the main flow never called them, which confused contributors reading
# the source ("does ULTRON depend on Docker?"). Deleted in v15.5.10.
# The -NoDocker flag is kept as a historical alias for "skip Qdrant".

# ----------------------------------------------------------------------
# Step 4 (new): Qdrant native Windows binary (no Docker)
#
# Qdrant is a core ULTRON capability — without it, semantic recall over
# the vault is disabled. We ship the *native* Windows binary fetched from
# the official GitHub releases; no Docker daemon, no container runtime.
#
# Install path: ~/.ultron/qdrant-native/qdrant.exe
# Config:       ~/.ultron/qdrant-native/config/production.yaml (minimal default)
# Boot:         ensure-qdrant.ps1 launches it on SessionStart and from
#               the ULTRON-QdrantBoot scheduled task.
# ----------------------------------------------------------------------
function Install-QdrantNative {
    Write-Step "4. Qdrant native (no Docker)"
    if ($NoDocker) {
        Write-Skip "Skipped via -NoDocker (kept for backwards compat — Qdrant is native, not Docker)"
        return
    }
    if (-not (Get-Choice -Id "mem_qdrant" -Default $true)) {
        Write-Skip "Qdrant unchecked in wizard - semantic recall will be disabled"
        return
    }

    $nativeDir = Join-Path $env:USERPROFILE ".ultron\qdrant-native"
    $exe = Join-Path $nativeDir "qdrant.exe"
    $cfgDir = Join-Path $nativeDir "config"
    $cfg = Join-Path $cfgDir "production.yaml"

    if (Test-Path -LiteralPath $exe) {
        try {
            $size = (Get-Item -LiteralPath $exe).Length
            Write-OK ("qdrant.exe already present (" + [Math]::Round($size/1MB) + " MB)")
        } catch {
            Write-OK "qdrant.exe already present"
        }
    } else {
        Write-V "Downloading Qdrant v1.18.0 Windows binary..."
        if (-not (Test-Path -LiteralPath $nativeDir)) {
            New-Item -ItemType Directory -Path $nativeDir -Force | Out-Null
        }
        $zipUrl = "https://github.com/qdrant/qdrant/releases/download/v1.18.0/qdrant-x86_64-pc-windows-msvc.zip"
        $zipPath = Join-Path $env:TEMP "qdrant-windows.zip"
        # CC-06 hardening: pin the SHA256 of the upstream Windows release zip
        # so a MITM / compromised mirror cannot drop a different binary on
        # us. Hash captured 2026-05-17 from the official GitHub release
        # asset (29,652,104 bytes, recompute with:
        #   Get-FileHash qdrant-x86_64-pc-windows-msvc.zip -Algorithm SHA256
        # when bumping the version). Mismatch = wipe + throw, no extract.
        $expectedSha = "B69196D0AA1D73AE5488A099360FC958FC2A4D82920A75E1D0975952C0441F6F"
        try {
            Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
            $actualSha = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash
            if ($actualSha -ne $expectedSha) {
                Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
                Write-Fail ("Qdrant zip SHA256 mismatch. Expected " + $expectedSha + ", got " + $actualSha)
                throw "Qdrant zip hash mismatch — refusing to extract untrusted binary."
            }
            Write-V ("Qdrant zip SHA256 verified (" + $actualSha.Substring(0, 12) + "...)")
            Write-V "Extracting to $nativeDir"
            Expand-Archive -LiteralPath $zipPath -DestinationPath $nativeDir -Force
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
            if (Test-Path -LiteralPath $exe) {
                Write-OK "qdrant.exe installed at $nativeDir"
            } else {
                Write-Warn2 "Extraction completed but qdrant.exe not found at expected path. Manual fix needed."
                return
            }
        } catch {
            Write-Warn2 ("Qdrant download failed: " + $_.Exception.Message)
            Write-Info "Manually: download $zipUrl, verify SHA256 == $expectedSha, extract to $nativeDir, re-run."
            return
        }
    }

    # Minimal config file so ensure-qdrant.ps1 can launch with `--config-path config\production.yaml`.
    if (-not (Test-Path -LiteralPath $cfgDir)) {
        New-Item -ItemType Directory -Path $cfgDir -Force | Out-Null
    }
    if (-not (Test-Path -LiteralPath $cfg)) {
        @"
storage:
  storage_path: ./storage
  snapshots_path: ./snapshots

service:
  host: 127.0.0.1
  http_port: 6333
  grpc_port: 6334

log_level: INFO
"@ | Set-Content -LiteralPath $cfg -Encoding UTF8
        Write-OK "production.yaml seeded"
    }

    # Probe — is something already serving on 6333?
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:6333/healthz" -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) {
            Write-OK "Qdrant /healthz 200 (already running)"
            return
        }
    } catch {
        # not running — ensure-qdrant.ps1 will start it on next SessionStart.
    }
    Write-Info "Qdrant binary in place. ensure-qdrant.ps1 will boot it on the next Claude session (or run it manually now)."
}

# ----------------------------------------------------------------------
# Step 5: directory layout
# ----------------------------------------------------------------------
function New-DirectoryLayout {
    Write-Step "5. directory layout"
    $dirs = @(
        $InstallRoot,
        (Join-Path $InstallRoot "cockpit"),
        (Join-Path $InstallRoot "plans"),
        (Join-Path $InstallRoot "skills"),
        (Join-Path $InstallRoot "scripts"),
        (Join-Path $InstallRoot "brain_index"),
        (Join-Path $InstallRoot ".tmp"),
        (Join-Path $InstallRoot "personal"),
        (Join-Path $InstallRoot "sessions"),
        (Join-Path $env:USERPROFILE ".ultron-vault"),
        (Join-Path $env:USERPROFILE ".claude\skills")
    )
    foreach ($d in $dirs) {
        if (Test-Path -LiteralPath $d) {
            Write-V ("exists: " + $d)
        } else {
            try {
                New-Item -ItemType Directory -Path $d -Force | Out-Null
                Write-V ("created: " + $d)
            } catch {
                Write-Warn2 ("could not create " + $d + ": " + $_.Exception.Message)
            }
        }
    }
    Write-OK "directory tree provisioned"

    # If we are not running from inside ~/.ultron, offer to relocate.
    $repoNorm = (Resolve-Path -LiteralPath $Script:RepoRoot).Path.TrimEnd('\')
    $rootNorm = (Resolve-Path -LiteralPath $InstallRoot).Path.TrimEnd('\')
    if ($repoNorm -ne $rootNorm) {
        Write-Warn2 ("Repo at " + $repoNorm + " is NOT the same as install root " + $rootNorm)
        Write-Info  "Most scripts expect the repo to live at $InstallRoot. Either:"
        Write-Info  "  - move the clone there, OR"
        Write-Info  "  - re-run with -InstallRoot $repoNorm"
    }
}

# ----------------------------------------------------------------------
# Step 5b: optional ACL lockdown of the install root.
#
# CC-13 hardening: on a multi-user host (shared family PC, lab machine,
# domain workstation with shadow admin accounts) the default ACL on
# %USERPROFILE%\.ultron inherits from the user's home directory, which on
# most Windows installs grants Read/Execute to BUILTIN\Users. That's fine
# for code, but ULTRON's vault, alerts.jsonl and SQLite brain_index can
# hold personal-content artefacts the user probably doesn't want other
# accounts on the same box to be able to read.
#
# This step is OFF by default — single-user laptops have no exposure,
# and locking the tree breaks scenarios where another local account
# legitimately needs to read the brain index. Opt-in with -LockdownAcl.
#
# The icacls invocation:
#   /inheritance:r            break inheritance, remove inherited ACEs
#   /grant:r ${user}:(OI)(CI)F  re-grant Full Control to the current user
#                              with Object/Container Inherit so newly
#                              created files inherit the new ACL.
# ----------------------------------------------------------------------
function Set-InstallRootAcl {
    Write-Step "5a. ACL lockdown (optional)"
    if (-not $LockdownAcl) {
        Write-Skip "skipped (use -LockdownAcl to enable on multi-user hosts)"
        return
    }
    if (-not (Test-Path -LiteralPath $InstallRoot)) {
        Write-Skip ("install root missing: " + $InstallRoot)
        return
    }
    $user = $env:USERNAME
    if (-not $user) {
        Write-Warn2 "USERNAME env var empty; refusing to run icacls with anonymous grantee."
        return
    }
    $grantSpec = ("{0}:(OI)(CI)F" -f $user)
    try {
        $out = & icacls $InstallRoot "/inheritance:r" "/grant:r" $grantSpec 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warn2 ("icacls returned " + $LASTEXITCODE + " - lockdown may be partial.")
            $out | ForEach-Object { Write-V $_ }
        } else {
            Write-OK ("ACL locked: " + $InstallRoot + " — only " + $user + " has access (inheritance broken)")
        }
    } catch {
        Write-Warn2 ("icacls failed: " + $_.Exception.Message)
    }
}

# ----------------------------------------------------------------------
# Step 6b: wake-up stubs (global CLAUDE.md + SYSTEM-MAP.md + MEMORY.md)
# ----------------------------------------------------------------------
function New-WakeUpStubs {
    Write-Step "5b. wake-up stubs (CLAUDE.md global + SYSTEM-MAP.md + MEMORY.md)"
    $pairs = @(
        @{ src = "templates\CLAUDE.md.example";    dst = (Join-Path $env:USERPROFILE ".claude\CLAUDE.md") },
        @{ src = "templates\SYSTEM-MAP.md.example"; dst = (Join-Path $InstallRoot "SYSTEM-MAP.md") },
        @{ src = "templates\MEMORY.md.example";     dst = (Join-Path $InstallRoot "MEMORY.md") }
    )
    foreach ($p in $pairs) {
        $srcPath = Join-Path $Script:RepoRoot $p.src
        if (-not (Test-Path $srcPath)) { Write-Warn2 ("template missing: " + $p.src); continue }
        if (Test-Path $p.dst) { Write-Skip ("kept existing " + $p.dst); continue }
        New-Item -ItemType Directory -Path (Split-Path $p.dst) -Force | Out-Null
        Copy-Item -LiteralPath $srcPath -Destination $p.dst -Force
        Write-OK ("seeded " + $p.dst)
    }
}

# ----------------------------------------------------------------------
# Step 6c: cockpit + personal + vault seeds
# ----------------------------------------------------------------------
function New-CockpitSeeds {
    Write-Step "5c. cockpit / personal / vault seeds"
    $seeds = @(
        @{ src = "templates\projects.empty.json"; dst = "cockpit\projects.json" },
        @{ src = "templates\apps.default.json";   dst = "cockpit\apps.json"     },
        @{ src = "templates\profile.template.md"; dst = "personal\profile.md"   },
        @{ src = "templates\known.empty.json";    dst = "personal\known.json"   }
    )
    foreach ($s in $seeds) {
        $srcPath = Join-Path $Script:RepoRoot $s.src
        $dstPath = Join-Path $InstallRoot $s.dst
        if (-not (Test-Path $srcPath)) { Write-Warn2 ("template missing: " + $s.src); continue }
        if (Test-Path $dstPath) { Write-Skip ("kept existing " + $dstPath); continue }
        New-Item -ItemType Directory -Path (Split-Path $dstPath) -Force | Out-Null
        Copy-Item -LiteralPath $srcPath -Destination $dstPath -Force
        Write-OK ("seeded " + $dstPath)
    }
    # Vault README — different root
    $vaultReadme = Join-Path $env:USERPROFILE ".ultron-vault\README.md"
    $vaultSrc = Join-Path $Script:RepoRoot "templates\VAULT-README.md"
    if ((Test-Path $vaultSrc) -and -not (Test-Path $vaultReadme)) {
        New-Item -ItemType Directory -Path (Split-Path $vaultReadme) -Force | Out-Null
        Copy-Item -LiteralPath $vaultSrc -Destination $vaultReadme -Force
        Write-OK ("seeded " + $vaultReadme)
    }
}

# ----------------------------------------------------------------------
# Step 7: hooks (merge into ~/.claude/settings.json)
# ----------------------------------------------------------------------
function Update-ClaudeSettings {
    Write-Step "7. Claude Code hooks"
    $tplPath = Join-Path $Script:RepoRoot "templates\settings-hooks.json"
    if (-not (Test-Path -LiteralPath $tplPath)) {
        Write-Warn2 ("hook template missing: " + $tplPath)
        return
    }
    $settingsDir  = Join-Path $env:USERPROFILE ".claude"
    $settingsPath = Join-Path $settingsDir "settings.json"

    if (-not (Test-Path -LiteralPath $settingsDir)) {
        New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
    }

    # Load + expand template
    try {
        $raw = Get-Content -LiteralPath $tplPath -Raw
        $userProfileFwd = $env:USERPROFILE -replace '\\', '/'
        $expanded = $raw -replace '\{USERPROFILE\}', $userProfileFwd
        $tpl = $expanded | ConvertFrom-Json
    } catch {
        Write-Warn2 ("could not parse " + $tplPath + ": " + $_.Exception.Message)
        return
    }

    # Load existing settings or seed
    if (Test-Path -LiteralPath $settingsPath) {
        # Backup
        $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $bak   = $settingsPath + ".bak-$stamp"
        try {
            Copy-Item -LiteralPath $settingsPath -Destination $bak -ErrorAction Stop
            Write-V ("backup -> " + $bak)
        } catch {
            Write-Warn2 ("could not backup settings.json: " + $_.Exception.Message)
        }
        try {
            $existing = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
        } catch {
            Write-Warn2 "existing settings.json is malformed; aborting hook merge."
            return
        }
    } else {
        $existing = [PSCustomObject]@{}
    }

    # Merge hooks: replace whole "hooks" object - safe because the template
    # IS the authoritative set ULTRON expects. We keep everything else.
    if (-not $existing.PSObject.Properties.Match('hooks').Count) {
        $existing | Add-Member -NotePropertyName "hooks" -NotePropertyValue $tpl.hooks
    } else {
        $existing.hooks = $tpl.hooks
    }

    # Atomic write via temp file
    try {
        $tmp = $settingsPath + ".tmp"
        ($existing | ConvertTo-Json -Depth 20) | Set-Content -LiteralPath $tmp -Encoding UTF8
        Move-Item -LiteralPath $tmp -Destination $settingsPath -Force
        Write-OK "settings.json hooks merged"
    } catch {
        Write-Fail ("could not write settings.json: " + $_.Exception.Message)
        return
    }
}

# ----------------------------------------------------------------------
# Step 8: skills picker
# ----------------------------------------------------------------------
function Install-Skills {
    Write-Step "8. skills picker"
    $manifestPath = Join-Path $Script:RepoRoot "templates\skills-manifest.example.yaml"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Write-Warn2 ("manifest missing: " + $manifestPath)
        return
    }

    # Tiny YAML reader: we only need name/core/personal/source/description.
    $entries = @()
    $current = $null
    foreach ($line in (Get-Content -LiteralPath $manifestPath)) {
        if ($line -match '^\s*- name:\s*(.+)$') {
            if ($current) { $entries += $current }
            $current = @{ name = $Matches[1].Trim(); core = $false; personal = $false; source = ""; description = "" }
        } elseif ($current) {
            if     ($line -match '^\s*core:\s*(true|false)\s*$')        { $current.core = ($Matches[1] -eq "true") }
            elseif ($line -match '^\s*personal:\s*(true|false)\s*$')    { $current.personal = ($Matches[1] -eq "true") }
            elseif ($line -match '^\s*source:\s*"?(.+?)"?\s*$')         { $current.source = $Matches[1].Trim() }
            elseif ($line -match '^\s*description:\s*"(.+)"\s*$')       { $current.description = $Matches[1] }
        }
    }
    if ($current) { $entries += $current }

    $targetRoot = Join-Path $env:USERPROFILE ".claude\skills"
    $installed  = 0
    $skipped    = 0

    foreach ($e in $entries) {
        $name = $e.name
        $dest = Join-Path $targetRoot $name
        $shouldInstall = $false
        if ($e.core) {
            $shouldInstall = $true
        } elseif ($e.personal) {
            $shouldInstall = Confirm-YesNo -Question ("install personal skill: $name -- " + $e.description) -Default $false
        }
        if (-not $shouldInstall) { $skipped++; continue }

        if (Test-Path -LiteralPath $dest) {
            Write-V ("$name already at $dest")
            $installed++
            continue
        }

        # repo:// means the SKILL.md lives in this repo
        if ($e.source -like "repo://*") {
            $rel = $e.source -replace '^repo://', ''
            $src = Join-Path $Script:RepoRoot $rel
            if (Test-Path -LiteralPath $src) {
                try {
                    Copy-Item -LiteralPath $src -Destination $dest -Recurse -Force
                    Write-V ("copied $rel -> $dest")
                    $installed++
                } catch {
                    Write-Warn2 ("could not install " + $name + ": " + $_.Exception.Message)
                }
            } else {
                Write-V ("repo source missing for $name : $src - skip")
                $skipped++
            }
        } elseif ($e.source -like "claude://*") {
            # Already-installed skills - just ensure dir exists; do not overwrite.
            Write-V ("claude:// skill $name - leaving user's local copy alone")
            $installed++
        }
    }
    Write-OK ("skills: $installed installed, $skipped skipped")
}

# ----------------------------------------------------------------------
# Step 8a': agents installer (v15.4.12)
# ----------------------------------------------------------------------
# Copies every agent shipped in the repo's `agents/` directory into
# `~/.claude/agents/`. Pre-existing destinations are left alone — the
# user's local edits win, the installer never overwrites.
#
# Why a dedicated step (and not part of Install-Skills): agents have
# their own taxonomy (`~/.claude/agents/<name>.md` flat layout) and the
# Agents tab + AI Router slot want them present at boot. The public repo
# ships NO `agents/` dir (community agents carry their own licenses), so
# a fresh clone copies nothing here and installs agents from the catalog
# (`cockpit/agent-catalog.json`) via the Agents tab instead. This step
# still copies any agent files a user drops into a local `agents/` dir.
function Install-Agents {
    Write-Step "8a'. agents (copy repo/agents -> ~/.claude/agents)"
    $src = Join-Path $Script:RepoRoot "agents"
    if (-not (Test-Path -LiteralPath $src)) {
        Write-Info "no bundled agents/ in repo - install agents from the Agents tab (Install from catalog) after first launch"
        return
    }
    $dest = Join-Path $env:USERPROFILE ".claude\agents"
    if (-not (Test-Path -LiteralPath $dest)) {
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
    }
    $installed = 0
    $skipped = 0
    foreach ($file in Get-ChildItem -LiteralPath $src -Filter "*.md" -File -ErrorAction SilentlyContinue) {
        $target = Join-Path $dest $file.Name
        if (Test-Path -LiteralPath $target) {
            $skipped++
            continue
        }
        try {
            Copy-Item -LiteralPath $file.FullName -Destination $target -Force
            $installed++
        } catch {
            Write-Warn2 ("could not install agent " + $file.Name + ": " + $_.Exception.Message)
        }
    }
    Write-OK ("agents: $installed installed, $skipped already present")
}

# ----------------------------------------------------------------------
# Step 8a''': skill sets from skills-catalog/ (v15.4.13)
# ----------------------------------------------------------------------
# Optional curated skill catalog. When a `skills-catalog/<category>/<name>/`
# tree with a manifest.json is present, the user picks which categories to
# install into `~/.claude/skills/<name>/`. The PUBLIC repo does NOT ship a
# skills-catalog/ (the curated set is large and not all of it is
# redistributable), so a fresh clone simply skips this step. The core skills
# a fresh install needs ship as plain `skills/<name>/SKILL.md` and via the
# skills picker (step 8).
function Install-SkillSets {
    Write-Step "8a'''. skill sets (skills-catalog -> ~/.claude/skills)"
    $catalog = Join-Path $Script:RepoRoot "skills-catalog"
    $manifestPath = Join-Path $catalog "manifest.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        Write-Info "no skills-catalog/ in repo - core skills install via the skills picker; skipping curated catalog"
        return
    }

    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Warn2 "skills-catalog manifest unreadable: $($_.Exception.Message)"
        return
    }

    $dest = Join-Path $env:USERPROFILE ".claude\skills"
    if (-not (Test-Path -LiteralPath $dest)) {
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
    }

    if ($NonInteractive) {
        Write-Info "non-interactive: skipping skill-set picker (use install.ps1 -Force interactively to pick)"
        return
    }

    $byCategory = $manifest.by_category
    if (-not $byCategory) {
        Write-V "manifest has no by_category map - skip"
        return
    }

    Write-Info "skill catalog: $($manifest.total_skills) skills across $($manifest.categories.Count) categories"
    Write-Info "(pick the sets you want. Skipped categories never touch ~/.claude/skills.)"

    $totalCopied = 0
    foreach ($cat in ($manifest.categories | Sort-Object)) {
        $count = $byCategory.$cat
        if (-not $count) { continue }
        $defaultPick = ($cat -eq "meta" -or $cat -eq "memory")
        $pick = Confirm-YesNo `
            -Question ("install '" + $cat + "' skill set (" + $count + " skills)") `
            -Default $defaultPick
        if (-not $pick) { continue }

        $catDir = Join-Path $catalog $cat
        if (-not (Test-Path -LiteralPath $catDir)) {
            Write-V "  $cat - source dir missing in repo, skip"
            continue
        }
        foreach ($skillDir in Get-ChildItem -LiteralPath $catDir -Directory -ErrorAction SilentlyContinue) {
            $target = Join-Path $dest $skillDir.Name
            if (Test-Path -LiteralPath $target) { continue }
            try {
                Copy-Item -LiteralPath $skillDir.FullName -Destination $target -Recurse -Force
                $totalCopied++
            } catch {
                Write-Warn2 ("could not copy " + $skillDir.Name + ": " + $_.Exception.Message)
            }
        }
        Write-V "  $cat - done"
    }
    Write-OK "skill sets: $totalCopied skills installed"
}

# ----------------------------------------------------------------------
# Step 8b: community skills from SkiTemplar/ultron-skills (optional)
# ----------------------------------------------------------------------
function Install-CommunitySkills {
    Write-Step "8b. community skills from SkiTemplar/ultron-skills (optional)"
    # Wizard wins over the legacy prompt. When no wizard ran, fall back
    # to asking on the command line just like before.
    $want = if ($Script:Selections.Count -gt 0) {
        Get-Choice -Id "cc_skills_comm" -Default $false
    } else {
        Confirm-YesNo -Question "Install curated community skills from ultron-skills repo?" -Default $false
    }
    if (-not $want) { Write-Skip "user declined"; return }
    if (-not (Get-Command "git" -ErrorAction SilentlyContinue)) {
        Write-Warn2 "git not on PATH; cannot clone ultron-skills"
        return
    }
    $skillsDest = Join-Path $env:USERPROFILE ".claude\skills"
    $tmp = Join-Path $env:TEMP "ultron-skills-clone"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    try {
        # --quiet suppresses git's progress prints to stderr (which PS strict
        # mode otherwise turns into terminating errors via the 2>&1 pipe).
        # We redirect stderr to a separate buffer so a clone failure surfaces
        # the real reason in the warn message instead of just the banner.
        $cloneErr = & git clone --quiet --depth 1 https://github.com/SkiTemplar/ultron-skills.git $tmp 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Warn2 ("clone failed (exit " + $LASTEXITCODE + "): " + ($cloneErr -join '; '))
            return
        }
        # Copy each skill that has SKILL.md, skip existing
        Get-ChildItem -Directory $tmp | ForEach-Object {
            $skill = $_.Name
            if ($skill -eq ".git") { return }
            $src = Join-Path $_.FullName "SKILL.md"
            $dst = Join-Path $skillsDest "$skill\SKILL.md"
            if ((Test-Path $src) -and -not (Test-Path $dst)) {
                New-Item -ItemType Directory -Path (Split-Path $dst) -Force | Out-Null
                Copy-Item -LiteralPath $src -Destination $dst -Force
                Write-V "copied $skill"
            }
        }
        Write-OK "community skills installed"
    } catch {
        Write-Warn2 ("community skills failed: " + $_.Exception.Message)
    } finally {
        if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
    }
}

# ----------------------------------------------------------------------
# Step 9: brain_index init
# ----------------------------------------------------------------------
# ----------------------------------------------------------------------
# Step 9b: ultron-memory sidecar (semantic recall daemon)
#
# The hooks and the Control Center look for ~/.ultron/bin/ultron-memory.exe.
# The prebuilt binary is gitignored, so a fresh clone does NOT ship it.
# Delegated to scripts/install-memory-sidecar.ps1 (download prebuilt release
# asset with SHA-256 check, else cargo build). Non-fatal on failure: hooks
# are fail-safe and recall degrades to sparse-only (FTS5) until it exists.
# ----------------------------------------------------------------------
function Install-MemorySidecar {
    Write-Step "9b. memory sidecar (ultron-memory.exe)"
    $script = Join-Path $Script:RepoRoot "scripts\install-memory-sidecar.ps1"
    if (-not (Test-Path -LiteralPath $script)) {
        Write-Skip "install-memory-sidecar.ps1 not in repo (older release?)"
        return
    }
    try {
        & $script -RepoRoot $Script:RepoRoot 2>&1 | ForEach-Object { Write-Info $_ }
        if ($LASTEXITCODE -eq 0) {
            Write-OK "ultron-memory sidecar deployed (semantic recall enabled)"
        } else {
            Write-Warn2 "sidecar not installed - recall degrades to sparse-only. Re-run scripts\install-memory-sidecar.ps1 later."
        }
    } catch {
        Write-Warn2 ("sidecar step failed: " + $_.Exception.Message)
    }
}

function Initialize-BrainIndex {
    Write-Step "9. brain_index init"
    $script = Join-Path $Script:RepoRoot "scripts\cockpit\brain_index.py"
    if (-not (Test-Path -LiteralPath $script)) {
        Write-Skip "brain_index.py not in repo (older release?)"
        return
    }
    if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
        Write-Warn2 "uv missing - skipping brain_index"
        return
    }
    # Check for empty vault first
    $vault = Join-Path $env:USERPROFILE ".ultron-vault"
    $vaultHasContent = $false
    try {
        $first = Get-ChildItem -LiteralPath $vault -Force -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($first) { $vaultHasContent = $true }
    } catch { }

    try {
        Push-Location $Script:RepoRoot
        if ($vaultHasContent) {
            Write-V "uv run python scripts/cockpit/brain_index.py build"
            & uv run python scripts\cockpit\brain_index.py build 2>&1 | ForEach-Object { Write-V $_ }
        } else {
            Write-V "vault empty - skipping initial embedding pass"
            # Still touch the DB so downstream code does not crash
            & uv run python -c "import sqlite3, pathlib; p = pathlib.Path.home()/'.ultron'/'brain_index'/'index.db'; p.parent.mkdir(parents=True, exist_ok=True); sqlite3.connect(str(p)).close()" 2>&1 | ForEach-Object { Write-V $_ }
        }
        Write-OK "brain_index initialized"
    } catch {
        Write-Warn2 ("brain_index init failed: " + $_.Exception.Message)
    } finally {
        Pop-Location
    }
}

# ----------------------------------------------------------------------
# Step 8c: optional feature toggles (writes ~/.ultron/cockpit/features.json)
#
# Asked interactively unless -NonInteractive. Each toggle:
#   news         -> off by default (Gemini tokens)
#   gaming       -> on
#   personal     -> on
#   schedules    -> on
#   self_improve -> on
# The Control Center reads this file at startup and gates tab visibility.
# Re-running install.ps1 keeps the previous answers — we never silently
# overwrite a user's choice without prompting.
# ----------------------------------------------------------------------
function Read-FeatureToggle {
    param(
        [string]$Name,
        [bool]$Default,
        [string]$Note
    )
    if ($NonInteractive) { return $Default }
    $defLabel = if ($Default) { "Y/n" } else { "y/N" }
    $line = "  " + $Name.PadRight(22) + "[" + $defLabel + "]"
    if ($Note) { $line += "  " + $Note }
    $resp = Read-Host $line
    if ($null -eq $resp) { $resp = "" }
    $resp = $resp.Trim().ToLower()
    if ($resp -eq "") { return $Default }
    if ($resp -in @("y", "yes")) { return $true }
    if ($resp -in @("n", "no"))  { return $false }
    return $Default
}

# ----------------------------------------------------------------------
# Step 8d: physically remove files for opted-out features.
#
# v15.3.5: the wizard checkboxes used to be purely cosmetic — the
# install pipeline ran every step unconditionally because they were
# "cheap on re-run". That meant unchecking News in the wizard still
# shipped news_html_generator.py + news_alerts.py + cockpit/news/ to
# the user's machine. People who wanted a minimal install (no
# Gemini tokens, no daily newsletter) ended up carrying the files
# anyway.
#
# This step is the authoritative "minimal install" enforcer. For each
# optional feature the user UNCHECKED in the wizard, we delete the
# corresponding files from ~/.ultron/scripts/cockpit/ (and any sibling
# data dirs). The Features tab in the desktop app only toggles
# *visibility* — it cannot uninstall code. The decision to NOT install
# an optional feature must be made in the wizard.
#
# Guarantees:
#   - Core stuff (skills, agents, hooks, brain_index, qdrant) is NEVER
#     touched by this step.
#   - Skipped when the wizard did not run (CLI / NonInteractive / Force)
#     so legacy automated installs never lose files.
#   - Idempotent: re-running with the same selections is a no-op.
# ----------------------------------------------------------------------
function Remove-OptOutFeatureFiles {
    Write-Step "8d. opt-out cleanup (purge files for unchecked wizard features)"
    if ($Script:Selections.Count -eq 0) {
        Write-Skip "wizard did not run - keeping all optional feature files"
        return
    }

    # Manifest: id -> list of repo-relative paths to remove if id == false.
    # Paths are interpreted under $Script:RepoRoot. Missing files are silent;
    # never throw. ONLY optional feature code — never core (skills, agents,
    # hooks, brain_index, qdrant).
    $optOutManifest = @{
        feat_gaming = @(
            "scripts\cockpit\game_detector.py",
            "scripts\cockpit\gaming-enum.ps1"
        )
        feat_schedules = @(
            "scripts\cockpit\install-scheduler.ps1"
        )
        feat_notifications = @(
            "scripts\qdrant\qdrant-notify.ps1"
        )
        feat_usage = @(
            "scripts\cockpit\usage_report.py",
            "scripts\cockpit\token_baseline.py",
            "scripts\cockpit\token_budget.py"
        )
        feat_sessions = @(
            "scripts\cockpit\session_compactor.py",
            "scripts\cockpit\session_highlights.py",
            "scripts\cockpit\session_replay.py"
        )
        feat_project = @(
            "scripts\cockpit\project_editor.py",
            "scripts\cockpit\project_notes.py",
            "scripts\cockpit\launch_project.py",
            "scripts\cockpit\scan_projects.py"
        )
        feat_plans = @(
            "scripts\cockpit\plans_cli.py"
        )
    }

    $purgedTotal = 0
    $keptTotal   = 0
    foreach ($id in $optOutManifest.Keys) {
        # Default $true means: when a wizard ran but did not stamp this id
        # for any reason, keep the files (the safe choice). The Catalog in
        # install-wizard.ps1 always stamps these ids though.
        $picked = Get-Choice -Id $id -Default $true
        if ($picked) {
            Write-V ("keeping " + $id + " files (selected in wizard)")
            $keptTotal += $optOutManifest[$id].Count
            continue
        }
        Write-Info ($id + " unchecked - purging " + $optOutManifest[$id].Count + " file(s)/dir(s)")
        foreach ($rel in $optOutManifest[$id]) {
            $full = Join-Path $Script:RepoRoot $rel
            if (-not (Test-Path -LiteralPath $full)) {
                Write-V ("  (already absent) " + $rel)
                continue
            }
            try {
                if ((Get-Item -LiteralPath $full).PSIsContainer) {
                    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction Stop
                } else {
                    Remove-Item -LiteralPath $full -Force -ErrorAction Stop
                }
                Write-V ("  purged " + $rel)
                $purgedTotal++
            } catch {
                Write-Warn2 ("could not remove " + $rel + ": " + $_.Exception.Message)
            }
        }
    }
    Write-OK ("opt-out cleanup: " + $purgedTotal + " purged, " + $keptTotal + " kept")
}

function Set-FeatureFlags {
    Write-Step "8c. optional feature toggles"
    $cockpitDir = Join-Path $env:USERPROFILE ".ultron\cockpit"
    if (-not (Test-Path -LiteralPath $cockpitDir)) {
        New-Item -ItemType Directory -Path $cockpitDir -Force | Out-Null
    }
    $featuresFile = Join-Path $cockpitDir "features.json"

    # Read previous answers as the defaults; falls back to baseline values
    # the first time around.
    $defaults = [ordered]@{
        gaming        = $true
        personal      = $true
        schedules     = $true
        self_improve  = $true
        notifications = $true
        usage         = $false  # off by default — only useful when on paid plan
        sessions      = $true
        projects      = $true   # plural — matches Rust Features struct + sidebar key
        plans         = $false  # off by default — power-user feature
    }
    if (Test-Path -LiteralPath $featuresFile) {
        try {
            $prev = Get-Content -LiteralPath $featuresFile -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($k in $defaults.Keys) {
                if ($null -ne $prev.$k) { $defaults[$k] = [bool]$prev.$k }
            }
        } catch {
            # corrupt JSON — fall back to baseline.
        }
    }

    # If the wizard ran, its checkboxes have already answered every
    # toggle. Skip the CLI re-prompt entirely and just write the file.
    if ($Script:Selections.Count -gt 0) {
        Write-Info "applying selections from the visual wizard"
        $features = [ordered]@{
            gaming        = Get-Choice -Id "feat_gaming"        -Default $defaults.gaming
            personal      = Get-Choice -Id "feat_personal"      -Default $defaults.personal
            schedules     = Get-Choice -Id "feat_schedules"     -Default $defaults.schedules
            self_improve  = Get-Choice -Id "feat_selfimp"       -Default $defaults.self_improve
            notifications = Get-Choice -Id "feat_notifications" -Default $defaults.notifications
            usage         = Get-Choice -Id "feat_usage"         -Default $defaults.usage
            sessions      = Get-Choice -Id "feat_sessions"      -Default $defaults.sessions
            # NB: the Rust `Features` struct field is `projects` (plural). The
            # wizard checkbox id stays `feat_project` (legacy), but the key
            # written to features.json MUST be `projects` so the sidebar's
            # featureKey="projects" gate resolves correctly.
            projects      = Get-Choice -Id "feat_project"       -Default $defaults.projects
            plans         = Get-Choice -Id "feat_plans"         -Default $defaults.plans
        }
    } else {
        if ($NonInteractive) {
            Write-Info "non-interactive: keeping existing features.json (or defaults if new)"
        } else {
            Write-Info "Enable optional features? Press Enter to accept the default."
        }
        $features = [ordered]@{
            gaming        = Read-FeatureToggle -Name "Gaming utilities" -Default $defaults.gaming        -Note "game detector + tweaks panel"
            personal      = Read-FeatureToggle -Name "Personal section" -Default $defaults.personal      -Note "private profile slots in the cockpit"
            schedules     = Read-FeatureToggle -Name "Schedules"        -Default $defaults.schedules     -Note "Windows scheduled-task management"
            self_improve  = Read-FeatureToggle -Name "Self-improve"     -Default $defaults.self_improve  -Note "route telemetry feeds the dispatcher tuner"
            notifications = Read-FeatureToggle -Name "Notifications"    -Default $defaults.notifications -Note "toast/tray alerts + pending-actions panel"
            usage         = Read-FeatureToggle -Name "Usage tracking"   -Default $defaults.usage         -Note "token budget + /usage cache (Anthropic API only)"
            sessions      = Read-FeatureToggle -Name "Sessions archive" -Default $defaults.sessions      -Note "session replay + highlights + compactor"
            projects      = Read-FeatureToggle -Name "Project manager"  -Default $defaults.projects      -Note "project editor + scan + notes panel"
            plans         = Read-FeatureToggle -Name "Plans & goals"    -Default $defaults.plans         -Note "lifecycle open -> in-progress -> resolved"
        }
    }

    try {
        ($features | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $featuresFile -Encoding UTF8
        Write-OK ("features.json -> " + $featuresFile)
    } catch {
        Write-Warn2 ("could not write features.json: " + $_.Exception.Message)
    }
}

# ----------------------------------------------------------------------
# Step 9b: git hooks (post-commit auto-changelog, etc.)
#
# Git hooks under .git/hooks/ are NOT versioned. We keep canonical copies
# in git-hooks/ at the repo root and let setup-git-hooks.ps1 copy them
# into the local clone. This is what guarantees CHANGELOG.md updates
# after every commit instead of only at Stop hook time.
# ----------------------------------------------------------------------
function Install-GitHooks {
    Write-Step "9b. git hooks (post-commit auto-changelog)"
    $setup = Join-Path $Script:RepoRoot "scripts\setup-git-hooks.ps1"
    if (-not (Test-Path -LiteralPath $setup)) {
        Write-Skip "setup-git-hooks.ps1 not in repo (older release?)"
        return
    }
    try {
        & $setup -Quiet
        if ($LASTEXITCODE -eq 0) {
            Write-OK "post-commit hook installed"
        } else {
            Write-Warn2 "setup-git-hooks.ps1 exited $LASTEXITCODE"
        }
    } catch {
        Write-Warn2 ("git hooks setup failed: " + $_.Exception.Message)
    }
}

# ----------------------------------------------------------------------
# Step 10: control-center build (npm install inline as of v15.5.14)
# ----------------------------------------------------------------------
# Sync Python venv via uv. Runs ALWAYS (even with -NoApp) because the
# hooks under ~/.claude/settings.json depend on ~/.ultron/.venv/Scripts/python.exe.
# If we only ran this from Build-ControlCenter, -NoApp users would end up
# with hooks pointing at a missing interpreter and every Claude session
# would fail silently.
function Initialize-PythonVenv {
    Write-Step "6. python venv (uv sync — required for hooks)"
    if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
        Write-Warn2 "uv not on PATH; cannot create venv. Hooks will fail."
        return
    }
    $pyproject = Join-Path $Script:RepoRoot "pyproject.toml"
    if (-not (Test-Path -LiteralPath $pyproject)) {
        Write-Skip "pyproject.toml missing; skipping uv sync"
        return
    }
    # uv writes progress info to stderr ("Resolved N packages..."). With
    # $ErrorActionPreference = "Stop" active at script scope, those stderr
    # lines become terminating errors as soon as 2>&1 surfaces them — the
    # try/catch fires BEFORE we ever get to check $LASTEXITCODE, so a
    # successful run still landed in the catch as "uv sync failed: Resolved
    # 98 packages". The fix is to relax ErrorActionPreference just for the
    # native-command call.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        Push-Location $Script:RepoRoot
        $uvOut = & uv sync 2>&1
        $code = $LASTEXITCODE
        if ($code -eq 0) {
            Write-OK "venv ready at .venv"
            if ($Script:VerboseOn -and $uvOut) {
                $uvOut | ForEach-Object { Write-V $_ }
            }
        } else {
            Write-Warn2 ("uv sync exited " + $code + ": " + ($uvOut -join '; '))
        }
    } catch {
        Write-Warn2 ("uv sync failed: " + $_.Exception.Message)
    } finally {
        Pop-Location
        $ErrorActionPreference = $prevEAP
    }
}

function Build-ControlCenter {
    Write-Step "10. control-center (npm install + optional Tauri build)"
    if ($NoApp) { Write-Skip "skipped via -NoApp"; return }
    # Wizard veto: if both UI checkboxes are off, skip this step entirely.
    # Get-Choice returns the legacy default ($false for ui_*) when the
    # wizard did not run, so CLI mode keeps the historical "ask first"
    # behaviour for the Tauri build prompt below.
    if ($Script:Selections.Count -gt 0) {
        $wantNpm = Get-Choice -Id "ui_npm" -Default $false
        $wantBld = Get-Choice -Id "ui_tauri_build" -Default $false
        if (-not ($wantNpm -or $wantBld)) {
            Write-Skip "Control Center unchecked in wizard - keeping repo as source-only"
            return
        }
    }

    # v15.5.14: inlined npm install (was a delegate call to scripts/install.ps1,
    # a 552-line legacy duplicate moved to _legacy/install-pre-v15.4.ps1 in
    # the same release — see ROUND2-POLISH report). The delegate only existed
    # to wrap `npm install` in the control-center directory, which is two
    # lines. Initialize-PythonVenv already provisioned the venv in step 6,
    # so no -SkipUvSync gymnastics needed here.
    $ccDir = Join-Path $Script:RepoRoot "control-center"
    if (-not (Test-Path -LiteralPath $ccDir)) {
        Write-Warn2 "control-center/ not found - skipping npm install"
        return
    }
    if (-not (Get-Command "npm" -ErrorAction SilentlyContinue)) {
        Write-Warn2 "npm not on PATH - skipping Control Center install"
        return
    }
    # Native binaries (npm, cargo, tauri) write progress to stderr. With
    # $ErrorActionPreference = "Stop" at script scope, the first stderr line
    # converts into a terminating error before we ever read $LASTEXITCODE.
    # Relax EAP for the npm call only.
    $prevEAP = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        Push-Location $ccDir
        $npmOut = & npm install 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-OK "npm install completed (control-center/)"
            if ($Script:VerboseOn -and $npmOut) {
                $npmOut | ForEach-Object { Write-V $_ }
            }
        } else {
            Write-Warn2 ("npm install exited " + $LASTEXITCODE + ": " + ($npmOut -join '; '))
        }
    } catch {
        Write-Warn2 ("npm install failed: " + $_.Exception.Message)
    } finally {
        Pop-Location
        $ErrorActionPreference = $prevEAP
    }

    # Optional Tauri build (cost-heavy - opt-in). Wizard wins.
    $doBuild = if ($Script:Selections.Count -gt 0) {
        Get-Choice -Id "ui_tauri_build" -Default $false
    } else {
        Confirm-YesNo -Question "Compile Tauri binary now? (takes several minutes)" -Default $false
    }
    if ($doBuild) {
        $cc = Join-Path $Script:RepoRoot "control-center"
        if (-not (Test-Path -LiteralPath $cc)) { Write-Skip "control-center/ missing"; return }
        # Same stderr-becomes-fatal trap as the delegate call above. Tauri
        # prints "Info Looking up installed tauri packages..." to stderr,
        # which would otherwise abort the build before npm even kicks off.
        $prevEAP2 = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            Push-Location $cc
            & npm run tauri build
            if ($LASTEXITCODE -eq 0) {
                Write-OK "tauri build done. Look in src-tauri/target/release/bundle/"
            } else {
                Write-Warn2 "tauri build exited $LASTEXITCODE"
            }
        } finally {
            Pop-Location
            $ErrorActionPreference = $prevEAP2
        }
    } else {
        Write-Skip "tauri build (run 'npm run tauri build' later)"
    }
}

# ----------------------------------------------------------------------
# Step 11: doctor verification
# ----------------------------------------------------------------------
function Invoke-Doctor {
    Write-Step "11. verification (doctor.py)"
    $doctor = Join-Path $Script:RepoRoot "scripts\cockpit\doctor.py"
    if (-not (Test-Path -LiteralPath $doctor)) {
        Write-Skip "doctor.py not present"
        return
    }
    if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
        Write-Skip "uv missing - cannot run doctor"
        return
    }
    try {
        Push-Location $Script:RepoRoot
        & uv run python scripts\cockpit\doctor.py 2>&1 | ForEach-Object {
            Write-Host ("        " + $_)
        }
        $code = $LASTEXITCODE
        if     ($code -eq 0) { Write-OK    "doctor: clean" }
        elseif ($code -eq 1) { Write-Warn2 "doctor: warnings (non-fatal)" }
        elseif ($code -eq 2) { Write-Fail  "doctor: blocking findings" }
        else                 { Write-Warn2 "doctor: exit $code" }
    } catch {
        Write-Warn2 ("doctor failed: " + $_.Exception.Message)
    } finally {
        Pop-Location
    }
}

# ----------------------------------------------------------------------
# Final summary
# ----------------------------------------------------------------------
function Write-Summary {
    Write-Host ""
    Write-Host "======================================================="
    Write-Host " ULTRON install summary"
    Write-Host "======================================================="
    Write-Host (" install root : " + $InstallRoot)
    Write-Host (" repo root    : " + $Script:RepoRoot)
    Write-Host (" steps ok     : " + $Script:StepsOK.Count)
    Write-Host (" steps skipped: " + $Script:StepsSkipped.Count)
    Write-Host (" warnings     : " + $Script:Warnings.Count)
    Write-Host (" errors       : " + $Script:Errors.Count)
    if ($Script:Warnings.Count -gt 0) {
        Write-Host ""
        Write-Host " warnings:"
        foreach ($w in $Script:Warnings) { Write-Host ("   - " + $w) }
    }
    if ($Script:Errors.Count -gt 0) {
        Write-Host ""
        Write-Host " errors:"
        foreach ($e in $Script:Errors) { Write-Host ("   - " + $e) }
    }
    Write-Host ""
    Write-Host " next steps:"
    Write-Host "   cd $Script:RepoRoot\control-center"
    Write-Host "   npx tauri dev               # run desktop app"
    Write-Host "   claude                      # start a Claude session"
    Write-Host "======================================================="
}

# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------
try {
    Write-Banner
    Show-InstallWizard
    Test-Preflight
    Test-OrInstall-Git    | Out-Null
    Test-OrInstall-Node   | Out-Null
    Test-ClaudeCode
    Test-OrInstall-Uv
    Test-OrInstall-Rust   | Out-Null
    # Qdrant — native Windows binary, no Docker needed. Semantic recall is
    # a core ULTRON capability; the installer fetches the official release
    # zip if `~/.ultron/qdrant-native/qdrant.exe` is missing.
    Install-QdrantNative
    New-DirectoryLayout
    Set-InstallRootAcl
    New-WakeUpStubs
    New-CockpitSeeds
    Initialize-PythonVenv
    Update-ClaudeSettings
    Install-Skills
    Install-Agents
    Install-SkillSets
    Install-CommunitySkills
    Set-FeatureFlags
    Remove-OptOutFeatureFiles
    Initialize-BrainIndex
    Install-MemorySidecar
    Install-GitHooks
    Build-ControlCenter
    Invoke-Doctor
    Write-Summary
    if ($Script:Errors.Count -gt 0) { exit 1 } else { exit 0 }
} catch {
    Write-Host ""
    Write-Host ("INSTALL ABORTED: " + $_.Exception.Message)
    if ($Script:VerboseOn) { Write-Host $_.ScriptStackTrace }
    Write-Host ""
    Write-Host "See $Script:RepoRoot\INSTALL.md for manual steps."
    exit 2
}
