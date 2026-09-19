# hablar.ps1 - la voz de mar.ia.
#
# El texto llega por STDIN, NO por la linea de comandos. Antes se incrustaba en
# un script escapando las comillas a mano; con stdin no hay nada que escapar y
# una frase con comillas, acentos o saltos de linea no puede romper ni inyectar
# nada.
#
# Tres motores, del que mejor suena al que siempre esta:
#
#   1. Piper (neuronal, local) - si existe <raiz>\bin\piper\piper.exe y un
#      modelo .onnx. Es el unico que no suena a robot. Se instala con
#      scripts\instalar-voz-piper.ps1; no viene de serie porque son ~80 MB.
#   2. WinRT (Laura / Pablo) - el motor moderno de Windows. Tiene voces en
#      español que System.Speech NO expone: en esta maquina, "Helena Desktop"
#      (la que se usaba) es la version vieja y peor de las tres.
#   3. System.Speech / SAPI - el respaldo de toda la vida.
#
# Uso:  "texto" | powershell -NoProfile -File hablar.ps1 [-Velocidad -10]

[CmdletBinding()]
param(
    # Porcentaje sobre la velocidad normal. Negativo = mas pausado, que es lo
    # que hace que no suene atropellado.
    [int]$Velocidad = -8,
    # Fuerza un motor concreto: piper | winrt | sapi. Vacio = el mejor que haya.
    [string]$Motor = ""
)

$ErrorActionPreference = "Stop"

$texto = [Console]::In.ReadToEnd()
if (-not $texto -or $texto.Trim().Length -eq 0) { exit 0 }
$texto = $texto.Trim()

function Raiz-Maria {
    if ($env:MARIA_HOME) { return $env:MARIA_HOME }
    $nuevo = Join-Path $env:USERPROFILE ".maria"
    if (Test-Path -LiteralPath $nuevo) { return $nuevo }
    return (Join-Path $env:USERPROFILE ".ultron")
}

function Reproducir([string]$wav) {
    # SoundPlayer bloquea hasta terminar, que es justo lo que hace falta: el
    # sidecar marca "hablando" mientras dura la llamada.
    $p = New-Object System.Media.SoundPlayer $wav
    $p.PlaySync()
}

# --- 1. Piper ---------------------------------------------------------------
function Hablar-Piper([string]$t) {
    $dir = Join-Path (Raiz-Maria) "bin\piper"
    $exe = Join-Path $dir "piper.exe"
    if (-not (Test-Path -LiteralPath $exe)) { return $false }
    $modelo = Get-ChildItem -LiteralPath $dir -Filter "*.onnx" -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $modelo) { return $false }
    $wav = Join-Path $env:TEMP ("maria-voz-" + [guid]::NewGuid().ToString("N") + ".wav")
    try {
        $t | & $exe --model $modelo.FullName --output_file $wav 2>$null
        if (-not (Test-Path -LiteralPath $wav)) { return $false }
        Reproducir $wav
        return $true
    } catch {
        return $false
    } finally {
        Remove-Item -LiteralPath $wav -Force -ErrorAction SilentlyContinue
    }
}

# --- 2. WinRT ---------------------------------------------------------------
function Hablar-WinRT([string]$t, [int]$vel) {
    try {
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
            Where-Object {
                $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
                $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
            })[0]
        $null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
        $syn = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer

        # Preferencia medida a oido en esta maquina: Laura > Pablo > Helena.
        $voces = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
            Where-Object { $_.Language -like 'es*' }
        if (-not $voces) { return $false }
        $voz = $null
        foreach ($pref in @('Laura', 'Pablo', 'Helena')) {
            if (-not $voz) { $voz = $voces | Where-Object { $_.DisplayName -match $pref } | Select-Object -First 1 }
        }
        if (-not $voz) { $voz = $voces | Select-Object -First 1 }
        $syn.Voice = $voz

        # SSML: la velocidad un poco por debajo y una pausa corta tras cada
        # punto. Es lo que quita la sensacion de lectura atropellada.
        $escapado = [System.Security.SecurityElement]::Escape($t)
        $escapado = $escapado -replace '\. ', '. <break time="180ms"/>'
        $ssml = @"
<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="es-ES">
<prosody rate="$vel%">$escapado</prosody>
</speak>
"@
        $op = $syn.SynthesizeSsmlToStreamAsync($ssml)
        $stream = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op)).GetAwaiter().GetResult()

        $wav = Join-Path $env:TEMP ("maria-voz-" + [guid]::NewGuid().ToString("N") + ".wav")
        try {
            $entrada = $stream.GetInputStreamAt(0)
            $lector = New-Object Windows.Storage.Streams.DataReader $entrada
            $null = $asTask.MakeGenericMethod([uint32]).Invoke($null, @($lector.LoadAsync([uint32]$stream.Size))).GetAwaiter().GetResult()
            $bytes = New-Object byte[] $stream.Size
            $lector.ReadBytes($bytes)
            [System.IO.File]::WriteAllBytes($wav, $bytes)
            Reproducir $wav
            return $true
        } finally {
            Remove-Item -LiteralPath $wav -Force -ErrorAction SilentlyContinue
        }
    } catch {
        return $false
    }
}

# --- 3. SAPI ----------------------------------------------------------------
function Hablar-Sapi([string]$t, [int]$vel) {
    Add-Type -AssemblyName System.Speech
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $es = $s.GetInstalledVoices() |
        Where-Object { $_.VoiceInfo.Culture.Name -like 'es*' -and $_.Enabled } |
        Select-Object -First 1
    if ($es) { $s.SelectVoice($es.VoiceInfo.Name) }
    # La escala de SAPI va de -10 a 10; el porcentaje se traduce a esa escala.
    $s.Rate = [Math]::Max(-10, [Math]::Min(10, [int]($vel / 10)))
    $s.Speak($t)
    return $true
}

$orden = if ($Motor) { @($Motor) } else { @('piper', 'winrt', 'sapi') }
foreach ($m in $orden) {
    $ok = switch ($m) {
        'piper' { Hablar-Piper $texto }
        'winrt' { Hablar-WinRT $texto $Velocidad }
        'sapi'  { Hablar-Sapi $texto $Velocidad }
        default { $false }
    }
    if ($ok) {
        Write-Output $m
        exit 0
    }
}
Write-Error "ningun motor de voz pudo hablar"
exit 1
