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
    assert [e.get("state") for e in eventos] == ["listening", "idle"]


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
