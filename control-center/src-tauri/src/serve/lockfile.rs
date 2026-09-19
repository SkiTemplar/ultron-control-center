//! Descubrimiento y propiedad del daemon: `~/.ultron/run/orchestrate.json`.
//!
//! Aquí vive todo lo que decide QUIÉN es el daemon vivo: el claim atómico que
//! resuelve la carrera de arranque antes de pagar el warmup de E5, el ping de
//! comprobación por loopback y la retirada del lockfile solo por su dueño.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::path::{Path, PathBuf};
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
    read_lockfile_at(&lockfile_path())
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
///
/// El retiro del huerfano va serializado por un segundo candado
/// (`orchestrate.json.retire`, tambien `create_new`). Sin el, dos `serve`
/// simultaneos veian el mismo lockfile caducado, lo borraban los dos y el
/// segundo `remove_file` se llevaba el claim recien creado por el primero:
/// ambos ganaban y quedaban dos daemons residentes (medido 2026-09-16: dos
/// `serve` arrancados en el mismo segundo, puertos 55842 y 55855, +1,5 GB).
pub(super) fn claim_lockfile(own_token: &str) -> Result<bool, String> {
    claim_lockfile_at(&lockfile_path(), own_token, |port, token| {
        ping_existing(port, token)
    })
}

fn file_age(path: &Path) -> Duration {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        // mtime ilegible (p.ej. borrado en este hueco): tratar como viejo para
        // caer al ping + retiro del huerfano.
        .unwrap_or(Duration::MAX)
}

fn read_lockfile_at(path: &Path) -> Option<(u16, String)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let port = v.get("port").and_then(Value::as_u64)? as u16;
    let token = v.get("token").and_then(Value::as_str)?.to_string();
    Some((port, token))
}

fn try_create_claim(lock: &Path, own_token: &str) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock)?;
    let body = json!({
        "pid": std::process::id(),
        "token": own_token,
        "started_at": now_ms(),
        "schema": "orchestrate-daemon.v1",
        "warming": true,
    });
    f.write_all(serde_json::to_string(&body).unwrap_or_default().as_bytes())
}

/// `true` si el lockfile existente es un huerfano: claim viejo sin daemon que
/// responda al ping.
fn is_orphan(lock: &Path, is_alive: &impl Fn(u16, &str) -> bool) -> bool {
    if file_age(lock) < CLAIM_FRESH {
        return false;
    }
    match read_lockfile_at(lock) {
        Some((port, token)) => !is_alive(port, &token),
        None => true,
    }
}

pub(super) fn claim_lockfile_at(
    lock: &Path,
    own_token: &str,
    is_alive: impl Fn(u16, &str) -> bool,
) -> Result<bool, String> {
    if let Some(parent) = lock.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create run dir: {e}"))?;
    }
    match try_create_claim(lock, own_token) {
        Ok(()) => return Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("claim lockfile: {e}")),
    }
    if !is_orphan(lock, &is_alive) {
        return Ok(false);
    }

    // Un solo proceso retira el huerfano. Un candado de retiro viejo es de un
    // proceso que murio a mitad: se limpia y este intento sale; el siguiente
    // `serve` (o el siguiente SessionStart) lo reintenta desde cero.
    let retire = lock.with_extension("json.retire");
    if std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&retire)
        .is_err()
    {
        if file_age(&retire) >= CLAIM_FRESH {
            let _ = std::fs::remove_file(&retire);
        }
        return Ok(false);
    }
    // Con el candado en mano, re-comprobar: otro proceso pudo retirar y
    // reclamar justo antes de que lo cogieramos.
    let result = if is_orphan(lock, &is_alive) {
        let _ = std::fs::remove_file(lock);
        match try_create_claim(lock, own_token) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(format!("claim lockfile: {e}")),
        }
    } else {
        Ok(false)
    };
    let _ = std::fs::remove_file(&retire);
    result
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

    fn stale_lock(dir: &Path) -> PathBuf {
        let lock = dir.join("orchestrate.json");
        std::fs::write(&lock, r#"{"pid":1,"port":1,"token":"old"}"#).unwrap();
        let old = SystemTime::now() - Duration::from_secs(3600);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .unwrap()
            .set_modified(old)
            .unwrap();
        lock
    }

    fn token_of(lock: &Path) -> String {
        let v: Value = serde_json::from_str(&std::fs::read_to_string(lock).unwrap()).unwrap();
        v["token"].as_str().unwrap().to_string()
    }

    #[test]
    fn claim_con_lockfile_fresco_sale_sin_tocarlo() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("orchestrate.json");
        assert!(claim_lockfile_at(&lock, "a", |_, _| false).unwrap());
        assert!(!claim_lockfile_at(&lock, "b", |_, _| false).unwrap());
        assert_eq!(token_of(&lock), "a");
    }

    #[test]
    fn claim_huerfano_con_daemon_vivo_no_se_retira() {
        let dir = tempfile::tempdir().unwrap();
        let lock = stale_lock(dir.path());
        assert!(!claim_lockfile_at(&lock, "b", |_, _| true).unwrap());
        assert_eq!(token_of(&lock), "old");
    }

    #[test]
    fn claim_huerfano_se_retira_y_se_reclama() {
        let dir = tempfile::tempdir().unwrap();
        let lock = stale_lock(dir.path());
        assert!(claim_lockfile_at(&lock, "b", |_, _| false).unwrap());
        assert_eq!(token_of(&lock), "b");
        assert!(!lock.with_extension("json.retire").exists());
    }

    #[test]
    fn candado_de_retiro_ocupado_no_borra_el_lockfile() {
        let dir = tempfile::tempdir().unwrap();
        let lock = stale_lock(dir.path());
        std::fs::write(lock.with_extension("json.retire"), "").unwrap();
        assert!(!claim_lockfile_at(&lock, "b", |_, _| false).unwrap());
        assert_eq!(token_of(&lock), "old");
    }

    #[test]
    fn no_pisa_el_claim_de_un_rival_que_retiro_el_huerfano_antes() {
        // Regresion 2026-09-16, entrelazado forzado: este proceso ya ha visto
        // el lockfile caducado cuando un rival lo retira y escribe su claim.
        // Sin el re-chequeo bajo candado, el remove_file borraba ese claim
        // fresco y los dos procesos ganaban.
        let dir = tempfile::tempdir().unwrap();
        let lock = stale_lock(dir.path());
        let rival_done = std::cell::Cell::new(false);
        let won = claim_lockfile_at(&lock, "b", |_, _| {
            if !rival_done.replace(true) {
                std::fs::remove_file(&lock).unwrap();
                try_create_claim(&lock, "rival").unwrap();
            }
            false
        })
        .unwrap();
        assert!(!won, "dos ganadores sobre el mismo lockfile");
        assert_eq!(token_of(&lock), "rival");
    }

    #[test]
    fn carrera_de_hilos_sobre_huerfano_deja_un_solo_ganador() {
        // El stub de `is_alive` dice que el huerfano ("old") esta MUERTO y que
        // cualquier otro token esta VIVO. Eso es lo que pasa de verdad: en
        // cuanto un hilo reclama, su proceso existe y el lock deja de ser
        // huerfano para los demas.
        //
        // Antes el stub devolvia `false` para todo, asi que el lock recien
        // reclamado por el ganador parecia huerfano tambien y un segundo hilo
        // lo retiraba: el test daba "2 ganadores" y fallaba ~1 de cada 3
        // ejecuciones de la suite completa (solo bajo carga; en aislamiento
        // pasaba siempre). Era el stub, no la exclusion mutua — comprobado el
        // 2026-09-19 leyendo el camino del `.retire`.
        for _ in 0..20 {
            let dir = tempfile::tempdir().unwrap();
            let lock = stale_lock(dir.path());
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let handles: Vec<_> = (0..8)
                .map(|i| {
                    let lock = lock.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || {
                        barrier.wait();
                        claim_lockfile_at(&lock, &format!("t{i}"), |_, token| token != "old")
                            .unwrap()
                    })
                })
                .collect();
            let winners = handles
                .into_iter()
                .map(|h| h.join().unwrap())
                .filter(|won| *won)
                .count();
            assert!(winners <= 1, "{winners} ganadores sobre el mismo lockfile");
        }
    }
}
