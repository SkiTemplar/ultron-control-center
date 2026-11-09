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
# Without the sidecar there is no memory of any kind: the hooks stay fail-safe
# but nothing writes or recalls. install.ps1 reports that as an install error.
#
# The download uses the public mirror, the repo the install guide clones. It has
# no published release yet, so today this path falls through to the local build.
#
# Standalone usage (also invoked by install.ps1 step 9b):
#   powershell -ExecutionPolicy Bypass -File scripts\install-memory-sidecar.ps1
#   ... -Force        rebuild/redownload even if the binary exists
#   ... -SkipDownload go straight to cargo build (air-gapped / private repo)
#   ... -SkipBuild    never compile, download only
#   ... -DestDir X    deploy somewhere else (tests)
#   ... -CheckLinker  only report whether the MSVC linker exists (exit 0/1)

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$SkipDownload,
    [switch]$SkipBuild,
    [switch]$CheckLinker,
    [string]$DestDir = "",
    [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"

function Say  { param([string]$m) Write-Host ("[sidecar] " + $m) }
function Warn { param([string]$m) Write-Host ("[sidecar] WARN " + $m) }

# The MSVC linker, or $null. A bare "link.exe" on PATH is not enough: Git for
# Windows ships a coreutils link.exe in usr\bin that rustc cannot use.
function Get-MsvcLinkerPath {
    $programFiles = ${env:ProgramFiles(x86)}
    $vswhere = if ($programFiles) { Join-Path $programFiles "Microsoft Visual Studio\Installer\vswhere.exe" } else { "" }
    if ($vswhere -and (Test-Path -LiteralPath $vswhere)) {
        $roots = @(& $vswhere -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath)
        foreach ($root in $roots) {
            $hit = Get-ChildItem -Path (Join-Path $root "VC\Tools\MSVC\*\bin\Hostx64\x64\link.exe") -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($hit) { return $hit.FullName }
        }
    }
    $onPath = Get-Command "link.exe" -CommandType Application -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -match '\\VC\\Tools\\MSVC\\' } | Select-Object -First 1
    if ($onPath) { return $onPath.Source }
    return $null
}

if ($CheckLinker) {
    $linker = Get-MsvcLinkerPath
    if ($linker) {
        Say ("MSVC linker: " + $linker)
        exit 0
    }
    Warn "MSVC linker (link.exe) not found."
    exit 1
}

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
    $base = "https://github.com/SkiTemplar/ultron-control-center/releases/latest/download/"
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
    Warn "-SkipBuild set and download failed. Sidecar NOT installed: no memory until it exists."
    exit 1
}
if (-not (Get-Command "cargo" -ErrorAction SilentlyContinue)) {
    Warn "cargo not on PATH. Install Rust (rustup) and re-run, or wait for a published release asset."
    exit 1
}
if (-not (Get-MsvcLinkerPath)) {
    Warn "MSVC linker (link.exe) not found: cargo cannot link on the msvc toolchain."
    Warn "Install it, then re-run: winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --override ""--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"""
    exit 1
}
$crateDir = Join-Path $RepoRoot "control-center\src-tauri"
if (-not (Test-Path -LiteralPath (Join-Path $crateDir "Cargo.toml"))) {
    Warn ("crate not found at " + $crateDir + " - wrong -RepoRoot?")
    exit 1
}
Say "building ultron-memory from source (cold build: up to ~25 minutes; it also downloads the ONNX runtime)..."
Push-Location $crateDir
# cargo writes progress ("Updating crates.io index", "Compiling ...") to
# stderr. When the caller redirects this script with 2>&1 (install.ps1 does),
# PowerShell 5.1 turns each stderr line into an ErrorRecord and EAP=Stop
# aborts the build on the first one. Judge success by the exit code only.
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
    & cargo build --release --bin ultron-memory --features qdrant
    if ($LASTEXITCODE -ne 0) { throw ("cargo build exited " + $LASTEXITCODE) }
} catch {
    $ErrorActionPreference = $prevEAP
    Pop-Location
    Warn ("build failed: " + $_.Exception.Message)
    exit 1
}
$ErrorActionPreference = $prevEAP
Pop-Location
$built = Join-Path $crateDir "target\release\ultron-memory.exe"
if (-not (Test-Path -LiteralPath $built)) {
    Warn ("build reported success but " + $built + " is missing")
    exit 1
}
Copy-Item -LiteralPath $built -Destination $destExe -Force
Say ("built and deployed -> " + $destExe)
exit 0
