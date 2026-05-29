# ULTRON - install sidecar binaries (card-deploy-embed-bin-install-step).
#
# Builds the `ultron-embed` sidecar (BGE-small 384-d embedder used by the
# memory hooks for real vector recall) and copies it to ~/.ultron/bin/ where
# the Stop/SessionStart hooks look for it.
#
# WHY a script and NOT tauri.conf.json bundle.externalBin:
#   The hooks (session-recall-inject.js, stop-compress-session.js) resolve the
#   binary via FIXED paths in this priority order:
#     1. $env:ULTRON_EMBED_BIN
#     2. ~/.ultron/bin/ultron-embed.exe          <-- this script populates this
#     3. ~/.ultron/control-center/src-tauri/target/release/ultron-embed.exe
#   They do NOT use Tauri's sidecar resolution. Adding bundle.externalBin would
#   make `tauri build` expect a `ultron-embed-<target-triple>.exe` next to the
#   app binary and FAIL the build if absent, while delivering zero runtime
#   benefit (nothing consumes the sidecar API). So the correct, non-breaking
#   fix is this install step. If a non-'app' bundle target is added later,
#   revisit externalBin then.
#
# Usage:  pwsh -File scripts/install-sidecars.ps1
# Exit:   0 on success, non-zero on failure (safe to call from setup.ps1 / CI).

[CmdletBinding()]
param(
    [switch]$Force  # rebuild + reinstall even if the destination hash matches
)

$ErrorActionPreference = "Stop"

$repoSrcTauri = Join-Path $env:USERPROFILE ".ultron\control-center\src-tauri"
$binDir       = Join-Path $env:USERPROFILE ".ultron\bin"
$builtExe     = Join-Path $repoSrcTauri "target\release\ultron-embed.exe"
$destExe      = Join-Path $binDir "ultron-embed.exe"

function Get-Sha256OrNull([string]$path) {
    if (Test-Path -LiteralPath $path) {
        return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    }
    return $null
}

if (-not (Test-Path -LiteralPath $repoSrcTauri)) {
    Write-Error "src-tauri not found at $repoSrcTauri - is the repo cloned to ~/.ultron?"
    exit 1
}

Write-Host "[install-sidecars] Building ultron-embed (release, --features qdrant)..." -ForegroundColor Cyan
Push-Location $repoSrcTauri
try {
    & cargo build --release --bin ultron-embed --features qdrant
    if ($LASTEXITCODE -ne 0) {
        Write-Error "cargo build failed (exit $LASTEXITCODE)"
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $builtExe)) {
    Write-Error "Build reported success but $builtExe is missing"
    exit 1
}

$srcHash = Get-Sha256OrNull $builtExe
$dstHash = Get-Sha256OrNull $destExe

if (($dstHash -eq $srcHash) -and -not $Force) {
    Write-Host "[install-sidecars] ~/.ultron/bin/ultron-embed.exe already up to date (sha256 $srcHash)" -ForegroundColor Green
    exit 0
}

if (-not (Test-Path -LiteralPath $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

Copy-Item -LiteralPath $builtExe -Destination $destExe -Force

# Verify the copy is byte-identical (supply-chain integrity: the file the
# hooks run must match what we just built).
$copiedHash = Get-Sha256OrNull $destExe
if ($copiedHash -ne $srcHash) {
    Write-Error "Copy verification FAILED: built=$srcHash copied=$copiedHash"
    exit 1
}

Write-Host "[install-sidecars] Installed -> $destExe" -ForegroundColor Green
Write-Host "[install-sidecars] sha256: $copiedHash" -ForegroundColor Green
exit 0
