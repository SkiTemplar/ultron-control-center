//! Descubrimiento y propiedad del daemon: `~/.ultron/run/orchestrate.json`.
//!
//! Aquí vive todo lo que decide QUIÉN es el daemon vivo: el claim atómico que
//! resuelve la carrera de arranque antes de pagar el warmup de E5, el ping de
//! comprobación por loopback y la retirada del lockfile solo por su dueño.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use serde_json::{json, Value};

/// Un claim de lockfile mas joven que esto pertenece a un ganador que AUN esta
/// calentando E5 (medido: warmup cold 1.8-4.8s): los perdedores salen sin
/// pingear. Mas viejo sin daemon que responda = claim huerfano (crash) y se retira.
const CLAIM_FRESH: Duration = Duration::from_secs(60);

/// `~/.ultron/run/orchestrate.json` — the discovery lockfile.
pub(super) fn lockfile_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ultron")
        .join("run")
        .join("orchestrate.json")
}

pub(super) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Non-crypto token: splitmix64 over (nanos ^ pid). Enough to stop an unrelated
/// local process from accidentally driving the daemon; loopback is the real wall.
pub(super) fn gen_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let mut seed = nanos ^ ((std::process::id() as u64).wrapping_shl(17));
    let next = |s: &mut u64| -> u64 {
        *s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *s;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    };
    format!("{:016x}{:016x}", next(&mut seed), next(&mut seed))
}

/// Best-effort: does a daemon described by `daemon` (parsed lockfile) answer ping?
pub(super) fn ping_existing(port: u16, token: &str) -> bool {
    let addr = (Ipv4Addr::LOCALHOST, port);
    let Ok(mut stream) = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(addr),
        Duration::from_millis(500),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(800)));
    let req = json!({ "token": token, "cmd": "ping" }).to_string();
    if writeln!(stream, "{req}").is_err() {
        return false;
    }
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return false;
    }
    serde_json::from_str::<Value>(&line)
        .ok()
        .and_then(|v| v.get("ok").and_then(Value::as_bool))
        .unwrap_or(false)
}

/// Read the lockfile -> (port, token) if present and well-formed.
pub(super) fn read_lockfile() -> Option<(u16, String)> {
    let raw = std::fs::read_to_string(lockfile_path()).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let port = v.get("port").and_then(Value::as_u64)? as u16;
    let token = v.get("token").and_then(Value::as_str)?.to_string();
    Some((port, token))
}

/// Claim ATOMICO del lockfile via `create_new` — exactamente UN `serve` gana
/// ANTES de pagar el warmup E5 (~1.5GB, segundos). Antes la carrera se detectaba
/// DESPUES del warmup: dos SessionStart paralelos calentaban E5 a la vez y el
/// perdedor quedaba residente hasta la ventana de inactividad (audit 2026-07-22).
/// El perdedor sale AQUI mismo (`Ok(false)` -> `already_running`), sin esperar a
/// ningun watchdog: por eso el default residente no deja daemons rivales vivos.
///
/// El body del claim NO lleva `port`: los clientes (que exigen port+token) caen
/// al fallback one-shot mientras el ganador calienta, y otros `serve` ven el
/// claim y salen. Si el archivo ya existe:
///   - edad < CLAIM_FRESH -> el ganador aun calienta (sin listener util): salir
///     SIN pingear.
///   - edad >= CLAIM_FRESH -> ping; vivo = already_running; muerto = claim
///     huerfano (crash en warmup): se retira y se reintenta UNA vez.
pub(super) fn claim_lockfile(own_token: &str) -> Result<bool, String> {
    let lock = lockfile_path();
    if let Some(parent) = lock.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create run dir: {e}"))?;
    }
    for attempt in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock)
        {
            Ok(mut f) => {
                let body = json!({
                    "pid": std::process::id(),
                    "token": own_token,
                    "started_at": now_ms(),
                    "schema": "orchestrate-daemon.v1",
                    "warming": true,
                });
                f.write_all(serde_json::to_string(&body).unwrap_or_default().as_bytes())
                    .map_err(|e| format!("write lockfile claim: {e}"))?;
                return Ok(true);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                let age = std::fs::metadata(&lock)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| SystemTime::now().duration_since(t).ok())
                    // mtime ilegible (p.ej. borrado en este hueco): tratar como
                    // viejo para caer al ping + retiro del huerfano.
                    .unwrap_or(Duration::MAX);
                if age < CLAIM_FRESH {
                    return Ok(false);
                }
                if let Some((port, token)) = read_lockfile() {
                    if ping_existing(port, &token) {
                        return Ok(false);
                    }
                }
                if attempt == 0 {
                    let _ = std::fs::remove_file(&lock);
                }
            }
            Err(e) => return Err(format!("claim lockfile: {e}")),
        }
    }
    Ok(false)
}

/// Borra el lockfile SOLO si su token es el nuestro. Un daemon que perdió la
/// carrera de arranque (o su watchdog tardío) no puede tumbar el descubrimiento
/// del daemon vivo borrando un lockfile ajeno (audit 2026-07-20, cat1).
pub(super) fn remove_lockfile_if_owned(own_token: &str) {
    if let Some((_, token)) = read_lockfile() {
        if token == own_token {
            let _ = std::fs::remove_file(lockfile_path());
        }
    }
}

/// `serve-ping` subcommand: report whether a live daemon is reachable.
pub fn ping_status() -> Value {
    match read_lockfile() {
        Some((port, token)) => {
            let alive = ping_existing(port, &token);
            json!({ "alive": alive, "port": port, "lockfile": lockfile_path().to_string_lossy() })
        }
        None => json!({ "alive": false, "lockfile": lockfile_path().to_string_lossy() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_thirtytwo_hex_chars() {
        let t = gen_token();
        assert_eq!(t.len(), 32, "token must be 32 hex chars");
        assert!(
            t.chars().all(|c| c.is_ascii_hexdigit()),
            "token must be hex"
        );
    }
}
