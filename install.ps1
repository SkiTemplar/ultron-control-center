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
    4.  Docker        - optional but recommended for Qdrant
    5.  Qdrant        - pull + run container if Docker is available
    6.  Dir layout    - ~/.ultron, ~/.ultron-vault, ~/.claude/skills
    7.  Hooks         - merge templates/settings-hooks.json into settings.json
    8.  Skills picker - install core skills, prompt one-by-one for personal
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
  Skip Docker / Qdrant steps (5). The app still works, semantic recall
  just stays disabled.

.PARAMETER InstallRoot
  Override the install root. Defaults to "$env:USERPROFILE\.ultron".

.PARAMETER Force
  Re-run idempotent steps even if their sentinel says they completed.

.EXAMPLE
  # Standard one-liner from a fresh shell:
  iex (irm https://raw.githubusercontent.com/SkiTemplar/ultron/main/install.ps1)

.EXAMPLE
  # CI / unattended:
  .\install.ps1 -NonInteractive -NoApp

.NOTES
  Pairs with scripts/install.ps1 (legacy/inner installer). This root
  script delegates to that one for the Python + npm sync stages after
  doing the heavier bootstrap. Both are safe to run independently.
#>

[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [switch]$NoApp,
    [switch]$NoDocker,
    [switch]$Force,
    [string]$InstallRoot = (Join-Path $env:USERPROFILE ".ultron")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ----------------------------------------------------------------------
# Constants and state
# ----------------------------------------------------------------------
$Script:VersionFallback = "v15.2.0"
$Script:RepoRoot        = if ($PSScriptRoot) { $PSScriptRoot } else { Get-Location }
$Script:Warnings        = New-Object System.Collections.Generic.List[string]
$Script:Errors          = New-Object System.Collections.Generic.List[string]
$Script:StepsOK         = New-Object System.Collections.Generic.List[string]
$Script:StepsSkipped    = New-Object System.Collections.Generic.List[string]
$Script:VerboseOn       = $PSBoundParameters.ContainsKey("Verbose") -or $VerbosePreference -ne "SilentlyContinue"

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
            Write-Fail "non-Windows host. Use scripts/install.sh on macOS/Linux."
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
    Write-Fail "Claude Code CLI not found on PATH."
    Write-Info ""
    Write-Info "Install it with one of:"
    Write-Info "  npm install -g @anthropic/claude-code"
    Write-Info "  (or follow https://docs.claude.com/en/docs/claude-code)"
    Write-Info ""
    Write-Info "Then re-run this installer."
    exit 2
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
    Write-Warn2 "uv missing. Attempting auto-install via astral.sh/uv/install.ps1"
    try {
        Invoke-Expression (Invoke-RestMethod -Uri "https://astral.sh/uv/install.ps1" -UseBasicParsing)
        # uv installer typically adds ~/.local/bin or ~/.cargo/bin to PATH for this session.
        $env:Path = $env:Path + ";" + (Join-Path $env:USERPROFILE ".local\bin")
        if (Get-Command "uv" -ErrorAction SilentlyContinue) {
            $ver = (& uv --version 2>$null) -join " "
            Write-OK ("uv " + $ver + " (just installed)")
        } else {
            Write-Fail "uv installed but not on PATH. Open a fresh shell and re-run."
            throw "uv PATH"
        }
    } catch {
        Write-Fail ("uv install failed: " + $_.Exception.Message)
        Write-Info "Install manually from https://docs.astral.sh/uv and re-run."
        throw
    }
}

# ----------------------------------------------------------------------
# Step 4: Docker Desktop (optional)
# ----------------------------------------------------------------------
function Test-Docker {
    Write-Step "4. Docker Desktop"
    if ($NoDocker) { Write-Skip "skipped via -NoDocker"; return $false }

    if (Get-Command "docker" -ErrorAction SilentlyContinue) {
        try {
            $ver = (& docker --version 2>$null)
            Write-OK ("docker " + $ver)
            # Probe daemon
            $null = & docker info 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-OK "docker daemon responsive"
                return $true
            } else {
                Write-Warn2 "docker installed but daemon not running. Start Docker Desktop."
                return $false
            }
        } catch {
            Write-Warn2 ("docker --version failed: " + $_.Exception.Message)
            return $false
        }
    }
    Write-Warn2 "Docker not installed. Qdrant (semantic recall) will be skipped."
    Write-Info "Download: https://www.docker.com/products/docker-desktop/"
    $cont = Confirm-YesNo -Question "Continue without Qdrant?" -Default $true
    if (-not $cont) {
        Write-Info "Install Docker Desktop and re-run."
        exit 3
    }
    return $false
}

# ----------------------------------------------------------------------
# Step 5: Qdrant (if Docker available)
# ----------------------------------------------------------------------
function Initialize-Qdrant {
    param([bool]$DockerOK)
    Write-Step "5. Qdrant vector store"
    if (-not $DockerOK) { Write-Skip "Docker not available"; return }

    try {
        Write-V "docker pull qdrant/qdrant:latest"
        & docker pull qdrant/qdrant:latest 2>&1 | ForEach-Object { Write-V $_ }
        if ($LASTEXITCODE -ne 0) { Write-Warn2 "docker pull qdrant failed (continuing)"; return }

        $existing = & docker ps -a --filter "name=^qdrant$" --format "{{.Names}}" 2>$null
        if ($existing -eq "qdrant") {
            Write-OK "qdrant container already exists"
            $running = & docker ps --filter "name=^qdrant$" --format "{{.Names}}" 2>$null
            if ($running -ne "qdrant") {
                Write-V "qdrant exists but stopped - starting"
                & docker start qdrant 2>&1 | ForEach-Object { Write-V $_ }
            }
        } else {
            $dataDir = Join-Path $env:USERPROFILE ".ultron\qdrant-data"
            if (-not (Test-Path -LiteralPath $dataDir)) {
                New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
            }
            Write-V ("docker run -d --name qdrant -p 6333:6333 -v " + $dataDir + ":/qdrant/storage qdrant/qdrant")
            & docker run -d --name qdrant -p 6333:6333 -v "${dataDir}:/qdrant/storage" qdrant/qdrant 2>&1 | ForEach-Object { Write-V $_ }
            if ($LASTEXITCODE -ne 0) { Write-Warn2 "docker run qdrant failed"; return }
            Write-OK "qdrant container started"
        }

        # Healthcheck (poll briefly)
        Start-Sleep -Seconds 2
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:6333/healthz" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) { Write-OK "qdrant /healthz 200" }
            else                          { Write-Warn2 "qdrant /healthz $($resp.StatusCode)" }
        } catch {
            Write-Warn2 ("qdrant healthcheck failed: " + $_.Exception.Message)
        }
    } catch {
        Write-Warn2 ("Qdrant step failed: " + $_.Exception.Message)
    }
}

# ----------------------------------------------------------------------
# Step 6: directory layout
# ----------------------------------------------------------------------
function New-DirectoryLayout {
    Write-Step "6. directory layout"
    $dirs = @(
        $InstallRoot,
        (Join-Path $InstallRoot "cockpit"),
        (Join-Path $InstallRoot "plans"),
        (Join-Path $InstallRoot "skills"),
        (Join-Path $InstallRoot "scripts"),
        (Join-Path $InstallRoot "brain_index"),
        (Join-Path $InstallRoot ".tmp"),
        (Join-Path $InstallRoot "personal"),
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
# Step 9: brain_index init
# ----------------------------------------------------------------------
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
# Step 10: control-center build (delegated to scripts/install.ps1)
# ----------------------------------------------------------------------
function Build-ControlCenter {
    Write-Step "10. control-center (uv sync + npm install)"
    if ($NoApp) { Write-Skip "skipped via -NoApp"; return }

    $inner = Join-Path $Script:RepoRoot "scripts\install.ps1"
    if (-not (Test-Path -LiteralPath $inner)) {
        Write-Warn2 "scripts/install.ps1 not found - skipping"
        return
    }
    try {
        # Delegate to the inner installer for uv sync + npm install.
        # We pass -NonInteractive because the feature prompts are handled
        # here in this orchestrator already.
        $args = @("-NonInteractive")
        if ($Script:VerboseOn) { $args += "-Verbose" }
        & $inner @args
        if ($LASTEXITCODE -eq 0) {
            Write-OK "uv sync + npm install completed"
        } else {
            Write-Warn2 "inner installer exited $LASTEXITCODE"
        }
    } catch {
        Write-Warn2 ("inner installer failed: " + $_.Exception.Message)
    }

    # Optional Tauri build (cost-heavy - opt-in)
    $doBuild = Confirm-YesNo -Question "Compile Tauri binary now? (takes several minutes)" -Default $false
    if ($doBuild) {
        $cc = Join-Path $Script:RepoRoot "control-center"
        if (-not (Test-Path -LiteralPath $cc)) { Write-Skip "control-center/ missing"; return }
        try {
            Push-Location $cc
            & npm run tauri build 2>&1 | ForEach-Object { Write-V $_ }
            if ($LASTEXITCODE -eq 0) {
                Write-OK "tauri build done. Look in src-tauri/target/release/bundle/"
            } else {
                Write-Warn2 "tauri build exited $LASTEXITCODE"
            }
        } finally {
            Pop-Location
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
    Test-Preflight
    Test-ClaudeCode
    Test-OrInstall-Uv
    $dockerOk = Test-Docker
    Initialize-Qdrant -DockerOK:$dockerOk
    New-DirectoryLayout
    Update-ClaudeSettings
    Install-Skills
    Initialize-BrainIndex
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
