// sesiones/tests_maquina_noche.rs — Estabilidad nocturna de la máquina de
// estados: la cola no se drena tras un cierre de turno por plazo con puente
// (hallazgo 2) y un salto de reloj por suspensión no vence plazos (hallazgo
// 5). Cada caso fallaba con el comportamiento anterior o fija un caso
// negativo.

use super::*;
use crate::sesiones::registro::cableado::{debe_reintentar_drenaje, ColaDrenable};
use crate::sesiones::senales::{EnvioKind, EstadoPantalla as P, Senal};
use crate::sesiones::types::SessionStatus as S;

const T0: Ms = 1_700_000_000_000;

struct H {
    e: EstadoSesion,
    ahora: Ms,
    t: ResumenTickets,
    todos: Vec<Efecto>,
}

impl H {
    /// Idle con el protocolo dado (prompt estable 300 ms).
    fn idle(protocolo: u8) -> Self {
        let mut h = Self {
            e: EstadoSesion::nuevo(T0),
            ahora: T0,
            t: ResumenTickets::default(),
            todos: Vec::new(),
        };
        h.e.protocolo = protocolo;
        h.s(pantalla(P::Prompt)).avanza(300);
        assert_eq!(h.e.status, S::Idle, "arranque");
        h.todos.clear();
        h
    }

    /// Working v2 con el turno `t1` abierto y el prompt a la vista.
    fn turno_con_prompt() -> Self {
        let mut h = Self::idle(2);
        h.s(envio()).s(Senal::TurnoInicio {
            turn_id: "t1".into(),
        });
        h.s(pantalla(P::Busy)).s(pantalla(P::Prompt));
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

    /// Avanza `ms` con un tick por segundo, como en producción.
    fn pasa(&mut self, ms: Ms) -> &mut Self {
        for _ in 0..ms / 1_000 {
            self.avanza(1_000);
        }
        self
    }

    fn drena(&self) -> bool {
        self.todos.contains(&Efecto::Drenar)
    }

    fn avisa_pausa(&self) -> bool {
        self.todos
            .iter()
            .any(|e| matches!(e, Efecto::Aviso { texto, .. } if texto.contains("retengo")))
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

fn envio() -> Senal {
    Senal::EnvioEscrito {
        client_id: "c1".into(),
        kind: EnvioKind::Prompt,
        texto: "hola".into(),
    }
}

fn fin(t: &str) -> Senal {
    Senal::TurnoFin {
        turn_id: t.into(),
        motivo: "answer".into(),
        abortado: false,
    }
}

// ---------------------------------------------------------------------------
// Hallazgo 2: cierre por plazo con puente
// ---------------------------------------------------------------------------

/// `turnEnd perdido` (motivo `lost`) con puente: idle sin drenar, con aviso y
/// sin reintento por pantalla; el `turnEnd` real (atrasado) reanuda.
#[test]
fn turno_perdido_con_puente_no_drena_y_el_turn_end_real_reanuda() {
    let mut h = H::turno_con_prompt();
    h.t.en_cola_ultron = 1;
    h.pasa(10_000);
    assert_eq!(h.e.status, S::Idle, "10 s de prompt quieto: turno perdido");
    assert!(!h.drena(), "el cierre por plazo no drena: {:?}", h.todos);
    assert!(h.avisa_pausa(), "nota visible: {:?}", h.todos);
    assert!(h.e.pausa_drenaje);
    assert!(
        !debe_reintentar_drenaje(&h.e, ColaDrenable::con_cola()),
        "el reintento por Tick/Pantalla respeta la pausa"
    );
    h.pasa(5_000);
    assert!(!h.drena(), "ni los ticks siguientes");
    h.s(fin("t1"));
    assert!(h.drena(), "el turnEnd real reanuda: {:?}", h.todos);
    assert!(!h.e.pausa_drenaje);
    assert_eq!(h.e.pausa_plazo, None);
    assert!(debe_reintentar_drenaje(&h.e, ColaDrenable::con_cola()));
}

/// Sin evidencia del puente, 30 s de prompt estable en idle reanudan.
#[test]
fn prompt_estable_30_s_reanuda_tras_el_cierre_por_plazo() {
    let mut h = H::turno_con_prompt();
    h.pasa(10_000);
    assert_eq!(h.e.status, S::Idle);
    h.todos.clear();
    h.pasa(29_000);
    assert!(!h.drena(), "29 s: sigue en pausa");
    h.pasa(1_000);
    assert!(h.drena(), "30 s de prompt estable: {:?}", h.todos);
    assert!(!h.e.pausa_drenaje);
}

/// La TUI ocupada reinicia los 30 s de prompt estable (caso negativo).
#[test]
fn la_tui_ocupada_reinicia_el_plazo_de_reanudacion() {
    let mut h = H::turno_con_prompt();
    h.pasa(10_000);
    h.todos.clear();
    h.pasa(20_000);
    h.s(pantalla(P::Busy));
    h.pasa(1_000);
    h.s(pantalla(P::Prompt));
    h.pasa(29_000);
    assert!(!h.drena(), "el prompt lleva 29 s: {:?}", h.todos);
    h.pasa(1_000);
    assert!(h.drena());
}

#[test]
fn hello_del_puente_reanuda_la_cola() {
    let mut h = H::turno_con_prompt();
    h.pasa(10_000);
    h.todos.clear();
    h.s(Senal::PuenteHello {
        protocolo: 2,
        claude_session_id: None,
        generacion: 2,
        transcript_path: None,
        origen: "start".into(),
    });
    assert!(h.drena(), "{:?}", h.todos);
}

/// Red de seguridad (`tx_fin_red`) con puente: tampoco drena.
#[test]
fn red_de_seguridad_con_puente_no_drena() {
    let mut h = H::idle(2);
    h.t.en_cola_ultron = 1;
    h.s(envio()).s(Senal::TurnoInicio {
        turn_id: "t1".into(),
    });
    h.todos.clear();
    h.s(Senal::TxTurnDuration).avanza(3_000);
    assert_eq!(h.e.status, S::Idle, "{:?}", h.todos);
    assert!(!h.drena(), "{:?}", h.todos);
    assert!(h.avisa_pausa());
    h.s(fin("t1"));
    assert!(h.drena(), "el turnEnd atrasado reanuda");
}

/// Sin puente, el transcript es la única fuente: se conserva el drenaje.
#[test]
fn sin_puente_el_cierre_por_transcript_sigue_drenando() {
    let mut h = H::idle(0);
    h.s(envio()).s(Senal::TxEndTurn);
    h.avanza(1_500);
    assert_eq!(h.e.status, S::Idle);
    assert!(h.drena());
    assert!(!h.avisa_pausa());
    assert_eq!(h.e.pausa_plazo, None);
}

/// Un turno real tras el cierre por plazo drena al acabar con su `turnEnd`.
#[test]
fn el_turno_siguiente_cerrado_de_verdad_drena() {
    let mut h = H::turno_con_prompt();
    h.pasa(10_000);
    h.s(envio()).s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.todos.clear();
    h.s(fin("t2"));
    assert_eq!(h.e.status, S::Idle);
    assert!(h.drena());
}

/// La pausa de una recuperación (Esc o Ctrl+C) no la levanta el prompt
/// estable aunque hubiera un cierre por plazo antes.
#[test]
fn la_recuperacion_no_se_reanuda_por_prompt_estable() {
    let mut h = H::turno_con_prompt();
    h.pasa(10_000);
    h.s(envio()).s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.s(Senal::RecuperacionTerminada {
        ok: true,
        motivo: None,
    });
    assert_eq!(h.e.status, S::Idle);
    h.todos.clear();
    h.pasa(40_000);
    assert!(!h.drena(), "{:?}", h.todos);
    assert!(h.e.pausa_drenaje);
}

// ---------------------------------------------------------------------------
// Hallazgo 5: salto de reloj
// ---------------------------------------------------------------------------

#[test]
fn salto_de_reloj_solo_por_encima_de_30_s() {
    assert_eq!(salto_de_reloj(None, T0), None, "sin tick previo");
    assert_eq!(salto_de_reloj(Some(T0), T0 + 1_000), None);
    assert_eq!(salto_de_reloj(Some(T0), T0 + 30_000), None);
    assert_eq!(salto_de_reloj(Some(T0), T0 + 31_000), Some(31_000));
    assert_eq!(salto_de_reloj(Some(T0 + 5), T0), None, "reloj atrás");
}

/// Suspensión de 1 h con un turno abierto y el prompt a la vista: con el
/// rebase, el primer tick no cierra el turno ni marca colgado; sin él
/// (caso negativo), vencen todos los plazos a la vez.
#[test]
fn un_salto_de_reloj_rebasado_no_cierra_el_turno_ni_marca_colgado() {
    let mut h = H::turno_con_prompt();
    h.s(Senal::HerramientaInicio {
        tool_use_id: "b1".into(),
        nombre: "Bash".into(),
        timeout_ms: Some(60_000),
    })
    .s(Senal::HerramientaFin {
        tool_use_id: "b1".into(),
    });
    h.pasa(2_000);
    let antes = h.e.clone();

    let mut sin = H {
        e: antes.clone(),
        ahora: h.ahora + 3_600_000,
        t: ResumenTickets::default(),
        todos: Vec::new(),
    };
    sin.s(Senal::Tick);
    assert_eq!(
        sin.e.status,
        S::Idle,
        "sin rebase el turno se da por perdido"
    );

    h.ahora += 3_600_000;
    rebasar_reloj(&mut h.e, h.ahora, 3_600_000);
    h.s(Senal::Tick);
    assert_eq!(h.e.status, S::Working, "{:?}", h.todos);
    assert_eq!(h.e.turn_id(), Some("t1"));
    assert_eq!(h.e.stalled, None, "ningún colgado por el hueco");
    h.pasa(9_000);
    assert_eq!(
        h.e.status,
        S::Working,
        "los 10 s cuentan desde la reanudación"
    );
}

/// Con la TUI ocupada y una herramienta abierta: ni `tuiFrozen` ni
/// `toolOverdue` por el hueco.
#[test]
fn el_rebase_no_marca_tui_congelada_ni_herramienta_vencida() {
    let mut h = H::turno_con_prompt();
    h.s(pantalla(P::Busy)).s(Senal::HerramientaInicio {
        tool_use_id: "b1".into(),
        nombre: "Bash".into(),
        timeout_ms: Some(60_000),
    });
    h.pasa(2_000);
    let desde = h.e.herramientas["b1"].desde;
    let mut sin = H {
        e: h.e.clone(),
        ahora: h.ahora + 3_600_000,
        t: ResumenTickets::default(),
        todos: Vec::new(),
    };
    sin.s(Senal::Tick);
    assert!(sin.e.stalled.is_some(), "sin rebase: colgado");

    h.ahora += 3_600_000;
    rebasar_reloj(&mut h.e, h.ahora, 3_600_000);
    h.s(Senal::Tick);
    assert_eq!(h.e.stalled, None, "{:?}", h.e.stalled);
    assert_eq!(h.e.herramientas["b1"].desde, desde + 3_600_000);
}

/// Dos Bash en paralelo de edades distintas: el rebase las desplaza el hueco
/// y Ctrl+B sigue eligiendo la más reciente. Con el rebase a `ahora` (caso
/// negativo) empataban y el desempate por `toolUseId` elegía la vieja.
#[test]
fn el_rebase_conserva_el_orden_de_las_herramientas_abiertas() {
    use crate::sesiones::segundo_plano::primer_plano;
    let bash = |id: &str| Senal::HerramientaInicio {
        tool_use_id: id.into(),
        nombre: "Bash".into(),
        timeout_ms: Some(600_000),
    };
    let mut h = H::turno_con_prompt();
    h.s(pantalla(P::Busy)).s(bash("z-vieja"));
    h.pasa(5_000);
    h.s(bash("a-nueva"));
    h.pasa(1_000);
    let antes = primer_plano(&h.e).expect("herramienta").tool_use_id;
    assert_eq!(antes, "a-nueva");

    h.ahora += 3_600_000;
    rebasar_reloj(&mut h.e, h.ahora, 3_600_000);
    let despues = primer_plano(&h.e).expect("herramienta").tool_use_id;
    assert_eq!(
        despues, antes,
        "la misma herramienta antes y después del salto"
    );
    let d = |id: &str| h.e.herramientas[id].desde;
    assert_eq!(d("a-nueva") - d("z-vieja"), 5_000, "conservan la distancia");
}
