// sesiones/modelos.rs — Modelos que ofrece cada motor externo y validación
// del modelo elegido (`sesiones_engine_models`).
//
// La lista sale de la propia CLI, no de una tabla fija: `codex debug models`
// (JSON, solo los de `visibility: "list"`) y `agy models` (una línea
// `id<TAB>nombre` por modelo). Los aciertos se cachean mientras dure la app y
// los fallos 60 s; la consulta tiene un tope de 10 s (motores-ventanas:F11).
//
// También guarda el effort de Codex (`model_reasoning_effort`) elegido en
// Ajustes → Motores, en `cockpit/sesiones/motores-ajustes.json` (ignorado por
// git); los niveles admitidos salen de la misma lista de la CLI
// (motores-ventanas:F2).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::motores::{self, GeminiCli};

const MODEL_MAX: usize = 80;
/// Tope de `codex debug models` / `agy models`.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// Tiempo que se recuerda un fallo antes de volver a preguntar a la CLI.
pub const ERROR_TTL: Duration = Duration::from_secs(60);

/// Modelo seleccionable de un motor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EngineModel {
    pub id: String,
    pub label: String,
    /// Niveles de effort que admite (solo Codex; vacío = desconocidos). No
    /// viaja en la lista: lo expone `sesiones_engine_effort_get`.
    #[serde(skip)]
    pub efforts: Vec<String>,
}

/// Rechaza identificadores que no sean un nombre de modelo: van como
/// argumento de la CLI.
pub fn validate_model(model: &str) -> Result<(), String> {
    let ok = !model.is_empty()
        && !model.starts_with('-')
        && model.len() <= MODEL_MAX
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':'));
    if ok {
        Ok(())
    } else {
        Err(format!("modelo no válido: '{model}'"))
    }
}

/// Valida el modelo según el motor: OpenCode usa `proveedor/modelo`.
pub fn validate_model_for(engine: &str, model: &str) -> Result<(), String> {
    if engine == "opencode" {
        super::opencode_modelos::validate_model(model)
    } else {
        validate_model(model)
    }
}

/// Modelos visibles de `codex debug models`.
pub fn parse_codex_models(json: &str) -> Vec<EngineModel> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return Vec::new();
    };
    v["models"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|m| m["visibility"].as_str() == Some("list"))
                .filter_map(|m| {
                    let id = m["slug"].as_str()?.to_string();
                    let label = m["display_name"].as_str().unwrap_or(&id).to_string();
                    let efforts = parse_levels(m);
                    Some(EngineModel { id, label, efforts })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Niveles de `supported_reasoning_levels` de un modelo de `codex debug models`.
fn parse_levels(m: &serde_json::Value) -> Vec<String> {
    m["supported_reasoning_levels"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|l| l["effort"].as_str())
                .filter(|e| validate_effort(e).is_ok())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// Modelos de `agy models`: líneas `id<TAB>nombre`; el resto se ignora.
pub fn parse_agy_models(text: &str) -> Vec<EngineModel> {
    text.lines()
        .filter_map(|l| {
            let (id, label) = l.split_once('\t')?;
            let id = id.trim();
            validate_model(id).ok()?;
            Some(EngineModel {
                id: id.to_string(),
                label: label.trim().to_string(),
                efforts: Vec::new(),
            })
        })
        .collect()
}

fn run_cli(engine: &str) -> Result<String, String> {
    let (program, args): (_, &[&str]) = match engine {
        "codex" => (motores::codex_program()?, &["debug", "models"]),
        "gemini" => match motores::gemini_program()? {
            (GeminiCli::Agy, p) => (p, &["models"]),
            (GeminiCli::Npm, _) => {
                return Err("la CLI 'gemini' de npm no lista modelos: instala agy".to_string())
            }
        },
        other => return Err(format!("motor desconocido: '{other}'")),
    };
    let cwd = std::env::temp_dir();
    let mut cmd = motores::command_for(&program, &cwd.to_string_lossy());
    cmd.args(args);
    let out = super::cli_info::run_cli(cmd, LIST_TIMEOUT, engine)
        .map_err(|e| format!("no se pudo pedir la lista de modelos a {engine}: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "{engine} no devolvió la lista de modelos: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Resultado cacheado de una consulta: lista (sin caducidad) o error con su
/// instante.
#[derive(Debug, Clone)]
enum Cached {
    Ok(Vec<EngineModel>),
    Err(String, Instant),
}

type Cache = Mutex<HashMap<String, Cached>>;

fn cache() -> &'static Cache {
    static C: OnceLock<Cache> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Lo cacheado que sigue vigente en `ahora`.
fn vigente(c: &Cached, ahora: Instant) -> Option<Result<Vec<EngineModel>, String>> {
    match c {
        Cached::Ok(v) => Some(Ok(v.clone())),
        Cached::Err(e, at) if ahora.duration_since(*at) < ERROR_TTL => Some(Err(e.clone())),
        Cached::Err(..) => None,
    }
}

fn fetch(engine: &str) -> Result<Vec<EngineModel>, String> {
    let raw = run_cli(engine)?;
    let models = if engine == "codex" {
        parse_codex_models(&raw)
    } else {
        parse_agy_models(&raw)
    };
    if models.is_empty() {
        return Err(format!("{engine} no devolvió ningún modelo"));
    }
    Ok(models)
}

/// Modelos del motor: la lista se cachea tras el primer acierto y un fallo
/// se recuerda `ERROR_TTL` para no relanzar la CLI en cada apertura.
pub fn list(engine: &str) -> Result<Vec<EngineModel>, String> {
    if engine == "opencode" {
        return super::opencode_modelos::list();
    }
    list_with(engine, Instant::now(), fetch)
}

/// Lista de `clave` con la caché de este módulo (OpenCode, por proveedor).
pub fn list_cacheada(
    clave: &str,
    fetch: impl FnOnce(&str) -> Result<Vec<EngineModel>, String>,
) -> Result<Vec<EngineModel>, String> {
    list_with(clave, Instant::now(), fetch)
}

fn list_with(
    engine: &str,
    ahora: Instant,
    fetch: impl FnOnce(&str) -> Result<Vec<EngineModel>, String>,
) -> Result<Vec<EngineModel>, String> {
    let hit = cache()
        .lock()
        .ok()
        .and_then(|c| c.get(engine).and_then(|x| vigente(x, ahora)));
    if let Some(r) = hit {
        return r;
    }
    let fresh = fetch(engine);
    let entry = match &fresh {
        Ok(v) => Cached::Ok(v.clone()),
        Err(e) => Cached::Err(e.clone(), ahora),
    };
    if let Ok(mut c) = cache().lock() {
        c.insert(engine.to_string(), entry);
    }
    fresh
}

// ---------------------------------------------------------------------------
// Effort de Codex (`-c model_reasoning_effort=`)
// ---------------------------------------------------------------------------

const EFFORT_MAX: usize = 16;

/// Un nivel de effort va como valor de `-c`: solo minúsculas ASCII.
pub fn validate_effort(effort: &str) -> Result<(), String> {
    let ok = !effort.is_empty()
        && effort.len() <= EFFORT_MAX
        && effort.chars().all(|c| c.is_ascii_lowercase());
    if ok {
        Ok(())
    } else {
        Err(format!("effort no válido: '{effort}'"))
    }
}

/// Effort guardado de Codex y niveles que se pueden elegir.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEffort {
    /// `None` = el de `~/.codex/config.toml`.
    pub effort: Option<String>,
    /// Niveles del modelo pedido (o de todos, sin repetir, si no se conoce).
    pub levels: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AjustesMotores {
    codex_effort: Option<String>,
}

fn ajustes_path() -> Option<PathBuf> {
    if cfg!(test) {
        return None; // los tests nunca tocan el cockpit real
    }
    crate::ultron_root().ok().map(|r| {
        r.join("cockpit")
            .join("sesiones")
            .join("motores-ajustes.json")
    })
}

fn leer_ajustes(path: &Path) -> AjustesMotores {
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "motores-ajustes.json no válido: se ignora");
            AjustesMotores::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => AjustesMotores::default(),
        Err(e) => {
            tracing::warn!(error = %e, "no se pudo leer motores-ajustes.json");
            AjustesMotores::default()
        }
    }
}

fn escribir_ajustes(path: &Path, ajustes: &AjustesMotores) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(ajustes).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

fn effort_actual() -> &'static Mutex<Option<String>> {
    static E: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    E.get_or_init(|| Mutex::new(ajustes_path().and_then(|p| leer_ajustes(&p).codex_effort)))
}

/// Effort de Codex guardado.
pub fn codex_effort() -> Option<String> {
    effort_actual().lock().ok().and_then(|e| e.clone())
}

/// Guarda el effort de Codex (`None` vuelve al de `config.toml`).
pub fn set_codex_effort(effort: Option<String>) -> Result<Option<String>, String> {
    let effort = effort.filter(|e| !e.is_empty());
    if let Some(e) = &effort {
        validate_effort(e)?;
    }
    if let Some(path) = ajustes_path() {
        let mut ajustes = leer_ajustes(&path);
        ajustes.codex_effort = effort.clone();
        escribir_ajustes(&path, &ajustes)?;
    }
    let mut actual = effort_actual()
        .lock()
        .map_err(|_| "ajustes de motores bloqueados".to_string())?;
    *actual = effort.clone();
    Ok(effort)
}

/// Niveles del modelo `model`; sin modelo o sin datos, la unión de todos.
pub fn levels_for(models: &[EngineModel], model: Option<&str>) -> Vec<String> {
    if let Some(m) = model.and_then(|id| models.iter().find(|m| m.id == id)) {
        if !m.efforts.is_empty() {
            return m.efforts.clone();
        }
    }
    let mut out: Vec<String> = Vec::new();
    for e in models.iter().flat_map(|m| m.efforts.iter()) {
        if !out.contains(e) {
            out.push(e.clone());
        }
    }
    out
}

/// Effort que recibe Codex con `model`: el guardado, salvo que la lista de la
/// CLI diga que ese modelo no lo admite (entonces manda `config.toml`).
pub fn effort_for(
    saved: Option<String>,
    model: Option<&str>,
    models: Option<&[EngineModel]>,
) -> Option<String> {
    let effort = saved?;
    let admitido = match (model, models) {
        (Some(id), Some(list)) => list
            .iter()
            .find(|m| m.id == id)
            .is_none_or(|m| m.efforts.is_empty() || m.efforts.contains(&effort)),
        _ => true,
    };
    admitido.then_some(effort)
}

/// Lista de Codex ya cacheada (sin lanzar la CLI).
fn codex_cacheada() -> Option<Vec<EngineModel>> {
    let c = cache().lock().ok()?;
    match c.get("codex")? {
        Cached::Ok(v) => Some(v.clone()),
        Cached::Err(..) => None,
    }
}

/// Effort que se pasa al lanzar Codex con `model`.
pub fn codex_effort_for(model: Option<&str>) -> Option<String> {
    effort_for(codex_effort(), model, codex_cacheada().as_deref())
}

fn solo_codex(engine: &str) -> Result<(), String> {
    if engine == "codex" {
        Ok(())
    } else {
        Err(format!("el motor '{engine}' no admite elegir effort"))
    }
}

/// Effort guardado del motor y niveles que admite `model`.
#[tauri::command]
pub async fn sesiones_engine_effort_get(
    engine: String,
    model: Option<String>,
) -> Result<EngineEffort, String> {
    solo_codex(&engine)?;
    tauri::async_runtime::spawn_blocking(move || {
        let models = list("codex").unwrap_or_default();
        EngineEffort {
            effort: codex_effort(),
            levels: levels_for(&models, model.as_deref()),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Guarda el effort del motor (`null` = el de su configuración).
#[tauri::command]
pub async fn sesiones_engine_effort_set(
    engine: String,
    effort: Option<String>,
) -> Result<Option<String>, String> {
    solo_codex(&engine)?;
    tauri::async_runtime::spawn_blocking(move || set_codex_effort(effort))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_solo_lista_los_visibles() {
        let json = r#"{"models":[{"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list"},{"slug":"oculto","visibility":"hide"}]}"#;
        let m = parse_codex_models(json);
        assert_eq!(
            m,
            vec![EngineModel {
                id: "gpt-6-astra".into(),
                label: "GPT-6-Astra".into(),
                efforts: Vec::new(),
            }]
        );
        assert!(parse_codex_models("no es json").is_empty());
    }

    #[test]
    fn agy_ignora_cabecera_y_lineas_sin_tabulador() {
        let text = "Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\n{\"models\":[]}\n";
        let m = parse_agy_models(text);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].id, "gemini-3.1-pro-high");
    }

    #[test]
    fn un_fallo_se_recuerda_60_s_y_despues_se_reintenta() {
        let t0 = Instant::now();
        let calls = std::cell::Cell::new(0);
        let falla = |_: &str| {
            calls.set(calls.get() + 1);
            Err("sin red".to_string())
        };
        assert!(list_with("prueba-fallo", t0, falla).is_err());
        let r = list_with("prueba-fallo", t0 + Duration::from_secs(30), falla);
        assert_eq!(r, Err("sin red".to_string()));
        assert_eq!(calls.get(), 1, "dentro de los 60 s no se relanza la CLI");
        let ok = |_: &str| {
            Ok(vec![EngineModel {
                id: "m".into(),
                label: "M".into(),
                efforts: Vec::new(),
            }])
        };
        let r = list_with("prueba-fallo", t0 + ERROR_TTL + Duration::from_secs(1), ok);
        assert_eq!(
            r.map(|v| v.len()),
            Ok(1),
            "pasado el plazo se vuelve a preguntar"
        );
    }

    #[test]
    fn el_tope_de_la_lista_no_pasa_de_10_s() {
        assert!(LIST_TIMEOUT <= Duration::from_secs(10));
    }

    #[test]
    fn rechaza_modelos_que_parecen_argumentos() {
        assert!(validate_model("gpt-5.6-sol").is_ok());
        assert!(validate_model("--dangerously-bypass").is_err());
        assert!(validate_model("x y").is_err());
        assert!(validate_model("a\"b").is_err());
        assert!(validate_model("").is_err());
    }

    fn modelo(id: &str, efforts: &[&str]) -> EngineModel {
        EngineModel {
            id: id.into(),
            label: id.into(),
            efforts: efforts.iter().map(|e| e.to_string()).collect(),
        }
    }

    #[test]
    fn los_niveles_salen_de_la_lista_de_codex() {
        let json = r#"{"models":[{"slug":"a","visibility":"list","supported_reasoning_levels":[{"effort":"low"},{"effort":"ultra"},{"effort":"x\" --sandbox"}]}]}"#;
        assert_eq!(parse_codex_models(json)[0].efforts, vec!["low", "ultra"]);
    }

    #[test]
    fn niveles_del_modelo_o_union_sin_repetir() {
        let list = [modelo("a", &["low", "ultra"]), modelo("b", &["low", "max"])];
        assert_eq!(levels_for(&list, Some("b")), vec!["low", "max"]);
        assert_eq!(levels_for(&list, None), vec!["low", "ultra", "max"]);
        assert_eq!(
            levels_for(&list, Some("retirado")),
            vec!["low", "ultra", "max"]
        );
    }

    #[test]
    fn el_effort_solo_se_manda_si_el_modelo_lo_admite() {
        let list = [modelo("luna", &["low", "max"]), modelo("astra", &[])];
        let ultra = || Some("ultra".to_string());
        assert_eq!(effort_for(ultra(), Some("luna"), Some(&list)), None);
        assert_eq!(
            effort_for(Some("max".into()), Some("luna"), Some(&list)),
            Some("max".into())
        );
        assert_eq!(effort_for(ultra(), Some("astra"), Some(&list)), ultra());
        assert_eq!(effort_for(ultra(), None, Some(&list)), ultra());
        assert_eq!(effort_for(ultra(), Some("luna"), None), ultra());
        assert_eq!(effort_for(None, Some("luna"), Some(&list)), None);
    }

    #[test]
    fn set_codex_effort_valida_y_vuelve_al_de_config() {
        assert!(set_codex_effort(Some("x\" -s".into())).is_err());
        assert!(validate_effort("HIGH").is_err());
        assert_eq!(
            set_codex_effort(Some("high".into())),
            Ok(Some("high".into()))
        );
        assert_eq!(codex_effort(), Some("high".into()));
        assert_eq!(set_codex_effort(Some(String::new())), Ok(None));
        assert_eq!(codex_effort(), None);
    }

    #[test]
    fn effort_de_otro_motor_es_error_visible() {
        assert!(solo_codex("gemini").is_err());
        assert!(solo_codex("codex").is_ok());
    }
}
