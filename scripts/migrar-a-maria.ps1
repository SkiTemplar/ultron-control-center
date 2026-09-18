# migrar-a-maria.ps1 - renombra la carpeta raiz .ultron a .maria.
#
# El usuario pidio (2026-09-18) que todo el sistema de carpetas se llame maria.
# Renombrar la raiz de un sistema vivo es la clase de cambio que rompe cosas en
# sitios que nadie recuerda: los hooks registrados en ~/.claude/settings.json,
# rutas dentro de brain.db, scripts sueltos. Por eso la migracion:
#
#   1. Para los procesos que tienen la carpeta abierta (qdrant, la app,
#      el sidecar de memoria). Renombrar con ficheros abiertos falla.
#   2. Renombra   %USERPROFILE%\.ultron  ->  %USERPROFILE%\.maria
#   3. Crea un ENLACE DE DIRECTORIO (junction) en .ultron apuntando a .maria.
#      Eso es lo que hace el cambio seguro: todo lo que siga diciendo .ultron
#      sigue funcionando, porque Windows lo resuelve a la carpeta nueva.
#   4. Verifica que se lee lo mismo por los dos nombres.
#
# Es idempotente: si .maria ya existe y .ultron ya es un enlace, no hace nada.
#
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\migrar-a-maria.ps1
#       (anade -DryRun para ver que haria sin tocar nada)

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$home_ = $env:USERPROFILE
$viejo = Join-Path $home_ ".ultron"
$nuevo = Join-Path $home_ ".maria"

function Es-Enlace([string]$ruta) {
    if (-not (Test-Path -LiteralPath $ruta)) { return $false }
    $item = Get-Item -LiteralPath $ruta -Force
    return [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
}

# --- 0. ¿Ya esta migrado? ---------------------------------------------------
if ((Test-Path -LiteralPath $nuevo) -and (Es-Enlace $viejo)) {
    Write-Output "Ya migrado: .maria existe y .ultron es un enlace. Nada que hacer."
    exit 0
}
if (-not (Test-Path -LiteralPath $viejo)) {
    Write-Output "No hay nada que migrar: $viejo no existe."
    exit 0
}
if (Test-Path -LiteralPath $nuevo) {
    throw "Existen las DOS carpetas y .ultron no es un enlace. Migracion a medias: revisar a mano $viejo y $nuevo."
}

if ($DryRun) {
    Write-Output "[dry-run] Pararia los procesos que usan $viejo"
    Write-Output "[dry-run] Renombraria $viejo -> $nuevo"
    Write-Output "[dry-run] Crearia el enlace $viejo -> $nuevo"
    exit 0
}

# --- 1. Parar lo que tiene la carpeta abierta -------------------------------
$nombres = @("control-center", "ultron-memory", "qdrant")
foreach ($n in $nombres) {
    Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Output "Parando $($_.ProcessName) (pid $($_.Id))"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }
}
# Cualquier otro proceso que corra DESDE la carpeta.
Get-Process | Where-Object { $_.Path -like "$viejo\*" } | ForEach-Object {
    Write-Output "Parando $($_.ProcessName) (pid $($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

# --- 2. Renombrar -----------------------------------------------------------
Write-Output "Renombrando $viejo -> $nuevo"
Rename-Item -LiteralPath $viejo -NewName ".maria" -ErrorAction Stop

# --- 3. Enlace de compatibilidad -------------------------------------------
Write-Output "Creando enlace $viejo -> $nuevo"
$null = New-Item -ItemType Junction -Path $viejo -Target $nuevo -ErrorAction Stop

# --- 4. Verificar -----------------------------------------------------------
$errores = @()
if (-not (Test-Path -LiteralPath (Join-Path $nuevo "brain.db"))) {
    $errores += "no encuentro brain.db en $nuevo"
}
if (-not (Es-Enlace $viejo)) {
    $errores += "$viejo no quedo como enlace"
}
# La misma marca tiene que verse por los dos nombres.
$marca = Join-Path $nuevo ".tmp\migracion-maria.txt"
$null = New-Item -ItemType Directory -Force -Path (Split-Path $marca) | Out-Null
Set-Content -LiteralPath $marca -Value (Get-Date -Format "o") -Encoding UTF8
if (-not (Test-Path -LiteralPath (Join-Path $viejo ".tmp\migracion-maria.txt"))) {
    $errores += "el enlace no resuelve: la marca no se ve desde $viejo"
}

if ($errores.Count -gt 0) {
    $errores | ForEach-Object { Write-Error $_ }
    throw "Migracion incompleta."
}

Write-Output "OK: raiz en $nuevo, enlace de compatibilidad en $viejo."
Write-Output "Arranca mar.ia: deberia leer y escribir en .maria."
