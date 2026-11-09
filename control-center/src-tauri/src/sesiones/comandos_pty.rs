// sesiones/comandos_pty.rs — Comandos Tauri del PTY de cada sesión
// (contrato de estabilidad, §7.1, columna «PTY»): crear, teclas, matar,
// terminal en superposición, recuperación, diálogos, modo de permisos y
// carpeta de logs.
//
// Todos los que hacen E/S de PTY o de proceso pasan por `blocking()`
// (`SC-08`): nunca bloquean el hilo de comandos de Tauri.
//
// Propiedad: WP-PTY.

use base64::Engine;
use tauri::AppHandle;

use super::comandos::blocking;
use super::pantalla;
use super::types::{
    KeyName, OpResult, PermissionMode, RecoverAction, RecoverOptions, RecoverOutcome, SessionInfo,
};
use super::{gestor, recuperacion, registro};

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sesiones_create(
    app: AppHandle,
    project_id: Option<String>,
    cwd: Option<String>,
    resume: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<PermissionMode>,
    fork_from: Option<String>,
) -> Result<SessionInfo, String> {
    let req = gestor::CreateRequest {
        project_id: project_id.filter(|p| !p.is_empty()),
        cwd: cwd.unwrap_or_default(),
        resume,
        model,
        effort,
        permission_mode,
        fork_from: fork_from.filter(|f| !f.is_empty()),
    };
    blocking(move || gestor::create(app, req)).await
}

/// Teclas de navegación (§3.2): `shiftTab | up | down | enter | tab`. Esc y
/// Ctrl+C solo salen por `sesiones_recover`.
#[tauri::command]
pub async fn sesiones_key(id: String, key: KeyName) -> Result<(), String> {
    blocking(move || gestor::key(&id, key)).await
}

#[tauri::command]
pub async fn sesiones_kill(id: String) -> Result<(), String> {
    blocking(move || gestor::kill(&id)).await
}

/// Engancha la terminal en superposición: emisión en vivo, interceptación
/// del mod apagada (la cola consulta `pty::io::attached` para pausar el
/// drenaje).
#[tauri::command]
pub async fn sesiones_terminal_attach(id: String) -> Result<String, String> {
    blocking(move || {
        let bytes = crate::pty::io::attach(&registro::pty_id(&id)?)?;
        registro::cableado::terminal_adjunta(&id, true);
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
}

#[tauri::command]
pub async fn sesiones_terminal_detach(id: String) -> Result<(), String> {
    blocking(move || {
        crate::pty::io::detach(&registro::pty_id(&id)?)?;
        registro::cableado::terminal_adjunta(&id, false);
        Ok(())
    })
    .await
}

/// Redimensiona el PTY y su pantalla emulada. La TUI responde con un
/// repintado completo (`ESC[2J` + pantalla entera; captura
/// `fixtures/tui/mcp-resize.ans`), así que la vista del menú no depende de
/// la parte del búfer que se haya perdido.
#[tauri::command]
pub async fn sesiones_terminal_resize(id: String, cols: u16, rows: u16) -> Result<(), String> {
    blocking(move || redimensionar(&id, cols, rows)).await
}

/// Devuelve el PTY y su pantalla emulada al tamaño de lanzamiento
/// (`gestor::COLS` x `gestor::ROWS`) al cerrar el bloque de menú.
#[tauri::command]
pub async fn sesiones_terminal_restore_size(id: String) -> Result<(), String> {
    blocking(move || redimensionar(&id, gestor::COLS, gestor::ROWS)).await
}

fn redimensionar(id: &str, cols: u16, rows: u16) -> Result<(), String> {
    let pty = registro::pty_id(id)?;
    redimensionar_con(pantalla::monitor(id).as_deref(), cols, rows, |c, r| {
        crate::pty::io::resize(&pty, c, r)
    })
}

/// La pantalla emulada cambia de tamaño ANTES que el PTY: el repintado que
/// la TUI pinta para el tamaño nuevo puede llegar al lector en cuanto
/// ConPTY cambia, y procesado al tamaño viejo dejaba restos (`❯`, `↑/`) que
/// sobrevivían al cierre del menú. Si el PTY no cambia, la pantalla vuelve
/// al tamaño anterior. El lock del parser no se mantiene durante el resize
/// del PTY (el lector lo necesita para seguir alimentando); el turno de
/// redimensionado sí, para que dos llamadas no se pisen la vuelta atrás.
pub(crate) fn redimensionar_con(
    monitor: Option<&pantalla::Monitor>,
    cols: u16,
    rows: u16,
    resize_pty: impl FnOnce(u16, u16) -> Result<(), String>,
) -> Result<(), String> {
    crate::pty::io::validar_tamano(cols, rows)?;
    let _turno = monitor.map(pantalla::Monitor::turno_redimension);
    let previo = monitor.map(|m| (m, m.tamano()));
    if let Some((m, _)) = previo {
        m.redimensionar(rows, cols);
    }
    resize_pty(cols, rows).inspect_err(|_| {
        if let Some((m, (filas, columnas))) = previo {
            m.redimensionar(filas, columnas);
        }
    })
}

/// Suelta las terminales del bloque de menú que siguen enganchadas cuando
/// ninguna vista puede soltarlas: se cerró la última ventana de Sessions o
/// su página se recargó (el cleanup de React no corre). Sin esto, la cola de
/// esas sesiones quedaba en pausa para siempre y el PTY, al tamaño del menú.
pub(crate) fn soltar_terminales() {
    for id in registro::cableado::terminales_adjuntas() {
        let r = soltar_terminal_con(&id, |c, r| redimensionar(&id, c, r));
        if let Err(e) = r {
            tracing::warn!(sesion = %id, error = %e, "terminal del menú soltada con errores");
        }
    }
}

/// Devuelve el PTY al tamaño de lanzamiento y después suelta la emisión y
/// la pausa de la cola (el drenaje no empieza con el PTY aún pequeño). La
/// pausa se quita aunque el PTY ya no exista o no cambie de tamaño.
fn soltar_terminal_con(
    id: &str,
    restaurar: impl FnOnce(u16, u16) -> Result<(), String>,
) -> Result<(), String> {
    let restaurado = restaurar(gestor::COLS, gestor::ROWS);
    let soltado = registro::pty_id(id).and_then(|p| crate::pty::io::detach(&p));
    registro::cableado::terminal_adjunta(id, false);
    restaurado.and(soltado)
}

/// Interrumpir, salir del menú o reiniciar (§3.3). `opts` solo con `restart`.
#[tauri::command]
pub async fn sesiones_recover(
    app: AppHandle,
    id: String,
    action: RecoverAction,
    opts: Option<RecoverOptions>,
) -> Result<RecoverOutcome, String> {
    blocking(move || recuperacion::recover(app, &id, action, opts)).await
}

/// Respuesta a la confianza en la carpeta del arranque (§4.6).
#[tauri::command]
pub async fn sesiones_trust_answer(id: String, accept: bool) -> Result<(), String> {
    blocking(move || recuperacion::trust_answer(&id, accept)).await
}

/// Elige la opción `index` de un diálogo de la TUI verificando el cursor (§4.6).
#[tauri::command]
pub async fn sesiones_dialog_answer(id: String, index: u32) -> Result<(), String> {
    blocking(move || recuperacion::dialog_answer(&id, index)).await
}

/// Entrada de la terminal en superposición o del bloque de menú del chat
/// (exenta de G1-G3, §3.2).
#[tauri::command]
pub async fn sesiones_terminal_input(id: String, data: String) -> Result<(), String> {
    blocking(move || gestor::terminal_input(&id, &data)).await
}

/// Cambia el modo de permisos en caliente con Shift+Tab verificado (§2.5).
#[tauri::command]
pub async fn sesiones_set_permission_mode(
    id: String,
    mode: PermissionMode,
) -> Result<OpResult, String> {
    blocking(move || {
        if super::motor_sesion::existe(&id) {
            super::motor_sesion::set_permission_mode(&id, mode)
        } else {
            recuperacion::set_permission_mode(&id, mode)
        }
    })
    .await
}

/// Pantalla de la TUI de una sesión: clasificación y contenido, para pintar
/// en el chat el bloque de un menú abierto (cambio de diseño del contrato).
/// Carpeta de los logs de la app (§8.3 paso 7).
#[tauri::command]
pub async fn sesiones_log_dir() -> Result<String, String> {
    crate::logs_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .ok_or_else(|| "no hay carpeta de datos locales en este sistema".to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::sesiones::pantalla::Monitor;

    /// Caso negativo del orden: el PTY no puede cambiar antes que la
    /// pantalla emulada.
    #[test]
    fn la_pantalla_cambia_antes_que_el_pty() {
        let m = Monitor::nuevo(gestor::ROWS, gestor::COLS);
        let mut visto = None;
        redimensionar_con(Some(&m), 100, 20, |_, _| {
            visto = Some(m.tamano());
            Ok(())
        })
        .expect("resize");
        assert_eq!(
            visto,
            Some((20, 100)),
            "el PTY cambió con la pantalla vieja"
        );
        assert_eq!(m.tamano(), (20, 100));
    }

    #[test]
    fn si_el_pty_falla_la_pantalla_vuelve_al_tamano_anterior() {
        let m = Monitor::nuevo(gestor::ROWS, gestor::COLS);
        let e = redimensionar_con(Some(&m), 100, 20, |_, _| Err("conpty".into()));
        assert_eq!(e, Err("conpty".to_string()));
        assert_eq!(m.tamano(), (gestor::ROWS, gestor::COLS));
        let e = redimensionar_con(Some(&m), 0, 20, |_, _| Ok(()));
        assert!(e.is_err(), "tamaño nulo");
        assert_eq!(m.tamano(), (gestor::ROWS, gestor::COLS));
    }

    /// Tamaño leído con el turno de redimensionado: otro test que cierre la
    /// última ventana suelta todas las terminales y puede tener un
    /// redimensionado a medias (cambio y vuelta atrás) sobre esta pantalla.
    fn tamano_estable(m: &Monitor) -> (u16, u16) {
        let _turno = m.turno_redimension();
        m.tamano()
    }

    /// Serializa los tests que sueltan TODAS las terminales o vacían las
    /// vistas previas (cerrar la última ventana) con los que comprueban que
    /// siguen enganchadas: en paralelo, un cierre global ajeno soltaba la
    /// terminal de otro test a medias (fallo intermitente).
    pub(crate) fn cierre_global() -> std::sync::MutexGuard<'static, ()> {
        static CIERRE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        CIERRE.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sesión de prueba con PTY falso, pantalla emulada y la terminal del
    /// menú enganchada a 100x20.
    pub(crate) fn sesion_enganchada() -> (String, String, Arc<Monitor>) {
        let id = format!("pty-cmd-{}", uuid::Uuid::new_v4());
        let pty = format!("pty-{id}");
        let m = Arc::new(Monitor::nuevo(20, 100));
        pantalla::registrar(&id, m.clone());
        let fuente = m.clone();
        crate::pty::registry::insertar_prueba(
            &pty,
            Box::new(std::io::sink()),
            Arc::new(move || fuente.vista()),
        );
        let mut s = registro::sesion_de_prueba(&id);
        s.pty_id = pty.clone();
        registro::insert(s).expect("alta");
        crate::pty::io::attach(&pty).expect("attach");
        registro::cableado::terminal_adjunta(&id, true);
        (id, pty, m)
    }

    #[test]
    fn soltar_restaura_el_tamano_suelta_la_emision_y_quita_la_pausa() {
        let _cierre = cierre_global();
        let (id, pty, m) = sesion_enganchada();
        assert!(registro::contexto(&id).terminal);
        soltar_terminal_con(&id, |c, r| redimensionar_con(Some(&m), c, r, |_, _| Ok(())))
            .expect("soltar");
        assert!(!crate::pty::io::attached(&pty));
        assert!(!registro::contexto(&id).terminal, "la cola sigue en pausa");
        assert_eq!(tamano_estable(&m), (gestor::ROWS, gestor::COLS));
        gestor::kill(&id).expect("kill");
    }

    /// La pausa de la cola se quita aunque el PTY no se pueda redimensionar
    /// (el de prueba no tiene maestro, como uno que ya terminó).
    #[test]
    fn soltar_terminales_quita_la_pausa_aunque_el_pty_no_cambie() {
        let _cierre = cierre_global();
        let (id, pty, m) = sesion_enganchada();
        soltar_terminales();
        assert!(!crate::pty::io::attached(&pty));
        assert!(!registro::contexto(&id).terminal);
        assert_eq!(
            tamano_estable(&m),
            (20, 100),
            "sin resize del PTY, la pantalla no cambia"
        );
        gestor::kill(&id).expect("kill");
    }
}
