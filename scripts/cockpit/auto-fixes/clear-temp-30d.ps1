# auto-fixes/clear-temp-30d.ps1
# Removes files older than 30 days from %TEMP% and Windows\Temp.
# Skips locked files silently. Triggered from Dashboard auto-fix modal.

$ErrorActionPreference = "Stop"
$cutoff = (Get-Date).AddDays(-30)
$targets = @($env:TEMP, "$env:SystemRoot\Temp") | Where-Object { Test-Path -LiteralPath $_ }

$removed = 0
$freed = 0L
$errors = @()

foreach ($t in $targets) {
    Get-ChildItem -LiteralPath $t -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object {
        $_.LastWriteTime -lt $cutoff
    } | ForEach-Object {
        try {
            $sz = $_.Length
            Remove-Item -LiteralPath $_.FullName -Force -ErrorAction Stop
            $removed++
            $freed += $sz
        } catch {
            # Locked files are expected — ignore unless we want noise.
            if ($errors.Count -lt 10) {
                $errors += "$($_.FullName): $($_.Exception.Message)"
            }
        }
    }
}

$summary = [pscustomobject]@{
    fix       = "clear-temp-30d"
    cutoff    = $cutoff.ToString("o")
    targets   = $targets
    removed   = $removed
    freed_mb  = [math]::Round($freed / 1MB, 2)
    errors    = $errors
}
$summary | ConvertTo-Json -Compress
