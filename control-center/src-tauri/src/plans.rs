// ULTRON Control Center — Plans tab backend.
//
// Reads `~/.ultron/plans/PLANS.json` and surfaces the items[] array with a
// flattened shape the UI can render directly. Mutations land in v15.1.1 via
// patch_plan_status — same atomic-write discipline as projects.rs.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct PlanRoot {
    #[serde(default)]
    items: Vec<serde_json::Value>,
    #[serde(default)]
    updated_at: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PlanItem {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub priority: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub spec_path: Option<String>,
    pub created_at: Option<String>,
    pub resolved_at: Option<String>,
    pub effort_hours: Option<Vec<u32>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PlansReport {
    pub items: Vec<PlanItem>,
    pub updated_at: Option<String>,
}

fn plans_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/plans/PLANS.json"))
}

fn extract_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
fn extract_opt_str(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}
fn extract_tags(v: &serde_json::Value) -> Vec<String> {
    v.get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
fn extract_effort(v: &serde_json::Value) -> Option<Vec<u32>> {
    let arr = v.get("effort_hours")?.as_array()?;
    let mut out: Vec<u32> = Vec::new();
    for x in arr {
        if let Some(n) = x.as_u64() {
            out.push(n as u32);
        }
    }
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

pub fn list_plans_inner() -> Result<PlansReport, String> {
    let path = plans_path().ok_or_else(|| "no HOME".to_string())?;
    if !path.exists() {
        return Ok(PlansReport {
            items: Vec::new(),
            updated_at: None,
        });
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let root: PlanRoot = serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let mut items: Vec<PlanItem> = Vec::with_capacity(root.items.len());
    for v in root.items.iter() {
        items.push(PlanItem {
            id: extract_str(v, "id"),
            title: extract_str(v, "title"),
            kind: extract_str(v, "kind"),
            status: extract_str(v, "status"),
            priority: extract_str(v, "priority"),
            description: extract_opt_str(v, "description"),
            tags: extract_tags(v),
            spec_path: extract_opt_str(v, "spec_path"),
            created_at: extract_opt_str(v, "created_at"),
            resolved_at: extract_opt_str(v, "resolved_at"),
            effort_hours: extract_effort(v),
        });
    }
    Ok(PlansReport {
        items,
        updated_at: root.updated_at,
    })
}

/// Patch the `status` field on a single plan item, atomically. Doesn't
/// validate the new status against an enum — the canonical statuses are
/// open / in_progress / blocked / resolved / wontfix, but PLANS.json may
/// carry other values from history.
pub fn patch_plan_status_inner(id: String, new_status: String) -> Result<bool, String> {
    if id.trim().is_empty() {
        return Err("id is empty".into());
    }
    let allowed = ["open", "in_progress", "blocked", "resolved", "wontfix"];
    if !allowed.contains(&new_status.as_str()) {
        return Err(format!("invalid status '{}'", new_status));
    }
    let path = plans_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let mut root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    let items = root
        .get_mut("items")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "no items[]".to_string())?;
    let mut touched = false;
    for v in items.iter_mut() {
        if v.get("id").and_then(|x| x.as_str()) == Some(id.as_str()) {
            v["status"] = serde_json::Value::String(new_status.clone());
            if new_status == "resolved" {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                v["resolved_at"] = serde_json::Value::String(format_unix_iso(now));
            }
            touched = true;
            break;
        }
    }
    if !touched {
        return Err(format!("plan '{}' not found", id));
    }
    if let Some(obj) = root.as_object_mut() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        obj.insert(
            "updated_at".to_string(),
            serde_json::Value::String(format_unix_iso(now)),
        );
    }
    let serialized = serde_json::to_string_pretty(&root).map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {}", e))?;
    Ok(true)
}

fn format_unix_iso(secs: u64) -> String {
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd { break; }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", year, month + 1, days + 1, h, m, s)
}
