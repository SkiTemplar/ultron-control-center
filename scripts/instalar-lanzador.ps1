# instalar-lanzador.ps1 - deja UN solo lanzador en el sistema: mar.ia.
#
# El problema (reportado el 2026-09-19): en el menu de inicio seguia habiendo
# un acceso directo "ULTRON Control Center" apuntando al binario del repo
# VIEJO (~/.maria/control-center/...), asi que buscar en el menu abria la
# version antigua. La nueva (el fork) no tenia ningun
# acceso directo: solo se podia abrir a mano desde target\release.
#
# Este script:
#   1. Borra los accesos directos del lanzador viejo (menu, escritorio, barra).
#   2. Crea "mar.ia" en el menu de inicio y en el escritorio, apuntando al
#      binario de ESTE repo, con el icono del reactor.
#   3. Deja la entrada de arranque con Windows apuntando al mismo binario.
#
# Es idempotente: se puede volver a lanzar despues de cada build sin ensuciar
# nada. Con -DryRun solo dice lo que haria.
#
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\instalar-lanzador.ps1

[CmdletBinding()]
param(
    [switch]$DryRun,
    # Ruta del .exe. Por defecto, el build de este repo.
    [string]$Exe
)

$ErrorActionPreference = "Stop"

# --- 1. Localizar el binario -----------------------------------------------
if (-not $Exe -or $Exe.Trim().Length -eq 0) {
    $repo = Split-Path -Parent $PSScriptRoot
    $Exe = Join-Path $repo "control-center\src-tauri\target\release\control-center.exe"
}
if (-not (Test-Path -LiteralPath $Exe)) {
    throw "No encuentro el binario: $Exe. Compila antes con: cd control-center; npm run build:local"
}
$Exe = (Resolve-Path -LiteralPath $Exe).Path
Write-Output "Binario: $Exe"

$menu      = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
$escritorio = [Environment]::GetFolderPath("Desktop")
$barra     = Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"
$sh        = New-Object -ComObject WScript.Shell

# --- 2. Quitar los lanzadores viejos ---------------------------------------
# Se borra por DESTINO, no por nombre: un acceso directo llamado "mar.ia" que
# apunte al binario viejo es igual de malo que uno llamado "ULTRON".
$viejos = @()
foreach ($sitio in @($menu, $escritorio, $barra)) {
    if (-not (Test-Path -LiteralPath $sitio)) { continue }
    Get-ChildItem -LiteralPath $sitio -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
        $destino = ""
        try { $destino = $sh.CreateShortcut($_.FullName).TargetPath } catch { }
        $esNuestro = $destino -match 'control-center\.exe$'
        $esElBueno = $destino -and ($destino -ieq $Exe)
        if ($esNuestro -and -not $esElBueno) { $viejos += $_.FullName }
    }
}
foreach ($v in $viejos) {
    if ($DryRun) {
        Write-Output "[dry-run] Borraria el acceso directo viejo: $v"
    } else {
        Remove-Item -LiteralPath $v -Force
        Write-Output "Borrado el acceso directo viejo: $v"
    }
}
if ($viejos.Count -eq 0) { Write-Output "No habia accesos directos viejos." }

# --- 3. Crear el lanzador de mar.ia ----------------------------------------
function Nuevo-Acceso([string]$destinoLnk) {
    if ($DryRun) {
        Write-Output "[dry-run] Crearia $destinoLnk"
        return
    }
    $lnk = $sh.CreateShortcut($destinoLnk)
    $lnk.TargetPath = $Exe
    $lnk.WorkingDirectory = Split-Path -Parent $Exe
    # El icono sale del propio .exe (el reactor que genera icons\make_icon.py).
    $lnk.IconLocation = "$Exe,0"
    $lnk.Description = "mar.ia - asistente local con relevo de proveedores"
    $lnk.Save()
    Write-Output "Creado: $destinoLnk"
}

Nuevo-Acceso (Join-Path $menu "mar.ia.lnk")
Nuevo-Acceso (Join-Path $escritorio "mar.ia.lnk")

# --- 4. Arranque con Windows ------------------------------------------------
# La app tambien lo registra sola la primera vez (`ensure_autostart`), pero esa
# marca no se actualiza si el binario cambia de sitio. Aqui se deja siempre
# apuntando al bueno.
$run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$valor = "$Exe --from-autostart"
$actual = (Get-ItemProperty -Path $run -Name "mar.ia" -ErrorAction SilentlyContinue)."mar.ia"
foreach ($viejo in @("ULTRON", "ULTRON Control Center", "ultron-control-center")) {
    if (Get-ItemProperty -Path $run -Name $viejo -ErrorAction SilentlyContinue) {
        if ($DryRun) {
            Write-Output "[dry-run] Quitaria del arranque: $viejo"
        } else {
            Remove-ItemProperty -Path $run -Name $viejo -Force
            Write-Output "Quitado del arranque: $viejo"
        }
    }
}
if ($actual -eq $valor) {
    Write-Output "Arranque con Windows: ya correcto."
} elseif ($DryRun) {
    Write-Output "[dry-run] Pondria en el arranque: $valor"
} else {
    Set-ItemProperty -Path $run -Name "mar.ia" -Value $valor
    Write-Output "Arranque con Windows: $valor"
}

if ($DryRun) { exit 0 }

# --- 5. Verificar -----------------------------------------------------------
$errores = @()
foreach ($p in @((Join-Path $menu "mar.ia.lnk"), (Join-Path $escritorio "mar.ia.lnk"))) {
    if (-not (Test-Path -LiteralPath $p)) { $errores += "falta $p"; continue }
    $d = $sh.CreateShortcut($p).TargetPath
    if ($d -ine $Exe) { $errores += "$p apunta a $d" }
}
$tras = (Get-ItemProperty -Path $run -Name "mar.ia" -ErrorAction SilentlyContinue)."mar.ia"
if ($tras -ne $valor) { $errores += "el arranque quedo en: $tras" }
# Que no quede NINGUN acceso directo a otro control-center.exe.
foreach ($sitio in @($menu, $escritorio, $barra)) {
    if (-not (Test-Path -LiteralPath $sitio)) { continue }
    Get-ChildItem -LiteralPath $sitio -Recurse -Filter *.lnk -ErrorAction SilentlyContinue | ForEach-Object {
        $d = ""
        try { $d = $sh.CreateShortcut($_.FullName).TargetPath } catch { }
        if ($d -match 'control-center\.exe$' -and $d -ine $Exe) {
            $errores += "sigue habiendo un lanzador viejo: $($_.FullName) -> $d"
        }
    }
}

if ($errores.Count -gt 0) {
    $errores | ForEach-Object { Write-Error $_ }
    throw "El lanzador no quedo limpio."
}

Write-Output ""
Write-Output "OK. Para abrir mar.ia: tecla Windows -> escribe 'mar.ia', o el icono del escritorio."
