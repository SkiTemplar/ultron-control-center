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

#[derive(Debug, Deserialize)]
pub struct CreatePlanPayload {
    pub title: String,
    pub priority: Option<String>,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePlanPayload {
    pub id: String,
    pub title: Option<String>,
    pub priority: Option<String>,
    pub kind: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct PlanMutateResult {
    pub success: bool,
    pub id: String,
}

fn slugify(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_dash = false;
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_unix_iso(secs)
}

fn read_plans_root() -> Result<(PathBuf, serde_json::Value), String> {
    let path = plans_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = fs::read_to_string(&path).map_err(|e| format!("read: {}", e))?;
    let root: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse: {}", e))?;
    Ok((path, root))
}

fn write_plans_root(path: &PathBuf, root: &serde_json::Value) -> Result<(), String> {
    let mut value = root.clone();
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "updated_at".to_string(),
            serde_json::Value::String(now_iso()),
        );
    }
    let serialized =
        serde_json::to_string_pretty(&value).map_err(|e| format!("serialize: {}", e))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename: {}", e))?;
    Ok(())
}

pub fn add_plan_inner(p: CreatePlanPayload) -> Result<PlanMutateResult, String> {
    let title = p.title.trim();
    if title.is_empty() {
        return Err("title is empty".into());
    }
    let (path, mut root) = read_plans_root()?;
    let items = root
        .get_mut("items")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "no items[]".to_string())?;
    let existing: std::collections::HashSet<String> = items
        .iter()
        .filter_map(|v| v.get("id").and_then(|x| x.as_str()).map(String::from))
        .collect();
    let base = slugify(title);
    let base = if base.is_empty() { "plan".to_string() } else { base };
    let mut id = base.clone();
    let mut i = 2u32;
    while existing.contains(&id) {
        id = format!("{}-{}", base, i);
        i += 1;
    }
    let priority = p.priority.as_deref().unwrap_or("p3").to_string();
    let status = p.status.as_deref().unwrap_or("open").to_string();
    let kind = p.kind.as_deref().unwrap_or("task").to_string();
    let entry = serde_json::json!({
        "id": id,
        "kind": kind,
        "title": title,
        "status": status,
        "priority": priority,
        "tags": p.tags.unwrap_or_default(),
        "description": p.description.unwrap_or_default(),
        "created_at": now_iso(),
        "resolved_at": serde_json::Value::Null,
    });
    items.push(entry);
    write_plans_root(&path, &root)?;
    Ok(PlanMutateResult { success: true, id })
}

pub fn update_plan_inner(p: UpdatePlanPayload) -> Result<PlanMutateResult, String> {
    if p.id.trim().is_empty() {
        return Err("id is empty".into());
    }
    let (path, mut root) = read_plans_root()?;
    let items = root
        .get_mut("items")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "no items[]".to_string())?;
    let target = items.iter_mut().find(|v| {
        v.get("id").and_then(|x| x.as_str()).map(String::from) == Some(p.id.clone())
    });
    let entry = target.ok_or_else(|| format!("plan '{}' not found", p.id))?;
    if let Some(title) = p.title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        entry["title"] = serde_json::Value::String(title.to_string());
    }
    if let Some(priority) = p.priority.as_deref().filter(|s| !s.is_empty()) {
        entry["priority"] = serde_json::Value::String(priority.to_string());
    }
    if let Some(kind) = p.kind.as_deref().filter(|s| !s.is_empty()) {
        entry["kind"] = serde_json::Value::String(kind.to_string());
    }
    if let Some(desc) = p.description.as_deref() {
        entry["description"] = serde_json::Value::String(desc.to_string());
    }
    if let Some(tags) = p.tags.as_ref() {
        let arr: Vec<serde_json::Value> = tags
            .iter()
            .filter_map(|t| {
                let t = t.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(serde_json::Value::String(t.to_string()))
                }
            })
            .collect();
        entry["tags"] = serde_json::Value::Array(arr);
    }
    write_plans_root(&path, &root)?;
    Ok(PlanMutateResult {
        success: true,
        id: p.id,
    })
}

pub fn delete_plan_inner(id: String) -> Result<PlanMutateResult, String> {
    if id.trim().is_empty() {
        return Err("id is empty".into());
    }
    let (path, mut root) = read_plans_root()?;
    let items = root
        .get_mut("items")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "no items[]".to_string())?;
    let before = items.len();
    items.retain(|v| v.get("id").and_then(|x| x.as_str()) != Some(id.as_str()));
    let after = items.len();
    write_plans_root(&path, &root)?;
    Ok(PlanMutateResult {
        success: before != after,
        id,
    })
}

/// Archive every item with status == "resolved" to
/// `plans/_archive/resolved-YYYY-MM.json` and drop them from PLANS.json.
/// Returns the count moved. We never delete history — the user explicitly
/// asked for Resolved not to grow unbounded but also not to be discarded.
pub fn clean_resolved_plans_inner() -> Result<u64, String> {
    let (path, mut root) = read_plans_root()?;
    let items = root
        .get_mut("items")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| "no items[]".to_string())?;

    // Split into kept + archived.
    let mut archived: Vec<serde_json::Value> = Vec::new();
    let mut kept: Vec<serde_json::Value> = Vec::with_capacity(items.len());
    for item in items.drain(..) {
        if item.get("status").and_then(|x| x.as_str()) == Some("resolved") {
            archived.push(item);
        } else {
            kept.push(item);
        }
    }
    *items = kept;
    let moved = archived.len() as u64;
    if moved == 0 {
        return Ok(0);
    }

    // Append to the monthly archive file, atomically.
    let archive_dir = path.parent().unwrap_or(&path).join("_archive");
    fs::create_dir_all(&archive_dir).map_err(|e| format!("mkdir archive: {}", e))?;
    let now = now_iso();
    let ym = &now[..7]; // YYYY-MM
    let archive_path = archive_dir.join(format!("resolved-{}.json", ym));

    let mut existing: Vec<serde_json::Value> = if archive_path.exists() {
        let raw = fs::read_to_string(&archive_path).unwrap_or_else(|_| "[]".into());
        serde_json::from_str(&raw).unwrap_or_default()
    } else {
        Vec::new()
    };
    existing.extend(archived);
    let serialized =
        serde_json::to_string_pretty(&existing).map_err(|e| format!("serialize: {}", e))?;
    let tmp = archive_path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write archive: {}", e))?;
    fs::rename(&tmp, &archive_path).map_err(|e| format!("rename archive: {}", e))?;

    write_plans_root(&path, &root)?;
    Ok(moved)
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
