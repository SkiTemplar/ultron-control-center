// ULTRON Control Center — AI Router config (which provider runs which zone).
//
// The config lives in `~/.ultron/.tmp/ai-router.json` so other ULTRON tools
// (Python scripts, news pipeline, future zones) can read the same source
// of truth without going through Tauri. If the file is missing we write
// defaults on first read so the user can see a real JSON on disk and edit
// it externally if needed.
//
// Allowed providers are kept intentionally narrow: claude / codex / gemini.
// Anything else is rejected at save time so we never persist a typo that
// would silently route to nothing later.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiRouterConfig {
    #[serde(default = "default_diagnose")]
    pub diagnose: String,
    #[serde(default = "default_summarize")]
    pub summarize: String,
    #[serde(default = "default_brainstorm_plans")]
    pub brainstorm_plans: String,
    #[serde(default = "default_news_generate")]
    pub news_generate: String,
    #[serde(default = "default_skill_edit")]
    pub skill_edit: String,
    #[serde(default = "default_mcp_create")]
    pub mcp_create: String,
    #[serde(default = "default_repo_review")]
    pub repo_review: String,
}

fn default_diagnose() -> String { "claude".into() }
fn default_summarize() -> String { "codex".into() }
fn default_brainstorm_plans() -> String { "codex".into() }
fn default_news_generate() -> String { "gemini".into() }
fn default_skill_edit() -> String { "claude".into() }
fn default_mcp_create() -> String { "claude".into() }
fn default_repo_review() -> String { "codex".into() }

impl Default for AiRouterConfig {
    fn default() -> Self {
        AiRouterConfig {
            diagnose: default_diagnose(),
            summarize: default_summarize(),
            brainstorm_plans: default_brainstorm_plans(),
            news_generate: default_news_generate(),
            skill_edit: default_skill_edit(),
            mcp_create: default_mcp_create(),
            repo_review: default_repo_review(),
        }
    }
}

fn router_file() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/.tmp/ai-router.json"))
}

fn validate_provider(name: &str, value: &str) -> Result<(), String> {
    match value {
        "claude" | "codex" | "gemini" => Ok(()),
        other => Err(format!(
            "invalid provider '{}' for field '{}', expected claude/codex/gemini",
            other, name
        )),
    }
}

fn write_atomic(path: &PathBuf, cfg: &AiRouterConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir tmp: {}", e))?;
        }
    }
    let serialized =
        serde_json::to_string_pretty(cfg).map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

pub fn read_ai_router_inner() -> Result<AiRouterConfig, String> {
    let path = router_file().ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        let cfg = AiRouterConfig::default();
        // Best-effort: if we cannot write the defaults, still return them
        // to the caller — read should never hard-fail just because we
        // couldn't create the file. We surface the error in stderr only.
        if let Err(e) = write_atomic(&path, &cfg) {
            eprintln!("[ai_router] failed to seed defaults at {:?}: {}", path, e);
        }
        return Ok(cfg);
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    // Use serde defaults for missing fields so adding a new zone later
    // doesn't break older configs on disk.
    let cfg: AiRouterConfig = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {:?}: {}", path, e))?;
    Ok(cfg)
}

pub fn save_ai_router_inner(cfg: AiRouterConfig) -> Result<AiRouterConfig, String> {
    validate_provider("diagnose", &cfg.diagnose)?;
    validate_provider("summarize", &cfg.summarize)?;
    validate_provider("brainstorm_plans", &cfg.brainstorm_plans)?;
    validate_provider("news_generate", &cfg.news_generate)?;
    validate_provider("skill_edit", &cfg.skill_edit)?;
    validate_provider("mcp_create", &cfg.mcp_create)?;
    validate_provider("repo_review", &cfg.repo_review)?;

    let path = router_file().ok_or_else(|| "no HOME".to_string())?;
    write_atomic(&path, &cfg)?;
    Ok(cfg)
}
