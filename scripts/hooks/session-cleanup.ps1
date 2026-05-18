# === maintainer-only as of v15.5.16 (folded into stop-memory-sync.ps1) ===
# session-cleanup.ps1  (DEPRECATED for live hook use)
#
# As of v15.5.16 (internal-review-note consolidation) this script is NO LONGER wired into
# the Stop hook chain. Its behavior is inlined at the TAIL of
# scripts/hooks/stop-memory-sync.ps1 so the Stop chain spends one fewer
# PowerShell launch per session.
#
# Kept on disk for manual maintainer use and so any out-of-tree reference
# does not break. See docs/MAINTAINERS.md.
#
# Removes empty plugin data dirs that Claude Code harness tries to mkdir on each hook fire.
# Without this, every new session gets EEXIST errors because the dirs already exist
# (harness uses mkdirSync without recursive:true — Windows-only bug).

$pluginDataDir = "$env:USERPROFILE\.claude\plugins\data"
if (Test-Path $pluginDataDir) {
    Get-ChildItem $pluginDataDir -Directory | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# Prune session-env dirs older than 2 days (safe: stale sessions only)
$sessionEnvDir = "$env:USERPROFILE\.claude\session-env"
if (Test-Path $sessionEnvDir) {
    $cutoff = (Get-Date).AddDays(-2)
    Get-ChildItem $sessionEnvDir -Directory |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

exit 0
