// mar.ia — artefactos: lo que la IA genera para VERSE, no para leerse.
//
// Una pagina HTML, un SVG o un prototipo con su JavaScript. En el chat son un
// bloque de codigo; en el panel de artefactos son la cosa funcionando.
//
// POR QUE UN SERVIDOR Y NO UN `srcdoc`. La ventana de mar.ia tiene una CSP
// estricta (`script-src 'self'`) y un `iframe` con `srcdoc` o `blob:` la HEREDA:
// el HTML se pintaria, pero ninguno de sus scripts correria, que es justo lo que
// distingue un artefacto de una captura. Servido desde otro origen
// (`http://127.0.0.1:<puerto>`) el documento trae su propia politica, y el
// `iframe` lo encierra con `sandbox="allow-scripts"`: puede ejecutar su codigo,
// pero no tocar la aplicacion, ni sus comandos, ni el disco.
//
// Lo que sirve: SOLO documentos que el chat ha registrado, por un identificador
// aleatorio, y solo en la interfaz local. No lista nada, no lee ficheros, no
// acepta mas que GET. Los 24 mas recientes; el resto se olvida.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use tiny_http::{Header, Response, Server};

const MAX_ARTEFACTOS: usize = 24;
/// Un artefacto es una pagina, no un volcado: mas que esto es un error.
const MAX_BYTES: usize = 4 * 1024 * 1024;

static DOCS: Mutex<VecDeque<(String, String)>> = Mutex::new(VecDeque::new());
static PUERTO: OnceLock<u16> = OnceLock::new();

fn arrancar() -> Result<u16, String> {
    if let Some(p) = PUERTO.get() {
        return Ok(*p);
    }
    let server = Server::http("127.0.0.1:0").map_err(|e| format!("servidor de artefactos: {e}"))?;
    let puerto = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("servidor de artefactos sin puerto")?;
    if PUERTO.set(puerto).is_err() {
        // Otro hilo gano la carrera: se usa el suyo y este se suelta.
        return Ok(*PUERTO.get().unwrap_or(&puerto));
    }
    std::thread::spawn(move || {
        for req in server.incoming_requests() {
            let id = req.url().trim_start_matches("/a/").to_string();
            let doc = (req.method() == &tiny_http::Method::Get && req.url().starts_with("/a/"))
                .then(|| {
                    DOCS.lock()
                        .ok()
                        .and_then(|d| d.iter().find(|(k, _)| *k == id).map(|(_, v)| v.clone()))
                })
                .flatten();
            let _ = match doc {
                Some(html) => {
                    let mut r = Response::from_string(html);
                    for (k, v) in [
                        ("Content-Type", "text/html; charset=utf-8"),
                        ("X-Content-Type-Options", "nosniff"),
                        ("Cache-Control", "no-store"),
                    ] {
                        if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                            r.add_header(h);
                        }
                    }
                    req.respond(r)
                }
                None => req.respond(Response::from_string("no existe").with_status_code(404)),
            };
        }
    });
    Ok(puerto)
}

/// Documento completo para un artefacto. `svg` se centra en una pagina minima;
/// `html` va tal cual (si ya es un documento) o envuelto. Pura.
#[must_use]
pub fn documento(tipo: &str, contenido: &str) -> String {
    let c = contenido.trim();
    let bajo = c.to_lowercase();
    if tipo == "html" && (bajo.starts_with("<!doctype") || bajo.starts_with("<html")) {
        return c.to_string();
    }
    let cuerpo = if tipo == "svg" {
        format!(
            "<body style=\"margin:0;display:grid;place-items:center;min-height:100vh;background:#fff\">{c}</body>"
        )
    } else {
        format!("<body>{c}</body>")
    };
    format!("<!doctype html><html><head><meta charset=\"utf-8\"></head>{cuerpo}</html>")
}

pub fn publicar(tipo: &str, contenido: &str) -> Result<String, String> {
    if contenido.len() > MAX_BYTES {
        return Err("el artefacto pasa de 4 MB".into());
    }
    let puerto = arrancar()?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let mut d = DOCS.lock().map_err(|_| "artefactos: cerrojo roto")?;
    d.push_back((id.clone(), documento(tipo, contenido)));
    while d.len() > MAX_ARTEFACTOS {
        d.pop_front();
    }
    Ok(format!("http://127.0.0.1:{puerto}/a/{id}"))
}

#[tauri::command]
pub async fn maria_artefacto_publicar(tipo: String, contenido: String) -> Result<String, String> {
    publicar(&tipo, &contenido)
}

/// Guarda el artefacto en la carpeta de trabajo de la conversacion.
#[tauri::command]
pub async fn maria_artefacto_guardar(
    thread_id: String,
    nombre: String,
    contenido: String,
) -> Result<String, String> {
    let dir = super::relay::carpeta_de_trabajo(&thread_id)?;
    let ruta = dir.join(super::adjuntos::nombre_seguro(&nombre));
    std::fs::write(&ruta, contenido).map_err(|e| format!("guardar artefacto: {e}"))?;
    Ok(ruta.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_documento_completo_no_se_envuelve() {
        let d = "<!DOCTYPE html><html><body>hola</body></html>";
        assert_eq!(documento("html", d), d);
    }

    #[test]
    fn un_fragmento_y_un_svg_se_envuelven() {
        assert!(documento("html", "<h1>hola</h1>").starts_with("<!doctype html>"));
        let s = documento("svg", "<svg></svg>");
        assert!(s.contains("place-items:center") && s.contains("<svg></svg>"));
    }

    #[test]
    fn se_publica_en_local_y_se_sirve_solo_lo_registrado() {
        let url = publicar("html", "<p>uno</p>").expect("publica");
        assert!(url.starts_with("http://127.0.0.1:"));
        let cuerpo = reqwest::blocking::get(&url).unwrap().text().unwrap();
        assert!(cuerpo.contains("<p>uno</p>"));
        let otro = format!("{}x", url);
        assert_eq!(reqwest::blocking::get(otro).unwrap().status().as_u16(), 404);
    }

    #[test]
    fn nunca_se_guardan_mas_que_los_ultimos() {
        for i in 0..(MAX_ARTEFACTOS + 5) {
            publicar("html", &format!("<p>{i}</p>")).unwrap();
        }
        assert!(DOCS.lock().unwrap().len() <= MAX_ARTEFACTOS);
    }
}
