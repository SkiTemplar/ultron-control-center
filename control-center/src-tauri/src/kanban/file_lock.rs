// kanban/file_lock.rs — lock de fichero entre procesos para kanban.json.
//
// `kanban.json` tiene tres escritores en procesos distintos: la app (este
// módulo), el hook `hooks/scripts/lib/kanban-auto.js` y el CLI
// `scripts/kanban.mjs`. El Mutex de `types_model::kanban_lock` solo serializa
// los hilos de la app; este lock serializa los procesos (auditoría 2026-10-26,
// L12).
//
// Protocolo, idéntico al de `hooks/scripts/lib/kanban-lock.js` (si se cambia
// uno, se cambia el otro):
//   - lock = `<kanban.json>.lock`, creado con `create_new` (O_EXCL); contenido
//     JSON `{pid, token, at}` para diagnóstico y para que solo su dueño lo borre;
//   - si existe: reintentos con backoff corto (5 ms doblando hasta 100 ms)
//     hasta `LOCK_TIMEOUT` (~2 s); después, error explícito;
//   - un lock con mtime de más de `LOCK_STALE` (10 s) es rancio (proceso
//     muerto): se rompe con aviso (`tracing::warn!`) y se reintenta. Romperlo
//     es renombrarlo a `<lock>.stale-<token>` (atómico) y, si lo renombrado
//     resulta reciente (otro proceso lo acababa de crear), devolverlo con un
//     hard link (`break_stale`);
//   - se libera en `Drop`.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const LOCK_TIMEOUT: Duration = Duration::from_millis(2000);
pub(crate) const LOCK_STALE: Duration = Duration::from_secs(10);
const BACKOFF_START: Duration = Duration::from_millis(5);
const BACKOFF_MAX: Duration = Duration::from_millis(100);

/// Lock de fichero adquirido; se libera al soltarse.
#[derive(Debug)]
pub(crate) struct BoardFileLock {
    path: PathBuf,
    token: String,
}

/// Ruta del lock de un tablero: `<kanban.json>.lock`.
pub(crate) fn lock_path_for(board_file: &Path) -> PathBuf {
    let mut os = board_file.as_os_str().to_os_string();
    os.push(".lock");
    PathBuf::from(os)
}

fn new_token() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("rs-{}-{nanos:x}-{n}", std::process::id())
}

/// Resultado de un intento de crear el lock.
enum Attempt {
    Acquired,
    /// Ya existe (`AlreadyExists`) o Windows lo tiene en borrado pendiente
    /// (`PermissionDenied`: otro proceso acaba de liberarlo y aún hay un handle
    /// abierto). Ambos son contención: se reintenta.
    Busy(Option<String>),
}

fn try_create(path: &Path, token: &str) -> Result<Attempt, String> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut f) => {
            let body = serde_json::json!({
                "pid": std::process::id(),
                "token": token,
                "at": super::board_io::now_iso(),
            });
            // El contenido es solo diagnóstico y propiedad: si no se escribe, el
            // lock sigue siendo válido, pero Drop no podrá reconocerlo como suyo.
            f.write_all(body.to_string().as_bytes())
                .map_err(|e| format!("escribir {}: {e}", path.display()))?;
            Ok(Attempt::Acquired)
        }
        Err(e) if e.kind() == ErrorKind::AlreadyExists => Ok(Attempt::Busy(None)),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => Ok(Attempt::Busy(Some(e.to_string()))),
        Err(e) => Err(format!("crear {}: {e}", path.display())),
    }
}

/// Edad del lock según su mtime; `None` si ya no existe.
fn lock_age(path: &Path) -> Option<Duration> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(
        SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default(),
    )
}

/// Rompe un lock rancio sin pisar uno recién creado (revisión 2026-10-26, LOW).
///
/// Carrera que evita: A y B ven el mismo lock rancio; A lo borra y crea el suyo;
/// B, que ya había decidido que era rancio, borraba por ruta el lock NUEVO de A
/// y los dos entraban en la sección crítica. Ahora el lock se renombra a un
/// nombre único (atómico: solo un proceso se lleva cada fichero) y se mira la
/// edad de lo renombrado: si es reciente, era de otro proceso y se devuelve a
/// su sitio con un hard link, que no sobrescribe si ya hay otro lock.
///
/// Devuelve `Ok(true)` si conviene reintentar ya (roto, devuelto o ya no
/// existía) y `Ok(false)` si el SO lo tiene ocupado y hay que esperar.
fn break_stale(path: &Path, token: &str, stale: Duration) -> Result<bool, String> {
    let mut grave = path.as_os_str().to_os_string();
    grave.push(format!(".stale-{token}"));
    let grave = PathBuf::from(grave);
    match fs::rename(path, &grave) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(true),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => return Ok(false),
        Err(e) => return Err(format!("romper lock rancio {}: {e}", path.display())),
    }
    if lock_age(&grave).is_some_and(|age| age <= stale) {
        match fs::hard_link(&grave, path) {
            Ok(()) => {}
            // Un tercero ya creó otro lock: el reciente no se puede devolver.
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("devolver lock {}: {e}", path.display())),
        }
    }
    match fs::remove_file(&grave) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(true),
        Err(e) => Err(format!("borrar {}: {e}", grave.display())),
    }
}

impl BoardFileLock {
    /// Adquiere el lock de `board_file` con los plazos por defecto.
    pub(crate) fn acquire(board_file: &Path) -> Result<Self, String> {
        Self::acquire_with(board_file, LOCK_TIMEOUT, LOCK_STALE)
    }

    /// Adquiere el lock con plazos explícitos (los tests los acortan).
    pub(crate) fn acquire_with(
        board_file: &Path,
        timeout: Duration,
        stale: Duration,
    ) -> Result<Self, String> {
        if let Some(parent) = board_file.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
        }
        let path = lock_path_for(board_file);
        let token = new_token();
        let deadline = Instant::now() + timeout;
        let mut backoff = BACKOFF_START;
        let mut last_denied: Option<String> = None;
        loop {
            match try_create(&path, &token)? {
                Attempt::Acquired => return Ok(Self { path, token }),
                Attempt::Busy(denied) => last_denied = denied.or(last_denied),
            }
            if let Some(age) = lock_age(&path) {
                if age > stale {
                    tracing::warn!(
                        "[kanban] lock rancio roto ({} s sin liberar, ¿proceso muerto?): {}",
                        age.as_secs(),
                        path.display()
                    );
                    if break_stale(&path, &token, stale)? {
                        continue;
                    }
                }
            }
            let now = Instant::now();
            if now >= deadline {
                // Un PermissionDenied que dura todo el plazo no es contención sino
                // un permiso real: se dice en el error en vez de esconderlo.
                let detalle = last_denied
                    .map(|e| format!("; último error al crearlo: {e}"))
                    .unwrap_or_default();
                return Err(format!(
                    "kanban.json bloqueado por otro proceso durante {} ms ({}){detalle}",
                    timeout.as_millis(),
                    path.display()
                ));
            }
            std::thread::sleep(backoff.min(deadline - now));
            backoff = (backoff * 2).min(BACKOFF_MAX);
        }
    }

    /// `true` si el fichero de lock sigue llevando nuestro token.
    fn still_owned(&self) -> bool {
        fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| {
                v.get("token")
                    .and_then(|t| t.as_str())
                    .map(|t| t == self.token)
            })
            .unwrap_or(false)
    }
}

impl Drop for BoardFileLock {
    fn drop(&mut self) {
        // Solo el dueño lo borra: si otro proceso lo rompió por rancio y creó el
        // suyo, borrarlo aquí dejaría su sección crítica sin protección.
        if !self.still_owned() {
            tracing::warn!(
                "[kanban] el lock {} ya no era nuestro al liberarlo (¿roto por rancio?)",
                self.path.display()
            );
            return;
        }
        if let Err(e) = fs::remove_file(&self.path) {
            tracing::warn!(
                "[kanban] no se pudo borrar el lock {}: {e}",
                self.path.display()
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn temp_board(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "kanban-file-lock-{}-{name}-{}",
            std::process::id(),
            new_token()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir.join("kanban.json")
    }

    #[test]
    fn adquiere_y_libera_el_lock() {
        let board = temp_board("basico");
        let lock_file = lock_path_for(&board);
        {
            let _g = BoardFileLock::acquire(&board).expect("lock libre");
            assert!(lock_file.exists(), "el .lock existe mientras se sostiene");
        }
        assert!(!lock_file.exists(), "Drop borra el .lock");
    }

    /// Caso negativo: un lock vivo de otro proceso agota la espera con error.
    #[test]
    fn lock_vivo_ajeno_agota_el_plazo_con_error() {
        let board = temp_board("vivo");
        let lock_file = lock_path_for(&board);
        fs::write(&lock_file, r#"{"pid":0,"token":"ajeno"}"#).unwrap();
        let t0 = Instant::now();
        let err = BoardFileLock::acquire_with(&board, Duration::from_millis(150), LOCK_STALE)
            .expect_err("no debe adquirir un lock vivo ajeno");
        assert!(err.contains("bloqueado"), "{err}");
        assert!(
            t0.elapsed() >= Duration::from_millis(140),
            "espera el plazo"
        );
        assert!(lock_file.exists(), "no borra el lock ajeno");
    }

    #[test]
    fn lock_rancio_se_rompe_y_se_adquiere() {
        let board = temp_board("rancio");
        let lock_file = lock_path_for(&board);
        let f = fs::File::create(&lock_file).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(20))
            .unwrap();
        drop(f);
        let g = BoardFileLock::acquire_with(&board, Duration::from_millis(200), LOCK_STALE)
            .expect("un lock de 20 s es rancio y se rompe");
        assert!(g.still_owned());
    }

    /// Caso negativo de la carrera al romper un rancio: cuando se va a romper,
    /// en la ruta ya hay un lock RECIENTE de otro proceso (que rompió el rancio
    /// antes). Romper por ruta lo borraba; ahora sigue en disco con su token.
    #[test]
    fn romper_rancio_no_borra_un_lock_recien_creado_por_otro() {
        let board = temp_board("carrera");
        let lock_file = lock_path_for(&board);
        fs::write(&lock_file, r#"{"pid":0,"token":"nuevo-de-a"}"#).unwrap();
        assert!(break_stale(&lock_file, "b", LOCK_STALE).unwrap());
        let raw = fs::read_to_string(&lock_file).expect("el lock reciente sigue en disco");
        assert!(raw.contains("nuevo-de-a"), "{raw}");
        let restos: Vec<_> = fs::read_dir(lock_file.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".stale-"))
            .collect();
        assert!(restos.is_empty(), "no quedan ficheros .stale-");
    }

    #[test]
    fn romper_rancio_borra_el_lock_viejo() {
        let board = temp_board("rancio-roto");
        let lock_file = lock_path_for(&board);
        let f = fs::File::create(&lock_file).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(20))
            .unwrap();
        drop(f);
        assert!(break_stale(&lock_file, "b", LOCK_STALE).unwrap());
        assert!(!lock_file.exists(), "el rancio se borra");
    }

    #[test]
    fn drop_no_borra_un_lock_que_ya_no_es_suyo() {
        let board = temp_board("ajeno");
        let lock_file = lock_path_for(&board);
        let g = BoardFileLock::acquire(&board).unwrap();
        fs::write(&lock_file, r#"{"pid":0,"token":"otro"}"#).unwrap();
        drop(g);
        assert!(lock_file.exists(), "el lock de otro dueño sigue en disco");
    }

    /// Leer-modificar-escribir concurrente desde varios hilos usando SOLO el
    /// lock de fichero (sin el Mutex del proceso): no se pierde ninguna
    /// actualización.
    #[test]
    fn rmw_concurrente_con_lock_no_pierde_actualizaciones() {
        let board = Arc::new(temp_board("rmw"));
        fs::write(board.as_path(), "0").unwrap();
        let hilos: Vec<_> = (0..4)
            .map(|_| {
                let board = Arc::clone(&board);
                std::thread::spawn(move || {
                    for _ in 0..5 {
                        let _g = BoardFileLock::acquire(&board).unwrap();
                        let n: u32 = fs::read_to_string(board.as_path())
                            .unwrap()
                            .parse()
                            .unwrap();
                        std::thread::sleep(Duration::from_millis(5));
                        fs::write(board.as_path(), (n + 1).to_string()).unwrap();
                    }
                })
            })
            .collect();
        for h in hilos {
            h.join().unwrap();
        }
        let total: u32 = fs::read_to_string(board.as_path())
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(total, 20);
    }
}
