// mcps/ping.rs — «Test» de un servidor MCP y chequeo de salud de todos.
//
// H15 (2026-10-17): el «Test» solo buscaba el servidor en
// `~/.claude/settings.json` («server not found in settings.json» para todos
// los reales, que viven en `~/.claude.json`), daba `ok` a los HTTP sin
// mandar ni una petición, lanzaba el comando sin `.cmd`, sin `env` y con
// ventana, y al matarlo dejaba huérfano al nieto (`npx` -> `node`). El
// «Run health check» llamaba a un script que también leía solo
// settings.json (mcp-health.json vacío desde julio). Ahora:
//
// - Misma unión de fuentes que el listado (`discovery::collect_all_sources`).
// - stdio: ejecutable resuelto con PATHEXT, `env` con `${VAR}` expandidas,
//   directorio del proyecto, sin ventana y dentro de un Job Object que se
//   lleva todo el árbol al terminar. `ok` solo con una respuesta JSON-RPC a
//   `initialize` (id 1) con `result`.
// - HTTP: `initialize` real por POST (o GET con `text/event-stream` si es
//   SSE) con tope de tiempo; `ok` solo con 2xx.
// - Servidores de `.mcp.json`: solo si están aprobados en Claude Code, sin
//   expandir `${VAR}` y con la allowlist de lanzadores (`mcps::confianza`).
//   Los no aprobados quedan como `unapproved` y no se ejecutan.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

use super::confianza::{validar_servidor_de_proyecto, Aprobaciones, Confianza};
use super::discovery::{collect_all_sources, list_mcps_inner, resolve_server, McpSource};
use super::types_io::{parse_settings, McpInfo, McpPingResult, McpServerCfg};

/// Tope del botón «Test». `npx` en frío tarda varios segundos.
const PING_TIMEOUT: Duration = Duration::from_secs(10);
/// Por encima de esto un servidor que responde cuenta como `degraded`.
const DEGRADED_AFTER_MS: u64 = 5_000;
/// Servidores que se prueban a la vez en el chequeo de salud.
const HEALTH_PARALLELISM: usize = 6;
/// Estado en mcp-health.json de un servidor de `.mcp.json` sin aprobar.
pub(super) const STATUS_UNAPPROVED: &str = "unapproved";

/// Qué haría un ping, decidido SOLO con la configuración. Va aparte del
/// `spawn` para poder fijarlo en un test sin arrancar ni un proceso.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum PlanPing {
    /// `disabled: true`: no se lanza NADA.
    Deshabilitado,
    /// HTTP/SSE: se contacta con la URL.
    Http,
    /// stdio sin `command`: no hay nada que lanzar.
    SinComando,
    /// stdio habilitado: se lanzaría este comando con estos argumentos.
    Lanzar(String, Vec<String>),
}

/// 2026-09-22 — defensa en profundidad: "deshabilitado" corta ANTES del
/// `spawn` y significa lo mismo aquí que en la configuración, venga la
/// llamada de donde venga.
pub(super) fn plan_de_ping(cfg: &McpServerCfg) -> PlanPing {
    if cfg.disabled {
        return PlanPing::Deshabilitado;
    }
    if is_http(cfg) {
        return PlanPing::Http;
    }
    match cfg.command.clone() {
        Some(command) => PlanPing::Lanzar(command, cfg.args.clone()),
        None => PlanPing::SinComando,
    }
}

fn is_http(cfg: &McpServerCfg) -> bool {
    cfg.url.is_some()
        || cfg
            .transport
            .as_deref()
            .map(|t| t.eq_ignore_ascii_case("http") || t.eq_ignore_ascii_case("sse"))
            .unwrap_or(false)
}

/// Resultado interno: `reachable` distingue «responde pero pide
/// autenticación» (degraded) de «no responde» (missing).
#[derive(Debug, Clone)]
pub(super) struct Probe {
    pub(super) result: McpPingResult,
    pub(super) reachable: bool,
    /// Servidor de proyecto sin aprobar: no se ha ejecutado nada.
    pub(super) sin_aprobar: bool,
}

impl Probe {
    fn fail(name: &str, latency_ms: Option<u64>, reachable: bool, error: String) -> Self {
        Self {
            result: McpPingResult {
                name: name.to_string(),
                ok: false,
                latency_ms,
                error: Some(error),
            },
            reachable,
            sin_aprobar: false,
        }
    }

    fn unapproved(name: &str) -> Self {
        Self {
            sin_aprobar: true,
            ..Self::fail(
                name,
                None,
                false,
                "sin aprobar: servidor de .mcp.json de proyecto que no está en enabledMcpjsonServers ni cubierto por enableAllProjectMcpServers; no se ejecuta"
                    .to_string(),
            )
        }
    }

    fn ok(name: &str, latency_ms: u64) -> Self {
        Self {
            result: McpPingResult {
                name: name.to_string(),
                ok: true,
                latency_ms: Some(latency_ms),
                error: None,
            },
            reachable: true,
            sin_aprobar: false,
        }
    }

    /// Estado que se guarda en mcp-health.json.
    pub(super) fn health_status(&self) -> &'static str {
        if self.sin_aprobar {
            return STATUS_UNAPPROVED;
        }
        match (self.result.ok, self.reachable) {
            (true, _) if self.result.latency_ms.unwrap_or(0) > DEGRADED_AFTER_MS => "degraded",
            (true, _) => "ok",
            (false, true) => "degraded",
            (false, false) => "missing",
        }
    }
}

/// Expande `${VAR}` y `${VAR:-por_defecto}` como Claude Code. Una variable
/// sin definir y sin valor por defecto es un error: Claude Code tampoco
/// arrancaría el servidor.
pub(super) fn expand_vars(input: &str) -> Result<String, String> {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let expr = &after[..end];
        let (var, default) = match expr.split_once(":-") {
            Some((v, d)) => (v, Some(d)),
            None => (expr, None),
        };
        match (std::env::var(var), default) {
            (Ok(v), _) => out.push_str(&v),
            (Err(_), Some(d)) => out.push_str(d),
            (Err(_), None) => {
                return Err(format!("la variable de entorno {var} no está definida"));
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn expand_map(map: &BTreeMap<String, serde_json::Value>) -> Result<Vec<(String, String)>, String> {
    map.iter()
        .map(|(k, v)| expand_vars(&value_to_string(v)).map(|e| (k.clone(), e)))
        .collect()
}

/// Ejecutable real: en Windows `Command::new("npx")` solo prueba `npx.exe`;
/// `which` aplica PATHEXT y encuentra `npx.cmd`. std ejecuta `.cmd`/`.bat`
/// a través de cmd.exe con el escapado correcto.
fn resolve_program(command: &str) -> std::path::PathBuf {
    which::which(command).unwrap_or_else(|_| std::path::PathBuf::from(command))
}

fn initialize_request() -> serde_json::Value {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "clientInfo": {"name": "ultron-control-center", "version": env!("CARGO_PKG_VERSION")},
            "capabilities": {}
        }
    })
}

/// Lee líneas de stdout hasta la respuesta con `id: 1`.
fn await_initialize<R: std::io::Read + Send + 'static>(
    stdout: R,
) -> std::sync::mpsc::Receiver<Result<(), String>> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
                continue;
            };
            if msg.get("id").and_then(|v| v.as_i64()) != Some(1) {
                continue;
            }
            let verdict = if msg.get("result").is_some() {
                Ok(())
            } else {
                Err(format!(
                    "initialize devolvió error: {}",
                    msg.get("error").map(|e| e.to_string()).unwrap_or_default()
                ))
            };
            let _ = tx.send(verdict);
            return;
        }
        let _ = tx.send(Err("cerró stdout sin responder a initialize".to_string()));
    });
    rx
}

/// Comando, argumentos y entorno de un servidor stdio con las variables ya
/// expandidas.
type ExpandedLaunch = (String, Vec<String>, Vec<(String, String)>);

fn ping_stdio(
    name: &str,
    command: &str,
    args: &[String],
    cfg: &McpServerCfg,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Probe {
    let expanded = (|| -> Result<ExpandedLaunch, String> {
        let cmd = expand_vars(command)?;
        let args = args
            .iter()
            .map(|a| expand_vars(a))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((cmd, args, expand_map(&cfg.env)?))
    })();
    let (command, args, env) = match expanded {
        Ok(t) => t,
        Err(e) => return Probe::fail(name, None, false, e),
    };

    let start = Instant::now();
    let mut cmd = std::process::Command::new(resolve_program(&command));
    cmd.args(&args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = cwd.filter(|d| d.is_dir()) {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Probe::fail(name, None, false, format!("spawn {command}: {e}")),
    };
    // Job Object: al terminarlo (o al soltarlo) muere todo el árbol.
    let job = match crate::sesiones::cli_info::Trabajo::para(&child) {
        Ok(j) => Some(j),
        Err(e) => {
            tracing::warn!(mcp = name, error = %e, "ping sin Job Object: solo se mata el hijo");
            None
        }
    };

    // stdin se queda abierta hasta el final: algunos servidores salen al
    // ver EOF antes de contestar.
    let mut stdin = child.stdin.take();
    if let Some(s) = stdin.as_mut() {
        let line = format!("{}\n", initialize_request());
        let _ = s.write_all(line.as_bytes()).and_then(|()| s.flush());
    }
    let verdict = match child.stdout.take() {
        Some(out) => await_initialize(out)
            .recv_timeout(timeout)
            .unwrap_or_else(|_| {
                Err(format!(
                    "sin respuesta a initialize en {} s",
                    timeout.as_secs()
                ))
            }),
        None => Err("sin stdout del proceso".to_string()),
    };
    let elapsed = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);

    drop(stdin);
    if let Some(j) = &job {
        if let Err(e) = j.terminar() {
            tracing::debug!(mcp = name, error = %e, "TerminateJobObject falló");
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    drop(job);

    match verdict {
        Ok(()) => Probe::ok(name, elapsed),
        Err(e) => Probe::fail(name, Some(elapsed), false, e),
    }
}

fn ping_http(name: &str, cfg: &McpServerCfg, timeout: Duration) -> Probe {
    let Some(url) = cfg.url.as_deref() else {
        return Probe::fail(name, None, false, "servidor HTTP sin url".to_string());
    };
    let prepared = (|| -> Result<(String, Vec<(String, String)>), String> {
        Ok((expand_vars(url)?, expand_map(&cfg.headers)?))
    })();
    let (url, headers) = match prepared {
        Ok(t) => t,
        Err(e) => return Probe::fail(name, None, false, e),
    };
    let is_sse = cfg
        .transport
        .as_deref()
        .is_some_and(|t| t.eq_ignore_ascii_case("sse"));

    let agent = ureq::AgentBuilder::new().timeout(timeout).build();
    let start = Instant::now();
    let mut req = if is_sse {
        agent.get(&url).set("Accept", "text/event-stream")
    } else {
        agent
            .post(&url)
            .set("Content-Type", "application/json")
            .set("Accept", "application/json, text/event-stream")
    };
    for (k, v) in &headers {
        req = req.set(k, v);
    }
    let res = if is_sse {
        req.call()
    } else {
        req.send_string(&initialize_request().to_string())
    };
    let elapsed = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    match res {
        Ok(_) => Probe::ok(name, elapsed),
        Err(ureq::Error::Status(code @ (401 | 403), _)) => Probe::fail(
            name,
            Some(elapsed),
            true,
            format!("responde, pero pide autenticación (HTTP {code})"),
        ),
        Err(ureq::Error::Status(code, _)) => Probe::fail(
            name,
            Some(elapsed),
            true,
            format!("initialize devolvió HTTP {code}"),
        ),
        Err(ureq::Error::Transport(t)) => {
            Probe::fail(name, Some(elapsed), false, format!("sin conexión: {t}"))
        }
    }
}

/// Prueba un servidor ya resuelto.
pub(super) fn probe_server(
    name: &str,
    cfg: &McpServerCfg,
    cwd: Option<&Path>,
    timeout: Duration,
) -> Probe {
    match plan_de_ping(cfg) {
        PlanPing::Deshabilitado => Probe::fail(
            name,
            None,
            false,
            "servidor deshabilitado: no se lanza".to_string(),
        ),
        PlanPing::Http => ping_http(name, cfg, timeout),
        PlanPing::SinComando => {
            Probe::fail(name, None, false, "stdio server has no command".to_string())
        }
        PlanPing::Lanzar(command, args) => ping_stdio(name, &command, &args, cfg, cwd, timeout),
    }
}

/// Prueba una fuente aplicando la política de confianza: un `.mcp.json` sin
/// aprobar no se ejecuta y uno aprobado pasa antes las restricciones de
/// proyecto (sin `${VAR}`, allowlist).
pub(super) fn probe_source(
    src: &McpSource,
    aprobaciones: &Aprobaciones,
    timeout: Duration,
) -> Probe {
    match aprobaciones.confianza(src) {
        Confianza::ProyectoSinAprobar => Probe::unapproved(&src.name),
        Confianza::ProyectoAprobado => match validar_servidor_de_proyecto(&src.cfg) {
            Ok(()) => probe_server(&src.name, &src.cfg, src.cwd.as_deref(), timeout),
            Err(e) => Probe::fail(&src.name, None, false, e),
        },
        Confianza::Usuario => probe_server(&src.name, &src.cfg, src.cwd.as_deref(), timeout),
    }
}

pub fn mcp_ping_inner(name: String) -> McpPingResult {
    let settings = match parse_settings() {
        Ok(s) => s,
        Err(e) => return Probe::fail(&name, None, false, format!("read settings: {e}")).result,
    };
    let sources = collect_all_sources(&settings);
    let Some(src) = resolve_server(&sources, &settings.disabled_mcpjson_servers, &name) else {
        return Probe::fail(
            &name,
            None,
            false,
            "no está en ninguna fuente (~/.claude.json, .mcp.json, plugins ni settings.json)"
                .to_string(),
        )
        .result;
    };
    probe_source(&src, &Aprobaciones::cargar(&settings), PING_TIMEOUT).result
}

fn write_health(results: &BTreeMap<String, String>, duration_ms: u64) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let dir = home.join(".ultron").join(".tmp");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .tmp: {e}"))?;
    let path = dir.join("mcp-health.json");
    let doc = serde_json::json!({
        "checked_at": chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        "duration_ms": duration_ms,
        "results": results,
        "source": "control-center",
    });
    let tmp = dir.join(format!("mcp-health.json.tmp.{}", std::process::id()));
    std::fs::write(&tmp, doc.to_string()).map_err(|e| format!("escribir temporal: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename mcp-health.json: {e}")
    })
}

/// Prueba todos los servidores habilitados del listado (de `HEALTH_PARALLELISM`
/// en `HEALTH_PARALLELISM`), guarda mcp-health.json y devuelve el listado ya
/// con los estados nuevos. Los deshabilitados no se lanzan y quedan sin estado;
/// los de `.mcp.json` sin aprobar tampoco se lanzan y quedan `unapproved`.
pub fn mcp_health_check_all_inner() -> Result<Vec<McpInfo>, String> {
    let settings = parse_settings()?;
    let sources = collect_all_sources(&settings);
    let targets: Vec<_> = list_mcps_inner()?
        .into_iter()
        .filter(|info| !info.disabled)
        .filter_map(|info| resolve_server(&sources, &settings.disabled_mcpjson_servers, &info.name))
        .collect();
    let aprobaciones = std::sync::Arc::new(Aprobaciones::cargar(&settings));

    let start = Instant::now();
    let mut results: BTreeMap<String, String> = BTreeMap::new();
    for chunk in targets.chunks(HEALTH_PARALLELISM) {
        let handles: Vec<_> = chunk
            .iter()
            .cloned()
            .map(|src| {
                let aprobaciones = std::sync::Arc::clone(&aprobaciones);
                std::thread::spawn(move || {
                    let probe = probe_source(&src, &aprobaciones, PING_TIMEOUT);
                    (src.name, probe)
                })
            })
            .collect();
        for h in handles {
            match h.join() {
                Ok((name, probe)) => {
                    results.insert(name, probe.health_status().to_string());
                }
                Err(_) => tracing::warn!("un hilo del chequeo de salud MCP entró en pánico"),
            }
        }
    }
    let duration_ms = u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX);
    write_health(&results, duration_ms)?;
    list_mcps_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(v: serde_json::Value) -> McpServerCfg {
        serde_json::from_value(v).expect("cfg")
    }

    #[test]
    fn expand_vars_resolves_defaults_and_fails_on_missing() {
        std::env::set_var("ULTRON_PING_TEST_VAR", "abc");
        assert_eq!(
            expand_vars("x-${ULTRON_PING_TEST_VAR}-y").unwrap(),
            "x-abc-y"
        );
        assert_eq!(expand_vars("${ULTRON_PING_TEST_NOPE:-def}").unwrap(), "def");
        assert!(expand_vars("${ULTRON_PING_TEST_NOPE}").is_err());
        assert_eq!(expand_vars("sin variables").unwrap(), "sin variables");
        assert_eq!(
            expand_vars("abierto ${SIN_CIERRE").unwrap(),
            "abierto ${SIN_CIERRE"
        );
    }

    #[test]
    fn health_status_maps_probe_outcomes() {
        let ok = Probe::ok("a", 100);
        assert_eq!(ok.health_status(), "ok");
        let slow = Probe::ok("a", DEGRADED_AFTER_MS + 1);
        assert_eq!(slow.health_status(), "degraded");
        let auth = Probe::fail("a", Some(10), true, "401".into());
        assert_eq!(auth.health_status(), "degraded");
        let dead = Probe::fail("a", None, false, "x".into());
        assert_eq!(dead.health_status(), "missing");
    }

    /// H15: un HTTP que no escucha ya no da `ok` sin contactar.
    #[test]
    fn http_ping_to_closed_port_is_not_ok() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let c =
            cfg(serde_json::json!({"type": "http", "url": format!("http://127.0.0.1:{port}/mcp")}));
        let p = probe_server("h", &c, None, Duration::from_secs(3));
        assert!(!p.result.ok);
        assert!(!p.reachable);
    }

    /// Gemelo positivo: un servidor HTTP que contesta 200 a `initialize`.
    #[test]
    fn http_ping_to_live_server_is_ok_and_sends_initialize() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut req = server.recv().unwrap();
            let mut body = String::new();
            req.as_reader().read_to_string(&mut body).unwrap();
            let method = req.method().to_string();
            req.respond(tiny_http::Response::from_string(
                r#"{"jsonrpc":"2.0","id":1,"result":{}}"#,
            ))
            .unwrap();
            (method, body)
        });
        let c =
            cfg(serde_json::json!({"type": "http", "url": format!("http://127.0.0.1:{port}/mcp")}));
        let p = probe_server("h", &c, None, Duration::from_secs(5));
        let (method, body) = handle.join().unwrap();
        assert!(p.result.ok, "error: {:?}", p.result.error);
        assert_eq!(method, "POST");
        assert!(body.contains("\"initialize\""));
    }

    #[test]
    fn http_401_is_reachable_but_not_ok() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let handle = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            req.respond(tiny_http::Response::empty(tiny_http::StatusCode(401)))
                .unwrap();
        });
        let c = cfg(serde_json::json!({"url": format!("http://127.0.0.1:{port}/mcp")}));
        let p = probe_server("h", &c, None, Duration::from_secs(5));
        handle.join().unwrap();
        assert!(!p.result.ok);
        assert!(p.reachable);
        assert_eq!(p.health_status(), "degraded");
    }

    /// stdio real: un `node` que contesta a `initialize` con la variable de
    /// `env` del servidor, para fijar que el `env` llega al proceso.
    #[test]
    fn stdio_ping_needs_a_real_initialize_response_and_passes_env() {
        let script = "const rl=require('readline').createInterface({input:process.stdin});\
            rl.on('line',l=>{const m=JSON.parse(l);if(m.id===1&&process.env.ULTRON_PING_ENV==='si'){\
            process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:{}})+'\\n')}})";
        let ok = cfg(serde_json::json!({
            "command": "node", "args": ["-e", script], "env": {"ULTRON_PING_ENV": "si"}
        }));
        let p = probe_server("s", &ok, None, Duration::from_secs(15));
        assert!(p.result.ok, "error: {:?}", p.result.error);

        // Caso negativo: sin la variable el script no contesta y el ping
        // falla por tope de tiempo (antes bastaba con cualquier byte).
        let silent = cfg(serde_json::json!({"command": "node", "args": ["-e", script]}));
        let p = probe_server("s", &silent, None, Duration::from_secs(3));
        assert!(!p.result.ok);
    }

    /// Seguridad: un servidor de `.mcp.json` sin aprobar NO se lanza (el
    /// script dejaría un fichero testigo) y queda `unapproved`; aprobado, sí
    /// se lanza (el testigo aparece).
    #[test]
    fn mcp_json_sin_aprobar_no_se_lanza_y_aprobado_si() {
        let dir = tempfile::tempdir().expect("tempdir");
        let testigo = dir.path().join("lanzado.txt");
        let script = format!(
            "require('fs').writeFileSync({}, 'x')",
            serde_json::to_string(&testigo.to_string_lossy()).expect("ruta")
        );
        let src = McpSource {
            origin: "project:clonado".to_string(),
            plugin: Some("clonado".to_string()),
            name: "repo-srv".to_string(),
            cfg: cfg(serde_json::json!({"command": "node", "args": ["-e", script]})),
            cwd: Some(dir.path().to_path_buf()),
            requiere_aprobacion: true,
        };
        let settings = |v: serde_json::Value| -> crate::mcps::types_io::SettingsRoot {
            serde_json::from_value(v).expect("settings")
        };

        let sin = Aprobaciones::desde(&settings(serde_json::json!({})), None);
        let p = probe_source(&src, &sin, Duration::from_secs(5));
        assert!(!p.result.ok);
        assert_eq!(p.health_status(), STATUS_UNAPPROVED);
        assert!(p
            .result
            .error
            .as_deref()
            .unwrap_or("")
            .contains("sin aprobar"));
        assert!(!testigo.exists(), "un servidor sin aprobar se ha ejecutado");

        let con = Aprobaciones::desde(
            &settings(serde_json::json!({"enabledMcpjsonServers": ["repo-srv"]})),
            None,
        );
        // No contesta a `initialize` (el ping falla), pero se ha lanzado.
        let p = probe_source(&src, &con, Duration::from_secs(5));
        assert_ne!(p.health_status(), STATUS_UNAPPROVED);
        let inicio = Instant::now();
        while !testigo.exists() && inicio.elapsed() < Duration::from_secs(5) {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            testigo.exists(),
            "aprobado debería lanzarse: {:?}",
            p.result.error
        );
    }

    #[test]
    fn stdio_output_that_is_not_the_response_does_not_count() {
        let c = cfg(serde_json::json!({
            "command": "node",
            "args": ["-e", "console.log('hola, no soy JSON-RPC')"]
        }));
        let p = probe_server("s", &c, None, Duration::from_secs(10));
        assert!(!p.result.ok);
    }
}
