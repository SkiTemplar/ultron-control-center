// hooks_admin/naming.rs — Auto-naming: analyze_hook_name and bulk variant.

use std::fs;
use std::path::PathBuf;

use super::commands::list_hooks_inner;
use super::types::HookNameResult;

/// Path to the names cache JSON.
fn names_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron").join("cockpit").join("hooks-names.json"))
}

/// Read the entire cache map (hook_id -> name_record). Returns an empty map on
/// any I/O or parse error so callers never have to handle the error case.
pub(crate) fn read_names_cache() -> serde_json::Map<String, serde_json::Value> {
    let Some(path) = names_cache_path() else {
        return serde_json::Map::new();
    };
    if !path.exists() {
        return serde_json::Map::new();
    }
    let Ok(raw) = fs::read_to_string(&path) else {
        return serde_json::Map::new();
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(serde_json::Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    }
}

/// Atomically persist the cache map.
fn write_names_cache(map: &serde_json::Map<String, serde_json::Value>) -> Result<(), String> {
    let Some(path) = names_cache_path() else {
        return Err("no HOME".into());
    };
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    }
    let tmp = path.with_extension("json.tmp");
    let raw = serde_json::to_string_pretty(&serde_json::Value::Object(map.clone()))
        .map_err(|e| format!("serialize: {}", e))?;
    fs::write(&tmp, &raw).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

/// Heuristic fallback: extract the first meaningful name from the command text.
///
/// Priority:
///   1. First shell comment line: `# my-hook-does-x`
///   2. First exported function: `function Do-Thing`
///   3. Python def: `def do_thing(`
///   4. Verb of the first non-option token on the command line
pub(crate) fn heuristic_name(command: &str) -> String {
    for line in command.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let candidate = rest.trim().to_string();
            if !candidate.is_empty() && candidate.len() <= 80 {
                return to_kebab_fragment(&candidate, 4);
            }
        }
    }
    for line in command.lines() {
        let lower = line.trim().to_lowercase();
        if lower.starts_with("function ") {
            if let Some(name) = lower.strip_prefix("function ") {
                let name = name
                    .split(|c: char| !c.is_alphanumeric() && c != '-' && c != '_')
                    .next()
                    .unwrap_or("")
                    .to_string();
                if !name.is_empty() {
                    return to_kebab_fragment(&name, 4);
                }
            }
        }
    }
    for line in command.lines() {
        let lower = line.trim().to_lowercase();
        if lower.starts_with("def ") {
            if let Some(name) = lower.strip_prefix("def ") {
                let name = name
                    .split(|c: char| !c.is_alphanumeric() && c != '_')
                    .next()
                    .unwrap_or("")
                    .replace('_', "-");
                if !name.is_empty() {
                    return to_kebab_fragment(&name, 4);
                }
            }
        }
    }
    let words: Vec<&str> = command
        .split_whitespace()
        .filter(|w| !w.starts_with('-') && !w.starts_with('/') && !w.starts_with('$'))
        .collect();
    let verb_phrase: Vec<String> = words
        .iter()
        .take(2)
        .map(|w| {
            let base = w.split(['\\', '/']).next_back().unwrap_or(w);
            let stem = base.split('.').next().unwrap_or(base);
            stem.to_lowercase().replace('_', "-")
        })
        .filter(|s| !s.is_empty())
        .collect();
    if verb_phrase.is_empty() {
        return "hook".to_string();
    }
    verb_phrase.join("-")
}

/// Sanitise an arbitrary string into at most `max_words` kebab-case words.
fn to_kebab_fragment(input: &str, max_words: usize) -> String {
    let mut words: Vec<String> = Vec::new();
    let mut buf = String::new();
    for ch in input.chars() {
        if ch.is_alphanumeric() {
            if ch.is_uppercase() && !buf.is_empty() {
                words.push(buf.to_lowercase());
                buf.clear();
            }
            buf.push(ch);
        } else if !buf.is_empty() {
            words.push(buf.to_lowercase());
            buf.clear();
        }
    }
    if !buf.is_empty() {
        words.push(buf.to_lowercase());
    }
    let noise: &[&str] = &["the", "a", "an", "and", "or", "to", "in", "of", "for"];
    let words: Vec<String> = words
        .into_iter()
        .filter(|w| w.len() > 1 && !noise.contains(&w.as_str()))
        .take(max_words)
        .collect();
    if words.is_empty() {
        return "hook".to_string();
    }
    words.join("-")
}

fn build_naming_prompt(hook_id: &str, event: &str, command: &str) -> String {
    format!(
        "You are naming a Claude Code shell hook for a developer.\n\
        Hook ID (opaque): {id}\n\
        Event: {event}\n\
        Command (the shell script / invocation):\n\
        ---\n{command}\n---\n\n\
        Respond with ONLY a short kebab-case name (2 to 4 words, no spaces, \
        no quotes, no punctuation) that describes what this hook does. \
        Examples: format-on-save  audit-bash-calls  notify-on-stop  \
        pre-commit-check  cost-watchdog-alert\n\
        Name:",
        id = hook_id,
        event = event,
        command = command
    )
}

/// Extract the first token from an AI response (strips quotes, dots, prose).
fn parse_ai_name(raw: &str) -> String {
    let candidate = raw
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or(raw)
        .trim()
        .trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
    let segments: Vec<&str> = candidate
        .split('-')
        .filter(|s| !s.is_empty())
        .take(4)
        .collect();
    if segments.is_empty() {
        return "hook".to_string();
    }
    segments.join("-").to_lowercase()
}

/// Analyse (or return cached) name for a single hook.
///
/// Strategy cascade:
///   1. Return cached entry if present.
///   2. Call `ai_router::route("utility", prompt)` -- uses Haiku/Gemini/Groq.
///   3. Heuristic extraction from command text.
///   4. Last-resort "hook" literal.
pub fn analyze_hook_name_inner(id: String) -> Result<HookNameResult, String> {
    let mut cache = read_names_cache();
    if let Some(cached_val) = cache.get(&id) {
        if let Some(name) = cached_val.get("name").and_then(|v| v.as_str()) {
            return Ok(HookNameResult {
                id,
                name: name.to_string(),
                strategy: cached_val
                    .get("strategy")
                    .and_then(|v| v.as_str())
                    .unwrap_or("cached")
                    .to_string(),
                cached: true,
            });
        }
    }

    let list = list_hooks_inner()?;
    let hook = list
        .hooks
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| format!("hook '{}' not found", id))?;

    let prompt = build_naming_prompt(&hook.id, &hook.event, &hook.command);
    let (name, strategy) = match crate::ai_router::route("utility", &prompt) {
        Ok(raw) => {
            let n = parse_ai_name(&raw);
            if n.len() >= 3 && n.contains('-') {
                (n, "ai".to_string())
            } else {
                (heuristic_name(&hook.command), "heuristic".to_string())
            }
        }
        Err(_) => (heuristic_name(&hook.command), "heuristic".to_string()),
    };

    let entry = serde_json::json!({ "name": name, "strategy": strategy });
    cache.insert(id.clone(), entry);
    let _ = write_names_cache(&cache);

    Ok(HookNameResult {
        id,
        name,
        strategy,
        cached: false,
    })
}

/// Bulk variant: analyse all hooks that don't have a cached name yet.
pub fn bulk_analyze_hook_names_inner() -> Result<Vec<HookNameResult>, String> {
    let list = list_hooks_inner()?;
    let cache = read_names_cache();
    let mut results: Vec<HookNameResult> = Vec::new();

    for hook in list.hooks.iter() {
        if cache.contains_key(&hook.id) {
            if let Some(cached_val) = cache.get(&hook.id) {
                if let Some(name) = cached_val.get("name").and_then(|v| v.as_str()) {
                    results.push(HookNameResult {
                        id: hook.id.clone(),
                        name: name.to_string(),
                        strategy: cached_val
                            .get("strategy")
                            .and_then(|v| v.as_str())
                            .unwrap_or("cached")
                            .to_string(),
                        cached: true,
                    });
                    continue;
                }
            }
        }
        match analyze_hook_name_inner(hook.id.clone()) {
            Ok(r) => results.push(r),
            Err(e) => {
                results.push(HookNameResult {
                    id: hook.id.clone(),
                    name: heuristic_name(&hook.command),
                    strategy: format!("fallback({})", e),
                    cached: false,
                });
            }
        }
    }
    Ok(results)
}

/// Read the current names cache for the frontend (no AI calls, no mutations).
pub fn get_hook_names_cache_inner() -> serde_json::Map<String, serde_json::Value> {
    read_names_cache()
}
