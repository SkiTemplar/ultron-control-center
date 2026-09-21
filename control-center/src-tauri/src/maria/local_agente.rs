// mar.ia — el modelo local, con manos.
//
// Hasta el 2026-09-21 el local solo sabia hablar: Claude, Codex y Antigravity
// abren ficheros y lanzan ordenes por su cuenta y el no. Pedido del usuario:
// "que todos los agentes, desde claude hasta el local, tengan acceso completo al
// pc y sus archivos". Con `acceso_total` recibe herramientas por la API de
// Ollama y se le deja encadenarlas; sin el, contesta a secas como siempre.
//
// Un modelo de 9B con una terminal es la pieza mas delicada del sistema, asi
// que lleva tres cinturones que las CLI grandes no necesitan:
//   * una lista corta de ordenes que no se ejecutan NUNCA (`orden_peligrosa`);
//   * tope de tiempo y de salida por orden, y de vueltas por turno;
//   * cada uso de herramienta se cuenta en la pantalla mientras ocurre.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::relay::{recorta, Adjuntos};

/// Tiempo maximo de una respuesta. Mas largo que el de las CLI: es el ultimo
/// recurso y una respuesta larga a 60 tokens/s pasa de tres minutos sin colgarse.
const TIMEOUT_LOCAL: Duration = Duration::from_secs(600);
/// Vueltas de herramienta por turno. Un modelo pequeño puede entrar en bucle.
const MAX_VUELTAS: usize = 8;
/// Lo que se le devuelve de cada herramienta, como mucho.
const MAX_SALIDA: usize = 6_000;
/// Lo que puede tardar una orden de terminal.
const TIMEOUT_ORDEN: Duration = Duration::from_secs(60);

/// Por que no se ejecuta esta orden, o None si se puede. Pura.
///
/// No es una caja de arena: es un freno para los errores que no tienen vuelta
/// atras. Todo lo demas esta permitido, que para eso es acceso total.
#[must_use]
pub fn orden_peligrosa(orden: &str) -> Option<&'static str> {
    let o = orden.to_lowercase();
    let compacta: String = o.split_whitespace().collect::<Vec<_>>().join(" ");
    const VETADAS: &[(&str, &str)] = &[
        ("format-volume", "formatear un volumen"),
        ("format c:", "formatear un volumen"),
        ("diskpart", "particionar discos"),
        ("bcdedit", "tocar el arranque de Windows"),
        ("clear-disk", "vaciar un disco"),
        (
            "remove-item -recurse -force c:\\",
            "borrar la raiz del disco",
        ),
        ("remove-item c:\\ ", "borrar la raiz del disco"),
        ("rd /s /q c:\\", "borrar la raiz del disco"),
        ("rmdir /s /q c:\\", "borrar la raiz del disco"),
        ("del /s /q c:\\", "borrar la raiz del disco"),
        ("reg delete hklm", "borrar claves del registro del sistema"),
        ("cipher /w", "sobrescribir el espacio libre"),
        ("shutdown", "apagar o reiniciar el equipo"),
        ("restart-computer", "apagar o reiniciar el equipo"),
        ("stop-computer", "apagar o reiniciar el equipo"),
    ];
    VETADAS
        .iter()
        .find(|(patron, _)| compacta.contains(patron))
        .map(|(_, motivo)| *motivo)
}

fn herramientas() -> serde_json::Value {
    let f = |nombre: &str, para: &str, props: serde_json::Value, req: &[&str]| {
        serde_json::json!({
            "type": "function",
            "function": {
                "name": nombre,
                "description": para,
                "parameters": { "type": "object", "properties": props, "required": req }
            }
        })
    };
    serde_json::json!([
        f(
            "leer_fichero",
            "Lee un fichero de texto del equipo.",
            serde_json::json!({ "ruta": { "type": "string", "description": "ruta absoluta o relativa a la carpeta de trabajo" } }),
            &["ruta"]
        ),
        f(
            "escribir_fichero",
            "Crea o sobrescribe un fichero de texto.",
            serde_json::json!({ "ruta": { "type": "string" }, "contenido": { "type": "string" } }),
            &["ruta", "contenido"]
        ),
        f(
            "listar_carpeta",
            "Lista el contenido de una carpeta.",
            serde_json::json!({ "ruta": { "type": "string" } }),
            &["ruta"]
        ),
        f(
            "ejecutar",
            "Ejecuta una orden de PowerShell y devuelve su salida.",
            serde_json::json!({ "orden": { "type": "string" } }),
            &["orden"]
        ),
        f(
            "recordar",
            "Busca en la memoria del usuario.",
            serde_json::json!({ "consulta": { "type": "string" } }),
            &["consulta"]
        ),
    ])
}

fn resolver(ruta: &str, base: Option<&Path>) -> PathBuf {
    let p = PathBuf::from(ruta);
    match base {
        Some(b) if p.is_relative() => b.join(p),
        _ => p,
    }
}

/// Ejecuta una herramienta y devuelve (lo que ve el usuario, lo que ve el modelo).
fn usar(nombre: &str, args: &serde_json::Value, base: Option<&Path>) -> (String, String) {
    let arg = |k: &str| {
        args.get(k)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    };
    match nombre {
        "leer_fichero" => {
            let p = resolver(&arg("ruta"), base);
            let r = std::fs::read_to_string(&p)
                .map(|t| recorta(&t, MAX_SALIDA))
                .unwrap_or_else(|e| format!("ERROR: no pude leer {}: {e}", p.display()));
            (format!("leyendo {}", p.display()), r)
        }
        "escribir_fichero" => {
            let p = resolver(&arg("ruta"), base);
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let r = match std::fs::write(&p, arg("contenido")) {
                Ok(()) => format!("escrito {}", p.display()),
                Err(e) => format!("ERROR: no pude escribir {}: {e}", p.display()),
            };
            (format!("escribiendo {}", p.display()), r)
        }
        "listar_carpeta" => {
            let p = resolver(&arg("ruta"), base);
            let r = match std::fs::read_dir(&p) {
                Ok(it) => {
                    let mut nombres: Vec<String> = it
                        .flatten()
                        .map(|e| {
                            let n = e.file_name().to_string_lossy().into_owned();
                            if e.path().is_dir() {
                                format!("{n}/")
                            } else {
                                n
                            }
                        })
                        .collect();
                    nombres.sort();
                    recorta(&nombres.join("\n"), MAX_SALIDA)
                }
                Err(e) => format!("ERROR: no pude listar {}: {e}", p.display()),
            };
            (format!("mirando {}", p.display()), r)
        }
        "ejecutar" => {
            let orden = arg("orden");
            if let Some(motivo) = orden_peligrosa(&orden) {
                return (
                    format!("orden rechazada ({motivo})"),
                    format!("RECHAZADA: mar.ia no ejecuta ordenes para {motivo}."),
                );
            }
            (
                format!("ejecutando: {}", recorta(&orden, 120)),
                ejecutar(&orden, base),
            )
        }
        "recordar" => {
            let r = super::relay::memoria_para(&arg("consulta"))
                .unwrap_or_else(|| "sin recuerdos sobre eso".into());
            ("consultando la memoria".into(), r)
        }
        otro => (
            format!("herramienta desconocida: {otro}"),
            format!("ERROR: no existe la herramienta {otro}"),
        ),
    }
}

fn ejecutar(orden: &str, base: Option<&Path>) -> String {
    let mut cmd = crate::proc::oculto("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", orden])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(b) = base.filter(|b| b.is_dir()) {
        cmd.current_dir(b);
    }
    let Ok(mut hijo) = cmd.spawn() else {
        return "ERROR: no pude lanzar PowerShell".into();
    };
    let inicio = std::time::Instant::now();
    loop {
        match hijo.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if inicio.elapsed() > TIMEOUT_ORDEN => {
                let _ = hijo.kill();
                return format!(
                    "ERROR: la orden paso de {} s y se corto",
                    TIMEOUT_ORDEN.as_secs()
                );
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(60)),
            Err(e) => return format!("ERROR: {e}"),
        }
    }
    match hijo.wait_with_output() {
        Ok(o) => {
            let mut t = String::from_utf8_lossy(&o.stdout).trim().to_string();
            let err = String::from_utf8_lossy(&o.stderr);
            if !err.trim().is_empty() {
                t.push_str(&format!("\n[stderr]\n{}", err.trim()));
            }
            if t.is_empty() {
                t = format!("(sin salida; codigo {})", o.status.code().unwrap_or(-1));
            }
            recorta(&t, MAX_SALIDA)
        }
        Err(e) => format!("ERROR: {e}"),
    }
}

/// Una vuelta contra Ollama en streaming. Devuelve (texto, llamadas a herramienta).
fn vuelta(
    clave: &str,
    mensajes: &[serde_json::Value],
    con_herramientas: bool,
    pensar: bool,
) -> Result<(String, Vec<serde_json::Value>), (String, bool)> {
    let mut body = serde_json::json!({
        "model": crate::ollama::toggle::model_name(),
        "stream": true,
        "think": pensar,
        "keep_alive": super::relay::keep_alive_respuesta(),
        "messages": mensajes,
        // SIN tope de salida: el limite honesto es la ventana de contexto.
        "options": { "num_ctx": 8192, "num_predict": -1 },
    });
    if con_herramientas {
        body["tools"] = herramientas();
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(TIMEOUT_LOCAL)
        .build()
        .map_err(|e| (format!("cliente http: {e}"), false))?;
    let resp = client
        .post("http://127.0.0.1:11434/api/chat")
        .json(&body)
        .send()
        .map_err(|e| (format!("ollama no responde: {e}"), false))?;

    let mut texto = String::new();
    let mut llamadas: Vec<serde_json::Value> = Vec::new();
    for linea in BufReader::new(resp).lines() {
        let Ok(linea) = linea else { break };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&linea) else {
            continue;
        };
        if let Some(e) = v.get("error").and_then(|e| e.as_str()) {
            return Err((format!("ollama: {}", recorta(e, 200)), false));
        }
        if let Some(d) = v.pointer("/message/content").and_then(|c| c.as_str()) {
            crate::maria::flujo::trozo(clave, "local", d, false);
            texto.push_str(d);
        }
        if let Some(tc) = v.pointer("/message/tool_calls").and_then(|t| t.as_array()) {
            llamadas.extend(tc.iter().cloned());
        }
        // Soltar `resp` cierra la conexion y Ollama deja de generar.
        if crate::maria::flujo::cancelado(clave)
            || v.get("done").and_then(serde_json::Value::as_bool) == Some(true)
        {
            break;
        }
    }
    Ok((texto, llamadas))
}

/// Respuesta del modelo local para `clave` (un hilo o un encargo).
pub fn responder(
    clave: &str,
    prompt: &str,
    effort: &str,
    adjuntos: &Adjuntos,
    acceso_total: bool,
    trabajo: Option<&Path>,
) -> Result<String, (String, bool)> {
    let pensar = crate::maria::models::razonar_en_local(effort);
    let mut mensajes: Vec<serde_json::Value> = Vec::new();
    if acceso_total {
        mensajes.push(serde_json::json!({
            "role": "system",
            "content": format!(
                "Eres mar.ia, un asistente que trabaja en el equipo del usuario. Tienes herramientas \
                 para leer y escribir ficheros, listar carpetas, ejecutar ordenes de PowerShell y \
                 consultar su memoria. Usalas cuando hagan falta y solo entonces; no inventes el \
                 contenido de un fichero que puedes abrir. {}Responde en el idioma del usuario.",
                trabajo.map_or_else(String::new, |d| format!(
                    "Tu carpeta de trabajo es {}; las rutas relativas parten de ahi. ",
                    d.display()
                ))
            ),
        }));
    }
    mensajes.push(serde_json::json!({
        "role": "user",
        "content": format!("{prompt}{}", if acceso_total { adjuntos.como_rutas() } else { adjuntos.como_texto() }),
    }));

    let mut total = String::new();
    for n in 0..MAX_VUELTAS {
        let (texto, llamadas) = vuelta(clave, &mensajes, acceso_total, pensar)?;
        total.push_str(&texto);
        if llamadas.is_empty() || crate::maria::flujo::cancelado(clave) {
            break;
        }
        mensajes.push(serde_json::json!({
            "role": "assistant", "content": texto, "tool_calls": llamadas,
        }));
        for ll in &llamadas {
            let nombre = ll
                .pointer("/function/name")
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let args = ll
                .pointer("/function/arguments")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            // Algunos modelos mandan los argumentos como cadena JSON.
            let args = match &args {
                serde_json::Value::String(s) => serde_json::from_str(s).unwrap_or(args.clone()),
                _ => args,
            };
            let (visible, salida) = usar(nombre, &args, trabajo);
            crate::maria::flujo::actividad(clave, "local", &visible);
            mensajes.push(serde_json::json!({
                "role": "tool", "tool_name": nombre, "content": salida,
            }));
        }
        if n + 1 == MAX_VUELTAS {
            total.push_str("\n\n_(me he parado tras ocho pasos con herramientas; dime si sigo)_");
        }
    }
    let total = total.trim().to_string();
    if total.is_empty() {
        let motivo = if crate::maria::flujo::cancelado(clave) {
            "parado"
        } else {
            "el modelo local devolvio una respuesta vacia"
        };
        return Err((motivo.into(), false));
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lo_irreversible_no_se_ejecuta_nunca() {
        for orden in [
            "Format-Volume -DriveLetter D",
            "Remove-Item  -Recurse -Force   C:\\",
            "rd /s /q C:\\",
            "shutdown /s /t 0",
            "reg delete HKLM\\Software\\X /f",
        ] {
            assert!(
                orden_peligrosa(orden).is_some(),
                "deberia rechazar: {orden}"
            );
        }
    }

    #[test]
    fn el_trabajo_normal_pasa() {
        for orden in [
            "Get-ChildItem C:\\Users",
            "git status",
            "Remove-Item .\\tmp\\salida.txt",
            "python script.py",
        ] {
            assert_eq!(orden_peligrosa(orden), None, "no deberia rechazar: {orden}");
        }
    }

    #[test]
    fn las_rutas_relativas_parten_de_la_carpeta_de_trabajo() {
        let base = Path::new("C:/trabajo");
        assert_eq!(
            resolver("notas.md", Some(base)),
            PathBuf::from("C:/trabajo/notas.md")
        );
        assert_eq!(
            resolver("D:/otro/x.txt", Some(base)),
            PathBuf::from("D:/otro/x.txt")
        );
        assert_eq!(resolver("x.txt", None), PathBuf::from("x.txt"));
    }

    #[test]
    fn una_herramienta_que_no_existe_se_dice() {
        let (_, salida) = usar("volar", &serde_json::Value::Null, None);
        assert!(salida.starts_with("ERROR"));
    }

    #[test]
    fn leer_un_fichero_que_no_esta_no_rompe_el_turno() {
        let (_, salida) = usar(
            "leer_fichero",
            &serde_json::json!({ "ruta": "Z:/no/existe.txt" }),
            None,
        );
        assert!(salida.starts_with("ERROR"));
    }
}
