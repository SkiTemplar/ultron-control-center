# arranque-pref.ps1 - la decision de "arrancar con Windows" de mar.ia, para los
# scripts que tocan el arranque o crean tareas programadas. Se carga con:
#   . (Join-Path $PSScriptRoot '..\arranque-pref.ps1')
#
# La decision la guarda la app (Ajustes -> Arranque) en
# <raiz>\cockpit\maria\arranque.json:
#   { "activado": false, "tareas_apagadas": ["\ULTRON-QdrantBoot"] }
# El usuario lo pidio el 2026-09-23: con el arranque DESACTIVADO en la app, no
# se ejecuta nada de mar.ia al iniciar sesion, ninguno de sus procesos. Por
# eso una tarea que se lanzaria al iniciar sesion se crea APAGADA y se anota:
# activar el arranque en la app enciende exactamente las anotadas.
#
# ASCII puro: PowerShell 5.1 rompe el parser con caracteres fuera de ASCII.

# Misma resolucion que maria_paths::home() en Rust y lib/maria-home.js:
# MARIA_HOME > ULTRON_HOME > ~/.maria > ~/.ultron.
function Get-MariaRaiz {
    if ($env:MARIA_HOME) { return $env:MARIA_HOME }
    if ($env:ULTRON_HOME) { return $env:ULTRON_HOME }
    $maria = Join-Path $env:USERPROFILE '.maria'
    if (Test-Path -LiteralPath $maria) { return $maria }
    return (Join-Path $env:USERPROFILE '.ultron')
}

function Get-MariaArranquePrefRuta {
    return (Join-Path (Get-MariaRaiz) 'cockpit\maria\arranque.json')
}

# $true / $false segun la app; $null si todavia no hay decision guardada (la
# app la crea la primera vez que abre).
function Get-MariaArranqueActivado {
    $ruta = Get-MariaArranquePrefRuta
    if (-not (Test-Path -LiteralPath $ruta)) { return $null }
    try {
        $p = Get-Content -Raw -LiteralPath $ruta | ConvertFrom-Json
        if ($null -eq $p.activado) { return $null }
        return [bool]$p.activado
    } catch {
        return $null
    }
}

# Si el arranque esta desactivado en la app, apaga la tarea y la anota en la
# preferencia. Devuelve $true si la apago. Con el arranque activado (o sin
# decision todavia) no hace nada.
function Disable-MariaTareaSiArranqueApagado {
    param(
        [Parameter(Mandatory = $true)][string]$TaskName,
        [string]$TaskPath = '\'
    )
    if ((Get-MariaArranqueActivado) -ne $false) { return $false }
    Disable-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName | Out-Null
    $ruta = Get-MariaArranquePrefRuta
    $p = Get-Content -Raw -LiteralPath $ruta | ConvertFrom-Json
    $lista = @(@($p.tareas_apagadas) | Where-Object { $_ })
    $id = "$TaskPath$TaskName"
    if ($lista -notcontains $id) { $lista += $id }
    $nuevo = [ordered]@{ activado = $false; tareas_apagadas = $lista }
    # WriteAllText escribe UTF-8 sin BOM (Set-Content -Encoding UTF8 la pone).
    [IO.File]::WriteAllText($ruta, (ConvertTo-Json -InputObject $nuevo -Depth 3))
    Write-Host "Arranque con Windows DESACTIVADO en mar.ia: '$TaskName' queda creada pero APAGADA."
    Write-Host "Se enciende al activar el arranque en Ajustes -> Arranque."
    return $true
}
