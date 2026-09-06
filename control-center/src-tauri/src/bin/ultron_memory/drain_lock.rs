//! drain_lock.rs — single-flight de `inbox drain --auto` (2026-09-03).
//!
//! El Stop hook lanza un drain por turno y por sesión abierta; con cinco
//! sesiones vivas se solapaban, cada uno con su lista pending rancia, y
//! re-aprobaban los mismos candidatos (206 filas activas duplicadas). El
//! guard de estado en `MemoryService` cierra la duplicación; este lock evita
//! además pagar N re-verificaciones (juez + dedup con E5) por lote.
//!
//! Lock = fichero creado con `create_new` (atómico en NTFS y POSIX) con
//! `{pid, started_at}`. Se libera al soltar el guard (Drop). Un lock cuyo
//! `started_at` supere `STALE_AFTER` se considera huérfano (drain que murió
//! sin limpiar) y se retira; no se comprueba el pid porque en Windows
//! requeriría abrir el proceso, y un drain sano nunca dura tanto.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Un drain real tarda segundos por candidato (juez + dedup); ayer el más largo
/// midió ~3 min. Muy por encima de eso el lock es un huérfano.
pub const STALE_AFTER: Duration = Duration::from_secs(15 * 60);

/// Guard RAII: el fichero se retira al soltarlo.
pub struct DrainLock {
    path: PathBuf,
}

impl Drop for DrainLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// `~/.ultron/.tmp/inbox-drain.lock` (mismo scratch que el resto de hooks).
pub fn default_path() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|h| h.join(".ultron").join(".tmp").join("inbox-drain.lock"))
        .ok_or_else(|| "no HOME dir".to_string())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `started_at` del lock existente, si el cuerpo es legible.
fn started_at_of(path: &Path) -> Option<u64> {
    let body = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    v.get("started_at").and_then(serde_json::Value::as_u64)
}

fn is_stale(path: &Path, stale_after: Duration) -> bool {
    match started_at_of(path) {
        Some(started) => now_ms().saturating_sub(started) > stale_after.as_millis() as u64,
        // Cuerpo ilegible (creado y aún sin escribir, o corrupto): se mira la
        // mtime; si tampoco, se trata como viejo para no bloquear para siempre.
        None => std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .map(|age| age > stale_after)
            .unwrap_or(true),
    }
}

/// Intenta tomar el lock. `Ok(None)` = otro drain vivo lo tiene (salir sin
/// trabajar). `Err` solo ante fallos de E/S que no sean "ya existe".
pub fn acquire(path: &Path, stale_after: Duration) -> Result<Option<DrainLock>, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create lock dir: {e}"))?;
    }
    for attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
        {
            Ok(mut f) => {
                let body = serde_json::json!({
                    "pid": std::process::id(),
                    "started_at": now_ms(),
                    "schema": "inbox-drain.v1",
                });
                f.write_all(body.to_string().as_bytes())
                    .map_err(|e| format!("write lock body: {e}"))?;
                return Ok(Some(DrainLock {
                    path: path.to_path_buf(),
                }));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if attempt == 0 && is_stale(path, stale_after) {
                    // Huérfano: se retira y se reintenta UNA vez. Si otro
                    // proceso gana la carrera del segundo intento, salimos.
                    let _ = std::fs::remove_file(path);
                    continue;
                }
                return Ok(None);
            }
            Err(e) => return Err(format!("open lock {}: {e}", path.display())),
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_lock_path(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "ultron-drain-lock-{}-{}-{}",
            tag,
            std::process::id(),
            now_ms()
        ));
        dir.join("inbox-drain.lock")
    }

    #[test]
    fn second_holder_is_refused_until_the_first_releases() {
        let path = temp_lock_path("second");
        let first = acquire(&path, STALE_AFTER).unwrap();
        assert!(first.is_some(), "primer drain toma el lock");
        assert!(
            acquire(&path, STALE_AFTER).unwrap().is_none(),
            "segundo drain sale"
        );
        drop(first);
        assert!(!path.exists(), "el guard retira el fichero al soltarse");
        assert!(acquire(&path, STALE_AFTER).unwrap().is_some());
    }

    #[test]
    fn a_stale_lock_is_taken_over() {
        let path = temp_lock_path("stale");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let hace_una_hora = now_ms() - 60 * 60 * 1000;
        std::fs::write(
            &path,
            format!("{{\"pid\":1,\"started_at\":{hace_una_hora}}}"),
        )
        .unwrap();
        let guard = acquire(&path, STALE_AFTER).unwrap();
        assert!(guard.is_some(), "un lock de hace una hora es huérfano");
        // El cuerpo ahora es el nuestro.
        assert_eq!(started_at_of(&path).map(|s| s > hace_una_hora), Some(true));
    }

    #[test]
    fn a_fresh_lock_with_unreadable_body_is_respected() {
        let path = temp_lock_path("fresh");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "garbage").unwrap();
        assert!(acquire(&path, STALE_AFTER).unwrap().is_none());
        let _ = std::fs::remove_file(&path);
    }
}
