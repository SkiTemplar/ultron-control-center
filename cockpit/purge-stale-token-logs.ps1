# ULTRON Sprint 3 F1 - purge stale token logs (rotated tokens still on disk)
#
# Usage:
#   pwsh ~/.ultron/cockpit/purge-stale-token-logs.ps1            # dry-run (default)
#   pwsh ~/.ultron/cockpit/purge-stale-token-logs.ps1 -Apply     # actually delete
#
# Purges Codex/CC session JSONLs containing OLD GitHub PAT + Supabase OAuth
# tokens that were rotated by user on 2026-05-03 morning. Cloud-side tokens
# are revoked; disk residue is dead-token cleanup for posture/backup hygiene.
#
# Safe: dry-run by default, lists files BEFORE deletion.

[CmdletBinding()]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$candidates = @()
$candidates += Get-ChildItem "$env:USERPROFILE\.codex\sessions\2026\05\03\rollout-2026-05-03T0*" -ErrorAction SilentlyContinue
$candidates += Get-ChildItem "$env:USERPROFILE\.codex\sessions\2026\05\03\rollout-2026-05-03T11-58*" -ErrorAction SilentlyContinue
$candidates += Get-ChildItem "$env:USERPROFILE\.claude\projects\C--Users-<user>-<project>\d7ecb93b-*" -ErrorAction SilentlyContinue
$candidates += Get-ChildItem "$env:USERPROFILE\.claude\history.jsonl.bak.*" -ErrorAction SilentlyContinue

if (-not $candidates) {
    Write-Host "[purge] no stale token logs found - clean already" -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "[purge] Found $($candidates.Count) stale token log file(s):" -ForegroundColor Cyan
$totalKB = 0
foreach ($f in $candidates) {
    $kb = [math]::Round($f.Length / 1024, 1)
    $totalKB += $kb
    $line = "  [{0,7} KB]  {1}" -f $kb, $f.FullName
    Write-Host $line
}
$totalLine = "[purge] Total: {0:N1} KB" -f $totalKB
Write-Host $totalLine
Write-Host ""

if (-not $Apply) {
    Write-Host "[purge] DRY-RUN - re-run with -Apply to actually delete" -ForegroundColor Yellow
    exit 0
}

Write-Host "[purge] DELETING..." -ForegroundColor Yellow
$deleted = 0
foreach ($f in $candidates) {
    try {
        Remove-Item -LiteralPath $f.FullName -Force
        $deleted++
    } catch {
        Write-Warning "[purge] failed to delete $($f.FullName): $_"
    }
}
Write-Host "[purge] OK deleted $deleted of $($candidates.Count)" -ForegroundColor Green
