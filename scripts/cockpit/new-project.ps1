# ULTRON new-project.ps1 - bootstrap "poom" de proyectos (decidido 2026-08-13).
#
# Flujo: nombre (+idea opcional) -> carpeta en la raiz elegida -> git init ->
# README + CLAUDE.md sembrados -> commit inicial -> tab de Windows Terminal
# con claude dentro (color por proyecto y titulo via spawn-claude-session.ps1).
#
# Triggers: (a) Claude en cualquier sesion ejecuta este script cuando el
# usuario pide "nuevo proyecto X"; (b) comando global `ultron-new` (shim .cmd
# en ~/.local/bin). Mismo motor en ambos.
#
# ASCII puro (PS 5.1). Nunca toca proyectos existentes: si la carpeta ya
# existe, aborta.

[CmdletBinding()]
param(
    [Parameter(Position = 0)][string]$Name = "",
    [Parameter(Position = 1)][string]$Idea = "",
    [string]$Root = "",
    [switch]$NoSpawn
)

$ErrorActionPreference = "Stop"

# Sin Mandatory a proposito: con Mandatory y sin argumento, PowerShell abre su
# prompt interactivo "Proporcione valores para los parametros" (visto por el
# usuario, confuso). Mejor uso claro y salir.
if (-not $Name -or $Name.Trim().Length -eq 0) {
    Write-Output "Uso: ultron-new <nombre> [""idea""] [-Root <ruta>] [-NoSpawn]"
    Write-Output "Crea el proyecto en la raiz configurada, siembra git+README+CLAUDE.md y abre un tab claude con color."
    exit 1
}

# --- Raiz de proyectos ------------------------------------------------------
# Antes estaba clavada a la carpeta del autor original
# (%USERPROFILE%\CARRERA\PROYECTOS_PERSONALES): en cualquier otra maquina el
# script moria con "La raiz de proyectos no existe". Ahora se resuelve por
# orden y se explica cual falta cuando no hay ninguna.
#   1. -Root <ruta>
#   2. $env:MARIA_PROJECTS_ROOT
#   3. "raiz_proyectos" de cockpit\maria\identidad.json
#   4. %USERPROFILE%\Documents  (existe en toda instalacion de Windows)
if (-not $Root -or $Root.Trim().Length -eq 0) {
    $Root = $env:MARIA_PROJECTS_ROOT
}
if (-not $Root -or $Root.Trim().Length -eq 0) {
    $idFile = Join-Path $env:USERPROFILE ".ultron\cockpit\maria\identidad.json"
    if (Test-Path -LiteralPath $idFile) {
        try {
            $id = Get-Content -LiteralPath $idFile -Raw | ConvertFrom-Json
            if ($id.raiz_proyectos) { $Root = [string]$id.raiz_proyectos }
        } catch {
            # Un JSON roto no puede impedir crear un proyecto: se sigue al
            # siguiente candidato.
        }
    }
}
if (-not $Root -or $Root.Trim().Length -eq 0) {
    $Root = Join-Path $env:USERPROFILE "Documents"
}
if (-not (Test-Path -LiteralPath $Root)) {
    throw "La raiz de proyectos no existe: $Root. Pasa -Root <ruta>, define MARIA_PROJECTS_ROOT o pon 'raiz_proyectos' en cockpit\maria\identidad.json."
}

# --- Validacion del nombre --------------------------------------------------
$clean = $Name.Trim()
if ($clean -notmatch '^[A-Za-z0-9][A-Za-z0-9 ._\-]{0,60}$') {
    throw "Nombre invalido: '$Name' (letras/numeros/espacios/guiones, max 61 chars, empieza alfanumerico)"
}
$dest = Join-Path $Root $clean
if (Test-Path -LiteralPath $dest) {
    throw "Ya existe: $dest (no se toca nada existente)"
}

# --- Crear + sembrar --------------------------------------------------------
New-Item -ItemType Directory -Path $dest | Out-Null

$ideaLine = if ($Idea -and $Idea.Trim().Length -gt 0) { $Idea.Trim() } else { "(describir la idea aqui)" }

$readme = @"
# $clean

$ideaLine
"@
Set-Content -LiteralPath (Join-Path $dest "README.md") -Value $readme -Encoding UTF8

$claudeMd = @"
# CLAUDE.md - $clean

Responder siempre en Espanol (con tildes; este seed va sin ellas por PS 5.1).

## Que es

$ideaLine

## Convenciones

- Commits: conventional commits (feat/fix/refactor/docs/test/chore).
- Verificar en runtime antes de dar nada por hecho.
"@
Set-Content -LiteralPath (Join-Path $dest "CLAUDE.md") -Value $claudeMd -Encoding UTF8

git -C $dest init -q
git -C $dest add -A
git -C $dest commit -q -m "chore: bootstrap del proyecto $clean (ultron-new)"

Write-Output "[ultron-new] proyecto creado: $dest"

# --- Spawn del tab con claude dentro (color + titulo gratis) ----------------
if (-not $NoSpawn) {
    $spawn = Join-Path $env:USERPROFILE ".ultron\scripts\cockpit\spawn-claude-session.ps1"
    $payload = @{
        provider = "claude"
        cwd = $dest
        prompt = ""
        model = ""
        effort = ""
        name = ""
        resumeId = ""
        dangerous = $true
        continueLast = $false
        forkSession = $false
        pasteOnly = $false
        respectClipboard = $false
        freeTier = $false
    } | ConvertTo-Json -Compress
    $b64 = [System.Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($payload))
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $spawn -Payload $b64
    Write-Output "[ultron-new] sesion claude lanzada en el proyecto"
}
