// sesiones/exportar_html.rs — Documento HTML autocontenido de una
// conversación exportada (ver `exportar`).
//
// Todo el contenido del transcript se escapa: el texto va en párrafos con
// `white-space: pre-wrap` y los bloques con valla de Markdown (```), en
// `<pre><code>`. No se interpreta ningún otro Markdown ni HTML del
// transcript. La CSP del documento prohíbe scripts y recursos externos; el
// CSS va en línea y sigue el tema claro u oscuro del sistema.

use super::exportar::{hora_legible, nombre_hablante, Cabecera, Entrada, Hablante};

const CSS: &str = r#":root{color-scheme:light dark;--bg:#fafafa;--fg:#1d1d1f;--muted:#6b6b70;--card:#fff;--line:#e3e3e6;--user:#eef4ff;--code:#f2f2f4;--accent:#b4232c}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#e8e8ea;--muted:#9a9aa1;--card:#1d1d20;--line:#2c2c31;--user:#1b2433;--code:#0f0f11;--accent:#ff5a63}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:1.5rem;margin:0 0 12px}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0 0 28px;color:var(--muted);font-size:.9rem}
dl.meta dt{font-weight:600}dl.meta dd{margin:0;word-break:break-all}
section.turno{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:14px 0}
section.usuario{background:var(--user)}
section h2{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:0 0 6px}
p.txt{white-space:pre-wrap;word-wrap:break-word;margin:.4em 0}
pre{background:var(--code);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow-x:auto;font:13px/1.45 ui-monospace,Consolas,monospace}
p.tool{margin:.3em 0;color:var(--muted);font-size:.88rem}
p.tool b{color:var(--fg)}
p.tool code,dd code{font:12.5px ui-monospace,Consolas,monospace}
p.nota{color:var(--muted);font-style:italic;text-align:center;margin:18px 0}
p.cmd code{color:var(--accent)}"#;

/// Escapa los cinco caracteres especiales de HTML.
pub fn escapar(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + s.len() / 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Párrafo de texto escapado; vacío si solo hay espacios.
fn parrafo(lineas: &[&str]) -> String {
    let t = lineas.join("\n");
    if t.trim().is_empty() {
        return String::new();
    }
    format!("<p class=\"txt\">{}</p>\n", escapar(t.trim_matches('\n')))
}

/// Texto de un mensaje: párrafos y bloques de código con valla (```).
pub fn cuerpo(texto: &str) -> String {
    let mut out = String::new();
    let mut prosa: Vec<&str> = Vec::new();
    let mut codigo: Option<(String, Vec<&str>)> = None;
    for linea in texto.lines() {
        let valla = linea.trim_start().strip_prefix("```");
        match (&mut codigo, valla) {
            (None, Some(lang)) => {
                out.push_str(&parrafo(&prosa));
                prosa.clear();
                codigo = Some((lang.trim().to_string(), Vec::new()));
            }
            (Some((lang, cod)), Some(_)) => {
                out.push_str(&bloque(lang, cod));
                codigo = None;
            }
            (Some((_, cod)), None) => cod.push(linea),
            (None, None) => prosa.push(linea),
        }
    }
    // Una valla sin cerrar sigue siendo código.
    if let Some((lang, cod)) = &codigo {
        out.push_str(&bloque(lang, cod));
    }
    out.push_str(&parrafo(&prosa));
    out
}

fn bloque(lang: &str, lineas: &[&str]) -> String {
    let clase: String = lang
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+'))
        .collect();
    let attr = if clase.is_empty() {
        String::new()
    } else {
        format!(" class=\"language-{clase}\"")
    };
    format!(
        "<pre><code{attr}>{}</code></pre>\n",
        escapar(&lineas.join("\n"))
    )
}

fn cabecera(c: &Cabecera) -> String {
    let mut filas = vec![
        ("Proyecto", escapar(&c.proyecto)),
        ("Directorio", format!("<code>{}</code>", escapar(&c.cwd))),
    ];
    if let Some(m) = &c.modelo {
        filas.push(("Modelo", format!("<code>{}</code>", escapar(m))));
    }
    if let Some(i) = &c.inicio {
        filas.push(("Inicio", escapar(&hora_legible(i))));
    }
    filas.push(("Exportado", escapar(&c.exportado)));
    let dl: String = filas
        .into_iter()
        .map(|(k, v)| format!("<dt>{k}</dt><dd>{v}</dd>"))
        .collect();
    format!(
        "<h1>{}</h1>\n<dl class=\"meta\">{dl}</dl>\n",
        escapar(c.titulo.trim())
    )
}

/// Acumula las entradas en secciones por hablante.
#[derive(Default)]
struct Lienzo {
    html: String,
    abierto: Option<Hablante>,
}

impl Lienzo {
    fn cerrar(&mut self) {
        if self.abierto.take().is_some() {
            self.html.push_str("</section>\n");
        }
    }

    fn seccion(&mut self, h: Hablante, hora: Option<&str>) {
        if self.abierto == Some(h) {
            return;
        }
        self.cerrar();
        let clase = match h {
            Hablante::Usuario => "usuario",
            Hablante::Asistente => "asistente",
        };
        let hora = hora
            .map(|t| format!(" · {}", escapar(t)))
            .unwrap_or_default();
        self.html.push_str(&format!(
            "<section class=\"turno {clase}\"><h2>{}{hora}</h2>\n",
            nombre_hablante(h)
        ));
        self.abierto = Some(h);
    }

    fn entrada(&mut self, e: &Entrada) {
        match e {
            Entrada::Texto {
                hablante,
                hora,
                texto,
            } => {
                self.seccion(*hablante, Some(hora));
                self.html.push_str(&cuerpo(texto));
            }
            Entrada::Herramienta { nombre, objetivo } => {
                self.seccion(Hablante::Asistente, None);
                let obj = if objetivo.is_empty() {
                    String::new()
                } else {
                    format!(": <code>{}</code>", escapar(objetivo))
                };
                self.html.push_str(&format!(
                    "<p class=\"tool\">Herramienta <b>{}</b>{obj}</p>\n",
                    escapar(nombre)
                ));
            }
            Entrada::Comando { hora, linea } => {
                self.cerrar();
                self.html.push_str(&format!(
                    "<section class=\"turno\"><h2>Comando · {}</h2><p class=\"cmd\"><code>{}</code></p></section>\n",
                    escapar(hora),
                    escapar(linea)
                ));
            }
            Entrada::Nota { texto } => {
                self.cerrar();
                self.html
                    .push_str(&format!("<p class=\"nota\">{}</p>\n", escapar(texto)));
            }
        }
    }
}

/// Documento HTML completo.
pub fn html(c: &Cabecera, entradas: &[Entrada]) -> String {
    let mut lienzo = Lienzo::default();
    for e in entradas {
        lienzo.entrada(e);
    }
    lienzo.cerrar();
    format!(
        "<!DOCTYPE html>\n<html lang=\"es\">\n<head>\n<meta charset=\"utf-8\">\n\
<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">\n\
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
<title>{}</title>\n<style>{CSS}</style>\n</head>\n<body>\n<main>\n{}{}</main>\n</body>\n</html>\n",
        escapar(c.titulo.trim()),
        cabecera(c),
        lienzo.html
    )
}
