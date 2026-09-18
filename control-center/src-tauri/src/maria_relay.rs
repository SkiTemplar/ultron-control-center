// mar.ia — relevo de proveedores sobre un unico hilo de conversacion.
//
// El problema: Claude Code, Codex y Gemini guardan su historial en formatos
// propios y ninguno puede leer la sesion del otro. "Seguir la misma
// conversacion con los tres" no existe como tal; hay que declararlo.
//
// La solucion: el hilo canonico es de mar.ia. Vive en
// `~/.ultron/cockpit/maria/threads/<id>.jsonl`, un turno por linea, con el
// proveedor que lo contesto. Cuando toca cambiar de proveedor (porque se agoto
// la cuota o porque la tarea pide otro), se compone un PAQUETE DE CONTEXTO —
// resumen del hilo + ultimos turnos + memoria relevante de ULTRON — y se
// arranca al siguiente con ese paquete por delante.
//
// Reparto de responsabilidades:
//   * el orden de proveedores y su estado vive en `relay.json`;
//   * la memoria la pone el daemon de ULTRON (mismo recall que el resto);
//   * cada proveedor se invoca por su CLI real, en modo no interactivo.
//
// Limite declarado (mandamiento 13): esto es un RELEVO con traspaso de
// contexto, no una sesion compartida. El proveedor nuevo sabe lo que se
// hablo porque se le cuenta, no porque lea la sesion del anterior.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Turnos recientes que viajan literalmente en el paquete de contexto.
const TURNOS_EN_CONTEXTO: usize = 8;

/// Tope de caracteres del paquete. Un traspaso gigante gasta tokens del
/// proveedor nuevo justo cuando venimos de quedarnos sin ellos.
const MAX_CONTEXTO_CHARS: usize = 6_000;

/// Tope por turno dentro del paquete.
const MAX_TURNO_CHARS: usize = 1_200;

/// Tiempo maximo por proveedor antes de pasar al siguiente.
const TIMEOUT_PROVEEDOR: Duration = Duration::from_secs(180);

/// Cuanto vive el modelo local en VRAM DENTRO de un turno. No es la politica
/// de reposo: al acabar el turno se descarga explicitamente (ver
/// `descargar_modelo_local`). Esta ventana solo evita recargarlo entre la
/// eleccion de destino y la respuesta, que son dos llamadas seguidas.
const KEEP_ALIVE_TURNO: &str = "2m";

/// Suelta el modelo local de la VRAM. Se llama al terminar cada turno:
/// el usuario pidio "cargar y descargar por cada pregunta" (2026-09-18).
/// Silencioso a proposito — si Ollama no esta, no hay nada que soltar y el
/// turno ya ha terminado.
fn descargar_modelo_local() {
    let modelo = crate::ollama::toggle::model_name();
    if let Err(e) = crate::ollama::toggle::deactivate(&modelo) {
        tracing::debug!(error = %e, "no se pudo descargar el modelo local");
    }
}

/// Un turno del hilo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Turn {
    pub ts: String,
    /// "user" | "assistant".
    pub role: String,
    /// Proveedor que lo contesto ("claude", "codex", "gemini", "local").
    /// Vacio en los turnos del usuario.
    #[serde(default)]
    pub provider: String,
    pub text: String,
}

/// Resultado de una vuelta de relevo.
#[derive(Debug, Serialize)]
pub struct RelayAnswer {
    pub thread_id: String,
    /// Proveedor que finalmente contesto.
    pub provider: String,
    pub text: String,
    /// Proveedores que se intentaron antes, con su motivo de descarte. Se
    /// devuelve siempre: si el relevo salto de Claude a Codex, el usuario
    /// tiene derecho a saberlo sin mirar un log.
    pub skipped: Vec<SkipReason>,
    /// Proveedor que propuso el modelo local para esta tarea (None si no
    /// estaba disponible o contesto algo que no existe).
    pub chosen_by_local: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkipReason {
    pub provider: String,
    /// "sin_cli" | "cuota" | "error" | "desactivado" | "timeout".
    pub kind: String,
    pub detail: String,
}

/// Orden y estado de los proveedores.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelayConfig {
    /// Orden de preferencia. El primero que pueda contestar, contesta.
    pub order: Vec<String>,
    /// Proveedores apagados a mano.
    #[serde(default)]
    pub disabled: Vec<String>,
}

impl Default for RelayConfig {
    fn default() -> Self {
        Self {
            // Claude primero (es la suscripcion con mas contexto), el modelo
            // local el ultimo: es gratis pero el mas flojo, asi que hace de red.
            order: vec![
                "claude".into(),
                "codex".into(),
                "gemini".into(),
                "local".into(),
            ],
            disabled: Vec::new(),
        }
    }
}

fn maria_dir() -> Result<PathBuf, String> {
    let dir = dirs::home_dir()
        .ok_or("no encuentro HOME")?
        .join(".ultron")
        .join("cockpit")
        .join("maria");
    std::fs::create_dir_all(dir.join("threads")).map_err(|e| format!("crear carpeta: {e}"))?;
    Ok(dir)
}

fn config_path() -> Result<PathBuf, String> {
    Ok(maria_dir()?.join("relay.json"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(maria_dir()?.join("relay-state.json"))
}

/// Ultimo resultado conocido de cada proveedor.
///
/// Es la unica medida HONESTA de "cuanto le queda": las CLI de suscripcion
/// (Claude, Codex, Gemini) no publican un contador de cuota, solo fallan
/// cuando se agota. Asi que se guarda lo que de verdad paso — contesto, se
/// quedo sin cuota o fallo — con su hora.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ProviderState {
    /// "ok" | "cuota" | "error" | "desactivado".
    pub status: String,
    pub detail: String,
    pub at: String,
    /// Veces que ha contestado desde que se lleva la cuenta.
    #[serde(default)]
    pub answered: u64,
}

pub type RelayState = std::collections::BTreeMap<String, ProviderState>;

pub fn load_state() -> RelayState {
    state_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_state(state: &RelayState) {
    if let Ok(path) = state_path() {
        if let Ok(text) = serde_json::to_string_pretty(state) {
            let _ = std::fs::write(path, text);
        }
    }
}

/// Anota el resultado de un intento conservando el contador de respuestas.
fn record_attempt(state: &mut RelayState, provider: &str, status: &str, detail: &str) {
    let entry = state.entry(provider.to_string()).or_default();
    entry.status = status.to_string();
    entry.detail = recorta(detail, 200);
    entry.at = chrono::Utc::now().to_rfc3339();
    if status == "ok" {
        entry.answered += 1;
    }
}

pub fn load_config() -> RelayConfig {
    let Ok(path) = config_path() else {
        return RelayConfig::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Ruta del hilo. El id se valida: es un nombre de fichero, no una ruta.
fn thread_path(thread_id: &str) -> Result<PathBuf, String> {
    if thread_id.is_empty()
        || thread_id.len() > 64
        || !thread_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("id de hilo invalido: {thread_id:?}"));
    }
    Ok(maria_dir()?.join("threads").join(format!("{thread_id}.jsonl")))
}

pub fn append_turn(thread_id: &str, turn: &Turn) -> Result<(), String> {
    let path = thread_path(thread_id)?;
    let line = serde_json::to_string(turn).map_err(|e| format!("serializar turno: {e}"))?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("abrir hilo: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("escribir turno: {e}"))
}

pub fn read_thread(thread_id: &str) -> Result<Vec<Turn>, String> {
    let path = thread_path(thread_id)?;
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(Vec::new()); // hilo nuevo: no es un error
    };
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Turn>(l).ok())
        .collect())
}

/// ¿El fallo es "se acabo la cuota" y no otra cosa?
///
/// Distinguirlo importa: ante cuota agotada hay que RELEVAR al siguiente
/// proveedor, mientras que ante un error de red o de sintaxis reintentar con
/// otro modelo no arregla nada y solo gasta la cuota del siguiente.
#[must_use]
pub fn is_quota_error(text: &str) -> bool {
    let t = text.to_lowercase();
    const SENALES: &[&str] = &[
        "usage limit",
        "limit reached",
        "rate limit",
        "rate_limit",
        "quota",
        "resource_exhausted",
        "insufficient_quota",
        "insufficient credit",
        "out of credit",
        "too many requests",
        "429",
        "upgrade to continue",
    ];
    SENALES.iter().any(|s| t.contains(s))
}

/// Recorta un texto a `max` caracteres respetando limites de caracter.
fn recorta(texto: &str, max: usize) -> String {
    if texto.chars().count() <= max {
        return texto.to_string();
    }
    let corto: String = texto.chars().take(max).collect();
    format!("{corto}…")
}

/// Compone el paquete de contexto que se le da al proveedor entrante.
///
/// Pura: se testea sin ficheros ni red.
#[must_use]
pub fn build_context(turns: &[Turn], memoria: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(mem) = memoria.filter(|m| !m.trim().is_empty()) {
        out.push_str("[memoria de ULTRON]\n");
        out.push_str(&recorta(mem.trim(), 1_500));
        out.push_str("\n\n");
    }
    let recientes: Vec<&Turn> = turns.iter().rev().take(TURNOS_EN_CONTEXTO).rev().collect();
    if !recientes.is_empty() {
        out.push_str("[conversacion previa]\n");
        for t in recientes {
            let quien = if t.role == "user" {
                "Usuario".to_string()
            } else if t.provider.is_empty() {
                "Asistente".to_string()
            } else {
                format!("Asistente ({})", t.provider)
            };
            out.push_str(&format!("{quien}: {}\n", recorta(&t.text, MAX_TURNO_CHARS)));
        }
        out.push('\n');
    }
    // Si aun asi se pasa del tope, se recorta por el PRINCIPIO: lo ultimo
    // dicho es lo que mas importa para continuar.
    if out.chars().count() > MAX_CONTEXTO_CHARS {
        let sobran = out.chars().count() - MAX_CONTEXTO_CHARS;
        let recortado: String = out.chars().skip(sobran).collect();
        out = format!("[…contexto anterior recortado…]\n{recortado}");
    }
    out
}

/// Comando y argumentos de cada CLI en modo NO interactivo.
///
/// `stdin` indica si el prompt se manda por la entrada estandar (mas seguro:
/// no hay limite de longitud de linea de comandos ni escapado que se pueda
/// colar).
fn cli_invocation(provider: &str) -> Option<(&'static str, Vec<String>, bool)> {
    match provider {
        // `claude -p` imprime la respuesta y sale.
        "claude" => Some(("claude", vec!["-p".into()], true)),
        // `codex exec -` lee el prompt de stdin; sandbox de solo lectura.
        "codex" => Some((
            "codex",
            vec![
                "exec".into(),
                "-".into(),
                "--sandbox".into(),
                "read-only".into(),
                "--skip-git-repo-check".into(),
            ],
            true,
        )),
        // `gemini -p <prompt>` no lee stdin en modo no interactivo.
        "gemini" => Some(("gemini", vec!["-p".into()], false)),
        _ => None,
    }
}

/// ¿Esta el binario en el PATH? Windows los instala como `.cmd`, asi que
/// `Command::new("claude")` no siempre resuelve: se pregunta a `where`.
fn cli_disponible(cmd: &str) -> bool {
    let mut probe = Command::new(if cfg!(windows) { "where" } else { "which" });
    probe.arg(cmd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        probe.creation_flags(0x0800_0000);
    }
    probe
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Lanza una CLI con el prompt y espera su salida.
fn run_cli(provider: &str, prompt: &str) -> Result<String, (String, bool)> {
    let Some((bin, args, por_stdin)) = cli_invocation(provider) else {
        return Err((format!("no se como invocar {provider}"), false));
    };
    if !cli_disponible(bin) {
        return Err((format!("{bin} no esta instalada"), false));
    }

    // En Windows las CLI de npm son shims .cmd: se invocan a traves de cmd /C
    // (mismo truco que pty/spawn.rs), con los argumentos como argv.
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(bin);
        c
    } else {
        Command::new(bin)
    };
    for a in &args {
        cmd.arg(a);
    }
    if !por_stdin {
        cmd.arg(prompt);
    }
    cmd.stdin(if por_stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    // La CLI de Claude baja de plan si ve ANTHROPIC_API_KEY: se limpia para el
    // hijo (mismo motivo que strip_api_key_for_claude en pty/spawn.rs).
    if provider == "claude" {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| (format!("no pude lanzar {bin}: {e}"), false))?;
    if por_stdin {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(prompt.as_bytes());
        }
    }

    // Espera acotada: un proveedor colgado no puede bloquear el relevo.
    let inicio = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if inicio.elapsed() > TIMEOUT_PROVEEDOR {
                    let _ = child.kill();
                    return Err((format!("{provider} no respondio a tiempo"), false));
                }
                std::thread::sleep(Duration::from_millis(120));
            }
            Err(e) => return Err((format!("esperando a {provider}: {e}"), false)),
        }
    }
    let out = child
        .wait_with_output()
        .map_err(|e| (format!("salida de {provider}: {e}"), false))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();

    if out.status.success() && !stdout.is_empty() {
        return Ok(stdout);
    }
    let motivo = if stderr.is_empty() { stdout } else { stderr };
    let cuota = is_quota_error(&motivo);
    Err((recorta(&motivo, 300), cuota))
}

/// Modelo local por Ollama. Ultimo recurso: sin cuota que agotar.
fn run_local(prompt: &str) -> Result<String, (String, bool)> {
    let body = serde_json::json!({
        "model": crate::ollama::toggle::model_name(),
        "stream": false,
        "think": false,
        // Ventana corta DENTRO del turno (la eleccion de destino y la
        // respuesta son dos llamadas seguidas). Al terminar `ask` se descarga
        // a mano con `descargar_modelo_local`: asi la VRAM queda libre entre
        // preguntas sin recargar el modelo dos veces en la misma.
        "keep_alive": KEEP_ALIVE_TURNO,
        "messages": [{ "role": "user", "content": prompt }],
        "options": { "num_ctx": 8192, "num_predict": 600 },
    });
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT_PROVEEDOR)
        .build()
        .map_err(|e| (format!("cliente http: {e}"), false))?;
    let resp = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .map_err(|e| (format!("ollama no responde: {e}"), false))?;
    let v: serde_json::Value = resp
        .json()
        .map_err(|e| (format!("respuesta de ollama ilegible: {e}"), false))?;
    let text = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(("el modelo local devolvio una respuesta vacia".into(), false));
    }
    Ok(text)
}

/// Proveedor que el modelo local propone para una tarea, validado.
///
/// El modelo puede alucinar cualquier cosa; aqui solo se aceptan nombres que
/// existan en el orden configurado. Si propone una fantasia, se devuelve None
/// y manda el orden de siempre. Pura: se testea sin red.
#[must_use]
pub fn parse_choice(raw: &str, known: &[String]) -> Option<String> {
    let limpio: String = raw
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || c.is_whitespace())
        .collect();
    // Se busca la primera palabra que sea un proveedor conocido: el modelo
    // suele contestar "claude" a secas, pero a veces mete una frase.
    limpio
        .split_whitespace()
        .find(|w| known.iter().any(|k| k == w))
        .map(str::to_string)
}

/// Orden de proveedores para ESTA tarea, decidido por el modelo local.
///
/// El local es gratis y ya esta ahi: que elija el destino cuesta ~1 s y evita
/// gastar una peticion de Claude en algo que resuelve Gemini o el propio
/// local. El elegido se pone el primero; el resto conserva el orden
/// configurado como red de seguridad.
fn order_for_task(prompt: &str, cfg: &RelayConfig) -> (Vec<String>, Option<String>) {
    let catalogo = cfg.order.join(", ");
    let instruccion = format!(
        "Elige QUE modelo debe resolver esta peticion. Responde SOLO con una \
         palabra de esta lista: {catalogo}.\n\
         Criterio: 'local' para lo trivial (saludos, conversiones, preguntas \
         cortas, ordenes del PC); 'gemini' para buscar en internet o trabajar \
         con imagenes; 'codex' para scripts sueltos y automatizacion; \
         'claude' para programar en un proyecto, arquitectura o textos largos.\n\n\
         Peticion: {prompt}"
    );
    let body = serde_json::json!({
        "model": crate::ollama::toggle::model_name(),
        "stream": false,
        "think": false,
        "keep_alive": KEEP_ALIVE_TURNO,
        "messages": [{ "role": "user", "content": instruccion }],
        "options": { "num_ctx": 2048, "num_predict": 8, "temperature": 0 },
    });
    let elegido = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .ok()
        .and_then(|c| {
            c.post("http://127.0.0.1:11434/api/chat")
                .json(&body)
                .send()
                .ok()
        })
        .and_then(|r| r.json::<serde_json::Value>().ok())
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.get("content"))
                .and_then(|c| c.as_str())
                .map(str::to_string)
        })
        .and_then(|raw| parse_choice(&raw, &cfg.order));

    match elegido {
        Some(p) => {
            let mut orden = vec![p.clone()];
            orden.extend(cfg.order.iter().filter(|o| **o != p).cloned());
            (orden, Some(p))
        }
        // Sin modelo local (o respuesta ininteligible) no se bloquea nada: se
        // usa el orden configurado.
        None => (cfg.order.clone(), None),
    }
}

/// Memoria relevante para este turno, via daemon de ULTRON. Mismo recall que
/// usa el resto del sistema: las skills, los hooks y la memoria no se
/// reimplementan aqui.
fn memoria_para(prompt: &str) -> Option<String> {
    let value = crate::daemon_client::recall(prompt, 3, None, true, false, Duration::from_secs(8))?;
    let items = value.get("memories")?.as_array()?;
    if items.is_empty() {
        return None;
    }
    let mut out = String::new();
    for m in items.iter().take(3) {
        if let Some(s) = m
            .get("summary")
            .or_else(|| m.get("text"))
            .and_then(|v| v.as_str())
        {
            out.push_str("- ");
            out.push_str(&recorta(s, 400));
            out.push('\n');
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Pregunta al hilo `thread_id`, relevando proveedores hasta que uno conteste.
///
/// `forzado` salta la eleccion del modelo local y pone ese proveedor el
/// primero (lo usa el comando `/migrar` del chat). El resto del orden se
/// conserva como red de seguridad: forzar a Claude cuando Claude no tiene
/// cuota no puede dejar al usuario sin respuesta.
pub fn ask(thread_id: &str, prompt: &str, forzado: Option<&str>) -> Result<RelayAnswer, String> {
    let r = ask_inner(thread_id, prompt, forzado);
    // Pase lo que pase, la VRAM queda libre: el turno ha terminado.
    descargar_modelo_local();
    if r.is_ok() {
        crate::maria_threads::touch(thread_id);
    }
    r
}

fn ask_inner(
    thread_id: &str,
    prompt: &str,
    forzado: Option<&str>,
) -> Result<RelayAnswer, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("no me has dicho nada".into());
    }
    let cfg = load_config();
    let turns = read_thread(thread_id)?;
    let contexto = build_context(&turns, memoria_para(prompt).as_deref());
    let completo = if contexto.is_empty() {
        prompt.to_string()
    } else {
        format!("{contexto}[mensaje actual]\n{prompt}")
    };

    append_turn(
        thread_id,
        &Turn {
            ts: chrono::Utc::now().to_rfc3339(),
            role: "user".into(),
            provider: String::new(),
            text: prompt.to_string(),
        },
    )?;

    let mut skipped: Vec<SkipReason> = Vec::new();
    let mut state = load_state();
    // Quien atiende primero lo decide el modelo local segun la tarea: es
    // gratis y evita gastar una peticion de Claude en algo trivial.
    let (orden, elegido) = match forzado.filter(|f| cfg.order.iter().any(|o| o == f)) {
        // Migracion pedida a mano: no se consulta al local, manda el usuario.
        Some(f) => {
            let mut orden = vec![f.to_string()];
            orden.extend(cfg.order.iter().filter(|o| o.as_str() != f).cloned());
            (orden, None)
        }
        None => order_for_task(prompt, &cfg),
    };
    if let Some(p) = &elegido {
        tracing::info!(proveedor = %p, "el modelo local eligio destino");
    }
    for provider in &orden {
        if cfg.disabled.iter().any(|d| d == provider) {
            record_attempt(&mut state, provider, "desactivado", "apagado en relay.json");
            skipped.push(SkipReason {
                provider: provider.clone(),
                kind: "desactivado".into(),
                detail: "apagado en relay.json".into(),
            });
            continue;
        }
        let intento = if provider == "local" {
            run_local(&completo)
        } else {
            run_cli(provider, &completo)
        };
        match intento {
            Ok(text) => {
                record_attempt(&mut state, provider, "ok", "contesto");
                save_state(&state);
                append_turn(
                    thread_id,
                    &Turn {
                        ts: chrono::Utc::now().to_rfc3339(),
                        role: "assistant".into(),
                        provider: provider.clone(),
                        text: text.clone(),
                    },
                )?;
                return Ok(RelayAnswer {
                    thread_id: thread_id.to_string(),
                    provider: provider.clone(),
                    text,
                    skipped,
                    chosen_by_local: elegido.clone(),
                });
            }
            Err((detail, cuota)) => {
                let kind = if cuota { "cuota" } else { "error" };
                if cuota {
                    // Se aprende el tope practico de la ventana: el consumo
                    // que habia justo cuando el proveedor dijo basta.
                    let w = crate::maria_quota::claude_window();
                    if provider == "claude" {
                        crate::maria_quota::record_ceiling("claude", w.tokens);
                    }
                }
                record_attempt(&mut state, provider, kind, &detail);
                skipped.push(SkipReason {
                    provider: provider.clone(),
                    kind: kind.into(),
                    detail,
                });
            }
        }
    }

    save_state(&state);
    Err(format!(
        "ningun proveedor pudo contestar: {}",
        skipped
            .iter()
            .map(|s| format!("{} ({})", s.provider, s.kind))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

// ---------------------------------------------------------------------------
// Comandos Tauri
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn maria_relay_ask(
    thread_id: String,
    prompt: String,
    provider: Option<String>,
) -> Result<RelayAnswer, String> {
    // Bloqueante (procesos + red) fuera del hilo async de Tauri.
    tauri::async_runtime::spawn_blocking(move || ask(&thread_id, &prompt, provider.as_deref()))
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

#[tauri::command]
pub async fn maria_relay_thread(thread_id: String) -> Result<Vec<Turn>, String> {
    read_thread(&thread_id)
}

/// Ultimo resultado conocido por proveedor (para el panel de la pantalla
/// principal: quien contesta, quien se quedo sin cuota y cuando).
#[tauri::command]
pub async fn maria_relay_state() -> Result<RelayState, String> {
    Ok(load_state())
}

#[tauri::command]
pub async fn maria_relay_config() -> Result<RelayConfig, String> {
    Ok(load_config())
}

#[tauri::command]
pub async fn maria_relay_save_config(config: RelayConfig) -> Result<RelayConfig, String> {
    let path = config_path()?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| format!("serializar: {e}"))?;
    std::fs::write(&path, text).map_err(|e| format!("guardar relay.json: {e}"))?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turno(role: &str, provider: &str, text: &str) -> Turn {
        Turn {
            ts: "2026-09-18T10:00:00Z".into(),
            role: role.into(),
            provider: provider.into(),
            text: text.into(),
        }
    }

    #[test]
    fn detecta_los_mensajes_de_cuota_agotada() {
        for t in [
            "Claude usage limit reached. Resets at 3pm",
            "Error 429: Too Many Requests",
            "RESOURCE_EXHAUSTED: quota exceeded for model",
            "insufficient_quota: add credit",
            "You have hit the rate limit",
        ] {
            assert!(is_quota_error(t), "deberia ser cuota: {t}");
        }
    }

    #[test]
    fn no_confunde_otros_fallos_con_cuota() {
        // Caso negativo: si un fallo de red se tomara por cuota, el relevo
        // quemaria la cuota del siguiente proveedor sin motivo.
        for t in [
            "ENOTFOUND api.anthropic.com",
            "command not found",
            "SyntaxError: unexpected token",
            "permission denied",
            "",
        ] {
            assert!(!is_quota_error(t), "no deberia ser cuota: {t}");
        }
    }

    #[test]
    fn el_contexto_incluye_memoria_y_ultimos_turnos() {
        let turns = vec![
            turno("user", "", "arregla el login"),
            turno("assistant", "claude", "falta el token CSRF"),
        ];
        let ctx = build_context(&turns, Some("- el proyecto usa Supabase"));
        assert!(ctx.contains("[memoria de ULTRON]"));
        assert!(ctx.contains("Supabase"));
        assert!(ctx.contains("Usuario: arregla el login"));
        assert!(ctx.contains("Asistente (claude): falta el token CSRF"));
    }

    #[test]
    fn el_contexto_solo_lleva_los_ultimos_turnos() {
        let turns: Vec<Turn> = (0..30)
            .map(|i| turno("user", "", &format!("mensaje {i}")))
            .collect();
        let ctx = build_context(&turns, None);
        assert!(ctx.contains("mensaje 29"), "falta el ultimo turno");
        assert!(!ctx.contains("mensaje 5"), "no deberia traer turnos viejos");
    }

    #[test]
    fn el_contexto_respeta_el_tope_de_caracteres() {
        let gordo = "a".repeat(5_000);
        let turns: Vec<Turn> = (0..10).map(|_| turno("user", "", &gordo)).collect();
        let ctx = build_context(&turns, None);
        assert!(
            ctx.chars().count() <= MAX_CONTEXTO_CHARS + 40,
            "contexto sin recortar: {} caracteres",
            ctx.chars().count()
        );
        // Se recorta por el principio: lo ultimo dicho sobrevive.
        assert!(ctx.starts_with("[…contexto anterior recortado…]"));
    }

    #[test]
    fn sin_memoria_ni_turnos_el_contexto_va_vacio() {
        // Caso negativo: un hilo nuevo no debe arrastrar cabeceras vacias que
        // solo gastan tokens.
        assert_eq!(build_context(&[], None), "");
    }

    #[test]
    fn el_id_de_hilo_no_puede_escaparse_de_la_carpeta() {
        for malo in ["../secreto", "a/b", "a\\b", "", &"x".repeat(65)] {
            assert!(thread_path(malo).is_err(), "deberia rechazar {malo:?}");
        }
        assert!(thread_path("hilo-01_test").is_ok());
    }

    #[test]
    fn acepta_la_eleccion_del_modelo_local() {
        let conocidos: Vec<String> = RelayConfig::default().order;
        assert_eq!(parse_choice("claude", &conocidos).as_deref(), Some("claude"));
        assert_eq!(parse_choice("  GEMINI
", &conocidos).as_deref(), Some("gemini"));
        assert_eq!(
            parse_choice("Yo usaria local para esto", &conocidos).as_deref(),
            Some("local")
        );
    }

    #[test]
    fn rechaza_una_eleccion_inventada() {
        // Caso negativo: el modelo puede devolver cualquier cosa. Un nombre
        // que no existe tiene que caer al orden configurado, no colarse.
        let conocidos: Vec<String> = RelayConfig::default().order;
        for raw in ["gpt-4", "", "no lo se", "deepseek", "!!!"] {
            assert!(parse_choice(raw, &conocidos).is_none(), "colo: {raw:?}");
        }
    }

    #[test]
    fn el_orden_por_defecto_deja_el_local_el_ultimo() {
        let cfg = RelayConfig::default();
        assert_eq!(cfg.order.first().map(String::as_str), Some("claude"));
        assert_eq!(cfg.order.last().map(String::as_str), Some("local"));
    }

    #[test]
    fn cada_proveedor_de_cli_sabe_como_invocarse() {
        for p in ["claude", "codex", "gemini"] {
            let inv = cli_invocation(p);
            assert!(inv.is_some(), "sin invocacion para {p}");
        }
        // El local NO va por CLI: se resuelve por HTTP contra Ollama.
        assert!(cli_invocation("local").is_none());
    }
}
