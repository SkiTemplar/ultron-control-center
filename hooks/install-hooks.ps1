# install-hooks.ps1 -- copia los hooks versionados del repo a ~/.claude/
#
# Los hooks de ULTRON (pipeline de memoria, sessions, workdays) viven en
# ~/.claude/scripts y ~/.claude/hooks porque Claude Code los ejecuta desde
# ahi. Este repo guarda la copia-fuente canonica en hooks/ para que NO se
# pierdan (ver memoria memory-hooks-not-versioned). Este script reinstala
# esa copia-fuente en ~/.claude.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File hooks\install-hooks.ps1
#
# NO toca settings.json (las rutas se resuelven con os.homedir() en cada
# hook, no hardcodean nada, asi que copiar basta). El registro de la tarea
# programada de Workdays es opcional y esta abajo (requiere -RegisterTask).

param(
    [switch]$RegisterTask
)

$ErrorActionPreference = "Stop"

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$RepoHooks  = Join-Path $RepoRoot "hooks"
$ClaudeHome = Join-Path $env:USERPROFILE ".claude"
$ScriptsDst = Join-Path $ClaudeHome "scripts"
$HooksDst   = Join-Path $ClaudeHome "hooks"

New-Item -ItemType Directory -Force -Path $ScriptsDst | Out-Null
New-Item -ItemType Directory -Force -Path $HooksDst   | Out-Null

$srcScripts = Join-Path $RepoHooks "scripts"
$srcHooks   = Join-Path $RepoHooks "hooks"

Write-Host "Copiando scripts a $ScriptsDst ..."
Copy-Item (Join-Path $srcScripts "*.js") $ScriptsDst -Force
Write-Host "Copiando hooks a $HooksDst ..."
Copy-Item (Join-Path $srcHooks "*.js") $HooksDst -Force

$copied = (Get-ChildItem (Join-Path $ScriptsDst "*.js")).Count + (Get-ChildItem (Join-Path $HooksDst "*.js")).Count
Write-Host "OK: $copied hooks instalados."

if ($RegisterTask) {
    $hookPath = Join-Path $HooksDst "workday-auto-update.js"
    $tr = "node `"$hookPath`""
    Write-Host "Registrando tarea UltronWorkdayAutoUpdate (cada 15 min) ..."
    # /RL HIGHEST requiere sesion elevada; si falla, cae a nivel normal (el
    # hook solo lee git y escribe JSON, no necesita admin).
    schtasks /CREATE /F /SC MINUTE /MO 15 /TN "UltronWorkdayAutoUpdate" /TR $tr /RL HIGHEST 2>$null
    if ($LASTEXITCODE -ne 0) {
        schtasks /CREATE /F /SC MINUTE /MO 15 /TN "UltronWorkdayAutoUpdate" /TR $tr
    }
    if ($LASTEXITCODE -eq 0) {
        Write-Host "OK: tarea registrada."
    } else {
        Write-Host "AVISO: no se pudo registrar la tarea (exit $LASTEXITCODE)."
    }
}

Write-Host "Hecho. Los hooks ya estan activos para la proxima sesion de Claude Code."
