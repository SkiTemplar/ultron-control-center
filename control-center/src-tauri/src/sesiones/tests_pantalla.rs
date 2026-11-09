// sesiones/tests_pantalla.rs — Clasificación de la pantalla con los fixtures
// grabados de la TUI real (`fixtures/tui/`, ver docs/sesiones/spikes-pty.md).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use super::*;

const FILAS: u16 = 48;
const COLS: u16 = 160;

fn fixture(nombre: &str) -> (&'static [u8], HashMap<String, usize>) {
    let (bytes, indice): (&'static [u8], &str) = match nombre {
        "sesion-a" => (
            include_bytes!("fixtures/tui/sesion-a.ans"),
            include_str!("fixtures/tui/sesion-a.json"),
        ),
        "sesion-b" => (
            include_bytes!("fixtures/tui/sesion-b.ans"),
            include_str!("fixtures/tui/sesion-b.json"),
        ),
        "confianza" => (
            include_bytes!("fixtures/tui/confianza.ans"),
            include_str!("fixtures/tui/confianza.json"),
        ),
        "resume" => (
            include_bytes!("fixtures/tui/resume.ans"),
            include_str!("fixtures/tui/resume.json"),
        ),
        "modelo" => (
            include_bytes!("fixtures/tui/modelo.ans"),
            include_str!("fixtures/tui/modelo.json"),
        ),
        "mcp-resize" => (
            include_bytes!("fixtures/tui/mcp-resize.ans"),
            include_str!("fixtures/tui/mcp-resize.json"),
        ),
        "segundo-plano" => (
            include_bytes!("fixtures/tui/segundo-plano.ans"),
            include_str!("fixtures/tui/segundo-plano.json"),
        ),
        otro => panic!("fixture desconocido: {otro}"),
    };
    (bytes, serde_json::from_str(indice).expect("índice"))
}

/// Pantalla tras procesar los bytes grabados hasta el corte `corte`.
fn pantalla(sesion: &str, corte: &str) -> Clasificacion {
    let (bytes, indice) = fixture(sesion);
    let n = *indice
        .get(corte)
        .unwrap_or_else(|| panic!("sin corte {corte}"));
    let mut p = vt100::Parser::new(FILAS, COLS, 0);
    p.process(&bytes[..n]);
    clasificar(p.screen())
}

use EstadoPantalla::{Busy, Dialog, Prompt, Trust};

/// (sesión, corte, estado, modo, entrada) de un fixture grabado.
type Fila = (
    &'static str,
    &'static str,
    EstadoPantalla,
    Option<&'static str>,
    Option<&'static str>,
);

const TABLA: &[Fila] = &[
    (
        "sesion-a",
        "prompt-vacio",
        Prompt,
        Some("bypassPermissions"),
        None,
    ),
    (
        "sesion-a",
        "prompt-texto",
        Prompt,
        Some("bypassPermissions"),
        Some("hola mundo"),
    ),
    (
        "sesion-a",
        "prompt-tras-ctrl-u",
        Prompt,
        Some("bypassPermissions"),
        None,
    ),
    (
        "sesion-b",
        "autocompletado-config",
        Prompt,
        Some("bypassPermissions"),
        Some("/config"),
    ),
    ("sesion-b", "config-abierto", Dialog, None, None),
    // El primer Esc de `/config` solo limpia la búsqueda: sigue abierto.
    ("sesion-b", "config-cerrado", Dialog, None, None),
    ("sesion-b", "model-abierto", Dialog, None, None),
    (
        "sesion-b",
        "model-cerrado",
        Prompt,
        Some("bypassPermissions"),
        None,
    ),
    ("sesion-b", "modo-1", Prompt, Some("auto"), None),
    ("sesion-b", "modo-2", Prompt, Some("default"), None),
    ("sesion-b", "modo-3", Prompt, Some("acceptEdits"), None),
    ("sesion-b", "modo-4", Prompt, Some("plan"), None),
    (
        "sesion-b",
        "modo-5",
        Prompt,
        Some("bypassPermissions"),
        None,
    ),
    ("sesion-b", "modo-6", Prompt, Some("auto"), None),
    ("sesion-b", "cost-pegado", Dialog, None, None),
    ("sesion-b", "panel-mod-uso", Dialog, None, None),
    ("sesion-b", "panel-mod-cerrado", Prompt, Some("auto"), None),
    ("sesion-b", "busy-bash", Busy, Some("auto"), None),
    // La pista atenuada «Press up to edit queued messages» no es entrada.
    ("sesion-b", "busy-bash-cola", Busy, Some("auto"), None),
    ("sesion-b", "bash-tras-esc", Busy, Some("auto"), None),
    // Tras Esc en modo shell la TUI devuelve el comando a la caja.
    (
        "sesion-b",
        "bash-final",
        Prompt,
        None,
        Some("ping -n 10 127.0.0.1"),
    ),
    ("confianza", "confianza", Trust, None, None),
    ("confianza", "confianza-abajo", Trust, None, None),
    ("resume", "resume-manual", Dialog, None, None),
    ("resume", "resume-bash-hecho", Prompt, Some("default"), None),
    (
        "modelo",
        "arranque-m",
        Prompt,
        Some("bypassPermissions"),
        None,
    ),
    ("modelo", "model-abierto", Dialog, None, None),
    (
        "modelo",
        "model-esc1",
        Prompt,
        Some("bypassPermissions"),
        None,
    ),
    (
        "modelo",
        "model-esc2",
        Prompt,
        Some("bypassPermissions"),
        None,
    ),
];

#[test]
fn cada_fixture_se_clasifica_como_su_nombre() {
    for (s, corte, estado, modo, entrada) in TABLA {
        let c = pantalla(s, corte);
        assert_eq!(c.estado, *estado, "{s}/{corte}");
        assert_eq!(c.modo.as_deref(), *modo, "{s}/{corte}: modo");
        assert_eq!(c.entrada.as_deref(), *entrada, "{s}/{corte}: entrada");
    }
}

fn opciones(s: &str, corte: &str) -> Vec<(String, bool)> {
    pantalla(s, corte)
        .opciones
        .into_iter()
        .map(|o| (o.label, o.selected))
        .collect()
}

#[test]
fn opciones_de_la_confianza_y_de_los_dialogos_con_el_cursor() {
    let no = ("No, exit".to_string(), true);
    let si = ("Yes, I trust this folder".to_string(), false);
    assert_eq!(opciones("confianza", "confianza"), vec![no, si]);
    let abajo = opciones("confianza", "confianza-abajo");
    assert_eq!(abajo[1], ("Yes, I trust this folder".to_string(), true));
    let mcp = opciones("resume", "resume-manual");
    assert_eq!(mcp.len(), 3);
    assert_eq!(
        mcp[2],
        ("Continue without using this MCP server".to_string(), true)
    );
    let modelos = pantalla("modelo", "model-abierto").opciones;
    let sel = modelos.iter().find(|o| o.selected).expect("resaltada");
    assert_eq!(sel.index, 1);
    assert!(sel.label.starts_with("Opus 5.5 ✔"), "{}", sel.label);
    assert!(modelos.iter().all(|o| !o.label.starts_with(['↓', '…'])));
    // Caso negativo: el prompt no tiene opciones.
    assert!(pantalla("sesion-a", "prompt-vacio").opciones.is_empty());
}

/// `/mcp` con el PTY redimensionado a 100x20, como en el bloque de menú.
fn mcp_a_100x20() -> (Monitor, &'static [u8], HashMap<String, usize>) {
    let (bytes, indice) = fixture("mcp-resize");
    let m = Monitor::nuevo(FILAS, COLS);
    m.alimentar(&bytes[..indice["mcp-abierto"]]);
    m.redimensionar(20, 100);
    m.alimentar(&bytes[indice["mcp-abierto"]..indice["flecha"]]);
    (m, bytes, indice)
}

/// Las cabeceras de sección de `/mcp` (`User MCPs (…)`) no se pueden
/// seleccionar: no son opciones. Antes salían como la primera y
/// `dialog_answer` pulsaba flechas hacia una fila a la que no se llega.
#[test]
fn las_cabeceras_de_seccion_no_son_opciones() {
    let (m, _, _) = mcp_a_100x20();
    let c = m.clasificar();
    assert_eq!(c.estado, Dialog);
    let etiquetas: Vec<&str> = c.opciones.iter().map(|o| o.label.as_str()).collect();
    assert!(
        etiquetas.iter().all(|l| !l.contains("MCPs")),
        "{etiquetas:?}"
    );
    assert_eq!(etiquetas.len(), 3, "{etiquetas:?}");
    assert_eq!(c.opciones[0].index, 0);
    assert!(c.opciones[0].selected && c.opciones[0].label.contains("codegraph"));
}

/// Con la pantalla emulada redimensionada antes que el repintado (orden de
/// `comandos_pty::redimensionar_con`), abrir y cerrar `/mcp` en 100x20 deja
/// el prompt limpio a 160x48: ningún `❯` ni `↑/` del menú fuera de la caja.
#[test]
fn abrir_y_cerrar_el_menu_redimensionado_no_deja_restos() {
    let (m, bytes, indice) = mcp_a_100x20();
    m.redimensionar(FILAS, COLS);
    m.alimentar(&bytes[indice["flecha"]..indice["cerrado"]]);
    assert_eq!(m.clasificar().estado, Prompt);
    let filas = m.instantanea().filas;
    let (arriba, abajo) = caja(&filas).expect("caja del prompt");
    let restos: Vec<&String> = filas
        .iter()
        .enumerate()
        .filter(|(i, _)| *i < arriba || *i > abajo)
        .map(|(_, l)| l)
        .filter(|l| l.contains('❯') || l.contains("↑/"))
        .collect();
    assert!(restos.is_empty(), "{restos:?}");
}

/// `seguridad-robustez:M2`: el búfer acumulado tiene un `❯` del prompt
/// anterior y ninguno de los pies que conocía `readiness()` (que daba
/// «listo»), pero la pantalla con `/config` abierto es un diálogo.
#[test]
fn un_prompt_antiguo_en_el_bufer_no_tapa_el_menu_abierto() {
    let (bytes, indice) = fixture("sesion-b");
    let hasta = &bytes[..indice["config-abierto"]];
    // Lo que veía `readiness()`: texto sin espacios ni mayúsculas del búfer
    // entero, con prompts `❯` y sin los dos pies de diálogo que conocía.
    let compacto: String = String::from_utf8_lossy(hasta)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect::<String>()
        .to_lowercase();
    assert!(compacto.contains('❯'));
    assert!(!["entertoconfirm", "esctocancel"]
        .iter()
        .any(|m| compacto.contains(m)));
    assert_eq!(pantalla("sesion-b", "config-abierto").estado, Dialog);
    assert_eq!(pantalla("sesion-b", "model-cerrado").estado, Prompt);
}

fn regla() -> String {
    "─".repeat(60)
}

/// AC-25: la pista de `PromptHint` (texto atenuado en la caja vacía) no es
/// entrada, y el modo se lee con los añadidos de `ultron-hud`.
#[test]
fn la_pista_atenuada_no_es_entrada() {
    let r = regla();
    let pie = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · socrático strict · tono ultron";
    let con_pista =
        format!("{r}\r\n❯\u{a0}\x1b[2mTry \"refactor\" · /agentes\x1b[22m\r\n{r}\r\n{pie}");
    let mut p = vt100::Parser::new(10, 100, 0);
    p.process(con_pista.as_bytes());
    let c = clasificar(p.screen());
    assert_eq!(c.estado, Prompt);
    assert_eq!(c.entrada, None);
    assert_eq!(c.modo.as_deref(), Some("bypassPermissions"));
    // Caso negativo: el mismo texto sin atenuar sí es entrada.
    let sin_pista = format!("{r}\r\n❯\u{a0}Try \"refactor\"\r\n{r}\r\n{pie}");
    let mut p = vt100::Parser::new(10, 100, 0);
    p.process(sin_pista.as_bytes());
    assert_eq!(
        clasificar(p.screen()).entrada.as_deref(),
        Some("Try \"refactor\"")
    );
}

/// La TUI pinta el cursor sobre la primera letra del placeholder (pista o
/// sugerencia de prompt) en inverso y SIN atenuar; el resto, atenuado. Esa
/// letra no es entrada: leída como texto, G3 mandaba un Ctrl+U sin efecto y
/// la cola se quedaba en pausa con la caja vacía.
#[test]
fn el_cursor_sobre_el_placeholder_no_es_entrada() {
    let r = regla();
    let entrada = |caja: &str| {
        let t = format!("{r}\r\n❯\u{a0}{caja}\r\n{r}\r\n");
        let mut p = vt100::Parser::new(10, 100, 0);
        p.process(t.as_bytes());
        clasificar(p.screen()).entrada
    };
    assert_eq!(
        entrada("\x1b[7mP\x1b[27m\x1b[2mrueba el build\x1b[22m"),
        None
    );
    // Casos negativos: texto real con el cursor encima de la primera letra.
    assert_eq!(entrada("\x1b[7ma\x1b[27m").as_deref(), Some("a"));
    assert_eq!(entrada("\x1b[7ma\x1b[27mbc").as_deref(), Some("abc"));
    assert_eq!(
        entrada("\x1b[7ma\x1b[27mbc \x1b[2mpista\x1b[22m").as_deref(),
        Some("abc")
    );
}

#[test]
fn clasificar_texto_lee_spinner_modo_y_entrada() {
    let r = regla();
    let busy = format!(
        "● Bash(npm test)\n✻ Thinking… (12s · esc to interrupt)\n{r}\n❯ \n{r}\n  ⏸ plan mode on"
    );
    let c = clasificar_texto(&busy);
    assert_eq!(c.estado, Busy);
    assert_eq!(c.modo.as_deref(), Some("plan"));
    assert!(c.actividad.is_some_and(|a| a.starts_with('✻')));
    let terminado = format!("✓ 6s · 199 tok · $0,32\n{r}\n❯ \n{r}\n  ⏸ manual mode on");
    let c = clasificar_texto(&terminado);
    assert_eq!(
        c.estado, Prompt,
        "la línea de turno terminado no es spinner"
    );
    assert_eq!(c.modo.as_deref(), Some("default"));
    assert_eq!(clasificar_texto("").estado, EstadoPantalla::Unknown);
}

/// §3.4: la pista de Ctrl+B solo cuenta con la pantalla ocupada; sin ella
/// (prompt libre o el `!comando` grabado, que no la pinta) es false.
#[test]
fn la_pista_de_segundo_plano_solo_cuenta_trabajando() {
    let r = regla();
    let con_pista = format!(
        "● Bash(Start-Sleep 60)\n  ⎿  Running… (ctrl+b to run in background)\n✻ Cooking… (3s · esc to interrupt)\n{r}\n❯ \n{r}\n  ⏵⏵ bypass permissions on"
    );
    let c = clasificar_texto(&con_pista);
    assert_eq!(c.estado, Busy);
    assert!(c.pista_segundo_plano);
    // Casos negativos: la misma línea con el prompt libre, y la TUI ocupada
    // sin pista.
    let libre =
        format!("  ⎿  (ctrl+b to run in background)\n{r}\n❯ \n{r}\n  ⏵⏵ bypass permissions on");
    let c = clasificar_texto(&libre);
    assert_eq!(c.estado, Prompt);
    assert!(!c.pista_segundo_plano);
    for corte in ["busy-bash", "busy-bash-cola"] {
        let c = pantalla("sesion-b", corte);
        assert_eq!(c.estado, Busy, "{corte}");
        assert!(!c.pista_segundo_plano, "{corte}");
    }
    assert!(!pantalla("sesion-a", "prompt-vacio").pista_segundo_plano);
}

/// Spike del 2026-10-16 (2.1.301, fullscreen con los mods): un Bash en primer
/// plano pinta «(ctrl+b to run in background)» bajo el comando, también con
/// un mensaje en la cola nativa; tras el Ctrl+B y en reposo no hay pista.
#[test]
fn la_pista_de_segundo_plano_en_la_cli_real() {
    for corte in ["bash-con-pista", "bash-2-en-curso", "cola-durante-bash"] {
        let c = pantalla("segundo-plano", corte);
        assert_eq!(c.estado, Busy, "{corte}");
        assert!(c.pista_segundo_plano, "{corte}");
    }
    for corte in ["arranque", "tras-ctrl-b", "fin-turno-2"] {
        let c = pantalla("segundo-plano", corte);
        assert_eq!(c.estado, Prompt, "{corte}");
        assert!(!c.pista_segundo_plano, "{corte}");
    }
}

/// El panel lateral de los mods (`│ …`) junto a las filas de la caja no es
/// entrada: si se colara, la lectura cambiaría con el panel y G3 tomaría
/// cada cambio por una caja distinta.
#[test]
fn el_panel_lateral_no_se_cuela_en_la_entrada() {
    let r = regla();
    let pantalla =
        format!("{r}\n❯ hola                │ ctx 41 %\n  segunda línea        │ 12:03\n{r}");
    let c = clasificar_texto(&pantalla);
    assert_eq!(c.estado, Prompt);
    assert_eq!(c.entrada.as_deref(), Some("hola\nsegunda línea"));
}

#[test]
fn alimentar_a_trozos_da_la_misma_pantalla() {
    let (bytes, indice) = fixture("sesion-a");
    let m = Monitor::nuevo(FILAS, COLS);
    for trozo in bytes[..indice["prompt-texto"]].chunks(97) {
        m.alimentar(trozo);
    }
    let c = m.clasificar();
    assert_eq!(c.entrada.as_deref(), Some("hola mundo"));
    assert_eq!(c.vista().entrada.as_deref(), Some("hola mundo"));
    m.redimensionar(40, 120);
    assert_eq!(m.instantanea().filas.len(), 40);
}

#[test]
fn debounce_de_150_ms_con_latencia_maxima_de_250() {
    let t = Instant::now();
    let ms = Duration::from_millis;
    assert!(!debe_clasificar(None, None, t));
    assert!(!debe_clasificar(Some(t), Some(t), t + ms(100)));
    assert!(debe_clasificar(Some(t), Some(t), t + ms(150)));
    // Salida continua: el último byte es reciente, pero ya pasaron 250 ms.
    assert!(!debe_clasificar(Some(t), Some(t + ms(200)), t + ms(240)));
    assert!(debe_clasificar(Some(t), Some(t + ms(240)), t + ms(250)));
    let m = Monitor::nuevo(FILAS, COLS);
    m.alimentar(b"x");
    assert!(!m.toca_clasificar(Instant::now()));
    assert!(m.toca_clasificar(Instant::now() + ms(200)));
    assert!(
        !m.toca_clasificar(Instant::now() + ms(400)),
        "la marca se consume"
    );
}

/// Prueba manual con la CLI real (sin prompt, sin coste de tokens): lanza
/// `claude` en un PTY con los argumentos de Sessions, espera al prompt por la
/// pantalla emulada (la respuesta DSR sale por el escritor), comprueba el modo
/// y Ctrl+C rechazado por G2 en el prompt, y mata el árbol.
/// `ULTRON_TEST_CWD` = carpeta de confianza donde lanzarlo.
#[cfg(windows)]
#[test]
#[ignore = "lanza la CLI real de claude; a mano"]
fn claude_real_llega_al_prompt_en_bypass() {
    use crate::pty::escritor::{ErrorEscritura, TeclaPty, Trabajo};
    use crate::pty::ops::{lanzar, Emisor, Lanzamiento};
    use std::sync::Arc;
    let cwd = std::env::var("ULTRON_TEST_CWD").expect("ULTRON_TEST_CWD");
    let mut cmd = portable_pty::CommandBuilder::new("cmd.exe");
    cmd.args(["/C", "claude", "--permission-mode", "bypassPermissions"]);
    cmd.args([
        "--settings",
        r#"{"tui":"fullscreen","promptSuggestionEnabled":false}"#,
    ]);
    cmd.cwd(cwd);
    for (k, _) in std::env::vars() {
        if k == "CLAUDECODE" || (k.starts_with("CLAUDE_CODE_") && k != "CLAUDE_CODE_PLUGIN_DIRS") {
            cmd.env_remove(k);
        }
    }
    let m = Arc::new(Monitor::nuevo(FILAS, COLS));
    let (m_out, m_vista) = (m.clone(), m.clone());
    let emisor: Emisor = Arc::new(|_, _| {});
    let l = Lanzamiento {
        id: crate::pty::registry::new_ulid(),
        provider: "claude".into(),
        cols: COLS,
        rows: FILAS,
        live_event: None,
        on_exit: Box::new(|_| {}),
        on_output: Some(Box::new(move |b| m_out.alimentar(b))),
        vista: Some(Arc::new(move || m_vista.vista())),
    };
    let id = lanzar(cmd, l, emisor).expect("lanzar");
    let inicio = Instant::now();
    while m.clasificar().estado != Prompt && inicio.elapsed() < Duration::from_secs(60) {
        std::thread::sleep(Duration::from_millis(200));
    }
    let c = m.clasificar();
    let r = crate::pty::io::enviar(&id, Trabajo::Tecla(TeclaPty::CtrlC));
    crate::pty::io::kill(&id).expect("kill");
    crate::pty::io::forget(&id);
    assert_eq!(c.estado, Prompt, "{:?}", m.instantanea().filas);
    assert_eq!(c.modo.as_deref(), Some("bypassPermissions"));
    assert_eq!(r, Err(ErrorEscritura::CtrlCSinTrabajo));
}
