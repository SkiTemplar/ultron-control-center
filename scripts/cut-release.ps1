#requires -Version 5.1
# === maintainer-only (not user-facing) ===
# Release tag automation invoked from `docs/RELEASE-PROCESS.md` step 1.
# Never called by hooks, control-center, or any user command. See
# docs/MAINTAINERS.md.
<#
.SYNOPSIS
    Cuts a new public release of ULTRON Control Center.

.DESCRIPTION
    Local helper that:
      1. Verifies a clean working tree on the main branch.
      2. Bumps the version in the three coherent files
         (package.json, Cargo.toml, tauri.conf.json).
      3. Creates an annotated, optionally signed git tag.
      4. Pushes the commit and the tag (or prints what it would push
         with -DryRun).
      5. Prints next steps so the user can verify the GitHub Actions
         run.

    The script never publishes anything by itself. The Actions workflow
    triggered by the tag push is what actually builds and ships the
    installer.

.PARAMETER NewVersion
    The new version to cut, in either "vX.Y.Z" or "X.Y.Z" form. If
    omitted, the script prompts interactively.

.PARAMETER DryRun
    Show every action without writing files, committing, tagging, or
    pushing. Useful before a real release.

.PARAMETER NoSign
    Skip GPG-signing the tag. Off by default; set if you do not have a
    signing key configured.

.PARAMETER SkipPush
    Make the commit and tag locally but do not push. Useful for testing
    or for staging multiple commits before publishing.

.EXAMPLE
    ./scripts/cut-release.ps1 -NewVersion v15.2.1

.EXAMPLE
    ./scripts/cut-release.ps1 -NewVersion 15.2.1 -DryRun

.NOTES
    Run from the repo root. The script resolves paths relative to its
    own location, so calling it from elsewhere also works.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$NewVersion,

    [switch]$DryRun,
    [switch]$NoSign,
    [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'

# ----------------------------------------------------------------------
# Resolve paths relative to the repo root (parent of this script's dir).
# ----------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir

# Monorepo SSOT + its mirrors (the version-drift CI gate checks all of them
# against pyproject via scripts/cockpit/version_propagate.py --check).
# NOTE (2026-07-06): the Control Center manifests (package.json / Cargo.toml /
# tauri.conf.json) carry their OWN 2.x version line, decoupled from the
# monorepo SSOT since the 2026-05 re-versioning. This script must NOT touch
# them — bumping them to the monorepo version broke the old behaviour.
$PyprojectToml = Join-Path $RepoRoot 'pyproject.toml'
$InstallPs1    = Join-Path $RepoRoot 'install.ps1'
$InstallWizard = Join-Path $RepoRoot 'scripts\cockpit\install-wizard.ps1'
$InstallSh     = Join-Path $RepoRoot 'install.sh'
$UvLock        = Join-Path $RepoRoot 'uv.lock'
$Changelog     = Join-Path $RepoRoot 'CHANGELOG.md'

# Markdown files scanned by version_propagate.py for stale version pins
# (badges, bootstrap one-liner URLs, release links). Historical mentions of
# OLDER versions are fine; pins equal to the OUTGOING SSOT version must move.
$MdTargets = @(
    'README.md', 'README.es.md', 'SYSTEM-MAP.md', 'INSTALL.md',
    'docs\INSTALL.md', 'docs\QUICKSTART.md', 'docs\memory-layers.md',
    'docs\skills-manifest-schema.md'
) | ForEach-Object { Join-Path $RepoRoot $_ }

# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------
function Write-Step  { param($msg) Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param($msg) Write-Host "    ok: $msg"   -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "    warn: $msg" -ForegroundColor Yellow }
function Write-Fail  { param($msg) Write-Host "    fail: $msg" -ForegroundColor Red }

function Invoke-Action {
    param([string]$Description, [scriptblock]$Action)
    if ($DryRun) {
        Write-Host "    [dry-run] $Description" -ForegroundColor DarkGray
    } else {
        & $Action
    }
}

function Get-NormalisedVersion {
    param([string]$Raw)
    if (-not $Raw) { return $null }
    $v = $Raw.Trim()
    if ($v.StartsWith('v') -or $v.StartsWith('V')) { $v = $v.Substring(1) }
    if ($v -notmatch '^\d+\.\d+\.\d+(-[A-Za-z0-9.\-]+)?$') {
        throw "Version '$Raw' is not valid semver (expected X.Y.Z or X.Y.Z-suffix)."
    }
    return $v
}

# ----------------------------------------------------------------------
# 1. Sanity checks
# ----------------------------------------------------------------------
Write-Step 'Verifying repo state'

Push-Location $RepoRoot
try {
    if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
        throw "Not a git repository: $RepoRoot"
    }

    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -ne 'main') {
        Write-Warn "Current branch is '$branch', not 'main'. Continue? (y/N)"
        $answer = Read-Host
        if ($answer -notmatch '^[yY]') {
            throw "Aborted: not on main."
        }
    }
    Write-Ok "branch: $branch"

    $statusLines = git status --porcelain
    if ($statusLines) {
        Write-Fail 'Working tree is not clean. Commit or stash first.'
        $statusLines | ForEach-Object { Write-Host "      $_" }
        throw 'Dirty working tree.'
    }
    Write-Ok 'working tree clean'

    # Make sure we are up to date with origin so we do not push a fork
    # of main by mistake.
    git fetch --quiet origin
    $local  = (git rev-parse '@').Trim()
    $remote = (git rev-parse '@{u}' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $remote -and ($local -ne $remote.Trim())) {
        Write-Warn 'Local branch is not at origin head. Continue? (y/N)'
        $answer = Read-Host
        if ($answer -notmatch '^[yY]') { throw 'Aborted: local out of sync.' }
    }

    # --------------------------------------------------------------
    # 2. Resolve the new version (prompt if missing)
    # --------------------------------------------------------------
    Write-Step 'Resolving new version'
    if (-not $NewVersion) {
        $NewVersion = Read-Host 'New version (e.g. v15.2.1)'
    }
    $bareVersion = Get-NormalisedVersion -Raw $NewVersion
    $tagName     = "v$bareVersion"
    Write-Ok "tag: $tagName  version: $bareVersion"

    # Refuse to re-cut an existing tag.
    $existingTag = git tag --list $tagName
    if ($existingTag) {
        throw "Tag '$tagName' already exists. Pick a different version or delete the tag first."
    }

    # --------------------------------------------------------------
    # 3. Bump the monorepo SSOT + every mirror the CI drift gate checks
    #    (rewritten 2026-07-06: the old version bumped the three Control
    #    Center manifests — which have their own decoupled 2.x line — and
    #    never touched pyproject, so the release commit itself tripped
    #    the version-drift gate on the v15.6.0 cut.)
    # --------------------------------------------------------------
    Write-Step 'Updating version files (SSOT + mirrors)'

    # Read the OUTGOING version first: markdown pins are replaced by value.
    # [IO.File] on every read/write below: PS 5.1 Get-Content without -Encoding
    # reads BOM-less UTF-8 as ANSI (mojibake), and Set-Content -Encoding utf8
    # writes a BOM (which would break the install.sh shebang). ReadAllText /
    # WriteAllText are UTF-8 no-BOM both ways (v15.7.0 cut, 2026-07-18).
    $ssotRaw = [IO.File]::ReadAllText($PyprojectToml)
    $ssotMatch = [regex]::Match($ssotRaw, '(?m)^version\s*=\s*"(?<ver>\d+\.\d+\.\d+)"')
    if (-not $ssotMatch.Success) { throw "Cannot find [project].version in pyproject.toml" }
    $oldVersion = $ssotMatch.Groups['ver'].Value
    Write-Ok "outgoing SSOT version: $oldVersion"

    # pyproject.toml (SSOT): ^version = "X.Y.Z"
    Invoke-Action -Description "pyproject.toml -> $bareVersion" -Action {
        $updated = [regex]::Replace(
            $ssotRaw,
            '(?m)^(version\s*=\s*")[^"]+(")',
            { param($m) "$($m.Groups[1].Value)$bareVersion$($m.Groups[2].Value)" },
            1)
        [IO.File]::WriteAllText($PyprojectToml, $updated)
    }
    Write-Ok 'pyproject.toml (SSOT)'

    # Mirrors are patched BY PATTERN (not old->new value) so a mirror that
    # already drifted behind still snaps to the new version.
    # install.ps1: $Script:VersionFallback = "vX.Y.Z"
    Invoke-Action -Description "install.ps1 VersionFallback -> v$bareVersion" -Action {
        $content = [IO.File]::ReadAllText($InstallPs1)
        $updated = [regex]::Replace(
            $content,
            '(\$Script:VersionFallback\s*=\s*"v)[0-9]+\.[0-9]+\.[0-9]+(")',
            { param($m) "$($m.Groups[1].Value)$bareVersion$($m.Groups[2].Value)" },
            1)
        [IO.File]::WriteAllText($InstallPs1, $updated)
    }
    Write-Ok 'install.ps1'

    # scripts/cockpit/install-wizard.ps1: [string]$Version = "vX.Y.Z"
    Invoke-Action -Description "install-wizard.ps1 Version -> v$bareVersion" -Action {
        $content = [IO.File]::ReadAllText($InstallWizard)
        $updated = [regex]::Replace(
            $content,
            '(\[string\]\$Version\s*=\s*"v)[0-9]+\.[0-9]+\.[0-9]+(")',
            { param($m) "$($m.Groups[1].Value)$bareVersion$($m.Groups[2].Value)" },
            1)
        [IO.File]::WriteAllText($InstallWizard, $updated)
    }
    Write-Ok 'install-wizard.ps1'

    # install.sh: readonly ULTRON_VERSION="vX.Y.Z"
    Invoke-Action -Description "install.sh ULTRON_VERSION -> v$bareVersion" -Action {
        $content = [IO.File]::ReadAllText($InstallSh)
        $updated = [regex]::Replace(
            $content,
            '(readonly\s+ULTRON_VERSION="v)[0-9]+\.[0-9]+\.[0-9]+(")',
            { param($m) "$($m.Groups[1].Value)$bareVersion$($m.Groups[2].Value)" },
            1)
        [IO.File]::WriteAllText($InstallSh, $updated)
    }
    Write-Ok 'install.sh'

    # Markdown pins (bootstrap URLs, badges, release links): replace the
    # OUTGOING version by value. Historical mentions of older versions stay
    # untouched by design; the propagate --check gate below catches leftovers.
    Invoke-Action -Description "markdown pins v$oldVersion -> v$bareVersion" -Action {
        foreach ($md in $MdTargets) {
            if (-not (Test-Path -LiteralPath $md)) { continue }
            $content = [IO.File]::ReadAllText($md)
            if ($content -match [regex]::Escape("v$oldVersion")) {
                $updated = $content -replace [regex]::Escape("v$oldVersion"), "v$bareVersion"
                [IO.File]::WriteAllText($md, $updated)
                Write-Ok ("markdown: " + (Split-Path -Leaf $md))
            }
        }
    }

    # uv.lock records the ultron package version; regenerate so the lock
    # does not drift from pyproject.
    Invoke-Action -Description 'uv lock (refresh ultron version in lockfile)' -Action {
        if (Get-Command uv -ErrorAction SilentlyContinue) {
            # cmd owns the redirect: in PS 5.1, `2>&1` on a native exe wraps
            # stderr lines in ErrorRecords and killed the v15.7.0 cut when uv
            # printed "Resolved N packages" to stderr.
            cmd /c "uv lock >nul 2>&1"
            if ($LASTEXITCODE -ne 0) { Write-Warn 'uv lock returned non-zero; check uv.lock manually.' }
        } else {
            Write-Warn 'uv not on PATH - uv.lock not refreshed. Run "uv lock" manually before pushing.'
        }
    }
    Write-Ok 'uv.lock'

    # --------------------------------------------------------------
    # 3b. Drift gate — the SAME check CI runs. If any mirror or markdown
    #     pin is stale, abort BEFORE committing anything.
    # --------------------------------------------------------------
    Write-Step 'Drift gate (version_propagate.py --check)'
    if ($DryRun) {
        Write-Host '    [dry-run] uv run python scripts/cockpit/version_propagate.py --check' -ForegroundColor DarkGray
    } else {
        & uv run python (Join-Path $RepoRoot 'scripts\cockpit\version_propagate.py') --check
        if ($LASTEXITCODE -ne 0) {
            throw 'version_propagate --check FAILED after the bump. Fix the reported drift, then re-run. Nothing was committed.'
        }
        Write-Ok 'all mirrors match the new SSOT'
    }

    # CHANGELOG warning.
    if (Test-Path $Changelog) {
        $changelogText = Get-Content -Raw -LiteralPath $Changelog
        if ($changelogText -notmatch [regex]::Escape("v$bareVersion")) {
            Write-Warn "CHANGELOG.md does not mention v$bareVersion. Add an entry before tagging."
        }
    } else {
        Write-Warn 'CHANGELOG.md not found at repo root. Skipping check.'
    }

    # --------------------------------------------------------------
    # 4. Commit + tag
    # --------------------------------------------------------------
    Write-Step 'Creating release commit and tag'

    Invoke-Action -Description 'git add (SSOT + mirrors + markdown pins)' -Action {
        git add $PyprojectToml $InstallPs1 $InstallWizard $InstallSh
        if (Test-Path $UvLock) { git add $UvLock }
        foreach ($md in $MdTargets) { if (Test-Path -LiteralPath $md) { git add $md } }
        if (Test-Path $Changelog) { git add $Changelog }
    }

    Invoke-Action -Description "git commit -m 'release: $tagName'" -Action {
        git commit -m "release: $tagName"
    }

    $signFlag = if ($NoSign) { '-a' } else { '-s' }
    Invoke-Action -Description "git tag $signFlag $tagName" -Action {
        # `-s` requires a GPG key; `-a` is plain annotated.
        git tag $signFlag -m "ULTRON Control Center $tagName" $tagName
    }

    # --------------------------------------------------------------
    # 5. Push (unless suppressed)
    # --------------------------------------------------------------
    if ($SkipPush) {
        Write-Warn 'Skipping push (-SkipPush set). Push manually when ready:'
        Write-Host "    git push && git push origin $tagName"
    } else {
        Write-Step 'Pushing to origin'
        Invoke-Action -Description 'git push' -Action {
            git push
        }
        Invoke-Action -Description "git push origin $tagName" -Action {
            git push origin $tagName
        }
    }

    # --------------------------------------------------------------
    # 6. Done. Print next steps.
    # --------------------------------------------------------------
    Write-Step 'Next steps'
    if ($DryRun) {
        Write-Host '    (dry-run mode) re-run without -DryRun to actually cut the release.'
    } else {
        Write-Host @"
    1. Open the Actions tab on GitHub to watch the release workflow.
       Both matrix legs must go green; finalize-release refuses to
       publish the draft unless all 10 expected assets are attached.
       Verify the REAL conclusion with:
         gh run view <run-id> --json conclusion
       (gh run watch --exit-status has returned 0 on failed runs.)

    2. When the release is published, verify the assets list on the
       GitHub Releases page: NSIS setup.exe, .msi, .deb, .AppImage,
       ultron-system ZIP (+.sha256) and the two ultron-memory sidecars
       (+.sha256). latest.json only appears if updater signing is
       configured (auto-updater is OFF by default).

    3. Smoke-test anonymous download (the path bootstrap + installer use):
         curl -sL https://github.com/SkiTemplar/ultron/releases/latest/download/ultron-memory-windows-x64.exe.sha256

    4. Smoke-test the installer on a clean Windows 11 VM. Confirm the
       SmartScreen warning is the only friction and the install completes.

    5. Announce. (Auto-updater is disabled; existing installs update by
       re-running the installer or bootstrap.)
"@
    }
}
finally {
    Pop-Location
}
