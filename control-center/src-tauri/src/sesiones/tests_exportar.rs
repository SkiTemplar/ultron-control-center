// sesiones/tests_exportar.rs — Tests de la exportación de conversaciones:
// Markdown y HTML a partir de un transcript sintético, escape del contenido,
// herramientas resumidas en una línea y validación del destino.

use super::*;

const RESULTADO_LARGO: &str = "SALIDA-DE-HERRAMIENTA-QUE-NO-DEBE-SALIR";

fn transcript_de_prueba() -> String {
    let lineas = [
        r#"{"type":"user","uuid":"u1","timestamp":"2026-10-15T08:00:00Z","message":{"role":"user","content":"Hola <script>alert(1)</script> & adiós"}}"#.to_string(),
        r#"{"type":"assistant","uuid":"a1","timestamp":"2026-10-15T08:00:05Z","message":{"id":"m1","role":"assistant","model":"claude-opus-5-5","content":[{"type":"text","text":"Mira:\n```html\n<script>robar()</script>\n```\nListo."}]}}"#.to_string(),
        r#"{"type":"assistant","uuid":"a2","timestamp":"2026-10-15T08:00:06Z","message":{"id":"m2","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cargo test --lib\necho segunda"}}]}}"#.to_string(),
        format!(
            r#"{{"type":"user","uuid":"r1","timestamp":"2026-10-15T08:00:09Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t1","content":"{RESULTADO_LARGO}"}}]}}}}"#
        ),
        r#"{"type":"assistant","uuid":"a3","timestamp":"2026-10-15T08:00:10Z","message":{"id":"m3","role":"assistant","content":[{"type":"text","text":"Tests en verde."}]}}"#.to_string(),
    ];
    lineas.join("\n") + "\n"
}

fn mensajes() -> Vec<ChatMessage> {
    let dir = tempfile::tempdir().expect("tempdir");
    let p = dir.path().join("t.jsonl");
    std::fs::write(&p, transcript_de_prueba()).expect("escribir");
    transcript::parse_fichero(&p, None).expect("parse")
}

fn cabecera() -> Cabecera {
    Cabecera {
        titulo: "Prueba <b>de</b> exportación".into(),
        proyecto: "ULTRON".into(),
        cwd: r"C:\proy\ultron".into(),
        modelo: Some("claude-opus-5-5".into()),
        inicio: Some("2026-10-15T08:00:00Z".into()),
        exportado: "2026-10-15 10:00".into(),
    }
}

#[test]
fn las_herramientas_quedan_en_una_linea_sin_resultado() {
    let e = entradas(&mensajes());
    let tools: Vec<_> = e
        .iter()
        .filter_map(|x| match x {
            Entrada::Herramienta { nombre, objetivo } => Some((nombre.as_str(), objetivo.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(tools, vec![("Bash", "cargo test --lib")]);
    let md = markdown(&cabecera(), &e);
    assert!(
        !md.contains(RESULTADO_LARGO),
        "volcó el resultado de la herramienta"
    );
    assert!(md.contains("> Herramienta **Bash**: `cargo test --lib`"));
}

#[test]
fn markdown_lleva_cabecera_y_ambos_hablantes() {
    let md = generar(&cabecera(), &mensajes(), Formato::Md);
    assert!(md.starts_with("# Prueba <b>de</b> exportación\n"));
    assert!(md.contains("- **Proyecto:** ULTRON"));
    assert!(md.contains(r"- **Directorio:** `C:\proy\ultron`"));
    assert!(md.contains("- **Modelo:** `claude-opus-5-5`"));
    assert!(md.contains("## Usuario · "));
    assert!(md.contains("## Claude · "));
    assert!(md.contains("```html\n<script>robar()</script>\n```"));
    assert!(md.contains("Tests en verde."));
    // Las respuestas seguidas del asistente comparten encabezado.
    assert_eq!(md.matches("## Claude").count(), 1);
}

#[test]
fn html_escapa_todo_el_contenido_del_transcript() {
    let html = generar(&cabecera(), &mensajes(), Formato::Html);
    assert!(
        !html.contains("<script>"),
        "HTML del transcript sin escapar"
    );
    assert!(!html.contains("<b>de</b>"), "título sin escapar");
    assert!(html.contains("Hola &lt;script&gt;alert(1)&lt;/script&gt; &amp; adiós"));
    assert!(html.contains(
        "<pre><code class=\"language-html\">&lt;script&gt;robar()&lt;/script&gt;</code></pre>"
    ));
    assert!(html.contains("Herramienta <b>Bash</b>: <code>cargo test --lib</code>"));
    assert!(!html.contains(RESULTADO_LARGO));
    assert!(html.contains("Content-Security-Policy"));
    assert!(html.contains("prefers-color-scheme:dark"));
}

#[test]
fn el_escape_cubre_comillas_y_atributos() {
    assert_eq!(
        exportar_html::escapar(r#"<a href="x" onclick='y'>&</a>"#),
        "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;"
    );
    // Un lenguaje de valla malicioso no rompe el atributo.
    let c = exportar_html::cuerpo("```js\" onload=\"x\nhola\n```");
    assert!(c.starts_with("<pre><code class=\"language-jsonloadx\">hola</code></pre>"));
}

#[test]
fn una_valla_sin_cerrar_sigue_siendo_codigo() {
    let c = exportar_html::cuerpo("antes\n```\n<i>x</i>");
    assert!(c.contains("<p class=\"txt\">antes</p>"));
    assert!(c.contains("<pre><code>&lt;i&gt;x&lt;/i&gt;</code></pre>"));
}

#[test]
fn el_nombre_por_defecto_es_proyecto_y_fecha() {
    assert_eq!(
        nombre_por_defecto("Mi proyecto/raro", "2026-10-15", Formato::Md),
        "Mi-proyecto-raro-2026-10-15.md"
    );
    assert_eq!(
        nombre_por_defecto("***", "2026-10-15", Formato::Html),
        "conversacion-2026-10-15.html"
    );
}

#[test]
fn el_destino_valido_se_acepta() {
    let dir = tempfile::tempdir().expect("tempdir");
    let p = dir.path().join("conv.md");
    assert_eq!(validar_destino(&p, Formato::Md), Ok(p.clone()));
    let h = dir.path().join("conv.HTML");
    assert!(validar_destino(&h, Formato::Html).is_ok());
}

#[test]
fn el_destino_invalido_se_rechaza() {
    let dir = tempfile::tempdir().expect("tempdir");
    let err = |p: &Path, f| validar_destino(p, f).expect_err("debía rechazarse");
    assert!(err(Path::new("conv.md"), Formato::Md).contains("no absoluta"));
    assert!(err(&dir.path().join("conv.txt"), Formato::Md).contains(".md"));
    assert!(err(&dir.path().join("conv.md"), Formato::Html).contains(".html"));
    assert!(err(&dir.path().join("sub").join("..").join("c.md"), Formato::Md).contains(".."));
    assert!(err(&dir.path().join("no-existe").join("c.md"), Formato::Md).contains("carpeta"));
    let carpeta = dir.path().join("carpeta.md");
    std::fs::create_dir(&carpeta).expect("mkdir");
    assert!(err(&carpeta, Formato::Md).contains("carpeta"));
}

#[test]
fn el_formato_llega_en_minusculas_por_el_cable() {
    let f: Formato = serde_json::from_str("\"html\"").expect("html");
    assert_eq!(f, Formato::Html);
    assert!(serde_json::from_str::<Formato>("\"pdf\"").is_err());
}
