//! Arranque del daemon y bucle de aceptación TCP.
//!
//! Aquí se junta todo lo demás: el claim del lockfile, el warmup de E5, los
//! hilos de fondo y el bucle que acepta conexiones de loopback y despacha cada
//! línea JSON al handler puro de `protocol`.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::concurrency::{orch_concurrency, Semaforo, ORCH_LOCK_WAIT};
use super::lockfile::{
    claim_lockfile, gen_token, lockfile_path, now_ms, ping_existing, read_lockfile,
    remove_lockfile_if_owned,
};
use super::protocol::{handle_request, Req};
use super::request_log::log_request;
use super::watchdog::{spawn_idle_watchdog, spawn_model_release_sweep};

/// Per-connection read timeout so a half-open socket can't pin a worker thread.
const READ_TIMEOUT: Duration = Duration::from_secs(8);
/// Cap a request line so a bogus client can't OOM the daemon.
const MAX_REQUEST_BYTES: u64 = 256 * 1024;

/// Run the orchestrator daemon. Blocks forever serving requests, OR returns
/// `Ok({already_running:true,...})` immediately if a live daemon is already up
/// (idempotent — safe to spawn on every SessionStart).
pub fn run_daemon() -> Result<Value, String> {
    // Este proceso ES el daemon: marcarlo antes de nada para que el cliente
    // (`daemon_client`) no se pregunte a si mismo y se cuelgue esperando su
    // propia respuesta.
    crate::daemon_client::mark_in_daemon();
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

    // Suelta los modelos que lleven su ventana sin usarse (ver watchdog.rs).
    spawn_model_release_sweep();

    // NO se calienta el CROSS-ENCODER aqui, a proposito (medido y decidido
    // 2026-08-14). `BGERerankerV2M3` es un modelo SEPARADO de E5 (`RERANKER`
    // OnceCell en qdrant.rs) y precalentarlo cuesta 1,5 GB residentes desde el
    // arranque — medido A/B: daemon 1501 MB sin el, 2962 MB con el, y hasta
    // 3579 MB con uso — que se pagan aunque la sesion sea pura charla y no
    // rerankee ni una vez. El problema que iba a resolver (el pico del primer
    // prompt tecnico venciendo el plazo del hook y descartando el prefetch
    // ENTERO) ya lo cierra el timeout del hook, subido de 12 s a 20 s el mismo
    // dia. Carga lazy en la primera peticion que lo necesite: se paga el pico
    // UNA vez por sesion y solo quien de verdad usa el rerank.

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

    // Guard de huerfano: solo mata al proceso si hay ventana configurada
    // (ver watchdog.rs). Con el default el daemon es residente.
    let last_activity = Arc::new(AtomicI64::new(now_ms()));
    spawn_idle_watchdog(Arc::clone(&last_activity), token.clone());

    // Un solo modelo residente sirviendo a varias sesiones a la vez (ver
    // ORCH_CONCURRENCY_DEFAULT). Sustituye al Mutex que serializaba TODO.
    let orch_sem = Arc::new(Semaforo::nuevo(orch_concurrency()));
    eprintln!(
        "ultron-memory serve: concurrencia de orchestrate = {}",
        orch_concurrency()
    );

    for incoming in listener.incoming() {
        let stream = match incoming {
            Ok(s) => s,
            Err(_) => continue,
        };
        let token = token.clone();
        let last = Arc::clone(&last_activity);
        let orch_sem = Arc::clone(&orch_sem);
        std::thread::spawn(move || {
            handle_conn(stream, &token, &last, &orch_sem, started);
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
    orch_sem: &Semaforo,
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
    // Traza por petición (2026-09-07): hasta hoy el daemon no dejaba rastro de
    // lo que servía, así que un prompt degradado ("orchestrate sin respuesta a
    // los 15 s") no se podía atribuir a nada — modelos fríos, semáforo lleno o
    // trabajo real. Se anota el estado de los modelos ANTES de servir.
    let t0 = Instant::now();
    let models_before = crate::qdrant::loaded_models();

    // Acota cuántas peticiones pesadas (orchestrate, skill_query y embed: las
    // tres embeben contra el E5 residente) se sirven a la vez; ping/shutdown
    // quedan libres. Espera ACOTADA (ORCH_LOCK_WAIT): sin hueco a tiempo se
    // responde "busy" y el hook espera al MISMO daemon — nunca cola infinita ni
    // proceso rival.
    let pesada = matches!(req.cmd.as_str(), "orchestrate" | "skill_query" | "embed");
    let (resp, shutdown) = if pesada {
        match orch_sem.adquirir(ORCH_LOCK_WAIT) {
            Some(_permiso) => handle_request(&req, token, started),
            None => (
                json!({
                    "error": "busy",
                    "detail": format!(
                        "sin hueco en {}ms con {} plazas — daemon saturado; el hook espera y degrada",
                        ORCH_LOCK_WAIT.as_millis(),
                        orch_concurrency()
                    ),
                }),
                false,
            ),
        }
    } else {
        handle_request(&req, token, started)
    };

    let _ = writeln!(writer, "{resp}");
    let _ = writer.flush();
    log_request(&req, &resp, t0.elapsed(), &models_before);
    if shutdown {
        remove_lockfile_if_owned(token);
        std::process::exit(0);
    }
}
