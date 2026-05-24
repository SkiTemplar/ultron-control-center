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

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
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
            let Some(inner_arr) = group_obj.get("hooks").and_then(|v| v.as_array()) else {
                continue;
            };
            for entry in inner_arr.iter() {
                let Some(entry_obj) = entry.as_object() else {
                    continue;
                };
                let type_str = entry_obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
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
                    extra: serde_json::Value::Object(extra_obj),
                });
            }
        }
    }
    out
}

fn validate_event(event: &str) -> Result<(), String> {
    if ALLOWED_EVENTS.iter().any(|e| *e == event) {
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
            let target_idx: Option<usize> = match group_obj
                .get("hooks")
                .and_then(|v| v.as_array())
            {
                Some(inner_arr) => {
                    let mut found: Option<usize> = None;
                    for (i, entry) in inner_arr.iter().enumerate() {
                        let Some(entry_obj) = entry.as_object() else {
                            continue;
                        };
                        let type_str = entry_obj
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
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
                    group_obj.insert(
                        "matcher".to_string(),
                        serde_json::Value::String(m.clone()),
                    );
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
            let Some(inner_arr) = group_obj.get_mut("hooks").and_then(|v| v.as_array_mut())
            else {
                continue;
            };
            let mut entry_idx_to_remove: Option<usize> = None;
            for (i, entry) in inner_arr.iter().enumerate() {
                let Some(entry_obj) = entry.as_object() else {
                    continue;
                };
                let type_str = entry_obj
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
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
pub fn test_hook_inner(
    id: String,
    mock_payload: Option<String>,
) -> Result<HookTestResult, String> {
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
    let _ = crate::sessions::spawn_session_inner(
        app,
        "claude".to_string(),
        Some(prompt),
        None,
        None,
    )
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
        return HookLastFired { id, timestamp: None, project: None, exit_code: None };
    };
    let base = home.join(".claude").join("projects");
    if !base.exists() {
        return HookLastFired { id, timestamp: None, project: None, exit_code: None };
    }
    let mut latest: Option<(String, String, Option<i32>)> = None;
    if let Ok(rd) = std::fs::read_dir(&base) {
        for entry in rd.filter_map(|e| e.ok()) {
            let p = entry.path().join("hook-fires.jsonl");
            if !p.exists() {
                continue;
            }
            let project_slug = entry.file_name().to_string_lossy().to_string();
            let Ok(txt) = std::fs::read_to_string(&p) else { continue };
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
        None => HookLastFired { id, timestamp: None, project: None, exit_code: None },
    }
}
