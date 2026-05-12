<#
.SYNOPSIS
  ULTRON · Gemini peer (second-opinion / long-context) vía CLI con suscripción.
  Reemplaza el MCP de Gemini que dependía de GEMINI_API_KEY.

.DESCRIPTION
  Invoca el CLI `gemini` (login OAuth / suscripción — NO API key) con un prompt
  que instruye al modelo a escribir su respuesta completa en Markdown en un
  archivo, para que Claude lo lea con la tool Read sin contaminar el contexto
  con stdout largo.

  Requisitos:
    - `gemini` CLI instalado y logueado (`gemini` interactivo una vez para OAuth).
    - Sin GEMINI_API_KEY: el CLI usa la sesión de la cuenta Google / Gemini Code Assist.

.PARAMETER Prompt
  El prompt para Gemini.

.PARAMETER Model
  Modelo a usar. Default: gemini-3.1-pro (Pro, no Flash). Si la suscripción no
  da Pro por CLI, el CLI degradará y hay que documentarlo (ver spec v15.0.1).

.PARAMETER OutDir
  Carpeta donde se escribe el .md de salida. Default: ~/.ultron/.tmp/gemini-out

.OUTPUTS
  Imprime por stdout SOLO la ruta del archivo .md generado. Claude debe hacer Read de esa ruta.

.EXAMPLE
  $f = & ~/.ultron/scripts/gemini-peer.ps1 -Prompt "Revisa esta arquitectura: ..."
  # luego: Read $f
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string] $Prompt,

    [string] $Model = 'gemini-3.1-pro',

    [string] $OutDir = "$env:USERPROFILE\.ultron\.tmp\gemini-out",

    [int] $TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command gemini -ErrorAction SilentlyContinue)) {
    Write-Error "gemini CLI no encontrado en PATH. Instala @google/gemini-cli y haz login (OAuth)."
    exit 2
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

$stamp   = (Get-Date).ToString('yyyyMMdd-HHmmss')
$outFile = Join-Path $OutDir "$stamp.md"

# Instrucción explícita: respuesta en Markdown DENTRO del archivo; stdout mínimo.
$wrapped = @"
$Prompt

---
INSTRUCCIONES DE SALIDA (obligatorias):
- Escribe tu respuesta COMPLETA en formato Markdown.
- No incluyas nada más por stdout aparte de la respuesta.
- (El runner ULTRON redirige tu stdout al archivo: $outFile)
"@

$job = Start-Job -ScriptBlock {
    param($model, $promptText)
    # --raw-output desactivado a propósito (seguridad: sanitiza ANSI).
    $promptText | & gemini -m $model -p -
} -ArgumentList $Model, $wrapped

if (-not (Wait-Job $job -Timeout $TimeoutSec)) {
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    Write-Error "Gemini CLI timeout tras ${TimeoutSec}s."
    exit 124
}

$result = Receive-Job $job
Remove-Job $job -Force -ErrorAction SilentlyContinue

$header = "<!-- ULTRON gemini-peer · model=$Model · $stamp -->`n`n"
Set-Content -Path $outFile -Value ($header + ($result -join "`n")) -Encoding utf8

# Único output por stdout: la ruta.
Write-Output $outFile
