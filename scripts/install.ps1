<#
.SYNOPSIS
  ULTRON v15.2 bootstrap installer (Windows / PowerShell).

.DESCRIPTION
  One-shot, idempotent installer for the ULTRON project. Validates host,
  checks dependencies (without installing them), provisions the
  ~/.ultron/ directory tree, runs `uv sync` and `npm install`, and asks
  the user which optional features to enable. Writes the user's choices
  to ~/.ultron/cockpit/features.json so the desktop app can read them.

  Hard rules honored:
    - No admin / UAC elevation needed.
    - No external API keys requested.
    - Re-running is safe (idempotent).
    - Uses $env:USERPROFILE - never hardcodes any specific user home path.
    - Every step prints a pre line ("checking X...") and a post line
      ("X: ok" or "X: missing - <link>").
    - On hard failure, prints the offending command, a suggested fix,
      and exits with a non-zero code.

.PARAMETER NonInteractive
  Skip the feature-toggle prompts and accept defaults (CI mode).

.PARAMETER InstallRoot
  Override the install root. Defaults to "$env:USERPROFILE\.ultron".

.NOTES
  TODO (Rust side, OUT OF SCOPE for this installer):
    The desktop app (control-center/src-tauri) should read
    `~/.ultron/cockpit/features.json` at startup and gate menu / tab
    visibility accordingly. Suggested stub:

        // src-tauri/src/features.rs
        #[derive(Deserialize, Default)]
        pub struct Features {
            pub news: bool,
            pub gaming: bool,
            pub personal: bool,
            pub schedules: bool,
            pub self_improve: bool,
        }
        pub fn load_features() -> Features {
            let path = dirs::home_dir()
                .map(|h| h.join(".ultron/cockpit/features.json"));
            // serde_json::from_reader, fall back to Features::default()
        }

    Then the React side calls a Tauri command `get_features()` and
    conditionally renders each tab. The installer here is only
    responsible for producing the JSON file.
#>

[CmdletBinding()]
param(
    [switch]$NonInteractive,
    # The outer installer (install.ps1 at repo root) already runs uv sync in
    # its step 6 (Initialize-PythonVenv). When it delegates the npm install
    # part to this inner script it passes -SkipUvSync so we don't double-run
    # the sync — that second pass often hits Windows file locks on the
    # freshly populated .venv (Acceso denegado on cffi / cryptography).
    [switch]$SkipUvSync,
    [string]$InstallRoot = (Join-Path $env:USERPROFILE ".ultron")
)

# Strict mode - fail on undefined vars / non-terminating errors we did not catch.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------------
# Constants
# ----------------------------------------------------------------------
$Script:Version = "v15.2.0"
$Script:RepoRoot = Split-Path -Parent $PSScriptRoot
$Script:Warnings = New-Object System.Collections.Generic.List[string]
$Script:Errors   = New-Object System.Collections.Generic.List[string]

# ----------------------------------------------------------------------
# Logging helpers - plain text, no emoji, no color codes the user might
# pipe somewhere awkward. Use Write-Host so output isn't captured.
# ----------------------------------------------------------------------
function Write-Step    { param([string]$Msg) Write-Host ("[ STEP ] " + $Msg) }
function Write-Check   { param([string]$Msg) Write-Host ("checking " + $Msg + "...") }
function Write-Ok      { param([string]$Msg) Write-Host ("  ok    " + $Msg) }
function Write-WarnRow { param([string]$Msg) Write-Host ("  warn  " + $Msg); $Script:Warnings.Add($Msg) }
function Write-FailRow { param([string]$Msg) Write-Host ("  fail  " + $Msg); $Script:Errors.Add($Msg) }
function Write-Info    { param([string]$Msg) Write-Host ("        " + $Msg) }
function Write-Banner {
    Write-Host ""
    Write-Host "======================================================="
    Write-Host (" ULTRON installer " + $Script:Version)
    Write-Host " https://github.com/SkiTemplar/ultron"
    Write-Host "======================================================="
    Write-Host ""
}

function Stop-WithFix {
    param(
        [string]$Stage,
        [string]$Command,
        [string]$Fix
    )
    Write-Host ""
    Write-Host ("INSTALL FAILED at stage: " + $Stage)
    Write-Host ("  command : " + $Command)
    Write-Host ("  fix     : " + $Fix)
    Write-Host ""
    exit 1
}

# ----------------------------------------------------------------------
# Version detection - package.json -> control-center/package.json -> fallback
# ----------------------------------------------------------------------
function Get-ProjectVersion {
    $candidates = @(
        (Join-Path $Script:RepoRoot "package.json"),
        (Join-Path $Script:RepoRoot "control-center\package.json")
    )
    foreach ($p in $candidates) {
        if (Test-Path -LiteralPath $p) {
            try {
                $json = Get-Content -LiteralPath $p -Raw | ConvertFrom-Json
                if ($json.version) { return ("v" + $json.version) }
            } catch {
                # Ignore - try next.
            }
        }
    }
    return $Script:Version
}

# ----------------------------------------------------------------------
# Preflight: OS / shell / network.
# ----------------------------------------------------------------------
function Test-Preflight {
    Write-Step "preflight"

    Write-Check "host OS"
    # $IsWindows is only defined in PowerShell 6+. In Windows PowerShell 5.1
    # the automatic variable does not exist, and Set-StrictMode -Version
    # Latest turns plain access into a parser-level error. Use a strict-mode
    # safe probe instead: Get-Variable returns $null when the variable is
    # missing, and `[System.Environment]::OSVersion.Platform` is universally
    # available.
    $isWindowsHost = $true
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $isWinVar = Get-Variable -Name IsWindows -ErrorAction SilentlyContinue
        if ($isWinVar) {
            $isWindowsHost = [bool]$isWinVar.Value
        } else {
            $isWindowsHost = ([System.Environment]::OSVersion.Platform -eq 'Win32NT')
        }
    }
    if (-not $isWindowsHost) {
        Write-FailRow "non-Windows host detected"
        Write-Info  "use scripts/install.sh on Linux / macOS instead."
        Stop-WithFix -Stage "preflight" `
                     -Command "scripts/install.ps1" `
                     -Fix     "Run scripts/install.sh on this platform."
    }
    Write-Ok "Windows host"

    Write-Check "PowerShell version"
    $psMajor = $PSVersionTable.PSVersion.Major
    if ($psMajor -lt 5) {
        Write-FailRow ("PowerShell " + $PSVersionTable.PSVersion + " is too old")
        Stop-WithFix -Stage "preflight" `
                     -Command ("`$PSVersionTable.PSVersion = " + $PSVersionTable.PSVersion) `
                     -Fix     "Install PowerShell 5.1+ (Windows built-in) or 7+ (https://aka.ms/powershell)."
    }
    Write-Ok ("PowerShell " + $PSVersionTable.PSVersion)

    Write-Check "internet reachability"
    try {
        $null = Test-Connection -ComputerName "github.com" -Count 1 -Quiet -ErrorAction Stop
        Write-Ok "github.com reachable"
    } catch {
        Write-WarnRow "could not reach github.com - uv sync / npm install may fail"
    }
}

# ----------------------------------------------------------------------
# Dependency probe - warn only, never auto-install.
# ----------------------------------------------------------------------
function Test-Command {
    param(
        [string]$Name,
        [string]$Probe,
        [string]$Link,
        [switch]$Optional
    )
    Write-Check $Name
    $cmdInfo = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmdInfo) {
        if ($Optional) {
            Write-WarnRow ($Name + ": missing (optional) - " + $Link)
        } else {
            Write-FailRow ($Name + ": missing - " + $Link)
        }
        return $null
    }
    try {
        # Use Start-Process style invocation via call operator with stdout capture.
        $ver = (& $Name $Probe 2>$null | Select-Object -First 1)
        if (-not $ver) { $ver = "(version not reported)" }
        Write-Ok ($Name + " " + $ver)
        return $ver
    } catch {
        Write-WarnRow ($Name + ": found but failed to report version (" + $_.Exception.Message + ")")
        return ""
    }
}

function Test-Dependencies {
    Write-Step "dependencies (warn-only - installer will not auto-install)"

    Test-Command -Name "rustc"  -Probe "--version" -Link "https://rustup.rs"                                       | Out-Null
    $nodeVer = Test-Command -Name "node" -Probe "--version" -Link "https://nodejs.org"
    if ($nodeVer) {
        # Node prints "v22.4.1" - pull the major.
        if ($nodeVer -match "v(\d+)\.") {
            $major = [int]$Matches[1]
            if ($major -lt 22) {
                Write-WarnRow ("node " + $nodeVer + " is older than v22 - control-center expects v22+")
            }
        }
    }
    Test-Command -Name "uv"     -Probe "--version" -Link "https://docs.astral.sh/uv"                               | Out-Null
    Test-Command -Name "claude" -Probe "--version" -Link "https://docs.claude.com/en/docs/claude-code"             | Out-Null

    # Optional CLIs - do not flag as errors.
    Test-Command -Name "codex"  -Probe "--version" -Link "https://github.com/openai/codex"             -Optional | Out-Null
    Test-Command -Name "gemini" -Probe "--version" -Link "https://github.com/google-gemini/gemini-cli" -Optional | Out-Null

    if ($Script:Errors.Count -gt 0) {
        Write-Host ""
        Write-Host "Required dependencies missing:"
        foreach ($e in $Script:Errors) { Write-Host ("  - " + $e) }
        Stop-WithFix -Stage "dependencies" `
                     -Command "(see list above)" `
                     -Fix     "Install the missing tools using the links printed, then re-run scripts/install.ps1."
    }
}

# ----------------------------------------------------------------------
# Directory tree - idempotent. Honors $InstallRoot.
# ----------------------------------------------------------------------
function New-DirTree {
    Write-Step ("provisioning directory tree at " + $InstallRoot)

    $dirs = @(
        $InstallRoot,
        (Join-Path $InstallRoot "cockpit"),
        (Join-Path $InstallRoot "plans"),
        (Join-Path $InstallRoot "skills"),
        (Join-Path $InstallRoot "scripts"),
        (Join-Path $InstallRoot "brain_index"),
        (Join-Path $InstallRoot ".tmp"),
        (Join-Path $InstallRoot "personal")
    )
    foreach ($d in $dirs) {
        Write-Check ("dir " + $d)
        if (Test-Path -LiteralPath $d) {
            Write-Ok "exists"
        } else {
            try {
                New-Item -ItemType Directory -Path $d -Force | Out-Null
                Write-Ok "created"
            } catch {
                Stop-WithFix -Stage "dirtree" `
                             -Command ("New-Item -ItemType Directory -Path '" + $d + "'") `
                             -Fix     "Ensure your user has write access to the parent path."
            }
        }
    }
}

# ----------------------------------------------------------------------
# Claude skills wiring.
#   - If ~/.claude/skills already exists, leave it alone.
#   - Else create an empty directory so the desktop app does not crash
#     looking it up. We do NOT symlink across users - symlinks on
#     Windows can trigger UAC and we promised no elevation.
# ----------------------------------------------------------------------
function Initialize-ClaudeSkills {
    Write-Step "wiring ~/.claude/skills"

    $claudeRoot   = Join-Path $env:USERPROFILE ".claude"
    $skillsRoot   = Join-Path $claudeRoot "skills"

    Write-Check $skillsRoot
    if (Test-Path -LiteralPath $skillsRoot) {
        Write-Ok "existing skills dir - leaving untouched"
        return
    }
    if (-not (Test-Path -LiteralPath $claudeRoot)) {
        try {
            New-Item -ItemType Directory -Path $claudeRoot -Force | Out-Null
        } catch {
            Stop-WithFix -Stage "claude-skills" `
                         -Command ("New-Item -ItemType Directory -Path '" + $claudeRoot + "'") `
                         -Fix     "Ensure your user can write to $env:USERPROFILE."
        }
    }
    try {
        New-Item -ItemType Directory -Path $skillsRoot -Force | Out-Null
        Write-Ok "created empty skills dir"
    } catch {
        Stop-WithFix -Stage "claude-skills" `
                     -Command ("New-Item -ItemType Directory -Path '" + $skillsRoot + "'") `
                     -Fix     "Create $skillsRoot manually."
    }
}

# ----------------------------------------------------------------------
# uv sync - Python deps.
# ----------------------------------------------------------------------
function Invoke-UvSync {
    Write-Step ("uv sync in " + $Script:RepoRoot)

    Write-Check "uv on PATH"
    if (-not (Get-Command "uv" -ErrorAction SilentlyContinue)) {
        Stop-WithFix -Stage "uv-sync" `
                     -Command "uv sync" `
                     -Fix     "Install uv from https://docs.astral.sh/uv and re-run."
    }
    Write-Ok "uv available"

    # The outer installer (install.ps1 at repo root) already runs uv sync in
    # step 6. If that succeeded, the .venv is up to date and this second
    # pass is redundant — sometimes harmful: on Windows the freshly
    # populated site-packages can still hold open file handles (Defender
    # scan, qdrant.exe child, lingering python.exe from the outer pass),
    # which makes uv's reinstall-style overwrite hit "Acceso denegado" on
    # cffi / cryptography / etc. We detect that case and skip cleanly.
    $venvPy = Join-Path $Script:RepoRoot ".venv\Scripts\python.exe"
    $venvAlreadyHealthy = Test-Path -LiteralPath $venvPy

    try {
        Push-Location $Script:RepoRoot
        $uvOut = & uv sync 2>&1
        if ($LASTEXITCODE -eq 0) {
            Write-Ok "python venv synced"
            return
        }

        # Non-zero exit. If the venv is already healthy, treat as a
        # warning and proceed — the outer installer's sync did the real work.
        $joined = ($uvOut -join "`n")
        $isAccessDenied = ($joined -match "Acceso denegado") -or ($joined -match "Access is denied") -or ($joined -match "os error 5")
        if ($venvAlreadyHealthy -and $isAccessDenied) {
            Write-WarnRow "uv sync hit a Windows file lock on the already-populated .venv — skipping the inner pass."
            Write-Info  "The outer installer's earlier uv sync already provisioned the venv. If hooks misbehave, close Claude Code + qdrant.exe, then run 'uv sync' manually."
            return
        }

        # Real failure — surface the actual reason.
        if ($joined) {
            Write-Info ("uv output: " + $joined)
        }
        Stop-WithFix -Stage "uv-sync" `
                     -Command "uv sync" `
                     -Fix     "Inspect the uv output above. Common cause: Python version mismatch - pyproject.toml requires Python >=3.12."
    } finally {
        Pop-Location
    }
}

# ----------------------------------------------------------------------
# npm install for control-center.
# ----------------------------------------------------------------------
function Invoke-NpmInstall {
    $cc = Join-Path $Script:RepoRoot "control-center"
    Write-Step ("npm install in " + $cc)

    Write-Check "control-center/ exists"
    if (-not (Test-Path -LiteralPath $cc)) {
        Write-WarnRow "control-center/ missing - skipping npm install"
        return
    }
    Write-Ok "found"

    Write-Check "npm on PATH"
    if (-not (Get-Command "npm" -ErrorAction SilentlyContinue)) {
        Stop-WithFix -Stage "npm-install" `
                     -Command "npm install" `
                     -Fix     "Install Node 22+ from https://nodejs.org (npm ships with it)."
    }
    Write-Ok "npm available"

    try {
        Push-Location $cc
        & npm install
        if ($LASTEXITCODE -ne 0) {
            Stop-WithFix -Stage "npm-install" `
                         -Command "npm install (in control-center/)" `
                         -Fix     "Delete control-center/node_modules and control-center/package-lock.json, then re-run."
        }
        Write-Ok "node modules installed"
    } finally {
        Pop-Location
    }
}

# ----------------------------------------------------------------------
# Feature toggles. Default policy:
#   news        -> NO   (costs Gemini tokens)
#   gaming      -> YES
#   personal    -> YES
#   schedules   -> YES
#   self_improve-> YES
#
# Prompt UX: pressing Enter accepts the printed default. Typing y / Y / yes
# forces ON; typing n / N / no forces OFF. Anything else re-prompts once,
# then falls back to the default.
# ----------------------------------------------------------------------
function Read-FeatureToggle {
    param(
        [string]$Name,
        [bool]$Default,
        [string]$Note
    )
    if ($NonInteractive) { return $Default }

    $defLabel = if ($Default) { "Y/n" } else { "y/N" }
    $prompt = ("  " + $Name.PadRight(20) + "[" + $defLabel + "]")
    if ($Note) { $prompt = ($prompt + "  -- " + $Note) }

    $tries = 0
    while ($tries -lt 2) {
        $raw = Read-Host -Prompt $prompt
        if (-not $raw) { return $Default }
        switch -Regex ($raw.Trim().ToLower()) {
            "^(y|yes)$" { return $true }
            "^(n|no)$"  { return $false }
            default     { Write-Host "    please answer y or n (Enter = default)"; $tries++ }
        }
    }
    return $Default
}

function Set-FeatureFlags {
    Write-Step "feature toggles"

    if ($NonInteractive) {
        Write-Info "non-interactive mode: using defaults"
    } else {
        Write-Info "Enable optional features? Press Enter to accept the default."
    }

    $features = [ordered]@{
        news         = (Read-FeatureToggle -Name "News digest"       -Default $false -Note "default N (costs Gemini tokens)")
        gaming       = (Read-FeatureToggle -Name "Gaming utilities"  -Default $true  -Note "default Y")
        personal     = (Read-FeatureToggle -Name "Personal section"  -Default $true  -Note "default Y")
        schedules    = (Read-FeatureToggle -Name "Schedules"         -Default $true  -Note "default Y")
        self_improve = (Read-FeatureToggle -Name "Self-improve"      -Default $true  -Note "default Y")
    }

    $outDir  = Join-Path $InstallRoot "cockpit"
    $outFile = Join-Path $outDir "features.json"

    if (-not (Test-Path -LiteralPath $outDir)) {
        New-Item -ItemType Directory -Path $outDir -Force | Out-Null
    }

    try {
        ($features | ConvertTo-Json -Depth 3) | Set-Content -LiteralPath $outFile -Encoding UTF8
        Write-Ok ("features.json written to " + $outFile)
    } catch {
        Stop-WithFix -Stage "features" `
                     -Command ("Set-Content " + $outFile) `
                     -Fix     "Check write permissions on $outDir."
    }

    return $features
}

# ----------------------------------------------------------------------
# Final summary.
# ----------------------------------------------------------------------
function Write-Summary {
    param(
        [System.Collections.Specialized.OrderedDictionary]$Features
    )

    Write-Host ""
    Write-Host "======================================================="
    Write-Host " ULTRON installer summary"
    Write-Host "======================================================="
    Write-Host (" install root : " + $InstallRoot)
    Write-Host (" repo root    : " + $Script:RepoRoot)
    Write-Host (" version      : " + (Get-ProjectVersion))
    Write-Host ""
    Write-Host " features enabled:"
    foreach ($k in $Features.Keys) {
        $state = if ($Features[$k]) { "on " } else { "off" }
        Write-Host ("   [" + $state + "] " + $k)
    }
    if ($Script:Warnings.Count -gt 0) {
        Write-Host ""
        Write-Host " warnings (non-fatal):"
        foreach ($w in $Script:Warnings) { Write-Host ("   - " + $w) }
    }
    Write-Host ""
    Write-Host " next step:"
    Write-Host "   cd control-center"
    Write-Host "   npx tauri dev"
    Write-Host ""
    Write-Host " uninstall:"
    Write-Host "   scripts/uninstall.ps1"
    Write-Host "======================================================="
}

# ----------------------------------------------------------------------
# Main
# ----------------------------------------------------------------------
try {
    $Script:Version = Get-ProjectVersion
    Write-Banner
    Test-Preflight
    Test-Dependencies
    New-DirTree
    Initialize-ClaudeSkills
    if ($SkipUvSync) {
        Write-Step "uv sync (skipped — outer installer already ran it)"
        Write-Ok "venv assumed in place"
    } else {
        Invoke-UvSync
    }
    Invoke-NpmInstall
    $features = Set-FeatureFlags
    Write-Summary -Features $features
    exit 0
} catch {
    Write-Host ""
    Write-Host ("UNCAUGHT ERROR: " + $_.Exception.Message)
    Write-Host $_.ScriptStackTrace
    exit 2
}
