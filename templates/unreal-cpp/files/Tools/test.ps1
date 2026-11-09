# Ejecuta los Automation Tests del proyecto sin interfaz y falla si alguno no pasa.
param([string]$Filter = '{{identifier}}')
. "$PSScriptRoot\common.ps1"

$reportDir = Join-Path $ProjectRoot 'Saved\TestReport'
if (Test-Path $reportDir) { Remove-Item $reportDir -Recurse -Force }

& $EditorCmd $UProject "-ExecCmds=Automation RunTests $Filter;Quit" `
    -unattended -nullrhi -nosplash -nopause -NoSound -stdout -FullStdOutLogOutput `
    "-ReportExportPath=$reportDir" | Out-Null

$index = Join-Path $reportDir 'index.json'
if (-not (Test-Path $index)) { throw "No se generó el informe de tests en $index" }

$report = Get-Content $index -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($t in $report.tests) {
    $mark = if ($t.state -eq 'Success') { 'OK  ' } else { 'FAIL' }
    Write-Output "$mark $($t.fullTestPath)"
    if ($t.state -ne 'Success') {
        foreach ($e in $t.entries) { if ($e.event.type -eq 'Error') { Write-Output "     $($e.event.message)" } }
    }
}
Write-Output "Pasados: $($report.succeeded) · Fallidos: $($report.failed) · Total: $($report.tests.Count)"
if ($report.failed -gt 0 -or $report.tests.Count -eq 0) { exit 1 }
