// sesiones/tests_maquina.rs — Tabla de la máquina de estados (contrato de
// estabilidad, §1.4, §1.5 y §8.4). Cada caso fallaba con el comportamiento
// anterior o fija un caso negativo.

use super::*;
use crate::sesiones::senales::{EnvioKind, EstadoPantalla as P, Senal};
use crate::sesiones::types::{SessionStatus as S, StallReason, WaitKind};

pub(super) const T0: Ms = 1_700_000_000_000;

/// Arnés: estado, reloj y efectos acumulados.
pub(super) struct H {
    pub(super) e: EstadoSesion,
    pub(super) ahora: Ms,
    pub(super) t: ResumenTickets,
    pub(super) todos: Vec<Efecto>,
}

impl H {
    pub(super) fn nuevo() -> Self {
        Self {
            e: EstadoSesion::nuevo(T0),
            ahora: T0,
            t: ResumenTickets::default(),
            todos: Vec::new(),
        }
    }

    /// Sesión ya en idle (prompt estable 300 ms) con el protocolo dado.
    pub(super) fn idle(protocolo: u8) -> Self {
        let mut h = Self::nuevo();
        h.e.protocolo = protocolo;
        h.s(pantalla(P::Prompt)).avanza(300);
        assert_eq!(h.e.status, S::Idle, "arranque");
        h.todos.clear();
        h
    }

    /// Sesión en working con el turno `t1` abierto por el puente y la
    /// pantalla sin clasificar (las reglas de pantalla se prueban aparte).
    pub(super) fn trabajando_v2() -> Self {
        let mut h = Self::idle(2);
        h.s(envio()).s(Senal::TurnoInicio {
            turn_id: "t1".into(),
        });
        h.s(pantalla(P::Unknown));
        h.todos.clear();
        h
    }

    pub(super) fn s(&mut self, s: Senal) -> &mut Self {
        let (n, ef) = transicion(&self.e, &s, self.ahora, &self.t);
        self.e = n;
        self.todos.extend(ef);
        self
    }

    pub(super) fn avanza(&mut self, ms: Ms) -> &mut Self {
        self.ahora += ms;
        self.s(Senal::Tick)
    }

    pub(super) fn hay(&self, f: impl Fn(&Efecto) -> bool) -> bool {
        self.todos.iter().any(f)
    }

    pub(super) fn cancela(&self) -> bool {
        self.hay(|e| matches!(e, Efecto::CancelarAsks { .. }))
    }

    pub(super) fn drena(&self) -> bool {
        self.hay(|e| *e == Efecto::Drenar)
    }
}

pub(super) fn pantalla(estado: P) -> Senal {
    Senal::Pantalla {
        estado,
        modo: None,
        entrada: None,
        pista: false,
    }
}

pub(super) fn envio() -> Senal {
    Senal::EnvioEscrito {
        client_id: "c1".into(),
        kind: EnvioKind::Prompt,
        texto: "hola".into(),
    }
}

pub(super) fn fin(t: &str) -> Senal {
    Senal::TurnoFin {
        turn_id: t.into(),
        motivo: "answer".into(),
        abortado: false,
    }
}

pub(super) fn tickets(sin_evidencia: usize, en_cola_cli: usize) -> ResumenTickets {
    ResumenTickets {
        sin_evidencia,
        en_cola_cli,
        en_cola_ultron: 0,
    }
}

pub(super) fn ask(id: &str) -> Senal {
    Senal::AskAbierta {
        ask_id: id.into(),
        kind: "question".into(),
    }
}

#[test]
fn comando_local_con_comando_fin_vuelve_a_idle() {
    let mut h = H::idle(2);
    h.s(Senal::ComandoInicio {
        run_id: "r1".into(),
        nombre: "cost".into(),
    });
    assert_eq!(h.e.status, S::Working);
    h.s(Senal::ComandoFin {
        run_id: "r1".into(),
        nombre: "cost".into(),
        interceptado: false,
    });
    assert_eq!(h.e.status, S::Idle);
    assert!(h.drena());
}

#[test]
fn en_v1_la_salida_local_del_transcript_cierra_el_comando() {
    let mut h = H::idle(1);
    h.s(Senal::EnvioEscrito {
        client_id: "c1".into(),
        kind: EnvioKind::Comando {
            nombre: "/cost".into(),
        },
        texto: "/cost".into(),
    });
    assert_eq!(h.e.status, S::Working);
    h.s(Senal::TxSalidaLocal);
    assert_eq!(h.e.status, S::Idle);
}

#[test]
fn en_v2_la_salida_local_no_decide() {
    let mut h = H::idle(2);
    h.s(Senal::ComandoInicio {
        run_id: "r1".into(),
        nombre: "compact".into(),
    });
    h.s(Senal::TxSalidaLocal);
    assert_eq!(h.e.status, S::Working, "lo cierra ComandoFin o TurnoFin");
}

#[test]
fn sin_puente_turn_duration_e_interrupcion_cierran() {
    let mut h = H::idle(0);
    h.s(envio()).s(Senal::TxTurnDuration);
    assert_eq!(h.e.status, S::Idle);
    assert!(h.drena());
    h.s(envio()).s(Senal::TxInterrumpido);
    assert_eq!(h.e.status, S::Idle, "interrupción sin turn_duration");
}

#[test]
fn turn_end_atrasado_no_devuelve_idle() {
    let mut h = H::trabajando_v2();
    h.s(fin("t1"));
    assert_eq!(h.e.status, S::Idle);
    h.s(envio());
    h.s(fin("t1"));
    assert_eq!(h.e.status, S::Working, "t1 ya estaba cerrado");
    h.s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.s(fin("t3"));
    assert_eq!(h.e.status, S::Working, "t3 no es el turno abierto");
    h.s(fin("t2"));
    assert_eq!(h.e.status, S::Idle);
}

#[test]
fn turn_end_con_la_cola_nativa_llena_sigue_working() {
    let mut h = H::trabajando_v2();
    h.t.en_cola_cli = 1;
    h.s(fin("t1"));
    assert_eq!(h.e.status, S::Working);
    assert!(h.e.turno.as_ref().is_some_and(|t| t.turn_id.is_none()));
    assert!(!h.drena());
}

#[test]
fn envio_en_waiting_no_pisa_la_espera() {
    let mut h = H::trabajando_v2();
    h.s(ask("a1")).s(envio());
    assert_eq!(h.e.status, S::Waiting);
}

#[test]
fn dos_preguntas_esperan_hasta_cerrar_las_dos() {
    let mut h = H::trabajando_v2();
    h.s(ask("a1")).s(ask("a2"));
    h.s(Senal::AskCerrada {
        ask_id: "a1".into(),
    });
    assert_eq!(h.e.status, S::Waiting);
    assert_eq!(
        h.e.waiting.as_ref().and_then(|w| w.ask_id.as_deref()),
        Some("a2")
    );
    h.s(Senal::AskCerrada {
        ask_id: "a2".into(),
    });
    assert_eq!(h.e.status, S::Working);
}

#[test]
fn ask_abierto_y_turn_end_van_a_idle_y_cancelan() {
    let mut h = H::trabajando_v2();
    h.s(ask("a1")).s(fin("t1"));
    assert_eq!(h.e.status, S::Idle);
    assert!(h.hay(|e| *e
        == Efecto::CancelarAsks {
            motivo: "turnEnded"
        }));
    assert!(h.hay(|e| matches!(e, Efecto::EmitirTurno(_))));
}

#[test]
fn working_since_se_conserva_en_waiting_y_se_borra_en_idle() {
    let mut h = H::trabajando_v2();
    let desde = h.e.working_since;
    assert!(desde.is_some());
    h.ahora += 5_000;
    h.s(ask("a1"));
    assert_eq!(h.e.working_since, desde);
    h.s(Senal::AskCerrada {
        ask_id: "a1".into(),
    });
    assert_eq!((h.e.status, h.e.working_since), (S::Working, desde));
    h.s(fin("t1"));
    assert_eq!(h.e.working_since, None);
}

#[test]
fn sin_eventos_121_s_es_no_events_y_un_evento_lo_evita() {
    let mut h = H::trabajando_v2();
    h.avanza(60_000).s(Senal::Actividad { agent_id: None });
    h.avanza(61_000);
    assert!(
        h.e.stalled.is_none(),
        "el evento a los 60 s reinicia la cuenta"
    );
    h.avanza(60_000);
    let st = h.e.stalled.clone().expect("stalled");
    assert_eq!(st.reason, StallReason::NoEvents);
    h.s(Senal::Progreso);
    assert!(h.e.stalled.is_none(), "la actividad limpia noEvents");
}

#[test]
fn herramienta_dentro_de_su_limite_no_marca_y_pasado_es_tool_overdue() {
    let mut h = H::trabajando_v2();
    h.s(Senal::HerramientaInicio {
        tool_use_id: "b1".into(),
        nombre: "Bash".into(),
        timeout_ms: Some(600_000),
    });
    h.avanza(300_000);
    assert!(h.e.stalled.is_none(), "herramienta abierta: sin noEvents");
    h.avanza(329_000);
    assert!(h.e.stalled.is_none(), "629 s: dentro del margen");
    h.avanza(2_000);
    let st = h.e.stalled.clone().expect("631 s");
    assert_eq!(st.reason, StallReason::ToolOverdue);
    assert_eq!(st.tool.as_deref(), Some("Bash"));
    assert!(st.detail.contains("límite 10 min"), "{}", st.detail);
}

#[test]
fn agente_con_subagente_activo_nunca_se_marca() {
    let mut h = H::trabajando_v2();
    h.s(Senal::HerramientaInicio {
        tool_use_id: "ag".into(),
        nombre: "Agent".into(),
        timeout_ms: None,
    });
    for _ in 0..20 {
        h.avanza(60_000).s(Senal::Actividad {
            agent_id: Some("sub".into()),
        });
        assert!(h.e.stalled.is_none());
    }
}

#[test]
fn hello_con_el_mismo_sid_no_resetea_y_con_otro_si() {
    let mut h = H::idle(0);
    let hello = |sid: &str| Senal::PuenteHello {
        protocolo: 2,
        claude_session_id: Some(sid.into()),
        generacion: 1,
        transcript_path: None,
        origen: "start".into(),
    };
    h.s(hello("sid-a")).s(hello("sid-a"));
    assert!(!h.hay(|e| matches!(e, Efecto::EmitirReset { .. })));
    h.s(hello("sid-b"));
    assert!(h.hay(|e| *e
        == Efecto::EmitirReset {
            claude_session_id: "sid-b".into()
        }));
    assert_eq!(h.e.protocolo, 2);
}

#[test]
fn modo_gana_el_cambio_mas_reciente() {
    let mut h = H::idle(2);
    let con_modo = |m: &str| Senal::Pantalla {
        estado: P::Prompt,
        modo: Some(m.into()),
        entrada: None,
        pista: false,
    };
    h.s(con_modo("bypass permissions on")).avanza(600);
    assert_eq!(
        h.e.modo.as_ref().map(|m| m.0.as_str()),
        Some("bypassPermissions")
    );
    h.s(Senal::ModoPermisos {
        modo: "plan".into(),
    });
    h.avanza(600);
    assert_eq!(
        h.e.modo.as_ref().map(|m| m.0.as_str()),
        Some("plan"),
        "la pantalla vieja no pisa el hook"
    );
    h.s(con_modo("accept edits on")).avanza(600);
    assert_eq!(h.e.modo.as_ref().map(|m| m.0.as_str()), Some("acceptEdits"));
}

#[test]
fn prompt_de_usuario_en_el_transcript_solo_sin_puente() {
    let mut h = H::idle(0);
    h.s(Senal::TxPromptUsuario { texto: "x".into() });
    assert_eq!(h.e.status, S::Working);
    let mut h = H::idle(2);
    h.s(Senal::TxPromptUsuario { texto: "x".into() });
    assert_eq!(h.e.status, S::Idle);
}

#[test]
fn reinicio_conserva_la_cola_y_la_salida_sin_reinicio_termina() {
    let mut h = H::trabajando_v2();
    h.s(Senal::ReinicioPedido)
        .s(Senal::ProcesoSalio { code: 1 });
    assert_eq!(h.e.status, S::Starting);
    assert!(!h.hay(|e| matches!(e, Efecto::FallarEnvios { .. })));
    assert!(h.hay(|e| *e == Efecto::CancelarAsks { motivo: "restart" }));
    let mut h = H::trabajando_v2();
    h.s(Senal::ProcesoSalio { code: 3 });
    assert_eq!((h.e.status, h.e.exit_code), (S::Exited, Some(3)));
    assert!(h.hay(|e| matches!(e, Efecto::FallarEnvios { .. })));
    h.s(envio()).s(fin("t1"));
    assert_eq!(h.e.status, S::Exited, "exited solo sale con ReinicioPedido");
    h.s(Senal::ReinicioPedido);
    assert_eq!(h.e.status, S::Starting);
    h.s(pantalla(P::Prompt)).avanza(300);
    assert_eq!((h.e.status, h.e.reiniciando), (S::Idle, None));
}

#[test]
fn recuperacion_ok_en_prompt_va_a_idle_sin_drenar() {
    let mut h = H::trabajando_v2();
    h.s(pantalla(P::Prompt)).s(Senal::RecuperacionTerminada {
        ok: true,
        motivo: None,
    });
    assert_eq!(h.e.status, S::Idle);
    assert!(!h.drena());
    assert!(h.e.cerrados.contains(&"t1".to_string()));
    let mut h = H::trabajando_v2();
    let motivo = Some(crate::sesiones::senales::MotivoFallo::SinRespuesta);
    h.s(Senal::RecuperacionTerminada { ok: false, motivo });
    assert_eq!(h.e.status, S::Working);
    assert!(h.hay(|e| matches!(
        e,
        Efecto::Aviso {
            nivel: Nivel::Error,
            ..
        }
    )));
}

#[test]
fn turno_perdido_a_los_10_s_de_prompt_sin_progreso() {
    let mut h = H::trabajando_v2();
    h.s(pantalla(P::Prompt));
    h.avanza(9_000);
    assert_eq!(h.e.status, S::Working, "9 s");
    h.avanza(1_000);
    assert_eq!(h.e.status, S::Idle, "10 s");
    assert!(h.e.cerrados.contains(&"t1".to_string()));
    assert!(h.hay(|e| matches!(e, Efecto::EmitirTurno(_))));
}

#[test]
fn interrumpir_con_ask_no_cancela_hasta_turn_end_o_2_s() {
    let mut h = H::trabajando_v2();
    h.s(ask("a1")).s(Senal::InterrupcionPedida);
    h.avanza(1_900);
    assert!(!h.cancela(), "nunca antes del abort");
    h.s(fin("t1"));
    assert!(h.hay(|e| *e
        == Efecto::CancelarAsks {
            motivo: "interrupted"
        }));
    let mut h = H::trabajando_v2();
    h.s(ask("a1")).s(Senal::InterrupcionPedida);
    h.avanza(1_000);
    assert!(!h.cancela());
    h.avanza(1_000);
    assert!(h.hay(|e| *e
        == Efecto::CancelarAsks {
            motivo: "interrupted"
        }));
    assert_eq!(h.e.status, S::Working, "sin ask, vuelve a working");
}

#[test]
fn comando_prompt_sin_turno_espera_15_s() {
    let mut h = H::idle(2);
    h.s(Senal::ComandoInicio {
        run_id: "r1".into(),
        nombre: "compact".into(),
    })
    .s(pantalla(P::Prompt))
    .s(Senal::ComandoFin {
        run_id: "r1".into(),
        nombre: "compact".into(),
        interceptado: false,
    });
    h.avanza(3_000);
    assert_eq!(h.e.status, S::Working, "3 s: los UserPromptSubmit tardan");
    h.avanza(12_000);
    assert_eq!(h.e.status, S::Idle, "15 s con prompt");
    assert!(h.hay(|e| matches!(e, Efecto::Aviso { .. })));
}

#[test]
fn comando_fin_con_turno_abierto_no_cambia() {
    let mut h = H::trabajando_v2();
    h.s(Senal::ComandoFin {
        run_id: "r9".into(),
        nombre: "status".into(),
        interceptado: false,
    });
    assert_eq!(h.e.status, S::Working);
}

#[test]
fn confianza_en_el_arranque_no_drena_hasta_el_prompt() {
    let mut h = H::nuevo();
    h.s(pantalla(P::Trust));
    assert_eq!(h.e.status, S::Waiting);
    assert_eq!(h.e.waiting.as_ref().map(|w| w.kind), Some(WaitKind::Trust));
    h.avanza(200_000);
    assert!(!h.drena(), "nunca se vacía la cola dentro del diálogo");
    h.s(pantalla(P::Prompt));
    assert_eq!(h.e.status, S::Idle);
    assert!(h.drena());
}

/// Auditoría H2: un diálogo de arranque que no es la confianza (`.mcp.json`
/// nuevo, aviso de ajustes) va como menú, que el chat sabe responder; antes
/// salía como «Confirma la carpeta» y `responder_confianza` lo rechazaba.
#[test]
fn dialogo_de_arranque_que_no_es_la_confianza_va_como_menu() {
    let mut h = H::nuevo();
    h.s(pantalla(P::Dialog));
    assert_eq!(h.e.status, S::Waiting);
    assert_eq!(h.e.waiting.as_ref().map(|w| w.kind), Some(WaitKind::Menu));
    h.avanza(200_000);
    assert!(!h.drena(), "nunca se vacía la cola dentro del diálogo");
    h.s(pantalla(P::Prompt)).avanza(500);
    assert_eq!(h.e.status, S::Idle, "{:?}", h.todos);
    assert!(h.drena());
}

/// Caso negativo de H2: la confianza sigue siendo confianza, y el diálogo
/// que aparece tras aceptarla pasa a menú.
#[test]
fn la_confianza_sigue_como_confianza_y_el_dialogo_siguiente_es_menu() {
    let mut h = H::nuevo();
    h.s(pantalla(P::Trust));
    assert_eq!(h.e.waiting.as_ref().map(|w| w.kind), Some(WaitKind::Trust));
    h.s(pantalla(P::Dialog));
    assert_eq!(h.e.status, S::Waiting);
    assert_eq!(h.e.waiting.as_ref().map(|w| w.kind), Some(WaitKind::Menu));
    h.s(pantalla(P::Trust));
    assert_eq!(h.e.waiting.as_ref().map(|w| w.kind), Some(WaitKind::Trust));
}

#[test]
fn end_turn_sin_puente_espera_1_5_s_de_silencio() {
    let mut h = H::idle(0);
    h.s(envio()).s(Senal::TxEndTurn);
    h.avanza(1_000).s(Senal::Actividad { agent_id: None });
    h.avanza(1_000);
    assert_eq!(h.e.status, S::Working, "hubo actividad tras el end_turn");
    h.s(Senal::TxEndTurn).avanza(1_500);
    assert_eq!(h.e.status, S::Idle);
}

#[test]
fn red_de_seguridad_con_puente_a_los_3_s() {
    let mut h = H::trabajando_v2();
    h.s(Senal::TxTurnDuration);
    h.avanza(2_000);
    assert_eq!(h.e.status, S::Working, "con puente decide TurnoFin");
    h.avanza(1_000);
    assert_eq!(h.e.status, S::Idle);
}

#[test]
fn menu_abierto_en_idle_y_su_salida() {
    let mut h = H::idle(2);
    h.s(pantalla(P::Dialog)).avanza(900);
    assert_eq!(h.e.status, S::Idle);
    h.avanza(100);
    assert_eq!(h.e.waiting.as_ref().map(|w| w.kind), Some(WaitKind::Menu));
    h.s(envio());
    assert_eq!(h.e.status, S::Waiting, "el composer no escribe en un menú");
    h.s(pantalla(P::Prompt)).avanza(500);
    assert_eq!(h.e.status, S::Idle);
}

#[test]
fn reconciliacion_por_pantalla_sin_turno() {
    let mut h = H::idle(0);
    h.t.sin_evidencia = 1;
    h.s(envio()).s(pantalla(P::Prompt));
    h.avanza(3_000);
    assert_eq!(h.e.status, S::Working, "envío sin evidencia");
    h.avanza(8_000);
    assert_eq!(h.e.status, S::Idle, "más de 10 s sin evidencia");
}

fn turnos(h: &H) -> usize {
    h.todos
        .iter()
        .filter(|e| matches!(e, Efecto::EmitirTurno(_)))
        .count()
}

/// #41.3: el `turnEnd` deja la sesión en working por un `cliQueued` que la
/// CLI absorbe en ese mismo turno. Si cuando llega el eco del transcript ya
/// no queda nada pendiente, la sesión pasa a idle en el acto (antes esperaba
/// ~3 s a la reconciliación por pantalla) y sin un segundo turno.
#[test]
fn el_eco_del_cierre_sin_pendientes_pasa_a_idle() {
    let mut h = H::trabajando_v2();
    h.t = tickets(0, 1);
    h.s(fin("t1"));
    assert_eq!(h.e.status, S::Working, "queda el cliQueued");
    h.todos.clear();
    h.t = ResumenTickets::default(); // cliQueued → absorbed
    h.ahora += 100;
    h.s(Senal::TxTurnDuration);
    assert_eq!(h.e.status, S::Idle, "{:?}", h.todos);
    assert!(h.drena(), "idle drena la cola");
    h.avanza(3_500);
    assert_eq!(turnos(&h), 0, "sin turno fantasma: {:?}", h.todos);
}

/// Caso negativo (carrera de #41.3): un `prompt` del puente sin `turnId`
/// entre el `turnEnd` y el eco abre el turno siguiente. Aunque los tickets ya
/// no tengan pendientes, el eco no puede marcar idle (ni drenar) hasta su
/// `turnStart`.
#[test]
fn un_prompt_antes_del_eco_mantiene_working() {
    let mut h = H::trabajando_v2();
    h.t = tickets(1, 0);
    h.s(fin("t1"));
    h.todos.clear();
    h.ahora += 40;
    h.t = ResumenTickets::default(); // sending → delivered por el prompt
    h.s(Senal::PromptEntrado {
        turn_id: None,
        texto: "hola".into(),
        origen: "user".into(),
    });
    h.ahora += 60;
    h.s(Senal::TxTurnDuration);
    assert_eq!(h.e.status, S::Working, "{:?}", h.todos);
    assert!(!h.drena(), "no drena con un turno empezando");
    h.s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.avanza(3_500);
    assert_eq!(h.e.status, S::Working);
    assert_eq!(turnos(&h), 0, "{:?}", h.todos);
}

/// Contrato §1: un arranque largo no se marca como «TUI congelada» (motivo
/// de `working`), sino con su motivo propio, que la línea de estado traduce
/// a «Reiniciar sesión».
#[test]
fn un_arranque_largo_no_se_marca_como_tui_congelada() {
    let mut h = H::nuevo();
    h.avanza(31_000);
    assert_eq!(h.e.status, S::Starting);
    let motivo = h.e.stalled.as_ref().map(|s| s.reason);
    assert_ne!(motivo, Some(StallReason::TuiFrozen));
    assert_eq!(motivo, Some(StallReason::StartupTimeout));
    h.s(pantalla(P::Prompt)).avanza(300);
    assert_eq!(h.e.status, S::Idle);
}

/// #32: un arranque que no llega al prompt (pantalla sin reconocer y sin
/// `hello`) quedaba en «Arrancando Claude…» sin plazo ni salida.
#[test]
fn arranque_sin_prompt_en_30_s_queda_stalled_por_arranque() {
    let mut h = H::nuevo();
    h.avanza(29_000);
    assert!(h.e.stalled.is_none(), "dentro del plazo");
    h.avanza(2_000);
    assert_eq!(h.e.status, S::Starting);
    let st = h.e.stalled.clone().expect("stalled de arranque");
    assert_eq!(st.reason, StallReason::StartupTimeout);
    assert!(st.detail.contains("unknown"), "{}", st.detail);
    assert!(
        h.hay(|e| *e == Efecto::EmitirSesiones),
        "se avisa a la ventana"
    );
    h.s(pantalla(P::Prompt)).avanza(300);
    assert_eq!(h.e.status, S::Idle);
    assert!(h.e.stalled.is_none(), "al llegar al prompt se retira");
}

/// Caso negativo: el plazo cuenta desde la entrada en `starting`, no desde el
/// alta; un reinicio tras un minuto en idle no nace vencido.
#[test]
fn el_plazo_de_arranque_empieza_en_cada_reinicio() {
    let mut h = H::idle(2);
    h.avanza(60_000);
    h.s(Senal::ReinicioPedido).avanza(10_000);
    assert_eq!(h.e.status, S::Starting);
    assert!(h.e.stalled.is_none(), "{:?}", h.e.stalled);
    h.avanza(21_000);
    assert_eq!(
        h.e.stalled.as_ref().map(|s| s.reason),
        Some(StallReason::StartupTimeout)
    );
}

/// #50: el bloque de menú abierto por un `/comando` lleva el comando en la
/// etiqueta; abierto a mano en la TUI, la genérica.
#[test]
fn el_menu_de_un_comando_lleva_el_comando_en_la_etiqueta() {
    let mut h = H::idle(2);
    h.s(Senal::ComandoInicio {
        run_id: "r1".into(),
        nombre: "/config".into(),
    });
    h.s(pantalla(P::Dialog)).avanza(1_000);
    let w = h.e.waiting.clone().expect("menú");
    assert_eq!((w.kind, w.label.as_str()), (WaitKind::Menu, "/config"));
    let mut g = H::idle(2);
    g.s(pantalla(P::Dialog)).avanza(1_000);
    assert_eq!(
        g.e.waiting.map(|w| w.label).as_deref(),
        Some("Menú abierto en la TUI")
    );
}

/// #50: `waiting.options` sale de la pantalla emulada al proyectar (antes
/// siempre `None`) y avisa del cambio para emitir; sin monitor, `None`.
#[test]
fn la_proyeccion_rellena_las_opciones_del_menu_desde_la_pantalla() {
    let bytes: &[u8] = include_bytes!("fixtures/tui/modelo.ans");
    let corte = 12_971; // «model-abierto» de fixtures/tui/modelo.json
    let mut h = H::idle(2);
    h.s(pantalla(P::Dialog)).avanza(1_000);
    let id = format!("opc-{}", uuid::Uuid::new_v4());
    let mut info = crate::sesiones::registro::sesion_de_prueba(&id).info;
    assert!(!proyectar(&h.e, &mut info), "sin monitor no hay opciones");
    assert!(info.waiting.as_ref().is_some_and(|w| w.options.is_none()));
    let m = std::sync::Arc::new(crate::sesiones::pantalla::Monitor::nuevo(48, 160));
    m.alimentar(&bytes[..corte]);
    crate::sesiones::pantalla::registrar(&id, m);
    assert!(proyectar(&h.e, &mut info), "las opciones cambiaron");
    let opciones = info
        .waiting
        .as_ref()
        .and_then(|w| w.options.clone())
        .expect("opciones");
    assert!(opciones
        .iter()
        .any(|o| o.selected && o.label.starts_with("Opus 5.5")));
    assert!(
        !proyectar(&h.e, &mut info),
        "mismas opciones: nada que emitir"
    );
    crate::sesiones::pantalla::olvidar(&id);
}

/// El reinicio mata el proceso con su cola nativa: pide fallar los
/// `cliQueued`, pero no los envíos en general (los `queued` se conservan).
#[test]
fn el_reinicio_falla_la_cola_nativa() {
    let mut h = H::trabajando_v2();
    h.s(Senal::ReinicioPedido);
    assert!(h.hay(|e| matches!(e, Efecto::FallarColaCli { .. })));
    assert!(!h.hay(|e| matches!(e, Efecto::FallarEnvios { .. })));
}

/// El `turnStart` del turno siguiente llega antes que el eco del cierre del
/// anterior: el eco no arma la red, y el turno nuevo no se cierra aunque
/// pase más de 3 s sin actividad (TTFT largo).
#[test]
fn el_eco_del_cierre_tras_el_turn_start_siguiente_no_cierra_el_turno() {
    let mut h = H::trabajando_v2();
    h.t = tickets(0, 1);
    h.s(fin("t1"));
    h.todos.clear();
    h.ahora += 30;
    h.t = ResumenTickets::default();
    h.s(Senal::PromptEntrado {
        turn_id: None,
        texto: "siguiente".into(),
        origen: "user".into(),
    });
    h.s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.ahora += 90;
    h.s(Senal::TxTurnDuration);
    assert_eq!(h.e.tx_fin_red, None, "el eco no arma la red");
    h.avanza(5_000);
    assert_eq!(
        (h.e.status, h.e.turn_id()),
        (S::Working, Some("t2")),
        "{:?}",
        h.todos
    );
    assert_eq!(turnos(&h), 0, "{:?}", h.todos);
    h.s(fin("t2"));
    assert_eq!(h.e.status, S::Idle, "el turnEnd real sí cierra t2");
}
