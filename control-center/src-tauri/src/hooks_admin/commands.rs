// hooks_admin/commands.rs — Public inner functions called from Tauri command wrappers in lib.rs.

use std::fs;
use std::time::Instant;

use super::io::{
    compute_id, delete_entry_by_id, discover_plugin_hooks, flatten_hooks, mutate_entry_by_id,
    mutate_hooks, read_settings_value, settings_path,
};
use super::types::{
    Hook, HookFire, HookFiresReport, HookLastFired, HookMutationResult, HookTestResult, HooksList,
};
use super::validation::{validate_command, validate_event, validate_matcher, TEST_TIMEOUT};

pub fn list_hooks_inner() -> Result<HooksList, String> {
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    let exists = path.exists();
    let root = read_settings_value()?;
    let mut hooks = flatten_hooks(&root);
    hooks.extend(discover_plugin_hooks());
    Ok(HooksList {
        hooks,
        settings_path: path.to_string_lossy().to_string(),
        settings_exists: exists,
    })
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

/// Run a hook's command in a sandboxed PowerShell with a 5s timeout.
pub fn test_hook_inner(id: String, mock_payload: Option<String>) -> Result<HookTestResult, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let list = list_hooks_inner()?;
    let hook = list
        .hooks
        .into_iter()
        .find(|h| h.id == id)
        .ok_or_else(|| format!("hook id '{}' not found", id))?;

    validate_command(&hook.command)?;

    let payload = mock_payload.unwrap_or_else(|| {
        r#"{"tool_name":"Bash","tool_input":{"command":"echo hello"}}"#.to_string()
    });

    let start = Instant::now();

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

    if let Some(stdin) = child.stdin.as_mut() {
        let _ = stdin.write_all(hook.command.as_bytes());
        #[cfg(target_os = "windows")]
        let _ = stdin.write_all(b"\nexit $LASTEXITCODE\n");
        #[cfg(not(target_os = "windows"))]
        let _ = stdin.write_all(b"\nexit $?\n");
    }
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
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(e) => return Err(format!("try_wait: {}", e)),
            }
        }
    };
    let elapsed = start.elapsed();

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
            for line in txt.lines().rev().take(50) {
                let Ok(json): Result<serde_json::Value, _> = serde_json::from_str(line) else {
                    continue;
                };
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
  IEX, DownloadString, curl | sh, rm -rf /, format c:, etc.) -- the
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

    let _ =
        crate::sessions::spawn_session_inner(app, "claude".to_string(), Some(prompt), None, None)
            .await?;
    Ok("Claude session abierta -- pega el JSON resultante en Add hook".to_string())
}
