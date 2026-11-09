// sesiones/lanzamiento.rs — Argumentos, settings y entorno de `claude` para
// una sesión (contrato de estabilidad, §2.5, §2.6, §3.3 y §8.3 pasos 5-6).
//
// - `--permission-mode <m>` siempre (del `permissionMode` de
//   `sesiones_create`, del `recover` o de `SessionPrefs`, en ese orden);
//   nunca la bandera de saltarse permisos (`seguridad-robustez:M1`).
// - Sesión nueva: `--session-id <uuid>`; reanudada: `--resume <sid>`;
//   bifurcada (`/branch`): `--resume <sid> --fork-session --session-id <uuid>`
//   (la CLI exige `--fork-session` para combinar `--session-id` y
//   `--resume`). El transcript es siempre `<slug>/<sid>.jsonl`.
// - `--settings <ruta>`: el tema del proyecto fusionado con
//   `promptSuggestionEnabled:false` y `tui:"fullscreen"` (R31, disposición
//   fija para `pantalla.rs`), en `%TEMP%/ultron-sesiones/<id>.settings.json`.
// - Entorno heredado menos una lista negra de secretos (`F13`).
//
// Como el PTY lanza `claude` a través de `cmd.exe /C`, una ruta con
// metacaracteres de cmd se descarta (con aviso) en lugar de pasarla.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::ajustes::EFFORTS;
use super::types::{PermissionMode, SessionPrefs};
use crate::pty::types::bloquear;

/// Cómo arranca la conversación de Claude Code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Arranque {
    Nueva { sid: String },
    Reanudar { sid: String },
    Bifurcar { desde: String, sid: String },
}

impl Arranque {
    /// Id de la conversación que escribirá el transcript.
    pub fn sid(&self) -> &str {
        match self {
            Self::Nueva { sid } | Self::Reanudar { sid } | Self::Bifurcar { sid, .. } => sid,
        }
    }
}

/// Configuración de lanzamiento de una sesión; se guarda para `restart` y en
/// `abiertas.json` (`persistencia.rs`) sin `settings_file`, que es un fichero
/// temporal y se vuelve a escribir al restaurar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub cwd: String,
    pub project_id: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: PermissionMode,
    /// `--settings` ya escrito (apto para `cmd.exe`).
    #[serde(skip)]
    pub settings_file: Option<String>,
}

pub fn valid_resume(id: &str) -> bool {
    (8..=64).contains(&id.len()) && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

pub fn valid_model(m: &str) -> bool {
    (1..=64).contains(&m.len())
        && m.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '[' | ']'))
}

/// true si la ruta puede cruzar `cmd.exe /C` sin reinterpretarse.
pub fn cmd_safe_path(p: &str) -> bool {
    !p.is_empty()
        && !p
            .chars()
            .any(|c| matches!(c, '&' | '|' | '<' | '>' | '^' | '%' | '"' | '!') || c.is_control())
}

/// Nombre del modo en `--permission-mode`. `default` lo acepta la CLI
/// 2.1.293 y lo muestra como «manual mode» (verificado en el spike).
pub fn modo_cli(m: PermissionMode) -> &'static str {
    match m {
        PermissionMode::Default => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::BypassPermissions => "bypassPermissions",
        PermissionMode::Plan => "plan",
        PermissionMode::Auto => "auto",
        PermissionMode::DontAsk => "dontAsk",
    }
}

/// Modo del lanzamiento: el de la petición si viene; si no, el de las prefs.
pub fn modo_lanzamiento(pedido: Option<PermissionMode>, prefs: &SessionPrefs) -> PermissionMode {
    pedido.unwrap_or(prefs.launch_permission_mode)
}

/// Argumentos de `claude` (tras `cmd.exe /C claude`).
pub fn build(cfg: &Config, arranque: &Arranque) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    match arranque {
        Arranque::Nueva { sid } => {
            uuid_valido(sid)?;
            args.extend(["--session-id".to_string(), sid.clone()]);
        }
        Arranque::Reanudar { sid } => {
            resume_valido(sid)?;
            args.extend(["--resume".to_string(), sid.clone()]);
        }
        Arranque::Bifurcar { desde, sid } => {
            resume_valido(desde)?;
            uuid_valido(sid)?;
            args.extend(["--resume".to_string(), desde.clone()]);
            args.push("--fork-session".to_string());
            args.extend(["--session-id".to_string(), sid.clone()]);
        }
    }
    args.extend([
        "--permission-mode".to_string(),
        modo_cli(cfg.permission_mode).to_string(),
    ]);
    if let Some(m) = cfg.model.as_deref().filter(|m| !m.is_empty()) {
        if !valid_model(m) {
            return Err(format!("nombre de modelo no válido: '{m}'"));
        }
        args.extend(["--model".to_string(), m.to_string()]);
    }
    if let Some(e) = cfg.effort.as_deref().filter(|e| !e.is_empty()) {
        if !EFFORTS.contains(&e) {
            return Err(format!(
                "effort no válido: '{e}' (low, medium, high, xhigh o max)"
            ));
        }
        args.extend(["--effort".to_string(), e.to_string()]);
    }
    if let Some(f) = &cfg.settings_file {
        args.extend(["--settings".to_string(), f.clone()]);
    }
    Ok(args)
}

fn resume_valido(sid: &str) -> Result<(), String> {
    if valid_resume(sid) {
        Ok(())
    } else {
        Err(format!("id de sesión para reanudar no válido: '{sid}'"))
    }
}

fn uuid_valido(sid: &str) -> Result<(), String> {
    uuid::Uuid::parse_str(sid)
        .map(|_| ())
        .map_err(|_| format!("id de sesión no válido: '{sid}'"))
}

/// Settings de lanzamiento: el tema del proyecto (si lo hay) más los ajustes
/// fijados por Sessions.
pub fn settings_lanzamiento(tema: &Value) -> Value {
    let mut out = match tema {
        Value::Object(m) => Value::Object(m.clone()),
        _ => json!({}),
    };
    out["promptSuggestionEnabled"] = json!(false);
    out["tui"] = json!("fullscreen");
    out
}

/// Escribe los settings de la sesión `id` y devuelve su ruta si es apta para
/// `cmd.exe`. `tema` es la ruta del settings del tema del proyecto.
pub fn escribir_settings(id: &str, tema: Option<&str>) -> Option<String> {
    let base = tema.map_or(Value::Null, |p| super::ajustes::read_json(p.as_ref()));
    let dir = std::env::temp_dir().join("ultron-sesiones");
    let path: PathBuf = dir.join(format!("{id}.settings.json"));
    let texto = serde_json::to_string_pretty(&settings_lanzamiento(&base)).ok()?;
    if let Err(e) = std::fs::create_dir_all(&dir).and_then(|()| std::fs::write(&path, texto)) {
        tracing::warn!(error = %e, "no se pudieron escribir los settings de la sesión");
        return None;
    }
    let p = path.to_string_lossy().into_owned();
    if cmd_safe_path(&p) {
        return Some(p);
    }
    tracing::warn!(ruta = %p, "settings de la sesión descartados: la ruta no cruza cmd.exe");
    None
}

/// Borra los settings de una sesión cerrada.
pub fn borrar_settings(id: &str) {
    let path = std::env::temp_dir()
        .join("ultron-sesiones")
        .join(format!("{id}.settings.json"));
    if let Err(e) = std::fs::remove_file(&path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::debug!(error = %e, "no se pudieron borrar los settings de la sesión");
        }
    }
}

/// Variables heredadas que `claude` no debe recibir (`seguridad-robustez:F13`):
/// el mismo clasificador que las tareas de motores
/// (`motores::se_excluye_de_claude`), con las excepciones de su autenticación.
pub fn claves_excluidas(claves: impl Iterator<Item = String>) -> Vec<String> {
    claves
        .filter(|k| super::motores::se_excluye_de_claude(k))
        .collect()
}

fn guardadas() -> &'static Mutex<HashMap<String, Config>> {
    static M: OnceLock<Mutex<HashMap<String, Config>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Guarda la configuración del último lanzamiento de la sesión.
pub fn guardar(id: &str, cfg: Config) {
    bloquear(guardadas()).insert(id.to_string(), cfg);
    super::persistencia::marcar();
}

/// Marca el proyecto como usado ahora (`last_active` de `projects.json`):
/// «+ Claude» ordena sus recientes por ese campo. Un fallo no impide la
/// sesión; queda en el log.
pub fn tocar_proyecto(project_id: Option<&str>) {
    let Some(pid) = project_id else {
        return;
    };
    if cfg!(test) {
        return; // los tests nunca tocan el registro real
    }
    if let Err(e) = crate::projects::touch_project_inner(pid) {
        tracing::warn!(proyecto = pid, error = %e, "no se pudo actualizar last_active");
    }
}

/// `Config` con el modelo y el effort cambiados a mitad de sesión. Un `None`
/// o un valor que `build` rechazaría conserva el del lanzamiento.
pub fn con_ajustes(cfg: &Config, model: Option<&str>, effort: Option<&str>) -> Config {
    let model = model.filter(|m| valid_model(m)).map(str::to_string);
    let effort = effort.filter(|e| EFFORTS.contains(e)).map(str::to_string);
    Config {
        model: model.or_else(|| cfg.model.clone()),
        effort: effort.or_else(|| cfg.effort.clone()),
        ..cfg.clone()
    }
}

/// `/model` o `/effort` confirmados a mitad de sesión: entran en la `Config`
/// guardada para que `restart` y la restauración relancen con ellos y no con
/// los del lanzamiento. Sin config guardada no hace nada. true si cambió.
pub fn actualizar(id: &str, model: Option<&str>, effort: Option<&str>) -> bool {
    let cambio = {
        let mut g = bloquear(guardadas());
        let Some(actual) = g.get_mut(id) else {
            return false;
        };
        let nueva = con_ajustes(actual, model, effort);
        let cambia = nueva != *actual;
        if cambia {
            *actual = nueva;
        }
        cambia
    };
    // Fuera del candado: el escritor de `abiertas.json` lee `guardada`.
    if cambio {
        super::persistencia::marcar();
    }
    cambio
}

pub fn guardada(id: &str) -> Option<Config> {
    bloquear(guardadas()).get(id).cloned()
}

pub fn olvidar(id: &str) {
    bloquear(guardadas()).remove(id);
    borrar_settings(id);
}

/// Configuración del reinicio: la del último lanzamiento con, si viene, el
/// modo pedido. No lee `SessionPrefs` (un cambio de prefs no altera la
/// sesión viva).
pub fn config_reinicio(ultima: &Config, modo: Option<PermissionMode>) -> Config {
    Config {
        permission_mode: modo.unwrap_or(ultima.permission_mode),
        ..ultima.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SID: &str = "0bacfbdb-a455-4982-bada-f1fc39a9d205";
    const OTRO: &str = "5f77529a-9be7-4361-87dc-3ad4ea7ac856";

    fn cfg(modo: PermissionMode) -> Config {
        Config {
            cwd: "/proyecto".into(),
            project_id: None,
            model: Some("claude-opus-5-5".into()),
            effort: Some("high".into()),
            permission_mode: modo,
            settings_file: Some("/t/ultron-sesiones/s.settings.json".into()),
        }
    }

    fn tiene(args: &[String], a: &str, b: &str) -> bool {
        args.windows(2).any(|w| w[0] == a && w[1] == b)
    }

    #[test]
    fn sesion_nueva_con_session_id_y_modo_siempre_presente() {
        let a = build(
            &cfg(PermissionMode::BypassPermissions),
            &Arranque::Nueva { sid: SID.into() },
        )
        .expect("args");
        assert!(tiene(&a, "--session-id", SID));
        assert!(tiene(&a, "--permission-mode", "bypassPermissions"));
        assert!(tiene(&a, "--model", "claude-opus-5-5"));
        assert!(tiene(&a, "--effort", "high"));
        assert!(tiene(
            &a,
            "--settings",
            "/t/ultron-sesiones/s.settings.json"
        ));
        assert!(!a.contains(&"--resume".to_string()));
    }

    #[test]
    fn reanudar_sin_session_id_y_bifurcar_con_fork_session() {
        let a = build(
            &cfg(PermissionMode::Default),
            &Arranque::Reanudar { sid: SID.into() },
        )
        .expect("args");
        assert!(tiene(&a, "--resume", SID));
        assert!(!a.contains(&"--session-id".to_string()));
        assert!(tiene(&a, "--permission-mode", "default"));
        let b = build(
            &cfg(PermissionMode::Plan),
            &Arranque::Bifurcar {
                desde: SID.into(),
                sid: OTRO.into(),
            },
        )
        .expect("args");
        assert!(tiene(&b, "--resume", SID));
        assert!(b.contains(&"--fork-session".to_string()));
        assert!(tiene(&b, "--session-id", OTRO));
    }

    /// AC-21: la bandera de saltarse permisos no sale con ningún modo.
    #[test]
    fn nunca_la_bandera_de_saltarse_permisos() {
        for m in [
            PermissionMode::Default,
            PermissionMode::AcceptEdits,
            PermissionMode::BypassPermissions,
            PermissionMode::Plan,
            PermissionMode::Auto,
            PermissionMode::DontAsk,
        ] {
            for arr in [
                Arranque::Nueva { sid: SID.into() },
                Arranque::Reanudar { sid: SID.into() },
            ] {
                let a = build(&cfg(m), &arr).expect("args");
                assert!(a.iter().all(|x| !x.contains("dangerously")), "{a:?}");
                assert!(tiene(&a, "--permission-mode", modo_cli(m)));
            }
        }
    }

    #[test]
    fn rechaza_ids_modelos_y_effort_invalidos() {
        let bad = |c: &Config, a: &Arranque| build(c, a).is_err();
        let ok = cfg(PermissionMode::Default);
        assert!(bad(&ok, &Arranque::Nueva { sid: "x;y".into() }));
        assert!(bad(
            &ok,
            &Arranque::Reanudar {
                sid: "abc & calc".into()
            }
        ));
        let modelo = Config {
            model: Some("a b".into()),
            ..ok.clone()
        };
        assert!(bad(&modelo, &Arranque::Nueva { sid: SID.into() }));
        let effort = Config {
            effort: Some("ultra".into()),
            ..ok
        };
        assert!(bad(&effort, &Arranque::Nueva { sid: SID.into() }));
    }

    #[test]
    fn el_modo_de_la_peticion_gana_a_las_prefs() {
        let prefs = SessionPrefs::default();
        assert_eq!(
            prefs.launch_permission_mode,
            PermissionMode::BypassPermissions
        );
        assert_eq!(
            modo_lanzamiento(Some(PermissionMode::AcceptEdits), &prefs),
            PermissionMode::AcceptEdits
        );
        assert_eq!(
            modo_lanzamiento(None, &prefs),
            PermissionMode::BypassPermissions
        );
    }

    /// El reinicio conserva el modo del último lanzamiento; con `opts`, el
    /// pedido. Cambiar las prefs entre medias no lo altera (no las lee).
    #[test]
    fn el_reinicio_usa_el_ultimo_lanzamiento_y_no_las_prefs() {
        let ultima = cfg(PermissionMode::BypassPermissions);
        let sin_opts = config_reinicio(&ultima, None);
        assert_eq!(sin_opts.permission_mode, PermissionMode::BypassPermissions);
        let con_opts = config_reinicio(&ultima, Some(PermissionMode::Default));
        assert_eq!(con_opts.permission_mode, PermissionMode::Default);
        let a = build(&con_opts, &Arranque::Reanudar { sid: SID.into() }).expect("args");
        assert!(tiene(&a, "--permission-mode", "default"));
        assert!(tiene(&a, "--resume", SID));
    }

    /// Auditoría H3: un `/model` y un `/effort` a mitad de sesión llegan a
    /// los argumentos del reinicio y de la restauración; antes `build`
    /// relanzaba con los del lanzamiento.
    #[test]
    fn el_modelo_y_el_effort_cambiados_entran_en_el_relanzamiento() {
        let id = format!("ajustes-{}", uuid::Uuid::new_v4());
        guardar(&id, cfg(PermissionMode::Default));
        assert!(actualizar(&id, Some("claude-sonnet-5-5"), None));
        assert!(actualizar(&id, None, Some("low")));
        let ultima = guardada(&id).expect("config guardada");
        let a = build(
            &config_reinicio(&ultima, None),
            &Arranque::Reanudar { sid: SID.into() },
        )
        .expect("args");
        assert!(tiene(&a, "--model", "claude-sonnet-5-5"));
        assert!(tiene(&a, "--effort", "low"));
        assert!(!a.contains(&"claude-opus-5-5".to_string()));
        assert!(
            !actualizar(&id, Some("claude-sonnet-5-5"), Some("low")),
            "sin cambio"
        );
        olvidar(&id);
    }

    /// Caso negativo de H3: sin config guardada no se inventa una, y un valor
    /// que `build` rechazaría no sustituye al del lanzamiento.
    #[test]
    fn actualizar_ignora_sesiones_sin_config_y_valores_invalidos() {
        let id = format!("ajustes-{}", uuid::Uuid::new_v4());
        assert!(!actualizar(&id, Some("claude-sonnet-5-5"), Some("low")));
        assert_eq!(guardada(&id), None);
        let base = cfg(PermissionMode::Default);
        let c = con_ajustes(&base, Some("modelo con espacios"), Some("turbo"));
        assert_eq!(c, base);
        let c = con_ajustes(&base, None, None);
        assert_eq!(c, base);
    }

    #[test]
    fn settings_fusionan_el_tema_con_los_ajustes_fijos() {
        let tema = json!({ "theme": "dark", "promptSuggestionEnabled": true });
        let s = settings_lanzamiento(&tema);
        assert_eq!(s["theme"], json!("dark"));
        assert_eq!(s["promptSuggestionEnabled"], json!(false));
        assert_eq!(s["tui"], json!("fullscreen"));
        assert!(s.get("askUserQuestionTimeout").is_none());
        let sin_tema = settings_lanzamiento(&Value::Null);
        assert_eq!(sin_tema["promptSuggestionEnabled"], json!(false));
    }

    #[test]
    fn el_entorno_excluye_secretos_y_conserva_el_resto() {
        let claves = [
            "GROQ_API_KEY",
            "OPENAI_API_KEY",
            "FOO_API_KEY",
            "ANTHROPIC_API_KEY",
            "MI_SECRET",
            "AWS_SECRET_KEY",
            "OPENALEX_MAILTO",
            "PATH",
            "SystemDrive",
            "windir",
            "ProgramData",
            "PSModulePath",
            "HTTPS_PROXY",
            "CLAUDE_CODE_PLUGIN_DIRS",
            // Lo que el clasificador anterior dejaba pasar.
            "AWS_SECRET_ACCESS_KEY",
            "AWS_ACCESS_KEY_ID",
            "NPM_TOKEN",
            "MI_PAT",
            "DB_PASSWORD_X",
            "ULTRON_KEY_ANTHROPIC_CREDITS",
            // Autenticación de la CLI y de sus plugins: se quedan.
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_AUTH_TOKEN",
            "GITHUB_PERSONAL_ACCESS_TOKEN",
            "github_personal_access_token",
            "GITHUB_TOKEN",
            "GH_TOKEN",
        ];
        let mut fuera = claves_excluidas(claves.iter().map(|k| (*k).to_string()));
        fuera.sort();
        assert_eq!(
            fuera,
            vec![
                "ANTHROPIC_API_KEY",
                "AWS_ACCESS_KEY_ID",
                "AWS_SECRET_ACCESS_KEY",
                "AWS_SECRET_KEY",
                "DB_PASSWORD_X",
                "FOO_API_KEY",
                "GROQ_API_KEY",
                "MI_PAT",
                "MI_SECRET",
                "NPM_TOKEN",
                "OPENAI_API_KEY",
                "OPENALEX_MAILTO",
                "ULTRON_KEY_ANTHROPIC_CREDITS",
            ]
        );
    }

    #[test]
    fn rutas_peligrosas_para_cmd() {
        assert!(cmd_safe_path(r"C:\Users\demo\AppData\Local\Temp\x.json"));
        assert!(!cmd_safe_path(r"C:\a&b\t.json"));
        assert!(!cmd_safe_path(""));
    }
}
