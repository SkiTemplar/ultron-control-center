// sesiones/tests_maquina_pausas.rs — Retenciones de la cola: interrumpir (H1,
// auditoría 2026-11-01), turno cortado al restaurar y límite de uso. Cada camino
// drenaba con el comportamiento anterior; los casos negativos fijan que un turno
// normal sigue drenando.

use super::*;
use crate::sesiones::registro;
use crate::sesiones::senales::{EnvioKind, EstadoPantalla as P, Senal};
use crate::sesiones::types::{QueuePauseReason, SessionStatus as S};

const T0: Ms = 1_700_000_000_000;

struct H {
    e: EstadoSesion,
    ahora: Ms,
    t: ResumenTickets,
    todos: Vec<Efecto>,
}

impl H {
    /// Working v2 con el turno `t1` abierto y un mensaje en la cola de ULTRON.
    fn trabajando() -> Self {
        let mut h = Self {
            e: EstadoSesion::nuevo(T0),
            ahora: T0,
            t: ResumenTickets::default(),
            todos: Vec::new(),
        };
        h.e.protocolo = 2;
        h.s(pantalla(P::Prompt)).avanza(300);
        h.s(envio(EnvioKind::Prompt));
        h.s(Senal::TurnoInicio {
            turn_id: "t1".into(),
        });
        h.s(pantalla(P::Unknown));
        assert_eq!(h.e.status, S::Working, "arranque");
        h.t.en_cola_ultron = 1;
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

    fn motivo(&self) -> Option<String> {
        self.todos.iter().rev().find_map(|e| match e {
            Efecto::EmitirTurno(t) => Some(t.motivo.clone()),
            _ => None,
        })
    }

    fn avisos(&self) -> Vec<String> {
        self.todos
            .iter()
            .filter_map(|e| match e {
                Efecto::Aviso { texto, .. } => Some(texto.clone()),
                _ => None,
            })
            .collect()
    }

    fn pausa(&self) -> Option<QueuePauseReason> {
        let mut info = registro::sesion_de_prueba("pausas").info;
        proyectar(&self.e, &mut info);
        info.queue_pause.map(|p| p.reason)
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

fn envio(kind: EnvioKind) -> Senal {
    Senal::EnvioEscrito {
        client_id: "c".into(),
        kind,
        texto: "x".into(),
    }
}

fn fin(turn_id: &str, abortado: bool) -> Senal {
    Senal::TurnoFin {
        turn_id: turn_id.into(),
        motivo: "answer".into(),
        abortado,
    }
}

fn recuperada() -> Senal {
    Senal::RecuperacionTerminada {
        ok: true,
        motivo: None,
    }
}

// ---------------------------------------------------------------------------
// H1: interrumpir retiene la cola
// ---------------------------------------------------------------------------

/// Camino 1: `interrumpiendo` caduca a los 2 s y `$.turn.abort` cierra sin marca.
#[test]
fn un_turn_end_sin_marca_tras_caducar_la_interrupcion_no_drena() {
    let mut h = H::trabajando();
    h.s(Senal::InterrupcionPedida).avanza(2_100);
    assert_eq!(h.e.interrumpiendo, None, "ya caducó");
    h.s(fin("t1", false));
    assert_eq!(h.e.status, S::Idle);
    assert!(!h.drena(), "{:?}", h.todos);
    assert!(h.e.pausa_drenaje);
    assert_eq!(h.motivo().as_deref(), Some("aborted"), "con «Enviar ahora»");
}

/// Camino 2: abortado con pendientes; al resolverse, la reconciliación pasa a
/// idle con `a_idle(true)`.
#[test]
fn abortado_con_pendientes_no_drena_al_reconciliar() {
    let mut h = H::trabajando();
    h.t.en_cola_cli = 1;
    h.s(fin("t1", true));
    assert_eq!(h.e.status, S::Working, "relleno por lo pendiente");
    h.t.en_cola_cli = 0;
    h.s(pantalla(P::Prompt)).avanza(3_100);
    assert_eq!(h.e.status, S::Idle, "{:?}", h.todos);
    assert!(!h.drena(), "{:?}", h.todos);
}

/// Camino 3: la señal llega antes que la pantalla (debounce de 150-250 ms). El
/// cierre queda pendiente y se aplica con el prompt, sin drenar.
#[test]
fn la_recuperacion_antes_del_prompt_se_aplica_al_llegar_y_no_drena() {
    let mut h = H::trabajando();
    h.s(Senal::InterrupcionPedida).s(recuperada());
    assert_eq!(h.e.status, S::Working, "la pantalla aún no está en prompt");
    assert!(h.e.recuperado_sin_prompt);
    h.s(pantalla(P::Prompt));
    assert_eq!(h.e.status, S::Idle, "{:?}", h.todos);
    assert!(!h.e.recuperado_sin_prompt);
    assert!(!h.drena(), "{:?}", h.todos);
    h.pasa(40_000);
    assert!(!h.drena(), "ni el plazo: {:?}", h.todos);
}

/// Camino 3 sin `turnEnd`: el cierre por plazo tampoco drena ni promete una
/// reanudación a los 30 s.
#[test]
fn el_turno_perdido_tras_interrumpir_no_drena_ni_avisa_de_plazo() {
    let mut h = H::trabajando();
    h.s(Senal::InterrupcionPedida);
    h.s(pantalla(P::Prompt)).pasa(10_000);
    assert_eq!(h.e.status, S::Idle, "{:?}", h.todos);
    assert_eq!(h.motivo().as_deref(), Some("aborted"));
    assert_eq!(h.e.pausa_plazo, None);
    assert!(h.avisos().is_empty(), "{:?}", h.avisos());
    h.pasa(40_000);
    assert!(!h.drena(), "{:?}", h.todos);
}

/// La pausa sobrevive a un turno nuevo que la CLI abre por su cuenta (aviso de
/// una tarea en segundo plano) y cierra de forma normal.
#[test]
fn la_pausa_sobrevive_a_un_turno_posterior_de_la_cli() {
    let mut h = H::trabajando();
    h.s(Senal::InterrupcionPedida).s(fin("t1", true));
    h.s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    assert_eq!(h.e.status, S::Working);
    h.s(fin("t2", false));
    assert_eq!(h.e.status, S::Idle);
    assert!(!h.drena(), "{:?}", h.todos);
    assert_eq!(h.pausa(), Some(QueuePauseReason::Interrupted));
}

/// Un cierre por plazo anterior y su evidencia real no levantan la pausa de la
/// interrupción: `reanudar_cola` la respeta.
#[test]
fn el_hello_y_el_prompt_estable_no_levantan_la_interrupcion() {
    let mut h = H::trabajando();
    h.e.pausa_plazo = Some(h.ahora);
    h.s(Senal::InterrupcionPedida);
    h.s(Senal::PuenteHello {
        protocolo: 2,
        claude_session_id: None,
        generacion: 2,
        transcript_path: None,
        origen: "start".into(),
    });
    assert_eq!(h.e.pausa_plazo, None, "el hello sí quita la de plazo");
    h.s(fin("t1", false));
    assert!(!h.drena(), "{:?}", h.todos);
}

/// Esc en la terminal: no hay `InterrupcionPedida` y `turnEnd` llega sin marca.
/// La línea del transcript retiene lo que quede, también después del `turnEnd`.
#[test]
fn la_linea_de_interrupcion_del_transcript_retiene_la_cola() {
    let mut h = H::trabajando();
    h.s(fin("t1", false));
    assert!(h.drena(), "sin evidencia aún: turno normal");
    h.todos.clear();
    h.s(Senal::TxInterrumpido);
    assert!(h.e.pausa_drenaje);
    assert_eq!(h.pausa(), Some(QueuePauseReason::Interrupted));
    h.pasa(5_000);
    assert!(!h.drena(), "{:?}", h.todos);
}

/// «Enviar ahora» levanta la pausa; y sin pausa no hace nada (caso negativo).
#[test]
fn enviar_ahora_levanta_la_interrupcion() {
    let mut h = H::trabajando();
    h.s(Senal::InterrupcionPedida).s(fin("t1", true));
    h.todos.clear();
    h.s(Senal::ReanudarCola);
    assert!(h.drena(), "{:?}", h.todos);
    assert!(!h.e.pausa_drenaje);
    assert_eq!(h.pausa(), None);
    h.todos.clear();
    h.s(Senal::ReanudarCola);
    assert!(!h.drena(), "sin pausa no drena");
}

/// Un prompt del usuario levanta la pausa: al acabar su turno, drena.
#[test]
fn un_prompt_del_usuario_levanta_la_interrupcion() {
    let mut h = H::trabajando();
    h.s(Senal::InterrupcionPedida).s(fin("t1", true));
    h.s(envio(EnvioKind::Prompt)).s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.todos.clear();
    h.s(fin("t2", false));
    assert_eq!(h.e.status, S::Idle);
    assert!(h.drena(), "{:?}", h.todos);
    assert_eq!(h.motivo().as_deref(), Some("answer"));
}

/// Caso negativo: un `/comando` o un `!bash` no dicen que quiera seguir.
#[test]
fn un_comando_o_un_bash_no_levantan_la_interrupcion() {
    for kind in [
        EnvioKind::Bash,
        EnvioKind::Comando {
            nombre: "/usage".into(),
        },
    ] {
        let mut h = H::trabajando();
        h.s(Senal::InterrupcionPedida).s(fin("t1", true));
        h.s(envio(kind.clone()));
        assert!(h.e.pausa_interrupcion.is_some(), "{kind:?}");
    }
}

/// Reiniciar es decidir seguir: la cola sale al llegar al prompt.
#[test]
fn reiniciar_levanta_la_interrupcion() {
    let mut h = H::trabajando();
    h.s(Senal::InterrupcionPedida).s(fin("t1", true));
    h.s(Senal::ReinicioPedido);
    assert_eq!(h.e.pausa_interrupcion, None);
    h.todos.clear();
    h.s(pantalla(P::Prompt)).avanza(300);
    assert_eq!(h.e.status, S::Idle);
    assert!(h.drena(), "{:?}", h.todos);
}

/// Caso negativo: salir de un menú no es una interrupción y no deja nada pendiente.
#[test]
fn salir_de_un_menu_no_deja_el_cierre_pendiente() {
    let mut h = H::trabajando();
    h.s(pantalla(P::Busy)).s(recuperada());
    assert!(!h.e.recuperado_sin_prompt);
    h.s(pantalla(P::Prompt));
    assert_eq!(h.e.status, S::Working);
}

/// Caso negativo: la semántica de un turno normal no cambia.
#[test]
fn un_turno_normal_sigue_drenando() {
    let mut h = H::trabajando();
    h.s(fin("t1", false));
    assert_eq!(h.e.status, S::Idle);
    assert!(h.drena(), "{:?}", h.todos);
    assert!(!h.e.pausa_drenaje);
    assert_eq!(h.pausa(), None);
    assert_eq!(h.motivo().as_deref(), Some("answer"));
}

// ---------------------------------------------------------------------------
// Turno cortado al restaurar
// ---------------------------------------------------------------------------

/// La cola no sale sola sobre una tarea a medias, y lo enseña con su botón.
#[test]
fn con_turno_cortado_la_cola_espera_a_enviar_ahora() {
    let mut h = H {
        e: EstadoSesion::nuevo(T0),
        ahora: T0,
        t: ResumenTickets {
            en_cola_ultron: 2,
            ..ResumenTickets::default()
        },
        todos: Vec::new(),
    };
    h.s(Senal::TurnoCortado);
    h.s(pantalla(P::Prompt)).avanza(300);
    assert_eq!(h.e.status, S::Idle);
    assert!(!h.drena(), "{:?}", h.todos);
    assert_eq!(h.pausa(), Some(QueuePauseReason::Interrupted));
    h.s(Senal::ReanudarCola);
    assert!(h.drena(), "{:?}", h.todos);
}

/// Caso negativo: sin turno cortado, una sesión restaurada drena al arrancar.
#[test]
fn sin_turno_cortado_la_sesion_restaurada_drena() {
    let mut e = EstadoSesion::nuevo(T0);
    let t = ResumenTickets::default();
    (e, _) = transicion(&e, &pantalla(P::Prompt), T0, &t);
    let (n, ef) = transicion(&e, &Senal::Tick, T0 + 300, &t);
    assert_eq!(n.status, S::Idle);
    assert!(ef.contains(&Efecto::Drenar), "{ef:?}");
}

// ---------------------------------------------------------------------------
// Límite de uso
// ---------------------------------------------------------------------------

/// El aviso de cuota termina el turno: `turnEnd` normal y la cola no sale.
#[test]
fn con_el_limite_el_fin_de_turno_no_drena_y_avisa_una_vez() {
    let mut h = H::trabajando();
    h.t.en_cola_ultron = 3;
    h.s(Senal::LimiteUso).s(fin("t1", false));
    assert_eq!(h.e.status, S::Idle);
    assert!(!h.drena(), "{:?}", h.todos);
    assert_eq!(h.pausa(), Some(QueuePauseReason::UsageLimit));
    h.s(Senal::LimiteUso).s(Senal::LimiteUso);
    let avisos = h.avisos();
    assert_eq!(avisos.len(), 1, "{avisos:?}");
    assert!(avisos[0].contains("retengo 3 mensajes"), "{}", avisos[0]);
    assert!(avisos[0].contains("«Enviar ahora»"), "{}", avisos[0]);
}

/// El `turnEnd` del puente llega antes que el aviso: con la sesión ya en idle,
/// el reintento por pantalla o tick tampoco drena.
#[test]
fn el_limite_con_la_sesion_ya_en_idle_para_el_reintento() {
    let mut h = H::trabajando();
    h.s(fin("t1", false));
    assert!(!h.e.pausa_drenaje);
    h.s(Senal::LimiteUso);
    assert!(h.e.pausa_drenaje, "el reintento por tick respeta la pausa");
    h.todos.clear();
    h.pasa(120_000);
    assert!(!h.drena(), "{:?}", h.todos);
}

/// Sin nada en cola no hay aviso, pero lo que se encole después se ve.
#[test]
fn el_limite_con_la_cola_vacia_no_avisa_pero_es_visible() {
    let mut h = H::trabajando();
    h.t.en_cola_ultron = 0;
    h.s(Senal::LimiteUso);
    assert!(h.avisos().is_empty());
    assert_eq!(h.pausa(), Some(QueuePauseReason::UsageLimit));
}

/// Vuelta del relevo o de la cuota: en idle, drena al momento.
#[test]
fn el_fin_del_limite_reanuda_en_idle() {
    let mut h = H::trabajando();
    h.s(Senal::LimiteUso).s(fin("t1", false));
    h.todos.clear();
    h.s(Senal::LimiteFin);
    assert!(h.drena(), "{:?}", h.todos);
    assert!(!h.e.pausa_drenaje);
    assert_eq!(h.pausa(), None);
}

/// Trabajando (lo traído del relevo), drena al cerrar ese turno, no antes.
#[test]
fn el_fin_del_limite_trabajando_espera_al_fin_de_turno() {
    let mut h = H::trabajando();
    h.s(Senal::LimiteUso).s(Senal::LimiteFin);
    assert!(!h.drena(), "{:?}", h.todos);
    h.s(fin("t1", false));
    assert!(h.drena(), "{:?}", h.todos);
}

/// Caso negativo: `LimiteFin` sin pausa no drena nada.
#[test]
fn el_fin_del_limite_sin_pausa_no_hace_nada() {
    let mut h = H::trabajando();
    h.s(fin("t1", false));
    h.todos.clear();
    h.s(Senal::LimiteFin);
    assert!(!h.drena(), "{:?}", h.todos);
}

/// Una interrupción sigue reteniendo aunque vuelva la cuota, y al revés.
#[test]
fn el_limite_y_la_interrupcion_se_retienen_por_separado() {
    let mut h = H::trabajando();
    h.s(Senal::LimiteUso)
        .s(Senal::InterrupcionPedida)
        .s(fin("t1", true));
    assert_eq!(
        h.pausa(),
        Some(QueuePauseReason::UsageLimit),
        "manda el límite"
    );
    h.todos.clear();
    h.s(Senal::LimiteFin);
    assert!(!h.drena(), "sigue la interrupción: {:?}", h.todos);
    assert_eq!(h.pausa(), Some(QueuePauseReason::Interrupted));
    h.s(Senal::ReanudarCola);
    assert!(h.drena(), "{:?}", h.todos);
}

/// Un prompt no prueba que la cuota haya vuelto; «Enviar ahora» sí la levanta,
/// porque el usuario decide.
#[test]
fn un_prompt_no_levanta_el_limite_y_enviar_ahora_si() {
    let mut h = H::trabajando();
    h.s(Senal::LimiteUso).s(fin("t1", false));
    h.s(envio(EnvioKind::Prompt)).s(Senal::TurnoInicio {
        turn_id: "t2".into(),
    });
    h.todos.clear();
    h.s(fin("t2", false));
    assert!(!h.drena(), "{:?}", h.todos);
    h.s(Senal::ReanudarCola);
    assert!(h.drena(), "{:?}", h.todos);
    assert_eq!(h.e.pausa_limite, None);
}

/// El proceso nuevo tiene la misma cuota: reiniciar no levanta el límite.
#[test]
fn reiniciar_no_levanta_el_limite() {
    let mut h = H::trabajando();
    h.s(Senal::LimiteUso).s(Senal::ReinicioPedido);
    assert!(h.e.pausa_limite.is_some());
    h.todos.clear();
    h.s(pantalla(P::Prompt)).avanza(300);
    assert_eq!(h.e.status, S::Idle);
    assert!(!h.drena(), "{:?}", h.todos);
}

/// La vuelta del relevo con la sesión terminada: Reiniciar no queda retenido.
#[test]
fn el_fin_del_limite_vale_para_una_sesion_terminada() {
    let mut h = H::trabajando();
    h.s(Senal::LimiteUso).s(Senal::ProcesoSalio { code: 0 });
    assert_eq!(h.e.status, S::Exited);
    h.s(Senal::LimiteFin);
    assert_eq!(h.e.pausa_limite, None);
    h.s(Senal::LimiteUso);
    assert_eq!(h.e.pausa_limite, None, "terminada: el aviso no la pausa");
}
