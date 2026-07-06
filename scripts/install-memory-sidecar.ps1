# install-memory-sidecar.ps1 - build or download ultron-memory.exe and deploy
# it to ~/.ultron/bin/ (the path every hook and the Control Center probe).
#
# Order of attempts:
#   1. Destination binary already present            -> skip (unless -Force)
#   2. Download prebuilt asset from the LATEST       -> verify SHA-256 sidecar
#      GitHub Release (ultron-memory-windows-x64.exe)   manifest, then deploy
#   3. cargo build --release --bin ultron-memory     -> copy from target/release
#      --features qdrant  (requires Rust toolchain)
#
# Exit codes: 0 = binary deployed or already present, 1 = all paths failed.
# Failure is NON-fatal for ULTRON as a whole: hooks are fail-safe and recall
# degrades to sparse-only (FTS5) until the sidecar exists.
#
# Standalone usage (also invoked by install.ps1 step 9b):
#   powershell -ExecutionPolicy Bypass -File scripts\install-memory-sidecar.ps1
#   ... -Force        rebuild/redownload even if the binary exists
#   ... -SkipDownload go straight to cargo build (air-gapped / private repo)
#   ... -SkipBuild    never compile, download only
#   ... -DestDir X    deploy somewhere else (tests)

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipDownload,
    [switch]$SkipBuild,
    [string]$DestDir = "",
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

function Say  { param([string]$m) Write-Host ("[sidecar] " + $m) }
function Warn { param([string]$m) Write-Host ("[sidecar] WARN " + $m) }

if ($RepoRoot -eq "") {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
if ($DestDir -eq "") {
    $DestDir = Join-Path $env:USERPROFILE ".ultron\bin"
}
$destExe = Join-Path $DestDir "ultron-memory.exe"

# --- 1. already present -------------------------------------------------
if ((Test-Path -LiteralPath $destExe) -and (-not $Force)) {
    $mb = [Math]::Round((Get-Item -LiteralPath $destExe).Length / 1MB)
    Say ("already present: " + $destExe + " (" + $mb + " MB). Use -Force to replace.")
    exit 0
}
if (-not (Test-Path -LiteralPath $DestDir)) {
    New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
}

# --- 2. download prebuilt release asset ----------------------------------
if (-not $SkipDownload) {
    $assetName = "ultron-memory-windows-x64.exe"
    $base = "https://github.com/SkiTemplar/ultron/releases/latest/download/"
    $tmpExe = Join-Path $env:TEMP $assetName
    $tmpSha = Join-Path $env:TEMP ($assetName + ".sha256")
    try {
        try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
        Say ("trying prebuilt asset " + $assetName + " from latest release...")
        Invoke-WebRequest -Uri ($base + $assetName) -OutFile $tmpExe -UseBasicParsing -TimeoutSec 180
        Invoke-WebRequest -Uri ($base + $assetName + ".sha256") -OutFile $tmpSha -UseBasicParsing -TimeoutSec 60
        $expected = ((Get-Content -LiteralPath $tmpSha -Raw).Trim() -split "\s+")[0].ToLower()
        $actual = (Get-FileHash -LiteralPath $tmpExe -Algorithm SHA256).Hash.ToLower()
        if ($expected -ne $actual) {
            Remove-Item -LiteralPath $tmpExe -Force -ErrorAction SilentlyContinue
            throw ("SHA256 mismatch: expected " + $expected + ", got " + $actual)
        }
        Copy-Item -LiteralPath $tmpExe -Destination $destExe -Force
        Remove-Item -LiteralPath $tmpExe, $tmpSha -Force -ErrorAction SilentlyContinue
        Say ("deployed prebuilt sidecar -> " + $destExe + " (SHA256 verified)")
        exit 0
    } catch {
        Warn ("prebuilt download unavailable (" + $_.Exception.Message + ") - falling back to local build")
    }
}

# --- 3. cargo build fallback ---------------------------------------------
if ($SkipBuild) {
    Warn "-SkipBuild set and download failed. Sidecar NOT installed; semantic recall stays sparse-only."
    exit 1
}
if (-not (Get-Command "cargo" -ErrorAction SilentlyContinue)) {
    Warn "cargo not on PATH. Install Rust (rustup) and re-run, or wait for a published release asset."
    exit 1
}
$crateDir = Join-Path $RepoRoot "control-center\src-tauri"
if (-not (Test-Path -LiteralPath (Join-Path $crateDir "Cargo.toml"))) {
    Warn ("crate not found at " + $crateDir + " - wrong -RepoRoot?")
    exit 1
}
Say "building ultron-memory from source (first build downloads the ONNX runtime; can take several minutes)..."
Push-Location $crateDir
try {
    & cargo build --release --bin ultron-memory --features qdrant
    if ($LASTEXITCODE -ne 0) { throw ("cargo build exited " + $LASTEXITCODE) }
} catch {
    Pop-Location
    Warn ("build failed: " + $_.Exception.Message)
    exit 1
}
Pop-Location
$built = Join-Path $crateDir "target\release\ultron-memory.exe"
if (-not (Test-Path -LiteralPath $built)) {
    Warn ("build reported success but " + $built + " is missing")
    exit 1
}
Copy-Item -LiteralPath $built -Destination $destExe -Force
Say ("built and deployed -> " + $destExe)
exit 0
