// sesiones/ajustes.rs — Ajustes de sesión (`sesiones_settings`,
// `sesiones_set_effort`, `sesiones_set_model`, `sesiones_set_socratic` y
// prefs de lanzamiento; contrato v0.2 y contrato de estabilidad, §2.5).
// `sesiones_set_fast`, `/config`, `$.session.usage()` y los ficheros de
// Claude Code en solo lectura se retiraron el 2026-10-26: no tenían
// consumidor en la UI (`/fast` y `/config` se escriben en el chat).
//
// Modelo y effort se aplican como comando (`comando_run::ajuste`):
// por el buzón con puente v2 (el texto devuelto confirma) y, sin él, por el
// PTY con la sesión libre. El modo de permisos real lo da la máquina.
//
// Effort (verificado en Claude Code 2.1.292): existe el comando `/effort
// <low|medium|high|xhigh|max>` y se aplica a la sesión en curso; además lo
// guarda como valor por defecto para sesiones nuevas (comportamiento del
// CLI). Si `CLAUDE_CODE_EFFORT_LEVEL` está definida, el CLI no aplica el
// cambio («overrides effort this session»): entonces se devuelve error.
// Sin `/effort` la línea de estado lee `modelSettings[<modelo>].effortLevel`
// y, si no, `effortLevel` de `~/.claude/settings.json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use std::time::Duration;

use super::types::{OpResult, SessionPrefs, SessionSettings};
use super::{comando_run, lanzamiento, registro};

#[path = "ajustes_prefs.rs"]
pub mod prefs;

/// Espera de los comandos Tauri sobre el buzón antes de devolver `pending`.
pub const ESPERA_OP: Duration = Duration::from_secs(5);

pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];
pub const SOCRATIC_MODES: &[&str] = &["strict", "light", "off", "uni"];
const EFFORT_ENV: &str = "CLAUDE_CODE_EFFORT_LEVEL";

/// Cómo se lanzó una sesión (lo registra `gestor::create`).
#[derive(Debug, Clone, Default)]
pub struct LaunchMeta {
    pub skip_permissions: bool,
    pub settings_file: Option<String>,
    /// Último effort fijado con `/effort` desde la ventana.
    pub effort: Option<String>,
}

fn metas() -> &'static Mutex<HashMap<String, LaunchMeta>> {
    static M: OnceLock<Mutex<HashMap<String, LaunchMeta>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn record_launch(id: &str, meta: LaunchMeta) {
    if let Ok(mut m) = metas().lock() {
        m.insert(id.to_string(), meta);
    }
}

/// Olvida los metadatos de una sesión cerrada.
pub fn forget(id: &str) {
    if let Ok(mut m) = metas().lock() {
        m.remove(id);
    }
}

fn meta(id: &str) -> LaunchMeta {
    metas()
        .lock()
        .ok()
        .and_then(|m| m.get(id).cloned())
        .unwrap_or_default()
}

pub fn claude_settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("settings.json"))
}

/// JSON de un fichero; `Null` si no existe o no se puede leer.
pub fn read_json(path: &Path) -> Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null)
}

fn model_key(model: &str) -> &str {
    model.strip_suffix("[1m]").unwrap_or(model)
}

/// Effort de un settings: el del modelo y, si no, el global.
pub fn effort_from(settings: &Value, model: Option<&str>) -> Option<String> {
    let per_model = model.and_then(|m| {
        settings
            .get("modelSettings")?
            .get(model_key(m))?
            .get("effortLevel")?
            .as_str()
    });
    per_model
        .or_else(|| settings.get("effortLevel").and_then(Value::as_str))
        .map(str::to_string)
}

fn norm(p: &str) -> String {
    p.replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// Modo socrático: el del proyecto por id o, si no, el del proyecto cuya ruta
/// contiene el cwd (la más larga gana, como `socratic-gate.js`). Ausente =
/// `strict`. `None` si el cwd no es de ningún proyecto.
pub fn socratic_for(registry: &Value, project_id: Option<&str>, cwd: &str) -> Option<String> {
    let projects = registry.get("projects")?.as_array()?;
    let mode = |p: &Value| {
        p.get("socratic")
            .and_then(Value::as_str)
            .filter(|m| SOCRATIC_MODES.contains(m))
            .unwrap_or("strict")
            .to_string()
    };
    if let Some(pid) = project_id {
        if let Some(p) = projects
            .iter()
            .find(|p| p.get("id").and_then(Value::as_str) == Some(pid))
        {
            return Some(mode(p));
        }
    }
    let want = norm(cwd);
    projects
        .iter()
        .filter_map(|p| Some((norm(p.get("path")?.as_str()?), p)))
        .filter(|(base, _)| {
            !base.is_empty() && (want == *base || want.starts_with(&format!("{base}\\")))
        })
        .max_by_key(|(base, _)| base.len())
        .map(|(_, p)| mode(p))
}

fn registry_value() -> Value {
    dirs::home_dir()
        .map(|h| read_json(&h.join(".ultron/cockpit/projects.json")))
        .unwrap_or(Value::Null)
}

/// Ajustes visibles de una sesión.
pub fn settings(id: &str) -> Result<SessionSettings, String> {
    if let Some(s) = super::motor_sesion::ajustes(id) {
        return Ok(s);
    }
    let (model, project_id, cwd, launch_mode, real) = registro::read(id, |s| {
        (
            s.info.model.clone(),
            s.info.project_id.clone(),
            s.info.cwd.clone(),
            s.info.launch_permission_mode,
            s.info.permission_mode,
        )
    })?;
    let user = claude_settings_path().map_or(Value::Null, |p| read_json(&p));
    let model = model.or_else(|| {
        user.get("model")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    let m = meta(id);
    let launch = m
        .settings_file
        .as_deref()
        .map_or(Value::Null, |f| read_json(Path::new(f)));
    let effort = std::env::var(EFFORT_ENV)
        .ok()
        .filter(|e| !e.trim().is_empty())
        .or(m.effort)
        .or_else(|| effort_from(&launch, model.as_deref()))
        .or_else(|| effort_from(&user, model.as_deref()));
    let permission_mode = real
        .and_then(|r| serde_json::to_value(r).ok())
        .and_then(|v| v.as_str().map(str::to_string))
        .or_else(|| m.skip_permissions.then(|| "bypassPermissions".to_string()))
        .or_else(|| {
            user.pointer("/permissions/defaultMode")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    Ok(SessionSettings {
        socratic: socratic_for(&registry_value(), project_id.as_deref(), &cwd),
        model,
        effort,
        permission_mode,
        project_id,
        launch_permission_mode: Some(launch_mode),
    })
}

/// Preferencias de lanzamiento vigentes (firma congelada en la fase 0a; la
/// lee `lanzamiento.rs`, que da prioridad al `permissionMode` de
/// `sesiones_create` o de `recover`). La primera vez crea el fichero con el
/// modo derivado de `claude_safe_mode` (§2.6).
pub fn prefs_actuales() -> SessionPrefs {
    match prefs::ruta_prefs() {
        Some(p) => prefs::prefs_en(&p, || {
            crate::features::read_features_inner().claude_safe_mode
        }),
        None => {
            tracing::warn!("sin directorio de datos locales: prefs de Sesiones por defecto");
            SessionPrefs::default()
        }
    }
}

/// Guarda las prefs de lanzamiento (`sesiones_prefs_set`).
pub fn guardar_prefs(p: &SessionPrefs) -> Result<SessionPrefs, String> {
    let ruta =
        prefs::ruta_prefs().ok_or_else(|| "no hay directorio de datos locales".to_string())?;
    prefs::guardar_en(&ruta, p)
}

/// `/effort <nivel>` por el buzón (v2) o por el PTY con la sesión libre. El
/// effort de la sesión solo cambia si el texto devuelto lo confirma (§2.5).
pub fn set_effort(id: &str, effort: &str) -> Result<OpResult, String> {
    if !EFFORTS.contains(&effort) {
        return Err(format!(
            "effort no válido: '{effort}' (low, medium, high, xhigh o max)"
        ));
    }
    if let Some(v) = std::env::var(EFFORT_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
    {
        return Err(format!(
            "{EFFORT_ENV}={v} fija el effort de esta sesión: Claude Code ignoraría /effort. Quita la variable y abre una sesión nueva"
        ));
    }
    let r = comando_run::ajuste(id, "effort", effort)?;
    if confirma(&r, effort) {
        recordar_effort(id, effort);
    }
    Ok(r)
}

/// El effort de la sesión pasa a ser `effort`, también para Reiniciar y la
/// restauración. Con `EFFORT_ENV` fijada, Claude Code ignora `/effort`.
pub fn recordar_effort(id: &str, effort: &str) {
    if std::env::var(EFFORT_ENV).is_ok_and(|v| !v.trim().is_empty()) {
        return;
    }
    if let Ok(mut m) = metas().lock() {
        m.entry(id.to_string()).or_default().effort = Some(effort.to_string());
    }
    lanzamiento::actualizar(id, None, Some(effort));
}

/// El texto devuelto por el comando confirma el valor pedido.
pub fn confirma(r: &OpResult, valor: &str) -> bool {
    let texto = r.text.as_deref().unwrap_or_default().to_lowercase();
    r.ok && !r.pending && texto.contains(&valor.to_lowercase())
}

/// Solo la familia 5.5: Opus y Sonnet con o sin la ventana de 1M; Haiku sin
/// ella (decisión del 2026-10-21: Haiku 5.5 para sesiones baratas).
pub fn valid_model_55(model: &str) -> bool {
    model == "claude-haiku-5-5"
        || matches!(model_key(model), "claude-opus-5-5" | "claude-sonnet-5-5")
}

/// `/model <id>`: `SessionInfo.model` cambia cuando el puente lo confirma
/// (`status.model`), no al escribirlo. Con el texto de confirmación, el
/// modelo entra también en la `Config` de `restart` y de la restauración (el
/// `status` del puente lo repite si el texto no lo nombra).
pub fn set_model(id: &str, model: &str) -> Result<OpResult, String> {
    let model = model.trim();
    if !valid_model_55(model) {
        return Err(format!(
            "modelo no permitido: '{model}' (solo claude-opus-5-5 o claude-sonnet-5-5, con [1m] opcional, o claude-haiku-5-5)"
        ));
    }
    let r = comando_run::ajuste(id, "model", model)?;
    if confirma(&r, model) {
        lanzamiento::actualizar(id, Some(model), None);
    }
    Ok(r)
}

pub fn valid_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && !id.contains("..")
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

pub fn set_socratic(project_id: &str, mode: &str) -> Result<(), String> {
    if !valid_project_id(project_id) {
        return Err(format!("id de proyecto no válido: '{project_id}'"));
    }
    if !SOCRATIC_MODES.contains(&mode) {
        return Err(format!(
            "modo socrático no válido: '{mode}' (strict, light, off o uni)"
        ));
    }
    let script = dirs::home_dir()
        .ok_or_else(|| "no hay directorio personal".to_string())?
        .join(".ultron/scripts/project-socratic.mjs");
    if !script.is_file() {
        return Err(format!("no existe el script {}", script.display()));
    }
    let node = which::which("node").map_err(|_| "no se encontró 'node' en el PATH".to_string())?;
    let mut cmd = std::process::Command::new(node);
    cmd.arg(&script).args([project_id, mode]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd
        .output()
        .map_err(|e| format!("no se pudo ejecutar project-socratic.mjs: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    Err(format!("project-socratic.mjs falló: {}", err.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn effort_del_modelo_antes_que_el_global() {
        let s = json!({"effortLevel":"high","modelSettings":{"claude-sonnet-5-5":{"effortLevel":"xhigh"}}});
        assert_eq!(
            effort_from(&s, Some("claude-sonnet-5-5[1m]")).as_deref(),
            Some("xhigh")
        );
        assert_eq!(
            effort_from(&s, Some("claude-opus-5-5")).as_deref(),
            Some("high")
        );
        assert_eq!(effort_from(&Value::Null, Some("claude-opus-5-5")), None);
    }

    #[test]
    fn socratico_por_id_por_ruta_y_por_defecto() {
        let r = json!({"projects":[
            {"id":"a","path":"C:\\p\\a","socratic":"uni"},
            {"id":"b","path":"C:\\p\\a\\b"},
            {"id":"c","path":"C:\\p\\c","socratic":"raro"}
        ]});
        assert_eq!(socratic_for(&r, Some("a"), "").as_deref(), Some("uni"));
        assert_eq!(
            socratic_for(&r, None, "C:/p/a/b/src").as_deref(),
            Some("strict")
        );
        assert_eq!(
            socratic_for(&r, None, "C:\\p\\a\\x").as_deref(),
            Some("uni")
        );
        assert_eq!(socratic_for(&r, Some("c"), "").as_deref(), Some("strict"));
        assert_eq!(socratic_for(&r, None, "C:\\p\\ab"), None);
    }

    #[test]
    fn solo_modelos_de_la_familia_5_5() {
        assert!(valid_model_55("claude-opus-5-5"));
        assert!(valid_model_55("claude-sonnet-5-5[1m]"));
        assert!(valid_model_55("claude-haiku-5-5"));
        assert!(!valid_model_55("claude-haiku-5-5[1m]"), "Haiku sin 1M");
        assert!(!valid_model_55("claude-haiku-4-5"));
        assert!(!valid_model_55("claude-opus-5"));
        assert!(!valid_model_55("opus"));
        assert!(!valid_model_55("claude-opus-5-5; rm"));
    }

    #[test]
    fn effort_y_socratico_rechazan_valores_fuera_de_lista() {
        assert!(set_effort("no-existe", "ultra").is_err());
        assert!(set_socratic("../x", "off").is_err());
        assert!(set_socratic("proyecto", "medio").is_err());
        assert!(set_model("no-existe", "claude-haiku-4").is_err());
    }
}
