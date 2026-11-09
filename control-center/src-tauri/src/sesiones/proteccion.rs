// sesiones/proteccion.rs — Protecciones de las sesiones abiertas ante la
// salida de la app.
//
// Salir de ULTRON (bandeja → Quit o `close_control_center`) mata el árbol de
// cada PTY en `RunEvent::Exit` y cancela los motores en curso: se corta el turno
// y un relevo a medias. La cola se guarda y se repone al volver, pero sale con
// la sesión restaurada. Cerrar la ventana de Sessions no mata nada (los PTY
// viven en el backend), así que no necesita aviso.
//
// Con alguna sesión trabajando, esperando respuesta, con envíos en cola o con
// un motor en curso, la
// primera petición de salida se retiene: se abre la ventana de Sessions y
// cada sesión ocupada recibe una nota (`sesiones://notice`) con lo que se
// perdería. Una segunda petición dentro de `VENTANA_CONFIRMACION` sale. El
// aviso no bloquea nada: si la ventana no puede mostrarse, la segunda
// petición sigue cerrando la app.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;

use super::types::{ev, SessionInfo, SessionStatus};
use super::{cola, motor, registro, ventana};
use crate::pty::types::bloquear;

/// Plazo para confirmar la salida con una segunda petición.
pub const VENTANA_CONFIRMACION: Duration = Duration::from_secs(15);

/// Sesión con trabajo que la salida perdería.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SesionOcupada {
    pub id: String,
    pub title: String,
    /// Turno en curso (`working`) o esperando una respuesta (`waiting`).
    pub working: bool,
    /// Envíos `queued` de la cola de ULTRON.
    pub queued: bool,
    /// Tarea de motor en curso (relevo incluido): salir la cancela.
    pub engines: bool,
}

/// Recuento de `sesiones_busy`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ocupadas {
    /// Sesiones con un turno en curso o esperando respuesta.
    pub working: usize,
    /// Sesiones con envíos en cola.
    pub queued: usize,
    /// Sesiones con una tarea de motor en curso.
    pub engines: usize,
    pub sessions: Vec<SesionOcupada>,
}

impl Ocupadas {
    pub fn vacia(&self) -> bool {
        self.sessions.is_empty()
    }
}

/// Sesiones cuya salida pierde trabajo. `en_cola` dice si una sesión tiene
/// envíos `queued` (inyectable en los tests). Una sesión terminada conserva
/// su cola (Reiniciar la envía), así que también cuenta. `con_motor` dice si
/// tiene una tarea de motor en curso.
pub fn contar(
    sesiones: &[SessionInfo],
    en_cola: impl Fn(&str) -> bool,
    con_motor: impl Fn(&str) -> bool,
) -> Ocupadas {
    let mut out = Ocupadas::default();
    for s in sesiones {
        let working = matches!(s.status, SessionStatus::Working | SessionStatus::Waiting);
        let queued = en_cola(&s.id);
        let engines = con_motor(&s.id);
        if !working && !queued && !engines {
            continue;
        }
        out.working += usize::from(working);
        out.queued += usize::from(queued);
        out.engines += usize::from(engines);
        out.sessions.push(SesionOcupada {
            id: s.id.clone(),
            title: s.title.clone(),
            working,
            queued,
            engines,
        });
    }
    out
}

/// Sesiones ocupadas ahora mismo.
pub fn ocupadas() -> Ocupadas {
    let motores = motor::list(None);
    let mut sesiones = registro::list();
    sesiones.extend(super::motor_sesion::infos());
    contar(
        &sesiones,
        |id| cola::global().hay_en_cola(id),
        |id| {
            motores
                .iter()
                .any(|t| t.status == "running" && t.session_id.as_deref() == Some(id))
        },
    )
}

/// Qué hacer con una petición de salida.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Salida {
    Permitir,
    /// Retener la salida y avisar en las sesiones ocupadas.
    Avisar,
}

/// Decisión pura: sin sesiones ocupadas, o con un aviso previo dentro del
/// plazo, se sale; si no, se avisa.
pub fn decidir(ocupadas: &Ocupadas, ultimo_aviso: Option<Instant>, ahora: Instant) -> Salida {
    if ocupadas.vacia() {
        return Salida::Permitir;
    }
    let confirmada =
        ultimo_aviso.is_some_and(|t| ahora.saturating_duration_since(t) <= VENTANA_CONFIRMACION);
    if confirmada {
        Salida::Permitir
    } else {
        Salida::Avisar
    }
}

/// Texto de la nota para una sesión ocupada.
pub fn texto_aviso(s: &SesionOcupada) -> String {
    let mut partes = Vec::new();
    if s.working {
        partes.push("salir corta el turno en curso");
    }
    if s.engines {
        partes.push("salir cancela el motor en curso");
    }
    if s.queued {
        partes.push("los envíos en cola se guardan y salen al volver a abrir ULTRON");
    }
    format!(
        "ULTRON iba a cerrarse con trabajo en esta sesión: {}. Para salir igualmente, \
         vuelve a pulsar Salir antes de {} s.",
        partes.join("; "),
        VENTANA_CONFIRMACION.as_secs()
    )
}

fn ultimo_aviso() -> &'static Mutex<Option<Instant>> {
    static M: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(None))
}

/// `RunEvent::ExitRequested`: true si la app puede salir. Si no, deja el
/// aviso en las sesiones ocupadas y abre la ventana de Sessions.
pub fn permitir_salida(app: &AppHandle) -> bool {
    let o = ocupadas();
    let ahora = Instant::now();
    let mut aviso = bloquear(ultimo_aviso());
    if decidir(&o, *aviso, ahora) == Salida::Permitir {
        return true;
    }
    *aviso = Some(ahora);
    drop(aviso);
    tracing::warn!(
        working = o.working,
        queued = o.queued,
        "salida retenida: hay sesiones con trabajo en curso"
    );
    let app = app.clone();
    // Crear o enfocar la ventana desde el bucle de eventos puede bloquear: en
    // otro hilo.
    let r = std::thread::Builder::new()
        .name("sesiones-aviso-salida".into())
        .spawn(move || avisar(&app, &o));
    if let Err(e) = r {
        tracing::warn!(error = %e, "no se pudo avisar de la salida retenida");
    }
    false
}

fn avisar(app: &AppHandle, o: &Ocupadas) {
    if let Err(e) = ventana::open(app, None) {
        tracing::warn!(error = %e, "no se pudo abrir Sessions para el aviso de salida");
    }
    for s in &o.sessions {
        registro::emit(
            ev::NOTICE,
            json!({ "id": s.id, "level": "warn", "text": texto_aviso(s) }),
        );
    }
}

/// `sesiones_busy`: cuántas sesiones perderían trabajo si se cerraran ahora.
#[tauri::command]
pub async fn sesiones_busy() -> Result<Ocupadas, String> {
    Ok(ocupadas())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sesiones::types::PermissionMode;

    fn sesion(id: &str, status: SessionStatus) -> SessionInfo {
        SessionInfo {
            project_name: "p".into(),
            title: format!("t-{id}"),
            status,
            ..SessionInfo::nueva(id, "/p", PermissionMode::Default)
        }
    }

    #[test]
    fn cuenta_turnos_en_curso_esperas_y_colas() {
        let s = [
            sesion("a", SessionStatus::Working),
            sesion("b", SessionStatus::Waiting),
            sesion("c", SessionStatus::Idle),
            sesion("d", SessionStatus::Exited),
            sesion("e", SessionStatus::Starting),
        ];
        let o = contar(&s, |id| id == "c" || id == "d" || id == "a", |_| false);
        assert_eq!(o.working, 2);
        assert_eq!(o.queued, 3);
        let ids: Vec<_> = o.sessions.iter().map(|x| x.id.as_str()).collect();
        assert_eq!(ids, ["a", "b", "c", "d"]);
        assert!(o.sessions[0].working && o.sessions[0].queued);
        assert_eq!(o.sessions[0].title, "t-a");
    }

    /// Caso negativo: sesiones libres sin cola no retienen la salida.
    #[test]
    fn sin_trabajo_la_salida_no_se_retiene() {
        let s = [
            sesion("a", SessionStatus::Idle),
            sesion("b", SessionStatus::Exited),
            sesion("c", SessionStatus::Starting),
        ];
        let o = contar(&s, |_| false, |_| false);
        assert!(o.vacia());
        assert_eq!(decidir(&o, None, Instant::now()), Salida::Permitir);
    }

    #[test]
    fn con_trabajo_avisa_y_la_segunda_peticion_en_plazo_sale() {
        let o = contar(&[sesion("a", SessionStatus::Working)], |_| false, |_| false);
        let t0 = Instant::now();
        assert_eq!(decidir(&o, None, t0), Salida::Avisar);
        let dentro = t0 + VENTANA_CONFIRMACION;
        assert_eq!(decidir(&o, Some(t0), dentro), Salida::Permitir);
        let fuera = t0 + VENTANA_CONFIRMACION + Duration::from_secs(1);
        assert_eq!(decidir(&o, Some(t0), fuera), Salida::Avisar);
    }

    #[test]
    fn el_aviso_dice_que_se_pierde() {
        let base = SesionOcupada {
            id: "a".into(),
            title: "t".into(),
            working: true,
            queued: false,
            engines: false,
        };
        assert!(texto_aviso(&base).contains("turno en curso"));
        assert!(!texto_aviso(&base).contains("motor"));
        let cola = SesionOcupada {
            working: false,
            queued: true,
            ..base
        };
        let t = texto_aviso(&cola);
        assert!(t.contains("envíos en cola") && t.contains("15 s"));
        assert!(t.contains("se guardan"), "la cola no se pierde: {t}");
        assert!(!t.contains("pierde"), "{t}");
    }

    /// Salir cancela un relevo en curso: con la sesión en reposo también avisa.
    #[test]
    fn un_motor_en_curso_retiene_la_salida_y_lo_dice() {
        let s = [
            sesion("a", SessionStatus::Idle),
            sesion("b", SessionStatus::Idle),
        ];
        let o = contar(&s, |_| false, |id| id == "a");
        assert_eq!(o.engines, 1);
        assert_eq!(o.sessions.len(), 1, "solo la del motor");
        assert_eq!(decidir(&o, None, Instant::now()), Salida::Avisar);
        assert!(texto_aviso(&o.sessions[0]).contains("cancela el motor"));
    }
}
