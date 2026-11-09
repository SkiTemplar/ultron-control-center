// sesiones/tests_maquina_recuperacion.rs — Incidente del 2026-10-15: avisos
// de una recuperación fallida según el motivo, pausa de la cola por plazo
// (solo con algo en cola, visible en `SessionInfo` y sin pausar si el puente
// mandó su `turnEnd`), «Enviar ahora» y plazo de Bash sin `timeout`. Cada
// caso fallaba con el comportamiento anterior o fija un caso negativo.

use super::*;
use crate::sesiones::registro;
use crate::sesiones::senales::{EnvioKind, EstadoPantalla as P, MotivoFallo, Senal};
use crate::sesiones::types::{QueuePauseReason, SessionStatus as S, StallReason};

const T0: Ms = 1_700_000_000_000;

struct H {
    e: EstadoSesion,
    ahora: Ms,
    t: ResumenTickets,
    todos: Vec<Efecto>,
}

impl H {
    /// Working v2 con el turno `t1` abierto y la pantalla sin clasificar.
    fn trabajando_v2() -> Self {
        let mut h = Self {
            e: EstadoSesion::nuevo(T0),
            ahora: T0,
            t: ResumenTickets::default(),
            todos: Vec::new(),
        };
        h.e.protocolo = 2;
        h.s(pantalla(P::Prompt)).avanza(300);
        h.s(Senal::EnvioEscrito {
            client_id: "c1".into(),
            kind: EnvioKind::Prompt,
            texto: "hola".into(),
        });
        h.s(Senal::TurnoInicio {
            turn_id: "t1".into(),
        });
        h.s(pantalla(P::Unknown));
        assert_eq!(h.e.status, S::Working, "arranque");
        h.todos.clear();
        h
    }

    fn s(&mut self, s: Senal) -> &mut Self {
        let (n, ef) = transicion(&self.e, &s, self.ahora, &self.t);
        self.e = n;
        self.todos.extend(ef);
        self
    }

    fn avanza(&mut self, ms: Ms) -> &mut Self {
        self.ahora += ms;
        self.s(Senal::Tick)
    }

    fn avisos(&self) -> Vec<(Nivel, String)> {
        self.todos
            .iter()
            .filter_map(|e| match e {
                Efecto::Aviso { nivel, texto } => Some((*nivel, texto.clone())),
                _ => None,
            })
            .collect()
    }
}

fn pantalla(estado: P) -> Senal {
    Senal::Pantalla {
        estado,
        modo: None,
        entrada: None,
        pista: false,
    }
}

fn fallo(motivo: Option<MotivoFallo>) -> Senal {
    Senal::RecuperacionTerminada { ok: false, motivo }
}

// ---------------------------------------------------------------------------
// Avisos de una recuperación fallida
// ---------------------------------------------------------------------------

/// 22:32:19: un turno nuevo abierto por el aviso de una tarea no es «la CLI
/// no responde»: aviso ámbar con la salida (otro Esc), nunca rojo.
#[test]
fn un_turno_nuevo_avisa_en_ambar_y_no_en_rojo() {
    let mut h = H::trabajando_v2();
    h.s(fallo(Some(MotivoFallo::TurnoNuevo)));
    assert_eq!(
        h.avisos(),
        vec![(Nivel::Warn, AVISO_TURNO_NUEVO.to_string())]
    );
    assert_eq!(h.e.status, S::Working);
}

/// Caso negativo: sin respuesta de la CLI, sí es un error con reinicio.
#[test]
fn sin_respuesta_de_la_cli_si_es_error() {
    let mut h = H::trabajando_v2();
    h.s(fallo(Some(MotivoFallo::SinRespuesta)));
    assert_eq!(
        h.avisos(),
        vec![(Nivel::Error, AVISO_SIN_RESPUESTA.to_string())]
    );
}

/// Sin motivo (hubo actividad del puente) o con el menú abierto, la máquina
/// no avisa: el resultado ya lo cuenta la ventana.
#[test]
fn sin_motivo_o_con_menu_la_maquina_no_avisa() {
    let mut h = H::trabajando_v2();
    h.s(fallo(None)).s(fallo(Some(MotivoFallo::MenuAbierto)));
    assert!(h.avisos().is_empty(), "{:?}", h.todos);
}

// ---------------------------------------------------------------------------
// Interrumpir con el puente v2 (auditoría H1)
// ---------------------------------------------------------------------------

fn fin_abortado() -> Senal {
    Senal::TurnoFin {
        turn_id: "t1".into(),
        motivo: "answer".into(),
        abortado: true,
    }
}

/// Esc con un mensaje en la cola de ULTRON: el `turnEnd` abortado cierra el
/// turno sin drenar y la recuperación posterior no levanta la pausa. Antes
/// `cerrar_turno` drenaba en el acto y salía el siguiente mensaje.
#[test]
fn turn_end_abortado_deja_la_cola_en_pausa() {
    let mut h = H::trabajando_v2();
    h.t.en_cola_ultron = 1;
    h.s(Senal::InterrupcionPedida).s(fin_abortado());
    assert_eq!(h.e.status, S::Idle);
    assert!(!h.todos.contains(&Efecto::Drenar), "{:?}", h.todos);
    assert!(h.e.pausa_drenaje);
    h.s(pantalla(P::Prompt)).s(Senal::RecuperacionTerminada {
        ok: true,
        motivo: None,
    });
    h.avanza(60_000);
    assert!(!h.todos.contains(&Efecto::Drenar), "{:?}", h.todos);
    assert!(h.e.pausa_drenaje, "la cola espera a «Enviar ahora»");
}

/// Motivo del último turno emitido (el que lee la ventana para ofrecer
/// «Enviar ahora»).
fn motivo_emitido(h: &H) -> Option<String> {
    h.todos.iter().rev().find_map(|e| match e {
        Efecto::EmitirTurno(t) => Some(t.motivo.clone()),
        _ => None,
    })
}

/// El `turnEnd` abortado sin `InterrupcionPedida` (Esc en la TUI) también
/// pausa; y el aviso de interrupción sin marca de aborto, igual. En los dos
/// casos el turno sale como `aborted`: si no, la ventana diría «Listo» sin
/// «Enviar ahora» con la cola en pausa.
#[test]
fn abortado_o_interrumpiendo_bastan_para_pausar() {
    let mut h = H::trabajando_v2();
    h.s(fin_abortado());
    assert!(!h.todos.contains(&Efecto::Drenar), "{:?}", h.todos);
    assert!(h.e.pausa_drenaje);
    assert_eq!(motivo_emitido(&h).as_deref(), Some("aborted"));
    let mut h = H::trabajando_v2();
    h.s(Senal::InterrupcionPedida).s(Senal::TurnoFin {
        turn_id: "t1".into(),
        motivo: "answer".into(),
        abortado: false,
    });
    assert!(!h.todos.contains(&Efecto::Drenar), "{:?}", h.todos);
    assert!(h.e.pausa_drenaje);
    assert_eq!(motivo_emitido(&h).as_deref(), Some("aborted"));
}

/// Sesión ef9979bb (2026-10-21): la cola nativa devuelta a mitad de la
/// interrupción (popAll) se reenviaba antes de que la recuperación acabase.
/// La pausa empieza al pedir la interrupción y un turno normal que cierre
/// después, aún dentro de ella, no drena.
#[test]
fn la_pausa_empieza_al_pedir_la_interrupcion() {
    let mut h = H::trabajando_v2();
    h.t.en_cola_cli = 1;
    h.s(Senal::InterrupcionPedida);
    assert!(h.e.pausa_drenaje, "pausa desde la petición");
    h.t.en_cola_cli = 0;
    h.t.en_cola_ultron = 1;
    h.s(pantalla(P::Prompt)).s(Senal::RecuperacionTerminada {
        ok: true,
        motivo: None,
    });
    h.avanza(60_000);
    assert!(!h.todos.contains(&Efecto::Drenar), "{:?}", h.todos);
    assert!(h.e.pausa_drenaje, "la cola espera a «Enviar ahora»");
}

/// Caso negativo: un `turnEnd` normal sigue drenando la cola.
#[test]
fn turn_end_normal_drena() {
    let mut h = H::trabajando_v2();
    h.t.en_cola_ultron = 1;
    h.s(Senal::TurnoFin {
        turn_id: "t1".into(),
        motivo: "answer".into(),
        abortado: false,
    });
    assert_eq!(h.e.status, S::Idle);
    assert!(h.todos.contains(&Efecto::Drenar), "{:?}", h.todos);
    assert!(!h.e.pausa_drenaje);
    assert_eq!(motivo_emitido(&h).as_deref(), Some("answer"));
}

// ---------------------------------------------------------------------------
// Pausa de la cola por plazo
// ---------------------------------------------------------------------------

/// Sesión 30de3966: el `turnEnd` real llegó y se ignoró (ajeno); 3 s después
/// la red de seguridad cerró el turno. El puente vive: sin pausa ni aviso.
#[test]
fn la_red_tras_un_turn_end_ignorado_no_pausa_la_cola() {
    let mut h = H::trabajando_v2();
    h.t.en_cola_ultron = 1;
    h.s(Senal::TurnoFin {
        turn_id: "x".into(),
        motivo: "answer".into(),
        abortado: false,
    });
    assert_eq!(h.e.status, S::Working, "ajeno: ignorado");
    assert!(h.todos.iter().any(|e| matches!(
        e,
        Efecto::Log(l) if l.contains("turno actual t1") && l.contains("ya cerrado: false")
    )));
    h.s(Senal::TxTurnDuration).avanza(3_000);
    assert_eq!(h.e.status, S::Idle, "{:?}", h.todos);
    assert_eq!(h.e.pausa_plazo, None);
    assert!(h.avisos().is_empty(), "{:?}", h.todos);
    assert!(h.todos.contains(&Efecto::Drenar));
}

/// Caso negativo: sin `turnEnd` del puente, la red pausa la cola y, con un
/// mensaje retenido, lo explica con la salida («Enviar ahora»).
#[test]
fn la_red_sin_turn_end_pausa_y_explica_cuantos_retiene() {
    let mut h = H::trabajando_v2();
    h.t.en_cola_ultron = 1;
    h.s(Senal::TxTurnDuration).avanza(3_000);
    assert_eq!(h.e.status, S::Idle);
    assert!(h.e.pausa_plazo.is_some());
    let avisos = h.avisos();
    assert_eq!(avisos.len(), 1, "{avisos:?}");
    assert_eq!(avisos[0].0, Nivel::Warn);
    assert!(
        avisos[0].1.contains("retengo 1 mensaje en cola"),
        "{}",
        avisos[0].1
    );
    assert!(avisos[0].1.contains("«Enviar ahora»"));
}

/// Con la cola de ULTRON vacía la pausa no retiene nada: sin aviso.
#[test]
fn la_pausa_con_la_cola_vacia_no_avisa() {
    let mut h = H::trabajando_v2();
    h.s(Senal::TxTurnDuration).avanza(3_000);
    assert!(
        h.e.pausa_plazo.is_some(),
        "la pausa sigue (por si llega algo)"
    );
    assert!(h.avisos().is_empty(), "{:?}", h.todos);
}

#[test]
fn el_aviso_de_pausa_cuenta_en_plural() {
    assert!(tiempo::aviso_pausa_plazo(3).contains("retengo 3 mensajes en cola"));
}

/// La pausa viaja en `SessionInfo.queuePause` (y su cambio se emite); el
/// `turnEnd` real la quita.
#[test]
fn la_pausa_se_proyecta_y_se_retira() {
    let mut h = H::trabajando_v2();
    h.s(Senal::TxTurnDuration).avanza(3_000);
    assert!(h.todos.contains(&Efecto::EmitirSesiones));
    let mut info = registro::sesion_de_prueba("qp").info;
    proyectar(&h.e, &mut info);
    let pausa = info.queue_pause.clone().expect("pausa visible");
    assert_eq!(pausa.reason, QueuePauseReason::Deadline);
    assert_eq!(pausa.since, iso(T0 + 300 + 3_000));
    h.s(Senal::TurnoFin {
        turn_id: "t1".into(),
        motivo: "answer".into(),
        abortado: false,
    });
    proyectar(&h.e, &mut info);
    assert_eq!(info.queue_pause, None);
}

/// «Enviar ahora» levanta la pausa en idle y drena; sin pausa no hace nada
/// (caso negativo).
#[test]
fn enviar_ahora_levanta_la_pausa() {
    let mut h = H::trabajando_v2();
    h.s(Senal::TxTurnDuration).avanza(3_000);
    h.todos.clear();
    h.s(Senal::ReanudarCola);
    assert_eq!(h.e.pausa_plazo, None);
    assert!(h.todos.contains(&Efecto::Drenar), "{:?}", h.todos);
    h.todos.clear();
    h.s(Senal::ReanudarCola);
    assert!(!h.todos.contains(&Efecto::Drenar));
}

// ---------------------------------------------------------------------------
// Bash sin `timeout`
// ---------------------------------------------------------------------------

fn herramienta(nombre: &str) -> Senal {
    Senal::HerramientaInicio {
        tool_use_id: format!("tu-{nombre}"),
        nombre: nombre.into(),
        timeout_ms: None,
    }
}

/// 22:25:12: un `find` de 7 min sin `timeout` no avisaba hasta los 15 min.
/// Bash usa el límite por defecto de la CLI (2 min) más el margen.
#[test]
fn bash_sin_timeout_vence_a_los_dos_minutos_y_medio() {
    let mut h = H::trabajando_v2();
    h.s(herramienta("Bash"));
    h.avanza(149_000);
    assert!(h.e.stalled.is_none(), "{:?}", h.e.stalled);
    h.avanza(2_000);
    let st = h.e.stalled.clone().expect("toolOverdue");
    assert_eq!(st.reason, StallReason::ToolOverdue);
    assert!(st.detail.contains("límite 2 min"), "{}", st.detail);
}

/// Caso negativo: el resto de herramientas sin `timeout` sigue con 15 min.
#[test]
fn read_sin_timeout_no_vence_a_los_dos_minutos_y_medio() {
    let mut h = H::trabajando_v2();
    h.s(herramienta("Read"));
    h.avanza(151_000);
    assert!(h.e.stalled.is_none(), "{:?}", h.e.stalled);
}
