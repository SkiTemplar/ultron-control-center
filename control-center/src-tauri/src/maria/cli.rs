// mar.ia — invocar a claude, codex y antigravity de la misma manera.
//
// Tres CLI, tres dialectos. Este modulo es el unico sitio que los conoce:
//
//   * como se pide cada cosa (modelo, esfuerzo, adjuntos, sesion, permisos);
//   * como se lee lo que devuelven (eventos de Claude, JSONL de Codex, un JSON
//     de Antigravity) para pintar la respuesta segun llega y quedarse con el
//     identificador de sesion;
//   * como se para.
//
// SESION CONTINUA (2026-09-21). Antes cada turno era una CLI sin estado con el
// hilo pegado como texto (8 turnos, 6.000 caracteres). Mientras conteste el
// mismo proveedor ahora se REANUDA su propia sesion: contexto completo, cache
// de prompt y menos cuota. El paquete de contexto queda para el relevo de
// verdad, que es cuando hace falta contarle a otro lo que se hablo.
//
// ACCESO TOTAL. Con `acceso_total` las tres se lanzan sin pedir permiso por
// herramienta y sin caja de arena (lo pidio el usuario: "que todos los agentes
// tengan acceso completo al pc"). Apagado, Codex va en solo lectura y las otras
// con sus permisos por defecto. Es un ajuste visible en Router -> Criterio, no
// un valor escondido.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use super::relay::{is_quota_error, necesita_cmd, recorta, ruta_de_cli, Adjuntos};

/// Tiempo maximo por proveedor antes de pasar al siguiente.
const TIMEOUT_PROVEEDOR: Duration = Duration::from_secs(180);
/// Con acceso total un encargo puede ser trabajo de verdad (leer un repo,
/// escribir ficheros): se le da mas cuerda.
const TIMEOUT_TRABAJO: Duration = Duration::from_secs(1_800);

/// Que hacer con la sesion propia de la CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sesion {
    /// Turno suelto, como siempre.
    Ninguna,
    /// Empezar una sesion que luego se pueda reanudar. Claude acepta que el
    /// identificador lo pongamos nosotros; las otras lo devuelven al acabar.
    Nueva(String),
    /// Seguir la sesion que ya tiene este hilo con este proveedor.
    Reanudar(String),
}

/// Lo que gobierna la pantalla Router -> Criterio.
#[derive(Debug, Clone, Default)]
pub struct Ajustes {
    pub ligero: bool,
    pub acceso_total: bool,
    /// Fichero `--mcp-config` con los MCP elegidos para el chat (modo ligero).
    pub mcp_config: Option<PathBuf>,
}

pub struct Peticion<'a> {
    /// Clave para emitir trozos y para parar: el hilo, o `hilo#encargo`.
    pub clave: &'a str,
    pub provider: &'a str,
    pub prompt: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
    pub ajustes: &'a Ajustes,
    pub adjuntos: &'a Adjuntos,
    pub sesion: Sesion,
    /// Carpeta de trabajo del proceso.
    pub cwd: Option<PathBuf>,
}

/// Lo que ha costado un turno, SEGUN LO QUE DIGA EL PROVEEDOR (2026-09-22).
///
/// Todo opcional y nada estimado: lo que un proveedor no cuenta se queda en
/// `None` y la pantalla escribe "sin dato". Inventar una cifra de tokens o de
/// dolares es peor que no dar ninguna, porque nadie la sabria desmentir.
///
/// Quien da que, comprobado contra los binarios instalados:
///   * claude  — linea `result` del stream-json: `usage` y `total_cost_usd`.
///   * codex   — evento `turn.completed`: `usage`, sin coste (la CLI no lo
///               publica).
///   * agy     — nada: su evento `result` no se ha podido verificar desde
///               aqui, asi que no se parsea nada a ojo. Solo tendra el tiempo,
///               que lo mide mar.ia.
///   * local   — nada: es gratis y corre en esta maquina.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Consumo {
    /// Tokens de entrada. En Claude es la suma de los tres cubos (nuevos,
    /// escritura de cache y lectura de cache), que es como los suma la propia
    /// CLI para su barra de contexto: son disjuntos.
    pub tokens_in: Option<u64>,
    pub tokens_out: Option<u64>,
    /// Estimacion en dolares del propio proveedor, no una factura.
    pub coste_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Respuesta {
    pub texto: String,
    /// Sesion que se puede reanudar en el turno siguiente.
    pub sesion: Option<String>,
    /// Tokens y coste, vacios donde el proveedor no los da.
    pub consumo: Consumo,
}

/// Binario de cada proveedor, o None si no es una CLI.
#[must_use]
pub fn binario(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("claude"),
        "codex" => Some("codex"),
        "antigravity" => Some("agy"),
        _ => None,
    }
}

/// ¿El prompt va por stdin? Antigravity lo quiere como argumento tras `-p`.
#[must_use]
pub fn por_stdin(provider: &str) -> bool {
    provider != "antigravity"
}

/// Ficheros de ajustes para el modo ligero de Claude. Van como RUTA y no como
/// JSON en linea: asi da igual quien cite que al pasar el argumento.
fn ficheros_claude_ligero() -> Option<(PathBuf, PathBuf)> {
    let dir = crate::maria::paths::cockpit("maria").ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let ajustes = dir.join("claude-ligero.json");
    let sin_mcp = dir.join("claude-sin-mcp.json");
    if !ajustes.exists() {
        std::fs::write(&ajustes, r#"{"disableAllHooks":true}"#).ok()?;
    }
    if !sin_mcp.exists() {
        std::fs::write(&sin_mcp, r#"{"mcpServers":{}}"#).ok()?;
    }
    Some((ajustes, sin_mcp))
}

/// Argumentos completos de la CLI, SIN el prompt cuando va por stdin. Pura
/// salvo por `ligero` (que necesita dos ficheros): se le pasan ya resueltos.
///
/// El orden importa y cada rareza tiene su historia:
///   * en Claude y Antigravity `-p` va el ULTIMO: se come lo que tenga detras;
///   * en Codex los posicionales van delante y `-i` (que es variadico) justo
///     antes de otra bandera, para que no se trague el `-` del prompt.
#[must_use]
pub fn argumentos(
    provider: &str,
    model: &str,
    effort: &str,
    ajustes: &Ajustes,
    ligero: Option<(&std::path::Path, &std::path::Path)>,
    adjuntos: &Adjuntos,
    sesion: &Sesion,
    prompt_si_argumento: &str,
) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    let modelo_y_esfuerzo = crate::maria::models::argumentos(provider, model, effort);
    match provider {
        "claude" => {
            a.extend(modelo_y_esfuerzo);
            for x in [
                "--output-format",
                "stream-json",
                "--verbose",
                "--include-partial-messages",
            ] {
                a.push(x.into());
            }
            if ajustes.ligero {
                if let Some((sin_hooks, sin_mcp)) = ligero {
                    a.push("--settings".into());
                    a.push(sin_hooks.to_string_lossy().into_owned());
                    a.push("--strict-mcp-config".into());
                    a.push("--mcp-config".into());
                    let mcp = ajustes.mcp_config.as_deref().unwrap_or(sin_mcp);
                    a.push(mcp.to_string_lossy().into_owned());
                }
            }
            if ajustes.acceso_total {
                a.push("--dangerously-skip-permissions".into());
            }
            match sesion {
                Sesion::Nueva(id) => {
                    a.push("--session-id".into());
                    a.push(id.clone());
                }
                Sesion::Reanudar(id) => {
                    a.push("--resume".into());
                    a.push(id.clone());
                }
                Sesion::Ninguna => {}
            }
            for d in adjuntos.carpetas() {
                a.push("--add-dir".into());
                a.push(d.to_string_lossy().into_owned());
            }
            a.push("-p".into());
        }
        "codex" => {
            a.push("exec".into());
            if let Sesion::Reanudar(id) = sesion {
                a.push("resume".into());
                a.push(id.clone());
            }
            a.push("-".into());
            for img in adjuntos.imagenes() {
                a.push("-i".into());
                a.push(img.to_string_lossy().into_owned());
            }
            a.extend(modelo_y_esfuerzo);
            a.push("--json".into());
            a.push("--skip-git-repo-check".into());
            if ajustes.acceso_total {
                a.push("--dangerously-bypass-approvals-and-sandbox".into());
            } else {
                // `resume` no acepta `--sandbox`; la clave de configuracion vale
                // para los dos subcomandos.
                a.push("-c".into());
                a.push("sandbox_mode=\"read-only\"".into());
            }
        }
        "antigravity" => {
            a.extend(modelo_y_esfuerzo);
            a.push("--output-format".into());
            a.push("stream-json".into());
            if ajustes.acceso_total {
                a.push("--dangerously-skip-permissions".into());
            }
            if let Sesion::Reanudar(id) = sesion {
                a.push("--conversation".into());
                a.push(id.clone());
            }
            for d in adjuntos.carpetas() {
                a.push("--add-dir".into());
                a.push(d.to_string_lossy().into_owned());
            }
            a.push("-p".into());
            a.push(prompt_si_argumento.to_string());
        }
        _ => {}
    }
    a
}

// ---------------------------------------------------------------------------
// Lectores de salida (puros)
// ---------------------------------------------------------------------------

/// Texto nuevo que trae una linea del `stream-json` de Claude, y el resultado
/// final si la linea es la de cierre.
#[must_use]
pub fn leer_linea_claude(linea: &str) -> (Option<String>, Option<Result<String, String>>) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(linea) else {
        return (None, None);
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("stream_event") => {
            let delta = v
                .pointer("/event/delta/text")
                .and_then(|t| t.as_str())
                .filter(|_| {
                    v.pointer("/event/delta/type").and_then(|t| t.as_str()) == Some("text_delta")
                })
                .map(str::to_string);
            (delta, None)
        }
        Some("result") => {
            let texto = v
                .get("result")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let mal = v.get("is_error").and_then(serde_json::Value::as_bool) == Some(true);
            (None, Some(if mal { Err(texto) } else { Ok(texto) }))
        }
        _ => (None, None),
    }
}

/// Suma de un campo entero del objeto `usage`, saltandose los que no estan.
fn suma_tokens(usage: &serde_json::Value, campos: &[&str]) -> Option<u64> {
    let vistos: Vec<u64> = campos
        .iter()
        .filter_map(|c| usage.get(*c).and_then(serde_json::Value::as_u64))
        .collect();
    (!vistos.is_empty()).then(|| vistos.iter().sum())
}

/// Tokens y coste de la linea `result` de Claude, si es esa linea. Pura.
///
/// La entrada se suma en sus tres cubos porque son disjuntos y asi los suma la
/// propia CLI para decidir cuanto contexto queda.
#[must_use]
pub fn consumo_claude(linea: &str) -> Option<Consumo> {
    let v = serde_json::from_str::<serde_json::Value>(linea).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("result") {
        return None;
    }
    let usage = v.get("usage")?;
    Some(Consumo {
        tokens_in: suma_tokens(
            usage,
            &[
                "input_tokens",
                "cache_creation_input_tokens",
                "cache_read_input_tokens",
            ],
        ),
        tokens_out: suma_tokens(usage, &["output_tokens"]),
        coste_usd: v.get("total_cost_usd").and_then(serde_json::Value::as_f64),
    })
}

/// Tokens del evento `turn.completed` de Codex, si es ese evento. Pura.
///
/// Codex NO publica coste: es una carencia conocida y abierta de su CLI, asi
/// que ahi se escribe "sin dato" en vez de estimarlo con tarifas que caducan.
#[must_use]
pub fn consumo_codex(linea: &str) -> Option<Consumo> {
    let v = serde_json::from_str::<serde_json::Value>(linea).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("turn.completed") {
        return None;
    }
    let usage = v.get("usage")?;
    Some(Consumo {
        // `cached_input_tokens` es el trozo cacheado de la entrada, no entrada
        // ADEMAS de la otra: sumarlo contaria dos veces. Solo el total.
        tokens_in: suma_tokens(usage, &["input_tokens"]),
        tokens_out: suma_tokens(usage, &["output_tokens"]),
        coste_usd: None,
    })
}

/// Herramienta que Claude empieza a usar en esta linea, si es el caso. Es lo
/// que permite decir "leyendo un fichero" en vez de un "pensando" mudo.
#[must_use]
pub fn actividad_claude(linea: &str) -> Option<String> {
    let v = serde_json::from_str::<serde_json::Value>(linea).ok()?;
    if v.pointer("/event/type")?.as_str()? != "content_block_start"
        || v.pointer("/event/content_block/type")?.as_str()? != "tool_use"
    {
        return None;
    }
    Some(format!(
        "usando {}",
        v.pointer("/event/content_block/name")?.as_str()?
    ))
}

/// Lo que puede traer una linea del `--json` de Codex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventoCodex {
    Sesion(String),
    Texto(String),
    Error(String),
    /// Orden que esta ejecutando: no es respuesta, es para contarlo.
    Actividad(String),
    Nada,
}

#[must_use]
pub fn leer_linea_codex(linea: &str) -> EventoCodex {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(linea) else {
        return EventoCodex::Nada;
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("thread.started") => v
            .get("thread_id")
            .and_then(|t| t.as_str())
            .map_or(EventoCodex::Nada, |id| EventoCodex::Sesion(id.to_string())),
        Some("item.started") => v
            .pointer("/item/command")
            .and_then(|c| c.as_str())
            .map_or(EventoCodex::Nada, |c| {
                EventoCodex::Actividad(format!("ejecutando: {}", recorta(c, 120)))
            }),
        Some("item.completed") => {
            let es_mensaje =
                v.pointer("/item/type").and_then(|t| t.as_str()) == Some("agent_message");
            v.pointer("/item/text")
                .and_then(|t| t.as_str())
                .filter(|_| es_mensaje)
                .map_or(EventoCodex::Nada, |t| EventoCodex::Texto(t.to_string()))
        }
        Some("error") | Some("turn.failed") => {
            let msg = v
                .get("message")
                .or_else(|| v.pointer("/error/message"))
                .and_then(|m| m.as_str())
                .unwrap_or("codex fallo sin decir por que");
            EventoCodex::Error(msg.to_string())
        }
        _ => EventoCodex::Nada,
    }
}

/// Lo que puede traer una linea del `stream-json` de Antigravity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventoAgy {
    Sesion(String),
    Texto(String),
    Actividad(String),
    Fin(Result<String, String>),
    Nada,
}

/// Formato real de agy (2026-09-21): `init` con la conversacion, `step_update`
/// con `text_delta` cuando el paso es la respuesta, y `result` al final.
#[must_use]
pub fn leer_linea_agy(linea: &str) -> EventoAgy {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(linea) else {
        return EventoAgy::Nada;
    };
    match v.get("event").and_then(|e| e.as_str()) {
        Some("init") => v
            .get("conversation_id")
            .and_then(|c| c.as_str())
            .map_or(EventoAgy::Nada, |c| EventoAgy::Sesion(c.to_string())),
        Some("step_update") => {
            let paso = v
                .pointer("/step_update/step_type")
                .and_then(|t| t.as_str())
                .unwrap_or("");
            let delta = v
                .pointer("/step_update/text_delta")
                .and_then(|t| t.as_str());
            match (paso, delta) {
                ("agent_response", Some(d)) if !d.is_empty() => EventoAgy::Texto(d.to_string()),
                ("user_input" | "agent_response", _) | ("", _) => EventoAgy::Nada,
                (otro, _) => {
                    let activo =
                        v.pointer("/step_update/state").and_then(|s| s.as_str()) == Some("ACTIVE");
                    if activo {
                        EventoAgy::Actividad(otro.replace('_', " "))
                    } else {
                        EventoAgy::Nada
                    }
                }
            }
        }
        Some("result") => {
            let texto = v
                .pointer("/result/response")
                .and_then(|r| r.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let estado = v
                .pointer("/result/status")
                .and_then(|s| s.as_str())
                .unwrap_or("");
            EventoAgy::Fin(if estado == "SUCCESS" && !texto.is_empty() {
                Ok(texto)
            } else {
                Err(v
                    .pointer("/result/error")
                    .and_then(|e| e.as_str())
                    .map_or_else(|| format!("antigravity: {estado}"), str::to_string))
            })
        }
        _ => EventoAgy::Nada,
    }
}

/// El JSON unico con el que acaba Antigravity: respuesta y conversacion.
pub fn leer_json_agy(todo: &str) -> Result<Respuesta, String> {
    // Puede venir ruido antes del objeto: se busca la ultima linea que parsee.
    let v = todo
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .or_else(|| serde_json::from_str::<serde_json::Value>(todo.trim()).ok())
        .ok_or_else(|| recorta(todo.trim(), 300))?;
    let texto = v
        .get("response")
        .and_then(|r| r.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let estado = v.get("status").and_then(|s| s.as_str()).unwrap_or("");
    if texto.is_empty() || (!estado.is_empty() && estado != "SUCCESS") {
        let motivo = v
            .get("error")
            .and_then(|e| e.as_str())
            .map_or_else(|| format!("antigravity: {estado}"), str::to_string);
        return Err(motivo);
    }
    Ok(Respuesta {
        texto,
        sesion: v
            .get("conversation_id")
            .and_then(|c| c.as_str())
            .map(str::to_string),
        consumo: Consumo::default(),
    })
}

// ---------------------------------------------------------------------------
// Fallos con nombre
// ---------------------------------------------------------------------------
//
// Estos dos mensajes los COMPONE `ejecutar` y los RECONOCE
// `relay::clasifica_fallo` para dar el `kind` del descarte. Viven aqui, en una
// funcion, a proposito: si la cadena se escribiera dos veces (una al fallar y
// otra al clasificar) cualquier retoque dejaria la clasificacion adivinando, y
// todo volveria a caer en "error" — que es justo de donde venimos (2026-09-22).

/// "Esa CLI no esta". Se dice el NOMBRE del binario y nada mas: el repo es
/// publico y volcar el PATH entero seria volcar rutas de la maquina.
#[must_use]
pub fn msg_sin_cli(bin: &str) -> String {
    format!("{bin} no esta en el PATH de esta maquina")
}

/// "Esa CLI se ha pasado de tiempo", con el plazo que se le dio.
#[must_use]
pub fn msg_timeout(provider: &str, segundos: u64) -> String {
    format!("{provider} no respondio en {segundos} s")
}

// ---------------------------------------------------------------------------
// Ejecucion
// ---------------------------------------------------------------------------

/// Lanza la CLI, emite la respuesta segun llega y devuelve el texto y la
/// sesion. El `bool` del error dice si fue por cuota. Si el usuario para el
/// turno devuelve lo que hubiera (o el error "parado" si no habia nada).
pub fn ejecutar(p: &Peticion<'_>) -> Result<Respuesta, (String, bool)> {
    let Some(bin) = binario(p.provider) else {
        return Err((msg_sin_cli(p.provider), false));
    };
    let Some(ruta) = ruta_de_cli(bin) else {
        return Err((msg_sin_cli(bin), false));
    };
    // Claude no tiene bandera de esfuerzo: se le pide en el propio mensaje.
    let prefijo = crate::maria::models::prefijo_esfuerzo(p.provider, p.effort);
    let prompt = format!("{prefijo}{}{}", p.prompt, p.adjuntos.como_rutas());
    let ligero = ficheros_claude_ligero();
    let args = argumentos(
        p.provider,
        p.model,
        p.effort,
        p.ajustes,
        ligero.as_ref().map(|(a, b)| (a.as_path(), b.as_path())),
        p.adjuntos,
        &p.sesion,
        &prompt,
    );

    // Un shim de npm (.cmd) va por `cmd /C`; un .exe nativo, DIRECTO: cmd.exe
    // trunca los argumentos en el primer salto de linea. Ver `necesita_cmd`.
    let mut cmd = if necesita_cmd(&ruta) {
        let mut c = crate::proc::oculto("cmd");
        c.arg("/C").arg(&ruta);
        c
    } else {
        crate::proc::oculto(&ruta)
    };
    cmd.args(&args);
    if let Some(dir) = p.cwd.as_ref().filter(|d| d.is_dir()) {
        cmd.current_dir(dir);
    }
    let stdin = por_stdin(p.provider);
    cmd.stdin(if stdin { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    // La CLI de Claude baja de plan si ve ANTHROPIC_API_KEY.
    if p.provider == "claude" {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| (format!("no pude lanzar {bin}: {e}"), false))?;
    if stdin {
        if let Some(mut entrada) = child.stdin.take() {
            let _ = entrada.write_all(prompt.as_bytes());
        }
    }

    // Un hilo por tuberia: leer las dos a la vez evita que el hijo se bloquee
    // con stderr lleno mientras aqui solo se mira stdout.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    if let Some(mut out) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut buf = [0_u8; 4096];
            while let Ok(n) = out.read(&mut buf) {
                if n == 0 || tx.send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
    }
    let err_hilo = child.stderr.take().map(|mut e| {
        std::thread::spawn(move || {
            let mut t = String::new();
            let _ = e.read_to_string(&mut t);
            t
        })
    });

    let tope = if p.ajustes.acceso_total {
        TIMEOUT_TRABAJO
    } else {
        TIMEOUT_PROVEEDOR
    };
    let inicio = std::time::Instant::now();
    let mut pendiente: Vec<u8> = Vec::new();
    let mut crudo = String::new();
    let mut texto = String::new();
    let mut sesion: Option<String> = match &p.sesion {
        Sesion::Nueva(id) | Sesion::Reanudar(id) => Some(id.clone()),
        Sesion::Ninguna => None,
    };
    let mut cierre: Option<Result<String, String>> = None;
    let mut consumo = Consumo::default();
    let mut parado = false;
    loop {
        match rx.recv_timeout(Duration::from_millis(80)) {
            Ok(trozo) => {
                pendiente.extend_from_slice(&trozo);
                {
                    while let Some(pos) = pendiente.iter().position(|b| *b == b'\n') {
                        let linea: Vec<u8> = pendiente.drain(..=pos).collect();
                        let linea = String::from_utf8_lossy(&linea);
                        if p.provider == "antigravity" {
                            crudo.push_str(&linea);
                            match leer_linea_agy(&linea) {
                                EventoAgy::Sesion(id) => sesion = Some(id),
                                EventoAgy::Texto(t) => {
                                    crate::maria::flujo::trozo(p.clave, p.provider, &t, false);
                                    texto.push_str(&t);
                                }
                                EventoAgy::Actividad(que) => {
                                    crate::maria::flujo::actividad(p.clave, p.provider, &que);
                                }
                                EventoAgy::Fin(r) => cierre = Some(r),
                                EventoAgy::Nada => {}
                            }
                        } else if p.provider == "claude" {
                            if let Some(que) = actividad_claude(&linea) {
                                crate::maria::flujo::actividad(p.clave, p.provider, &que);
                            }
                            let (delta, fin) = leer_linea_claude(&linea);
                            if let Some(d) = delta {
                                crate::maria::flujo::trozo(p.clave, p.provider, &d, false);
                                texto.push_str(&d);
                            }
                            if fin.is_some() {
                                cierre = fin;
                            }
                            if let Some(c) = consumo_claude(&linea) {
                                consumo = c;
                            }
                        } else {
                            if let Some(c) = consumo_codex(&linea) {
                                consumo = c;
                            }
                            match leer_linea_codex(&linea) {
                                EventoCodex::Sesion(id) => sesion = Some(id),
                                EventoCodex::Texto(t) => {
                                    let sep = if texto.is_empty() { "" } else { "\n\n" };
                                    let nuevo = format!("{sep}{t}");
                                    crate::maria::flujo::trozo(p.clave, p.provider, &nuevo, false);
                                    texto.push_str(&nuevo);
                                }
                                EventoCodex::Error(e) => cierre = Some(Err(e)),
                                EventoCodex::Actividad(que) => {
                                    crate::maria::flujo::actividad(p.clave, p.provider, &que);
                                }
                                EventoCodex::Nada => {}
                            }
                        }
                    }
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if crate::maria::flujo::cancelado(p.clave) {
            let _ = child.kill();
            parado = true;
            break;
        }
        if inicio.elapsed() > tope {
            let _ = child.kill();
            let _ = child.wait();
            return Err((msg_timeout(p.provider, tope.as_secs()), false));
        }
    }
    let estado = child
        .wait()
        .map_err(|e| (format!("esperando a {}: {e}", p.provider), false))?;
    let stderr = err_hilo
        .and_then(|h| h.join().ok())
        .unwrap_or_default()
        .trim()
        .to_string();

    if parado {
        let t = texto.trim().to_string();
        return if t.is_empty() {
            Err(("parado".into(), false))
        } else {
            Ok(Respuesta {
                texto: t,
                sesion,
                consumo,
            })
        };
    }
    if p.provider == "antigravity" && cierre.is_none() && texto.trim().is_empty() {
        // Una version de agy sin `stream-json` contesta con un solo objeto.
        match leer_json_agy(&crudo) {
            Ok(r) => {
                crate::maria::flujo::trozo(p.clave, p.provider, &r.texto, false);
                return Ok(r);
            }
            Err(e) => cierre = Some(Err(e)),
        }
    }
    let salida = match cierre {
        Some(Ok(t)) if !t.is_empty() => t,
        Some(Err(e)) => {
            let cuota = is_quota_error(&e);
            return Err((recorta(&e, 300), cuota));
        }
        _ => texto.trim().to_string(),
    };
    if estado.success() && !salida.is_empty() {
        return Ok(Respuesta {
            texto: salida,
            sesion,
            consumo,
        });
    }
    let motivo = if stderr.is_empty() { salida } else { stderr };
    let cuota = is_quota_error(&motivo);
    Err((recorta(&motivo, 300), cuota))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sin_adjuntos() -> Adjuntos {
        Adjuntos::default()
    }

    #[test]
    fn en_claude_y_antigravity_la_p_va_la_ultima_bandera() {
        let aj = Ajustes::default();
        let c = argumentos(
            "claude",
            "sonnet",
            "medio",
            &aj,
            None,
            &sin_adjuntos(),
            &Sesion::Ninguna,
            "",
        );
        assert_eq!(c.last().map(String::as_str), Some("-p"));
        let a = argumentos(
            "antigravity",
            "",
            "medio",
            &aj,
            None,
            &sin_adjuntos(),
            &Sesion::Ninguna,
            "hola",
        );
        assert_eq!(&a[a.len() - 2..], ["-p", "hola"]);
    }

    #[test]
    fn el_acceso_total_cambia_las_banderas_de_los_tres() {
        let total = Ajustes {
            acceso_total: true,
            ..Ajustes::default()
        };
        let no = Ajustes::default();
        let tiene = |v: &[String], x: &str| v.iter().any(|a| a == x);
        let cx = |aj: &Ajustes| {
            argumentos(
                "codex",
                "",
                "medio",
                aj,
                None,
                &sin_adjuntos(),
                &Sesion::Ninguna,
                "",
            )
        };
        assert!(tiene(
            &cx(&total),
            "--dangerously-bypass-approvals-and-sandbox"
        ));
        assert!(tiene(&cx(&no), "sandbox_mode=\"read-only\""));
        assert!(!tiene(
            &cx(&no),
            "--dangerously-bypass-approvals-and-sandbox"
        ));
        let cl = argumentos(
            "claude",
            "",
            "medio",
            &total,
            None,
            &sin_adjuntos(),
            &Sesion::Ninguna,
            "",
        );
        assert!(tiene(&cl, "--dangerously-skip-permissions"));
        let ag = argumentos(
            "antigravity",
            "",
            "medio",
            &no,
            None,
            &sin_adjuntos(),
            &Sesion::Ninguna,
            "x",
        );
        assert!(!tiene(&ag, "--dangerously-skip-permissions"));
    }

    #[test]
    fn reanudar_usa_el_dialecto_de_cada_una() {
        let aj = Ajustes::default();
        let s = Sesion::Reanudar("abc".into());
        let c = argumentos("claude", "", "medio", &aj, None, &sin_adjuntos(), &s, "");
        assert!(c.windows(2).any(|w| w == ["--resume", "abc"]));
        let x = argumentos("codex", "", "medio", &aj, None, &sin_adjuntos(), &s, "");
        assert_eq!(&x[..4], ["exec", "resume", "abc", "-"]);
        let g = argumentos(
            "antigravity",
            "",
            "medio",
            &aj,
            None,
            &sin_adjuntos(),
            &s,
            "x",
        );
        assert!(g.windows(2).any(|w| w == ["--conversation", "abc"]));
        // Solo Claude deja elegir el identificador al empezar.
        let n = argumentos(
            "claude",
            "",
            "medio",
            &aj,
            None,
            &sin_adjuntos(),
            &Sesion::Nueva("u".into()),
            "",
        );
        assert!(n.windows(2).any(|w| w == ["--session-id", "u"]));
    }

    #[test]
    fn el_modo_ligero_usa_los_mcp_elegidos_si_los_hay() {
        let h = std::path::Path::new("hooks.json");
        let vacio = std::path::Path::new("vacio.json");
        let aj = Ajustes {
            ligero: true,
            mcp_config: Some(PathBuf::from("chat.json")),
            ..Ajustes::default()
        };
        let a = argumentos(
            "claude",
            "",
            "medio",
            &aj,
            Some((h, vacio)),
            &sin_adjuntos(),
            &Sesion::Ninguna,
            "",
        );
        assert!(a.windows(2).any(|w| w == ["--mcp-config", "chat.json"]));
        let sin = Ajustes {
            ligero: true,
            ..Ajustes::default()
        };
        let b = argumentos(
            "claude",
            "",
            "medio",
            &sin,
            Some((h, vacio)),
            &sin_adjuntos(),
            &Sesion::Ninguna,
            "",
        );
        assert!(b.windows(2).any(|w| w == ["--mcp-config", "vacio.json"]));
    }

    #[test]
    fn las_imagenes_de_codex_no_se_comen_el_prompt() {
        let adj = Adjuntos {
            rutas: vec![PathBuf::from("C:/x/a.png")],
        };
        let x = argumentos(
            "codex",
            "",
            "medio",
            &Ajustes::default(),
            None,
            &adj,
            &Sesion::Ninguna,
            "",
        );
        let i = x.iter().position(|a| a == "-i").unwrap();
        let guion = x.iter().position(|a| a == "-").unwrap();
        assert!(
            guion < i,
            "el `-` del prompt va antes de la bandera variadica"
        );
        assert!(
            x[i + 2].starts_with('-'),
            "tras la imagen viene otra bandera"
        );
    }

    #[test]
    fn una_linea_de_streaming_de_claude_da_solo_el_texto_nuevo() {
        let linea = r#"{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hola"}}}"#;
        assert_eq!(leer_linea_claude(linea), (Some("Hola".into()), None));
        let piensa = r#"{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","text":"mmm"}}}"#;
        assert_eq!(leer_linea_claude(piensa), (None, None));
        let mal = r#"{"type":"result","is_error":true,"result":"Claude usage limit reached"}"#;
        assert_eq!(
            leer_linea_claude(mal),
            (None, Some(Err("Claude usage limit reached".into())))
        );
        assert_eq!(leer_linea_claude("no es json"), (None, None));
    }

    #[test]
    fn codex_da_sesion_texto_y_error() {
        // Lineas reales de codex-cli 0.155.1 (2026-09-21).
        assert_eq!(
            leer_linea_codex(r#"{"type":"thread.started","thread_id":"01a0"}"#),
            EventoCodex::Sesion("01a0".into())
        );
        assert_eq!(
            leer_linea_codex(
                r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"uno"}}"#
            ),
            EventoCodex::Texto("uno".into())
        );
        // Un razonamiento o una orden ejecutada no son respuesta.
        assert_eq!(
            leer_linea_codex(
                r#"{"type":"item.completed","item":{"type":"reasoning","text":"pienso"}}"#
            ),
            EventoCodex::Nada
        );
        assert_eq!(
            leer_linea_codex(r#"{"type":"error","message":"usage limit"}"#),
            EventoCodex::Error("usage limit".into())
        );
        assert_eq!(
            leer_linea_codex(r#"{"type":"turn.started"}"#),
            EventoCodex::Nada
        );
    }

    #[test]
    fn se_cuenta_que_herramienta_esta_usando() {
        let tool = r#"{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Read","input":{}}}}"#;
        assert_eq!(actividad_claude(tool), Some("usando Read".into()));
        let texto = r#"{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"text","text":""}}}"#;
        assert_eq!(actividad_claude(texto), None);
        assert_eq!(
            leer_linea_codex(
                r#"{"type":"item.started","item":{"type":"command_execution","command":"git status"}}"#
            ),
            EventoCodex::Actividad("ejecutando: git status".into())
        );
    }

    #[test]
    fn antigravity_en_streaming_da_conversacion_texto_y_cierre() {
        // Lineas reales de `agy --output-format stream-json` (2026-09-21).
        assert_eq!(
            leer_linea_agy(r#"{"event":"init","conversation_id":"a810","init":{"cwd":"C:\\x"}}"#),
            EventoAgy::Sesion("a810".into())
        );
        assert_eq!(
            leer_linea_agy(
                r#"{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"1\n2"}}"#
            ),
            EventoAgy::Texto("1\n2".into())
        );
        assert_eq!(
            leer_linea_agy(
                r#"{"event":"step_update","step_update":{"state":"DONE","step_type":"user_input"}}"#
            ),
            EventoAgy::Nada
        );
        assert_eq!(
            leer_linea_agy(
                r#"{"event":"step_update","step_update":{"state":"ACTIVE","step_type":"run_command"}}"#
            ),
            EventoAgy::Actividad("run command".into())
        );
        assert_eq!(
            leer_linea_agy(
                r#"{"event":"result","result":{"status":"SUCCESS","response":"uno\n"}}"#
            ),
            EventoAgy::Fin(Ok("uno".into()))
        );
        assert!(matches!(
            leer_linea_agy(r#"{"event":"result","result":{"status":"ERROR","response":""}}"#),
            EventoAgy::Fin(Err(_))
        ));
    }

    #[test]
    fn antigravity_devuelve_respuesta_y_conversacion_o_el_motivo() {
        // Salida real de agy (2026-09-21).
        let ok =
            r#"{"conversation_id":"78c0","status":"SUCCESS","response":"uno\n","num_turns":1}"#;
        assert_eq!(
            leer_json_agy(ok),
            Ok(Respuesta {
                texto: "uno".into(),
                sesion: Some("78c0".into()),
                // agy no publica consumo en una salida que se haya podido
                // verificar: se queda vacio, no se estima.
                consumo: Consumo::default(),
            })
        );
        assert!(leer_json_agy(r#"{"status":"ERROR","response":""}"#).is_err());
        assert!(leer_json_agy("jetski: no output produced").is_err());
    }

    #[test]
    fn de_claude_salen_tokens_y_coste_de_su_linea_de_cierre() {
        // Forma real de la linea `result` del stream-json (CLI 2.1.278): la
        // entrada viene en tres cubos DISJUNTOS y la propia CLI los suma asi
        // para su barra de contexto.
        let fin = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":12400,"result":"hola","total_cost_usd":0.0312,"usage":{"input_tokens":120,"cache_creation_input_tokens":800,"cache_read_input_tokens":7200,"output_tokens":1200}}"#;
        assert_eq!(
            consumo_claude(fin),
            Some(Consumo {
                tokens_in: Some(8120),
                tokens_out: Some(1200),
                coste_usd: Some(0.0312),
            })
        );
        // Casos negativos: una linea de texto en curso no cierra nada, y un
        // cierre SIN usage no se rellena con ceros — se queda sin dato.
        assert_eq!(
            consumo_claude(r#"{"type":"stream_event","event":{"delta":{"text":"hola"}}}"#),
            None
        );
        assert_eq!(consumo_claude(r#"{"type":"result","result":"hola"}"#), None);
        assert_eq!(consumo_claude("no es json"), None);
    }

    #[test]
    fn de_codex_salen_tokens_pero_nunca_un_coste() {
        // `TurnCompletedEvent` del binario de codex: usage con input/output y
        // el trozo cacheado APARTE, que es parte de la entrada y no se suma.
        let fin = r#"{"type":"turn.completed","usage":{"input_tokens":4300,"cached_input_tokens":4000,"cache_write_input_tokens":0,"output_tokens":210,"reasoning_output_tokens":80}}"#;
        let c = consumo_codex(fin).expect("turn.completed trae usage");
        assert_eq!(c.tokens_in, Some(4300));
        assert_eq!(c.tokens_out, Some(210));
        assert_eq!(
            c.coste_usd, None,
            "codex no publica coste: no se estima con tarifas que caducan"
        );
        // Caso negativo: el evento de fin de otro proveedor no cuela.
        assert_eq!(consumo_codex(r#"{"type":"result","usage":{}}"#), None);
        assert_eq!(consumo_codex(r#"{"type":"item.completed"}"#), None);
    }
}
