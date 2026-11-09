// sesiones/maquina_senales.rs — Transiciones de la máquina de estados por
// señal (contrato de estabilidad, §1.4): envío, pantalla, salida y reinicio
// del proceso, hello, turnos, comandos, asks, modo de permisos, fin de turno
// por transcript y recuperación. Funciones puras sobre `EstadoSesion`.
//
// Propiedad: WP-ESTADO.

use super::{
    a_idle, a_working, cancelar_asks, cerrar_turno, normalizar_modo, push_cerrado, sin_pendientes,
    tiempo, wait_info, Efecto, EstadoSesion, Ms, Nivel, Origen, ResumenTickets, TurnoAbierto,
};
use crate::sesiones::catalogo;
use crate::sesiones::senales::{EnvioKind, EstadoPantalla, MotivoFallo};
use crate::sesiones::types::{CommandKind, SessionStatus, WaitKind};

/// Motivo de los `cliQueued` que se pierden al matar el proceso en un
/// reinicio (su cola nativa vivía en la memoria del proceso).
pub(super) const MOTIVO_COLA_CLI_REINICIO: &str =
    "El reinicio cerró la CLI con el mensaje en su cola: reinténtalo";

pub(super) fn envio_escrito(
    n: &mut EstadoSesion,
    kind: &EnvioKind,
    ahora: Ms,
    ef: &mut Vec<Efecto>,
) {
    n.recuperado_sin_prompt = false;
    // Un prompt del usuario levanta la pausa de la interrupción; un `/comando`
    // o un `!bash` no dicen que quiera seguir con lo que hay en cola. El límite
    // de uso no se levanta así: un prompt no prueba que la cuota haya vuelto.
    if matches!(kind, EnvioKind::Prompt) {
        n.pausa_interrupcion = None;
    }
    if n.status == SessionStatus::Waiting {
        ef.push(Efecto::Log(
            "envío escrito con la sesión en waiting: se conserva".into(),
        ));
        return;
    }
    n.envio_desde = Some(ahora);
    if n.status != SessionStatus::Idle {
        return;
    }
    let origen = match kind {
        EnvioKind::Prompt => Origen::Prompt,
        EnvioKind::Bash => Origen::Bash,
        EnvioKind::Comando { nombre } => {
            let nombre = nombre.trim_start_matches('/').to_string();
            let kind = catalogo::kind_por_nombre(&nombre);
            Origen::Comando {
                run_id: None,
                nombre,
                kind,
            }
        }
    };
    a_working(n, origen, None, ahora);
}

pub(super) fn pantalla(
    n: &mut EstadoSesion,
    estado: EstadoPantalla,
    modo: Option<&str>,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    if estado != n.pantalla {
        n.pantalla = estado;
        n.pantalla_desde = ahora;
    }
    if estado == EstadoPantalla::Prompt && std::mem::take(&mut n.recuperado_sin_prompt) {
        cerrar_recuperacion(n, ef);
    }
    if let Some(m) = modo.and_then(normalizar_modo) {
        if n.modo_en_pantalla.as_deref() != Some(m.as_str()) {
            n.modo_en_pantalla = Some(m.clone());
            n.modo_candidato = Some((m, ahora));
        }
    }
    tiempo::evaluar_pantalla(n, ahora, t, ef);
}

pub(super) fn proceso_salio(n: &mut EstadoSesion, code: i32, ef: &mut Vec<Efecto>) {
    if n.reiniciando.take().is_some() {
        // Solo hay un proceso anterior: la siguiente salida es la del
        // relanzado y termina la sesión aunque no haya llegado a idle.
        ef.push(Efecto::Log(format!(
            "proceso anterior salió con código {code} durante el reinicio"
        )));
        return;
    }
    cancelar_asks(n, "sessionExited", ef);
    ef.push(Efecto::FallarEnvios {
        motivo: "la sesión terminó",
    });
    n.status = SessionStatus::Exited;
    n.exit_code = Some(code);
    n.waiting = None;
    n.stalled = None;
    n.turno = None;
    n.working_since = None;
    n.herramientas.clear();
    n.interrumpiendo = None;
}

pub(super) fn reinicio(n: &mut EstadoSesion, ahora: Ms, ef: &mut Vec<Efecto>) {
    cancelar_asks(n, "restart", ef);
    ef.push(Efecto::FallarColaCli {
        motivo: MOTIVO_COLA_CLI_REINICIO,
    });
    // Desde exited, la salida del proceso anterior ya se procesó.
    n.reiniciando = (n.status != SessionStatus::Exited).then_some(ahora);
    n.status = SessionStatus::Starting;
    n.waiting = None;
    n.stalled = None;
    n.turno = None;
    n.working_since = None;
    n.herramientas.clear();
    n.modo = None;
    n.modo_en_pantalla = None;
    n.modo_candidato = None;
    n.exit_code = None;
    n.interrumpiendo = None;
    n.puente_listo_desde = None;
    n.plazo_comando = None;
    n.tx_end_turn = None;
    n.tx_fin_red = None;
    n.envio_desde = None;
    n.pausa_plazo = None;
    // Reiniciar es decidir seguir: la cola sale al llegar al prompt. El límite
    // de uso se conserva porque el proceso nuevo tiene la misma cuota.
    n.pausa_interrupcion = None;
    n.recuperado_sin_prompt = false;
    n.ultimo_turn_end_puente = None;
    n.pantalla = EstadoPantalla::Unknown;
    // El puente era del proceso anterior: el relanzado lo anuncia en su
    // `hello`, y sin él la sesión va por pantalla (sin esperar un puente que
    // quizá ya no existe).
    n.protocolo = 0;
    n.generacion = 0;
}

pub(super) fn hello(
    n: &mut EstadoSesion,
    protocolo: u8,
    sid: Option<&str>,
    gen: u32,
    ef: &mut Vec<Efecto>,
) {
    n.protocolo = protocolo;
    n.generacion = gen;
    tiempo::reanudar_cola(n, "hello del puente", ef);
    let Some(sid) = sid.filter(|s| !s.is_empty()) else {
        return;
    };
    match n.claude_session_id.as_deref() {
        Some(actual) if actual != sid => ef.push(Efecto::EmitirReset {
            claude_session_id: sid.to_string(),
        }),
        _ => {}
    }
    n.claude_session_id = Some(sid.to_string());
}

pub(super) fn puente_listo(
    n: &mut EstadoSesion,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    if n.status == SessionStatus::Starting && n.puente_listo_desde.is_none() {
        n.puente_listo_desde = Some(ahora);
    }
    tiempo::evaluar_pantalla(n, ahora, t, ef);
}

pub(super) fn prompt_entrado(n: &mut EstadoSesion, ahora: Ms) {
    n.envio_desde = None;
    n.plazo_comando = None;
    if n.status == SessionStatus::Idle {
        a_working(n, Origen::Externo, None, ahora);
    } else if n.cierre_puente.is_some() {
        n.prompt_tras_cierre = true;
    }
}

pub(super) fn turno_inicio(n: &mut EstadoSesion, turn_id: &str, ahora: Ms) {
    if n.cerrados.iter().any(|c| c == turn_id) {
        return;
    }
    n.plazo_comando = None;
    n.envio_desde = None;
    n.stalled = None;
    n.recuperado_sin_prompt = false;
    if n.turn_id() != Some(turn_id) {
        // Un fin de turno del transcript anterior a este turno es del previo.
        n.tx_fin_red = None;
    }
    match n.status {
        SessionStatus::Idle | SessionStatus::Starting => {
            a_working(n, Origen::Externo, Some(turn_id.to_string()), ahora);
        }
        SessionStatus::Working | SessionStatus::Waiting => match n.turno.as_mut() {
            Some(t) => t.turn_id = Some(turn_id.to_string()),
            None => {
                n.turno = Some(TurnoAbierto {
                    turn_id: Some(turn_id.to_string()),
                    origen: Origen::Externo,
                    desde: ahora,
                });
            }
        },
        SessionStatus::Exited => {}
    }
}

pub(super) fn turno_fin(
    n: &mut EstadoSesion,
    turn_id: &str,
    motivo: &str,
    abortado: bool,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    // Un `turnEnd` real, aunque sea el atrasado del turno cerrado por plazo,
    // es la evidencia que reanuda la cola y la prueba de que el puente vive.
    n.ultimo_turn_end_puente = Some(ahora);
    tiempo::reanudar_cola(n, "turnEnd real del puente", ef);
    if !matches!(n.status, SessionStatus::Working | SessionStatus::Waiting) {
        ef.push(Efecto::Log(format!("turnEnd {turn_id} sin turno abierto")));
        return;
    }
    let actual = n.turn_id().map(str::to_string);
    let ajeno = actual.as_deref().is_some_and(|a| a != turn_id);
    let cerrado = n.cerrados.iter().any(|c| c == turn_id);
    if cerrado || ajeno {
        ef.push(Efecto::Log(format!(
            "turnEnd atrasado ignorado: {turn_id} (turno actual {}, ya cerrado: {cerrado})",
            actual.as_deref().unwrap_or("ninguno")
        )));
        return;
    }
    let cancel = if n.interrumpiendo.is_some() {
        "interrupted"
    } else {
        "turnEnded"
    };
    let motivo = if abortado { "aborted" } else { motivo };
    cerrar_turno(n, Some(turn_id), motivo, cancel, ahora, t, ef);
    if n.status == SessionStatus::Working {
        n.cierre_puente = Some(ahora);
        n.prompt_tras_cierre = false;
    }
}

pub(super) fn comando_inicio(n: &mut EstadoSesion, run_id: &str, nombre: &str, ahora: Ms) {
    let nombre = nombre.trim_start_matches('/');
    n.envio_desde = None;
    match n.status {
        SessionStatus::Idle => {
            let origen = Origen::Comando {
                run_id: Some(run_id.to_string()),
                nombre: nombre.to_string(),
                kind: catalogo::kind_por_nombre(nombre),
            };
            a_working(n, origen, None, ahora);
        }
        SessionStatus::Working | SessionStatus::Waiting => {
            if let Some(TurnoAbierto {
                origen:
                    Origen::Comando {
                        run_id: r @ None,
                        nombre: nm,
                        ..
                    },
                ..
            }) = n.turno.as_mut()
            {
                if nm == nombre {
                    *r = Some(run_id.to_string());
                }
            }
        }
        _ => {}
    }
}

pub(super) fn comando_fin(
    n: &mut EstadoSesion,
    run_id: &str,
    nombre: &str,
    interceptado: bool,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    let activo = n.status == SessionStatus::Working || n.esperando(WaitKind::Menu);
    let Some(turno) = n.turno.as_ref().filter(|_| activo) else {
        return;
    };
    if turno.turn_id.is_some() {
        ef.push(Efecto::Log(
            "commandEnd con turno abierto: lo cierra turnEnd".into(),
        ));
        return;
    }
    let Origen::Comando {
        run_id: r,
        nombre: nm,
        kind,
    } = &turno.origen
    else {
        return;
    };
    let nombre = nombre.trim_start_matches('/');
    let mismo = r.as_deref() == Some(run_id) || (r.is_none() && nm == nombre);
    if !mismo {
        return;
    }
    if *kind == CommandKind::Prompt && !interceptado {
        n.plazo_comando = Some(ahora);
        return;
    }
    if sin_pendientes(n, t) {
        a_idle(n, ef, true);
    }
}

pub(super) fn ask_abierta(n: &mut EstadoSesion, ask_id: &str, kind: &str, ahora: Ms) {
    if n.asks.iter().any(|(id, _)| id == ask_id) {
        return;
    }
    let k = match kind {
        "question" => WaitKind::Question,
        "plan" => WaitKind::Plan,
        _ => WaitKind::Permission,
    };
    n.asks.push((ask_id.to_string(), k));
    if n.esperando_ask() {
        return;
    }
    if n.working_since.is_none() {
        n.working_since = Some(ahora);
    }
    n.status = SessionStatus::Waiting;
    n.waiting = Some(wait_info(k, Some(ask_id.to_string()), ahora));
}

pub(super) fn ask_cerrada(
    n: &mut EstadoSesion,
    ask_id: &str,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    n.asks.retain(|(id, _)| id != ask_id);
    if !n.esperando_ask() {
        return;
    }
    if let Some((id, k)) = n.asks.first().cloned() {
        n.waiting = Some(wait_info(k, Some(id), ahora));
    } else if n.turno.is_some() {
        n.status = SessionStatus::Working;
        n.waiting = None;
    } else if sin_pendientes(n, t) {
        a_idle(n, ef, true);
    } else {
        a_working(n, Origen::Externo, None, ahora);
    }
}

pub(super) fn modo_permisos(n: &mut EstadoSesion, modo: &str, ahora: Ms) {
    let Some(m) = normalizar_modo(modo) else {
        return;
    };
    n.modo_candidato = None;
    if n.modo.as_ref().map(|x| x.0.as_str()) != Some(m.as_str()) {
        n.modo = Some((m, ahora));
    }
}

pub(super) fn fin_por_transcript(
    n: &mut EstadoSesion,
    interrumpido: bool,
    ahora: Ms,
    t: &ResumenTickets,
    ef: &mut Vec<Efecto>,
) {
    n.tx_end_turn = None;
    // Esc en la terminal: `InterrupcionPedida` no se emite y `$.turn.abort`
    // puede cerrar sin marca; la línea de interrupción del transcript es la
    // única evidencia y llega también después del `turnEnd`.
    if interrumpido {
        super::retener_por_interrupcion(n, ahora);
    }
    if n.status != SessionStatus::Working {
        return;
    }
    if n.con_puente() {
        if es_eco_del_cierre(n, ahora) {
            ef.push(Efecto::Log(
                "fin de turno del transcript tras el turnEnd del puente: ya cerrado".into(),
            ));
            // Lo pendiente se resolvió entre el turnEnd y el eco (un
            // cliQueued absorbido en ese turno): no queda turno que esperar.
            // Un prompt llegado después del cierre abre el siguiente (#41.3),
            // y con su `turnStart` ya recibido el turno es otro y sigue.
            if es_relleno(n) && sin_pendientes(n, t) && !n.prompt_tras_cierre {
                a_idle(n, ef, true);
            }
            return;
        }
        // La red se arma con la evidencia más reciente (§1.4).
        n.tx_fin_red = Some(ahora);
        return;
    }
    let (motivo, cancel) = if interrumpido || n.interrumpiendo.is_some() {
        ("aborted", "interrupted")
    } else {
        ("answer", "turnEnded")
    };
    cerrar_turno(n, None, motivo, cancel, ahora, t, ef);
}

/// Margen tras un `turnEnd` del puente en el que el fin de turno del
/// transcript es el del mismo turno (llega entre 50 y 120 ms después).
const ECO_CIERRE_PUENTE: Ms = 2_000;

/// El transcript cierra el turno que el puente ya cerró: la sesión siguió en
/// working por envíos pendientes, en el turno de relleno sin `turn_id` o en
/// el siguiente que la CLI ya arrancó (`turnStart` antes del eco). Sin esto,
/// la red de seguridad emitía un turno fantasma a los 3 s o cerraba el
/// turno siguiente si tardaba en dar actividad.
fn es_eco_del_cierre(n: &EstadoSesion, ahora: Ms) -> bool {
    n.turno.is_some()
        && n.cierre_puente
            .is_some_and(|c| ahora.saturating_sub(c) < ECO_CIERRE_PUENTE)
}

/// Turno de relleno: working solo por envíos pendientes, sin `turn_id`.
fn es_relleno(n: &EstadoSesion) -> bool {
    n.turno.as_ref().is_some_and(|t| t.turn_id.is_none())
}

pub(super) fn salida_local(n: &mut EstadoSesion, t: &ResumenTickets, ef: &mut Vec<Efecto>) {
    // En v2 los comandos locales los cierra `ComandoFin`; en v0 y v1, la
    // salida del transcript (§1.4, «Comandos locales»).
    let activo = n.status == SessionStatus::Working || n.esperando(WaitKind::Menu);
    if !activo || n.protocolo >= 2 {
        return;
    }
    let de_comando = n
        .turno
        .as_ref()
        .is_some_and(|t| matches!(t.origen, Origen::Comando { .. } | Origen::Bash));
    if de_comando && sin_pendientes(n, t) {
        a_idle(n, ef, true);
    }
}

/// Aviso de una recuperación fallida: solo es un error si la CLI no respondió
/// (el mismo turno sigue abierto, sin actividad del puente). Un turno nuevo
/// se para con otro Esc; sin motivo, el resultado ya lo cuenta la ventana.
pub(super) const AVISO_SIN_RESPUESTA: &str =
    "La CLI no responde a Esc ni a Ctrl+C: reinicia la sesión";
pub(super) const AVISO_TURNO_NUEVO: &str =
    "Claude abrió otro turno con el aviso de una tarea en segundo plano; pulsa Esc otra vez para pararlo";

fn aviso_de_fallo(motivo: Option<MotivoFallo>) -> Option<Efecto> {
    let (nivel, texto) = match motivo? {
        MotivoFallo::SinRespuesta => (Nivel::Error, AVISO_SIN_RESPUESTA),
        MotivoFallo::TurnoNuevo => (Nivel::Warn, AVISO_TURNO_NUEVO),
        MotivoFallo::MenuAbierto => return None,
    };
    Some(Efecto::Aviso {
        nivel,
        texto: texto.into(),
    })
}

pub(super) fn recuperacion(
    n: &mut EstadoSesion,
    ok: bool,
    motivo: Option<MotivoFallo>,
    ef: &mut Vec<Efecto>,
) {
    if !ok {
        ef.extend(aviso_de_fallo(motivo));
        return;
    }
    let activo = matches!(n.status, SessionStatus::Working | SessionStatus::Waiting);
    if !activo {
        return;
    }
    if n.pantalla != EstadoPantalla::Prompt {
        // La interrupción lee la pantalla al momento y la máquina la recibe con
        // retraso: el cierre queda pendiente de que llegue el prompt.
        n.recuperado_sin_prompt = n.pausa_interrupcion.is_some();
        return;
    }
    cerrar_recuperacion(n, ef);
}

/// Recuperación hecha con el prompt a la vista: idle sin drenar.
fn cerrar_recuperacion(n: &mut EstadoSesion, ef: &mut Vec<Efecto>) {
    if !matches!(n.status, SessionStatus::Working | SessionStatus::Waiting) {
        return;
    }
    if let Some(id) = n.turn_id().map(str::to_string) {
        push_cerrado(n, &id);
    }
    n.herramientas.clear();
    cancelar_asks(n, "interrupted", ef);
    n.interrumpiendo = None;
    // La pausa de la recuperación manda: el prompt estable no la levanta.
    n.pausa_plazo = None;
    a_idle(n, ef, false);
}
