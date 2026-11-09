// sesiones/codex.rs — Motor Codex (tareas en segundo plano).
//
// local: `codex exec --json -C <cwd> -s <sandbox> --skip-git-repo-check -`
// con el prompt por stdin; la salida es JSON por líneas (comprobado con
// codex-cli 0.154: `thread.started`, `turn.started`, `item.started` /
// `item.completed` con `item.type` = `agent_message` | `command_execution` |
// `file_change` | `reasoning` | `error`, `turn.completed`, `turn.failed`,
// `error`). Si la sesión ya tiene un hilo de Codex terminado se continúa con
// `codex exec resume --json -c sandbox_mode="<sandbox>" <hilo> -` (E8;
// `resume` no admite `-C` ni `-s`: el cwd va por el proceso y el sandbox por
// `-c`). Sandbox: `workspace-write` para `task`, `read-only` para `opinion`.
// cloud: `codex cloud exec --env <env> -- <prompt>` (salida de texto; el
// prompt va como argumento, por eso se limita su tamaño).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use super::codex_parse::{evt, parse_exec_line, LineOutcome};
use super::motor::{self, Launch, LineParser, OnDone, TaskSpec};
use super::motores;
use super::types::EngineTask;

/// Tope del prompt de Codex Cloud, que viaja como argumento (el límite de la
/// línea de órdenes de Windows es 32 767 caracteres).
const CLOUD_PROMPT_MAX: usize = 28_000;

/// Hilo de Codex por sesión de Sesiones (continuidad, E8).
fn threads() -> &'static Mutex<HashMap<String, String>> {
    static T: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(HashMap::new()))
}

fn thread_for(session_id: Option<&str>) -> Option<String> {
    let sid = session_id?;
    threads().lock().ok()?.get(sid).cloned()
}

/// Hilo de Codex que retomará la sesión `session_id` (`None` = hilo nuevo).
#[cfg(test)]
pub fn hilo_de(session_id: &str) -> Option<String> {
    thread_for(Some(session_id))
}

/// Siembra el hilo de una sesión de motor que se reabre (o que sigue abierta
/// tras un reinicio): su siguiente turno retoma el hilo con `exec resume`.
pub fn sembrar_hilo(session_id: &str, thread_id: &str) {
    if let Ok(mut m) = threads().lock() {
        m.insert(session_id.to_string(), thread_id.to_string());
    }
}

/// Olvida el hilo de una sesión que se cierra.
pub fn olvidar_hilo(session_id: &str) {
    if let Ok(mut m) = threads().lock() {
        m.remove(session_id);
    }
}

fn remember_thread() -> OnDone {
    Box::new(|t: &EngineTask| {
        if let (Some(sid), Some(th)) = (t.session_id.clone(), t.thread_id.clone()) {
            if t.status == "done" && t.mode == "local" {
                if let Ok(mut m) = threads().lock() {
                    m.insert(sid, th);
                }
            }
        }
        super::relevo::task_finished(t);
    })
}

/// Entorno de Codex Cloud del proyecto (`codexCloudEnv` en projects.json).
pub fn cloud_env_for(cwd: &str, project_id: Option<&str>) -> Option<String> {
    let (_, root) = crate::projects::registry::load_registry_mut().ok()?;
    let norm = |p: &str| p.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let want = norm(cwd);
    root.get("projects")?.as_array()?.iter().find_map(|p| {
        let by_id = project_id.is_some() && p.get("id").and_then(Value::as_str) == project_id;
        let by_path = p.get("path").and_then(Value::as_str).map(norm) == Some(want.clone());
        if !(by_id || by_path) {
            return None;
        }
        p.get("codexCloudEnv")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
    })
}

/// Sandbox de Codex según el tipo de intervención.
pub fn sandbox_for(kind: &str) -> &'static str {
    if kind == "relay" {
        "danger-full-access"
    } else if kind == "opinion" {
        "read-only"
    } else {
        "workspace-write"
    }
}

/// Opciones que eligen el modelo del hilo (`None` = el predeterminado).
pub struct ModelChoice<'a> {
    pub model: Option<&'a str>,
    pub effort: Option<&'a str>,
}

/// `--image=<ruta>` por imagen. Con `=` cada opción lleva un solo valor: en
/// `exec`, `-i` es variádico y se tragaría el `-` del prompt por stdin.
fn image_args(images: &[String]) -> Vec<String> {
    images.iter().map(|i| format!("--image={i}")).collect()
}

/// Argumentos de `codex` para el modo local (nuevo hilo o continuación). El
/// modelo y el effort van como overrides de config (`-c`), y las imágenes
/// con `--image`: ambos los admiten `exec` y `exec resume`.
pub fn local_args(
    cwd: &str,
    kind: &str,
    resume: Option<&str>,
    choice: &ModelChoice,
    images: &[String],
) -> Vec<String> {
    let sandbox = sandbox_for(kind);
    let mut a: Vec<String> = vec!["exec".into()];
    let mut model_args: Vec<String> = image_args(images);
    if let Some(m) = choice.model {
        model_args.extend(["-c".into(), format!("model=\"{m}\"")]);
    }
    if let Some(e) = choice.effort {
        model_args.extend(["-c".into(), format!("model_reasoning_effort=\"{e}\"")]);
    }
    model_args.extend(crate::ai_router::exec::CODEX_WINDOWS_SANDBOX.map(String::from));
    match resume {
        Some(th) => {
            a.extend([
                "resume".into(),
                "--json".into(),
                "--skip-git-repo-check".into(),
            ]);
            a.extend(["-c".into(), format!("sandbox_mode=\"{sandbox}\"")]);
            a.extend(model_args);
            a.extend([th.to_string(), "-".into()]);
        }
        None => {
            a.extend(["--json".into(), "-C".into(), cwd.to_string()]);
            a.extend(["-s".into(), sandbox.into(), "--skip-git-repo-check".into()]);
            a.extend(model_args);
            a.push("-".into());
        }
    }
    a
}

/// Error de un envío a Codex Cloud con adjuntos: la nube no ve el disco local.
pub const CLOUD_NO_ATTACHMENTS: &str = "Codex cloud no admite adjuntos locales";

/// Intérprete de la salida de texto de `codex cloud exec`.
fn cloud_parser() -> LineParser {
    let mut acc = String::new();
    Box::new(move |line: &str| {
        acc.push_str(line);
        acc.push('\n');
        LineOutcome {
            event: evt("message", line.to_string()),
            message: Some(acc.trim().to_string()),
            ..LineOutcome::default()
        }
    })
}

/// Lanza una tarea de Codex. `full_prompt` ya incluye el paquete de contexto.
pub fn start(
    spec: TaskSpec,
    full_prompt: String,
    project_id: Option<&str>,
    images: &[String],
) -> Result<EngineTask, String> {
    if full_prompt.trim().is_empty() {
        return Err("el prompt para Codex está vacío".to_string());
    }
    if !std::path::Path::new(&spec.cwd).is_dir() {
        return Err(format!("el directorio no existe: {}", spec.cwd));
    }
    let program = motores::codex_program()?;
    let mut cmd = motores::command_for_task(&program, &spec.cwd);
    let launch = match spec.mode.as_str() {
        "local" => {
            let resume = thread_for(spec.session_id.as_deref());
            let effort = super::modelos::codex_effort_for(spec.model.as_deref());
            let choice = ModelChoice {
                model: spec.model.as_deref(),
                effort: effort.as_deref(),
            };
            cmd.args(local_args(
                &spec.cwd,
                &spec.kind,
                resume.as_deref(),
                &choice,
                images,
            ));
            Launch {
                cmd,
                stdin: Some(full_prompt.into_bytes()),
                parser: Box::new(|l: &str| parse_exec_line(l)),
                on_done: Some(remember_thread()),
                vigia_stderr: None,
            }
        }
        "cloud" => {
            if !images.is_empty() {
                return Err(CLOUD_NO_ATTACHMENTS.to_string());
            }
            if full_prompt.chars().count() > CLOUD_PROMPT_MAX {
                return Err(format!(
                    "el prompt para Codex Cloud supera {CLOUD_PROMPT_MAX} caracteres (va como argumento): quita el contexto o usa el modo local"
                ));
            }
            let env = cloud_env_for(&spec.cwd, project_id).ok_or_else(|| {
                "el proyecto no tiene 'codexCloudEnv' en projects.json: configura el entorno de Codex Cloud".to_string()
            })?;
            cmd.args(["cloud", "exec", "--env", &env, "--", &full_prompt]);
            Launch {
                cmd,
                stdin: None,
                parser: cloud_parser(),
                on_done: None,
                vigia_stderr: None,
            }
        }
        other => return Err(format!("modo de Codex no válido: '{other}'")),
    };
    motor::spawn(spec, launch)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SIN: ModelChoice<'static> = ModelChoice {
        model: None,
        effort: None,
    };

    #[test]
    fn las_imagenes_van_con_igual_en_hilo_nuevo_y_al_reanudar() {
        let imgs = vec!["C:/a b/x.png".to_string(), "/tmp/y.jpg".to_string()];
        for resume in [None, Some("th-1")] {
            let a = local_args("/tmp/p", "task", resume, &SIN, &imgs);
            assert!(a.contains(&"--image=C:/a b/x.png".to_string()));
            assert!(a.contains(&"--image=/tmp/y.jpg".to_string()));
            assert!(!a.contains(&"-i".to_string()), "-i es variádico en exec");
            assert_eq!(a.last().map(String::as_str), Some("-"));
        }
        let sin = local_args("/tmp/p", "task", None, &SIN, &[]);
        assert!(!sin.iter().any(|x| x.starts_with("--image")));
    }

    #[test]
    fn hilo_nuevo_con_sandbox_de_escritura() {
        let a = local_args("/tmp/p", "task", None, &SIN, &[]);
        assert_eq!(a[0], "exec");
        assert!(a.windows(2).any(|w| w == ["-s", "workspace-write"]));
        assert_eq!(a.last().map(String::as_str), Some("-"));
    }

    #[test]
    fn la_opinion_es_de_solo_lectura_y_reanuda_el_hilo() {
        let a = local_args("/tmp/p", "opinion", Some("th-1"), &SIN, &[]);
        assert_eq!(&a[..2], ["exec", "resume"]);
        assert!(a.contains(&"sandbox_mode=\"read-only\"".to_string()));
        assert!(!a.contains(&"-C".to_string()), "resume no admite -C");
        assert_eq!(&a[a.len() - 2..], ["th-1", "-"]);
    }

    #[test]
    fn el_modelo_va_como_override_de_config() {
        let a = local_args(
            "/tmp/p",
            "task",
            None,
            &ModelChoice {
                model: Some("gpt-5.6-sol"),
                effort: None,
            },
            &[],
        );
        assert!(a.windows(2).any(|w| w == ["-c", "model=\"gpt-5.6-sol\""]));
        assert!(!local_args("/tmp/p", "task", None, &SIN, &[])
            .iter()
            .any(|x| x.starts_with("model")));
    }

    #[test]
    fn el_sandbox_de_windows_va_sin_elevar_en_hilo_nuevo_y_al_reanudar() {
        for resume in [None, Some("th-1")] {
            let a = local_args("/tmp/p", "task", resume, &SIN, &[]);
            assert!(a
                .windows(2)
                .any(|w| w == ["-c", "windows.sandbox=\"unelevated\""]));
        }
    }

    #[test]
    fn el_effort_va_como_override_tambien_al_reanudar() {
        for resume in [None, Some("th-1")] {
            let a = local_args(
                "/tmp/p",
                "task",
                resume,
                &ModelChoice {
                    model: None,
                    effort: Some("xhigh"),
                },
                &[],
            );
            assert!(a
                .windows(2)
                .any(|w| w == ["-c", "model_reasoning_effort=\"xhigh\""]));
            assert_eq!(a.last().map(String::as_str), Some("-"));
        }
    }

    #[test]
    fn el_relevo_tiene_acceso_total_en_hilo_nuevo_y_reanudado() {
        let nuevo = local_args("/tmp/p", "relay", None, &SIN, &[]);
        assert!(nuevo.windows(2).any(|w| w == ["-s", "danger-full-access"]));
        let resume = local_args("/tmp/p", "relay", Some("th-1"), &SIN, &[]);
        assert!(resume.contains(&"sandbox_mode=\"danger-full-access\"".to_string()));
    }
}
