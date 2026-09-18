"""mar.ia — sidecar de voz.

Cadena completa y local: microfono -> fin de dictado (VAD) -> transcripcion
(faster-whisper) -> modelo local (Ollama) -> voz (SAPI de Windows).

PROTOCOLO. Este proceso lo lanza la app (src-tauri/src/maria_voice.rs) y habla
por stdin/stdout con una linea JSON por mensaje. Se eligio asi, y no un puerto
HTTP, porque el webview tiene un CSP estricto que bloquea `connect-src` a
localhost: cualquier puerto obligaria a abrir un agujero en esa politica. Ademas
un hijo con tuberias muere con su padre, sin puertos huerfanos.

  ENTRADA (stdin), una orden por linea:
    {"cmd": "listen"}    empieza a escuchar YA (atajo de teclado)
    {"cmd": "stop"}      deja de grabar y TRANSCRIBE lo dicho (soltar la tecla)
    {"cmd": "cancel"}    aborta y TIRA el audio (no transcribe)
    {"cmd": "ping"}      responde {"event":"pong"}
    {"cmd": "shutdown"}  sale

  SALIDA (stdout), un evento por linea:
    {"event":"state","state":"idle|listening|thinking|speaking"}
    {"event":"amp","amp":0.0-1.0}          nivel del microfono, ~20/s
    {"event":"transcript","text":"..."}    lo que ha entendido
    {"event":"reply","text":"..."}         lo que va a decir
    {"event":"tool","name":"...","args":{}} herramienta que pide ejecutar
    {"event":"error","message":"..."}
    {"event":"log","message":"..."}        diagnostico, no va al orbe

El estado NO se acumula aqui: la memoria, las skills y los agentes siguen
viviendo en ULTRON. Este proceso solo convierte voz en intencion y devuelve voz.
"""

from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

# ---------------------------------------------------------------------------
# Configuracion (todo sobreescribible por el supervisor con variables de entorno)
# ---------------------------------------------------------------------------

OLLAMA_URL = "http://127.0.0.1:11434"
# Medido en la 4080 Laptop el 17/09/2026: 6,6 GB, 3,4 s por respuesta en
# caliente, 51 tok/s y tool calling correcto en español.
LLM_MODEL = "qwen3.5:9b"
# El modelo se descarga en cuanto contesta: la GPU queda libre (774 MiB en
# reposo). Durante una conversacion activa se mantiene unos segundos para que
# el turno siguiente no pague la carga otra vez.
KEEP_ALIVE_IDLE = "0"
KEEP_ALIVE_ACTIVE = "45s"

SAMPLE_RATE = 16_000
FRAME_MS = 30
# Silencio que da por terminada la orden. 900 ms deja respirar sin cortar a
# mitad de frase; por debajo de ~700 ms corta a quien piensa mientras habla.
SILENCE_MS = 900
# Tope duro: si algo se queda enganchado, no grabamos indefinidamente.
MAX_UTTERANCE_S = 30
# Por debajo de esto es ruido de sala, no voz.
SILENCE_RMS = 0.012


def emit(event: str, **fields: Any) -> None:
    """Escribe un evento en stdout. Una linea, con flush: el supervisor lee
    linea a linea y sin flush el orbe se quedaria congelado."""
    payload = {"event": event, **fields}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    emit("log", message=message)


# ---------------------------------------------------------------------------
# Voz (TTS) — SAPI de Windows
# ---------------------------------------------------------------------------


def speak(text: str) -> None:
    """Dice `text` con la voz del sistema.

    SAPI en vez de una libreria: cero dependencias nuevas, voces españolas ya
    instaladas en Windows y el mismo patron de PowerShell desacoplado que usa
    notify-relay.js. Kokoro llegara despues, que suena mucho mejor.
    """
    if not text.strip():
        return
    # Las comillas simples se duplican para que el texto no pueda inyectar
    # codigo en el script (mismo saneado que psLiteral en notify-relay.js).
    literal = text.replace("'", "''")
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$es = $s.GetInstalledVoices() | Where-Object { "
        "$_.VoiceInfo.Culture.Name -like 'es*' -and $_.Enabled } | Select-Object -First 1; "
        "if ($es) { $s.SelectVoice($es.VoiceInfo.Name) }; "
        f"$s.Speak('{literal}')"
    )
    subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
         "-ExecutionPolicy", "Bypass", "-Command", script],
        check=False,
        capture_output=True,
    )


# ---------------------------------------------------------------------------
# Modelo local
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "Eres mar.ia, la asistente local de este PC. Respondes en español de España, "
    "en una o dos frases como mucho, porque tu respuesta se lee en voz alta. "
    "Cuando el usuario pida una accion sobre el ordenador o sobre ULTRON, usa una "
    "herramienta en vez de describir lo que harias. Si la orden no esta clara, "
    "pregunta una sola cosa concreta."
)


def ask_llm(prompt: str, tools: list[dict[str, Any]], keep_alive: str) -> dict[str, Any]:
    """Una vuelta contra Ollama. Devuelve el mensaje crudo (texto y/o llamadas
    a herramienta).

    `think=False` es obligatorio: con el razonamiento activado este modelo gasta
    los tokens pensando y devuelve contenido vacio (verificado el 17/09/2026).
    """
    import urllib.request

    body = json.dumps({
        "model": LLM_MODEL,
        "stream": False,
        "think": False,
        "keep_alive": keep_alive,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        "tools": tools,
        "options": {"num_ctx": 8192, "num_predict": 300, "temperature": 0.4},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat", data=body, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("message", {}) or {}


# ---------------------------------------------------------------------------
# Escucha
# ---------------------------------------------------------------------------


@dataclass
class Recorder:
    """Captura del microfono con corte por silencio.

    El modelo de transcripcion se carga PEREZOSAMENTE, en la primera escucha:
    arrancar el sidecar no debe costar 2,5 GB de VRAM si hoy no le hablas.
    """

    model: Any | None = None
    # cancel: tirar lo grabado. stop: cerrar la grabacion y transcribirla.
    # Son cosas distintas: soltar la tecla de hablar NO puede descartar lo que
    # acabas de decir.
    cancel: threading.Event = field(default_factory=threading.Event)
    stop: threading.Event = field(default_factory=threading.Event)

    def ensure_model(self) -> Any:
        if self.model is None:
            from faster_whisper import WhisperModel

            log("cargando faster-whisper large-v3-turbo (int8)")
            # int8 sobre GPU: ~2,5 GB y ~12x tiempo real. Si no hay CUDA, cae a
            # CPU en vez de reventar.
            try:
                self.model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8")
            except Exception as exc:  # noqa: BLE001 - degradar, no morir
                log(f"sin CUDA ({exc}); transcribiendo en CPU")
                self.model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
        return self.model

    def record_utterance(self) -> bytes:
        """Graba hasta que detecta silencio sostenido. Devuelve PCM 16 kHz mono."""
        import numpy as np
        import sounddevice as sd

        frames: list[bytes] = []
        silence_frames = 0
        voiced = False
        needed_silence = SILENCE_MS // FRAME_MS
        block = int(SAMPLE_RATE * FRAME_MS / 1000)
        started = time.monotonic()

        with sd.RawInputStream(
            samplerate=SAMPLE_RATE, blocksize=block, dtype="int16", channels=1
        ) as stream:
            while True:
                if self.cancel.is_set():
                    return b""
                if self.stop.is_set():
                    # Se solto la tecla: se cierra la toma con lo que haya.
                    break
                data, _overflow = stream.read(block)
                pcm = bytes(data)
                frames.append(pcm)

                samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
                rms = float(np.sqrt(np.mean(samples * samples))) if samples.size else 0.0
                emit("amp", amp=min(1.0, rms * 8))

                if rms >= SILENCE_RMS:
                    voiced = True
                    silence_frames = 0
                elif voiced:
                    silence_frames += 1
                    if silence_frames >= needed_silence:
                        break

                if time.monotonic() - started > MAX_UTTERANCE_S:
                    log("tope de duracion alcanzado; corto la grabacion")
                    break

        # `voiced` exige que haya habido algo por encima del ruido de sala: si
        # se pulsa la tecla y no se dice nada, no se manda silencio a
        # transcribir (Whisper alucina texto sobre el silencio).
        return b"".join(frames) if voiced else b""

    def transcribe(self, pcm: bytes) -> str:
        import numpy as np

        if not pcm:
            return ""
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _info = self.ensure_model().transcribe(
            audio, language="es", vad_filter=True, beam_size=1
        )
        return " ".join(seg.text.strip() for seg in segments).strip()


# ---------------------------------------------------------------------------
# Herramientas expuestas al modelo
#
# Solo declaraciones: la ejecucion la hace la app (tiene los comandos, los
# permisos y el daemon). El sidecar emite {"event":"tool"} y el supervisor
# responde. Asi el sidecar no puede tocar el sistema por su cuenta.
# ---------------------------------------------------------------------------

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "abrir_app",
            "description": "Abre una aplicacion instalada en el PC.",
            "parameters": {
                "type": "object",
                "properties": {"nombre": {"type": "string"}},
                "required": ["nombre"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "delegar_a_agente",
            "description": (
                "Manda una tarea de programacion o analisis a ULTRON para que la "
                "ejecute un agente de Claude/Codex/Gemini."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "tarea": {"type": "string"},
                    "proyecto": {"type": "string"},
                },
                "required": ["tarea"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recordar",
            "description": "Busca en la memoria de ULTRON algo que se hablo antes.",
            "parameters": {
                "type": "object",
                "properties": {"consulta": {"type": "string"}},
                "required": ["consulta"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Bucle principal
# ---------------------------------------------------------------------------


def stdin_reader(commands: "queue.Queue[dict[str, Any]]") -> None:
    """Lee ordenes del supervisor. Hilo aparte: la escucha bloquea."""
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            commands.put(json.loads(line))
        except json.JSONDecodeError:
            emit("error", message=f"orden ilegible: {line[:120]}")


def acknowledge(calls: list[dict[str, Any]]) -> str:
    """Frase corta que describe las herramientas pedidas.

    No inventa resultados: dice lo que VA a hacer, no que este hecho. El
    resultado real lo confirma la app cuando ejecuta.
    """
    partes: list[str] = []
    for call in calls:
        fn = call.get("function", {}) or {}
        name = fn.get("name", "")
        args = fn.get("arguments", {}) or {}
        if name == "abrir_app":
            partes.append(f"abro {args.get('nombre', 'la aplicación')}")
        elif name == "delegar_a_agente":
            partes.append("se lo paso a un agente")
        elif name == "recordar":
            partes.append("lo busco en la memoria")
        elif name:
            partes.append(name.replace("_", " "))
    if not partes:
        return ""
    return ("Vale, " + " y ".join(partes) + ".").capitalize()


def handle_utterance(rec: Recorder, speak_fn: Callable[[str], None]) -> None:
    emit("state", state="listening")
    pcm = rec.record_utterance()
    if not pcm:
        emit("state", state="idle")
        return

    emit("state", state="thinking")
    text = rec.transcribe(pcm)
    if not text:
        emit("state", state="idle")
        return
    emit("transcript", text=text)

    message = ask_llm(text, TOOLS, KEEP_ALIVE_ACTIVE)
    calls = message.get("tool_calls") or []
    for call in calls:
        fn = call.get("function", {})
        emit("tool", name=fn.get("name", ""), args=fn.get("arguments", {}))

    reply = (message.get("content") or "").strip()
    # Cuando el modelo solo emite herramientas no devuelve texto, y entonces el
    # usuario se queda sin respuesta: oye silencio y no sabe si le ha hecho
    # caso. Se locuta un acuse de lo que va a hacer (verificado: "abre spotify"
    # devolvia tool_calls y content vacio).
    if not reply and calls:
        reply = acknowledge(calls)
    if reply:
        emit("reply", text=reply)
        emit("state", state="speaking")
        speak_fn(reply)
    emit("state", state="idle")


def main() -> int:
    commands: "queue.Queue[dict[str, Any]]" = queue.Queue()
    threading.Thread(target=stdin_reader, args=(commands,), daemon=True).start()
    rec = Recorder()
    emit("state", state="idle")
    log("sidecar de voz listo")

    while True:
        cmd = commands.get()
        name = cmd.get("cmd")
        if name == "shutdown":
            log("cierro")
            return 0
        if name == "ping":
            emit("pong")
            continue
        if name == "cancel":
            rec.cancel.set()
            continue
        if name == "stop":
            rec.stop.set()
            continue
        if name == "listen":
            rec.cancel.clear()
            rec.stop.clear()
            try:
                handle_utterance(rec, speak)
            except Exception as exc:  # noqa: BLE001 - un fallo no mata el sidecar
                emit("error", message=str(exc))
                emit("state", state="idle")
            continue
        emit("error", message=f"orden desconocida: {name}")


if __name__ == "__main__":
    raise SystemExit(main())
