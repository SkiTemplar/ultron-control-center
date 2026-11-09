// sesiones/tests_maquina_huerfanos.rs — Máquina de estados: envíos y
// tickets huérfanos, red de seguridad del cierre de turno, proyección a
// `SessionInfo`, relanzamiento y actividad del puente que mantiene vivo el
// turno. Comparte el arnés `H` de `tests_maquina.rs`. Cada caso fallaba con
// el comportamiento anterior o fija un caso negativo.

use super::tests::{ask, envio, fin, pantalla, tickets, H};
use super::*;
use crate::sesiones::senales::{EstadoPantalla as P, Senal};
use crate::sesiones::types::{SessionStatus as S, StallReason};

/// Regresión 2026-10-12: un envío que la CLI nunca confirma (`cliQueued` o
/// `sending` huérfano) dejaba la sesión en working para siempre, porque la
/// actividad del turno borra `envio_desde` y con él la salida por caducidad.
#[test]
fn ticket_huerfano_tras_el_turno_no_deja_working_para_siempre() {
    let mut h = H::trabajando_v2();
    h.t.en_cola_cli = 1;
    h.s(Senal::Actividad { agent_id: None });
    h.s(Senal::TurnoFin {
        turn_id: "t1".into(),
        motivo: "answer".into(),
        abortado: false,
    });
    assert_eq!(
        h.e.status,
        S::Working,
        "con un envío en la cola nativa sigue working"
    );
    h.s(pantalla(P::Prompt)).avanza(9_000);
    assert_eq!(
        h.e.status,
        S::Working,
        "antes de 10 s de prompt quieto no decide (caso negativo)"
    );
    assert!(!h.hay(|e| *e == Efecto::ResolverHuerfanos));
    h.avanza(1_500);
    assert_eq!(
        h.e.status,
        S::Idle,
        "prompt quieto 10 s sin turno: la CLI ya no tiene nada"
    );
    let resolver = h.todos.iter().position(|e| *e == Efecto::ResolverHuerfanos);
    let drenar = h.todos.iter().position(|e| *e == Efecto::Drenar);
    assert!(
        resolver.is_some_and(|r| drenar.is_some_and(|d| r < d)),
        "resuelve los huérfanos antes de drenar"
    );
}

#[test]
fn actividad_reciente_aplaza_la_resolucion_de_huerfanos() {
    let mut h = H::trabajando_v2();
    h.t.sin_evidencia = 1;
    h.s(Senal::TurnoFin {
        turn_id: "t1".into(),
        motivo: "answer".into(),
        abortado: false,
    });
    h.s(pantalla(P::Prompt)).avanza(8_000);
    h.s(Senal::Actividad { agent_id: None });
    h.avanza(3_000);
    assert_eq!(
        h.e.status,
        S::Working,
        "hubo actividad hace 3 s: aún no son huérfanos"
    );
    h.avanza(8_000);
    assert_eq!(h.e.status, S::Idle);
}

#[test]
fn proyeccion_a_session_info() {
    let mut h = H::trabajando_v2();
    h.s(ask("a1"));
    let mut info = crate::sesiones::registro::sesion_de_prueba("x").info;
    proyectar(&h.e, &mut info);
    assert_eq!(info.status, S::Waiting);
    assert_eq!(info.turn_id.as_deref(), Some("t1"));
    assert_eq!(info.bridge_protocol, 2);
    assert!(info
        .working_since
        .as_deref()
        .is_some_and(|s| s.ends_with('Z')));
    assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
}

/// Regresión (log real): el `turn_duration` del turno A llega tarde, con B ya
/// en marcha; la red de seguridad cerraba B a los 3 s como «answer» y su
/// `turnEnd` real se ignoraba.
#[test]
fn red_de_seguridad_no_cierra_el_turno_siguiente() {
    let mut h = H::trabajando_v2();
    h.s(fin("t1"));
    assert_eq!(h.e.status, S::Idle);
    h.s(envio()).s(Senal::TxTurnDuration);
    h.s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.avanza(3_500);
    assert_eq!(h.e.status, S::Working, "la evidencia era de t1, no de t2");
    assert!(!h.e.cerrados.contains(&"t2".to_string()));
    h.s(fin("t2"));
    assert_eq!(h.e.status, S::Idle, "el turnEnd real de t2 cierra");
}

#[test]
fn red_de_seguridad_se_anula_si_el_turno_sigue_activo() {
    let mut h = H::trabajando_v2();
    h.s(fin("t1"));
    h.s(envio()).s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.s(Senal::TxTurnDuration);
    h.avanza(1_000).s(Senal::Progreso);
    h.avanza(2_500);
    assert_eq!(
        h.e.status,
        S::Working,
        "hubo progreso tras la evidencia: no era el fin de t2"
    );
    h.s(Senal::TxTurnDuration).avanza(3_000);
    assert_eq!(h.e.status, S::Idle, "evidencia nueva y silencio: cierra");
}

/// Un `sending` sin evidencia en idle (reinicio, recuperación, comando por
/// buzón o «enviar ya» en el arranque) bloqueaba el drenaje para siempre.
#[test]
fn sending_huerfano_en_idle_se_resuelve_con_plazo() {
    let mut h = H::idle(2);
    h.t.sin_evidencia = 1;
    for _ in 0..15 {
        h.avanza(1_000);
    }
    assert!(
        !h.hay(|e| *e == Efecto::ResolverHuerfanos),
        "antes de 15 s no decide (caso negativo)"
    );
    h.avanza(1_000);
    assert!(h.hay(|e| *e == Efecto::ResolverHuerfanos));
    assert_eq!(h.e.status, S::Idle);
}

#[test]
fn sending_huerfano_tras_reinicio_o_recuperacion_no_queda_vivo() {
    let mut h = H::trabajando_v2();
    h.t.sin_evidencia = 1;
    h.s(Senal::ReinicioPedido)
        .s(pantalla(P::Prompt))
        .avanza(300);
    assert_eq!(h.e.status, S::Idle);
    h.avanza(16_000);
    assert!(h.hay(|e| *e == Efecto::ResolverHuerfanos), "reinicio");
    let mut h = H::trabajando_v2();
    h.t.sin_evidencia = 1;
    h.s(pantalla(P::Prompt)).s(Senal::RecuperacionTerminada {
        ok: true,
        motivo: None,
    });
    assert_eq!(h.e.status, S::Idle);
    h.avanza(16_000);
    assert!(h.hay(|e| *e == Efecto::ResolverHuerfanos), "recuperación");
}

#[test]
fn actividad_en_idle_aplaza_el_sending_huerfano() {
    let mut h = H::idle(2);
    h.t.sin_evidencia = 1;
    h.avanza(1_000).avanza(13_000);
    h.s(Senal::Actividad { agent_id: None });
    h.avanza(3_000);
    assert!(
        !h.hay(|e| *e == Efecto::ResolverHuerfanos),
        "actividad hace 3 s: aún no es huérfano"
    );
    h.avanza(8_000);
    assert!(h.hay(|e| *e == Efecto::ResolverHuerfanos));
}

/// El proceso relanzado sale antes de llegar a idle: antes se ignoraba su
/// `ProcesoSalio` y la sesión se quedaba en starting para siempre.
#[test]
fn el_proceso_relanzado_que_sale_en_el_arranque_termina() {
    let mut h = H::trabajando_v2();
    h.s(Senal::ReinicioPedido)
        .s(Senal::ProcesoSalio { code: 0 })
        .s(Senal::ProcesoSalio { code: 1 });
    assert_eq!((h.e.status, h.e.exit_code), (S::Exited, Some(1)));
    let mut h = H::trabajando_v2();
    h.s(Senal::ProcesoSalio { code: 3 });
    h.s(Senal::ReinicioPedido)
        .s(Senal::ProcesoSalio { code: 4 });
    assert_eq!(
        (h.e.status, h.e.exit_code),
        (S::Exited, Some(4)),
        "desde exited no queda salida anterior que esperar"
    );
    let mut h = H::trabajando_v2();
    h.s(Senal::ReinicioPedido).avanza(6_000);
    h.s(Senal::ProcesoSalio { code: 5 });
    assert_eq!(
        (h.e.status, h.e.exit_code),
        (S::Exited, Some(5)),
        "la salida anterior ya no llegará (PTY sustituido)"
    );
}

/// El primer envío tras más de 2 min en idle mostraba al instante
/// «Sin eventos desde hace 2 min».
#[test]
fn primer_envio_tras_mucho_idle_no_marca_sin_eventos() {
    let mut h = H::idle(2);
    h.avanza(200_000);
    h.s(envio());
    assert_eq!(h.e.status, S::Working);
    assert!(h.e.stalled.is_none(), "{:?}", h.e.stalled);
    h.s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    })
    .s(pantalla(P::Unknown));
    h.avanza(121_000);
    assert_eq!(
        h.e.stalled.as_ref().map(|s| s.reason),
        Some(StallReason::NoEvents),
        "pasado el umbral sí marca (caso negativo)"
    );
}

/// Tras interrumpir, lo devuelto a la cola no se reenvía solo: el reintento
/// del drenaje anulaba el `a_idle(drenar=false)` de la recuperación.
#[test]
fn tras_la_recuperacion_no_se_reintenta_el_drenaje() {
    use crate::sesiones::registro::cableado::{debe_reintentar_drenaje, ColaDrenable};
    let mut h = H::trabajando_v2();
    h.s(pantalla(P::Prompt)).s(Senal::RecuperacionTerminada {
        ok: true,
        motivo: None,
    });
    h.avanza(1_000);
    assert_eq!(h.e.status, S::Idle);
    assert!(!debe_reintentar_drenaje(&h.e, ColaDrenable::con_cola()));
    h.s(envio()).s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.s(fin("t2")).s(pantalla(P::Prompt));
    assert!(
        debe_reintentar_drenaje(&h.e, ColaDrenable::con_cola()),
        "el siguiente turno cerrado reanuda el drenaje"
    );
}

/// La pantalla lleva 60 s en el prompt antes del turno: el turno recién
/// abierto no se da por perdido en el primer tick (antes, a los 0,5 s).
#[test]
fn un_turno_recien_abierto_con_la_pantalla_quieta_no_se_pierde() {
    let mut h = H::idle(2);
    h.avanza(60_000);
    h.s(Senal::TurnoInicio {
        turn_id: "t1".into(),
    });
    h.avanza(500);
    assert_eq!(h.e.status, S::Working);
    assert!(!h.hay(|e| matches!(e, Efecto::Log(l) if l.starts_with("turnEnd perdido"))));
}

/// Con el puente mandando actividad cada 2 s y la pantalla en el prompt, el
/// turno sigue vivo; cuando el puente calla 10 s, sí se da por perdido.
#[test]
fn la_actividad_del_puente_mantiene_vivo_el_turno() {
    let mut h = H::trabajando_v2();
    h.s(pantalla(P::Prompt));
    for _ in 0..10 {
        h.avanza(2_000).s(Senal::Actividad { agent_id: None });
    }
    assert_eq!(h.e.status, S::Working, "20 s con actividad");
    h.avanza(10_000);
    assert_eq!(h.e.status, S::Idle, "10 s sin actividad: perdido");
}

/// `turnEnd` del puente con un envío pendiente: el fin del mismo turno en el
/// transcript llega detrás y no puede emitir un segundo turno, fantasma.
#[test]
fn el_fin_del_transcript_tras_el_turn_end_no_emite_otro_turno() {
    let mut h = H::trabajando_v2();
    h.t = tickets(1, 0);
    h.s(fin("t1"));
    assert_eq!(h.e.status, S::Working, "queda el envío pendiente");
    h.ahora += 100;
    h.s(Senal::TxTurnDuration);
    h.avanza(3_500);
    let turnos = h
        .todos
        .iter()
        .filter(|e| matches!(e, Efecto::EmitirTurno(_)))
        .count();
    assert_eq!(turnos, 1, "{:?}", h.todos);
}

/// Caso negativo: pasados 2 s del `turnEnd`, un fin del transcript sí arma
/// la red de seguridad (es de otro turno sin `turnStart`).
#[test]
fn un_fin_del_transcript_tardio_sigue_armando_la_red() {
    let mut h = H::trabajando_v2();
    h.t = tickets(1, 0);
    h.s(fin("t1"));
    h.ahora += 2_500;
    h.s(Senal::TxTurnDuration);
    h.avanza(3_500);
    let turnos = h
        .todos
        .iter()
        .filter(|e| matches!(e, Efecto::EmitirTurno(_)))
        .count();
    assert_eq!(turnos, 2);
}
