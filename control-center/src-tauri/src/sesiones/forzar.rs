// sesiones/forzar.rs — «Interrumpir y enviar» (CONTRATO-v3, §3.4).
//
// Tras un turno abortado la cola queda en pausa (`pausa_drenaje`) y la
// interrupción devuelve la cola nativa de la CLI a la de ULTRON (popAll →
// `terminar`), así que interrumpir y después «Enviar ahora» a mano mandaba
// lo devuelto antes que el mensaje nuevo. Aquí: (1) el mensaje entra el
// primero de la cola (`encolar_delante`, idempotente por `clientId`); (2) se
// interrumpe con el algoritmo de §3.3 y su antirrebote; (3) si la CLI paró,
// sale solo ese elemento (`enviar_ya` con su `clientId`), por delante de lo
// devuelto, que sigue en cola y drena al cerrar el turno nuevo. Si no paró,
// el mensaje sigue el primero de la cola y el resultado lo dice con los
// pasos de la interrupción (`colaPausada` si la cola no drenará sola). Si
// otra interrupción de la sesión estaba en curso (`enCurso`, un Esc a la
// vez), se espera a que acabe y, si paró el turno, se envía igual. Antes de
// escribir se espera a que la máquina salga de `working`/`waiting` (la
// señal de pantalla puede llegar un tick tarde). Con la sesión libre es un
// envío inmediato.
//
// Propiedad: WP-PTY.

use std::sync::Arc;
use std::time::{Duration, Instant};

use super::cola::{self, Colas, Contexto, Escritor};
use super::maquina::Ms;
use super::recuperacion::{self, Resultado, SiReservada, ESPERA_TURNO, PASO};
use super::types::{
    InterruptSendOutcome, QueueItemInput, QueueState, RecoverAction, ScreenState, SessionStatus,
};

/// Lo que «Interrumpir y enviar» necesita de una sesión.
pub trait EntornoForzar {
    fn id(&self) -> &str;
    fn colas(&self) -> &Colas;
    fn contexto(&self) -> Contexto;
    fn escritor(&self) -> Arc<dyn Escritor>;
    /// Interrupción de §3.3 con su antirrebote.
    fn interrumpir(&self) -> Resultado;
    fn ahora(&self) -> Ms;
    fn dormir(&self, d: Duration);
    /// Espera a que acabe la otra interrupción en curso de la sesión;
    /// true si al acabar la pantalla ya no está ocupada (paró el turno).
    fn esperar_otra_interrupcion(&self) -> bool;
    /// Drenaje en pausa: el primero de la cola no sale al cerrar el turno.
    fn cola_en_pausa(&self) -> bool;
}

/// Paso de la interrupción cuando otra de la sesión ya estaba en marcha.
pub const EN_CURSO: &str = "enCurso";
/// Paso final cuando el mensaje queda en una cola en pausa: no sale solo.
pub const COLA_PAUSADA: &str = "colaPausada";
/// Espera máxima de la máquina fuera de `working`/`waiting` tras parar.
const ESPERA_ESTADO: Duration = Duration::from_secs(1);
/// Espera máxima de otra interrupción en curso (§3.3 encadena varias
/// esperas de `ESPERA_TURNO`).
const ESPERA_OTRA: Duration = Duration::from_secs(ESPERA_TURNO.as_secs() * 3);

fn ocupada(ctx: Contexto) -> bool {
    matches!(ctx.status, SessionStatus::Working | SessionStatus::Waiting)
}

/// Estados en los que no se escribe: terminada, arrancando o con un diálogo
/// o la confianza en la pantalla.
fn comprobar(ctx: Contexto) -> Result<(), String> {
    if ctx.status == SessionStatus::Exited {
        return Err("la sesión terminó".into());
    }
    if matches!(ctx.screen, ScreenState::Dialog | ScreenState::Trust) {
        return Err("La TUI tiene un diálogo abierto: no se escribe".into());
    }
    if ctx.status == SessionStatus::Starting {
        return Err("Claude aún está arrancando: no hay turno que interrumpir".into());
    }
    Ok(())
}

/// §3.4: encola delante, interrumpe y envía solo ese elemento.
pub fn interrumpir_y_enviar(
    e: &dyn EntornoForzar,
    input: QueueItemInput,
) -> Result<InterruptSendOutcome, String> {
    comprobar(e.contexto())?;
    let (id, client_id) = (e.id(), input.client_id.clone());
    let item = e.colas().encolar_delante(id, input, e.ahora())?;
    if item.state != QueueState::Queued {
        // Reintento del mismo `clientId` ya enviado o absorbido: no se
        // interrumpe otra vez. Un `failed` no llega aquí: `encolar_delante`
        // lo devuelve a `queued` y se envía de nuevo.
        return Ok(InterruptSendOutcome {
            interrupted: false,
            sent: true,
            steps: vec!["yaEnviado".into()],
            item,
        });
    }
    let estaba_ocupada = ocupada(e.contexto());
    let mut steps = vec!["encoladoDelante".to_string()];
    if estaba_ocupada {
        if !parar_turno(e, &mut steps) {
            if e.cola_en_pausa() {
                steps.push(COLA_PAUSADA.into());
            }
            return Ok(InterruptSendOutcome {
                interrupted: false,
                sent: false,
                steps,
                item: e.colas().elemento(id, &client_id)?,
            });
        }
        esperar_estado_libre(e, &mut steps);
    } else {
        steps.push("sinTurno".into());
    }
    enviar_el_primero(e, &client_id, estaba_ocupada, steps)
}

/// Interrumpe; con otra interrupción en curso, espera a que acabe y vale si
/// paró el turno. true si el turno está parado.
fn parar_turno(e: &dyn EntornoForzar, steps: &mut Vec<String>) -> bool {
    let r = e.interrumpir();
    let otra = !r.ok && r.steps.iter().any(|s| s == EN_CURSO);
    steps.extend(r.steps);
    if !otra {
        return r.ok;
    }
    let paro = e.esperar_otra_interrupcion();
    steps.push(if paro { "otraParo" } else { "otraNoParo" }.into());
    paro
}

/// Tras parar, la máquina puede seguir un tick en `working`/`waiting` y
/// `enviar_ya` rechaza `waiting`: se espera como mucho `ESPERA_ESTADO`.
fn esperar_estado_libre(e: &dyn EntornoForzar, steps: &mut Vec<String>) {
    let mut t = Duration::ZERO;
    while ocupada(e.contexto()) {
        if t >= ESPERA_ESTADO {
            steps.push("estadoSinCambiar".into());
            return;
        }
        e.dormir(PASO);
        t += PASO;
    }
}

fn enviar_el_primero(
    e: &dyn EntornoForzar,
    client_id: &str,
    interrupted: bool,
    mut steps: Vec<String>,
) -> Result<InterruptSendOutcome, String> {
    let id = e.id();
    let w = e.escritor();
    e.colas()
        .enviar_ya(id, Some(client_id), e.contexto(), &*w, e.ahora())
        .map_err(|err| format!("{err}: el mensaje sigue en la cola"))?;
    let item = e.colas().elemento(id, client_id)?;
    let sent = item.state != QueueState::Queued;
    steps.push(if sent { "enviado" } else { "sigueEnCola" }.to_string());
    Ok(InterruptSendOutcome {
        interrupted,
        sent,
        steps,
        item,
    })
}

// ---------------------------------------------------------------------------
// Entorno real de una sesión
// ---------------------------------------------------------------------------

struct EntornoSesion {
    id: String,
}

impl EntornoForzar for EntornoSesion {
    fn id(&self) -> &str {
        &self.id
    }
    fn colas(&self) -> &Colas {
        cola::global()
    }
    fn contexto(&self) -> Contexto {
        super::registro::contexto(&self.id)
    }
    fn escritor(&self) -> Arc<dyn Escritor> {
        cola::escritor()
    }
    fn interrumpir(&self) -> Resultado {
        interrumpir_con_reserva(&self.id)
    }
    fn ahora(&self) -> Ms {
        super::buzon::ahora_ms()
    }
    fn dormir(&self, d: Duration) {
        std::thread::sleep(d);
    }
    fn esperar_otra_interrupcion(&self) -> bool {
        let clave = recuperacion::clave_reserva(&self.id, RecoverAction::Interrupt);
        let t0 = Instant::now();
        while recuperacion::en_curso(&clave) && t0.elapsed() < ESPERA_OTRA {
            std::thread::sleep(PASO);
        }
        !recuperacion::en_curso(&clave)
            && recuperacion::EntornoSesion::nuevo(&self.id)
                .is_ok_and(|env| recuperacion::fuera_de_busy(&env))
    }
    fn cola_en_pausa(&self) -> bool {
        super::registro::estado(&self.id).is_some_and(|e| e.pausa_drenaje)
    }
}

/// La misma reserva que `sesiones_recover` con `interrupt`: un Esc del
/// composer y este botón no interrumpen a la vez. Semántica de una reserva
/// ocupada en `SiReservada::ComprobarPantalla`.
fn interrumpir_con_reserva(id: &str) -> Resultado {
    match recuperacion::EntornoSesion::nuevo(id) {
        Ok(env) => recuperacion::accion_reservada(
            &env,
            &recuperacion::clave_reserva(id, RecoverAction::Interrupt),
            SiReservada::ComprobarPantalla,
            recuperacion::interrumpir,
        ),
        Err(e) => Resultado {
            ok: false,
            steps: vec![format!("interrumpir: {e}")],
        },
    }
}

/// `sesiones_interrupt_send` (§3.4).
pub fn interrupt_send(id: &str, input: QueueItemInput) -> Result<InterruptSendOutcome, String> {
    if !super::registro::exists(id) {
        return Err(format!("no existe la sesión '{id}'"));
    }
    let r = interrumpir_y_enviar(&EntornoSesion { id: id.to_string() }, input);
    match &r {
        Ok(o) => tracing::info!(
            sesion = id,
            interrumpido = o.interrupted,
            enviado = o.sent,
            steps = ?o.steps,
            "interrumpir y enviar"
        ),
        Err(e) => tracing::info!(sesion = id, error = %e, "interrumpir y enviar rechazado"),
    }
    r
}

#[cfg(test)]
#[path = "tests_forzar.rs"]
mod tests;
