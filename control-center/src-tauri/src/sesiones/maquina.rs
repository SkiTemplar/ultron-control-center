// sesiones/maquina.rs — Máquina de estados pura de una sesión (contrato de
// estabilidad, §1.2-§1.5).
//
// `transicion` es pura: recibe el estado, la señal, el reloj inyectado
// (`ahora`, milisegundos desde la época UNIX) y el resumen de la cola, y
// devuelve el estado nuevo y los efectos. El cableado (`registro`) aplica el
// estado bajo el lock y ejecuta los efectos después de soltarlo. Las reglas
// que dependen del tiempo (pantalla estable, colgado, plazos) viven en
// `maquina_tiempo.rs`; las transiciones por señal, en `maquina_senales.rs`;
// los tests de tabla, en `tests_maquina.rs`.
//
// Propiedad: WP-ESTADO.

use std::collections::{HashMap, VecDeque};

use super::pantalla;
use super::senales::{EstadoPantalla, Senal};
use super::types::{
    CommandKind, DialogOption, PermissionMode, QueuePause, QueuePauseReason, SessionInfo,
    SessionStatus, StallInfo, Usage, WaitInfo, WaitKind,
};

#[path = "maquina_senales.rs"]
mod senal;
#[path = "maquina_tiempo.rs"]
mod tiempo;
use senal::*;
pub use tiempo::{rebasar_reloj, salto_de_reloj};

/// Milisegundos de un reloj inyectado (época UNIX en producción).
pub type Ms = u64;

/// Turnos cerrados que se recuerdan para descartar `turnEnd` atrasados.
const MAX_CERRADOS: usize = 32;
/// Umbral por defecto de `stalled.noEvents` (§1.5).
pub const UMBRAL_STALL_DEF: Ms = 120_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origen {
    Prompt,
    Comando {
        run_id: Option<String>,
        nombre: String,
        kind: CommandKind,
    },
    Bash,
    Externo,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnoAbierto {
    pub turn_id: Option<String>,
    pub origen: Origen,
    pub desde: Ms,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HerramientaAbierta {
    pub nombre: String,
    pub desde: Ms,
    pub timeout_ms: Option<u64>,
}

/// Turno principal cerrado (base de `sesiones://turn`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TurnoCerrado {
    pub turn_id: Option<String>,
    pub desde: Ms,
    pub hasta: Ms,
    pub motivo: String,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Nivel {
    Info,
    Warn,
    Error,
}

/// Lo que `cola.rs` sabe de los envíos: escritos sin evidencia de entrega y
/// elementos en la cola nativa de la CLI y en la propia.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResumenTickets {
    pub sin_evidencia: usize,
    pub en_cola_cli: usize,
    /// Elementos `queued` de la cola de ULTRON (aún sin escribir en el PTY).
    pub en_cola_ultron: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Efecto {
    EmitirSesiones,
    Drenar,
    CancelarAsks {
        motivo: &'static str,
    },
    EmitirTurno(TurnoCerrado),
    EmitirReset {
        claude_session_id: String,
    },
    Aviso {
        nivel: Nivel,
        texto: String,
    },
    Log(String),
    /// La sesión terminó: los envíos `sending` pasan a `failed` (§1.4).
    FallarEnvios {
        motivo: &'static str,
    },
    /// Reinicio: los `cliQueued` (cola nativa del proceso que se mata) pasan
    /// a `failed`.
    FallarColaCli {
        motivo: &'static str,
    },
    /// La TUI lleva 10 s quieta en el prompt sin turno: lo que quede en
    /// `cliQueued` ya lo consumió la CLI y lo que quede en `sending` no llegó.
    ResolverHuerfanos,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EstadoSesion {
    pub status: SessionStatus,
    pub waiting: Option<WaitInfo>,
    pub stalled: Option<StallInfo>,
    pub turno: Option<TurnoAbierto>,
    /// Últimos 32 `turn_id` cerrados (anti `turnEnd` atrasado).
    pub cerrados: VecDeque<String>,
    /// `toolUseId` → herramienta abierta del hilo principal.
    pub herramientas: HashMap<String, HerramientaAbierta>,
    pub pantalla: EstadoPantalla,
    pub pantalla_desde: Ms,
    /// La última pantalla pintaba la pista de Ctrl+B (§3.4).
    pub pista_segundo_plano: bool,
    pub ultimo_progreso: Ms,
    pub ultima_actividad: Ms,
    pub working_since: Option<Ms>,
    /// Fuente de fin de turno: 2|1 => puente, 0 => transcript.
    pub protocolo: u8,
    /// Generación del último hello (§6.1).
    pub generacion: u32,
    pub claude_session_id: Option<String>,
    /// Restart en curso desde este instante: la primera `ProcesoSalio` (la del
    /// proceso anterior) no vacía la cola ni pasa a exited.
    pub reiniciando: Option<Ms>,
    /// Desde `InterrupcionPedida` hasta `TurnoFin` o 2 s.
    pub interrumpiendo: Option<Ms>,
    /// Modo de permisos (camelCase) y cuándo cambió: gana el más reciente.
    pub modo: Option<(String, Ms)>,
    // -- campos internos de WP-ESTADO --
    /// Asks abiertos en orden de llegada.
    pub asks: Vec<(String, WaitKind)>,
    pub exit_code: Option<i32>,
    /// Umbral de `noEvents` (prefs `stallSeconds`).
    pub umbral_stall_ms: Ms,
    /// Último envío escrito sin evidencia de que la CLI lo recibió.
    pub envio_desde: Option<Ms>,
    pub puente_listo_desde: Option<Ms>,
    /// `ComandoFin` de un comando `prompt` sin turno todavía (`noTurnStart`).
    pub plazo_comando: Option<Ms>,
    pub tx_end_turn: Option<Ms>,
    /// `turn_duration` o interrupción del transcript con puente y sin `TurnoFin`.
    pub tx_fin_red: Option<Ms>,
    /// Último modo leído de la pantalla y candidato pendiente de 500 ms.
    pub modo_en_pantalla: Option<String>,
    pub modo_candidato: Option<(String, Ms)>,
    /// Desde cuándo hay envíos `sending` sin evidencia con la sesión en idle.
    pub huerfanos_desde: Option<Ms>,
    /// Idle sin drenaje (tras una recuperación): ni el reintento por pantalla
    /// ni los plazos vuelven a drenar hasta el siguiente `a_idle` que drene.
    pub pausa_drenaje: bool,
    /// Turno cerrado por plazo con puente (`lost` o red de seguridad): la
    /// cola queda en pausa hasta un `turnEnd` o `hello` real del puente o
    /// `PROMPT_REANUDA` de prompt estable en idle (hallazgo nocturno 2).
    pub pausa_plazo: Option<Ms>,
    /// El usuario interrumpió (o el turno se cortó): la cola no drena hasta
    /// «Enviar ahora» o un prompt suyo. A diferencia de `pausa_drenaje`,
    /// sobrevive a los `a_idle(.., true)` posteriores y a que caduque
    /// `interrumpiendo` (H1, CONTRATO-v3 §3.3).
    pub pausa_interrupcion: Option<Ms>,
    /// `RecuperacionTerminada` llegó antes que la pantalla en prompt (la
    /// máquina la recibe con 150-250 ms de retraso): se aplica al llegar esta.
    pub recuperado_sin_prompt: bool,
    /// Límite de uso de Claude desde este instante hasta la vuelta: mandar
    /// nada más solo consumiría mensajes contra el aviso de cuota.
    pub pausa_limite: Option<Ms>,
    /// `turnEnd` del puente que dejó la sesión en working con envíos
    /// pendientes: el fin de ese mismo turno en el transcript llega detrás.
    pub cierre_puente: Option<Ms>,
    /// Llegó un `prompt` del puente después de `cierre_puente`: el turno
    /// siguiente está empezando y el eco del cierre no puede pasar a idle
    /// aunque ya no queden envíos pendientes (#41.3).
    pub prompt_tras_cierre: bool,
    /// Entrada en `starting` (alta o reinicio): base del plazo de arranque.
    pub arranque_desde: Ms,
    /// Último `turnEnd` real del puente, también el atrasado o ajeno que se
    /// ignora: prueba de que el puente vive y la red de seguridad no pausa.
    pub ultimo_turn_end_puente: Option<Ms>,
}

impl EstadoSesion {
    /// Estado inicial de una sesión recién lanzada.
    pub fn nuevo(ahora: Ms) -> Self {
        Self {
            status: SessionStatus::Starting,
            waiting: None,
            stalled: None,
            turno: None,
            cerrados: VecDeque::new(),
            herramientas: HashMap::new(),
            pantalla: EstadoPantalla::Unknown,
            pantalla_desde: ahora,
            pista_segundo_plano: false,
            ultimo_progreso: ahora,
            ultima_actividad: ahora,
            working_since: None,
            protocolo: 0,
            generacion: 0,
            claude_session_id: None,
            reiniciando: None,
            interrumpiendo: None,
            modo: None,
            asks: Vec::new(),
            exit_code: None,
            umbral_stall_ms: UMBRAL_STALL_DEF,
            envio_desde: None,
            puente_listo_desde: None,
            plazo_comando: None,
            tx_end_turn: None,
            tx_fin_red: None,
            modo_en_pantalla: None,
            modo_candidato: None,
            huerfanos_desde: None,
            pausa_drenaje: false,
            pausa_plazo: None,
            pausa_interrupcion: None,
            recuperado_sin_prompt: false,
            pausa_limite: None,
            cierre_puente: None,
            prompt_tras_cierre: false,
            arranque_desde: ahora,
            ultimo_turn_end_puente: None,
        }
    }

    pub fn con_puente(&self) -> bool {
        self.protocolo >= 1
    }

    fn turn_id(&self) -> Option<&str> {
        self.turno.as_ref().and_then(|t| t.turn_id.as_deref())
    }

    fn esperando_ask(&self) -> bool {
        self.status == SessionStatus::Waiting
            && self.waiting.as_ref().is_some_and(|w| es_ask(w.kind))
    }

    fn esperando(&self, kind: WaitKind) -> bool {
        self.status == SessionStatus::Waiting
            && self.waiting.as_ref().is_some_and(|w| w.kind == kind)
    }
}

fn es_ask(k: WaitKind) -> bool {
    matches!(
        k,
        WaitKind::Question | WaitKind::Permission | WaitKind::Plan
    )
}

/// Transición pura (§1.4). Añade `EmitirSesiones` al principio si cambió algo
/// visible en `SessionInfo`.
pub fn transicion(
    e: &EstadoSesion,
    s: &Senal,
    ahora: Ms,
    tickets: &ResumenTickets,
) -> (EstadoSesion, Vec<Efecto>) {
    let mut n = e.clone();
    let mut ef = Vec::new();
    if n.status == SessionStatus::Exited {
        match s {
            Senal::ReinicioPedido => reinicio(&mut n, ahora, &mut ef),
            // La vuelta del relevo también vale para una sesión terminada:
            // si no, Reiniciar la dejaría con la cola retenida.
            Senal::LimiteFin => n.pausa_limite = None,
            _ => {}
        }
    } else {
        aplicar(&mut n, s, ahora, tickets, &mut ef);
    }
    if n.status == SessionStatus::Starting && e.status != SessionStatus::Starting {
        n.arranque_desde = ahora;
    }
    tiempo::huerfanos_en_reposo(&mut n, ahora, tickets, &mut ef);
    tiempo::evaluar_stall(&mut n, ahora);
    if visible(e) != visible(&n) {
        ef.insert(0, Efecto::EmitirSesiones);
    }
    (n, ef)
}

type Visible<'a> = (
    SessionStatus,
    &'a Option<WaitInfo>,
    &'a Option<StallInfo>,
    Option<&'a str>,
    EstadoPantalla,
    Option<&'a str>,
    Option<i32>,
    u8,
    Option<Ms>,
    Option<QueuePause>,
    // `toolUseId` y `backgroundable` de `foregroundTool` (§3.4).
    Option<(String, bool)>,
);

fn visible(e: &EstadoSesion) -> Visible<'_> {
    (
        e.status,
        &e.waiting,
        &e.stalled,
        e.turn_id(),
        e.pantalla,
        e.modo.as_ref().map(|m| m.0.as_str()),
        e.exit_code,
        e.protocolo,
        e.working_since,
        pausa_visible(e),
        super::segundo_plano::primer_plano(e).map(|f| (f.tool_use_id, f.backgroundable)),
    )
}

fn aplicar(n: &mut EstadoSesion, s: &Senal, ahora: Ms, t: &ResumenTickets, ef: &mut Vec<Efecto>) {
    if es_actividad(s) {
        n.ultima_actividad = ahora;
    }
    match s {
        Senal::EnvioEscrito { kind, .. } => envio_escrito(n, kind, ahora, ef),
        Senal::Pantalla {
            estado,
            modo,
            pista,
            ..
        } => {
            n.pista_segundo_plano = *pista;
            pantalla(n, *estado, modo.as_deref(), ahora, t, ef)
        }
        Senal::Progreso => n.ultimo_progreso = ahora,
        Senal::ProcesoSalio { code } => proceso_salio(n, *code, ef),
        Senal::ReinicioPedido => reinicio(n, ahora, ef),
        Senal::PuenteHello {
            protocolo,
            claude_session_id,
            generacion,
            ..
        } => hello(n, *protocolo, claude_session_id.as_deref(), *generacion, ef),
        Senal::PuenteListo => puente_listo(n, ahora, t, ef),
        Senal::PromptEntrado { .. } => prompt_entrado(n, ahora),
        Senal::TurnoInicio { turn_id } => turno_inicio(n, turn_id, ahora),
        Senal::TurnoFin {
            turn_id,
            motivo,
            abortado,
        } => turno_fin(n, turn_id, motivo, *abortado, ahora, t, ef),
        Senal::ComandoInicio { run_id, nombre } => comando_inicio(n, run_id, nombre, ahora),
        Senal::ComandoFin {
            run_id,
            nombre,
            interceptado,
        } => comando_fin(n, run_id, nombre, *interceptado, ahora, t, ef),
        Senal::AskAbierta { ask_id, kind } => ask_abierta(n, ask_id, kind, ahora),
        Senal::AskCerrada { ask_id } => ask_cerrada(n, ask_id, ahora, t, ef),
        Senal::ModoPermisos { modo } => modo_permisos(n, modo, ahora),
        _ => aplicar_tx(n, s, ahora, t, ef),
    }
}

/// Herramientas, actividad, transcript, reloj y recuperación.
fn aplicar_tx(
    n: &mut EstadoSesion,
    s: &Senal,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    match s {
        Senal::HerramientaInicio {
            tool_use_id,
            nombre,
            timeout_ms,
        } => {
            let h = HerramientaAbierta {
                nombre: nombre.clone(),
                desde: ahora,
                timeout_ms: *timeout_ms,
            };
            n.herramientas.insert(tool_use_id.clone(), h);
        }
        Senal::HerramientaFin { tool_use_id } => {
            n.herramientas.remove(tool_use_id);
        }
        Senal::Actividad { agent_id: None } => n.envio_desde = None,
        Senal::TxTurnDuration => fin_por_transcript(n, false, ahora, t, ef),
        Senal::TxInterrumpido => fin_por_transcript(n, true, ahora, t, ef),
        Senal::TxSalidaLocal | Senal::TxSalidaBash => salida_local(n, t, ef),
        Senal::TxEndTurn => {
            if n.status == SessionStatus::Working && !n.con_puente() {
                n.tx_end_turn = Some(ahora);
            }
        }
        Senal::TxPromptUsuario { .. } => {
            if n.status == SessionStatus::Idle && !n.con_puente() {
                a_working(n, Origen::Externo, None, ahora);
            }
        }
        Senal::Tick => tiempo::evaluar_tick(n, ahora, t, ef),
        Senal::InterrupcionPedida => {
            n.interrumpiendo = Some(ahora);
            // La pausa empieza al pedir la interrupción, no al cerrar el turno:
            // la cola nativa que la CLI devuelve a la caja (popAll) vuelve a la
            // de ULTRON a mitad de la recuperación y un drenaje intermedio la
            // reenviaba en el acto (sesión ef9979bb, 2026-10-21: Claude siguió
            // con el mensaje en cola tras «Interrumpir»).
            retener_por_interrupcion(n, ahora);
        }
        Senal::TurnoCortado => retener_por_interrupcion(n, ahora),
        Senal::RecuperacionTerminada { ok, motivo } => recuperacion(n, *ok, *motivo, ef),
        Senal::ReanudarCola => tiempo::enviar_ahora(n, ef),
        Senal::LimiteUso => tiempo::limite_uso(n, ahora, t, ef),
        Senal::LimiteFin => tiempo::limite_fin(n, ef),
        _ => {}
    }
}

/// Eventos del puente y líneas del transcript cuentan como actividad.
fn es_actividad(s: &Senal) -> bool {
    !matches!(
        s,
        Senal::EnvioEscrito { .. }
            | Senal::Pantalla { .. }
            | Senal::ProcesoSalio { .. }
            | Senal::ReinicioPedido
            | Senal::Tick
            | Senal::InterrupcionPedida
            | Senal::RecuperacionTerminada { .. }
            | Senal::ReanudarCola
            | Senal::TurnoCortado
            | Senal::LimiteUso
            | Senal::LimiteFin
    )
}

// ---------------------------------------------------------------------------
// Ayudas de transición
// ---------------------------------------------------------------------------

pub(super) fn a_working(n: &mut EstadoSesion, origen: Origen, turn_id: Option<String>, ahora: Ms) {
    n.status = SessionStatus::Working;
    n.waiting = None;
    // El turno empieza ahora: el silencio previo en idle no cuenta para
    // `noEvents`.
    n.ultima_actividad = ahora;
    if n.working_since.is_none() {
        n.working_since = Some(ahora);
    }
    n.turno = Some(TurnoAbierto {
        turn_id,
        origen,
        desde: ahora,
    });
}

/// Algo retiene la cola por encima de un fin de turno: el cierre por plazo
/// (solo reanuda la evidencia real), la interrupción y el límite de uso (solo
/// «Enviar ahora», un prompt del usuario o la vuelta de la cuota).
pub(super) fn cola_retenida(n: &EstadoSesion) -> bool {
    n.pausa_plazo.is_some() || n.pausa_interrupcion.is_some() || n.pausa_limite.is_some()
}

/// Marca la pausa de la interrupción; la primera marca fija su antigüedad.
pub(super) fn retener_por_interrupcion(n: &mut EstadoSesion, ahora: Ms) {
    n.pausa_interrupcion.get_or_insert(ahora);
    n.pausa_drenaje = true;
}

pub(super) fn a_idle(n: &mut EstadoSesion, ef: &mut Vec<Efecto>, drenar: bool) {
    let drenar = drenar && !cola_retenida(n);
    n.status = SessionStatus::Idle;
    n.waiting = None;
    n.stalled = None;
    n.turno = None;
    n.working_since = None;
    n.herramientas.clear();
    n.plazo_comando = None;
    n.tx_end_turn = None;
    n.tx_fin_red = None;
    n.envio_desde = None;
    n.reiniciando = None;
    n.cierre_puente = None;
    n.prompt_tras_cierre = false;
    n.recuperado_sin_prompt = false;
    n.pausa_drenaje = !drenar;
    if drenar {
        ef.push(Efecto::Drenar);
    }
}

pub(super) fn sin_pendientes(n: &EstadoSesion, t: &ResumenTickets) -> bool {
    t.sin_evidencia == 0 && t.en_cola_cli == 0 && n.asks.is_empty()
}

pub(super) fn cancelar_asks(n: &mut EstadoSesion, motivo: &'static str, ef: &mut Vec<Efecto>) {
    ef.push(Efecto::CancelarAsks { motivo });
    n.asks.clear();
    if n.esperando_ask() {
        n.status = SessionStatus::Working;
        n.waiting = None;
    }
}

pub(super) fn push_cerrado(n: &mut EstadoSesion, turn_id: &str) {
    if !n.cerrados.iter().any(|c| c == turn_id) {
        n.cerrados.push_back(turn_id.to_string());
    }
    while n.cerrados.len() > MAX_CERRADOS {
        n.cerrados.pop_front();
    }
}

/// Cierra el turno principal: `cerrados`, herramientas, asks, evento `turn` e
/// idle si no hay pendientes (si los hay, sigue working sin `turn_id`).
pub(super) fn cerrar_turno(
    n: &mut EstadoSesion,
    cerrado: Option<&str>,
    motivo: &str,
    cancel: &'static str,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    let turno = n.turno.take();
    let turn_id = cerrado
        .map(str::to_string)
        .or_else(|| turno.as_ref().and_then(|t| t.turn_id.clone()));
    if let Some(id) = &turn_id {
        push_cerrado(n, id);
    }
    n.herramientas.clear();
    cancelar_asks(n, cancel, ef);
    // Un turno abortado (Esc o «Interrumpir») deja la cola en pausa hasta
    // «Enviar ahora» (CONTRATO-v3, §3.3): drenar aquí mandaba el siguiente
    // mensaje en el acto, y el `RecuperacionTerminada` posterior ya no
    // encontraba turno que cerrar. El turno se emite como `aborted` también
    // cuando solo había `interrumpiendo`: la ventana ofrece «Enviar ahora»
    // por ese motivo, y sin él la cola quedaba en pausa sin el botón. La marca
    // de la pausa sobrevive al `interrumpiendo` de 2 s: un `turnEnd` sin marca
    // de aborto que llega después sigue siendo el del turno interrumpido.
    let interrumpido =
        motivo == "aborted" || n.interrumpiendo.is_some() || n.pausa_interrupcion.is_some();
    let motivo = if interrumpido { "aborted" } else { motivo };
    if interrumpido {
        retener_por_interrupcion(n, ahora);
    }
    let desde = turno.map(|t| t.desde).or(n.working_since).unwrap_or(ahora);
    ef.push(Efecto::EmitirTurno(TurnoCerrado {
        turn_id,
        desde,
        hasta: ahora,
        motivo: motivo.to_string(),
        usage: None,
    }));
    n.interrumpiendo = None;
    if sin_pendientes(n, t) {
        a_idle(n, ef, !interrumpido);
    } else {
        n.status = SessionStatus::Working;
        n.turno = Some(TurnoAbierto {
            turn_id: None,
            origen: Origen::Externo,
            desde: ahora,
        });
        n.tx_end_turn = None;
        n.tx_fin_red = None;
    }
}

/// `waiting` de un menú: la etiqueta es el `/comando` que lo abrió si la
/// máquina lo sabe (turno de comando); si no, la genérica.
pub(super) fn wait_menu(n: &EstadoSesion, ahora: Ms) -> WaitInfo {
    let base = wait_info(WaitKind::Menu, None, ahora);
    match n.turno.as_ref().map(|t| &t.origen) {
        Some(Origen::Comando { nombre, .. }) if !nombre.is_empty() => WaitInfo {
            label: format!("/{nombre}"),
            ..base
        },
        _ => base,
    }
}

pub(super) fn wait_info(kind: WaitKind, ask_id: Option<String>, ahora: Ms) -> WaitInfo {
    let label = match kind {
        WaitKind::Question => "Pregunta de Claude",
        WaitKind::Permission => "Permiso",
        WaitKind::Plan => "Plan",
        WaitKind::Menu => "Menú abierto en la TUI",
        WaitKind::Trust => "Confirma la carpeta",
    };
    WaitInfo {
        kind,
        ask_id,
        label: label.to_string(),
        since: iso(ahora),
        options: None,
    }
}

// ---------------------------------------------------------------------------
// Conversión y proyección
// ---------------------------------------------------------------------------

/// Modo de permisos en camelCase a partir del id o del indicador de pantalla.
pub fn normalizar_modo(texto: &str) -> Option<String> {
    let t = texto.trim();
    if permission_mode(t).is_some() {
        return Some(t.to_string());
    }
    let l = t.to_lowercase();
    let m = if l.contains("bypass") {
        "bypassPermissions"
    } else if l.contains("accept edits") {
        "acceptEdits"
    } else if l.contains("plan mode") {
        "plan"
    } else if l.contains("auto mode") {
        "auto"
    } else if l.contains("don't ask") || l.contains("dont ask") {
        "dontAsk"
    } else {
        return None;
    };
    Some(m.to_string())
}

pub fn permission_mode(id: &str) -> Option<PermissionMode> {
    serde_json::from_value(serde_json::Value::String(id.to_string())).ok()
}

/// ISO 8601 UTC con milisegundos de un instante en ms desde la época UNIX.
pub fn iso(ms: Ms) -> String {
    i64::try_from(ms)
        .ok()
        .and_then(chrono::DateTime::<chrono::Utc>::from_timestamp_millis)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

/// Opciones del menú abierto, leídas de la pantalla emulada de la sesión en
/// el momento de proyectar (la máquina no las guarda: cambian con el cursor).
/// Solo con `waiting.kind = menu`; sin opciones legibles, `None`.
fn con_opciones(id: &str, waiting: Option<&WaitInfo>) -> Option<WaitInfo> {
    let w = waiting?;
    if w.kind != WaitKind::Menu {
        return Some(w.clone());
    }
    let opciones: Vec<DialogOption> = pantalla::actual(id).opciones;
    Some(WaitInfo {
        options: (!opciones.is_empty()).then_some(opciones),
        ..w.clone()
    })
}

/// Copia el estado de la máquina en los campos de `SessionInfo` (§1.1).
/// Devuelve `true` si cambiaron las opciones del menú abierto, que no pasan
/// por la máquina: quien proyecta debe emitir `sesiones://sessions` entonces.
pub fn proyectar(e: &EstadoSesion, info: &mut SessionInfo) -> bool {
    let waiting = con_opciones(&info.id, e.waiting.as_ref());
    let opciones_cambiadas = opciones_de(waiting.as_ref()) != opciones_de(info.waiting.as_ref());
    info.status = e.status;
    info.waiting = waiting;
    info.stalled = e.stalled.clone();
    info.working_since = e.working_since.map(iso);
    info.last_activity_at = iso(e.ultima_actividad);
    info.turn_id = e.turn_id().map(str::to_string);
    info.screen = e.pantalla;
    info.permission_mode = e.modo.as_ref().and_then(|(m, _)| permission_mode(m));
    info.exit_code = e.exit_code;
    info.bridge_protocol = e.protocolo;
    info.queue_pause = pausa_visible(e);
    info.foreground_tool = super::segundo_plano::primer_plano(e);
    // Puente del proceso actual: el reinicio olvida el protocolo hasta el
    // `hello` del relanzado, y un proceso terminado no tiene puente.
    info.bridge_connected = e.protocolo >= 1 && e.status != SessionStatus::Exited;
    if let Some(sid) = &e.claude_session_id {
        info.claude_session_id = Some(sid.clone());
    }
    opciones_cambiadas
}

/// Pausa que la ventana enseña (con «Enviar ahora»). Si hay varias, la que
/// tarda más en resolverse sola: límite, interrupción, plazo.
fn pausa_visible(e: &EstadoSesion) -> Option<QueuePause> {
    let (reason, desde) = e
        .pausa_limite
        .map(|p| (QueuePauseReason::UsageLimit, p))
        .or_else(|| {
            e.pausa_interrupcion
                .map(|p| (QueuePauseReason::Interrupted, p))
        })
        .or_else(|| e.pausa_plazo.map(|p| (QueuePauseReason::Deadline, p)))?;
    Some(QueuePause {
        reason,
        since: iso(desde),
    })
}

fn opciones_de(w: Option<&WaitInfo>) -> Option<&[DialogOption]> {
    w.and_then(|w| w.options.as_deref())
}

#[cfg(test)]
#[path = "tests_maquina.rs"]
mod tests;

#[cfg(test)]
#[path = "tests_maquina_noche.rs"]
mod tests_noche;

#[cfg(test)]
#[path = "tests_maquina_recuperacion.rs"]
mod tests_recuperacion;

#[cfg(test)]
#[path = "tests_maquina_huerfanos.rs"]
mod tests_huerfanos;

#[cfg(test)]
#[path = "tests_maquina_pausas.rs"]
mod tests_pausas;

#[cfg(test)]
#[path = "tests_maquina_reinicio.rs"]
mod tests_reinicio;
