// sesiones/registro_estado.rs — Cableado de la máquina de estados (contrato
// de estabilidad, §1.2 y §1.6): estado de cada sesión, manejador de señales,
// ejecución de efectos fuera de los locks, drenaje en un hilo propio y
// latencia por turno (`VEL-01`).
//
// `manejar_senal` es el manejador que ESTADO-B instala con
// `senales::instalar` en `sesiones::init`. El nuevo estado se aplica y se
// proyecta en `SessionInfo` con los mapas bloqueados (orden fijo: estados →
// registro); los efectos (E/S, eventos, cola, preguntas) se ejecutan después
// de soltarlos.
//
// Propiedad: WP-ESTADO.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde_json::json;

use super::{emit, emit_sessions, sink, update};
use crate::sesiones::buzon::{self, ahora_ms};
use crate::sesiones::cola::{self, Contexto};
use crate::sesiones::maquina::{self, Efecto, EstadoSesion, Ms, Nivel, TurnoCerrado};
use crate::sesiones::preguntas::Broker;
use crate::sesiones::senales::{EnvioKind, Senal};
use crate::sesiones::types::{ev, AskCancelReason, ScreenState, SessionStatus, TurnPayload};
use crate::sesiones::{ajustes, caja, catalogo, puente, puente_eventos, recuperacion, seguidor};

/// Drenaje de la cola en un hilo propio por sesión.
#[path = "registro_drenaje.rs"]
mod drenaje;
use drenaje::drenaje_automatico;
pub use drenaje::pedir_drenaje;

/// `lastActivityAt` viaja como mucho cada 5 s sin otros cambios (§1.6).
const EMISION_ACTIVIDAD: Ms = 5_000;

#[derive(Default)]
struct Latencia {
    envio: Option<Ms>,
    primer_evento: Option<Ms>,
    primer_token: Option<Ms>,
}

#[derive(Default)]
struct Estados {
    maquinas: HashMap<String, EstadoSesion>,
    ultima_emision: HashMap<String, Ms>,
    latencias: HashMap<String, Latencia>,
    terminales: HashSet<String>,
    /// Último `Tick` de cada sesión: base de la detección de saltos de reloj.
    ultimo_tick: HashMap<String, Ms>,
}

fn estados() -> &'static Mutex<Estados> {
    static E: OnceLock<Mutex<Estados>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(Estados::default()))
}

fn nuevo_estado(ahora: Ms) -> EstadoSesion {
    let mut e = EstadoSesion::nuevo(ahora);
    e.umbral_stall_ms = u64::from(ajustes::prefs_actuales().stall_seconds.clamp(60, 600)) * 1000;
    e
}

/// Manejador único de señales (§1.3). Sin sesión registrada, la señal se
/// descarta con traza.
pub fn manejar_senal(id: &str, s: Senal) {
    if matches!(s, Senal::ReinicioPedido) {
        // El reinicio conserva el id con un PTY nuevo, que nace sin terminal
        // enganchada: la pausa de la cola no puede sobrevivirle.
        quitar_terminal(id);
    }
    marcar_si_cambia_conversacion(id, &s);
    let ahora = ahora_ms();
    entregar_comando_por_senal(id, &s, ahora);
    let tickets = cola::global().resumen(id);
    let reintento = matches!(s, Senal::Pantalla { .. } | Senal::Tick);
    let (n, efectos, emitir) = {
        let Ok(mut g) = estados().lock() else {
            tracing::error!(sesion = id, "estados de sesión envenenados");
            return;
        };
        let mut actual = g
            .maquinas
            .get(id)
            .cloned()
            .unwrap_or_else(|| nuevo_estado(ahora));
        rebasar_si_salto(&mut g, id, &s, ahora, &mut actual);
        let (n, efectos) = maquina::transicion(&actual, &s, ahora, &tickets);
        // `proyectar` avisa si cambiaron las opciones del menú: sin cambio de
        // estado también hay que emitir, porque los botones de la ventana
        // resuelven su índice contra la pantalla del momento del clic (#50).
        let Ok(opciones) = update(id, |se| (false, maquina::proyectar(&n, &mut se.info))) else {
            // `rebasar_si_salto` ya pudo anotar el tick: se purga todo.
            purgar(&mut g, id);
            tracing::debug!(sesion = id, senal = ?s, "señal de una sesión que ya no existe");
            return;
        };
        g.maquinas.insert(id.to_string(), n.clone());
        latencia(&mut g, id, &s, ahora);
        let previa = g.ultima_emision.get(id).copied().unwrap_or(0);
        let cambio = efectos.contains(&Efecto::EmitirSesiones);
        let actividad =
            n.ultima_actividad > previa && ahora.saturating_sub(previa) >= EMISION_ACTIVIDAD;
        let emitir = cambio || actividad || opciones;
        if emitir {
            g.ultima_emision.insert(id.to_string(), ahora);
        }
        (n, efectos, emitir)
    };
    if emitir {
        emit_sessions();
    }
    ejecutar(id, efectos, &n);
    if reintento && debe_reintentar_drenaje(&n, cola_drenable(id)) {
        drenaje_automatico(id);
    }
}

/// Suspensión del PC (hallazgo nocturno 5): si entre el último `Tick` de la
/// sesión y esta señal pasaron más de `SALTO_RELOJ`, el proceso estuvo
/// parado y se rebasan los plazos de la máquina antes de la transición.
fn rebasar_si_salto(g: &mut Estados, id: &str, s: &Senal, ahora: Ms, e: &mut EstadoSesion) {
    let gap = maquina::salto_de_reloj(g.ultimo_tick.get(id).copied(), ahora);
    if matches!(s, Senal::Tick) || gap.is_some() {
        g.ultimo_tick.insert(id.to_string(), ahora);
    }
    if let Some(gap) = gap {
        maquina::rebasar_reloj(e, ahora, gap);
        tracing::info!(sesion = id, "reanudación detectada (gap {} s)", gap / 1000);
    }
}

/// Evidencia de entrega de un `/comando` en vuelo: su `commandStart` o
/// `commandEnd`, o el `hello` de la conversación nueva que abrió (`/clear`,
/// `/resume`…), que nunca aparece como mensaje que emparejar.
fn entregar_comando_por_senal(id: &str, s: &Senal, ahora: Ms) {
    let nombre = match s {
        Senal::ComandoInicio { nombre, .. } | Senal::ComandoFin { nombre, .. } => nombre.as_str(),
        Senal::PuenteHello { origen, .. } if origen == "clear" || origen == "resume" => {
            origen.as_str()
        }
        _ => return,
    };
    if cola::global().comando_entregado(id, nombre, ahora) {
        cola::emitir_actual(id);
    }
}

/// El fin de turno del puente suele llegar antes de que la TUI vuelva al
/// prompt: el drenaje de ese momento no escribe (pantalla ocupada) y nadie
/// lo repetía. Con la sesión en reposo, el prompt a la vista y elementos en
/// cola, cada señal de pantalla o tick lo vuelve a pedir; nunca tras un idle
/// sin drenaje (recuperación tras interrumpir). Tampoco cuando `cola::drenar`
/// no podría escribir (terminal enganchada o un `sending` sin evidencia): el
/// reintento lanzaría un hilo por tick que saldría sin hacer nada.
pub(crate) fn debe_reintentar_drenaje(n: &EstadoSesion, c: ColaDrenable) -> bool {
    c.en_cola
        && !c.sin_evidencia
        && !c.terminal
        && n.status == SessionStatus::Idle
        && n.pantalla == ScreenState::Prompt
        && !n.pausa_drenaje
}

/// Lo que el reintento del drenaje mira fuera de la máquina de estados.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ColaDrenable {
    /// Algún elemento `queued` espera turno.
    pub en_cola: bool,
    /// Algún envío `sending` sin evidencia: `cola::drenar` no escribe.
    pub sin_evidencia: bool,
    /// Terminal del bloque de menú enganchada: `cola::drenar` no escribe.
    pub terminal: bool,
}

impl ColaDrenable {
    /// Cola con elementos y nada que impida escribir (tests).
    #[cfg(test)]
    pub(crate) fn con_cola() -> Self {
        Self {
            en_cola: true,
            ..Self::default()
        }
    }
}

fn cola_drenable(id: &str) -> ColaDrenable {
    let c = cola::global();
    ColaDrenable {
        en_cola: c.hay_en_cola(id),
        sin_evidencia: c.resumen(id).sin_evidencia > 0,
        terminal: estados().lock().is_ok_and(|g| g.terminales.contains(id)),
    }
}

/// `/clear` o `/resume` escritos por ULTRON: el seguidor vigila el
/// transcript nuevo (reserva sin puente, §1.4).
fn marcar_si_cambia_conversacion(id: &str, s: &Senal) {
    let Senal::EnvioEscrito {
        kind: EnvioKind::Comando { nombre },
        ..
    } = s
    else {
        return;
    };
    let n = nombre.trim().trim_start_matches('/');
    let n = n.split_whitespace().next().unwrap_or_default();
    if seguidor::CAMBIAN_CONVERSACION.contains(&n) {
        seguidor::marcar_cambio_conversacion(id);
    }
}

fn latencia(g: &mut Estados, id: &str, s: &Senal, ahora: Ms) {
    let l = g.latencias.entry(id.to_string()).or_default();
    match s {
        Senal::EnvioEscrito { .. } => {
            *l = Latencia {
                envio: Some(ahora),
                ..Latencia::default()
            }
        }
        Senal::Pantalla { .. } | Senal::Tick | Senal::Progreso => {}
        _ => {
            if l.envio.is_some() && l.primer_evento.is_none() {
                l.primer_evento = Some(ahora);
            }
        }
    }
}

/// Primer delta de texto tras un envío (`t_first_token`). Solo actúa sobre
/// la latencia que abrió `EnvioEscrito`: no la crea tras el cierre.
pub fn primer_token(id: &str) {
    let ahora = ahora_ms();
    if let Ok(mut g) = estados().lock() {
        let Some(l) = g.latencias.get_mut(id) else {
            return;
        };
        if l.envio.is_some() && l.primer_token.is_none() {
            l.primer_token = Some(ahora);
        }
    }
}

fn registrar_latencia(id: &str) {
    let Ok(mut g) = estados().lock() else { return };
    let Some(l) = g.latencias.remove(id) else {
        return;
    };
    let Some(envio) = l.envio else { return };
    tracing::info!(
        sesion = id,
        t_first_event_ms = l.primer_evento.map(|t| t.saturating_sub(envio)),
        t_first_token_ms = l.primer_token.map(|t| t.saturating_sub(envio)),
        "latencia del turno"
    );
}

/// Estado de la máquina de una sesión.
pub fn estado(id: &str) -> Option<EstadoSesion> {
    estados().lock().ok()?.maquinas.get(id).cloned()
}

/// Contexto de la cola: estado, pantalla, protocolo y terminal adjunta.
pub fn contexto(id: &str) -> Contexto {
    let terminal = estados()
        .lock()
        .map(|g| g.terminales.contains(id))
        .unwrap_or(false);
    match estado(id) {
        Some(e) => Contexto {
            status: e.status,
            screen: e.pantalla,
            protocolo: e.protocolo,
            terminal,
            limite: e.pausa_limite.is_some(),
        },
        None => Contexto {
            status: SessionStatus::Starting,
            screen: ScreenState::Unknown,
            protocolo: 0,
            terminal,
            limite: false,
        },
    }
}

/// Terminal en superposición adjunta o soltada: pausa el drenaje y se
/// proyecta en `SessionInfo.terminalAttached` (#31). Enganchar la terminal de
/// una sesión que ya salió del registro no anota nada (orden fijo: estados →
/// registro, como en `manejar_senal`).
pub fn terminal_adjunta(id: &str, adjunta: bool) {
    if let Ok(mut g) = estados().lock() {
        if adjunta {
            if !super::exists(id) {
                tracing::debug!(sesion = id, "terminal enganchada de una sesión cerrada");
                return;
            }
            g.terminales.insert(id.to_string());
        } else {
            g.terminales.remove(id);
        }
    }
    proyectar_terminal(id, adjunta);
    if !adjunta && soltar_reanuda_cola(estado(id).as_ref()) {
        drenaje_automatico(id);
    }
}

/// Soltar la terminal (también la recarga de la página tras una caída del
/// renderer) solo reanuda el drenaje si la cola no está en pausa: ni por un
/// cierre por plazo ni por un turno interrumpido, cuya cola espera a «Enviar
/// ahora».
fn soltar_reanuda_cola(e: Option<&EstadoSesion>) -> bool {
    !e.is_some_and(|e| e.pausa_drenaje || e.pausa_plazo.is_some())
}

/// Sesiones con la terminal del bloque de menú enganchada (copia).
pub fn terminales_adjuntas() -> Vec<String> {
    estados()
        .lock()
        .map(|g| g.terminales.iter().cloned().collect())
        .unwrap_or_default()
}

fn quitar_terminal(id: &str) {
    if let Ok(mut g) = estados().lock() {
        g.terminales.remove(id);
    }
    proyectar_terminal(id, false);
}

/// Fija `terminal_attached`; true si cambió (y hay que emitir).
fn fijar_terminal(info: &mut crate::sesiones::types::SessionInfo, adjunta: bool) -> bool {
    let cambia = info.terminal_attached != adjunta;
    info.terminal_attached = adjunta;
    cambia
}

/// Proyección en el registro, ya sin el lock de estados (orden fijo:
/// estados → registro). `update` emite `sesiones://sessions` solo si
/// cambió. Una sesión que ya no existe no tiene nada que proyectar.
fn proyectar_terminal(id: &str, adjunta: bool) {
    if let Err(e) = update(id, |se| (fijar_terminal(&mut se.info, adjunta), ())) {
        tracing::debug!(sesion = id, error = %e, "terminal sin sesión que proyectar");
    }
}

/// Cierre de una sesión (lo usa `gestor::kill`): primero sale del registro y
/// después se olvida su estado. Con ese orden, una señal cuyo `update`
/// funcionó lo hizo antes del `remove` (los dos bajo el lock de estados) y su
/// rastro lo borra `olvidar_sesion`; una señal posterior ve fallar `update` y
/// purga lo que hubiera dejado.
pub fn cerrar_estado(id: &str) {
    cerrar_estado_con(id, || {});
}

/// `cerrar_estado` con un punto de inyección entre los dos pasos (tests).
fn cerrar_estado_con(id: &str, entre: impl FnOnce()) {
    super::remove(id);
    entre();
    olvidar_sesion(id);
}

/// Quita la sesión de todos los mapas de estados.
fn purgar(g: &mut Estados, id: &str) {
    g.maquinas.remove(id);
    g.ultima_emision.remove(id);
    g.latencias.remove(id);
    g.terminales.remove(id);
    g.ultimo_tick.remove(id);
}

/// Limpia todo lo de una sesión cerrada (la llama `cerrar_estado`).
pub fn olvidar_sesion(id: &str) {
    if let Ok(mut g) = estados().lock() {
        purgar(&mut g, id);
    }
    caja::pausas().levantar(id);
    recuperacion::olvidar(id);
    if let Some(s) = sink() {
        Broker::global().cancel_for(&*s, id, AskCancelReason::SessionExited);
    }
    cola::global().olvidar(id);
    buzon::olvidar(id);
    catalogo::olvidar_viva(id);
    puente_eventos::olvidar(id);
    puente::revocar_token(id);
}

// ---------------------------------------------------------------------------
// Efectos
// ---------------------------------------------------------------------------

fn motivo(m: &str) -> AskCancelReason {
    match m {
        "interrupted" => AskCancelReason::Interrupted,
        "turnEnded" => AskCancelReason::TurnEnded,
        "sessionExited" => AskCancelReason::SessionExited,
        "modAborted" => AskCancelReason::ModAborted,
        "restart" => AskCancelReason::Restart,
        _ => AskCancelReason::Unknown,
    }
}

fn ejecutar(id: &str, efectos: Vec<Efecto>, n: &EstadoSesion) {
    for ef in efectos {
        match ef {
            Efecto::EmitirSesiones => {}
            Efecto::Drenar => drenaje_automatico(id),
            Efecto::CancelarAsks { motivo: m } => {
                if let Some(s) = sink() {
                    Broker::global().cancel_for(&*s, id, motivo(m));
                }
            }
            Efecto::EmitirTurno(t) => emitir_turno(id, &t),
            Efecto::EmitirReset { claude_session_id } => emit(
                ev::RESET,
                json!({ "id": id, "claudeSessionId": claude_session_id }),
            ),
            Efecto::Aviso { nivel, texto } => aviso(id, nivel, &texto),
            Efecto::Log(texto) => tracing::info!(sesion = id, status = ?n.status, "{texto}"),
            Efecto::FallarEnvios { motivo: m } => {
                cola::global().fallar_envios(id, m);
                cola::emitir_actual(id);
                buzon::olvidar(id);
            }
            Efecto::FallarColaCli { motivo: m } => {
                cola::global().fallar_cola_cli(id, m);
                cola::emitir_actual(id);
            }
            Efecto::ResolverHuerfanos => {
                cola::global().resolver_huerfanos(id, "La CLI no confirmó el envío", ahora_ms());
                cola::emitir_actual(id);
            }
        }
    }
}

fn aviso(id: &str, nivel: Nivel, texto: &str) {
    let level = match nivel {
        Nivel::Info => "info",
        Nivel::Warn => "warn",
        Nivel::Error => "error",
    };
    emit(
        ev::NOTICE,
        json!({ "id": id, "level": level, "text": texto }),
    );
}

fn emitir_turno(id: &str, t: &TurnoCerrado) {
    registrar_latencia(id);
    let turn_id = t.turn_id.clone().unwrap_or_default();
    let acum = puente_eventos::acumulado_turno(id, &turn_id).unwrap_or_default();
    let p = TurnPayload {
        id: id.to_string(),
        turn_id,
        started_at: maquina::iso(t.desde),
        ended_at: maquina::iso(t.hasta),
        duration_ms: t.hasta.saturating_sub(t.desde),
        reason: t.motivo.clone(),
        usage: t.usage.clone().or(acum.usage),
        subagent_usage: acum.subagentes,
    };
    emit(ev::TURN, serde_json::to_value(p).unwrap_or_default());
}

#[cfg(test)]
mod tests_reintento {
    use super::*;
    use std::time::Instant;

    #[test]
    fn reintenta_solo_en_reposo_con_prompt_y_cola() {
        let mut n = EstadoSesion::nuevo(0);
        n.status = SessionStatus::Idle;
        n.pantalla = ScreenState::Prompt;
        let con_cola = ColaDrenable::con_cola();
        assert!(debe_reintentar_drenaje(&n, con_cola));
        assert!(
            !debe_reintentar_drenaje(&n, ColaDrenable::default()),
            "sin cola no hay nada que drenar"
        );
        n.pantalla = ScreenState::Busy;
        assert!(
            !debe_reintentar_drenaje(&n, con_cola),
            "con la TUI ocupada no se escribe"
        );
        n.pantalla = ScreenState::Prompt;
        n.status = SessionStatus::Working;
        assert!(
            !debe_reintentar_drenaje(&n, con_cola),
            "trabajando no se drena"
        );
    }

    /// L1: con la sesión libre y cola, pero sin poder escribir (terminal
    /// enganchada o un `sending` sin evidencia), el tick no pide drenaje: antes
    /// lanzaba un hilo por tick que salía con `Ok(None)`.
    #[test]
    fn sin_poder_escribir_el_tick_no_pide_drenaje() {
        let mut n = EstadoSesion::nuevo(0);
        n.status = SessionStatus::Idle;
        n.pantalla = ScreenState::Prompt;
        let terminal = ColaDrenable {
            terminal: true,
            ..ColaDrenable::con_cola()
        };
        assert!(
            !debe_reintentar_drenaje(&n, terminal),
            "terminal enganchada"
        );
        let sending = ColaDrenable {
            sin_evidencia: true,
            ..ColaDrenable::con_cola()
        };
        assert!(!debe_reintentar_drenaje(&n, sending), "envío sin evidencia");
        assert!(
            debe_reintentar_drenaje(&n, ColaDrenable::con_cola()),
            "caso negativo: libre, sí"
        );
    }

    /// L1: la terminal enganchada se lee del registro real de la sesión.
    #[test]
    fn cola_drenable_ve_la_terminal_enganchada() {
        let id = format!("drenable-terminal-{}", uuid::Uuid::new_v4());
        crate::sesiones::registro::insert(crate::sesiones::registro::sesion_de_prueba(&id))
            .expect("alta");
        assert!(!cola_drenable(&id).terminal);
        terminal_adjunta(&id, true);
        assert!(cola_drenable(&id).terminal);
        cerrar_estado(&id);
        assert!(!cola_drenable(&id).terminal);
    }

    /// L2: cerrar la sesión levanta la pausa de la caja ocupada.
    #[test]
    fn olvidar_sesion_levanta_la_pausa_de_la_caja() {
        let id = format!("olvidar-pausa-{}", uuid::Uuid::new_v4());
        let ahora = Instant::now();
        caja::pausas().pausar(&id, Some("texto".into()), ahora);
        let igual = || Some("texto".to_string());
        assert!(caja::pausas().en_pausa(&id, igual, ahora), "pausada");
        olvidar_sesion(&id);
        assert!(
            !caja::pausas().en_pausa(&id, igual, ahora),
            "cerrar la sesión levanta la pausa"
        );
    }

    /// Cerrar la sesión vacía sus entradas en los mapas de la recuperación.
    #[test]
    fn olvidar_sesion_quita_las_marcas_de_la_recuperacion() {
        use crate::sesiones::types::RecoverAction;
        let id = format!("olvidar-recuperacion-{}", uuid::Uuid::new_v4());
        let t0 = Instant::now();
        let clave = recuperacion::clave_reserva(&id, RecoverAction::Interrupt);
        recuperacion::anotar_tarea(&id);
        recuperacion::anotar_turno(&id);
        recuperacion::liberar(&clave, t0);
        olvidar_sesion(&id);
        assert!(!recuperacion::tarea_desde(&id, t0));
        assert!(!recuperacion::turno_desde(&id, t0));
        let reserva = recuperacion::reservar(&clave, t0);
        assert_eq!(reserva, recuperacion::Reserva::Libre, "sin antirrebote");
        recuperacion::olvidar(&id);
    }

    /// El reinicio conserva el id: la terminal enganchada al PTY viejo no
    /// puede dejar la cola en pausa con el PTY nuevo.
    #[test]
    fn el_reinicio_quita_la_pausa_de_la_terminal() {
        let id = format!("reinicio-terminal-{}", uuid::Uuid::new_v4());
        crate::sesiones::registro::insert(crate::sesiones::registro::sesion_de_prueba(&id))
            .expect("alta");
        terminal_adjunta(&id, true);
        assert!(contexto(&id).terminal);
        assert!(terminales_adjuntas().contains(&id));
        manejar_senal(&id, Senal::ReinicioPedido);
        assert!(!contexto(&id).terminal);
        assert!(!terminales_adjuntas().contains(&id));
        cerrar_estado(&id);
    }

    /// #31: `SessionInfo.terminalAttached` refleja la terminal del bloque de
    /// menú (enganchar, soltar y reinicio) para el aviso «Cola en pausa».
    #[test]
    fn la_terminal_enganchada_se_proyecta_en_la_sesion() {
        use crate::sesiones::registro;
        let id = format!("terminal-proyectada-{}", uuid::Uuid::new_v4());
        registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
        let enganchada = || registro::read(&id, |s| s.info.terminal_attached).expect("sesión");
        assert!(!enganchada(), "nace sin terminal");
        terminal_adjunta(&id, true);
        assert!(enganchada(), "enganchar se proyecta");
        terminal_adjunta(&id, false);
        assert!(!enganchada(), "soltar se proyecta");
        terminal_adjunta(&id, true);
        manejar_senal(&id, Senal::ReinicioPedido);
        assert!(!enganchada(), "el reinicio la suelta también en la sesión");
        olvidar_sesion(&id);
        registro::remove(&id);
    }

    /// El límite por el manejador real: el contexto de la cola deja de estar
    /// libre, la pausa llega a `SessionInfo` y el aviso no se repite. El estado
    /// de la máquina es el mismo que recibe `relevo::observe` en producción.
    #[test]
    fn el_limite_llega_al_contexto_de_la_cola_y_a_la_sesion() {
        use crate::sesiones::registro;
        use crate::sesiones::types::QueuePauseReason;
        let id = format!("limite-cableado-{}", uuid::Uuid::new_v4());
        registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
        assert!(!contexto(&id).limite);
        manejar_senal(&id, Senal::LimiteUso);
        assert!(contexto(&id).limite);
        let pausa = registro::read(&id, |s| s.info.queue_pause.clone()).expect("sesión");
        assert_eq!(pausa.map(|p| p.reason), Some(QueuePauseReason::UsageLimit));
        assert!(
            !soltar_reanuda_cola(estado(&id).as_ref()),
            "soltar la terminal"
        );
        manejar_senal(&id, Senal::LimiteFin);
        assert!(!contexto(&id).limite);
        let pausa = registro::read(&id, |s| s.info.queue_pause.clone()).expect("sesión");
        assert_eq!(pausa, None);
        cerrar_estado(&id);
    }

    /// Solo un cambio real emite `sesiones://sessions` (caso negativo: el
    /// mismo valor no reemite).
    #[test]
    fn fijar_terminal_solo_avisa_si_cambia() {
        let mut info = crate::sesiones::registro::sesion_de_prueba("x").info;
        assert!(!fijar_terminal(&mut info, false), "mismo valor");
        assert!(fijar_terminal(&mut info, true), "cambio");
        assert!(info.terminal_attached);
        assert!(!fijar_terminal(&mut info, true), "mismo valor");
        let json = serde_json::to_value(&info).expect("json");
        assert_eq!(json["terminalAttached"], serde_json::json!(true));
        assert!(fijar_terminal(&mut info, false), "cambio");
        let json = serde_json::to_value(&info).expect("json");
        assert!(json.get("terminalAttached").is_none(), "false no viaja");
    }
}

#[cfg(test)]
mod tests_emision_opciones {
    use super::*;
    use crate::sesiones::maquina::ResumenTickets;
    use crate::sesiones::senales::EstadoPantalla;
    use crate::sesiones::{pantalla, registro};
    use std::sync::Arc;

    fn pantalla_senal(estado: EstadoPantalla) -> Senal {
        Senal::Pantalla {
            estado,
            modo: None,
            entrada: None,
            pista: false,
        }
    }

    /// Menú abierto (`waiting`, `kind = menu`) construido con la tabla pura
    /// en el pasado reciente, para que `manejar_senal` lo herede sin esperas.
    fn menu_abierto(ahora: Ms) -> EstadoSesion {
        let t = ResumenTickets::default();
        let mut e = EstadoSesion::nuevo(ahora - 10_000);
        e.protocolo = 2;
        let pasos = [
            (pantalla_senal(EstadoPantalla::Prompt), ahora - 10_000),
            (Senal::Tick, ahora - 9_700),
            (pantalla_senal(EstadoPantalla::Dialog), ahora - 9_000),
            (Senal::Tick, ahora - 8_000),
        ];
        for (s, t_ms) in pasos {
            e = maquina::transicion(&e, &s, t_ms, &t).0;
        }
        assert_eq!(e.status, SessionStatus::Waiting, "menú abierto");
        e
    }

    fn ultima_emision(id: &str) -> Option<Ms> {
        estados().lock().ok()?.ultima_emision.get(id).copied()
    }

    fn preparar(id: &str, ahora: Ms, previa: Ms) {
        let mut g = estados().lock().expect("estados");
        g.maquinas.insert(id.to_string(), menu_abierto(ahora));
        g.ultima_emision.insert(id.to_string(), previa);
    }

    /// #50: los botones del menú resuelven el índice contra la pantalla del
    /// clic; si un cambio de opciones sin cambio de estado (submenú, cursor
    /// movido desde el xterm) no emite, la ventana pulsa la opción equivocada.
    #[test]
    fn un_cambio_de_opciones_sin_cambio_de_estado_emite() {
        let bytes: &[u8] = include_bytes!("fixtures/tui/modelo.ans");
        let id = format!("emision-opciones-{}", uuid::Uuid::new_v4());
        registro::insert(registro::sesion_de_prueba(&id)).expect("alta");
        let ahora = ahora_ms();
        let previa = ahora - 1_000;
        preparar(&id, ahora, previa);
        manejar_senal(&id, pantalla_senal(EstadoPantalla::Dialog));
        assert_eq!(
            ultima_emision(&id),
            Some(previa),
            "sin opciones nuevas no se emite"
        );

        let m = Arc::new(pantalla::Monitor::nuevo(48, 160));
        m.alimentar(&bytes[..12_971]); // «model-abierto» de fixtures/tui/modelo.json
        pantalla::registrar(&id, m);
        manejar_senal(&id, pantalla_senal(EstadoPantalla::Dialog));
        let tras_cambio = ultima_emision(&id).expect("emisión");
        assert!(
            tras_cambio > previa,
            "las opciones cambiaron sin cambiar el estado"
        );
        let opciones = registro::read(&id, |s| s.info.waiting.clone())
            .expect("sesión")
            .and_then(|w| w.options);
        assert!(
            opciones.is_some_and(|o| !o.is_empty()),
            "la proyección lleva las opciones"
        );

        // Otra marca de reloj, para que una reemisión no pase desapercibida.
        std::thread::sleep(std::time::Duration::from_millis(5));
        manejar_senal(&id, pantalla_senal(EstadoPantalla::Dialog));
        assert_eq!(
            ultima_emision(&id),
            Some(tras_cambio),
            "mismas opciones: no se reemite"
        );
        pantalla::olvidar(&id);
        olvidar_sesion(&id);
        registro::remove(&id);
    }
}

#[cfg(test)]
#[path = "tests_registro_salto.rs"]
mod tests_salto_reloj;

/// Cierre de sesión sin huérfanos y terminal soltada.
#[cfg(test)]
#[path = "tests_registro_cierre.rs"]
mod tests_cierre;
