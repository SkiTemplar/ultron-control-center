<#
.SYNOPSIS
  Install ULTRON's repo-side git hooks into the local .git/hooks/ folder.

.DESCRIPTION
  Git hooks under .git/hooks/ are NOT versioned. To distribute them, we keep
  canonical copies in git-hooks/ at the repo root and a small installer
  script (this file) that copies them into place.

  Idempotent — re-running overwrites existing hooks with the canonical
  versions. Add to install.ps1 so every fresh setup wires the hooks
  automatically.

.PARAMETER Quiet
  Suppress per-file progress.

.EXAMPLE
  .\scripts\setup-git-hooks.ps1
  .\scripts\setup-git-hooks.ps1 -Quiet
#>

[CmdletBinding()]
param(
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$srcDir = Join-Path $repoRoot "git-hooks"
$dstDir = Join-Path $repoRoot ".git\hooks"

if (-not (Test-Path -LiteralPath $srcDir)) {
    Write-Host "[setup-git-hooks] no git-hooks/ directory in repo — nothing to install" -ForegroundColor DarkGray
    exit 0
}
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot ".git"))) {
    Write-Host "[setup-git-hooks] not a git repo (.git/ missing) — skipping" -ForegroundColor DarkGray
    exit 0
}
if (-not (Test-Path -LiteralPath $dstDir)) {
    New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
}

$installed = 0
Get-ChildItem -LiteralPath $srcDir -File | ForEach-Object {
    $dst = Join-Path $dstDir $_.Name
    Copy-Item -LiteralPath $_.FullName -Destination $dst -Force
    # On Windows, Git for Windows interprets hooks via its bundled sh.exe;
    # there's no chmod needed, but stripping the read-only bit is safe.
    Set-ItemProperty -LiteralPath $dst -Name IsReadOnly -Value $false -ErrorAction SilentlyContinue
    $installed++
    if (-not $Quiet) {
        Write-Host ("  [OK] installed " + $_.Name) -ForegroundColor Green
    }
}

if (-not $Quiet) {
    Write-Host "[setup-git-hooks] $installed hook(s) installed into $dstDir"
}
exit 0
