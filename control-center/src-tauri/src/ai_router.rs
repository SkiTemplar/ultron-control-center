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
// v15.2.39 shape:     { "diagnose": { "provider": "claude", "model": null, "agent": null } }
//
// `read_ai_router_inner` accepts all three shapes via an untagged enum:
// legacy string values are auto-upgraded in memory to
// `AiRouterEntry { provider, model: None, agent: None }`. Configs written
// before the `agent` field existed deserialize cleanly because the field
// is `#[serde(default)]`. We do NOT rewrite the file on read (avoids
// surprise writes); the next save from the UI naturally persists the new
// shape, including any agent the user picked.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Per-zone routing entry.
///
/// - `provider` — claude / codex / gemini.
/// - `model`   — optional; `None` means "use the provider's account
///   default" (whatever the CLI picks).
/// - `agent`   — optional subagent slug (filename stem under
///   `~/.claude/agents/`). When set AND the active provider is Claude,
///   `sessions::spawn_session_inner` prepends a `[USE AGENT: <slug>]`
///   directive to the prompt so the Claude session opens with the right
///   subagent context. `None` keeps the original behaviour.
/// - `auto_mode` — v15.2.40: when true, the frontend ignores the explicit
///   provider/model/agent on dispatch and asks the agents Qdrant index
///   (`embed_agents.py query`) to pick the best subagent for the prompt
///   at call time. Falls back to the manual config if the index is
///   unavailable or no agent scores above the threshold. `false` keeps
///   the original deterministic behaviour.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AiRouterEntry {
    pub provider: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub auto_mode: bool,
}

impl AiRouterEntry {
    fn new(provider: &str) -> Self {
        AiRouterEntry {
            provider: provider.to_string(),
            model: None,
            agent: None,
            auto_mode: false,
        }
    }

    /// Full constructor — provider + pinned model + optional subagent.
    /// Used by `default_*` recommendations so a fresh install (or a
    /// `reset_ai_router_to_defaults` invocation) lands on the curated
    /// agent+model combo instead of bare "claude default".
    fn with_full(provider: &str, model: Option<&str>, agent: Option<&str>) -> Self {
        AiRouterEntry {
            provider: provider.to_string(),
            model: model.map(str::to_string),
            agent: agent.map(str::to_string),
            auto_mode: false,
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
                agent: None,
                auto_mode: false,
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

// v15.4.4 — curated provider + model + agent per zone. Picked to match
// the strengths of each agent in `~/.claude/agents/` and the cost/quality
// trade-off of each provider:
//   - Opus 4.7 → brainstorm / creative / architectural reasoning.
//   - Sonnet 4.6 → default fast-but-smart (edits, fix-ups, analysis).
//   - Codex gpt-5.5 → adversarial review (different model = different blind spots).
//   - Gemini 3.1 pro → long-context (full repo, full newsletter).

fn default_diagnose() -> AiRouterEntry {
    // PC report → root-cause analysis is the debugger agent's job.
    AiRouterEntry::with_full("claude", Some("claude-sonnet-4-6"), Some("debugger"))
}
fn default_summarize() -> AiRouterEntry {
    // Newsletter HTML → long context wins, no agent needed.
    AiRouterEntry::with_full("gemini", Some("gemini-3.1-flash-preview"), None)
}
fn default_brainstorm_plans() -> AiRouterEntry {
    // Plan brainstorm wants depth → Opus, no agent (free-form exploration).
    AiRouterEntry::with_full("claude", Some("claude-opus-4-7"), None)
}
fn default_news_generate() -> AiRouterEntry {
    // Generative + long context → Gemini Pro, no agent.
    AiRouterEntry::with_full("gemini", Some("gemini-3.1-pro-preview"), None)
}
fn default_skill_edit() -> AiRouterEntry {
    // Markdown frontmatter tweaks → Sonnet is plenty, no agent.
    AiRouterEntry::with_full("claude", Some("claude-sonnet-4-6"), None)
}
fn default_mcp_create() -> AiRouterEntry {
    // mcp-developer agent exists for exactly this — Opus for the templating.
    AiRouterEntry::with_full("claude", Some("claude-opus-4-7"), Some("mcp-developer"))
}
fn default_repo_review() -> AiRouterEntry {
    // Adversarial → different model from author. Codex's gpt-5.5 is the
    // designated peer reviewer in ULTRON.
    AiRouterEntry::with_full("codex", Some("gpt-5.5"), None)
}
fn default_personal_analyse() -> AiRouterEntry {
    // Profile / known.json analysis → context-manager owns cross-doc state.
    AiRouterEntry::with_full("claude", Some("claude-sonnet-4-6"), Some("context-manager"))
}
fn default_memory_analyse() -> AiRouterEntry {
    // Vault / brain_index navigation → ultron-context is purpose-built.
    AiRouterEntry::with_full("claude", Some("claude-sonnet-4-6"), Some("ultron-context"))
}
fn default_notif_fix() -> AiRouterEntry {
    // Alert triage → debugger again (same root-cause discipline).
    AiRouterEntry::with_full("claude", Some("claude-sonnet-4-6"), Some("debugger"))
}
fn default_self_improve() -> AiRouterEntry {
    // Telemetry → architecture lens, Opus.
    AiRouterEntry::with_full("claude", Some("claude-opus-4-7"), Some("ultron-arch"))
}
fn default_system_analyse() -> AiRouterEntry {
    // Hooks / scheduled tasks / processes on Windows → PowerShell expert.
    AiRouterEntry::with_full(
        "claude",
        Some("claude-sonnet-4-6"),
        Some("powershell-7-expert"),
    )
}
fn default_usage_analyse() -> AiRouterEntry {
    // Token / cost arithmetic — small task, fast model, no agent.
    AiRouterEntry::with_full("claude", Some("claude-haiku-4-5"), None)
}
fn default_skill_create() -> AiRouterEntry {
    // Brand-new skill = creative + structured → Opus, no agent (the
    // skill-creator skill itself handles the methodology).
    AiRouterEntry::with_full("claude", Some("claude-opus-4-7"), None)
}

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

fn validate_agent(name: &str, value: &Option<String>) -> Result<(), String> {
    // Agent is an opaque filename stem under ~/.claude/agents/. We only
    // sanity-check it (no control chars, no path separators, reasonable
    // length). The frontend dropdown is the source of truth for which
    // slugs exist; a power-user editing the JSON directly can pick any
    // string that maps to a real .md file. Empty string → reject (use
    // null instead to mean "no agent").
    if let Some(a) = value {
        if a.is_empty() {
            return Err(format!("agent for '{}' is empty (use null instead)", name));
        }
        if a.len() > 64 {
            return Err(format!("agent for '{}' too long (>64 chars)", name));
        }
        if a.chars().any(|c| {
            c.is_control() || c == ' ' || c == '/' || c == '\\' || c == '.' || c == ':'
        }) {
            return Err(format!("agent for '{}' has invalid characters", name));
        }
    }
    Ok(())
}

fn validate_entry(name: &str, entry: &AiRouterEntry) -> Result<(), String> {
    validate_provider(name, &entry.provider)?;
    validate_model(name, &entry.model)?;
    validate_agent(name, &entry.agent)?;
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

// ---------------------------------------------------------------------------
// v15.2.40 — auto-mode resolver
//
// When a zone has `auto_mode: true`, the manual provider/model/agent picks
// are *ignored*: instead we ask the agents Qdrant index (via
// `embed_agents.py query "<prompt>"`) which subagent best matches the
// prompt and route accordingly. Defaults to Claude as the provider because
// only Claude understands the `[USE AGENT: <slug>]` directive today.
//
// Hard safety net: if the Python helper is missing / Qdrant is down /
// no agent scores above the confidence threshold, we silently fall back
// to the manual config so the button keeps working.
// ---------------------------------------------------------------------------
//
// Confidence threshold under which we don't trust the match. Tuned by
// hand: paraphrase-mpnet typically returns >0.6 for solid matches,
// 0.4-0.55 for borderline ones, <0.4 for "agent doesn't really fit".
const AUTO_MODE_MIN_SCORE: f64 = 0.5;

#[derive(Debug, Clone, Serialize)]
pub struct ResolvedRoute {
    /// Final entry the caller should hand to `spawn_session`.
    pub entry: AiRouterEntry,
    /// `true` when the entry was rewritten by auto-mode.
    pub auto_resolved: bool,
    /// Slug picked by the embedding query (if any) — informational.
    pub matched_agent: Option<String>,
    /// Similarity score (0..1) — informational.
    pub matched_score: Option<f64>,
    /// Why auto-mode fell back to manual, if applicable. `None` when
    /// auto-mode wasn't requested or succeeded cleanly.
    pub fallback_reason: Option<String>,
}

/// Shell out to `embed_agents.py query <text> --top 3` and pick the top
/// match. Returns `None` for any error so the caller can fall back to
/// the manual config without surfacing the failure as a hard error.
fn query_best_agent(prompt: &str) -> Option<(String, f64, Option<String>)> {
    let home = dirs::home_dir()?;
    let script = home.join(".ultron/scripts/cockpit/embed_agents.py");
    if !script.is_file() {
        return None;
    }
    // Truncate the prompt to a sane length — paraphrase-mpnet's window is
    // 512 tokens (~2000 chars). Longer prompts get clamped silently to
    // keep the CLI invocation snappy.
    let trimmed = if prompt.len() > 2000 {
        &prompt[..2000]
    } else {
        prompt
    };
    let output = std::process::Command::new("uv")
        .arg("run")
        .arg("python")
        .arg(&script)
        .arg("query")
        .arg(trimmed)
        .arg("--top")
        .arg("3")
        .current_dir(home.join(".ultron"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let parsed: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    let arr = parsed.as_array()?;
    let first = arr.first()?;
    let score = first.get("score").and_then(|s| s.as_f64())?;
    let name = first.get("name").and_then(|n| n.as_str())?.to_string();
    let model = first
        .get("model")
        .and_then(|m| m.as_str())
        .filter(|m| !m.is_empty())
        .map(|m| m.to_string());
    Some((name, score, model))
}

/// Map an agent's `model` frontmatter field (claude-opus-4-7 / sonnet /
/// haiku / opus / inherit / etc.) to a model string the spawn_session
/// pipeline understands. `inherit` and empty values become `None` so the
/// CLI picks its account default. Anything else is passed through.
fn normalise_agent_model(raw: Option<String>) -> Option<String> {
    let m = raw?;
    let lower = m.trim().to_lowercase();
    if lower.is_empty() || lower == "inherit" || lower == "default" {
        return None;
    }
    // Shortcuts the agent frontmatter often uses ("sonnet", "opus", ...).
    // Map them to the canonical model IDs we hand to the CLI.
    match lower.as_str() {
        "opus" => Some("claude-opus-4-7".into()),
        "sonnet" => Some("claude-sonnet-4-6".into()),
        "haiku" => Some("claude-haiku-4-5".into()),
        _ => Some(m),
    }
}

/// Resolve a zone for a given prompt. Honours `auto_mode`: when true and
/// the agents index returns a match above threshold, we rewrite the
/// entry as `provider=claude` with the picked agent (+ the agent's
/// preferred model if any). Otherwise — and on any failure — we return
/// the manual entry unchanged.
pub fn resolve_zone_inner(zone_key: String, prompt: String) -> Result<ResolvedRoute, String> {
    let cfg = read_ai_router_inner()?;
    let entry = cfg
        .zone(&zone_key)
        .ok_or_else(|| format!("unknown zone key: {}", zone_key))?
        .clone();
    if !entry.auto_mode {
        return Ok(ResolvedRoute {
            entry,
            auto_resolved: false,
            matched_agent: None,
            matched_score: None,
            fallback_reason: None,
        });
    }
    let Some((name, score, agent_model)) = query_best_agent(&prompt) else {
        return Ok(ResolvedRoute {
            entry,
            auto_resolved: false,
            matched_agent: None,
            matched_score: None,
            fallback_reason: Some("agents index unavailable".into()),
        });
    };
    if score < AUTO_MODE_MIN_SCORE {
        return Ok(ResolvedRoute {
            entry,
            auto_resolved: false,
            matched_agent: Some(name.clone()),
            matched_score: Some(score),
            fallback_reason: Some(format!(
                "best match '{}' scored {:.2} < threshold {:.2}",
                name, score, AUTO_MODE_MIN_SCORE
            )),
        });
    }
    let model = normalise_agent_model(agent_model);
    let resolved = AiRouterEntry {
        provider: "claude".into(),
        model,
        agent: Some(name.clone()),
        auto_mode: true,
    };
    Ok(ResolvedRoute {
        entry: resolved,
        auto_resolved: true,
        matched_agent: Some(name),
        matched_score: Some(score),
        fallback_reason: None,
    })
}

pub fn save_ai_router_inner(cfg: AiRouterConfig) -> Result<AiRouterConfig, String> {
    validate_entry("diagnose", &cfg.diagnose)?;
    validate_entry("summarize", &cfg.summarize)?;
    validate_entry("brainstorm_plans", &cfg.brainstorm_plans)?;
    validate_entry("news_generate", &cfg.news_generate)?;
    validate_entry("skill_edit", &cfg.skill_edit)?;
    validate_entry("mcp_create", &cfg.mcp_create)?;
    validate_entry("repo_review", &cfg.repo_review)?;
    validate_entry("personal_analyse", &cfg.personal_analyse)?;
    validate_entry("memory_analyse", &cfg.memory_analyse)?;
    validate_entry("notif_fix", &cfg.notif_fix)?;
    validate_entry("self_improve", &cfg.self_improve)?;
    validate_entry("system_analyse", &cfg.system_analyse)?;
    validate_entry("usage_analyse", &cfg.usage_analyse)?;
    validate_entry("skill_create", &cfg.skill_create)?;

    let path = router_file().ok_or_else(|| "no HOME".to_string())?;
    write_atomic(&path, &cfg)?;
    Ok(cfg)
}

/// v15.4.4 — re-apply the curated `default_*` recommendations across all
/// zones, ignoring whatever the user (or a previous version) wrote.
/// Useful when ULTRON ships a new mapping (better agent for X) and the
/// user wants to opt in without editing 14 dropdowns by hand.
pub fn reset_ai_router_to_defaults_inner() -> Result<AiRouterConfig, String> {
    let cfg = AiRouterConfig::default();
    save_ai_router_inner(cfg)
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
        assert!(cfg.diagnose.agent.is_none());
        assert_eq!(cfg.news_generate.provider, "gemini");
        assert!(cfg.news_generate.model.is_none());
        assert!(cfg.news_generate.agent.is_none());
    }

    #[test]
    fn parses_pre_agent_object_shape() {
        // Configs written by v15.2.38 (object shape but no `agent` field).
        // Must deserialize cleanly with `agent` defaulting to None.
        let raw = r#"{
            "diagnose": { "provider": "claude", "model": "claude-opus-4-7" }
        }"#;
        let cfg: AiRouterConfig = serde_json::from_str(raw).expect("pre-agent shape parses");
        assert_eq!(cfg.diagnose.provider, "claude");
        assert_eq!(cfg.diagnose.model.as_deref(), Some("claude-opus-4-7"));
        assert!(cfg.diagnose.agent.is_none());
    }

    #[test]
    fn parses_full_shape_with_agent() {
        let raw = r#"{
            "diagnose": { "provider": "claude", "model": null, "agent": "debugger" },
            "skill_edit": { "provider": "claude", "model": "claude-opus-4-7", "agent": "refactoring-specialist" }
        }"#;
        let cfg: AiRouterConfig = serde_json::from_str(raw).expect("with-agent shape parses");
        assert_eq!(cfg.diagnose.agent.as_deref(), Some("debugger"));
        assert_eq!(cfg.skill_edit.agent.as_deref(), Some("refactoring-specialist"));
        // Other zones default to no agent.
        assert!(cfg.summarize.agent.is_none());
    }

    #[test]
    fn rejects_empty_agent_string() {
        let mut cfg = AiRouterConfig::default();
        cfg.diagnose.agent = Some(String::new());
        let err = save_ai_router_inner(cfg).err().expect("should reject");
        assert!(err.contains("empty"));
    }

    #[test]
    fn rejects_agent_with_path_chars() {
        let mut cfg = AiRouterConfig::default();
        cfg.diagnose.agent = Some("../etc/passwd".into());
        let err = save_ai_router_inner(cfg).err().expect("should reject");
        assert!(err.contains("invalid characters"));
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
        // Missing fields fall back to defaults (v15.4.4 — summarize now
        // defaults to gemini for long-context HTML).
        assert_eq!(cfg.summarize.provider, "gemini");
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
    fn parses_auto_mode_field() {
        // Configs from the auto-mode rollout carry the bool flag.
        let raw = r#"{
            "diagnose": { "provider": "claude", "model": null, "agent": null, "auto_mode": true }
        }"#;
        let cfg: AiRouterConfig = serde_json::from_str(raw).expect("auto_mode shape parses");
        assert!(cfg.diagnose.auto_mode);
        // Other zones default to false.
        assert!(!cfg.summarize.auto_mode);
    }

    #[test]
    fn pre_auto_mode_configs_default_false() {
        // Older v15.2.39 config without `auto_mode` must deserialize cleanly
        // with auto_mode defaulting to false everywhere.
        let raw = r#"{
            "diagnose": { "provider": "claude", "model": null, "agent": "debugger" }
        }"#;
        let cfg: AiRouterConfig = serde_json::from_str(raw).expect("pre-auto_mode shape parses");
        assert!(!cfg.diagnose.auto_mode);
        assert_eq!(cfg.diagnose.agent.as_deref(), Some("debugger"));
    }

    #[test]
    fn zone_lookup_works() {
        let cfg = AiRouterConfig::default();
        assert_eq!(cfg.zone("diagnose").unwrap().provider, "claude");
        assert_eq!(cfg.zone("news_generate").unwrap().provider, "gemini");
        assert!(cfg.zone("nonexistent").is_none());
    }
}
