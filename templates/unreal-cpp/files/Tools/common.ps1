# Rutas y utilidades compartidas por los scripts de herramientas.
$ErrorActionPreference = 'Stop'
$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:UProject = Join-Path $ProjectRoot '{{identifier}}.uproject'
$script:EngineRoot = if ($env:UE_ROOT) { $env:UE_ROOT } else { 'C:\Program Files\Epic Games\UE_5.6' }
$script:BuildBat = Join-Path $EngineRoot 'Engine\Build\BatchFiles\Build.bat'
$script:EditorCmd = Join-Path $EngineRoot 'Engine\Binaries\Win64\UnrealEditor-Cmd.exe'
$script:Editor = Join-Path $EngineRoot 'Engine\Binaries\Win64\UnrealEditor.exe'
$script:RunUAT = Join-Path $EngineRoot 'Engine\Build\BatchFiles\RunUAT.bat'

function Assert-ExitCode([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step falló con código $LASTEXITCODE" }
}

# Ejecuta un binario nativo sin que su stderr aborte el script (PowerShell 5.1)
# y muestra solo las líneas que casan con $Filter. Devuelve el código de salida.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$Filter = '.') {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Exe @Arguments 2>&1 | ForEach-Object { "$_" } | Where-Object { $_ -match $Filter } | ForEach-Object { Write-Host $_ }
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previous
    }
}
