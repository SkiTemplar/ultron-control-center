# === maintainer-only (not user-facing) ===
# GitHub Releases admin tool. One-shot cleanup of orphaned release entries
# after tag deletion. No hook or control-center caller. See docs/MAINTAINERS.md.
# delete-orphan-releases.ps1 — clean up GitHub Releases whose tag was deleted.
#
# After deleting tags v15.4.17 → v15.4.21 with `git push --delete`, the
# associated GitHub Releases stay visible in the Releases UI pointing at
# missing tags (red flag). GitHub does NOT auto-delete them.
#
# This script needs a GitHub Personal Access Token with `repo` scope.
# Create one at: https://github.com/settings/tokens/new (classic, repo scope).
#
# Usage:
#   $env:GITHUB_TOKEN = 'ghp_XXXXXXXX'
#   .\scripts\delete-orphan-releases.ps1
#
# Or pass it inline:
#   .\scripts\delete-orphan-releases.ps1 -Token 'ghp_XXXXXXXX'
#
# Add tags to delete via the -Tags parameter (defaults to the v15.4.17-21 set).

[CmdletBinding()]
param(
    [string]$Token = $env:GITHUB_TOKEN,
    [string]$Repo = 'SkiTemplar/ultron',
    [string[]]$Tags = @('v15.4.17', 'v15.4.18', 'v15.4.19', 'v15.4.20', 'v15.4.21')
)

if (-not $Token) {
    Write-Host '[error] No token. Set $env:GITHUB_TOKEN or pass -Token.' -ForegroundColor Red
    Write-Host 'Get one at https://github.com/settings/tokens/new (classic, repo scope).' -ForegroundColor Yellow
    exit 1
}

$headers = @{
    'Authorization' = "Bearer $Token"
    'Accept' = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent' = 'ultron-orphan-cleaner'
}

foreach ($tag in $Tags) {
    Write-Host ''
    Write-Host "[$tag] Looking up release..." -ForegroundColor Cyan
    try {
        $release = Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/releases/tags/$tag"
        Write-Host "[$tag] Found release id=$($release.id), name=$($release.name)"
        $confirm = Read-Host "[$tag] Delete this release? (y/N)"
        if ($confirm -ne 'y') {
            Write-Host "[$tag] Skipped."
            continue
        }
        Invoke-RestMethod -Headers $headers -Method Delete -Uri "https://api.github.com/repos/$Repo/releases/$($release.id)" | Out-Null
        Write-Host "[$tag] Deleted release id=$($release.id)" -ForegroundColor Green
    } catch {
        if ($_.Exception.Response.StatusCode -eq 'NotFound') {
            Write-Host "[$tag] No release attached (just a stray tag; nothing to delete)." -ForegroundColor Yellow
        } else {
            Write-Host "[$tag] Error: $_" -ForegroundColor Red
        }
    }
}

Write-Host ''
Write-Host 'Done. Verify at https://github.com/' $Repo '/releases' -ForegroundColor Green
