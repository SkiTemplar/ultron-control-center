// sesiones/segundo_plano.rs — «Segundo plano» (CONTRATO-v3, §3.4): pasa la
// herramienta del hilo principal en primer plano a segundo plano con Ctrl+B
// y lo verifica.
//
// La CLI enlaza `task:background` a Ctrl+B en el contexto `Task`, activo solo
// mientras hay una tarea en primer plano (pinta «ctrl+b to run in
// background»); en el transcript (Ctrl+O) Ctrl+B es pasar página. Por eso el
// escritor solo lo admite con la pantalla `busy` (G5) y aquí solo se manda
// con una herramienta abierta que se pueda mover. Spike del 2026-10-16
// (2.1.301, `docs/sesiones/spikes-pty.md`): la pista aparece unos 3 s después
// de que el comando arranque y un Ctrl+B anterior no hace nada, así que se
// espera a verla (como mucho `ESPERA_PISTA`) antes de mandarlo; si no sale,
// no se manda (2.1.306 la omite a veces y entonces Ctrl+B no hace nada, y
// `foregroundTool.backgroundable` ya la exige para ofrecer el botón). La prueba es
// que el puente cierre esa herramienta (`HerramientaFin`): la CLI le devuelve
// el `tool_result` «Command was manually backgrounded by user with ID: …» y
// el `tool.call` del mod termina. Si en ese plazo la herramienta termina
// sola, el cierre también cuenta (falso positivo benigno: la nota dice
// «terminó o pasó a segundo plano»).
//
// Los algoritmos trabajan contra el trait `EntornoSp` para probarlos sin PTY.
//
// Propiedad: WP-PTY.

use std::time::{Duration, Instant};

use super::maquina::{iso, EstadoSesion, Ms};
use super::pantalla::Clasificacion;
use super::recuperacion::{self, Reserva, PASO};
use super::types::{BackgroundEvidence, BackgroundOutcome, ForegroundTool};
use crate::pty::escritor::{ErrorEscritura, TeclaPty, Trabajo};

/// Espera máxima del cierre de la herramienta tras el Ctrl+B.
pub const ESPERA_CIERRE: Duration = Duration::from_secs(3);
/// Espera máxima de la pista «ctrl+b to run in background» antes de mandar
/// Ctrl+B (en el spike tardó unos 3 s desde que arrancó el comando).
pub const ESPERA_PISTA: Duration = Duration::from_secs(4);

/// Motivo de `ok: false` sin cierre de la herramienta.
pub const SIN_CONFIRMAR: &str = "Claude Code no confirmó el paso a segundo plano en 3 s";
/// Motivo de `ok: false` sin mandar nada: la TUI no ofrecía Ctrl+B.
pub const SIN_PISTA: &str =
    "Claude Code no lo ofrece ahora (la TUI no pinta «ctrl+b to run in background»)";

/// Paso único de `BackgroundOutcome` cuando otro Ctrl+B de la misma sesión
/// sigue en vuelo: no se escribe nada y no es un fallo.
pub const EN_CURSO: &str = "enCurso";
/// Paso único cuando el anterior terminó hace menos de 1,5 s (doble clic).
pub const ANTIRREBOTE: &str = "antirrebote";

/// Lo que el paso a segundo plano necesita de una sesión.
pub trait EntornoSp {
    /// Herramientas abiertas del hilo principal: (`toolUseId`, nombre, desde).
    fn herramientas(&self) -> Vec<(String, String, Ms)>;
    fn pantalla(&self) -> Clasificacion;
    fn escribir(&self, t: Trabajo) -> Result<(), ErrorEscritura>;
    fn dormir(&self, d: Duration);
}

/// Herramientas que Ctrl+B puede pasar a segundo plano.
pub fn movible(nombre: &str) -> bool {
    matches!(nombre, "Bash" | "PowerShell" | "Agent" | "Task") || nombre.starts_with("mcp__")
}

/// La más reciente de las abiertas (desempate estable por `toolUseId`).
fn mas_reciente(abiertas: Vec<(String, String, Ms)>) -> Option<(String, String, Ms)> {
    abiertas
        .into_iter()
        .max_by(|a, b| a.2.cmp(&b.2).then_with(|| a.0.cmp(&b.0)))
}

/// Herramienta sobre la que actúa Ctrl+B: con varias en paralelo, la más
/// reciente de las que se pueden mover (un `Read` posterior a un `Bash` no
/// tapa el `Bash`); sin ninguna movible, la más reciente, para informar de
/// que no se puede mover.
fn objetivo(abiertas: Vec<(String, String, Ms)>) -> Option<(String, String, Ms)> {
    let (movibles, resto): (Vec<_>, Vec<_>) = abiertas.into_iter().partition(|h| movible(&h.1));
    mas_reciente(movibles).or_else(|| mas_reciente(resto))
}

/// Herramienta en primer plano de la máquina (`SessionInfo.foregroundTool`).
/// `backgroundable` exige además la pista en pantalla: Claude Code 2.1.306 a
/// veces no la pinta para un Bash en curso y entonces tampoco atiende Ctrl+B
/// (incidente del 2026-10-21: cuatro intentos sin efecto y el usuario acabó
/// interrumpiendo). Un botón que no puede funcionar no se ofrece.
pub fn primer_plano(e: &EstadoSesion) -> Option<ForegroundTool> {
    let abiertas = e
        .herramientas
        .iter()
        .map(|(id, h)| (id.clone(), h.nombre.clone(), h.desde))
        .collect();
    objetivo(abiertas).map(|(tool_use_id, name, desde)| ForegroundTool {
        backgroundable: movible(&name) && e.pista_segundo_plano,
        tool_use_id,
        name,
        since: iso(desde),
    })
}

/// §3.4: Ctrl+B sobre la herramienta en primer plano y espera de su cierre.
/// Err sin escribir nada si no hay herramienta, si no se puede mover o si el
/// escritor rechaza la tecla (G5).
pub fn pasar_a_segundo_plano(e: &dyn EntornoSp) -> Result<BackgroundOutcome, String> {
    let (tool_use_id, tool, _) = objetivo(e.herramientas())
        .ok_or_else(|| "No hay ninguna herramienta en primer plano".to_string())?;
    if !movible(&tool) {
        return Err(format!("{tool} no se puede pasar a segundo plano"));
    }
    let abierta = |e: &dyn EntornoSp| e.herramientas().iter().any(|h| h.0 == tool_use_id);
    let pista = esperar(e, ESPERA_PISTA, |e| {
        e.pantalla().pista_segundo_plano || !abierta(e)
    }) && abierta(e);
    if !abierta(e) {
        // Terminó sola mientras se esperaba la pista: no se manda nada.
        return Ok(cerrada_sola(tool_use_id, tool));
    }
    if !pista {
        // Sin pista, Claude Code no atiende Ctrl+B: mandarlo solo retrasaba el
        // aviso y dejaba creer que se podía reintentar.
        return Ok(sin_pista(tool_use_id, tool));
    }
    let mut steps = vec!["pista".to_string()];
    e.escribir(Trabajo::Tecla(TeclaPty::SegundoPlano))
        .map_err(|err| err.to_string())?;
    steps.push("ctrlB".to_string());
    let cerrada = esperar(e, ESPERA_CIERRE, |e| !abierta(e));
    steps.push(if cerrada { "toolEnd" } else { "sinCierre" }.to_string());
    Ok(BackgroundOutcome {
        ok: cerrada,
        evidence: if cerrada {
            BackgroundEvidence::ToolEnd
        } else {
            BackgroundEvidence::None
        },
        reason: (!cerrada).then(|| SIN_CONFIRMAR.to_string()),
        tool_use_id,
        tool,
        steps,
    })
}

fn sin_pista(tool_use_id: String, tool: String) -> BackgroundOutcome {
    BackgroundOutcome {
        ok: false,
        evidence: BackgroundEvidence::None,
        reason: Some(format!("{SIN_PISTA}; Esc para interrumpir")),
        tool_use_id,
        tool,
        steps: vec!["sinPista".to_string()],
    }
}

fn cerrada_sola(tool_use_id: String, tool: String) -> BackgroundOutcome {
    BackgroundOutcome {
        ok: true,
        tool_use_id,
        tool,
        evidence: BackgroundEvidence::ToolEnd,
        steps: vec!["terminadaSinCtrlB".to_string()],
        reason: None,
    }
}

/// Sondea `pred` cada `PASO` hasta `max`; true si se cumplió.
fn esperar(e: &dyn EntornoSp, max: Duration, pred: impl Fn(&dyn EntornoSp) -> bool) -> bool {
    let mut t = Duration::ZERO;
    loop {
        if pred(e) {
            return true;
        }
        if t >= max {
            return false;
        }
        e.dormir(PASO);
        t += PASO;
    }
}

/// Un solo paso a segundo plano por sesión: la reserva de §3.3 con la clave
/// `<id>:Background`. Con otro en vuelo (tecla mantenida, doble clic, botón
/// y atajo a la vez) o recién terminado no se llama a `f`: devuelve
/// `ok: false` con el paso `enCurso` o `antirrebote` y sin motivo, porque el
/// que está en vuelo ya informa de su resultado.
pub fn con_reserva(
    id: &str,
    f: impl FnOnce() -> Result<BackgroundOutcome, String>,
) -> Result<BackgroundOutcome, String> {
    let clave = format!("{id}:Background");
    let paso = match recuperacion::reservar(&clave, Instant::now()) {
        Reserva::Libre => {
            let _liberar = recuperacion::Liberar(&clave);
            return f();
        }
        Reserva::EnCurso => EN_CURSO,
        Reserva::Antirrebote => ANTIRREBOTE,
    };
    Ok(BackgroundOutcome {
        ok: false,
        tool_use_id: String::new(),
        tool: String::new(),
        evidence: BackgroundEvidence::None,
        steps: vec![paso.to_string()],
        reason: None,
    })
}

// ---------------------------------------------------------------------------
// Entorno real de una sesión
// ---------------------------------------------------------------------------

/// `EntornoSp` sobre la sesión viva: máquina de estados, pantalla emulada y
/// escritor del PTY.
struct EntornoSesion {
    id: String,
    pty: String,
}

impl EntornoSp for EntornoSesion {
    fn herramientas(&self) -> Vec<(String, String, Ms)> {
        super::registro::estado(&self.id)
            .map(|e| {
                e.herramientas
                    .into_iter()
                    .map(|(id, h)| (id, h.nombre, h.desde))
                    .collect()
            })
            .unwrap_or_default()
    }
    fn pantalla(&self) -> Clasificacion {
        super::pantalla::actual(&self.id)
    }
    fn escribir(&self, t: Trabajo) -> Result<(), ErrorEscritura> {
        crate::pty::io::enviar(&self.pty, t)
    }
    fn dormir(&self, d: Duration) {
        std::thread::sleep(d);
    }
}

/// `sesiones_background` (§3.4).
pub fn background(id: &str) -> Result<BackgroundOutcome, String> {
    if !super::registro::exists(id) {
        return Err(format!("no existe la sesión '{id}'"));
    }
    let pty = super::registro::pty_id(id)?;
    if pty.is_empty() {
        return Err("la sesión aún no tiene PTY".to_string());
    }
    let r = con_reserva(id, || {
        pasar_a_segundo_plano(&EntornoSesion {
            id: id.to_string(),
            pty,
        })
    });
    match &r {
        Ok(o) => {
            tracing::info!(sesion = id, ok = o.ok, tool = %o.tool, steps = ?o.steps, "segundo plano")
        }
        Err(e) => tracing::info!(sesion = id, error = %e, "segundo plano rechazado"),
    }
    r
}

#[cfg(test)]
#[path = "tests_segundo_plano.rs"]
mod tests;
