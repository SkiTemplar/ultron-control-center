// ULTRON Control Center — AI Router config (which provider + model runs which zone).
//
// The config lives in `~/.ultron/.tmp/ai-router.json` so other ULTRON tools
// (Python scripts, news pipeline, future zones) can read the same source
// of truth without going through Tauri. If the file is missing we write
// defaults on first read so the user can see a real JSON on disk and edit
// it externally if needed.
//
// Allowed providers are kept intentionally narrow: claude / codex / gemini.
// Anything else is rejected at save time so we never persist a typo that
// would silently route to nothing later. `model` is opaque (validated only
// for length / control chars) — the frontend hard-codes the dropdown choices
// but a power-user editing the JSON directly can pick any string they want.
//
// v15.2 shape upgrade
// -------------------
// Old shape (v15.1):  { "diagnose": "claude" }
// New shape (v15.2):  { "diagnose": { "provider": "claude", "model": null } }
//
// `read_ai_router_inner` accepts both via an untagged enum: legacy string
// values are auto-upgraded in memory to `AiRouterEntry { provider, model: None }`.
// We do NOT rewrite the file on read (avoids surprise writes); the next save
// from the UI naturally persists the new shape.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Per-zone routing entry. `model` is optional: `None` means "use the
/// provider's account default" (whatever the CLI picks).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AiRouterEntry {
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
}

impl AiRouterEntry {
    fn new(provider: &str) -> Self {
        AiRouterEntry {
            provider: provider.to_string(),
            model: None,
        }
    }
}

/// Wire shape that accepts both the legacy bare-string form and the new
/// object form. Used only during deserialization; we collapse to
/// `AiRouterEntry` immediately after parsing.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum AiRouterEntryWire {
    Legacy(String),
    Full(AiRouterEntry),
}

impl From<AiRouterEntryWire> for AiRouterEntry {
    fn from(w: AiRouterEntryWire) -> Self {
        match w {
            AiRouterEntryWire::Legacy(s) => AiRouterEntry {
                provider: s,
                model: None,
            },
            AiRouterEntryWire::Full(e) => e,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AiRouterConfig {
    #[serde(default = "default_diagnose", deserialize_with = "de_entry")]
    pub diagnose: AiRouterEntry,
    #[serde(default = "default_summarize", deserialize_with = "de_entry")]
    pub summarize: AiRouterEntry,
    #[serde(default = "default_brainstorm_plans", deserialize_with = "de_entry")]
    pub brainstorm_plans: AiRouterEntry,
    #[serde(default = "default_news_generate", deserialize_with = "de_entry")]
    pub news_generate: AiRouterEntry,
    #[serde(default = "default_skill_edit", deserialize_with = "de_entry")]
    pub skill_edit: AiRouterEntry,
    #[serde(default = "default_mcp_create", deserialize_with = "de_entry")]
    pub mcp_create: AiRouterEntry,
    #[serde(default = "default_repo_review", deserialize_with = "de_entry")]
    pub repo_review: AiRouterEntry,
    // v15.2.38: new zones to plug the hardcoded-provider call sites the
    // user surfaced. Defaults stay on claude for safety; the user picks
    // codex / gemini per zone from Settings -> AI Router.
    #[serde(default = "default_personal_analyse", deserialize_with = "de_entry")]
    pub personal_analyse: AiRouterEntry,
    #[serde(default = "default_memory_analyse", deserialize_with = "de_entry")]
    pub memory_analyse: AiRouterEntry,
    #[serde(default = "default_notif_fix", deserialize_with = "de_entry")]
    pub notif_fix: AiRouterEntry,
    #[serde(default = "default_self_improve", deserialize_with = "de_entry")]
    pub self_improve: AiRouterEntry,
    #[serde(default = "default_system_analyse", deserialize_with = "de_entry")]
    pub system_analyse: AiRouterEntry,
    #[serde(default = "default_usage_analyse", deserialize_with = "de_entry")]
    pub usage_analyse: AiRouterEntry,
    #[serde(default = "default_skill_create", deserialize_with = "de_entry")]
    pub skill_create: AiRouterEntry,
}

fn de_entry<'de, D>(d: D) -> Result<AiRouterEntry, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let wire = AiRouterEntryWire::deserialize(d)?;
    Ok(wire.into())
}

fn default_diagnose() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_summarize() -> AiRouterEntry { AiRouterEntry::new("codex") }
fn default_brainstorm_plans() -> AiRouterEntry { AiRouterEntry::new("codex") }
fn default_news_generate() -> AiRouterEntry { AiRouterEntry::new("gemini") }
fn default_skill_edit() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_mcp_create() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_repo_review() -> AiRouterEntry { AiRouterEntry::new("codex") }
fn default_personal_analyse() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_memory_analyse() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_notif_fix() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_self_improve() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_system_analyse() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_usage_analyse() -> AiRouterEntry { AiRouterEntry::new("claude") }
fn default_skill_create() -> AiRouterEntry { AiRouterEntry::new("claude") }

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
            personal_analyse: default_personal_analyse(),
            memory_analyse: default_memory_analyse(),
            notif_fix: default_notif_fix(),
            self_improve: default_self_improve(),
            system_analyse: default_system_analyse(),
            usage_analyse: default_usage_analyse(),
            skill_create: default_skill_create(),
        }
    }
}

impl AiRouterConfig {
    /// Look up a zone by string key. Used by call sites that need to read
    /// the routing decision for a specific feature (news, diagnose, ...).
    /// Returns `None` for unknown keys so callers can fall back to a hard
    /// default without panicking.
    pub fn zone(&self, key: &str) -> Option<&AiRouterEntry> {
        match key {
            "diagnose" => Some(&self.diagnose),
            "summarize" => Some(&self.summarize),
            "brainstorm_plans" => Some(&self.brainstorm_plans),
            "news_generate" => Some(&self.news_generate),
            "skill_edit" => Some(&self.skill_edit),
            "mcp_create" => Some(&self.mcp_create),
            "repo_review" => Some(&self.repo_review),
            "personal_analyse" => Some(&self.personal_analyse),
            "memory_analyse" => Some(&self.memory_analyse),
            "notif_fix" => Some(&self.notif_fix),
            "self_improve" => Some(&self.self_improve),
            "system_analyse" => Some(&self.system_analyse),
            "usage_analyse" => Some(&self.usage_analyse),
            "skill_create" => Some(&self.skill_create),
            _ => None,
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

fn validate_model(name: &str, value: &Option<String>) -> Result<(), String> {
    // Models are opaque strings: we only enforce sanity (no control chars,
    // reasonable length). The frontend has its own allow-list per provider
    // but power-users editing the JSON directly can pick anything that
    // their CLI will accept.
    if let Some(m) = value {
        if m.is_empty() {
            return Err(format!("model for '{}' is empty (use null instead)", name));
        }
        if m.len() > 64 {
            return Err(format!("model for '{}' too long (>64 chars)", name));
        }
        if m.chars().any(|c| c.is_control() || c == ' ') {
            return Err(format!("model for '{}' has invalid characters", name));
        }
    }
    Ok(())
}

fn validate_entry(name: &str, entry: &AiRouterEntry) -> Result<(), String> {
    validate_provider(name, &entry.provider)?;
    validate_model(name, &entry.model)?;
    Ok(())
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
    // The custom `de_entry` deserializer handles both legacy string and new
    // object shapes per field, so configs on disk from v15.1 keep working.
    let cfg: AiRouterConfig = serde_json::from_str(&raw)
        .map_err(|e| format!("parse {:?}: {}", path, e))?;
    Ok(cfg)
}

pub fn save_ai_router_inner(cfg: AiRouterConfig) -> Result<AiRouterConfig, String> {
    validate_entry("diagnose", &cfg.diagnose)?;
    validate_entry("summarize", &cfg.summarize)?;
    validate_entry("brainstorm_plans", &cfg.brainstorm_plans)?;
    validate_entry("news_generate", &cfg.news_generate)?;
    validate_entry("skill_edit", &cfg.skill_edit)?;
    validate_entry("mcp_create", &cfg.mcp_create)?;
    validate_entry("repo_review", &cfg.repo_review)?;

    let path = router_file().ok_or_else(|| "no HOME".to_string())?;
    write_atomic(&path, &cfg)?;
    Ok(cfg)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_legacy_string_shape() {
        let raw = r#"{
            "diagnose": "claude",
            "summarize": "codex",
            "brainstorm_plans": "codex",
            "news_generate": "gemini",
            "skill_edit": "claude",
            "mcp_create": "claude",
            "repo_review": "codex"
        }"#;
        let cfg: AiRouterConfig = serde_json::from_str(raw).expect("legacy shape parses");
        assert_eq!(cfg.diagnose.provider, "claude");
        assert!(cfg.diagnose.model.is_none());
        assert_eq!(cfg.news_generate.provider, "gemini");
        assert!(cfg.news_generate.model.is_none());
    }

    #[test]
    fn parses_new_object_shape() {
        let raw = r#"{
            "diagnose": { "provider": "claude", "model": "claude-opus-4-7" },
            "summarize": { "provider": "codex", "model": null },
            "brainstorm_plans": { "provider": "codex", "model": "gpt-5.5" },
            "news_generate": { "provider": "gemini", "model": "gemini-3.1-pro" },
            "skill_edit": { "provider": "claude", "model": null },
            "mcp_create": { "provider": "claude", "model": null },
            "repo_review": { "provider": "codex", "model": null }
        }"#;
        let cfg: AiRouterConfig = serde_json::from_str(raw).expect("new shape parses");
        assert_eq!(cfg.diagnose.provider, "claude");
        assert_eq!(cfg.diagnose.model.as_deref(), Some("claude-opus-4-7"));
        assert_eq!(cfg.news_generate.model.as_deref(), Some("gemini-3.1-pro"));
        assert!(cfg.summarize.model.is_none());
    }

    #[test]
    fn parses_mixed_shape() {
        // A user that hand-edited only some fields after upgrade.
        let raw = r#"{
            "diagnose": "claude",
            "news_generate": { "provider": "gemini", "model": "gemini-3.1-flash" }
        }"#;
        let cfg: AiRouterConfig = serde_json::from_str(raw).expect("mixed shape parses");
        assert_eq!(cfg.diagnose.provider, "claude");
        assert!(cfg.diagnose.model.is_none());
        assert_eq!(cfg.news_generate.model.as_deref(), Some("gemini-3.1-flash"));
        // Missing fields fall back to defaults.
        assert_eq!(cfg.summarize.provider, "codex");
    }

    #[test]
    fn rejects_bad_provider() {
        let mut cfg = AiRouterConfig::default();
        cfg.diagnose.provider = "openai".into();
        let err = save_ai_router_inner(cfg).err().expect("should reject");
        assert!(err.contains("invalid provider"));
    }

    #[test]
    fn rejects_empty_model_string() {
        let mut cfg = AiRouterConfig::default();
        cfg.diagnose.model = Some(String::new());
        let err = save_ai_router_inner(cfg).err().expect("should reject");
        assert!(err.contains("empty"));
    }

    #[test]
    fn zone_lookup_works() {
        let cfg = AiRouterConfig::default();
        assert_eq!(cfg.zone("diagnose").unwrap().provider, "claude");
        assert_eq!(cfg.zone("news_generate").unwrap().provider, "gemini");
        assert!(cfg.zone("nonexistent").is_none());
    }
}
