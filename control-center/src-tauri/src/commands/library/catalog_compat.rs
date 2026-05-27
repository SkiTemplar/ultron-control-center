//! Catalog compatibility analysis — v2.9.8 (card-1779825112840).
//!
//! Reads the user's CLAUDE.md + package.json / Cargo.toml / pyproject.toml from
//! the current working directory and computes a `compat_score` (0.0–1.0) for
//! each `RepoHit` returned by the GitHub search commands.
//!
//! Score formula:
//!   +0.30 if the item's primary language matches any stack language
//!   +0.30 if any topic in the item overlaps with the detected stack tags
//!   +0.40 if no dependency name collision is detected (heuristic by name prefix)
//!
//! The result is cached at `~/.ultron/cockpit/library-catalog-compat.json`
//! with a 1-hour TTL. The cache key is the sorted set of `full_name` strings
//! from the input slice (so adding/removing items invalidates it correctly).

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::commands::library::library::RepoHit;
use crate::ultron_root;

// ---------------------------------------------------------------------------
// Public types (mirrored on the TypeScript side)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatReport {
    pub item_id: String,
    /// 0.0 – 1.0
    pub compat_score: f32,
    /// Human-readable explanation fragments (one per contributing factor).
    pub reasons: Vec<String>,
    /// Non-empty when a hard blocker was found (score forced to 0).
    pub blocked_by: Option<String>,
}

/// Cached payload persisted to disk.
#[derive(Debug, Serialize, Deserialize)]
struct CachedCompat {
    /// Unix seconds when the cache was written.
    written_at_secs: u64,
    /// Sorted join of full_name inputs — invalidation key.
    input_key: String,
    reports: Vec<CompatReport>,
}

// ---------------------------------------------------------------------------
// Stack detection
// ---------------------------------------------------------------------------

/// Normalised description of the detected project stack.
#[derive(Debug, Default)]
pub struct DetectedStack {
    /// Lower-cased language names: "typescript", "rust", "python", etc.
    pub languages: HashSet<String>,
    /// Framework / topic tags: "react", "tauri", "fastapi", etc.
    pub tags: HashSet<String>,
    /// Lower-cased dependency names from manifests.
    pub deps: HashSet<String>,
}

/// Detect the stack from CLAUDE.md + common manifest files.
pub fn detect_stack(cwd: &PathBuf) -> DetectedStack {
    let mut stack = DetectedStack::default();

    // --- CLAUDE.md (home dir) ---
    if let Some(home) = dirs::home_dir() {
        let claude_md = home.join(".claude").join("CLAUDE.md");
        if let Ok(body) = std::fs::read_to_string(&claude_md) {
            parse_claude_md_stack(&body, &mut stack);
        }
    }

    // --- package.json ---
    let pkg_json = cwd.join("package.json");
    if let Ok(body) = std::fs::read_to_string(&pkg_json) {
        parse_package_json(&body, &mut stack);
    }

    // --- Cargo.toml ---
    let cargo_toml = cwd.join("Cargo.toml");
    if let Ok(body) = std::fs::read_to_string(&cargo_toml) {
        parse_cargo_toml(&body, &mut stack);
    }

    // --- pyproject.toml ---
    let pyproject = cwd.join("pyproject.toml");
    if let Ok(body) = std::fs::read_to_string(&pyproject) {
        parse_pyproject_toml(&body, &mut stack);
    }

    stack
}

fn parse_claude_md_stack(body: &str, stack: &mut DetectedStack) {
    // Look for language keywords in the plain text — coarse but effective.
    let lowered = body.to_ascii_lowercase();
    let lang_keywords = [
        ("typescript", "typescript"),
        ("javascript", "javascript"),
        ("rust", "rust"),
        ("python", "python"),
        ("go ", "go"),
        ("golang", "go"),
        ("java ", "java"),
        ("kotlin", "kotlin"),
        ("swift", "swift"),
        ("c#", "csharp"),
        ("dotnet", "csharp"),
        (".net", "csharp"),
        ("ruby", "ruby"),
        ("php", "php"),
    ];
    for (needle, lang) in &lang_keywords {
        if lowered.contains(needle) {
            stack.languages.insert(lang.to_string());
        }
    }

    // Framework / tag keywords.
    let tag_keywords = [
        ("react", "react"),
        ("next.js", "nextjs"),
        ("nextjs", "nextjs"),
        ("tauri", "tauri"),
        ("vue", "vue"),
        ("angular", "angular"),
        ("svelte", "svelte"),
        ("fastapi", "fastapi"),
        ("django", "django"),
        ("flask", "flask"),
        ("spring", "spring"),
        ("node", "node"),
        ("deno", "deno"),
        ("postgres", "postgres"),
        ("sqlite", "sqlite"),
        ("redis", "redis"),
        ("claude", "claude-code"),
        ("mcp", "mcp"),
    ];
    for (needle, tag) in &tag_keywords {
        if lowered.contains(needle) {
            stack.tags.insert(tag.to_string());
        }
    }
}

fn parse_package_json(body: &str, stack: &mut DetectedStack) {
    stack.languages.insert("typescript".to_string());
    stack.languages.insert("javascript".to_string());

    // Pull dependency names via lightweight string scan (no full JSON parse
    // to keep compilation minimal — serde_json is already in scope though).
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(body) {
        for section in &["dependencies", "devDependencies"] {
            if let Some(obj) = val.get(section).and_then(|v| v.as_object()) {
                for key in obj.keys() {
                    let name = key.trim_start_matches('@')
                        .split('/')
                        .next()
                        .unwrap_or(key)
                        .to_ascii_lowercase();
                    stack.deps.insert(name.clone());
                    // Derive tags from well-known deps.
                    match name.as_str() {
                        "react" | "react-dom" => { stack.tags.insert("react".to_string()); }
                        "next" => { stack.tags.insert("nextjs".to_string()); }
                        "vue" => { stack.tags.insert("vue".to_string()); }
                        "svelte" => { stack.tags.insert("svelte".to_string()); }
                        "express" | "fastify" | "hono" => { stack.tags.insert("node".to_string()); }
                        "@tauri-apps" => { stack.tags.insert("tauri".to_string()); }
                        _ => {}
                    }
                }
            }
        }
    }
}

fn parse_cargo_toml(body: &str, stack: &mut DetectedStack) {
    stack.languages.insert("rust".to_string());

    // Walk [dependencies] section with line-by-line heuristic.
    let mut in_deps = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("[dependencies") || trimmed.starts_with("[dev-dependencies") {
            in_deps = true;
            continue;
        }
        if trimmed.starts_with('[') {
            in_deps = false;
        }
        if in_deps {
            if let Some(name) = trimmed.split('=').next() {
                let dep = name.trim().to_ascii_lowercase().replace('-', "_");
                if !dep.is_empty() && !dep.starts_with('#') {
                    stack.deps.insert(dep.clone());
                    match dep.as_str() {
                        "tauri" => { stack.tags.insert("tauri".to_string()); }
                        "tokio" | "async_std" => { stack.tags.insert("async-rust".to_string()); }
                        "axum" | "actix_web" | "warp" => { stack.tags.insert("rust-web".to_string()); }
                        _ => {}
                    }
                }
            }
        }
    }
}

fn parse_pyproject_toml(body: &str, stack: &mut DetectedStack) {
    stack.languages.insert("python".to_string());

    let mut in_deps = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed == "dependencies = [" || trimmed == "[project.dependencies]" {
            in_deps = true;
            continue;
        }
        if trimmed.starts_with('[') && trimmed != "dependencies = [" {
            in_deps = false;
        }
        if in_deps && !trimmed.is_empty() && !trimmed.starts_with('#') {
            // Dep lines look like `"fastapi>=0.95"` or `fastapi`.
            let cleaned = trimmed.trim_matches(|c: char| c == '"' || c == '\'' || c == ',');
            if let Some(name) = cleaned.split(|c: char| c == '>' || c == '<' || c == '=' || c == '[').next() {
                let dep = name.trim().to_ascii_lowercase();
                if !dep.is_empty() {
                    stack.deps.insert(dep.clone());
                    match dep.as_str() {
                        "fastapi" => { stack.tags.insert("fastapi".to_string()); }
                        "django" => { stack.tags.insert("django".to_string()); }
                        "flask" => { stack.tags.insert("flask".to_string()); }
                        _ => {}
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/// Compute a `CompatReport` for a single `RepoHit` given the detected stack.
pub fn score_item(hit: &RepoHit, stack: &DetectedStack) -> CompatReport {
    let item_id = hit.full_name.clone();
    let mut score: f32 = 0.0;
    let mut reasons: Vec<String> = Vec::new();
    // Factor 1 (+0.30): primary language match.
    let lang_score = score_language(hit, stack, &mut reasons);
    score += lang_score;

    // Factor 2 (+0.30): topic overlap with stack tags.
    let topic_score = score_topics(hit, stack, &mut reasons);
    score += topic_score;

    // Factor 3 (+0.40): dependency non-collision heuristic.
    let (dep_score, blocked_by) = score_deps(hit, stack, &mut reasons);
    score += dep_score;

    // If hard blocker found, override score.
    if blocked_by.is_some() {
        score = 0.0;
    }

    // Clamp to [0.0, 1.0] and round to 2 decimals.
    let final_score = (score.clamp(0.0, 1.0) * 100.0).round() / 100.0;

    CompatReport { item_id, compat_score: final_score, reasons, blocked_by }
}

fn score_language(hit: &RepoHit, stack: &DetectedStack, reasons: &mut Vec<String>) -> f32 {
    let item_lang = match &hit.language {
        Some(l) => l.to_ascii_lowercase(),
        None => return 0.0,
    };

    // Normalise GitHub language names to our canonical set.
    let canonical = match item_lang.as_str() {
        "typescript" | "javascript" | "js" | "ts" => vec!["typescript", "javascript"],
        "rust" => vec!["rust"],
        "python" => vec!["python"],
        "go" => vec!["go"],
        "java" => vec!["java"],
        "kotlin" => vec!["kotlin"],
        "swift" => vec!["swift"],
        "c#" | "csharp" => vec!["csharp"],
        "ruby" => vec!["ruby"],
        "php" => vec!["php"],
        _ => vec![item_lang.as_str()],
    };

    for lang in &canonical {
        if stack.languages.contains(*lang) {
            reasons.push(format!("language match: {}", item_lang));
            return 0.30;
        }
    }
    0.0
}

fn score_topics(hit: &RepoHit, stack: &DetectedStack, reasons: &mut Vec<String>) -> f32 {
    if hit.topics.is_empty() || stack.tags.is_empty() {
        return 0.0;
    }

    let item_topics: HashSet<String> = hit.topics.iter().map(|t| t.to_ascii_lowercase()).collect();
    let overlap: Vec<&String> = stack.tags.iter().filter(|t| item_topics.contains(t.as_str())).collect();

    if !overlap.is_empty() {
        let matched: Vec<&str> = overlap.iter().map(|s| s.as_str()).collect();
        reasons.push(format!("topic overlap: {}", matched.join(", ")));
        return 0.30;
    }
    0.0
}

fn score_deps(
    hit: &RepoHit,
    stack: &DetectedStack,
    reasons: &mut Vec<String>,
) -> (f32, Option<String>) {
    // Without cloning the repo we can't read its manifest. Use a heuristic:
    // if the repo NAME itself matches a dependency we already have installed,
    // there is no collision (it's already installed). If the repo name is
    // a well-known package in a *different* ecosystem than our stack, flag it.
    //
    // Conservative approach: grant the +0.40 unless we can identify a clear
    // cross-ecosystem mismatch.

    let repo_name_lower = hit.name.to_ascii_lowercase().replace('-', "_");

    // Cross-ecosystem hard blockers: pip-only package in a Rust-only stack, etc.
    let is_rust_stack = stack.languages.contains("rust") && !stack.languages.contains("python") && !stack.languages.contains("javascript");
    let is_python_stack = stack.languages.contains("python") && !stack.languages.contains("rust") && !stack.languages.contains("javascript");
    let is_js_stack = (stack.languages.contains("typescript") || stack.languages.contains("javascript"))
        && !stack.languages.contains("rust")
        && !stack.languages.contains("python");

    // A known Python-only package in a Rust-only stack is a likely blocker.
    let python_only_packages = ["django", "flask", "fastapi", "celery", "sqlalchemy", "pytest", "numpy", "pandas"];
    let rust_only_packages = ["tokio", "actix", "axum", "serde", "rayon", "rocket"];

    if is_rust_stack && python_only_packages.contains(&repo_name_lower.as_str()) {
        return (0.0, Some(format!("Python package '{}' incompatible with Rust-only stack", hit.name)));
    }
    if is_python_stack && rust_only_packages.contains(&repo_name_lower.as_str()) {
        return (0.0, Some(format!("Rust crate '{}' incompatible with Python-only stack", hit.name)));
    }
    if is_js_stack && rust_only_packages.contains(&repo_name_lower.as_str()) {
        return (0.0, Some(format!("Rust crate '{}' incompatible with JS/TS-only stack", hit.name)));
    }

    // Dep already in our stack → small bonus hint, still counts as +0.40.
    if stack.deps.contains(&repo_name_lower) {
        reasons.push(format!("'{}' already in stack dependencies", hit.name));
    } else {
        reasons.push("no dependency conflicts detected".to_string());
    }

    (0.40, None)
}

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

const CACHE_TTL_SECS: u64 = 3600; // 1 hour

fn cache_path() -> Result<PathBuf, String> {
    Ok(ultron_root()?.join("cockpit").join("library-catalog-compat.json"))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn build_input_key(hits: &[RepoHit]) -> String {
    let mut names: Vec<&str> = hits.iter().map(|h| h.full_name.as_str()).collect();
    names.sort_unstable();
    names.join(",")
}

fn try_load_cache(input_key: &str) -> Option<Vec<CompatReport>> {
    let path = cache_path().ok()?;
    let body = std::fs::read_to_string(&path).ok()?;
    let cached: CachedCompat = serde_json::from_str(&body).ok()?;

    let age = now_secs().saturating_sub(cached.written_at_secs);
    if age > CACHE_TTL_SECS {
        return None;
    }
    if cached.input_key != input_key {
        return None;
    }
    Some(cached.reports)
}

fn write_cache(input_key: &str, reports: &[CompatReport]) {
    let Ok(path) = cache_path() else { return };
    let payload = CachedCompat {
        written_at_secs: now_secs(),
        input_key: input_key.to_string(),
        reports: reports.to_vec(),
    };
    if let Ok(json) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(&path, json);
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Analyse a list of `RepoHit` items for compatibility with the current stack.
/// Results are cached for 1 hour. Pass `force_refresh = true` to bypass cache.
pub fn analyze_catalog_compat_inner(
    items: Vec<RepoHit>,
    force_refresh: bool,
) -> Vec<CompatReport> {
    let input_key = build_input_key(&items);

    if !force_refresh {
        if let Some(cached) = try_load_cache(&input_key) {
            return cached;
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let stack = detect_stack(&cwd);

    let reports: Vec<CompatReport> = items.iter().map(|hit| score_item(hit, &stack)).collect();
    write_cache(&input_key, &reports);
    reports
}

// ---------------------------------------------------------------------------
// Tauri command wrapper
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct AnalyzeCompatArgs {
    pub items: Vec<RepoHit>,
    #[serde(default)]
    pub force_refresh: bool,
}

/// Analyse `items` for compatibility with the stack detected in the cwd +
/// CLAUDE.md.  Results are cached for 1 h at
/// `~/.ultron/cockpit/library-catalog-compat.json`.
#[tauri::command]
pub fn analyze_catalog_compat(args: AnalyzeCompatArgs) -> Vec<CompatReport> {
    analyze_catalog_compat_inner(args.items, args.force_refresh)
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_hit(full_name: &str, language: Option<&str>, topics: &[&str]) -> RepoHit {
        RepoHit {
            full_name: full_name.to_string(),
            owner: "owner".to_string(),
            name: full_name.split('/').last().unwrap_or(full_name).to_string(),
            description: None,
            stars: 100,
            language: language.map(|s| s.to_string()),
            html_url: None,
            updated_at: None,
            topics: topics.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn ts_rust_stack() -> DetectedStack {
        let mut stack = DetectedStack::default();
        stack.languages.insert("typescript".to_string());
        stack.languages.insert("rust".to_string());
        stack.tags.insert("tauri".to_string());
        stack.tags.insert("react".to_string());
        stack.deps.insert("react".to_string());
        stack.deps.insert("tauri".to_string());
        stack
    }

    #[test]
    fn language_match_scores_030() {
        let stack = ts_rust_stack();
        let hit = make_hit("foo/bar", Some("TypeScript"), &[]);
        let report = score_item(&hit, &stack);
        assert!((report.compat_score - 0.70).abs() < 0.01, "expected 0.70, got {}", report.compat_score);
        // 0.30 language + 0.0 topics + 0.40 no-conflict = 0.70
    }

    #[test]
    fn topic_overlap_adds_030() {
        let stack = ts_rust_stack();
        let hit = make_hit("foo/bar", Some("TypeScript"), &["tauri", "claude-code"]);
        let report = score_item(&hit, &stack);
        // 0.30 + 0.30 + 0.40 = 1.00
        assert!((report.compat_score - 1.0).abs() < 0.01, "expected 1.0, got {}", report.compat_score);
    }

    #[test]
    fn no_language_match_zero_language_score() {
        let stack = ts_rust_stack();
        let hit = make_hit("foo/bar", Some("Python"), &[]);
        let report = score_item(&hit, &stack);
        // 0.0 language + 0.0 topics + 0.40 no-conflict = 0.40
        assert!((report.compat_score - 0.40).abs() < 0.01, "expected 0.40, got {}", report.compat_score);
    }

    #[test]
    fn blocked_by_cross_ecosystem_forces_zero() {
        let mut stack = DetectedStack::default();
        stack.languages.insert("rust".to_string());
        // Pure Rust stack (no python/js).
        let hit = make_hit("org/django", Some("Python"), &[]);
        let report = score_item(&hit, &stack);
        assert_eq!(report.compat_score, 0.0);
        assert!(report.blocked_by.is_some());
    }

    #[test]
    fn input_key_is_sorted() {
        let hits = vec![
            make_hit("z/repo", None, &[]),
            make_hit("a/repo", None, &[]),
        ];
        let key = build_input_key(&hits);
        assert_eq!(key, "a/repo,z/repo");
    }

    #[test]
    fn parse_cargo_toml_detects_rust_and_tauri() {
        let toml = r#"
[package]
name = "my-app"

[dependencies]
tauri = "2.0"
serde = { version = "1" }
"#;
        let cwd = PathBuf::from("."); // unused in this call
        let _ = cwd;
        let mut stack = DetectedStack::default();
        parse_cargo_toml(toml, &mut stack);
        assert!(stack.languages.contains("rust"));
        assert!(stack.tags.contains("tauri"));
        assert!(stack.deps.contains("serde"));
    }

    #[test]
    fn parse_package_json_detects_react() {
        let json = r#"{"dependencies": {"react": "18.0", "react-dom": "18.0"}}"#;
        let mut stack = DetectedStack::default();
        parse_package_json(json, &mut stack);
        assert!(stack.languages.contains("typescript"));
        assert!(stack.tags.contains("react"));
    }
}
