// sesiones/recuperacion_interrumpir.rs — Interrumpir el turno (§3.3):
// `turn.abort` por el puente v2, un Esc y, como último recurso, un Ctrl+C.
//
// Incidente del 2026-10-15 (sesión f8e7249b): el turno pedido terminó y la
// CLI abrió otro con el aviso de una tarea en segundo plano; la recuperación
// escaló a Ctrl+C sobre ese turno nuevo y la máquina avisó en rojo de que
// había que reiniciar, cuando el siguiente Esc lo paró con `turn.abort`. Por
// eso: el `turnId` del principio se compara con el vigente tras cada espera
// (un turno nuevo se aborta una vez por el puente, nunca con teclas); un Esc
// que solo sacó la cola nativa a la caja (popAll) se resuelve devolviendo
// ese texto a la cola y con otro Esc, y Ctrl+C solo sale con el mismo turno,
// la caja vacía y la pantalla ocupada.
//
// Propiedad: WP-PTY.

use std::time::Duration;

use super::{devolver_entrada, esperar, fuera_de_busy, terminar, Entorno, Resultado, ESPERA_TURNO};
use crate::pty::escritor::{TeclaPty, Trabajo};
use crate::sesiones::senales::{MotivoFallo, Senal};

/// Espera máxima de la anotación de una `<task-notification>` (puente o
/// transcript) antes de dar el resultado.
const ESPERA_TAREA: Duration = Duration::from_millis(500);

/// true si el turno `t0` que se pidió parar ya no es el vigente: terminó y
/// la CLI abrió otro. Sin `t0` (sin puente v2 o sin turno) no se sabe.
pub(super) fn turno_relevado(e: &dyn Entorno, t0: Option<&str>) -> bool {
    match (t0, e.turno_v2()) {
        (Some(antes), Some(ahora)) => antes != ahora,
        _ => false,
    }
}

fn libre_o_relevado(e: &dyn Entorno, t0: Option<&str>) -> bool {
    fuera_de_busy(e) || turno_relevado(e, t0)
}

/// §3.3: `turn.abort` (puente v2) → un Esc → un Ctrl+C, con las guardas de
/// arriba. Un único reintento si el turno se releva.
pub fn interrumpir(e: &dyn Entorno) -> Resultado {
    let t0 = e.turno_v2();
    let t0 = t0.as_deref();
    let mut steps = Vec::new();
    // La máquina anota la interrupción; no cancela todavía los asks.
    e.senal(Senal::InterrupcionPedida);
    if t0.is_some() && e.cola_nativa() {
        // `$.turn.abort` cierra el turno sin marca de interrupción y la CLI
        // saca acto seguido el siguiente mensaje de su cola nativa: Claude
        // sigue trabajando (sesión ef9979bb, 2026-10-21). Con cola, Esc: la
        // CLI la devuelve a la caja (popAll) y `escalar_teclas` la reencola.
        steps.push("colaNativaSinTurnAbort".to_string());
    } else if let Some(t) = t0 {
        if e.abortar_turno(t) {
            steps.push("turn.abort".to_string());
            let fin = esperar(e, ESPERA_TURNO, |e| {
                e.turno_cerrado() || libre_o_relevado(e, t0)
            });
            if fin && !turno_relevado(e, t0) {
                return terminar(e, steps);
            }
        } else {
            steps.push("turn.abort sin respuesta".to_string());
        }
    }
    if turno_relevado(e, t0) {
        return reintentar_turno_nuevo(e, steps);
    }
    if e.turno_cerrado() && fuera_de_busy(e) {
        steps.push("nadaQueInterrumpir".to_string());
        return terminar(e, steps);
    }
    escalar_teclas(e, t0, steps)
}

/// Esc; si solo sacó la cola nativa a la caja, devolverla y otro Esc; y
/// Ctrl+C solo si `puede_ctrl_c`.
fn escalar_teclas(e: &dyn Entorno, t0: Option<&str>, mut steps: Vec<String>) -> Resultado {
    escribir(e, TeclaPty::Esc, "esc", &mut steps);
    if let Some(r) = tras_tecla(e, t0, &mut steps) {
        return r;
    }
    if let Some(texto) = e.pantalla().entrada {
        // popAll: la CLI devolvió a la caja los mensajes de su cola nativa y
        // el turno sigue. Ctrl+C borraría ese texto.
        devolver_entrada(e, texto, "colaDevuelta", &mut steps);
        escribir(e, TeclaPty::Esc, "esc2", &mut steps);
        if let Some(r) = tras_tecla(e, t0, &mut steps) {
            return r;
        }
    }
    if puede_ctrl_c(e, t0) {
        escribir(e, TeclaPty::CtrlC, "ctrlC", &mut steps);
        if let Some(r) = tras_tecla(e, t0, &mut steps) {
            return r;
        }
    } else if !fuera_de_busy(e) {
        steps.push("ctrlCOmitido".to_string());
    }
    if fuera_de_busy(e) {
        return terminar(e, steps);
    }
    fallo(e, t0, steps)
}

fn escribir(e: &dyn Entorno, tecla: TeclaPty, paso: &str, steps: &mut Vec<String>) {
    match e.escribir(Trabajo::Tecla(tecla)) {
        Ok(()) => steps.push(paso.to_string()),
        Err(err) => steps.push(format!("{paso}: {err}")),
    }
}

/// Espera tras una tecla: `Some` si la pantalla se liberó o el turno se
/// relevó (y ya está resuelto); `None` si hay que seguir escalando.
fn tras_tecla(e: &dyn Entorno, t0: Option<&str>, steps: &mut Vec<String>) -> Option<Resultado> {
    if !esperar(e, ESPERA_TURNO, |e| libre_o_relevado(e, t0)) {
        return None;
    }
    let steps = std::mem::take(steps);
    Some(if turno_relevado(e, t0) {
        reintentar_turno_nuevo(e, steps)
    } else {
        terminar(e, steps)
    })
}

/// Ctrl+C solo sobre el mismo turno, abierto, con la caja vacía (no borra
/// texto) y la pantalla ocupada, releída justo antes de escribir: con la CLI
/// en reposo dejaría el aviso «Press Ctrl-C again to exit».
fn puede_ctrl_c(e: &dyn Entorno, t0: Option<&str>) -> bool {
    e.turno_v2().as_deref() == t0
        && !e.turno_cerrado()
        && e.pantalla().entrada.is_none()
        && !fuera_de_busy(e)
}

/// El turno pedido terminó y la CLI abrió otro: se aborta ese por el puente
/// una sola vez, sin teclas (podrían caer en un tercer turno o en el prompt).
fn reintentar_turno_nuevo(e: &dyn Entorno, mut steps: Vec<String>) -> Resultado {
    steps.push("turnoNuevo".to_string());
    anotar_tarea_si_llega(e, &mut steps);
    let Some(t2) = e.turno_v2() else {
        // El turno nuevo ya cerró solo.
        return terminar(e, steps);
    };
    if e.abortar_turno(&t2) {
        steps.push("turn.abort".to_string());
        let t2 = Some(t2.as_str());
        let fin = esperar(e, ESPERA_TURNO, |e| {
            e.turno_cerrado() || libre_o_relevado(e, t2)
        });
        if fin && !turno_relevado(e, t2) {
            return terminar(e, steps);
        }
    } else {
        steps.push("turn.abort sin respuesta".to_string());
    }
    steps.push("sigueTrabajando".to_string());
    senal_fallo(e, Some(MotivoFallo::TurnoNuevo));
    Resultado { ok: false, steps }
}

/// La anotación de la `<task-notification>` llega por el puente o por el
/// transcript con algo de retraso: se espera un poco antes de contarlo.
fn anotar_tarea_si_llega(e: &dyn Entorno, steps: &mut Vec<String>) {
    if esperar(e, ESPERA_TAREA, |e| e.retomado_por_tarea()) {
        steps.push("retomaPorTarea".to_string());
    }
}

/// La pantalla sigue ocupada tras las teclas. Solo es «la CLI no responde»
/// si el mismo turno sigue abierto y el puente no dio señales de vida.
fn fallo(e: &dyn Entorno, t0: Option<&str>, mut steps: Vec<String>) -> Resultado {
    steps.push("sigueTrabajando".to_string());
    anotar_tarea_si_llega(e, &mut steps);
    let por_tarea = steps.iter().any(|s| s == "retomaPorTarea");
    let motivo = if turno_relevado(e, t0) {
        steps.push("turnoNuevo".to_string());
        Some(MotivoFallo::TurnoNuevo)
    } else if por_tarea {
        Some(MotivoFallo::TurnoNuevo)
    } else if e.actividad_puente() {
        None
    } else {
        // La ventana no repite el aviso: lo da la máquina en rojo.
        steps.push("sinRespuesta".to_string());
        Some(MotivoFallo::SinRespuesta)
    };
    senal_fallo(e, motivo);
    Resultado { ok: false, steps }
}

fn senal_fallo(e: &dyn Entorno, motivo: Option<MotivoFallo>) {
    e.senal(Senal::RecuperacionTerminada { ok: false, motivo });
}
