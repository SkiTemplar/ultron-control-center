// sesiones/maquina_tiempo.rs — Reglas de la máquina de estados que dependen
// del tiempo (contrato de estabilidad, §1.4 y §1.5): pantalla estable,
// reconciliación, plazos del transcript y del comando, interrupción con asks
// abiertos, detección de colgado, pausa de la cola tras un cierre por plazo
// y rebase de plazos tras un salto de reloj. Funciones puras con el reloj
// inyectado.
//
// Propiedad: WP-ESTADO.

use super::{
    a_idle, a_working, cancelar_asks, cerrar_turno, push_cerrado, sin_pendientes, wait_info,
    wait_menu, Efecto, EstadoSesion, HerramientaAbierta, Ms, Nivel, Origen, ResumenTickets,
    TurnoCerrado,
};
use crate::sesiones::senales::EstadoPantalla;
use crate::sesiones::types::{SessionStatus, StallInfo, StallReason, WaitKind};

const PROMPT_ESTABLE_ARRANQUE: Ms = 300;
const PUENTE_LISTO_ESPERA: Ms = 1_500;
const MENU_ESTABLE: Ms = 1_000;
const BUSY_EXTERNO: Ms = 2_000;
const SALIDA_MENU: Ms = 500;
const RECONCILIA_PROMPT: Ms = 3_000;
const RECONCILIA_SIN_EVIDENCIA: Ms = 10_000;
const TURNO_PERDIDO: Ms = 10_000;
const MODO_ESTABLE: Ms = 500;
const PLAZO_COMANDO: Ms = 15_000;
const TX_END_TURN_ESPERA: Ms = 1_500;
const TX_RED_PUENTE: Ms = 3_000;
/// La salida del proceso anterior llega durante el kill (espera ≤ 3 s); pasado
/// este plazo, el gestor ya la descarta por PTY y no llegará.
const PLAZO_REINICIO: Ms = 5_000;
/// `sending` sin evidencia en idle: plazo antes de darlo por no entregado.
const HUERFANO_EN_REPOSO: Ms = 15_000;
const INTERRUPCION_ASKS: Ms = 2_000;
const SIN_TURNO_STALL: Ms = 15_000;
const TOOL_MARGEN: Ms = 30_000;
const TOOL_SIN_TIMEOUT: Ms = 15 * 60_000;
/// Límite de Bash y PowerShell sin `timeout` en la entrada: el de la CLI por
/// defecto (2 min). Un `find` de 7 min (2026-10-15) no daba ningún aviso.
const TOOL_BASH_POR_DEFECTO: Ms = 120_000;
/// Herramientas de terminal con el límite por defecto de la CLI.
const HERRAMIENTAS_TERMINAL: &[&str] = &["Bash", "PowerShell"];
const TUI_CONGELADA: Ms = 30_000;
/// `starting` sin prompt reconocido ni puente listo: plazo antes de avisar.
const PLAZO_ARRANQUE: Ms = 30_000;
/// Herramientas de agente: solo pueden caer en `noEvents` (§1.5).
const HERRAMIENTAS_AGENTE: &[&str] = &["Agent", "Task", "Workflow"];

/// Reglas de pantalla estable según el estado (§1.4).
pub(super) fn evaluar_pantalla(
    n: &mut EstadoSesion,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    let estable = ahora.saturating_sub(n.pantalla_desde);
    match n.status {
        SessionStatus::Starting => arranque(n, estable, ahora, ef),
        SessionStatus::Waiting => esperando(n, estable, ahora, t, ef),
        SessionStatus::Idle => en_reposo(n, estable, ahora, ef),
        SessionStatus::Working => trabajando(n, estable, ahora, t, ef),
        SessionStatus::Exited => {}
    }
    modo_por_pantalla(n, ahora);
}

fn arranque(n: &mut EstadoSesion, estable: Ms, ahora: Ms, ef: &mut Vec<Efecto>) {
    match n.pantalla {
        EstadoPantalla::Trust => {
            n.status = SessionStatus::Waiting;
            n.waiting = Some(wait_info(WaitKind::Trust, None, ahora));
        }
        // Otro diálogo de arranque (`.mcp.json` nuevo, aviso de ajustes) no
        // es la confianza: va como menú, que el chat sabe responder.
        EstadoPantalla::Dialog => {
            n.status = SessionStatus::Waiting;
            n.waiting = Some(wait_menu(n, ahora));
        }
        EstadoPantalla::Prompt if estable >= PROMPT_ESTABLE_ARRANQUE => a_idle(n, ef, true),
        _ => {
            let listo = n
                .puente_listo_desde
                .is_some_and(|l| ahora.saturating_sub(l) >= PUENTE_LISTO_ESPERA);
            if listo {
                a_idle(n, ef, true);
            }
        }
    }
}

fn esperando(
    n: &mut EstadoSesion,
    estable: Ms,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    let Some(kind) = n.waiting.as_ref().map(|w| w.kind) else {
        return;
    };
    match (kind, n.pantalla) {
        (WaitKind::Trust, EstadoPantalla::Prompt) => a_idle(n, ef, true),
        // Aceptada la confianza, el siguiente diálogo de arranque es un menú;
        // y al revés, un menú de arranque puede dar paso a la confianza.
        (WaitKind::Trust, EstadoPantalla::Dialog) => n.waiting = Some(wait_menu(n, ahora)),
        (WaitKind::Menu, EstadoPantalla::Trust) if n.turno.is_none() => {
            n.waiting = Some(wait_info(WaitKind::Trust, None, ahora));
        }
        (WaitKind::Menu, EstadoPantalla::Prompt) if estable >= SALIDA_MENU => {
            let con_turno = n.turno.as_ref().is_some_and(|t| t.turn_id.is_some());
            if con_turno {
                n.status = SessionStatus::Working;
                n.waiting = None;
            } else if sin_pendientes(n, t) {
                a_idle(n, ef, true);
            } else {
                a_working(n, Origen::Externo, None, ahora);
            }
        }
        (WaitKind::Menu, EstadoPantalla::Busy) if estable >= SALIDA_MENU => {
            n.status = SessionStatus::Working;
            n.waiting = None;
            if n.turno.is_none() {
                a_working(n, Origen::Externo, None, ahora);
            }
        }
        _ => {}
    }
}

fn en_reposo(n: &mut EstadoSesion, estable: Ms, ahora: Ms, ef: &mut Vec<Efecto>) {
    reanudar_por_prompt(n, ahora, ef);
    if n.pantalla == EstadoPantalla::Dialog && estable >= MENU_ESTABLE && n.asks.is_empty() {
        n.status = SessionStatus::Waiting;
        n.waiting = Some(wait_menu(n, ahora));
        ef.push(Efecto::Aviso {
            nivel: Nivel::Info,
            texto: "La TUI tiene un menú abierto".into(),
        });
    } else if n.pantalla == EstadoPantalla::Busy && estable >= BUSY_EXTERNO && !n.con_puente() {
        a_working(n, Origen::Externo, None, ahora);
    }
}

fn trabajando(
    n: &mut EstadoSesion,
    estable: Ms,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    if n.pantalla == EstadoPantalla::Dialog && estable >= MENU_ESTABLE && n.asks.is_empty() {
        n.status = SessionStatus::Waiting;
        n.waiting = Some(wait_menu(n, ahora));
        return;
    }
    if n.pantalla != EstadoPantalla::Prompt || !n.herramientas.is_empty() || !n.asks.is_empty() {
        return;
    }
    match n.turno.as_ref().and_then(|t| t.turn_id.clone()) {
        None => reconciliar(n, estable, ahora, t, ef),
        Some(id) => turno_perdido(n, &id, estable, ahora, t, ef),
    }
}

/// Working sin `turn_id` y pantalla en prompt 3 s: la TUI ya terminó.
fn reconciliar(
    n: &mut EstadoSesion,
    estable: Ms,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    if estable < RECONCILIA_PROMPT || n.plazo_comando.is_some() {
        return;
    }
    let resueltos = t.sin_evidencia == 0 && t.en_cola_cli == 0;
    let caducado = n
        .envio_desde
        .is_some_and(|e| ahora.saturating_sub(e) > RECONCILIA_SIN_EVIDENCIA);
    // La actividad del turno borra `envio_desde`: sin esta salida, un envío que
    // la CLI no confirma nunca dejaba la sesión en working para siempre.
    let quieta = estable >= RECONCILIA_SIN_EVIDENCIA
        && ahora.saturating_sub(n.ultima_actividad) >= RECONCILIA_SIN_EVIDENCIA;
    if !(resueltos || caducado || quieta) {
        return;
    }
    ef.push(Efecto::Log(
        "reconciliación por pantalla: prompt estable sin turno abierto".into(),
    ));
    if !resueltos {
        ef.push(Efecto::Log(format!(
            "envíos sin confirmar de la CLI: sending={} cliQueued={}",
            t.sin_evidencia, t.en_cola_cli
        )));
        ef.push(Efecto::ResolverHuerfanos);
    }
    a_idle(n, ef, true);
}

/// `turn_id` abierto, prompt 10 s y sin progreso: el `turnEnd` se perdió (o
/// `$.turn.abort` no dejó marca). Los 10 s cuentan también desde el inicio
/// del turno y desde la última actividad (los eventos del puente cuentan):
/// la pantalla y el spinner no se reinician al empezar un turno, y un turno
/// sin repintado se cerraba en el primer tick aunque siguiera trabajando.
fn turno_perdido(
    n: &mut EstadoSesion,
    id: &str,
    estable: Ms,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    let desde_inicio = n
        .turno
        .as_ref()
        .map_or(TURNO_PERDIDO, |t| ahora.saturating_sub(t.desde));
    let quieto = [
        estable,
        ahora.saturating_sub(n.ultimo_progreso),
        ahora.saturating_sub(n.ultima_actividad),
        desde_inicio,
    ]
    .iter()
    .all(|d| *d >= TURNO_PERDIDO);
    if !quieto {
        return;
    }
    ef.push(Efecto::Log(format!("turnEnd perdido: {id}")));
    pausar_por_plazo(n, ahora, t, ef);
    let desde = n.turno.as_ref().map_or(ahora, |t| t.desde);
    push_cerrado(n, id);
    n.turno = None;
    // Tras una interrupción, el turno que no cierra es el interrumpido: la
    // ventana ofrece «Enviar ahora» por este motivo.
    let motivo = if n.pausa_interrupcion.is_some() {
        "aborted"
    } else {
        "lost"
    };
    ef.push(Efecto::EmitirTurno(TurnoCerrado {
        turn_id: Some(id.to_string()),
        desde,
        hasta: ahora,
        motivo: motivo.into(),
        usage: None,
    }));
    if sin_pendientes(n, t) {
        a_idle(n, ef, true);
    } else {
        a_working(n, Origen::Externo, None, ahora);
    }
}

fn modo_por_pantalla(n: &mut EstadoSesion, ahora: Ms) {
    let Some((m, desde)) = n.modo_candidato.clone() else {
        return;
    };
    if ahora.saturating_sub(desde) < MODO_ESTABLE {
        return;
    }
    n.modo_candidato = None;
    let posterior = n.modo.as_ref().is_some_and(|(_, cambio)| *cambio > desde);
    let vigente = n.modo_en_pantalla.as_deref() == Some(m.as_str());
    if vigente && !posterior && n.modo.as_ref().map(|x| x.0.as_str()) != Some(m.as_str()) {
        n.modo = Some((m, ahora));
    }
}

/// `Tick`: pantalla estable, plazos e interrupción con asks abiertos.
pub(super) fn evaluar_tick(
    n: &mut EstadoSesion,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    if let Some(i) = n.interrumpiendo {
        if ahora.saturating_sub(i) >= INTERRUPCION_ASKS {
            n.interrumpiendo = None;
            if !n.asks.is_empty() {
                cancelar_asks(n, "interrupted", ef);
            }
        }
    }
    let reinicio_vencido = n
        .reiniciando
        .is_some_and(|r| ahora.saturating_sub(r) >= PLAZO_REINICIO);
    if reinicio_vencido {
        n.reiniciando = None;
    }
    if n.status == SessionStatus::Working {
        plazos(n, ahora, t, ef);
    }
    evaluar_pantalla(n, ahora, t, ef);
}

/// Idle con envíos `sending` sin evidencia (reinicio, recuperación, comando
/// por buzón que no llegó, «enviar ya» en el arranque): bloquean el drenaje.
/// Pasados 15 s en idle y 10 s sin actividad, la CLI no los recibió.
pub(super) fn huerfanos_en_reposo(
    n: &mut EstadoSesion,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    let en_reposo = n.status == SessionStatus::Idle
        && t.sin_evidencia > 0
        && matches!(n.pantalla, EstadoPantalla::Prompt | EstadoPantalla::Unknown);
    if !en_reposo {
        n.huerfanos_desde = None;
        return;
    }
    let desde = *n.huerfanos_desde.get_or_insert(ahora);
    let quieta = ahora.saturating_sub(n.ultima_actividad) >= RECONCILIA_SIN_EVIDENCIA;
    if ahora.saturating_sub(desde) < HUERFANO_EN_REPOSO || !quieta {
        return;
    }
    n.huerfanos_desde = None;
    ef.push(Efecto::Log(format!(
        "envíos sin confirmar con la sesión en idle: sending={}",
        t.sin_evidencia
    )));
    ef.push(Efecto::ResolverHuerfanos);
    if !n.pausa_drenaje {
        ef.push(Efecto::Drenar);
    }
}

fn plazos(n: &mut EstadoSesion, ahora: Ms, t: &ResumenTickets, ef: &mut Vec<Efecto>) {
    let sin_turno = n.turno.as_ref().is_none_or(|t| t.turn_id.is_none());
    if let Some(p) = n.plazo_comando {
        if ahora.saturating_sub(p) >= PLAZO_COMANDO
            && n.pantalla == EstadoPantalla::Prompt
            && sin_turno
        {
            ef.push(Efecto::Aviso {
                nivel: Nivel::Warn,
                texto: "El comando no abrió turno".into(),
            });
            a_idle(n, ef, true);
            return;
        }
    }
    if let Some(e) = n.tx_end_turn {
        let quieto = n.ultima_actividad <= e;
        if ahora.saturating_sub(e) >= TX_END_TURN_ESPERA && quieto && !n.con_puente() {
            cerrar_turno(n, None, "answer", "turnEnded", ahora, t, ef);
            return;
        }
    }
    if let Some(r) = n.tx_fin_red {
        if n.ultima_actividad > r {
            // El turno siguió tras la evidencia: era de otro turno.
            n.tx_fin_red = None;
        } else if ahora.saturating_sub(r) >= TX_RED_PUENTE {
            red_de_seguridad(n, r, ahora, t, ef);
        }
    }
}

// ---------------------------------------------------------------------------
// Cola en pausa tras un cierre por plazo (hallazgo nocturno 2)
// ---------------------------------------------------------------------------

/// El transcript cerró el turno y el puente no mandó su `turnEnd` en 3 s.
/// Si el puente mandó un `turnEnd` real cerca de esa evidencia (aunque se
/// ignorase por atrasado o ajeno), el puente vive y no hay nada que dudar:
/// se cierra sin pausar la cola (sesión 30de3966, 2026-10-15).
fn red_de_seguridad(
    n: &mut EstadoSesion,
    evidencia: Ms,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    let puente_vivo = n
        .ultimo_turn_end_puente
        .is_some_and(|f| f.saturating_add(TX_RED_PUENTE) >= evidencia);
    if puente_vivo {
        ef.push(Efecto::Log(
            "red de seguridad: el transcript cerró el turno tras un turnEnd del puente; sin pausa"
                .into(),
        ));
    } else {
        ef.push(Efecto::Log(
            "red de seguridad: el transcript cerró el turno y el puente no envió turnEnd".into(),
        ));
        pausar_por_plazo(n, ahora, t, ef);
    }
    cerrar_turno(n, None, "answer", "turnEnded", ahora, t, ef);
}

/// Aviso de la pausa por plazo con `n` mensajes retenidos en la cola.
pub(super) fn aviso_pausa_plazo(n: usize) -> String {
    let mensajes = if n == 1 {
        "1 mensaje".to_string()
    } else {
        format!("{n} mensajes")
    };
    format!(
        "No llegó la confirmación de fin de turno del puente: retengo {mensajes} en cola \
         hasta ver el prompt de Claude libre 30 s seguidos o hasta que pulses «Enviar ahora»"
    )
}

/// Con puente, un cierre por plazo no es evidencia de que el turno acabó (19
/// `turnEnd` atrasados en 4 días de logs): la sesión pasa a idle, pero la
/// cola no se drena sola. Sin puente el transcript es la única fuente y se
/// conserva el drenaje. Se llama antes de `a_idle`/`cerrar_turno`. Sin nada
/// en la cola de ULTRON la pausa no retiene nada: solo queda en el log. Con la
/// cola ya retenida por una interrupción, ni pausa ni aviso: el plazo no es la
/// causa y el aviso prometería una reanudación que no va a ocurrir.
fn pausar_por_plazo(n: &mut EstadoSesion, ahora: Ms, t: &ResumenTickets, ef: &mut Vec<Efecto>) {
    if !n.con_puente() || n.pausa_interrupcion.is_some() {
        return;
    }
    n.pausa_plazo = Some(ahora);
    if t.en_cola_ultron == 0 {
        ef.push(Efecto::Log(
            "cola en pausa tras un cierre por plazo (vacía: sin aviso)".into(),
        ));
        return;
    }
    ef.push(Efecto::Aviso {
        nivel: Nivel::Warn,
        texto: aviso_pausa_plazo(t.en_cola_ultron),
    });
}

/// Prompt estable en idle que reanuda la cola tras un cierre por plazo.
const PROMPT_REANUDA: Ms = 30_000;

/// Evidencia real (`turnEnd`, `hello` o prompt estable): quita la pausa del
/// cierre por plazo y, en idle, drena si nada más retiene la cola. Sin pausa
/// de plazo no hace nada (la pausa de una recuperación no se toca).
pub(super) fn reanudar_cola(n: &mut EstadoSesion, por: &str, ef: &mut Vec<Efecto>) {
    if n.pausa_plazo.take().is_none() {
        return;
    }
    ef.push(Efecto::Log(format!(
        "cola reanudada tras el cierre por plazo: {por}"
    )));
    soltar_si_libre(n, ef);
}

/// En idle y sin ninguna retención, la cola vuelve a drenar. Trabajando, lo
/// hará el `a_idle` del fin de turno.
fn soltar_si_libre(n: &mut EstadoSesion, ef: &mut Vec<Efecto>) {
    if n.status == SessionStatus::Idle && !super::cola_retenida(n) {
        n.pausa_drenaje = false;
        ef.push(Efecto::Drenar);
    }
}

/// «Enviar ahora»: el usuario decide que Claude está libre, sea cual sea la
/// retención. Sin ninguna pausa no hace nada.
pub(super) fn enviar_ahora(n: &mut EstadoSesion, ef: &mut Vec<Efecto>) {
    let retenida = n.pausa_interrupcion.take().is_some() | n.pausa_limite.take().is_some();
    n.recuperado_sin_prompt = false;
    if n.pausa_plazo.is_some() {
        reanudar_cola(n, "envío manual", ef);
    } else if retenida {
        ef.push(Efecto::Log("cola reanudada: envío manual".into()));
        soltar_si_libre(n, ef);
    }
}

/// Aviso de la retención por el límite de uso con `n` mensajes en cola.
pub(super) fn aviso_pausa_limite(n: usize) -> String {
    let mensajes = if n == 1 {
        "1 mensaje".to_string()
    } else {
        format!("{n} mensajes")
    };
    format!(
        "Claude ha llegado a su límite de uso: retengo {mensajes} en cola hasta que vuelva \
         el cupo o hasta que pulses «Enviar ahora»"
    )
}

/// Primer aviso de cuota: la cola se retiene hasta la vuelta. Los siguientes
/// no repiten el aviso. Sin nada en cola, solo queda en el log: lo que se
/// encole después lo enseña `queuePause`.
pub(super) fn limite_uso(
    n: &mut EstadoSesion,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    n.pausa_drenaje = true;
    if n.pausa_limite.is_some() {
        return;
    }
    n.pausa_limite = Some(ahora);
    if t.en_cola_ultron == 0 {
        ef.push(Efecto::Log(
            "cola en pausa por el límite de uso (vacía: sin aviso)".into(),
        ));
        return;
    }
    ef.push(Efecto::Aviso {
        nivel: Nivel::Warn,
        texto: aviso_pausa_limite(t.en_cola_ultron),
    });
}

/// La cuota volvió o el relevo terminó.
pub(super) fn limite_fin(n: &mut EstadoSesion, ef: &mut Vec<Efecto>) {
    if n.pausa_limite.take().is_none() {
        return;
    }
    ef.push(Efecto::Log("cola reanudada: fin del límite de uso".into()));
    soltar_si_libre(n, ef);
}

fn reanudar_por_prompt(n: &mut EstadoSesion, ahora: Ms, ef: &mut Vec<Efecto>) {
    let Some(p) = n.pausa_plazo else { return };
    let estable = ahora.saturating_sub(n.pantalla_desde.max(p));
    if n.pantalla == EstadoPantalla::Prompt && estable >= PROMPT_REANUDA {
        reanudar_cola(n, "prompt estable 30 s", ef);
    }
}

// ---------------------------------------------------------------------------
// Saltos de reloj: suspensión del PC (hallazgo nocturno 5)
// ---------------------------------------------------------------------------

/// Hueco entre dos ticks de una sesión a partir del cual el proceso estuvo
/// parado (suspensión): los ticks llegan cada segundo como mucho.
pub const SALTO_RELOJ: Ms = 30_000;

/// Hueco desde el último tick si supera `SALTO_RELOJ`.
pub fn salto_de_reloj(ultimo_tick: Option<Ms>, ahora: Ms) -> Option<Ms> {
    ultimo_tick
        .map(|t| ahora.saturating_sub(t))
        .filter(|gap| *gap > SALTO_RELOJ)
}

/// Rebasa a `ahora` los instantes de referencia de los plazos para que
/// ninguno venza por el hueco de una suspensión: pantalla estable, quietud,
/// colgado, plazos del transcript, del comando, del arranque y de los
/// huérfanos. `turno.desde` y `working_since` no son plazos (duración del
/// turno) y se conservan. Las herramientas abiertas se desplazan `gap` en
/// vez de rebasarse a `ahora`: así conservan su orden relativo, del que
/// depende la elección de `segundo_plano::objetivo`, y su plazo restante
/// (el proceso de la herramienta también estuvo suspendido).
pub fn rebasar_reloj(n: &mut EstadoSesion, ahora: Ms, gap: Ms) {
    let rebasa = |x: &mut Ms| *x = (*x).max(ahora);
    rebasa(&mut n.pantalla_desde);
    rebasa(&mut n.ultima_actividad);
    rebasa(&mut n.ultimo_progreso);
    rebasa(&mut n.arranque_desde);
    for h in n.herramientas.values_mut() {
        h.desde = h.desde.saturating_add(gap);
    }
    for o in [
        &mut n.envio_desde,
        &mut n.plazo_comando,
        &mut n.tx_end_turn,
        &mut n.tx_fin_red,
        &mut n.huerfanos_desde,
        &mut n.puente_listo_desde,
        &mut n.interrumpiendo,
        &mut n.reiniciando,
        &mut n.pausa_plazo,
    ] {
        if let Some(x) = o.as_mut() {
            rebasa(x);
        }
    }
    n.stalled = None;
}

// ---------------------------------------------------------------------------
// Colgado (§1.5)
// ---------------------------------------------------------------------------

/// Recalcula `stalled` (solo en working). Conserva `since` y el texto si el
/// motivo no cambia, para no emitir en cada tick.
pub(super) fn evaluar_stall(n: &mut EstadoSesion, ahora: Ms) {
    let motivo = match n.status {
        SessionStatus::Working => sin_turno(n, ahora)
            .or_else(|| herramienta_vencida(n, ahora))
            .or_else(|| tui_congelada(n, ahora))
            .or_else(|| sin_eventos(n, ahora)),
        SessionStatus::Starting => arranque_vencido(n, ahora),
        _ => {
            n.stalled = None;
            return;
        }
    };
    n.stalled = match (motivo, n.stalled.take()) {
        (None, _) => None,
        (Some(m), Some(prev)) if prev.reason == m.reason && prev.tool == m.tool => Some(prev),
        (Some(m), _) => Some(m),
    };
}

fn stall(reason: StallReason, ahora: Ms, tool: Option<String>, detail: String) -> StallInfo {
    StallInfo {
        reason,
        since: super::iso(ahora),
        tool,
        detail,
    }
}

/// `starting` que no llega al prompt en `PLAZO_ARRANQUE`: error de
/// autenticación o de ajustes, aviso que el clasificador no reconoce o un
/// `hello` que no llega. Con un reinicio en curso, el plazo es el suyo.
fn arranque_vencido(n: &EstadoSesion, ahora: Ms) -> Option<StallInfo> {
    let desde = n.arranque_desde.max(n.reiniciando.unwrap_or(0));
    (ahora.saturating_sub(desde) > PLAZO_ARRANQUE).then(|| {
        stall(
            StallReason::StartupTimeout,
            ahora,
            None,
            format!(
                "Claude no ha llegado al prompt en 30 s (pantalla: {})",
                nombre_pantalla(n.pantalla)
            ),
        )
    })
}

fn nombre_pantalla(p: EstadoPantalla) -> String {
    serde_json::to_value(p)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| "desconocida".into())
}

fn sin_turno(n: &EstadoSesion, ahora: Ms) -> Option<StallInfo> {
    let e = n.envio_desde.filter(|_| n.con_puente())?;
    (ahora.saturating_sub(e) > SIN_TURNO_STALL).then(|| {
        stall(
            StallReason::NoTurnStart,
            ahora,
            None,
            "Claude no ha recibido el mensaje (15 s)".into(),
        )
    })
}

fn es_agente(nombre: &str) -> bool {
    HERRAMIENTAS_AGENTE.contains(&nombre)
}

fn herramienta_vencida(n: &EstadoSesion, ahora: Ms) -> Option<StallInfo> {
    n.herramientas
        .values()
        .filter(|h| !es_agente(&h.nombre))
        .filter(|h| ahora.saturating_sub(h.desde) > limite_herramienta(h) + margen(h))
        .min_by_key(|h| h.desde)
        .map(|h| {
            let pasado = duracion(ahora.saturating_sub(h.desde));
            let limite = duracion(limite_herramienta(h));
            let detail = format!(
                "{} sigue sin terminar: {pasado} (límite {limite})",
                h.nombre
            );
            stall(
                StallReason::ToolOverdue,
                ahora,
                Some(h.nombre.clone()),
                detail,
            )
        })
}

/// `timeout` de la entrada; sin él, 2 min en Bash y PowerShell y 15 min en
/// el resto.
fn limite_herramienta(h: &HerramientaAbierta) -> Ms {
    match h.timeout_ms {
        Some(t) => t,
        None if HERRAMIENTAS_TERMINAL.contains(&h.nombre.as_str()) => TOOL_BASH_POR_DEFECTO,
        None => TOOL_SIN_TIMEOUT,
    }
}

/// Margen sobre el límite: el de un `timeout` explícito o el de la terminal
/// por defecto (la CLI corta a los 2 min); el plazo largo ya lo lleva dentro.
fn margen(h: &HerramientaAbierta) -> Ms {
    if h.timeout_ms.is_some() || HERRAMIENTAS_TERMINAL.contains(&h.nombre.as_str()) {
        TOOL_MARGEN
    } else {
        0
    }
}

fn tui_congelada(n: &EstadoSesion, ahora: Ms) -> Option<StallInfo> {
    let quieta = ahora.saturating_sub(n.ultimo_progreso) >= TUI_CONGELADA
        && ahora.saturating_sub(n.pantalla_desde) >= TUI_CONGELADA;
    (n.pantalla == EstadoPantalla::Busy && quieta).then(|| {
        stall(
            StallReason::TuiFrozen,
            ahora,
            None,
            "La terminal de Claude no responde (30 s)".into(),
        )
    })
}

fn sin_eventos(n: &EstadoSesion, ahora: Ms) -> Option<StallInfo> {
    if n.herramientas.values().any(|h| !es_agente(&h.nombre)) {
        return None;
    }
    let ultimo = n.ultima_actividad.max(n.ultimo_progreso);
    (ahora.saturating_sub(ultimo) >= n.umbral_stall_ms).then(|| {
        let detail = format!("Sin eventos desde hace {}", duracion(n.umbral_stall_ms));
        stall(StallReason::NoEvents, ahora, None, detail)
    })
}

/// «45 s», «2 min», «17 min» (los minutos se truncan).
pub(super) fn duracion(ms: Ms) -> String {
    let s = ms / 1000;
    if s < 60 {
        format!("{s} s")
    } else {
        format!("{} min", s / 60)
    }
}
