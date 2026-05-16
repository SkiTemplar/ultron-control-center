#requires -Version 5.1
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

$PackageJson  = Join-Path $RepoRoot 'control-center\package.json'
$CargoToml    = Join-Path $RepoRoot 'control-center\src-tauri\Cargo.toml'
$TauriConf    = Join-Path $RepoRoot 'control-center\src-tauri\tauri.conf.json'
$Changelog    = Join-Path $RepoRoot 'CHANGELOG.md'

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
    # 3. Bump the three version files coherently
    # --------------------------------------------------------------
    Write-Step 'Updating version files'

    # package.json: "version": "X.Y.Z"
    Invoke-Action -Description "package.json -> $bareVersion" -Action {
        $content = Get-Content -Raw -LiteralPath $PackageJson
        $updated = [regex]::Replace(
            $content,
            '("version"\s*:\s*")[^"]+(")',
            { param($m) "$($m.Groups[1].Value)$bareVersion$($m.Groups[2].Value)" },
            1)
        Set-Content -LiteralPath $PackageJson -Value $updated -NoNewline -Encoding utf8
    }
    Write-Ok 'package.json'

    # Cargo.toml: only the [package] version line. The first occurrence
    # of `version = "..."` after `name = "control-center"` is the one
    # we want — replacing all would also touch dep versions.
    Invoke-Action -Description "Cargo.toml -> $bareVersion" -Action {
        $content = Get-Content -Raw -LiteralPath $CargoToml
        $pattern = '(?ms)(name\s*=\s*"control-center"\s*\nversion\s*=\s*")[^"]+(")'
        $updated = [regex]::Replace(
            $content,
            $pattern,
            { param($m) "$($m.Groups[1].Value)$bareVersion$($m.Groups[2].Value)" },
            1)
        Set-Content -LiteralPath $CargoToml -Value $updated -NoNewline -Encoding utf8
    }
    Write-Ok 'Cargo.toml'

    # tauri.conf.json: top-level "version".
    Invoke-Action -Description "tauri.conf.json -> $bareVersion" -Action {
        $content = Get-Content -Raw -LiteralPath $TauriConf
        $updated = [regex]::Replace(
            $content,
            '("version"\s*:\s*")[^"]+(")',
            { param($m) "$($m.Groups[1].Value)$bareVersion$($m.Groups[2].Value)" },
            1)
        Set-Content -LiteralPath $TauriConf -Value $updated -NoNewline -Encoding utf8
    }
    Write-Ok 'tauri.conf.json'

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

    Invoke-Action -Description 'git add (3 version files)' -Action {
        git add $PackageJson $CargoToml $TauriConf
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
       The 'release' job will produce a Windows installer and latest.json.

    2. When the workflow finishes (~10-20 min on free tier), verify the
       release on the GitHub Releases page:
         - installer (.exe / .msi) attached
         - latest.json attached and signed
         - release notes look right

    3. Smoke-test the installer on a clean Windows 11 VM. Confirm the
       SmartScreen warning is the only friction and the install completes.

    4. From an older install, confirm the auto-updater detects $tagName
       on next launch and installs cleanly.

    5. Announce. The auto-updater handles existing installs from now on.
"@
    }
}
finally {
    Pop-Location
}
