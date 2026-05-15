# ULTRON Control Center — gaming process enumeration.
#
# Returns a JSON array of running processes grouped by name with aggregated
# WorkingSet64. Used by gaming.rs::list_killable_inner. Extracted from the
# inline PS-Command in gaming.rs so the capability validator can pin it by
# script path instead of accepting arbitrary 4000-char PowerShell.

$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new() } catch {}

$rows = @(Get-Process -ErrorAction SilentlyContinue | Group-Object ProcessName | ForEach-Object {
    $totalRam = ($_.Group | Measure-Object -Property WorkingSet64 -Sum).Sum
    [PSCustomObject]@{
        name = $_.Name
        ram  = [int64]$totalRam
        pid  = ($_.Group | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First 1).Id
    }
})

if ($rows.Count -eq 0) { '[]' }
else { ConvertTo-Json @($rows) -Depth 4 -Compress }
