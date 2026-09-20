# instalar-voz-gpu.ps1 - pone la transcripcion de voz en la GPU.
#
# POR QUE HACE FALTA
# faster-whisper transcribe por CPU en este equipo (~4 s por cada 3 s de audio)
# porque CTranslate2 no encuentra cuBLAS ni cuDNN:
#
#     RuntimeError: Library cublas64_12.dll is not found or cannot be loaded
#
# Tener una tarjeta NVIDIA no basta: esas dos librerias no vienen con el driver,
# vienen con CUDA. En vez de instalar CUDA entero se bajan como paquetes de pip,
# que es lo mismo pero solo lo necesario y dentro del entorno de la voz.
#
# QUE HACE: instala nvidia-cublas-cu12 y nvidia-cudnn-cu12 en voice\.venv
# (unos 700 MB) y comprueba que la GPU transcribe de verdad.
#
# QUE NO HACE: no toca el sistema, no instala drivers y no cambia nada fuera de
# voice\.venv. Si algo falla, la voz sigue funcionando por CPU.
#
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\instalar-voz-gpu.ps1

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
$py   = Join-Path $repo "voice\.venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $py)) {
    throw "No encuentro el entorno de la voz en $py. Crea primero voice\.venv."
}

# Sin tarjeta NVIDIA esto no sirve de nada: mejor decirlo que bajar 700 MB.
$nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
if (-not $nvidia) {
    Write-Warning "No encuentro nvidia-smi: puede que no haya tarjeta NVIDIA o driver."
    Write-Warning "La voz seguira transcribiendo por CPU, que funciona igual pero mas lento."
}

$paquetes = @("nvidia-cublas-cu12", "nvidia-cudnn-cu12")

if ($DryRun) {
    Write-Output "[dry-run] Instalaria en $py :"
    $paquetes | ForEach-Object { Write-Output "  - $_" }
    exit 0
}

Write-Output "Instalando $($paquetes -join ', ') (unos 700 MB, tarda un rato)..."

# El entorno de la voz esta creado con `uv`, que NO instala pip dentro. Por eso
# `python -m pip` falla con "No module named pip" (medido el 2026-09-21). Se
# usa `uv pip install --python <venv>`, que es la forma de meter paquetes en un
# entorno de uv; si uv no estuviera, se cae a pip por si el entorno es clasico.
$uv = Get-Command uv -ErrorAction SilentlyContinue
if ($uv) {
    & $uv.Source pip install --python $py --upgrade @paquetes
} else {
    & $py -m pip install --upgrade @paquetes
}
if ($LASTEXITCODE -ne 0) {
    throw "la instalacion fallo con codigo $LASTEXITCODE."
}

# Comprobacion REAL, no "se instalo el paquete": se transcribe un segundo de
# silencio, que es lo que obliga a pasar por el codificador y por cuBLAS.
Write-Output ""
Write-Output "Comprobando que la GPU transcribe de verdad..."
$prueba = @'
import sys
sys.path.insert(0, "voice")
import maria_voice as mv
m = mv.cargar_whisper()
print("DISPOSITIVO:", getattr(getattr(m, "model", None), "device", "desconocido"))
'@
Push-Location $repo
try {
    $prueba | & $py -
} finally {
    Pop-Location
}

Write-Output ""
Write-Output "Listo. Si arriba pone 'transcripcion en GPU', ya esta."
Write-Output "Si sigue diciendo CPU, la voz funciona igual: solo tarda unos segundos mas."
