# voz de mar.ia

Sidecar local: palabra clave -> transcripcion -> modelo local -> voz.
La app lo lanza sola (`maria_voice_start`); esto es para montarlo a mano.

## Preparar el entorno

```bash
cd voice
uv venv --python 3.12 .venv
VIRTUAL_ENV="$PWD/.venv" uv pip install faster-whisper sounddevice numpy vosk pytest
```

## Modelo de palabra clave

Vosk pequeno en español (Apache-2.0, 58 MB descomprimido). No se versiona:

```bash
curl -L -o es.zip https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip
unzip es.zip -d models && rm es.zip
```

El modelo de transcripcion (faster-whisper large-v3-turbo, ~1,5 GB) se
descarga solo la primera vez que hablas.

## Probar

```bash
.venv/Scripts/python.exe -m pytest test_maria_voice.py -q   # 12 tests, sin microfono
echo '{"cmd":"ping"}' | .venv/Scripts/python.exe maria_voice.py
```

## Protocolo

Una linea JSON por mensaje, por stdin/stdout. Ver la cabecera de
`maria_voice.py` para la lista completa de ordenes y eventos.
