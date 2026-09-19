# instalar-voz-piper.ps1 - la voz neuronal de mar.ia.
#
# Las voces que trae Windows (Laura, Pablo, Helena) son sintesis clasica: se
# entienden, pero suenan a robot. Piper es un sintetizador neuronal que corre
# EN LOCAL, sin cuenta ni red despues de instalarse, y la diferencia se nota.
#
# Por que no viene de serie: son unos 80 MB entre el binario y el modelo, y
# descargar eso sin pedirlo no es de recibo. En cuanto esta, `voice\hablar.ps1`
# lo usa solo (es el primero de su lista); si no esta, sigue con WinRT.
#
# Lo que descarga, de sitios oficiales:
#   * piper (binario Windows x64) - github.com/rhasspy/piper
#   * modelo de voz en espanol      - huggingface.co/rhasspy/piper-voices
#
# Uso:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\instalar-voz-piper.ps1
#       -Voz davefx|sharvard   (por defecto: davefx, masculina de Espana)
#       -Desinstalar           (borra binario y modelos)

[CmdletBinding()]
param(
    [ValidateSet("davefx", "sharvard")]
    [string]$Voz = "davefx",
    [switch]$Desinstalar
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Raiz-Maria {
    if ($env:MARIA_HOME) { return $env:MARIA_HOME }
    $nuevo = Join-Path $env:USERPROFILE ".maria"
    if (Test-Path -LiteralPath $nuevo) { return $nuevo }
    return (Join-Path $env:USERPROFILE ".ultron")
}

$destino = Join-Path (Raiz-Maria) "bin\piper"

if ($Desinstalar) {
    if (Test-Path -LiteralPath $destino) {
        Remove-Item -LiteralPath $destino -Recurse -Force
        Write-Output "Borrado: $destino. mar.ia volvera a usar la voz de Windows."
    } else {
        Write-Output "No habia nada que borrar en $destino."
    }
    exit 0
}

New-Item -ItemType Directory -Force -Path $destino | Out-Null

# --- 1. Binario -------------------------------------------------------------
$exe = Join-Path $destino "piper.exe"
if (Test-Path -LiteralPath $exe) {
    Write-Output "piper.exe ya esta."
} else {
    $zip = Join-Path $env:TEMP "piper_windows_amd64.zip"
    $url = "https://github.com/rhasspy/piper/releases/latest/download/piper_windows_amd64.zip"
    Write-Output "Descargando piper..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Write-Output "Descomprimiendo..."
    Expand-Archive -LiteralPath $zip -DestinationPath $destino -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    # El zip trae una carpeta piper\ dentro: se aplana para que hablar.ps1 lo
    # encuentre siempre en el mismo sitio.
    $dentro = Join-Path $destino "piper"
    if (Test-Path -LiteralPath (Join-Path $dentro "piper.exe")) {
        Get-ChildItem -LiteralPath $dentro -Force | Move-Item -Destination $destino -Force
        Remove-Item -LiteralPath $dentro -Recurse -Force -ErrorAction SilentlyContinue
    }
}
if (-not (Test-Path -LiteralPath $exe)) {
    throw "No encuentro piper.exe tras la descarga. Revisa $destino."
}

# --- 2. Modelo de voz -------------------------------------------------------
$voces = @{
    "davefx"   = "es/es_ES/davefx/medium/es_ES-davefx-medium"
    "sharvard" = "es/es_ES/sharvard/medium/es_ES-sharvard-medium"
}
$ruta = $voces[$Voz]
$nombre = Split-Path $ruta -Leaf
$onnx = Join-Path $destino "$nombre.onnx"
$json = Join-Path $destino "$nombre.onnx.json"
$base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/$ruta"

if (Test-Path -LiteralPath $onnx) {
    Write-Output "El modelo $nombre ya esta."
} else {
    Write-Output "Descargando la voz $Voz (unos 60 MB)..."
    Invoke-WebRequest -Uri "$base.onnx" -OutFile $onnx -UseBasicParsing
    Invoke-WebRequest -Uri "$base.onnx.json" -OutFile $json -UseBasicParsing
}

# --- 3. Comprobar que habla -------------------------------------------------
$wav = Join-Path $env:TEMP "maria-piper-prueba.wav"
try {
    "Hola, soy mar.ia. Esta es mi voz nueva." | & $exe --model $onnx --output_file $wav 2>$null
    if (-not (Test-Path -LiteralPath $wav)) { throw "piper no genero audio" }
    $tam = (Get-Item -LiteralPath $wav).Length
    if ($tam -lt 1000) { throw "el audio generado esta vacio ($tam bytes)" }
    Write-Output "Prueba OK: $tam bytes de audio. Reproduciendo..."
    (New-Object System.Media.SoundPlayer $wav).PlaySync()
} finally {
    Remove-Item -LiteralPath $wav -Force -ErrorAction SilentlyContinue
}

Write-Output ""
Write-Output "Listo. mar.ia usara Piper a partir de la proxima frase."
Write-Output "Para volver a la voz de Windows: -Desinstalar"
