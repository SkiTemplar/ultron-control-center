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
    {"cmd": "ask", "text": "..."}  mismo turno pero escrito, sin microfono
    {"cmd": "wake_on"}   activa la palabra clave ("María")
    {"cmd": "wake_off"}  la desactiva (el microfono queda cerrado)
    {"cmd": "stop"}      deja de grabar y TRANSCRIBE lo dicho (soltar la tecla)
    {"cmd": "cancel"}    aborta y TIRA el audio (no transcribe)
    {"cmd": "say", "text": "..."}  locuta ese texto (resultado de una
                                   herramienta que ejecuto la app)
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
viviendo en mar.ia. Este proceso solo convierte voz en intencion y devuelve voz.
"""

from __future__ import annotations

import datetime
import json
import math
import os
import pathlib
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
# El modelo se descarga EN CUANTO contesta: la GPU queda libre (774 MiB en
# reposo, medido). Decision explicita del usuario el 2026-09-18 ("se debe
# cargar y descargar por cada pregunta, es igual que tarde un poco mas"), asi
# que no se deja ninguna ventana de gracia: cada turno paga la carga (3,0 s en
# caliente, hasta 36 s en frio) a cambio de no reservar 6,6 GB de VRAM entre
# preguntas. El servidor `ollama serve` SI queda levantado (lo arranca la app
# al abrirse): lo que se descarga es el modelo, no el servicio.
KEEP_ALIVE_POR_TURNO = "0"

# --- idioma ----------------------------------------------------------------
# mar.ia CONTESTA en ingles. Lo pidio el usuario el 2026-09-21: "haz que maria
# solo me hable en ingles, ya que la voz se escucha mejor" — las voces inglesas
# de Windows (Zira, Mark) suenan bastante mejor que las españolas en esta
# maquina.
#
# Lo que NO cambia: se le sigue HABLANDO en español. Son dos idiomas distintos
# a proposito, uno por sentido:
IDIOMA_ESCUCHA = "es"   # lo que transcribe Whisper de lo que dices tu
IDIOMA_RESPUESTA = "en"  # en lo que contesta y con lo que se locuta

# --- palabra clave ---------------------------------------------------------
# Vosk (Apache-2.0) con el modelo pequeno de español: 58 MB en disco, corre en
# CPU y no pide cuenta, clave ni periodo de prueba. Se descarto Porcupine
# justamente por eso: su plan gratuito es un trial.
#
# El truco para que sea barato: en vez de transcribir todo lo que se oye, se
# le pasa una GRAMATICA de una sola frase. El reconocedor solo puede devolver
# esas palabras o "[unk]", asi que el trabajo por segundo de audio es minimo.
WAKE_MODEL_DIR = "models/vosk-model-small-es-0.42"
WAKE_WORDS = ["maria", "oye maria", "hola maria"]
# Variantes que suelta el reconocedor cuando oye el nombre. Sin acento: Vosk
# devuelve el texto normalizado del modelo.
WAKE_HITS = ("maria", "mar ia", "maría")

SAMPLE_RATE = 16_000
FRAME_MS = 30
# Silencio que da por terminada la orden. Lo pidio el usuario asi el
# 2026-09-19: "cuando deje de hablar unos 2 segundos, pare de escucharme y
# responda". Antes eran 900 ms.
SILENCE_MS = 2000
# Tope duro: si algo se queda enganchado, no grabamos indefinidamente.
MAX_UTTERANCE_S = 30
# Y un tope MUY anterior para cuando no se ha oido ni una palabra. Este es el
# que arregla el "se queda todo el rato escuchando" (2026-09-19): sin el, un
# microfono mudo o una activacion por error tenian al orbe escuchando los 30 s
# enteros antes de rendirse. Ocho segundos son de sobra para empezar a hablar.
SIN_VOZ_S = 8

# --- cuando hay voz y cuando no --------------------------------------------
# Esto ERA un umbral fijo (SILENCE_RMS = 0.012) y era el fallo: el usuario
# hablaba, la palabra clave le oia y luego no se transcribia nada y el orbe se
# quedaba en "escuchando" hasta el tope de 30 s.
#
# Medido en este equipo el 2026-09-19: el microfono de los auriculares da un
# ruido ambiente de 0,00001 RMS, mil veces por debajo de aquel umbral. Con esa
# ganancia, la voz tampoco llegaba a 0,012 y la grabacion se descartaba entera
# (`voiced` nunca se ponia a True). Vosk si le oia porque normaliza el nivel
# por dentro; la puerta de grabacion, no.
#
# Ahora el umbral es RELATIVO al ruido de la sala, que es lo unico que funciona
# igual con un microfono flojo y con uno caliente:
#     umbral = max(ruido_medido * FACTOR_VOZ, PISO_RMS)
FACTOR_VOZ = 6.0
# Piso de seguridad, por si el ruido medido fuese cero absoluto (silencio
# digital). -80 dBFS: cualquier voz real lo pasa.
PISO_RMS = 0.0001
# El ruido de la sala se estima con el frame MAS FLOJO visto hasta ahora, no
# con los primeros 300 ms.
#
# Por que: si empiezas a hablar en el mismo instante en que se abre el
# microfono (que es lo normal con ctrl+espacio), esos 300 ms son TU VOZ. El
# umbral salia entonces seis veces por encima de tu propio volumen, no se
# detectaba voz en toda la toma y el orbe se quedaba en "te escucho" hasta el
# tope. Reportado el 2026-09-20: "Maria se queda en listening todo el rato".
#
# Con el minimo continuo, el umbral solo puede BAJAR segun avanza la toma, asi
# que una toma que empieza hablando se corrige sola en cuanto hay una pausa.
SUELO_INICIAL = 0.002
# Por debajo de esta fraccion del PICO de la toma, se considera que ya no
# hablas. Es lo que decide cuando cortar, y va contra el pico y no contra el
# ruido a proposito: el silencio entre frases esta ~16 dB por debajo de la voz,
# pase lo que pase con la ganancia del microfono.
FRACCION_SILENCIO = 0.15


# Turno en marcha (grabando, pensando o hablando). Lo consulta el escuchador
# de palabra clave para soltar el microfono y no oirse a si misma.
busy = threading.Event()


# stdout en UTF-8, pase lo que pase. Python en Windows usa la pagina de codigos
# ANSI del sistema (cp1252 aqui), asi que "linea" con tilde salia como un byte
# 0xED suelto y el supervisor leia basura: el saludo llegaba como "l?nea" y un
# lector estricto se rompia con UnicodeDecodeError (medido el 2026-09-19).
for _flujo in (sys.stdout, sys.stderr):
    try:
        _flujo.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        # Flujo ya envuelto o sin reconfigure: se sigue igual.
        pass

# Un solo escritor a la vez en stdout. Sin este candado, el sidecar MORIA al
# arrancar: el saludo, su envolvente y el bucle principal escribian a la vez en
# la tuberia y el flush petaba con `OSError: [Errno 22] Invalid argument`, que
# a su vez tumbaba el proceso (visto en logs/maria-voz.log el 2026-09-19).
_SALIDA = threading.Lock()
# Se levanta cuando stdout deja de existir: el supervisor se ha ido y no hay
# nada que hacer aqui. El bucle principal lo mira para salir limpio.
SALIDA_ROTA = threading.Event()


def emit(event: str, **fields: Any) -> None:
    """Escribe un evento en stdout. Una linea, con flush: el supervisor lee
    linea a linea y sin flush el orbe se quedaria congelado.

    Es seguro llamarlo desde varios hilos (voz, envolvente, bucle principal).
    """
    payload = {"event": event, **fields}
    linea = json.dumps(payload, ensure_ascii=False) + "\n"
    with _SALIDA:
        try:
            sys.stdout.write(linea)
            sys.stdout.flush()
        except (OSError, ValueError):
            # La tuberia se ha cerrado: el padre ya no esta. No se re-lanza el
            # error — eso mataba el hilo y dejaba el microfono cogido.
            SALIDA_ROTA.set()


def log(message: str) -> None:
    emit("log", message=message)


# ---------------------------------------------------------------------------
# Voz (TTS) — SAPI de Windows
# ---------------------------------------------------------------------------


# Ritmo de habla de SAPI en español, medido a ojo sobre frases reales: unas
# 2,8 palabras por segundo. Sirve para saber CUANTO va a durar la frase y
# animar el orbe mientras tanto.
PALABRAS_POR_SEGUNDO = 2.8
# Cada cuanto se manda un nivel al orbe mientras habla.
PASO_ENVOLVENTE_S = 0.06


def _envolvente_al_hablar(text: str, parar: "threading.Event") -> None:
    """Manda niveles al orbe mientras SAPI habla, para que se mueva al ritmo
    de la frase.

    LIMITE DECLARADO: esto NO es el audio real. SAPI no devuelve el nivel de
    salida, asi que se sintetiza una envolvente a partir de la cadencia del
    texto (silabas aproximadas y pausas en las comas y los puntos). Es una
    ANIMACION creible, no una medicion — y por eso esta escrito aqui y no
    disfrazado de `amp` del microfono.
    """
    palabras = max(1, len(text.split()))
    duracion = palabras / PALABRAS_POR_SEGUNDO
    t = 0.0
    fase = 0.0
    while not parar.is_set() and t < duracion + 1.5:
        # Dos senos desfasados: sube y baja como una voz, sin repetirse igual.
        fase += PASO_ENVOLVENTE_S * 9.0
        nivel = 0.35 + 0.30 * math.sin(fase) + 0.18 * math.sin(fase * 0.37 + 1.1)
        emit("amp", amp=max(0.05, min(1.0, nivel)))
        parar.wait(PASO_ENVOLVENTE_S)
        t += PASO_ENVOLVENTE_S
    emit("amp", amp=0.0)


def speak(text: str) -> None:
    """Dice `text` en voz alta.

    El trabajo lo hace `hablar.ps1`, que elige el mejor motor disponible:
    Piper (neuronal, si esta instalado) > WinRT (voces Laura/Pablo) > SAPI.
    Antes se llamaba a SAPI directamente con la voz "Helena Desktop", que es la
    mas vieja de las tres que hay en español en esta maquina y la que sonaba a
    robot (el usuario lo pidio el 2026-09-19).

    El texto viaja por STDIN, no por la linea de comandos: asi no hay comillas
    que escapar y una frase no puede inyectar nada en el script.

    Mientras habla se manda una envolvente al orbe (ver
    `_envolvente_al_hablar`) para que se vea que esta hablando.
    """
    if not text.strip():
        return
    script = pathlib.Path(__file__).resolve().parent / "hablar.ps1"
    if not script.exists():
        log(f"no encuentro {script}: sin voz")
        return

    creationflags = 0x0800_0000 if sys.platform == "win32" else 0
    parar = threading.Event()
    animacion = threading.Thread(
        target=_envolvente_al_hablar, args=(text, parar), daemon=True
    )
    animacion.start()
    try:
        res = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
             "-File", str(script), "-Idioma", IDIOMA_RESPUESTA],
            input=text,
            text=True,
            encoding="utf-8",
            capture_output=True,
            creationflags=creationflags,
            timeout=120,
        )
        if res.returncode != 0:
            log(f"la voz fallo: {(res.stderr or '').strip()[:200]}")
    except subprocess.TimeoutExpired:
        log("la voz tardo demasiado y se corto")
    finally:
        # La animacion se corta con la voz, pase lo que pase: dejarla viva
        # tras un fallo dejaria el orbe latiendo en silencio para siempre.
        parar.set()
        animacion.join(timeout=1.0)


# ---------------------------------------------------------------------------
# Modelo local
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = (
    "You are mar.ia, the local assistant on this PC. The user speaks to you in "
    "Spanish; you ALWAYS answer in English, in one or two sentences at most, "
    "because your answer is read out loud. When the user asks for an action on "
    "the computer or the system, call a tool instead of describing what you "
    "would do. If the request is unclear, ask one concrete question."
)

# Dias y meses a mano: el sidecar no fija el locale del sistema, y con el locale
# por defecto `strftime("%A")` sale en ingles.
DIAS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MESES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


def contexto_de_ahora() -> str:
    """Fecha, hora y equipo, para que no tenga que adivinarlos.

    Un modelo de lenguaje no sabe que dia es: lo unico que puede hacer es
    inventarselo a partir de su entrenamiento, y eso es lo que paso — el
    usuario le pregunto la fecha el 2026-09-19 y no supo decirsela. No es un
    problema de permisos ni de herramientas: el dato hay que darselo, y darselo
    en cada turno porque cambia.
    """
    import getpass
    import platform

    ahora = datetime.datetime.now().astimezone()
    fecha = f"{DIAS[ahora.weekday()]} {ahora.day} {MESES[ahora.month - 1]} {ahora.year}"
    try:
        equipo = platform.node() or "este PC"
        usuario = getpass.getuser()
    except Exception:  # noqa: BLE001 - el contexto nunca puede tumbar un turno
        equipo, usuario = "este PC", "el usuario"
    return (
        f"Real context RIGHT NOW (use it, do not guess): "
        f"today is {fecha}; the time is {ahora:%H:%M} ({ahora.tzname()}); "
        f"the machine is called {equipo} and the session belongs to {usuario}. "
        f"For any other fact about the computer or the network use the "
        f"estado_del_sistema tool; for errors and warnings, mirar_registros."
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
            {"role": "system", "content": contexto_de_ahora()},
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


_VOSK_MODELO: Any | None = None
_VOSK_LOCK = threading.Lock()


def reconocedor_libre(modelo: Any) -> Any:
    """Reconocedor de gramatica libre, para la transcripcion en vivo.

    Funcion aparte para poder sustituirla en las pruebas: el comportamiento
    pegajoso de `PartialResult` es justo lo que hay que poder imitar.
    """
    from vosk import KaldiRecognizer

    return KaldiRecognizer(modelo, SAMPLE_RATE)


def modelo_vosk() -> Any:
    """El modelo pequeno de Vosk, cargado una sola vez.

    Lo usan dos cosas: la palabra clave (con gramatica de una frase) y la
    transcripcion en vivo mientras hablas (con gramatica libre). Cargarlo dos
    veces serian 58 MB de disco y ~100 MB de RAM repetidos para nada.
    """
    global _VOSK_MODELO
    with _VOSK_LOCK:
        if _VOSK_MODELO is None:
            from vosk import Model, SetLogLevel

            SetLogLevel(-1)
            ruta = pathlib.Path(__file__).with_name("models").joinpath(
                pathlib.Path(WAKE_MODEL_DIR).name
            )
            _VOSK_MODELO = Model(str(ruta))
        return _VOSK_MODELO


MODELO_STT = "large-v3-turbo"


def _registrar_dlls_cuda() -> None:
    """Deja a la vista cuBLAS y cuDNN si estan instalados como paquetes de pip.

    `scripts/instalar-voz-gpu.ps1` los mete en site-packages/nvidia/*/bin, donde
    Windows no los busca solo.

    Se hace por DOS vias, y hacen falta las dos:

      * `os.add_dll_directory` — la via moderna, pero solo la consulta quien
        carga con `LOAD_LIBRARY_SEARCH_USER_DIRS`.
      * el PATH del proceso — CTranslate2 (el motor de faster-whisper) pide
        `cublas64_12.dll` por nombre y con la busqueda estandar, que NO mira
        los directorios de la via anterior. Medido el 2026-09-21: con los
        paquetes ya instalados y `add_dll_directory` puesto, seguia diciendo
        "Library cublas64_12.dll is not found or cannot be loaded"; añadiendo
        la carpeta al PATH, carga.

    Silencioso a proposito: si no estan, se sigue por CPU.
    """
    base = pathlib.Path(sys.executable).parent.parent / "Lib" / "site-packages" / "nvidia"
    for sub in ("cublas", "cudnn", "cuda_nvrtc"):
        carpeta = base / sub / "bin"
        if not carpeta.is_dir():
            continue
        if hasattr(os, "add_dll_directory"):
            try:
                os.add_dll_directory(str(carpeta))
            except OSError:
                pass
        actual = os.environ.get("PATH", "")
        if str(carpeta) not in actual:
            os.environ["PATH"] = f"{carpeta}{os.pathsep}{actual}"


def cargar_whisper(forzar_cpu: bool = False) -> Any:
    """Carga faster-whisper en la GPU si REALMENTE puede, y si no en la CPU.

    Por que una prueba de verdad y no un try alrededor del constructor: el
    constructor con `device="cuda"` funciona aunque falten las librerias de
    CUDA. El error salta despues, al codificar el primer audio:

        RuntimeError: Library cublas64_12.dll is not found or cannot be loaded

    Y eso es exactamente lo que estaba pasando (medido el 2026-09-19 en este
    equipo, que no tiene cuBLAS instalado): la palabra clave te oia, la
    grabacion iba bien, y al transcribir reventaba. Desde fuera se veia como
    "se queda escuchando y no escribe nada".

    Asi que se transcribe un segundo de silencio con `vad_filter=False`, que
    obliga a pasar por el codificador. Si ahi falla, no hay GPU util.

    CPU mide 4 s por cada 3 s de audio en esta maquina; la GPU seria ~0,3 s.
    Para tenerla: scripts\\instalar-voz-gpu.ps1 (baja cuBLAS y cuDNN, ~700 MB).
    """
    import numpy as np

    _registrar_dlls_cuda()
    from faster_whisper import WhisperModel

    if not forzar_cpu:
        try:
            m = WhisperModel(MODELO_STT, device="cuda", compute_type="int8")
            mudo = np.zeros(16_000, dtype=np.float32)
            segs, _ = m.transcribe(mudo, language="es", beam_size=1, vad_filter=False)
            list(segs)  # perezoso: sin consumirlo no se codifica nada
            log(f"transcripcion en GPU ({MODELO_STT}, int8)")
            return m
        except Exception as exc:  # noqa: BLE001 - degradar, no morir
            log(
                f"la GPU no puede transcribir ({type(exc).__name__}: {exc}); "
                f"uso la CPU. Para la GPU: scripts\\instalar-voz-gpu.ps1"
            )

    log(f"transcripcion en CPU ({MODELO_STT}, int8)")
    return WhisperModel(MODELO_STT, device="cpu", compute_type="int8")


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
            self.model = cargar_whisper()
        return self.model

    def record_utterance(self) -> bytes:
        """Graba hasta que detecta silencio sostenido. Devuelve PCM 16 kHz mono.

        Dos cosas van en paralelo mientras grabas:

        * El NIVEL, para saber cuando has terminado. El umbral se calcula con
          el ruido real de la sala (ver FACTOR_VOZ): con un umbral fijo, un
          microfono flojo no abria nunca la puerta y la toma se tiraba entera.
        * La TRANSCRIPCION EN VIVO con Vosk, que se emite segun hablas. El
          usuario lo pidio el 2026-09-19: "todas mis voces deberian
          transcribirse al momento para saber exactamente el mensaje que le van
          a dar". Ademas sirve de segunda opinion sobre si hay voz: Vosk
          normaliza el nivel, asi que oye aunque el microfono venga bajito.

        Lo definitivo lo dice Whisper despues; esto es el subtitulo mientras
        hablas.
        """
        import numpy as np
        import sounddevice as sd

        try:
            vivo = reconocedor_libre(modelo_vosk())
        except Exception as exc:  # noqa: BLE001 - sin parciales se sigue grabando
            log(f"sin transcripcion en vivo ({exc})")
            vivo = None

        frames: list[bytes] = []
        silence_frames = 0
        voiced = False
        ultimo_parcial = ""
        needed_silence = SILENCE_MS // FRAME_MS
        block = int(SAMPLE_RATE * FRAME_MS / 1000)
        # Suelo de ruido: arranca alto y baja con cada frame mas flojo.
        ruido = SUELO_INICIAL
        # Frame mas fuerte visto. Con el suelo se decide si hubo voz.
        pico = 0.0
        # Vosk ha llegado a reconocer algo en algun momento de la toma.
        hubo_texto = False
        umbral = max(ruido * FACTOR_VOZ, PISO_RMS)
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
                # El medidor del orbe se escala contra el umbral, no contra un
                # numero fijo: si no, con este microfono la bolita no se movia.
                emit("amp", amp=min(1.0, rms / (umbral * 4)))

                # El suelo de ruido solo baja: el frame mas flojo de la toma
                # es la mejor estimacion de "la sala callada".
                if rms < ruido:
                    ruido = rms
                    umbral = max(ruido * FACTOR_VOZ, PISO_RMS)

                # Y la decision de "aqui ha habido voz" se REHACE con el umbral
                # de ahora, no con el que hubiera cuando paso el frame. Es lo
                # que permite empezar a hablar en el mismo instante en que se
                # abre el microfono: mientras hablas el suelo esta alto y no
                # cuenta como voz, pero en cuanto callas el suelo baja, el
                # umbral baja con el y el pico que ya habia pasado se reconoce
                # hacia atras.
                pico = max(pico, rms)

                # Texto nuevo de Vosk en ESTE frame.
                #
                # OJO con la diferencia, que es el fallo que costo dos dias:
                # `PartialResult()` NO se vacia. Una vez reconocida una
                # palabra, devuelve el mismo texto en todos los frames
                # siguientes, tambien en los de silencio. Usarlo como "hay voz
                # ahora" dejaba el contador de silencio a cero para siempre y
                # la toma no se cerraba nunca: 30 s de tope + Whisper en CPU =
                # los dos minutos que reporto el usuario el 2026-09-21.
                #
                # Lo que si es señal de voz AHORA es que el parcial CREZCA.
                texto_nuevo = False
                if vivo is not None:
                    try:
                        if vivo.AcceptWaveform(pcm):
                            trozo = json.loads(vivo.Result()).get("text", "")
                        else:
                            trozo = json.loads(vivo.PartialResult()).get("partial", "")
                        trozo = (trozo or "").strip()
                        if trozo:
                            hubo_texto = True
                        if trozo and trozo != ultimo_parcial:
                            ultimo_parcial = trozo
                            texto_nuevo = True
                            emit("parcial", text=trozo)
                    except Exception:  # noqa: BLE001 - el parcial es un extra
                        vivo = None

                # Umbral de corte: una fraccion del pico de la toma. Contra el
                # pico y no contra el ruido, porque el ruido medido acaba
                # siendo casi cero (hay microsilencios entre silabas) y
                # entonces cualquier respiracion contaba como voz.
                umbral_corte = max(pico * FRACCION_SILENCIO, umbral)

                if pico >= umbral or hubo_texto:
                    voiced = True
                if rms >= umbral_corte or texto_nuevo:
                    silence_frames = 0
                elif voiced:
                    silence_frames += 1
                    if silence_frames >= needed_silence:
                        break

                transcurrido = time.monotonic() - started
                if not voiced and transcurrido > SIN_VOZ_S:
                    log(f"{SIN_VOZ_S} s sin oir nada; dejo de escuchar")
                    break
                if transcurrido > MAX_UTTERANCE_S:
                    log("tope de duracion alcanzado; corto la grabacion")
                    break

        log(
            f"suelo {ruido:.5f} pico {pico:.5f} -> corte "
            f"{max(pico * FRACCION_SILENCIO, umbral):.5f}, voz={voiced}"
        )
        # `voiced` exige que haya habido algo por encima del ruido de sala: si
        # se pulsa la tecla y no se dice nada, no se manda silencio a
        # transcribir (Whisper alucina texto sobre el silencio).
        return b"".join(frames) if voiced else b""

    def transcribe(self, pcm: bytes) -> str:
        import numpy as np

        if not pcm:
            return ""
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        # Normalizado de nivel: este microfono entrega picos de 0,01 y Whisper
        # con audio tan bajo se inventa texto o devuelve vacio. Se sube hasta
        # 0,8 de pico. Si la toma ya viene fuerte, no se toca.
        pico = float(np.abs(audio).max()) if audio.size else 0.0
        if 0.0 < pico < 0.8:
            audio = audio * (0.8 / pico)

        def intento(modelo: Any) -> str:
            segments, _info = modelo.transcribe(
                audio, language=IDIOMA_ESCUCHA, vad_filter=True, beam_size=1
            )
            return " ".join(seg.text.strip() for seg in segments).strip()

        try:
            return intento(self.ensure_model())
        except Exception as exc:  # noqa: BLE001 - una toma no puede perderse
            # Red de seguridad: si la GPU se cae a mitad (se quedo sin memoria,
            # falta una libreria que la prueba no vio), se rehace en CPU y se
            # vuelve a intentar. Perder lo que acabas de decir por un fallo de
            # driver no es aceptable.
            log(f"fallo al transcribir ({type(exc).__name__}: {exc}); reintento en CPU")
            self.model = cargar_whisper(forzar_cpu=True)
            return intento(self.model)


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
            "name": "estado_del_sistema",
            "description": (
                "Datos reales de este ordenador AHORA: CPU, memoria, disco, GPU y "
                "si hay conexion a internet. Usala para cualquier pregunta sobre "
                "como va el PC o si hay red."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "mirar_registros",
            "description": (
                "Lee los ultimos registros de este ordenador: los de mar.ia y los "
                "errores recientes de Windows. Usala cuando pregunten que ha "
                "fallado, por que algo no funciona o que ha pasado."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "fuente": {
                        "type": "string",
                        "enum": ["maria", "windows"],
                        "description": "maria = los logs del programa; windows = el visor de eventos.",
                    }
                },
            },
        },
    },
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
                "Manda una tarea de programacion o analisis a un agente para que la "
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
            "description": "Busca en tu memoria algo que se hablo antes.",
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


def wake_text_is_hit(text: str) -> bool:
    """¿El reconocedor ha oido la palabra clave?

    Se compara sobre el texto normalizado y con `in`: el modelo pequeno suele
    devolver la frase entera de la gramatica ("oye maria"), y a veces la parte.
    """
    limpio = " ".join(text.lower().split())
    return any(h in limpio for h in WAKE_HITS)


class WakeListener:
    """Escucha continua de la palabra clave.

    Vive en su propio hilo y solo publica un aviso: NO graba, NO guarda audio y
    NO transcribe nada mas que la gramatica. Cuando acierta, pone la orden
    `listen` en la cola principal, que es la que si abre la toma completa.
    """

    def __init__(self, commands: "queue.Queue[dict[str, Any]]") -> None:
        self.commands = commands
        self.stop = threading.Event()
        self.thread: threading.Thread | None = None

    def start(self) -> None:
        if self.thread and self.thread.is_alive():
            return
        self.stop.clear()
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def halt(self) -> None:
        self.stop.set()

    def _run(self) -> None:
        try:
            import json as _json
            import sounddevice as sd
            from vosk import KaldiRecognizer

            grammar = _json.dumps(WAKE_WORDS + ["[unk]"])
            rec = KaldiRecognizer(modelo_vosk(), SAMPLE_RATE, grammar)
            log("palabra clave activa: di «María»")

            block = int(SAMPLE_RATE * FRAME_MS / 1000)
            while not self.stop.is_set():
                # Mientras hay un turno en marcha, el escuchador SUELTA el
                # microfono: si lo mantuviera abierto grabaria la respuesta
                # hablada de mar.ia y se despertaria a si misma, ademas de
                # pelearse con la toma de `record_utterance` por el
                # dispositivo.
                if busy.is_set():
                    busy.wait(0.15)
                    continue
                with sd.RawInputStream(
                    samplerate=SAMPLE_RATE, blocksize=block, dtype="int16", channels=1
                ) as stream:
                    while not self.stop.is_set() and not busy.is_set():
                        data, _overflow = stream.read(block)
                        pcm = bytes(data)
                        if rec.AcceptWaveform(pcm):
                            hit = wake_text_is_hit(
                                _json.loads(rec.Result()).get("text", "")
                            )
                        else:
                            # El parcial dispara antes: la palabra clave tiene
                            # que notarse instantanea, no al acabar la frase.
                            hit = wake_text_is_hit(
                                _json.loads(rec.PartialResult()).get("partial", "")
                            )
                        if hit:
                            rec.Reset()
                            emit("wake")
                            busy.set()  # cierra este stream en la vuelta de arriba
                            self.commands.put({"cmd": "listen"})
                            break
        except Exception as exc:  # noqa: BLE001 - sin palabra clave se sigue con la tecla
            emit("error", message=f"palabra clave desactivada: {exc}")


def stdin_reader(commands: "queue.Queue[dict[str, Any]]") -> None:
    """Lee ordenes del supervisor. Hilo aparte: la escucha bloquea.

    Cuando stdin se cierra, el padre ha muerto: se manda `shutdown` para que
    el bucle principal salga. Sin esto el sidecar quedaba huerfano esperando
    ordenes eternamente y RETENIENDO EL MICROFONO (medido: 4 procesos vivos
    tras varios arranques de la app, 2026-09-18).
    """
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            commands.put(json.loads(line))
        except json.JSONDecodeError:
            emit("error", message=f"orden ilegible: {line[:120]}")
    commands.put({"cmd": "shutdown"})


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
            partes.append(f"opening {args.get('nombre', 'the app')}")
        elif name == "delegar_a_agente":
            partes.append("handing it to an agent")
        elif name == "recordar":
            partes.append("looking it up in memory")
        elif name:
            partes.append(name.replace("_", " "))
    if not partes:
        return ""
    return ("OK, " + " and ".join(partes) + ".").capitalize()


def handle_utterance(rec: Recorder, speak_fn: Callable[[str], None]) -> None:
    """Un turno completo: grabar, transcribir y contestar.

    Los dos caminos que no llevan a respuesta AVISAN. Antes volvian a "idle" en
    silencio y desde fuera era imposible distinguir "no te he oido" de "me he
    colgado": el usuario veia el orbe escuchando y nada mas.
    """
    emit("state", state="listening")
    pcm = rec.record_utterance()
    if not pcm:
        emit("state", state="idle")
        emit("transcript", text="(I heard nothing: check the microphone)")
        log("grabacion vacia: ninguna muestra por encima del umbral")
        return

    emit("state", state="thinking")
    text = rec.transcribe(pcm)
    if not text:
        emit("state", state="idle")
        emit("transcript", text="(I could not make out what you said)")
        log("whisper no devolvio texto para una toma con voz")
        return
    process_text(text, speak_fn)


def process_text(text: str, speak_fn: Callable[[str], None]) -> None:
    """Turno a partir de TEXTO ya conocido.

    Lo comparten la voz (tras transcribir) y la linea de comando escrita de la
    pantalla principal: misma cabeza, mismas herramientas, misma respuesta
    hablada. Sin esto habria dos caminos que divergirian a la primera.

    El estado "thinking" lo emite el LLAMANTE: la voz ya lo puso antes de
    transcribir, y emitirlo aqui otra vez lo duplicaba.
    """
    emit("transcript", text=text)

    # Quien contesta por voz es SIEMPRE el modelo local: la voz no pasa por el
    # relevo de proveedores (eso es el chat). Si Ollama no esta, antes se
    # quedaba MUDA — el usuario hablaba y no pasaba nada. Ahora lo dice.
    try:
        message = ask_llm(text, TOOLS, KEEP_ALIVE_POR_TURNO)
    except Exception as e:  # urllib lanza de muchas formas distintas
        log(f"el modelo local no contesta: {e}")
        aviso = (
            "I cannot think right now: the local model is not answering. "
            "Check that Ollama is running."
        )
        emit("reply", text=aviso)
        emit("state", state="speaking")
        speak_fn(aviso)
        emit("state", state="idle")
        return
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


def saludo_de_bienvenida() -> str:
    """Saludo segun la hora. Frase fija a proposito: cargar el modelo (6,6 GB)
    para decir "buenos dias" seria pagar 3 segundos y toda la VRAM por una
    cortesia."""
    hora = time.localtime().tm_hour
    if 6 <= hora < 13:
        momento = "Good morning"
    elif 13 <= hora < 21:
        momento = "Good afternoon"
    else:
        momento = "Good evening"
    return f"{momento}. mar.ia online, I am listening."


def main() -> int:
    commands: "queue.Queue[dict[str, Any]]" = queue.Queue()
    threading.Thread(target=stdin_reader, args=(commands,), daemon=True).start()
    rec = Recorder()
    wake = WakeListener(commands)
    emit("state", state="idle")
    log("sidecar de voz listo")

    # Saludo al despertar: el usuario lo pidio ("que me salude segun
    # despierte"). Va en un hilo aparte para no retrasar la primera orden, y
    # se puede apagar con MARIA_SIN_SALUDO=1.
    if os.environ.get("MARIA_SIN_SALUDO", "") != "1":
        def _saludar() -> None:
            # Medio segundo de cortesia: al arrancar llega `wake_on` y se monta
            # el detector. Saludar en ese mismo instante competia por el
            # microfono y por la salida.
            time.sleep(0.6)
            frase = saludo_de_bienvenida()
            emit("reply", text=frase)
            emit("state", state="speaking")
            speak(frase)
            emit("state", state="idle")

        threading.Thread(target=_saludar, daemon=True).start()

    while True:
        try:
            cmd = commands.get(timeout=1.0)
        except queue.Empty:
            if SALIDA_ROTA.is_set():
                wake.halt()
                return 0
            continue
        name = cmd.get("cmd")
        if name == "shutdown":
            wake.halt()
            log("cierro")
            return 0
        if name == "wake_on":
            wake.start()
            continue
        if name == "wake_off":
            wake.halt()
            log("palabra clave desactivada")
            continue
        if name == "ping":
            emit("pong")
            continue
        if name == "cancel":
            rec.cancel.set()
            continue
        if name == "stop":
            rec.stop.set()
            continue
        if name == "say":
            # La app ya ejecuto la herramienta y manda el resultado REAL para
            # locutarlo. El sidecar no inventa el desenlace: solo pone la voz.
            texto = str(cmd.get("text") or "").strip()
            if texto:
                emit("reply", text=texto)
                emit("state", state="speaking")
                speak(texto)
                emit("state", state="idle")
            continue
        if name == "ask":
            texto = str(cmd.get("text") or "").strip()
            if not texto:
                continue
            busy.set()
            try:
                emit("state", state="thinking")
                process_text(texto, speak)
            except Exception as exc:  # noqa: BLE001
                emit("error", message=str(exc))
                emit("state", state="idle")
            finally:
                busy.clear()
            continue
        if name == "listen":
            rec.cancel.clear()
            rec.stop.clear()
            busy.set()
            try:
                handle_utterance(rec, speak)
            except Exception as exc:  # noqa: BLE001 - un fallo no mata el sidecar
                emit("error", message=str(exc))
                emit("state", state="idle")
            finally:
                # Pase lo que pase, el turno se cierra: si no, el escuchador
                # de palabra clave se quedaria esperando para siempre y mar.ia
                # dejaria de responder al nombre.
                busy.clear()
            continue
        emit("error", message=f"orden desconocida: {name}")


if __name__ == "__main__":
    raise SystemExit(main())
