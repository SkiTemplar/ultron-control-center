//! Persistent localhost daemon for the memory orchestrator (`ultron-memory serve`).
//!
//! WHY: each `ultron-memory orchestrate` invocation is a fresh OS process, so the
//! global `E5_MODEL` `OnceCell` (multilingual-e5-large, ~1.3 GB ONNX) is re-loaded
//! from scratch on every prompt. Measured cost: orchestrate cold = 3.1–4.8 s, of
//! which ~1.8 s is just the model init. The UserPromptSubmit hook therefore pays
//! 3–5 s BEFORE every assistant turn — the #1 latency cost of the whole system.
//!
//! FIX: a long-lived process keeps that `OnceCell` resident. The hot path becomes
//! 3 warm embeds + 3 Qdrant loopback searches + FTS5/SQLite — sub-second. The
//! daemon changes NO semantics: SQLite connections and the Qdrant HTTP client are
//! still opened per request exactly as before; the only shared warm state is the
//! E5 model that already lived in a process-global `OnceCell`.
//!
//! TRANSPORT: line-delimited JSON over TCP on `127.0.0.1` (loopback only), zero new
//! dependencies (std::net + serde_json). A dynamic port (bind `:0`) + a per-launch
//! token are published in `~/.ultron/run/orchestrate.json`. The token is anti-
//! accident, NOT crypto: loopback is the real boundary (no remote can reach it).
//!
//! LIFECYCLE: started DETACHED from the SessionStart `memory-warmup` hook. Exits on
//! an explicit `shutdown` request or after `IDLE_TIMEOUT` with no traffic (so it
//! never lingers as an orphan). The client always `ping`s before trusting the
//! lockfile, so a stale lockfile (after a crash) degrades to the spawn fallback.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde::Deserialize;
use serde_json::{json, Value};

/// Exit after this long without a single request (orphan guard).
const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Un claim de lockfile mas joven que esto pertenece a un ganador que AUN esta
/// calentando E5 (medido: warmup cold 1.8-4.8s): los perdedores salen sin
/// pingear. Mas viejo sin daemon que responda = claim huerfano (crash) y se retira.
const CLAIM_FRESH: Duration = Duration::from_secs(60);
/// Per-connection read timeout so a half-open socket can't pin a worker thread.
const READ_TIMEOUT: Duration = Duration::from_secs(8);
/// Cap a request line so a bogus client can't OOM the daemon.
const MAX_REQUEST_BYTES: u64 = 256 * 1024;

/// One request line from a hook client.
#[derive(Debug, Deserialize)]
struct Req {
    /// Per-launch shared token (must match the lockfile's). Anti-accident only.
    token: Option<String>,
    /// "orchestrate" | "skill_query" | "ping" | "shutdown".
    cmd: String,
    /// Prompt to route / query (orchestrate + skill_query).
    prompt: Option<String>,
    /// Project slug for project-scoped recall (orchestrate only).
    project: Option<String>,
    /// Top-N semantic skill hits to return (skill_query only; default 5).
    top: Option<u32>,
}

/// `~/.ultron/run/orchestrate.json` — the discovery lockfile.
fn lockfile_path() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".ultron")
        .join("run")
        .join("orchestrate.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Non-crypto token: splitmix64 over (nanos ^ pid). Enough to stop an unrelated
/// local process from accidentally driving the daemon; loopback is the real wall.
fn gen_token() -> String {
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

/// Pure request handler — separated from socket I/O so it is hermetically
/// testable. Returns `(response_json, should_shutdown)`.
fn handle_request(req: &Req, expected_token: &str, started: Instant) -> (Value, bool) {
    if req.token.as_deref() != Some(expected_token) {
        return (json!({ "error": "unauthorized" }), false);
    }
    match req.cmd.as_str() {
        "ping" => (
            json!({
                "ok": true,
                "pid": std::process::id(),
                "uptime_ms": started.elapsed().as_millis() as u64,
            }),
            false,
        ),
        "shutdown" => (json!({ "ok": true, "shutting_down": true }), true),
        "skill_query" => {
            // Semantic skill match over `ultron_skills_lazy` (E5 1024d, incl.
            // `.disabled`). Warm in the daemon → sub-second, vs the ~10 s the
            // standalone embed_skills.py paid per process. This is what lets the
            // v3 dispatcher's semantic fallback run inside the hook budget.
            let prompt = req.prompt.as_deref().unwrap_or("");
            if prompt.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            let top = req.top.unwrap_or(5);
            let hits = crate::memory::catalog::search_skills_lazy(prompt, top);
            match serde_json::to_value(&hits) {
                Ok(v) => (v, false),
                Err(e) => (json!({ "error": format!("serialize: {e}") }), false),
            }
        }
        "orchestrate" => {
            let prompt = req.prompt.as_deref().unwrap_or("");
            if prompt.trim().is_empty() {
                return (json!({ "error": "empty prompt" }), false);
            }
            // UserPromptSubmit hot path: dense por politica (sparse-first vs
            // hibrido E5 ~1.1s warm) — ver hotpath_dense_enabled().
            let ctx = crate::orchestrator::orchestrate(
                prompt,
                req.project.as_deref(),
                hotpath_dense_enabled(),
            );
            match serde_json::to_value(&ctx) {
                Ok(v) => (v, false),
                Err(e) => (json!({ "error": format!("serialize: {e}") }), false),
            }
        }
        other => (json!({ "error": format!("unknown cmd '{other}'") }), false),
    }
}

/// Politica dense del request 'orchestrate' del daemon (fast-path, check 9.5).
/// dense=true = hibrido completo (E5 query embed ~1.1s warm por request);
/// dense=false = sparse-first (FTS5 + re-ranker, p50 ~134ms) — el presupuesto
/// <300ms del hook solo es alcanzable por este camino. Overrides en runtime:
/// ULTRON_HOTPATH_SPARSE=1 fuerza sparse, ULTRON_HOTPATH_DENSE=1 fuerza dense.
fn hotpath_dense_enabled() -> bool {
    if std::env::var("ULTRON_HOTPATH_DENSE").as_deref() == Ok("1") {
        return true;
    }
    if std::env::var("ULTRON_HOTPATH_SPARSE").as_deref() == Ok("1") {
        return false;
    }
    // Default DENSE, validado contra el oraculo golden (2026-07-22, 29 queries,
    // ambos paths sin rerank como el hook real): sparse-first p@3=0.092 /
    // recall@8=0.164 vs dense p@3=0.414 / recall@8=0.687. La degradacion
    // (-0.32 p@3) multiplica x6 el umbral aceptable (0.05): sparse-first puro
    // es inviable en este corpus; el <300ms del check 9.5 requiere un
    // fast-embedder real (BGE-small), no este atajo.
    true
}

/// Best-effort: does a daemon described by `daemon` (parsed lockfile) answer ping?
fn ping_existing(port: u16, token: &str) -> bool {
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
fn read_lockfile() -> Option<(u16, String)> {
    let raw = std::fs::read_to_string(lockfile_path()).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let port = v.get("port").and_then(Value::as_u64)? as u16;
    let token = v.get("token").and_then(Value::as_str)?.to_string();
    Some((port, token))
}

/// Claim ATOMICO del lockfile via `create_new` — exactamente UN `serve` gana
/// ANTES de pagar el warmup E5 (~1.5GB, segundos). Antes la carrera se detectaba
/// DESPUES del warmup: dos SessionStart paralelos calentaban E5 a la vez y el
/// perdedor quedaba residente hasta IDLE_TIMEOUT (audit 2026-07-22).
///
/// El body del claim NO lleva `port`: los clientes (que exigen port+token) caen
/// al fallback one-shot mientras el ganador calienta, y otros `serve` ven el
/// claim y salen. Si el archivo ya existe:
///   - edad < CLAIM_FRESH -> el ganador aun calienta (sin listener util): salir
///     SIN pingear.
///   - edad >= CLAIM_FRESH -> ping; vivo = already_running; muerto = claim
///     huerfano (crash en warmup): se retira y se reintenta UNA vez.
fn claim_lockfile(own_token: &str) -> Result<bool, String> {
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
fn remove_lockfile_if_owned(own_token: &str) {
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

/// Run the orchestrator daemon. Blocks forever serving requests, OR returns
/// `Ok({already_running:true,...})` immediately if a live daemon is already up
/// (idempotent — safe to spawn on every SessionStart).
pub fn run_daemon() -> Result<Value, String> {
    // Idempotency: if a healthy daemon already owns the lockfile, do nothing.
    if let Some((port, token)) = read_lockfile() {
        if ping_existing(port, &token) {
            return Ok(json!({ "already_running": true, "port": port }));
        }
    }

    let token = gen_token();
    let started = Instant::now();

    // Claim atomico ANTES del warmup: un solo proceso paga E5; los perdedores
    // salen aqui sin calentar nada (ver claim_lockfile).
    if !claim_lockfile(&token)? {
        return Ok(json!({ "already_running": true, "claimed_by_peer": true }));
    }

    // Bind loopback + dynamic port (the OS picks a free one).
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)) {
        Ok(l) => l,
        Err(e) => {
            remove_lockfile_if_owned(&token);
            return Err(format!("bind 127.0.0.1:0: {e}"));
        }
    };
    let port = match listener.local_addr() {
        Ok(a) => a.port(),
        Err(e) => {
            remove_lockfile_if_owned(&token);
            return Err(format!("local_addr: {e}"));
        }
    };

    // Warm E5 ONCE up front so the very first orchestrate request is already hot.
    let _ = crate::qdrant::embed_e5("warmup", true);

    // Idempotent: keep `ultron_skills_lazy` populated so the v3 semantic fallback
    // (skill_query) works after a Qdrant wipe / skill change without a manual
    // `reindex-skills-lazy`. Cheap (one probe search, then skip if populated).
    // Best-effort: a failure here must not stop the daemon from serving.
    match crate::memory::catalog::maybe_index_skills_lazy() {
        Ok((n, _)) if n > 0 => {
            eprintln!("ultron-memory serve: indexed {n} lazy skills into ultron_skills_lazy");
        }
        _ => {}
    }

    // Publish the FULL lockfile (claim + port). El claim atomico garantiza que
    // somos el unico dueño, asi que el overwrite plano es seguro; el re-check
    // post-warmup anterior (audit 2026-07-20, cat1) queda obsoleto porque la
    // carrera se decide ahora ANTES del warmup.
    let lock = lockfile_path();
    let body = json!({
        "port": port,
        "pid": std::process::id(),
        "token": token,
        "started_at": now_ms(),
        "schema": "orchestrate-daemon.v1",
    });
    if let Err(e) = std::fs::write(&lock, serde_json::to_string(&body).unwrap_or_default()) {
        remove_lockfile_if_owned(&token);
        return Err(format!("write lockfile: {e}"));
    }
    eprintln!(
        "ultron-memory serve: listening on 127.0.0.1:{port} (pid {})",
        std::process::id()
    );

    // Idle watchdog: exit if no request arrives within IDLE_TIMEOUT (orphan guard).
    let last_activity = Arc::new(AtomicI64::new(now_ms()));
    {
        let last = Arc::clone(&last_activity);
        let token_wd = token.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(60));
            if now_ms() - last.load(Ordering::Relaxed) > IDLE_TIMEOUT.as_millis() as i64 {
                remove_lockfile_if_owned(&token_wd);
                std::process::exit(0);
            }
        });
    }

    // Serialize orchestrate calls (prompts are sequential; this also sidesteps any
    // surprise about concurrent SQLite/ONNX use under load — KISS + safe).
    let orch_lock = Arc::new(Mutex::new(()));

    for incoming in listener.incoming() {
        let stream = match incoming {
            Ok(s) => s,
            Err(_) => continue,
        };
        let token = token.clone();
        let last = Arc::clone(&last_activity);
        let orch_lock = Arc::clone(&orch_lock);
        std::thread::spawn(move || {
            handle_conn(stream, &token, &last, &orch_lock, started);
        });
    }
    // `incoming()` only ends on a listener error; treat as clean shutdown.
    remove_lockfile_if_owned(&token);
    Ok(json!({ "stopped": true }))
}

fn handle_conn(
    stream: TcpStream,
    token: &str,
    last_activity: &AtomicI64,
    orch_lock: &Mutex<()>,
    started: Instant,
) {
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));
    let mut writer = match stream.try_clone() {
        Ok(w) => w,
        Err(_) => return,
    };
    let mut reader = BufReader::new(stream).take(MAX_REQUEST_BYTES);
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() || line.trim().is_empty() {
        return;
    }
    let req: Req = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(e) => {
            let _ = writeln!(
                writer,
                "{}",
                json!({ "error": format!("bad request: {e}") })
            );
            return;
        }
    };
    last_activity.store(now_ms(), Ordering::Relaxed);

    // Serialize the heavy E5 paths (orchestrate + skill_query both embed via the
    // process-global E5 OnceCell); ping/shutdown stay lock-free.
    let (resp, shutdown) = if req.cmd == "orchestrate" || req.cmd == "skill_query" {
        let _guard = orch_lock.lock().unwrap_or_else(|p| p.into_inner());
        handle_request(&req, token, started)
    } else {
        handle_request(&req, token, started)
    };

    let _ = writeln!(writer, "{resp}");
    let _ = writer.flush();
    if shutdown {
        remove_lockfile_if_owned(token);
        std::process::exit(0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(token: Option<&str>, cmd: &str) -> Req {
        Req {
            token: token.map(str::to_string),
            cmd: cmd.to_string(),
            prompt: None,
            project: None,
            top: None,
        }
    }

    #[test]
    fn ping_with_valid_token_returns_ok() {
        let (resp, shutdown) = handle_request(&req(Some("tok"), "ping"), "tok", Instant::now());
        assert_eq!(resp.get("ok").and_then(Value::as_bool), Some(true));
        assert!(!shutdown);
    }

    #[test]
    fn wrong_token_is_unauthorized() {
        let (resp, shutdown) = handle_request(&req(Some("nope"), "ping"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("unauthorized")
        );
        assert!(!shutdown);
    }

    #[test]
    fn missing_token_is_unauthorized() {
        let (resp, _) = handle_request(&req(None, "ping"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("unauthorized")
        );
    }

    #[test]
    fn unknown_cmd_is_rejected() {
        let (resp, shutdown) =
            handle_request(&req(Some("tok"), "frobnicate"), "tok", Instant::now());
        assert!(resp
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("")
            .contains("unknown cmd"));
        assert!(!shutdown);
    }

    #[test]
    fn shutdown_sets_flag() {
        let (resp, shutdown) = handle_request(&req(Some("tok"), "shutdown"), "tok", Instant::now());
        assert_eq!(resp.get("ok").and_then(Value::as_bool), Some(true));
        assert!(shutdown);
    }

    #[test]
    fn empty_prompt_orchestrate_errors_without_touching_e5() {
        // prompt is None -> handled before any embed; hermetic (no Qdrant/E5).
        let (resp, shutdown) =
            handle_request(&req(Some("tok"), "orchestrate"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("empty prompt")
        );
        assert!(!shutdown);
    }

    #[test]
    fn empty_prompt_skill_query_errors_without_touching_e5() {
        // prompt is None -> handled before any embed; hermetic (no Qdrant/E5).
        let (resp, shutdown) =
            handle_request(&req(Some("tok"), "skill_query"), "tok", Instant::now());
        assert_eq!(
            resp.get("error").and_then(Value::as_str),
            Some("empty prompt")
        );
        assert!(!shutdown);
    }

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
