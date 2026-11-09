// Turno real de OpenCode y vigía de stderr de `motor` con un proceso que se
// cuelga.
//
// El turno real, la lista de modelos y el saldo de DeepSeek van con `#[ignore]`
// (red, keys y cuota de un proveedor):
//
//   cd control-center/src-tauri
//   cargo test --lib sesiones::tests_opencode_real -- --ignored --nocapture
//
// Modelo por defecto: `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`
// (OPENROUTER_API_KEY en el entorno o en el registro de usuario); otro con
// `ULTRON_OPENCODE_MODELO=<proveedor/modelo>`.

use std::time::{Duration, Instant};

use super::motor::{self, Launch, TaskSpec};
use super::opencode;
use super::opencode_parse::fallo_stderr;
use super::types::EngineTask;

const MODELO_REAL: &str = "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free";

fn spec(cwd: &str, model: Option<String>) -> TaskSpec {
    TaskSpec {
        engine: "opencode",
        kind: "task".into(),
        mode: "local".into(),
        cwd: cwd.to_string(),
        prompt: "prueba".into(),
        session_id: None,
        context_chars: 0,
        model,
        group: None,
    }
}

fn esperar(id: &str, tope: Duration) -> EngineTask {
    let limite = Instant::now() + tope;
    loop {
        let t = motor::get(id).expect("tarea");
        if t.status != "running" || Instant::now() > limite {
            return t;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
#[ignore = "turno real: red, key de OpenRouter y cuota del proveedor"]
fn un_turno_real_de_opencode_termina_con_respuesta_y_tokens() {
    let dir = tempfile::tempdir().expect("tempdir");
    let cwd = dir.path().to_string_lossy().into_owned();
    let modelo = std::env::var("ULTRON_OPENCODE_MODELO").unwrap_or_else(|_| MODELO_REAL.into());
    let prompt = "Responde exactamente con la palabra: ornitorrinco".to_string();
    let t = opencode::start(spec(&cwd, Some(modelo.clone())), prompt).expect("lanzar");
    let fin = esperar(&t.id, Duration::from_secs(240));
    println!("modelo {modelo}: {} · {:?}", fin.status, fin.summary);
    for e in &fin.events {
        println!("[{}] {}", e.kind, e.text);
    }
    assert_eq!(fin.status, "done", "eventos: {:?}", fin.events);
    let resumen = fin.summary.unwrap_or_default().to_lowercase();
    assert!(resumen.contains("ornitorrinco"), "{resumen}");
    assert!(fin.thread_id.is_some_and(|s| opencode::sesion_valida(&s)));
    assert!(fin.usage.is_some_and(|u| u.output_tokens > 0));
}

/// Un motor que escribe el fallo final del turno en stderr y no sale (como
/// OpenCode) se mata y la tarea queda en `error` con la causa.
#[cfg(windows)]
#[test]
fn el_vigia_de_stderr_mata_un_motor_colgado_y_deja_la_causa() {
    let mut cmd = std::process::Command::new("cmd");
    use std::os::windows::process::CommandExt;
    cmd.arg("/C").raw_arg(
        "echo level=ERROR message=process session.id=ses_a error=\"AI_APICallError: insufficient_quota\" 1>&2 & ping -n 60 127.0.0.1 >NUL",
    );
    let launch = Launch {
        cmd,
        stdin: None,
        parser: Box::new(|_| super::codex_parse::LineOutcome::default()),
        on_done: None,
        vigia_stderr: Some(fallo_stderr),
    };
    let inicio = Instant::now();
    let t = motor::spawn(spec(".", None), launch).expect("spawn");
    let fin = esperar(&t.id, Duration::from_secs(30));
    assert!(inicio.elapsed() < Duration::from_secs(20), "esperó al ping");
    assert_eq!(fin.status, "error");
    let texto: Vec<&str> = fin.events.iter().map(|e| e.text.as_str()).collect();
    assert!(
        texto
            .iter()
            .any(|t| t.contains("AI_APICallError: insufficient_quota")),
        "{texto:?}"
    );
}

/// Motor que deja `linea` en stderr y sigue vivo unos segundos: pasado el
/// margen del vigía, ¿sigue en curso?
#[cfg(windows)]
fn sigue_en_curso_tras(linea: &str, vigia: Option<super::motor_stderr::VigiaStderr>) -> bool {
    let mut cmd = std::process::Command::new("cmd");
    use std::os::windows::process::CommandExt;
    cmd.arg("/C")
        .raw_arg(format!("echo {linea} 1>&2 & ping -n 8 127.0.0.1 >NUL"));
    let launch = Launch {
        cmd,
        stdin: None,
        parser: Box::new(|_| super::codex_parse::LineOutcome::default()),
        on_done: None,
        vigia_stderr: vigia,
    };
    let t = motor::spawn(spec(".", None), launch).expect("spawn");
    std::thread::sleep(Duration::from_secs(4));
    let vivo = motor::get(&t.id).expect("tarea").status == "running";
    let _ = motor::cancel(&t.id);
    vivo
}

/// Caso negativo: sin vigía, el mismo motor sigue en curso pasado el margen.
#[cfg(windows)]
#[test]
fn sin_vigia_un_fallo_en_stderr_no_cancela_nada() {
    let linea = "level=ERROR message=process error=\"AI_X\"";
    assert!(sigue_en_curso_tras(linea, None));
}

/// Un `stream error` al que OpenCode responde con un reintento no mata el
/// motor aunque haya vigía.
#[cfg(windows)]
#[test]
fn un_stream_error_reintentable_no_mata_el_motor() {
    let linea =
        "level=ERROR message=\"stream error\" small=false error.error=\"AI_APICallError: 503\"";
    assert!(sigue_en_curso_tras(linea, Some(fallo_stderr)));
}

#[test]
#[ignore = "real: lanza `opencode models` por cada proveedor con key"]
fn la_lista_real_trae_deepseek_y_los_proveedores_con_key() {
    let v = super::opencode_modelos::list().expect("lista");
    let mut por_proveedor: std::collections::BTreeMap<&str, usize> = Default::default();
    for m in &v {
        *por_proveedor
            .entry(m.id.split('/').next().unwrap_or(""))
            .or_default() += 1;
    }
    println!("{por_proveedor:?}");
    assert!(v.iter().any(|m| m.id == "deepseek/deepseek-flash"));
    assert!(v
        .iter()
        .all(|m| !m.id.starts_with("opencode/") && !m.id.starts_with("github-copilot/")));
}

#[test]
#[ignore = "real: GET https://api.deepseek.com/user/balance"]
fn el_saldo_real_de_deepseek_se_lee() {
    let b = super::uso_externo::deepseek_balance(true);
    println!("{b:?}");
    assert_eq!(b.status, "ok", "{b:?}");
}
