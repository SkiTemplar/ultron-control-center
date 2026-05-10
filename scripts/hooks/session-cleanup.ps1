# session-cleanup.ps1
# Removes empty plugin data dirs that Claude Code harness tries to mkdir on each hook fire.
# Without this, every new session gets EEXIST errors because the dirs already exist
# (harness uses mkdirSync without recursive:true — Windows-only bug).

$pluginDataDir = "C:\Users\USER\.claude\plugins\data"
if (Test-Path $pluginDataDir) {
    Get-ChildItem $pluginDataDir -Directory | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

# Prune session-env dirs older than 2 days (safe: stale sessions only)
$sessionEnvDir = "C:\Users\USER\.claude\session-env"
if (Test-Path $sessionEnvDir) {
    $cutoff = (Get-Date).AddDays(-2)
    Get-ChildItem $sessionEnvDir -Directory |
        Where-Object { $_.LastWriteTime -lt $cutoff } |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

exit 0
