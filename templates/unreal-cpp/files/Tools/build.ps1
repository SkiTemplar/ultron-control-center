# Compila el editor (por defecto) o el juego y muestra solo errores, avisos y el resultado.
param(
    [ValidateSet('Editor', 'Game')] [string]$Target = 'Editor',
    [ValidateSet('Development', 'DebugGame', 'Shipping')] [string]$Configuration = 'Development'
)
. "$PSScriptRoot\common.ps1"

$targetName = if ($Target -eq 'Editor') { '{{identifier}}Editor' } else { '{{identifier}}' }
$cmdArgs = @($targetName, 'Win64', $Configuration, "-Project=$UProject", '-WaitMutex', '-NoHotReloadFromIDE')
$code = Invoke-Native $BuildBat $cmdArgs '(error|warning C\d+|Result:)'
if ($code -ne 0) { throw "Build $targetName falló con código $code" }
