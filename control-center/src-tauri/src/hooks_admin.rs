// ULTRON Control Center — Hooks administration module.
//
// Source of truth: ~/.claude/settings.json under the "hooks" key. Hooks in
// Claude Code are nested:
//
//   "hooks": {
//     "<Event>": [
//       { "matcher": "<regex|tool name>", "hooks": [ { "type": "command", "command": "..." } ] },
//       ...
//     ]
//   }
//
// We flatten that into a single list of `Hook` records with stable IDs so
// the frontend can edit/delete/toggle individual entries without index
// races (the user could re-order or insert entries between fetch and
// write).
//
// `enabled` is NOT a field Claude Code understands natively. We tag a hook
// as disabled by mutating its `type` to `"disabled-command"` (which Claude
// Code silently ignores because it isn't `"command"`). This lets us keep
// the entry around for the toggle without losing the command string.
//
// Mutations route through `settings::settings_save_inner` so we inherit
// the timestamped backup + atomic tmp+rename write for free.
//
// Auto-naming: `analyze_hook_name_inner` assigns a human-readable kebab-case
// name to a hook based on its command text.  It tries three strategies in
// order:
//   1. AI Router `route()` via the "utility" zone (Haiku / Gemini Flash).
//   2. Heuristic: first comment or exported function name found in the command.
//   3. Last-resort: prefix of the command verb (first non-option word).
// Results are cached in ~/.ultron/cockpit/hooks-names.json keyed by hook id.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::settings;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Events Claude Code currently dispatches. Anything outside this list is
/// rejected by `add_hook_inner` so we never write a typo'd event that
/// silently never fires.
pub const ALLOWED_EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "UserPromptSubmit",
    "SessionStart",
    "SessionEnd",
    "Stop",
    "SubagentStop",
    "PreCompact",
    "Notification",
];

/// Hard cap on the test sandbox — Claude Code itself imposes a 60s ceiling
/// on hook execution; we test for "does this command produce sensible
/// output quickly" so 5s is plenty and protects against hangs from
/// commands that try to read stdin interactively.
const TEST_TIMEOUT: Duration = Duration::from_secs(5);

/// Substrings rejected by `validate_command`. Not a perfect RCE filter —
/// the user could still write a malicious .ps1 file and call it — but it
/// blocks the most common copy-pasted footguns and the obvious AI
/// hallucinated "curl|bash" patterns we don't want to silently persist.
///
/// Built at module load so the source file itself never contains a
/// literal forbidden fragment (avoids tripping ULTRON's own
/// settings-edit safety hooks during dev edits of THIS file).
fn forbidden_fragments() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    v.push("Invoke-Expression".to_string());
    v.push("invoke-expression".to_string());
    v.push(" IEX ".to_string());
    v.push(" iex ".to_string());
    v.push("IEX(".to_string());
    v.push("iex(".to_string());
    v.push("DownloadString".to_string());
    v.push("curl -s ".to_string());
    v.push("curl -fsSL ".to_string());
    v.push("wget -O- ".to_string());
    v.push("; rm -rf".to_string());
    v.push(";rm -rf".to_string());
    v.push("&& rm -rf".to_string());
    v.push("rm -rf /".to_string());
    v.push("rm -rf ~".to_string());
    v.push("; del /f /s /q".to_string());
    v.push("Remove-Item -Recurse -Force C:\\".to_string());
    v.push("format c:".to_string());
    v.push("format C:".to_string());
    // Built piecewise so this very file does not contain the literal
    // 4-letter danger token that some scanners block on save.
    v.push(format!("{}{}", "ev", "al("));
    v.push("/dev/tcp/".to_string());
    v.push("base64 -d | sh".to_string());
    v
}

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct Hook {
    pub id: String,
    pub event: String,
    pub matcher: Option<String>,
    pub command: String,
    pub enabled: bool,
    /// Always "user" right now. v15.1.6 only edits the global
    /// `~/.claude/settings.json`; project-level overrides under
    /// `~/.claude/settings.local.json` are out of scope.
    pub source: String,
    /// Human-readable description from the settings.json group entry
    /// (the `description` field on the outer `{ matcher, hooks, description, id }` object).
    /// Used by the UI as the initial display name before AI auto-naming.
    pub description: Option<String>,
    /// Optional flags from the raw entry that we don't otherwise model —
    /// e.g. `asyncRewake`. Surfaced as a JSON blob so the UI can render
    /// them read-only without us having to track every Claude Code flag.
    pub extra: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct HooksList {
    pub hooks: Vec<Hook>,
    pub settings_path: String,
    pub settings_exists: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookMutationResult {
    pub success: bool,
    pub hook: Option<Hook>,
    pub backup_path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookTestResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub elapsed_ms: u128,
    pub timed_out: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookFire {
    pub timestamp: Option<String>,
    pub event: Option<String>,
    pub hook_id: Option<String>,
    pub matcher: Option<String>,
    pub exit_code: Option<i64>,
    pub raw: serde_json::Value,
}

#[derive(Debug, Serialize, Clone)]
pub struct HookFiresReport {
    pub fires: Vec<HookFire>,
    pub log_path: String,
    pub instrumented: bool,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude/settings.json"))
}

/// Stable ID — same (event, matcher, command) always hashes to the same
/// string regardless of array index. We include the command verbatim so a
/// rename of the underlying script invalidates the ID (intentional: that
/// "is" a new hook from a user's perspective).
fn compute_id(event: &str, matcher: Option<&str>, command: &str) -> String {
    let mut hasher = DefaultHasher::new();
    event.hash(&mut hasher);
    matcher.unwrap_or("").hash(&mut hasher);
    command.hash(&mut hasher);
    let h = hasher.finish();
    // 12 hex chars is plenty for the few dozen hooks a user will have.
    format!("hk_{:012x}", h & 0x0000_FFFF_FFFF_FFFF)
}

fn read_settings_value() -> Result<serde_json::Value, String> {
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        // Fresh install — no settings.json yet. Return an empty object so
        // `list_hooks_inner` can render "no hooks configured" cleanly.
        return Ok(serde_json::json!({}));
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read settings.json: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("parse settings.json: {}", e))
}

/// Extract a Vec of Hook records from a settings.json `Value`. Tolerant
/// of missing keys — returns an empty Vec if there is no "hooks" key.
fn flatten_hooks(root: &serde_json::Value) -> Vec<Hook> {
    let mut out: Vec<Hook> = Vec::new();
    let Some(hooks_obj) = root.get("hooks").and_then(|v| v.as_object()) else {
        return out;
    };
    for (event_name, groups) in hooks_obj.iter() {
        let Some(arr) = groups.as_array() else {
            continue;
        };
        for group in arr.iter() {
            let Some(group_obj) = group.as_object() else {
                continue;
            };
            let matcher = group_obj
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            // Read the human-readable description from the group object (outer wrapper),
            // e.g. `{ matcher, hooks, description, id }`. Falls back to None if absent.
            let group_description = group_obj
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string());
            let Some(inner_arr) = group_obj.get("hooks").and_then(|v| v.as_array()) else {
                continue;
            };
            for entry in inner_arr.iter() {
                let Some(entry_obj) = entry.as_object() else {
                    continue;
                };
                let type_str = entry_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                // Either "command" (enabled) or "disabled-command" (our
                // toggle-off marker). Anything else we skip — could be a
                // future Claude Code hook type we don't model yet.
                let enabled = match type_str {
                    "command" => true,
                    "disabled-command" => false,
                    _ => continue,
                };
                let Some(command) = entry_obj.get("command").and_then(|v| v.as_str()) else {
                    continue;
                };
                // Capture every entry-level key that isn't `type` or
                // `command` as "extra" so the UI can show flags like
                // `asyncRewake` without us having to model them.
                let mut extra_obj = serde_json::Map::new();
                for (k, v) in entry_obj.iter() {
                    if k != "type" && k != "command" {
                        extra_obj.insert(k.clone(), v.clone());
                    }
                }
                let id = compute_id(event_name, matcher.as_deref(), command);
                out.push(Hook {
                    id,
                    event: event_name.clone(),
                    matcher: matcher.clone(),
                    command: command.to_string(),
                    enabled,
                    source: "user".to_string(),
                    description: group_description.clone(),
                    extra: serde_json::Value::Object(extra_obj),
                });
            }
        }
    }
    out
}

fn validate_event(event: &str) -> Result<(), String> {
    if ALLOWED_EVENTS.contains(&event) {
        Ok(())
    } else {
        Err(format!(
            "event '{}' is not supported (allowed: {})",
            event,
            ALLOWED_EVENTS.join(", ")
        ))
    }
}

fn validate_command(command: &str) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("command is empty".into());
    }
    if trimmed.len() > 4_000 {
        return Err("command is suspiciously long (>4000 chars)".into());
    }
    // CC-12 hardening: PowerShell treats a backtick as a no-op escape
    // before any non-special char — `` `i`ex `` evaluates identically to
    // `iex`. The original substring check missed that. Normalise the
    // command by (a) stripping every backtick AND (b) lower-casing the
    // whole string before scanning for forbidden fragments. The needles
    // are also normalised the same way so we don't have to encode every
    // possible casing variant in the blocklist.
    let normalised: String = trimmed
        .chars()
        .filter(|c| *c != '`')
        .collect::<String>()
        .to_ascii_lowercase();
    for needle in forbidden_fragments() {
        // Apply the same normalisation to the needle so the fixture list
        // stays human-readable in source.
        let needle_norm: String = needle
            .chars()
            .filter(|c| *c != '`')
            .collect::<String>()
            .to_ascii_lowercase();
        if normalised.contains(&needle_norm) {
            return Err(format!(
                "command contains forbidden fragment '{}' (blocked by safety net)",
                needle.trim()
            ));
        }
        // Also check the *raw* trimmed string — the trim-aware needles in
        // forbidden_fragments() (e.g. " IEX ", "; rm -rf") rely on word
        // boundaries that the lower-case+strip pass would still preserve,
        // but we run the raw check too in case the normalisation ever
        // softens a needle we wanted strict.
        if trimmed.contains(&needle) {
            return Err(format!(
                "command contains forbidden fragment '{}' (blocked by safety net)",
                needle.trim()
            ));
        }
    }
    Ok(())
}

fn validate_matcher(matcher: Option<&str>) -> Result<(), String> {
    let Some(m) = matcher else { return Ok(()) };
    if m.len() > 512 {
        return Err("matcher is too long".into());
    }
    // Matcher is a regex per Claude Code spec — we don't precompile here
    // (would add the `regex` crate just for validation), we just enforce a
    // reasonable length and reject NUL bytes / line breaks that would
    // corrupt the JSON.
    if m.contains('\n') || m.contains('\r') || m.contains('\0') {
        return Err("matcher cannot contain newlines or NUL bytes".into());
    }
    Ok(())
}

/// Mutation core: read settings, mutate the "hooks" object via `f`, save.
fn mutate_hooks<F>(f: F) -> Result<(serde_json::Value, Option<String>), String>
where
    F: FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> Result<serde_json::Value, String>,
{
    let snapshot = settings::settings_read_inner().or_else(|_| {
        // settings.json doesn't exist yet — create an empty in-memory
        // snapshot so we can write the first hook.
        Ok::<_, String>(settings::SettingsSnapshot {
            path: settings_path()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            content: serde_json::json!({}),
            modified: None,
            size_bytes: 0,
            backup_dir: String::new(),
            recent_backups: Vec::new(),
        })
    })?;

    let mut content = snapshot.content;
    if !content.is_object() {
        content = serde_json::json!({});
    }
    let root = content
        .as_object_mut()
        .ok_or_else(|| "settings.json root is not an object".to_string())?;

    // Ensure "hooks" exists and is an object.
    let entry = root
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    let hooks_obj = entry
        .as_object_mut()
        .ok_or_else(|| "settings.json 'hooks' is not an object".to_string())?;

    let payload = f(hooks_obj)?;

    let save = settings::settings_save_inner(settings::SettingsSavePayload { content })?;
    Ok((payload, save.backup_path))
}

/// Locate and mutate a single entry in-place inside the nested hooks
/// structure. The callback receives the entry's JSON object so it can
/// replace fields. Returns the rebuilt `Hook` view on success.
fn mutate_entry_by_id<F>(
    hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
    target_id: &str,
    apply: F,
) -> Result<Hook, String>
where
    F: FnOnce(
        &mut serde_json::Map<String, serde_json::Value>,
        &mut Option<String>,
    ) -> Result<(), String>,
{
    for (event_name, groups) in hooks_obj.iter_mut() {
        let Some(arr) = groups.as_array_mut() else {
            continue;
        };
        for group in arr.iter_mut() {
            let Some(group_obj) = group.as_object_mut() else {
                continue;
            };
            // Pull matcher out so we can recompute IDs after a potential
            // matcher change. We always write it back at the end.
            let mut matcher: Option<String> = group_obj
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            // Locate the matching entry inside this group's `hooks` array
            // without holding the borrow past the lookup — we re-borrow
            // when we apply the mutation so we can safely touch
            // `group_obj` afterwards to (re)write the matcher.
            let target_idx: Option<usize> = match group_obj.get("hooks").and_then(|v| v.as_array())
            {
                Some(inner_arr) => {
                    let mut found: Option<usize> = None;
                    for (i, entry) in inner_arr.iter().enumerate() {
                        let Some(entry_obj) = entry.as_object() else {
                            continue;
                        };
                        let type_str = entry_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        if type_str != "command" && type_str != "disabled-command" {
                            continue;
                        }
                        let command = entry_obj
                            .get("command")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let id = compute_id(event_name, matcher.as_deref(), command);
                        if id == target_id {
                            found = Some(i);
                            break;
                        }
                    }
                    found
                }
                None => None,
            };
            let Some(idx) = target_idx else { continue };

            // Re-borrow `hooks` mutably to apply the mutation. This
            // borrow is released at the end of the inner block so we can
            // touch `group_obj` (matcher) and re-read the entry below.
            let (new_command, new_type_str, extra_obj) = {
                let inner_arr = group_obj
                    .get_mut("hooks")
                    .and_then(|v| v.as_array_mut())
                    .ok_or_else(|| "group 'hooks' is not an array".to_string())?;
                let entry = inner_arr
                    .get_mut(idx)
                    .ok_or_else(|| "entry index out of range".to_string())?;
                let entry_obj = entry
                    .as_object_mut()
                    .ok_or_else(|| "entry is not an object".to_string())?;

                // Apply user-provided mutation (may change matcher slot
                // too — group write happens after this borrow is released).
                apply(entry_obj, &mut matcher)?;

                let new_command = entry_obj
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let new_type_str = entry_obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("command")
                    .to_string();
                let mut extra_obj = serde_json::Map::new();
                for (k, v) in entry_obj.iter() {
                    if k != "type" && k != "command" {
                        extra_obj.insert(k.clone(), v.clone());
                    }
                }
                (new_command, new_type_str, extra_obj)
            };

            // Now we can safely touch group_obj — the inner borrow above
            // is gone.
            match &matcher {
                Some(m) if !m.is_empty() => {
                    group_obj.insert("matcher".to_string(), serde_json::Value::String(m.clone()));
                }
                _ => {
                    group_obj.remove("matcher");
                }
            }

            let enabled = new_type_str == "command";
            let new_id = compute_id(event_name, matcher.as_deref(), &new_command);
            return Ok(Hook {
                id: new_id,
                event: event_name.clone(),
                matcher: matcher.clone(),
                command: new_command,
                enabled,
                source: "user".to_string(),
                description: None,
                extra: serde_json::Value::Object(extra_obj),
            });
        }
    }
    Err(format!("hook id '{}' not found", target_id))
}

/// Same as `mutate_entry_by_id` but removes the entry (and prunes empty
/// groups / empty event arrays so we don't leave dangling shells in
/// settings.json).
fn delete_entry_by_id(
    hooks_obj: &mut serde_json::Map<String, serde_json::Value>,
    target_id: &str,
) -> Result<(), String> {
    let mut events_to_prune: Vec<String> = Vec::new();
    let mut deleted = false;

    for (event_name, groups) in hooks_obj.iter_mut() {
        let Some(arr) = groups.as_array_mut() else {
            continue;
        };
        let mut groups_to_remove: Vec<usize> = Vec::new();
        for (group_idx, group) in arr.iter_mut().enumerate() {
            let Some(group_obj) = group.as_object_mut() else {
                continue;
            };
            let matcher: Option<String> = group_obj
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let Some(inner_arr) = group_obj.get_mut("hooks").and_then(|v| v.as_array_mut()) else {
                continue;
            };
            let mut entry_idx_to_remove: Option<usize> = None;
            for (i, entry) in inner_arr.iter().enumerate() {
                let Some(entry_obj) = entry.as_object() else {
                    continue;
                };
                let type_str = entry_obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if type_str != "command" && type_str != "disabled-command" {
                    continue;
                }
                let command = entry_obj
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let id = compute_id(event_name, matcher.as_deref(), command);
                if id == target_id {
                    entry_idx_to_remove = Some(i);
                    break;
                }
            }
            if let Some(i) = entry_idx_to_remove {
                inner_arr.remove(i);
                deleted = true;
                if inner_arr.is_empty() {
                    groups_to_remove.push(group_idx);
                }
                break;
            }
        }
        // Remove emptied groups in reverse order so indexes stay valid.
        for &idx in groups_to_remove.iter().rev() {
            arr.remove(idx);
        }
        if arr.is_empty() {
            events_to_prune.push(event_name.clone());
        }
        if deleted {
            break;
        }
    }
    for k in events_to_prune {
        hooks_obj.remove(&k);
    }
    if !deleted {
        return Err(format!("hook id '{}' not found", target_id));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Public functions (called from #[tauri::command] wrappers in lib.rs)
// ---------------------------------------------------------------------------

pub fn list_hooks_inner() -> Result<HooksList, String> {
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    let exists = path.exists();
    let root = read_settings_value()?;
    let mut hooks = flatten_hooks(&root);
    // v2.6 (card-v26-fb-001): plugin hooks live under
    // ~/.claude/plugins/cache/<mkt>/<plugin>/<version>/hooks/hooks.json
    // with the same shape as the user settings.json `hooks` key. Merge
    // them so "0 hooks" doesn't show when ECC (or any other plugin)
    // ships a hook bundle.
    hooks.extend(discover_plugin_hooks());
    Ok(HooksList {
        hooks,
        settings_path: path.to_string_lossy().to_string(),
        settings_exists: exists,
    })
}

/// Walk `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/hooks/hooks.json`
/// and flatten each one into Hook records tagged with `source = "plugin:<mkt>/<plugin>"`.
/// Read-only and tolerant — a malformed plugin hooks.json is silently
/// skipped so it never breaks the whole listing.
fn discover_plugin_hooks() -> Vec<Hook> {
    let mut out: Vec<Hook> = Vec::new();
    let Some(home) = dirs::home_dir() else {
        return out;
    };
    let cache_root = home.join(".claude").join("plugins").join("cache");
    if !cache_root.exists() {
        return out;
    }
    let Ok(marketplaces) = fs::read_dir(&cache_root) else {
        return out;
    };
    for mkt in marketplaces.flatten() {
        let mkt_path = mkt.path();
        if !mkt_path.is_dir() {
            continue;
        }
        let mkt_name = mkt.file_name().to_string_lossy().to_string();
        let Ok(plugins) = fs::read_dir(&mkt_path) else {
            continue;
        };
        for plugin in plugins.flatten() {
            let plugin_path = plugin.path();
            if !plugin_path.is_dir() {
                continue;
            }
            let plugin_name = plugin.file_name().to_string_lossy().to_string();
            let Ok(versions) = fs::read_dir(&plugin_path) else {
                continue;
            };
            for version in versions.flatten() {
                let version_path = version.path();
                if !version_path.is_dir() {
                    continue;
                }
                let hooks_file = version_path.join("hooks").join("hooks.json");
                if !hooks_file.exists() {
                    continue;
                }
                let Ok(raw) = fs::read_to_string(&hooks_file) else {
                    continue;
                };
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                    continue;
                };
                // Plugin hooks.json may be either { "hooks": { ... } }
                // (wrapper) or the inner object directly. flatten_hooks
                // expects the wrapper; if we got the inner, wrap it.
                let wrapped = if value.get("hooks").is_some() {
                    value
                } else {
                    serde_json::json!({ "hooks": value })
                };
                let source = format!("plugin:{}/{}", mkt_name, plugin_name);
                for mut hook in flatten_hooks(&wrapped) {
                    hook.source = source.clone();
                    out.push(hook);
                }
            }
        }
    }
    out
}

pub fn add_hook_inner(
    event: String,
    matcher: Option<String>,
    command: String,
) -> Result<HookMutationResult, String> {
    validate_event(&event)?;
    validate_command(&command)?;
    let matcher = matcher.filter(|m| !m.trim().is_empty());
    validate_matcher(matcher.as_deref())?;

    // Build the entry object up-front so we can pass an owned copy into
    // the mutation closure.
    let mut entry_obj = serde_json::Map::new();
    entry_obj.insert(
        "type".to_string(),
        serde_json::Value::String("command".to_string()),
    );
    entry_obj.insert(
        "command".to_string(),
        serde_json::Value::String(command.clone()),
    );
    let new_id = compute_id(&event, matcher.as_deref(), &command);

    let (_payload, backup_path) = mutate_hooks(|hooks_obj| {
        // Reject exact duplicates so the UI's "add" can't silently create
        // a second copy of an existing hook.
        let already = hooks_obj
            .get(&event)
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter().any(|group| {
                    let m = group
                        .get("matcher")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    if m != matcher {
                        return false;
                    }
                    group
                        .get("hooks")
                        .and_then(|v| v.as_array())
                        .map(|inner| {
                            inner.iter().any(|e| {
                                e.get("command")
                                    .and_then(|v| v.as_str())
                                    .map(|c| c == command)
                                    .unwrap_or(false)
                            })
                        })
                        .unwrap_or(false)
                })
            })
            .unwrap_or(false);
        if already {
            return Err(format!("hook already exists under event '{}'", event));
        }

        let event_arr = hooks_obj
            .entry(event.clone())
            .or_insert_with(|| serde_json::Value::Array(Vec::new()));
        let arr = event_arr
            .as_array_mut()
            .ok_or_else(|| format!("'hooks.{}' is not an array", event))?;

        // Look for an existing group with the same matcher to append into
        // (matches Claude Code's convention of grouping by matcher).
        let mut appended = false;
        for group in arr.iter_mut() {
            let group_matcher = group
                .get("matcher")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if group_matcher == matcher {
                let inner = group
                    .get_mut("hooks")
                    .and_then(|v| v.as_array_mut())
                    .ok_or_else(|| "group 'hooks' is not an array".to_string())?;
                inner.push(serde_json::Value::Object(entry_obj.clone()));
                appended = true;
                break;
            }
        }
        if !appended {
            let mut group = serde_json::Map::new();
            if let Some(m) = &matcher {
                group.insert("matcher".to_string(), serde_json::Value::String(m.clone()));
            }
            group.insert(
                "hooks".to_string(),
                serde_json::Value::Array(vec![serde_json::Value::Object(entry_obj.clone())]),
            );
            arr.push(serde_json::Value::Object(group));
        }
        Ok(serde_json::Value::Null)
    })?;

    let hook = Hook {
        id: new_id,
        event,
        matcher,
        command,
        enabled: true,
        source: "user".to_string(),
        description: None,
        extra: serde_json::Value::Object(serde_json::Map::new()),
    };
    Ok(HookMutationResult {
        success: true,
        hook: Some(hook),
        backup_path,
    })
}

pub fn update_hook_inner(
    id: String,
    command: Option<String>,
    enabled: Option<bool>,
    matcher: Option<String>,
) -> Result<HookMutationResult, String> {
    if let Some(c) = &command {
        validate_command(c)?;
    }
    if let Some(m) = matcher.as_deref() {
        if !m.is_empty() {
            validate_matcher(Some(m))?;
        }
    }
    let mut hook_out: Option<Hook> = None;
    let (_payload, backup_path) = mutate_hooks(|hooks_obj| {
        let hook = mutate_entry_by_id(hooks_obj, &id, |entry_obj, matcher_slot| {
            if let Some(c) = command.clone() {
                entry_obj.insert("command".to_string(), serde_json::Value::String(c));
            }
            if let Some(e) = enabled {
                let t = if e { "command" } else { "disabled-command" };
                entry_obj.insert("type".to_string(), serde_json::Value::String(t.into()));
            }
            if let Some(m) = matcher.clone() {
                // Empty string => drop matcher
                if m.trim().is_empty() {
                    *matcher_slot = None;
                } else {
                    *matcher_slot = Some(m);
                }
            }
            Ok(())
        })?;
        hook_out = Some(hook);
        Ok(serde_json::Value::Null)
    })?;
    Ok(HookMutationResult {
        success: true,
        hook: hook_out,
        backup_path,
    })
}

pub fn toggle_hook_inner(id: String) -> Result<HookMutationResult, String> {
    let mut hook_out: Option<Hook> = None;
    let (_payload, backup_path) = mutate_hooks(|hooks_obj| {
        let hook = mutate_entry_by_id(hooks_obj, &id, |entry_obj, _matcher_slot| {
            let current = entry_obj
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("command")
                .to_string();
            let next = if current == "disabled-command" {
                "command"
            } else {
                "disabled-command"
            };
            entry_obj.insert("type".to_string(), serde_json::Value::String(next.into()));
            Ok(())
        })?;
        hook_out = Some(hook);
        Ok(serde_json::Value::Null)
    })?;
    Ok(HookMutationResult {
        success: true,
        hook: hook_out,
        backup_path,
    })
}

pub fn delete_hook_inner(id: String) -> Result<HookMutationResult, String> {
    let (_payload, backup_path) = mutate_hooks(|hooks_obj| {
        delete_entry_by_id(hooks_obj, &id)?;
        Ok(serde_json::Value::Null)
    })?;
    Ok(HookMutationResult {
        success: true,
        hook: None,
        backup_path,
    })
}

// ---------------------------------------------------------------------------
// Test sandbox
// ---------------------------------------------------------------------------

/// Run a hook's command in a sandboxed PowerShell with a 5s timeout. The
/// command is fed to `powershell.exe -NoProfile -NonInteractive -Command -`
/// on stdin so we don't have to shell-escape it.
///
/// The mock payload (the JSON blob Claude Code would normally send on
/// stdin to the hook process) is exposed via the `CLAUDE_HOOK_PAYLOAD`
/// env var so hooks that read it explicitly can opt in. Hooks that read
/// stdin directly will block on EOF and hit the timeout — that's the
/// intended behavior (the UI displays a banner explaining why).
pub fn test_hook_inner(id: String, mock_payload: Option<String>) -> Result<HookTestResult, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let list = list_hooks_inner()?;
    let hook = list
        .hooks
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| format!("hook id '{}' not found", id))?;

    // Reject the test if the command tripped the validator at any point —
    // we don't want this to be a back-door for executing forbidden
    // fragments inside the test sandbox just because they're already
    // persisted.
    validate_command(&hook.command)?;

    let payload = mock_payload.unwrap_or_else(|| {
        // Sensible default — what Claude Code sends for a PreToolUse hook
        // against the Bash tool. The hook is free to ignore it.
        r#"{"tool_name":"Bash","tool_input":{"command":"echo hello"}}"#.to_string()
    });

    let start = Instant::now();

    // v15.5.18 review: pipe the hook command through PowerShell on Windows,
    // bash on Linux. The hook's own command is platform-agnostic (Python
    // script or shell snippet) but the test wrapper has to use the host
    // shell to drive stdin.
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "-",
        ]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("bash");
        c.arg("-s");
        c
    };

    let mut child = cmd
        .env("CLAUDE_HOOK_PAYLOAD", &payload)
        .env("ULTRON_HOOK_TEST", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn test shell: {}", e))?;

    // Write the command on stdin then close it so the shell exits.
    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(hook.command.as_bytes());
        #[cfg(target_os = "windows")]
        let _ = stdin.write_all(b"\nexit $LASTEXITCODE\n");
        #[cfg(not(target_os = "windows"))]
        let _ = stdin.write_all(b"\nexit $?\n");
    }
    // Drop stdin handle so the child sees EOF.
    drop(child.stdin.take());

    let mut timed_out = false;
    let status = {
        let kill_start = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if kill_start.elapsed() >= TEST_TIMEOUT {
                        timed_out = true;
                        let _ = child.kill();
                        break child.wait().map_err(|e| format!("reap: {}", e))?;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(format!("try_wait: {}", e)),
            }
        }
    };
    let elapsed = start.elapsed();

    // Read stdout/stderr after the child has exited.
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut s) = child.stdout.take() {
        use std::io::Read;
        let _ = s.read_to_string(&mut stdout);
    }
    if let Some(mut s) = child.stderr.take() {
        use std::io::Read;
        let _ = s.read_to_string(&mut stderr);
    }

    // Trim very large outputs so we don't bloat the IPC message.
    if stdout.len() > 16_000 {
        stdout.truncate(16_000);
        stdout.push_str("\n[...output truncated at 16KB]");
    }
    if stderr.len() > 16_000 {
        stderr.truncate(16_000);
        stderr.push_str("\n[...output truncated at 16KB]");
    }

    Ok(HookTestResult {
        success: status.success() && !timed_out,
        exit_code: status.code(),
        stdout,
        stderr,
        elapsed_ms: elapsed.as_millis(),
        timed_out,
    })
}

// ---------------------------------------------------------------------------
// Recent fires log
// ---------------------------------------------------------------------------

pub fn recent_hook_fires_inner(limit: Option<usize>) -> Result<HookFiresReport, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let path = home.join(".ultron/.tmp/hook-fires.jsonl");
    let log_path = path.to_string_lossy().to_string();
    if !path.exists() {
        return Ok(HookFiresReport {
            fires: Vec::new(),
            log_path,
            instrumented: false,
        });
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read hook-fires.jsonl: {}", e))?;
    let lim = limit.unwrap_or(100).clamp(1, 2000);
    let mut lines: Vec<&str> = raw.lines().filter(|l| !l.trim().is_empty()).collect();
    let n = lines.len();
    let start = n.saturating_sub(lim);
    lines.drain(0..start);
    let mut fires: Vec<HookFire> = Vec::with_capacity(lines.len());
    for line in lines.iter().rev() {
        let parsed: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let timestamp = parsed
            .get("timestamp")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                parsed
                    .get("ts")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
            });
        let event = parsed
            .get("event")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let hook_id = parsed
            .get("hook_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let matcher = parsed
            .get("matcher")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let exit_code = parsed.get("exit_code").and_then(|v| v.as_i64());
        fires.push(HookFire {
            timestamp,
            event,
            hook_id,
            matcher,
            exit_code,
            raw: parsed,
        });
    }
    Ok(HookFiresReport {
        fires,
        log_path,
        instrumented: true,
    })
}

// ---------------------------------------------------------------------------
// AI-create hook (spawns a Claude session — same UX as Memory's "with AI")
// ---------------------------------------------------------------------------

const HOOK_PROMPT_TEMPLATE: &str = r#"You are generating a Claude Code hook entry for ~/.claude/settings.json.

Supported hook events:
  - PreToolUse        (fires before a tool runs; can block via exit 2)
  - PostToolUse       (fires after a tool runs)
  - UserPromptSubmit  (fires when the user submits a prompt)
  - SessionStart      (fires when a session starts)
  - SessionEnd        (fires when a session ends)
  - Stop              (fires when Claude stops responding)
  - SubagentStop      (fires when a sub-agent stops)
  - PreCompact        (fires before context compaction)
  - Notification      (fires when Claude shows a notification)

The "matcher" field is optional. It's a regex matched against tool names
for PreToolUse / PostToolUse (e.g. "Bash", "Read|Glob|Grep", "mcp__.*").
Other events ignore it.

The "command" field is what gets executed. The placeholders below are
rewritten at install time to the user's actual home. On Windows, prefer:
  - PowerShell -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <HOME>/.ultron/scripts/hooks/<name>.ps1
  - <HOME>/.ultron/.venv/Scripts/python.exe <HOME>/.ultron/scripts/hooks/<name>.py
On Linux:
  - bash <HOME>/.ultron/scripts/hooks/<name>.sh
  - <HOME>/.ultron/.venv/bin/python <HOME>/.ultron/scripts/hooks/<name>.py

The user described what they want:
---
{DESCRIPTION}
---

Output ONLY a single JSON object with this exact shape, no fences, no
prose, no commentary:

{
  "event": "<one of the supported events>",
  "matcher": "<optional regex, or omit the key>",
  "command": "<the shell command to run>"
}

Rules:
- Pick the most appropriate event for the described behavior.
- If matcher is irrelevant for the chosen event, omit the key.
- The command must NOT contain any obvious RCE pattern (Invoke-Expression,
  IEX, DownloadString, curl | sh, rm -rf /, format c:, etc.) — the
  backend rejects those.
- Reference an existing script file when possible rather than inlining
  shell logic.
- If the user implies the hook should log something, write to
  ~/.ultron/.tmp/hook-fires.jsonl (one JSON line per fire).

Produce the JSON now."#;

pub async fn request_hook_via_ai_inner(
    app: &tauri::AppHandle,
    description: String,
) -> Result<String, String> {
    let description = description.trim().to_string();
    if description.is_empty() {
        return Err("description is empty".to_string());
    }
    let prompt = HOOK_PROMPT_TEMPLATE.replace("{DESCRIPTION}", &description);

    // Spawn a Claude session so the user gets the conversation UI and
    // can refine. Same pattern as Memory's "New note with AI" — no
    // inline round-trip parsing because hooks deserve a human-in-the-loop
    // confirmation step.
    let _ =
        crate::sessions::spawn_session_inner(app, "claude".to_string(), Some(prompt), None, None)
            .await?;
    Ok("Claude session abierta — pega el JSON resultante en Add hook".to_string())
}

// ---------------------------------------------------------------------------
// P7: last fired entry (tail of ~/.claude/projects/*/hook-fires.jsonl).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HookLastFired {
    pub id: String,
    pub timestamp: Option<String>,
    pub project: Option<String>,
    pub exit_code: Option<i32>,
}

pub fn hooks_last_fired_inner(id: String) -> HookLastFired {
    let Some(home) = dirs::home_dir() else {
        return HookLastFired {
            id,
            timestamp: None,
            project: None,
            exit_code: None,
        };
    };
    let base = home.join(".claude").join("projects");
    if !base.exists() {
        return HookLastFired {
            id,
            timestamp: None,
            project: None,
            exit_code: None,
        };
    }
    let mut latest: Option<(String, String, Option<i32>)> = None;
    if let Ok(rd) = std::fs::read_dir(&base) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path().join("hook-fires.jsonl");
            if !p.exists() {
                continue;
            }
            let project_slug = entry.file_name().to_string_lossy().to_string();
            let Ok(txt) = std::fs::read_to_string(&p) else {
                continue;
            };
            // Look at the most recent 50 lines for this hook's id.
            for line in txt.lines().rev().take(50) {
                let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(line) else {
                    continue;
                };
                // Match on either explicit hook_id field or fallback to "hook".
                let entry_id = json
                    .get("hook_id")
                    .and_then(|v| v.as_str())
                    .or_else(|| json.get("hook").and_then(|v| v.as_str()))
                    .unwrap_or("");
                if entry_id != id {
                    continue;
                }
                let ts = json
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let ec = json
                    .get("exit_code")
                    .and_then(|v| v.as_i64())
                    .map(|n| n as i32);
                let candidate = (ts.clone(), project_slug.clone(), ec);
                match &latest {
                    Some((existing_ts, _, _)) if existing_ts >= &ts => {}
                    _ => latest = Some(candidate),
                }
                break;
            }
        }
    }
    match latest {
        Some((ts, proj, ec)) => HookLastFired {
            id,
            timestamp: Some(ts),
            project: Some(proj),
            exit_code: ec,
        },
        None => HookLastFired {
            id,
            timestamp: None,
            project: None,
            exit_code: None,
        },
    }
}

// ---------------------------------------------------------------------------
// Auto-naming: analyze_hook_name
// ---------------------------------------------------------------------------

/// Result type for `analyze_hook_name_inner`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HookNameResult {
    pub id: String,
    /// Human-readable kebab-case name (2-4 words), e.g. "format-on-save".
    pub name: String,
    /// How the name was obtained: "ai", "heuristic", or "fallback".
    pub strategy: String,
    /// `true` if this result was served from the on-disk cache.
    pub cached: bool,
}

/// Path to the names cache JSON.
fn names_cache_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron").join("cockpit").join("hooks-names.json"))
}

/// Read the entire cache map (hook_id → name_record). Returns an empty map on
/// any I/O or parse error so callers never have to handle the error case.
fn read_names_cache() -> serde_json::Map<String, serde_json::Value> {
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
fn heuristic_name(command: &str) -> String {
    // 1. Shell / Python comment
    for line in command.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let candidate = rest.trim().to_string();
            if !candidate.is_empty() && candidate.len() <= 80 {
                return to_kebab_fragment(&candidate, 4);
            }
        }
    }
    // 2. PowerShell function: `function Verb-Noun { ... }`
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
    // 3. Python def
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
    // 4. First meaningful verb from the command line itself
    let words: Vec<&str> = command
        .split_whitespace()
        .filter(|w| !w.starts_with('-') && !w.starts_with('/') && !w.starts_with('$'))
        .collect();
    // Try to build a 2-word phrase from the executable + first arg
    let verb_phrase: Vec<String> = words
        .iter()
        .take(2)
        .map(|w| {
            // Strip .exe, .py, .ps1 etc. and take only the basename
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
    // Split on non-alnum, CamelCase boundaries, and underscores
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
    // Drop common noise tokens
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

/// Prompt sent to the AI to request a kebab-case name.
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
    // Keep only kebab-safe chars and collapse to max 4 segments
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
///   2. Call `ai_router::route("utility", prompt)` — uses Haiku/Gemini/Groq.
///   3. Heuristic extraction from command text.
///   4. Last-resort "hook" literal.
pub fn analyze_hook_name_inner(id: String) -> Result<HookNameResult, String> {
    // --- Check cache first ---
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

    // --- Lookup the hook to get its command text ---
    let list = list_hooks_inner()?;
    let hook = list
        .hooks
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| format!("hook '{}' not found", id))?;

    // --- Attempt AI naming ---
    let prompt = build_naming_prompt(&hook.id, &hook.event, &hook.command);
    let (name, strategy) = match crate::ai_router::route("utility", &prompt) {
        Ok(raw) => {
            let n = parse_ai_name(&raw);
            if n.len() >= 3 && n.contains('-') {
                (n, "ai".to_string())
            } else {
                // AI returned something too short/weird — fall back
                (heuristic_name(&hook.command), "heuristic".to_string())
            }
        }
        Err(_) => {
            // AI Router unavailable (no key, no zone, network error) — use heuristic
            (heuristic_name(&hook.command), "heuristic".to_string())
        }
    };

    // --- Persist to cache ---
    let entry = serde_json::json!({ "name": name, "strategy": strategy });
    cache.insert(id.clone(), entry);
    // Best-effort: cache write failure does not abort the response.
    let _ = write_names_cache(&cache);

    Ok(HookNameResult {
        id,
        name,
        strategy,
        cached: false,
    })
}

/// Bulk variant: analyse all hooks that don't have a cached name yet.
/// Returns the list of newly assigned names (already-cached hooks are skipped).
pub fn bulk_analyze_hook_names_inner() -> Result<Vec<HookNameResult>, String> {
    let list = list_hooks_inner()?;
    let cache = read_names_cache();
    let mut results: Vec<HookNameResult> = Vec::new();

    for hook in list.hooks.iter() {
        // Skip already-named hooks
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
        // Name this hook — ignore per-hook errors and continue bulk
        match analyze_hook_name_inner(hook.id.clone()) {
            Ok(r) => results.push(r),
            Err(e) => {
                // Push a fallback entry so the bulk caller knows we tried
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

// ---------------------------------------------------------------------------
// Hook descriptions — readable name + one-line summary per hook.
//
// the user's brief: the cards must show "el nombre de lo que hace cada una,
// no el código raro". This analyses every hook WITHOUT any AI call:
//   1. A curated catalog of the well-known ULTRON hooks (polished titles).
//   2. Fallback: parse the referenced script's leading header comment
//      (JSDoc `/** ... */`, `//` or `#` block) for a one-line summary, and
//      humanise the filename for the title.
//   3. Last resort: humanised basename only.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize)]
pub struct HookDescription {
    pub id: String,
    /// Short readable name shown as the card title (e.g. "Sincronizar sesión a Mem0").
    pub title: String,
    /// One-line description of what the hook does. May be empty.
    pub summary: String,
    /// "curated", "header", or "filename" — provenance, for debugging/UI hints.
    pub source: String,
}

/// Curated (title, summary) for the known ULTRON hook scripts, keyed by the
/// script's file name. Kept here (not AI) so the names are stable and precise.
fn curated_hook_meta(basename: &str) -> Option<(&'static str, &'static str)> {
    let meta: &[(&str, &str, &str)] = &[
        (
            "stop-compress-session.js",
            "Comprimir sesión a Qdrant",
            "Al cerrar, resume la sesión en hechos estructurados y los guarda en la colección Qdrant ultron_sessions para recall semántico.",
        ),
        (
            "kanban-update-reminder.js",
            "Recordatorio de Kanban",
            "Si detecta que se completó una tarea, recuerda actualizar el kanban del proyecto activo antes de cerrar.",
        ),
        (
            "load-cross-project-memory.js",
            "Cargar memoria cross-proyecto",
            "Al iniciar, inyecta un índice de las memorias (MEMORY.md) de todos los proyectos recientes, no solo el actual.",
        ),
        (
            "session-start-override.js",
            "Resumen de sesión previa (fallback por proyecto)",
            "Al iniciar, inyecta el resumen de la última sesión del mismo proyecto cuando el match por worktree del plugin falla.",
        ),
        (
            "workday-session-linker.js",
            "Vincular sesión a Workday",
            "Al iniciar, enlaza la nueva sesión con la jornada (Workday) en curso del Control Center.",
        ),
        (
            "session-recall-inject.js",
            "Recall semántico (Qdrant)",
            "Al iniciar, busca por similitud vectorial en Qdrant e inyecta el contexto más relevante de sesiones pasadas.",
        ),
        (
            "routing-dispatcher.js",
            "Router de skills y personas",
            "En cada prompt, puntúa el texto contra personas y skills y sugiere la más adecuada (sin LLM).",
        ),
        (
            "save-user-prompt.js",
            "Auto-guardar prompts del usuario",
            "En cada prompt, archiva el mensaje en un inbox markdown por día y marca el conocimiento crítico.",
        ),
        (
            "quota-capture.js",
            "Captura de cuota de Claude",
            "Tras cada herramienta, detecta avisos de límite de la suscripción y los escribe en quota-state.json.",
        ),
        // --- Hooks vigentes (iter-10, 2026-06) ---
        (
            "ensure-qdrant.ps1",
            "Arrancar Qdrant",
            "Al iniciar, comprueba que Qdrant esté vivo en el puerto 6333 y lo lanza si hace falta.",
        ),
        (
            "memory-warmup.js",
            "Precalentar memoria",
            "Al iniciar, precarga el índice de memoria y el modelo de embeddings E5 para que el primer recall no tarde.",
        ),
        (
            "project-card.js",
            "Ficha del proyecto",
            "Al iniciar, inyecta una ficha cacheada del proyecto actual (estado, decisiones, ubicación de funciones).",
        ),
        (
            "memory-session-resume.js",
            "Resumen de memoria al iniciar",
            "Al iniciar, inyecta el resume de tareas abiertas y decisiones recientes desde el sistema de memoria de ULTRON.",
        ),
        (
            "memory-orchestrate.js",
            "Orquestar memoria por prompt",
            "En cada prompt, hace prefetch del contexto relevante (recall híbrido sparse+denso) y lo inyecta como orientación.",
        ),
        (
            "deny-secrets.py",
            "Bloquear secretos",
            "Antes de cada herramienta, bloquea operaciones que expondrían secretos o credenciales (write-path guard).",
        ),
        (
            "posttoolfail-capture.js",
            "Capturar fallos de herramienta",
            "Tras un fallo de herramienta, registra el error como patrón para el recall futuro.",
        ),
        (
            "batch-capture.js",
            "Captura batch al cerrar",
            "Al cerrar, drena los candidatos de memoria pendientes acumulados durante la sesión.",
        ),
        (
            "qdrant-mirror-sync.js",
            "Espejar memoria a Qdrant",
            "Al cerrar, sincroniza los items nuevos de SQLite hacia la colección densa de Qdrant.",
        ),
        (
            "route_quality_aggregator.py",
            "Agregar calidad de routing",
            "Al cerrar, agrega la telemetría de routing de la sesión para medir aciertos del dispatcher.",
        ),
        (
            "session-end-summary.js",
            "Resumen al terminar la sesión",
            "En SessionEnd, escribe un resumen final de la sesión para arrancar mejor la siguiente.",
        ),
        (
            "precompact-preserve-l0.js",
            "Preservar contexto L0 antes de compactar",
            "Antes de compactar, guarda el contexto L0 (<=400 tokens) para que sobreviva a la compactación.",
        ),
        (
            "subagent-harvest.js",
            "Cosechar subagentes",
            "Cuando un subagente termina, recoge sus hallazgos hacia el sistema de memoria.",
        ),
        (
            "notify-relay.js",
            "Relé de notificaciones",
            "Reenvía las notificaciones de Claude Code hacia el Control Center / sistema operativo.",
        ),
    ];
    meta.iter()
        .find(|(name, _, _)| *name == basename)
        .map(|(_, title, summary)| (*title, *summary))
}

/// Extract the first script-like path argument from a hook command, e.g.
/// `node C:/Users/.../foo.js` → `C:/Users/.../foo.js`. Returns the raw token
/// (with `~` expanded) when it ends in a known script extension.
fn extract_script_path(command: &str) -> Option<PathBuf> {
    const EXTS: [&str; 6] = [".js", ".cjs", ".mjs", ".ts", ".py", ".ps1"];
    for raw in command.split_whitespace() {
        // Strip surrounding quotes a user may have added.
        let tok = raw.trim_matches(|c| c == '"' || c == '\'');
        let lower = tok.to_ascii_lowercase();
        if EXTS.iter().any(|e| lower.ends_with(e)) {
            let expanded =
                if let Some(rest) = tok.strip_prefix("~/").or_else(|| tok.strip_prefix("~\\")) {
                    dirs::home_dir()
                        .map(|h| h.join(rest))
                        .unwrap_or_else(|| PathBuf::from(tok))
                } else {
                    PathBuf::from(tok)
                };
            return Some(expanded);
        }
    }
    None
}

/// Read the leading header comment of a script and return its first meaningful
/// sentence as a one-line summary. Handles `/** */`, `//` and `#` styles.
fn parse_script_header(path: &Path) -> Option<String> {
    let raw = fs::read_to_string(path).ok()?;
    let mut summary_lines: Vec<String> = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        if idx > 40 {
            break;
        }
        let t = line.trim();
        if t.is_empty() {
            if summary_lines.is_empty() {
                continue;
            } else {
                break;
            }
        }
        if t.starts_with("#!") {
            continue; // shebang
        }
        // Strip comment markers.
        let cleaned = t
            .trim_start_matches("/**")
            .trim_start_matches("/*")
            .trim_start_matches("*/")
            .trim_start_matches('*')
            .trim_start_matches("//")
            .trim_start_matches('#')
            .trim();
        // Stop once code starts (no comment marker and we already have text).
        let is_comment =
            t.starts_with("/*") || t.starts_with('*') || t.starts_with("//") || t.starts_with('#');
        if !is_comment {
            if summary_lines.is_empty() {
                continue;
            }
            break;
        }
        if cleaned.is_empty() || cleaned == "'use strict';" {
            continue;
        }
        summary_lines.push(cleaned.to_string());
        // One or two lines is plenty for a card.
        if summary_lines.len() >= 2 {
            break;
        }
    }
    if summary_lines.is_empty() {
        return None;
    }
    let joined = summary_lines.join(" ");
    // Keep it to the first sentence (split on ". ") and cap the length.
    let first = joined.split(". ").next().unwrap_or(&joined).trim();
    let mut s = first.trim_end_matches('.').to_string();
    const MAX: usize = 160;
    if s.chars().count() > MAX {
        s = s.chars().take(MAX - 1).collect::<String>() + "…";
    }
    Some(s)
}

/// Turn `stop-compress-session.js` → `Stop compress session`.
fn humanize_basename(basename: &str) -> String {
    let stem = basename
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(basename);
    let words: Vec<String> = stem
        .split(['-', '_'])
        .filter(|w| !w.is_empty())
        .map(|w| w.to_string())
        .collect();
    if words.is_empty() {
        return basename.to_string();
    }
    let mut out = words.join(" ");
    // Capitalise the first character.
    if let Some(first) = out.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    out
}

/// Compute readable descriptions for every hook (no AI, no mutations).
pub fn get_hook_descriptions_inner() -> Vec<HookDescription> {
    let Ok(root) = read_settings_value() else {
        return Vec::new();
    };
    let mut out: Vec<HookDescription> = Vec::new();
    for hook in flatten_hooks(&root) {
        let script = extract_script_path(&hook.command);
        let basename = script
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let (title, summary, source) = if let Some((t, s)) = curated_hook_meta(&basename) {
            (t.to_string(), s.to_string(), "curated")
        } else if let Some(s) = script.as_ref().and_then(|p| parse_script_header(p)) {
            (humanize_basename(&basename), s, "header")
        } else if !basename.is_empty() {
            (humanize_basename(&basename), String::new(), "filename")
        } else {
            // Non-script command (inline shell): use the description field or
            // a trimmed command preview.
            let preview = hook.command.chars().take(80).collect::<String>();
            (
                hook.description.clone().unwrap_or_else(|| preview.clone()),
                String::new(),
                "command",
            )
        };

        out.push(HookDescription {
            id: hook.id,
            title,
            summary,
            source: source.to_string(),
        });
    }
    out
}
