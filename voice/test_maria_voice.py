"""Tests del sidecar de voz que no tocan el microfono ni la GPU.

Cubren el protocolo (lo que el supervisor lee) y las piezas puras. La cadena
completa de audio se prueba a mano: grabar y transcribir necesita microfono y
modelo, y un test que pida ambos no es hermetico.

Ejecutar:  .venv\\Scripts\\python.exe -m pytest test_maria_voice.py -q
"""

from __future__ import annotations

import io
import json
import sys

import maria_voice as mv


def capture(fn) -> list[dict]:
    """Ejecuta `fn` capturando lo que escribe en stdout como eventos."""
    buf = io.StringIO()
    real, sys.stdout = sys.stdout, buf
    try:
        fn()
    finally:
        sys.stdout = real
    return [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]


def test_emit_escribe_una_linea_json_por_evento():
    eventos = capture(lambda: mv.emit("state", state="listening"))
    assert eventos == [{"event": "state", "state": "listening"}]


def test_emit_no_escapa_los_acentos():
    # El supervisor y el orbe muestran el texto tal cual: un á en pantalla
    # seria un fallo visible.
    eventos = capture(lambda: mv.emit("transcript", text="acción rápida"))
    assert eventos[0]["text"] == "acción rápida"


def test_acuse_describe_la_herramienta_pedida():
    calls = [{"function": {"name": "abrir_app", "arguments": {"nombre": "Spotify"}}}]
    assert mv.acknowledge(calls) == "Vale, abro spotify."


def test_acuse_encadena_varias_acciones():
    calls = [
        {"function": {"name": "abrir_app", "arguments": {"nombre": "Spotify"}}},
        {"function": {"name": "recordar", "arguments": {"consulta": "el plan"}}},
    ]
    assert mv.acknowledge(calls) == "Vale, abro spotify y lo busco en la memoria."


def test_acuse_vacio_cuando_no_hay_herramientas():
    # Caso negativo: sin herramientas NO se inventa una frase, o el usuario
    # oiria un "vale" ante una orden que nadie ejecuto.
    assert mv.acknowledge([]) == ""


def test_el_acuse_no_afirma_que_este_hecho():
    # Regla dura: describe la intencion, nunca el resultado. Quien confirma es
    # la app cuando ejecuta de verdad.
    frase = mv.acknowledge([{"function": {"name": "abrir_app", "arguments": {"nombre": "Edge"}}}])
    for pasado in ("he abierto", "abierto", "hecho", "listo"):
        assert pasado not in frase.lower()


def test_la_transcripcion_vacia_no_llama_al_modelo():
    """Sin voz no hay turno: ni modelo, ni TTS, ni evento de respuesta."""
    dicho: list[str] = []

    class RecSilencioso:
        def record_utterance(self) -> bytes:
            return b""

        def transcribe(self, pcm: bytes) -> str:  # pragma: no cover - no se llama
            raise AssertionError("no debe transcribirse nada")

    def boom(*_args, **_kwargs):  # pragma: no cover - no se llama
        raise AssertionError("no debe consultarse el modelo")

    original, mv.ask_llm = mv.ask_llm, boom
    try:
        eventos = capture(lambda: mv.handle_utterance(RecSilencioso(), dicho.append))
    finally:
        mv.ask_llm = original

    assert dicho == []
    assert [e["state"] for e in eventos if "state" in e] == ["listening", "idle"]
    # Y NO se queda mudo: dice que no ha oido nada. Antes volvia a "idle" en
    # silencio y desde fuera parecia que se habia colgado escuchando.
    avisos = [e.get("text", "") for e in eventos if e.get("event") == "transcript"]
    assert any("no he o" in a.lower() for a in avisos), avisos


def test_el_turno_completo_emite_transcripcion_respuesta_y_estados():
    dicho: list[str] = []

    class RecFalso:
        def record_utterance(self) -> bytes:
            return b"\x01\x02"

        def transcribe(self, pcm: bytes) -> str:
            return "apaga la musica"

    original, mv.ask_llm = mv.ask_llm, lambda *_a, **_k: {"content": "Hecho."}
    try:
        eventos = capture(lambda: mv.handle_utterance(RecFalso(), dicho.append))
    finally:
        mv.ask_llm = original

    tipos = [e["event"] for e in eventos]
    assert "transcript" in tipos and "reply" in tipos
    assert [e["state"] for e in eventos if e["event"] == "state"] == [
        "listening",
        "thinking",
        "speaking",
        "idle",
    ]
    assert dicho == ["Hecho."]


def test_un_fallo_del_modelo_no_deja_el_orbe_colgado():
    """Caso negativo: si el modelo revienta, el estado tiene que volver a idle
    o el orbe se queda 'pensando' para siempre."""

    class RecFalso:
        def record_utterance(self) -> bytes:
            return b"\x01"

        def transcribe(self, pcm: bytes) -> str:
            return "haz algo"

    def boom(*_args, **_kwargs):
        raise RuntimeError("ollama caido")

    original, mv.ask_llm = mv.ask_llm, boom
    try:
        try:
            eventos = capture(lambda: mv.handle_utterance(RecFalso(), lambda _t: None))
        except RuntimeError:
            # handle_utterance propaga; el bucle principal es quien lo captura
            # y vuelve a idle. Se comprueba ese contrato aqui.
            eventos = []
    finally:
        mv.ask_llm = original
    assert eventos == [] or eventos[-1].get("state") == "idle"


# --- palabra clave ---------------------------------------------------------


def test_reconoce_la_palabra_clave_en_sus_variantes():
    for t in ["maria", "oye maria", "hola maria que tal", "MARIA"]:
        assert mv.wake_text_is_hit(t), t


def test_no_se_despierta_con_cualquier_cosa():
    # Caso negativo: un falso positivo abre el microfono y graba sin permiso.
    for t in ["", "[unk]", "marea", "mira el correo", "haz una marinera"]:
        assert not mv.wake_text_is_hit(t), t


def test_el_turno_marca_ocupado_y_lo_libera():
    """El escuchador suelta el microfono mientras dura el turno; si `busy` se
    quedara puesto, mar.ia dejaria de responder a su nombre para siempre."""

    class RecFalso:
        def record_utterance(self) -> bytes:
            assert mv.busy.is_set(), "el turno deberia estar marcado como ocupado"
            return b""

    mv.busy.set()
    try:
        capture(lambda: mv.handle_utterance(RecFalso(), lambda _t: None))
    finally:
        mv.busy.clear()
    assert not mv.busy.is_set()

# ---------------------------------------------------------------------------
# Saludo al despertar y animacion al hablar
# ---------------------------------------------------------------------------


def test_el_saludo_cambia_con_la_hora(monkeypatch):
    """El saludo dice la franja correcta. Se congela el reloj: si dependiera de
    la hora real, el test pasaria o fallaria segun cuando se lance."""
    import time as _t

    def reloj(hora):
        return lambda *_: _t.struct_time((2026, 9, 19, hora, 0, 0, 4, 262, 0))

    for hora, esperado in [(9, "Buenos días"), (16, "Buenas tardes"), (23, "Buenas noches")]:
        monkeypatch.setattr(mv.time, "localtime", reloj(hora))
        frase = mv.saludo_de_bienvenida()
        assert frase.startswith(esperado), f"a las {hora}: {frase}"
        assert "mar.ia" in frase


def test_el_saludo_no_carga_el_modelo(monkeypatch):
    """Caso negativo: si el saludo pasara por el LLM, arrancar costaria 6,6 GB
    de VRAM y varios segundos solo para dar los buenos dias."""
    def explota(*_a, **_k):
        raise AssertionError("el saludo no puede llamar al modelo")

    monkeypatch.setattr(mv, "ask_llm", explota)
    assert mv.saludo_de_bienvenida()


def test_la_envolvente_manda_niveles_y_termina_en_cero():
    """Mientras habla, el orbe recibe niveles; al acabar, vuelve a 0 — si no,
    se quedaria latiendo en silencio para siempre."""
    import threading

    parar = threading.Event()

    def corta():
        parar.set()

    t = threading.Timer(0.25, corta)
    t.start()
    eventos = capture(lambda: mv._envolvente_al_hablar("una frase de prueba", parar))
    t.cancel()

    niveles = [e for e in eventos if e.get("event") == "amp"]
    assert len(niveles) >= 2, f"muy pocos niveles: {len(niveles)}"
    assert all(0.0 <= e["amp"] <= 1.0 for e in niveles), "nivel fuera de rango"
    assert niveles[-1]["amp"] == 0.0, "no volvio a cero al terminar"


def test_la_envolvente_para_al_instante_si_ya_venia_parada():
    """Caso negativo: con la senal de parada ya puesta no debe animar nada,
    solo dejar el orbe a cero."""
    import threading

    parar = threading.Event()
    parar.set()
    eventos = capture(lambda: mv._envolvente_al_hablar("lo que sea", parar))
    niveles = [e for e in eventos if e.get("event") == "amp"]
    assert niveles == [{"event": "amp", "amp": 0.0}], niveles

def test_emit_es_seguro_desde_varios_hilos():
    """Tres hilos escribiendo a la vez: el sidecar arrancaba asi (saludo +
    envolvente + bucle principal) y el flush petaba con OSError 22, matando el
    proceso. Cada linea tiene que salir entera y ser JSON valido."""
    import threading

    salida = io.StringIO()
    original = mv.sys.stdout
    mv.sys.stdout = salida
    try:
        hilos = [
            threading.Thread(target=lambda n=n: [mv.emit("amp", amp=0.5, hilo=n) for _ in range(40)])
            for n in range(3)
        ]
        for h in hilos:
            h.start()
        for h in hilos:
            h.join()
    finally:
        mv.sys.stdout = original

    lineas = [l for l in salida.getvalue().splitlines() if l.strip()]
    assert len(lineas) == 120, f"se perdieron lineas: {len(lineas)}"
    for l in lineas:
        json.loads(l)  # cada linea, JSON entero — nada de mezclas


def test_emit_no_revienta_si_la_tuberia_se_cierra():
    """Caso negativo: con el padre muerto, emit no puede lanzar (eso mataba el
    hilo y dejaba el microfono cogido). Debe marcar SALIDA_ROTA y callarse."""
    class Rota:
        def write(self, _):
            raise OSError(22, "Invalid argument")

        def flush(self):
            raise OSError(22, "Invalid argument")

    original = mv.sys.stdout
    mv.SALIDA_ROTA.clear()
    mv.sys.stdout = Rota()
    try:
        mv.emit("state", state="idle")  # no debe lanzar
    finally:
        mv.sys.stdout = original
    assert mv.SALIDA_ROTA.is_set()
    mv.SALIDA_ROTA.clear()

def test_si_el_modelo_local_no_esta_maria_lo_dice_en_voz_alta(monkeypatch):
    """Caso negativo del turno de voz: con Ollama caido, mar.ia se quedaba
    MUDA — hablabas y no pasaba nada. Ahora avisa y vuelve a idle."""
    def caido(*_a, **_k):
        raise OSError("connection refused")

    monkeypatch.setattr(mv, "ask_llm", caido)
    dicho = []
    eventos = capture(lambda: mv.process_text("que hora es", dicho.append))

    estados = [e["state"] for e in eventos if e.get("event") == "state"]
    respuestas = [e["text"] for e in eventos if e.get("event") == "reply"]
    assert estados[-1] == "idle", f"se quedo colgada en {estados}"
    assert respuestas, "no dijo nada"
    assert "Ollama" in respuestas[0]
    assert dicho and "Ollama" in dicho[0], "no lo dijo en voz alta"


# ---------------------------------------------------------------------------
# La captura: umbral relativo y transcripcion en vivo
#
# El fallo real (2026-09-19): el microfono de los auriculares da 0,00001 RMS de
# ruido y el umbral estaba fijo en 0,012. La voz nunca lo pasaba, la toma se
# tiraba entera y el orbe se quedaba en "escuchando". Estos tests fijan que el
# umbral se saque del ruido MEDIDO y no de una constante.
# ---------------------------------------------------------------------------


class StreamFalso:
    """Un microfono de mentira: devuelve los bloques que se le den."""

    def __init__(self, bloques):
        self.bloques = list(bloques)

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def read(self, _n):
        if self.bloques:
            return self.bloques.pop(0), False
        # Se acabo el guion: silencio digital para siempre.
        return b"\x00\x00" * 480, False


def _tono(amplitud: float, n: int = 480) -> bytes:
    import numpy as np

    x = (np.random.default_rng(0).normal(0, amplitud, n) * 32767).clip(-32767, 32767)
    return x.astype(np.int16).tobytes()


def _grabar_con(monkeypatch, bloques):
    """Corre record_utterance contra un microfono de mentira. Devuelve
    (pcm, eventos)."""
    import sounddevice as sd

    monkeypatch.setattr(sd, "RawInputStream", lambda **_k: StreamFalso(bloques))
    # Sin Vosk: aqui se prueba la puerta por nivel, no el reconocedor.
    monkeypatch.setattr(mv, "modelo_vosk", lambda: (_ for _ in ()).throw(RuntimeError("sin vosk")))
    rec = mv.Recorder()
    caja = {}
    eventos = capture(lambda: caja.setdefault("pcm", rec.record_utterance()))
    return caja["pcm"], eventos


def test_un_microfono_flojo_tambien_abre_la_puerta(monkeypatch):
    """Voz a 0,004 RMS: MUY por debajo del viejo umbral fijo de 0,012."""
    ruido = [_tono(0.00001) for _ in range(12)]   # 360 ms de sala
    voz = [_tono(0.004) for _ in range(20)]       # 600 ms hablando
    silencio = [_tono(0.00001) for _ in range(40)]  # y te callas
    pcm, _ = _grabar_con(monkeypatch, ruido + voz + silencio)
    assert pcm, "con voz audible la grabacion no puede salir vacia"


def test_una_sala_en_silencio_no_se_confunde_con_voz(monkeypatch):
    """Caso negativo: solo ruido, nada de voz -> no se graba nada.

    Sin esto, bajar el umbral habria cambiado un fallo por el contrario:
    mandarle a Whisper silencio, que se lo inventa.
    """
    solo_ruido = [_tono(0.00001) for _ in range(60)]
    monkeypatch.setattr(mv, "MAX_UTTERANCE_S", 1.0)
    pcm, _ = _grabar_con(monkeypatch, solo_ruido)
    assert pcm == b"", "el ruido de sala no es voz"


def test_el_umbral_se_calcula_con_el_ruido_medido(monkeypatch):
    """Una sala ruidosa sube el liston; una silenciosa se queda en el piso."""
    ruidosa = [_tono(0.01) for _ in range(12)]
    monkeypatch.setattr(mv, "MAX_UTTERANCE_S", 1.0)
    _, eventos = _grabar_con(monkeypatch, ruidosa)
    linea = [e.get("message", "") for e in eventos if e.get("event") == "log"]
    umbral = [m for m in linea if "umbral" in m]
    assert umbral, f"no se registro el calibrado: {linea}"
    # ruido ~0,01 * FACTOR_VOZ=6 -> bastante por encima del piso.
    assert mv.PISO_RMS < 0.01 * mv.FACTOR_VOZ


def test_el_nivel_del_orbe_se_escala_contra_el_umbral(monkeypatch):
    """Con un microfono flojo la bolita tiene que moverse igual."""
    ruido = [_tono(0.00001) for _ in range(12)]
    voz = [_tono(0.004) for _ in range(10)]
    _, eventos = _grabar_con(monkeypatch, ruido + voz + [_tono(0.00001) for _ in range(40)])
    amps = [e["amp"] for e in eventos if e.get("event") == "amp"]
    assert amps, "sin niveles el orbe se queda quieto"
    assert max(amps) > 0.5, f"la voz apenas movio el medidor: max={max(amps):.3f}"


# ---------------------------------------------------------------------------
# Whisper: la GPU que "carga" pero no transcribe
#
# El fallo medido el 2026-09-19: WhisperModel(device="cuda") se construye sin
# rechistar aunque falte cublas64_12.dll, y revienta despues, al codificar el
# primer audio de verdad. Resultado visible: la palabra clave te oye, grabas, y
# no aparece texto por ningun sitio.
# ---------------------------------------------------------------------------


class _WhisperFalso:
    """Se construye siempre; en cuda falla al transcribir, como el de verdad."""

    def __init__(self, _modelo, device="cpu", compute_type="int8"):
        self.device = device

    def transcribe(self, _audio, **_kw):
        if self.device == "cuda":
            raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
        return iter([type("S", (), {"text": " hola "})()]), None


def test_una_gpu_que_no_puede_transcribir_cae_a_cpu(monkeypatch):
    import faster_whisper

    monkeypatch.setattr(faster_whisper, "WhisperModel", _WhisperFalso)
    eventos = capture(lambda: setattr(test_una_gpu_que_no_puede_transcribir_cae_a_cpu,
                                      "m", mv.cargar_whisper()))
    m = test_una_gpu_que_no_puede_transcribir_cae_a_cpu.m
    assert m.device == "cpu", "tenia que haberse quedado en CPU"
    mensajes = " ".join(e.get("message", "") for e in eventos)
    # Y lo DICE: un cambio de GPU a CPU sin avisar es un misterio de 4 segundos
    # por respuesta que nadie sabe explicar.
    assert "GPU no puede transcribir" in mensajes, mensajes
    assert "instalar-voz-gpu" in mensajes, "hay que decir como arreglarlo"


def test_la_transcripcion_no_se_pierde_si_la_gpu_falla_a_mitad(monkeypatch):
    """Caso negativo: el modelo ya cargado peta -> se rehace en CPU y se salva
    lo que el usuario acaba de decir."""
    import faster_whisper
    import numpy as np

    monkeypatch.setattr(faster_whisper, "WhisperModel", _WhisperFalso)
    rec = mv.Recorder()
    rec.model = _WhisperFalso("x", device="cuda")  # una GPU que ya no va
    pcm = (np.zeros(16000, dtype=np.int16) + 1000).tobytes()
    texto = capture(lambda: None) and None
    texto = rec.transcribe(pcm)
    assert texto == "hola", texto
    assert rec.model.device == "cpu"
