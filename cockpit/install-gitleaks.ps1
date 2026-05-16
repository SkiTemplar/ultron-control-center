#!/usr/bin/env pwsh
<#
.SYNOPSIS
    ULTRON v12.5.0-fix2 (F5) — install gitleaks pre-commit hook in a target git repo.

.DESCRIPTION
    Closes V-CRIT-1..6 of Kirkardo TOTAL Triple. Idempotent. Verifies gitleaks
    binary is installed; copies/symlinks .gitleaks.toml into the repo root if
    missing; installs a pre-commit hook that calls `gitleaks protect --staged`.

.PARAMETER RepoPath
    Path to the git repo (defaults to ~/.ultron-vault).

.PARAMETER Force
    Overwrite any existing pre-commit hook (otherwise the script aborts).

.EXAMPLE
    pwsh install-gitleaks.ps1
    pwsh install-gitleaks.ps1 -RepoPath $env:USERPROFILE\some-other-repo -Force
#>
param(
    [string]$RepoPath = "$env:USERPROFILE\.ultron-vault",
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Write-Info($m)  { Write-Host "[gitleaks-install] $m" -ForegroundColor Cyan }
function Write-Warn($m)  { Write-Host "[gitleaks-install] WARN: $m" -ForegroundColor Yellow }
function Write-Err($m)   { Write-Host "[gitleaks-install] ERROR: $m" -ForegroundColor Red }

# 1) Verify gitleaks is installed
$gitleaks = Get-Command gitleaks -ErrorAction SilentlyContinue
if (-not $gitleaks) {
    Write-Err "gitleaks binary not found in PATH."
    Write-Host ""
    Write-Host "Install options:"
    Write-Host "  scoop install gitleaks       (scoop)"
    Write-Host "  winget install gitleaks      (winget)"
    Write-Host "  choco install gitleaks       (choco)"
    Write-Host "  https://github.com/gitleaks/gitleaks/releases (manual)"
    Write-Host ""
    Write-Host "After install: re-run this script."
    exit 1
}
Write-Info "gitleaks: $($gitleaks.Source)"

# 2) Verify target is a git repo
if (-not (Test-Path $RepoPath)) {
    Write-Err "RepoPath does not exist: $RepoPath"
    exit 1
}
$gitDir = Join-Path $RepoPath ".git"
if (-not (Test-Path $gitDir)) {
    Write-Err "Not a git repo (no .git/): $RepoPath"
    exit 1
}
Write-Info "target repo: $RepoPath"

# 3) Copy .gitleaks.toml to repo root if missing
$srcConfig = "$env:USERPROFILE\.ultron\cockpit\.gitleaks.toml"
$dstConfig = Join-Path $RepoPath ".gitleaks.toml"
if (-not (Test-Path $srcConfig)) {
    Write-Err "Source config not found: $srcConfig"
    exit 1
}
if (-not (Test-Path $dstConfig)) {
    Copy-Item $srcConfig $dstConfig
    Write-Info ".gitleaks.toml installed → $dstConfig"
} else {
    Write-Info ".gitleaks.toml already present (kept)"
}

# 4) Install pre-commit hook
$hookDir  = Join-Path $gitDir "hooks"
$hookPath = Join-Path $hookDir "pre-commit"
if (-not (Test-Path $hookDir)) {
    New-Item -ItemType Directory -Path $hookDir -Force | Out-Null
}
if ((Test-Path $hookPath) -and -not $Force) {
    Write-Warn "pre-commit hook already exists: $hookPath (use -Force to overwrite)"
    exit 1
}

$hookContent = @'
#!/bin/sh
# ULTRON v12.5.0-fix2 (F5) — gitleaks pre-commit hook
# Blocks commits that introduce secrets matching .gitleaks.toml ruleset.
# Bypass (only if you know what you're doing): git commit --no-verify

if ! command -v gitleaks >/dev/null 2>&1; then
    echo "[gitleaks] WARN: gitleaks not in PATH — skipping secret scan" >&2
    exit 0
fi

CONFIG_FLAG=""
if [ -f ".gitleaks.toml" ]; then
    CONFIG_FLAG="--config .gitleaks.toml"
fi

if ! gitleaks protect --staged --no-banner $CONFIG_FLAG; then
    echo ""
    echo "[gitleaks] BLOCKED — secret-pattern match in staged changes."
    echo "[gitleaks] Review above. To bypass (NOT RECOMMENDED): git commit --no-verify"
    exit 1
fi

exit 0
'@

# Write with LF line endings (sh hooks on Windows use sh.exe → must be LF)
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($hookPath, ($hookContent -replace "`r`n","`n"), $utf8NoBom)
Write-Info "pre-commit hook installed → $hookPath"

# 5) Smoke test
Write-Info "Running gitleaks self-test on repo (read-only)…"
& gitleaks detect --source $RepoPath --no-banner --config $dstConfig --redact 2>&1 | Select-Object -First 20
$rc = $LASTEXITCODE
if ($rc -eq 0) {
    Write-Info "✅ Repo clean."
} elseif ($rc -eq 1) {
    Write-Warn "Findings detected. Review above. Pre-commit hook is now installed and will block future commits with these patterns."
} else {
    Write-Warn "gitleaks exit code $rc (unexpected)"
}

Write-Info "Done. Next commit in $RepoPath will be scanned."
