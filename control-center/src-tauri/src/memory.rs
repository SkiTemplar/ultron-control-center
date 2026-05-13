// ULTRON Control Center — Memory module.
//
// Aggregates the state of the three memory layers ULTRON uses:
//   1. L2 vault   (~/.ultron-vault/) — Obsidian-style markdown corpus
//   2. L1 brain   (~/.ultron/brain_index/index.db) — FTS5 keyword index
//   3. Qdrant     (http://localhost:6333) — semantic recall collections
//
// All reads are filesystem-local or a single HTTP GET against qdrant
// healthz / collections. No mutations from this module; sync/push actions
// shell out to existing scripts (handled in lib.rs).

use std::fs;
use std::path::PathBuf;
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Clone)]
pub struct MemoryStatus {
    pub vault: VaultStatus,
    pub brain: BrainStatus,
    pub qdrant: QdrantStatus,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct VaultStatus {
    pub exists: bool,
    pub path: Option<String>,
    pub note_count: u64,
    pub size_bytes: u64,
    pub last_modified: Option<String>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct BrainStatus {
    pub exists: bool,
    pub path: Option<String>,
    pub size_bytes: u64,
    pub last_modified: Option<String>,
    pub age_hours: Option<f64>,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct QdrantStatus {
    pub up: bool,
    pub error: Option<String>,
    pub collections: Vec<QdrantCollection>,
}

#[derive(Debug, Serialize, Clone)]
pub struct QdrantCollection {
    pub name: String,
    pub points_count: Option<u64>,
    pub vectors_count: Option<u64>,
    pub status: Option<String>,
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

fn system_time_to_iso(t: SystemTime) -> Option<String> {
    let secs = t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs();
    // Format as ISO 8601 UTC without external deps. Approximate: use chrono-less
    // arithmetic — month-aware calculation is overkill for "last modified" use.
    // Instead format as epoch + an h:m:s string. We render in the UI with the
    // user's locale anyway.
    Some(epoch_to_iso(secs))
}

fn epoch_to_iso(secs: u64) -> String {
    // Days from 1970-01-01
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let h = secs_in_day / 3600;
    let m = (secs_in_day % 3600) / 60;
    let s = secs_in_day % 60;

    // Compute calendar date
    let mut year = 1970i32;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let yd: i64 = if leap { 366 } else { 365 };
        if days < yd {
            break;
        }
        days -= yd;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let mdays: [i64; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    while month < 12 && days >= mdays[month] {
        days -= mdays[month];
        month += 1;
    }
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year,
        month + 1,
        days + 1,
        h,
        m,
        s
    )
}

fn dir_stats(dir: &PathBuf) -> (u64, u64, Option<SystemTime>) {
    // Recursive walk: count .md files, sum sizes, latest mtime.
    let mut count = 0u64;
    let mut total = 0u64;
    let mut latest: Option<SystemTime> = None;
    let walker = walkdir(dir);
    for entry in walker {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        if entry.path().extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        count += 1;
        total += meta.len();
        if let Ok(mt) = meta.modified() {
            latest = Some(latest.map_or(mt, |cur| if mt > cur { mt } else { cur }));
        }
    }
    (count, total, latest)
}

// Minimal manual walker so we don't pull in a walkdir crate. The vault is
// small enough (<10k files) that this is fine.
struct WalkIter {
    stack: Vec<PathBuf>,
}

fn walkdir(root: &PathBuf) -> WalkIter {
    WalkIter { stack: vec![root.clone()] }
}

struct WalkEntry {
    path: PathBuf,
}

impl WalkEntry {
    fn path(&self) -> &PathBuf {
        &self.path
    }
    fn metadata(&self) -> Result<fs::Metadata, std::io::Error> {
        fs::metadata(&self.path)
    }
}

impl Iterator for WalkIter {
    type Item = WalkEntry;
    fn next(&mut self) -> Option<Self::Item> {
        while let Some(p) = self.stack.pop() {
            let Ok(meta) = fs::metadata(&p) else { continue };
            if meta.is_dir() {
                if let Ok(rd) = fs::read_dir(&p) {
                    for child in rd.flatten() {
                        // Skip hidden dirs to avoid .git/.obsidian/etc.
                        let name = child.file_name();
                        let s = name.to_string_lossy();
                        if s.starts_with('.') {
                            continue;
                        }
                        self.stack.push(child.path());
                    }
                }
                continue;
            }
            return Some(WalkEntry { path: p });
        }
        None
    }
}

// ---------------------------------------------------------------------------
// Vault status
// ---------------------------------------------------------------------------

fn read_vault() -> VaultStatus {
    let Some(home) = dirs::home_dir() else {
        return VaultStatus::default();
    };
    let path = home.join(".ultron-vault");
    if !path.exists() {
        return VaultStatus::default();
    }
    let (count, total, latest) = dir_stats(&path);
    VaultStatus {
        exists: true,
        path: Some(path.to_string_lossy().to_string()),
        note_count: count,
        size_bytes: total,
        last_modified: latest.and_then(system_time_to_iso),
    }
}

// ---------------------------------------------------------------------------
// Brain index status
// ---------------------------------------------------------------------------

fn read_brain() -> BrainStatus {
    let Some(home) = dirs::home_dir() else {
        return BrainStatus::default();
    };
    let path = home.join(".ultron/brain_index/index.db");
    let Ok(meta) = fs::metadata(&path) else {
        return BrainStatus::default();
    };
    let last_modified = meta.modified().ok();
    let age_hours = last_modified.and_then(|t| {
        t.elapsed().ok().map(|d| d.as_secs_f64() / 3600.0)
    });
    BrainStatus {
        exists: true,
        path: Some(path.to_string_lossy().to_string()),
        size_bytes: meta.len(),
        last_modified: last_modified.and_then(system_time_to_iso),
        age_hours,
    }
}

// ---------------------------------------------------------------------------
// Qdrant collections
// ---------------------------------------------------------------------------

fn read_qdrant() -> QdrantStatus {
    // Single sync request to /collections (cheap, ~1ms when up).
    let mut status = QdrantStatus::default();

    let resp = match ureq::get("http://localhost:6333/collections")
        .timeout(std::time::Duration::from_secs(8))
        .call()
    {
        Ok(r) => r,
        Err(e) => {
            status.error = Some(format!("{}", e));
            return status;
        }
    };

    let body = match resp.into_string() {
        Ok(s) => s,
        Err(e) => {
            status.error = Some(format!("read body: {}", e));
            return status;
        }
    };

    #[derive(serde::Deserialize)]
    struct CollList {
        result: Option<CollResult>,
    }
    #[derive(serde::Deserialize)]
    struct CollResult {
        collections: Vec<CollName>,
    }
    #[derive(serde::Deserialize)]
    struct CollName {
        name: String,
    }

    let parsed: CollList = match serde_json::from_str(&body) {
        Ok(p) => p,
        Err(e) => {
            status.error = Some(format!("parse: {}", e));
            return status;
        }
    };
    status.up = true;

    let collections = parsed.result.map(|r| r.collections).unwrap_or_default();
    for c in collections {
        // Fetch per-collection details for points_count
        let detail = ureq::get(&format!("http://localhost:6333/collections/{}", c.name))
            .timeout(std::time::Duration::from_secs(8))
            .call();
        let (points, vectors, st) = match detail {
            Ok(r) => match r.into_string() {
                Ok(s) => parse_collection_detail(&s),
                Err(_) => (None, None, None),
            },
            Err(_) => (None, None, None),
        };
        status.collections.push(QdrantCollection {
            name: c.name,
            points_count: points,
            vectors_count: vectors,
            status: st,
        });
    }
    status
}

fn parse_collection_detail(body: &str) -> (Option<u64>, Option<u64>, Option<String>) {
    #[derive(serde::Deserialize)]
    struct D {
        result: Option<DR>,
    }
    #[derive(serde::Deserialize)]
    struct DR {
        points_count: Option<u64>,
        vectors_count: Option<u64>,
        status: Option<String>,
    }
    match serde_json::from_str::<D>(body) {
        Ok(d) => {
            let r = d.result.unwrap_or(DR { points_count: None, vectors_count: None, status: None });
            (r.points_count, r.vectors_count, r.status)
        }
        Err(_) => (None, None, None),
    }
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

pub fn memory_status_inner() -> MemoryStatus {
    MemoryStatus {
        vault: read_vault(),
        brain: read_brain(),
        qdrant: read_qdrant(),
    }
}

// ---------------------------------------------------------------------------
// brain_index.py query passthrough
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BrainResult {
    #[serde(default)]
    pub id: i64,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub layer: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub snippet: String,
    #[serde(default)]
    pub rank: f64,
}

#[derive(serde::Deserialize)]
struct BrainQueryOutput {
    #[serde(default)]
    results: Vec<BrainResult>,
}

pub async fn brain_query_inner(
    app: &tauri::AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<BrainResult>, String> {
    use tauri_plugin_shell::ShellExt;
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let script = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit/brain_index.py");
    let script_str = script.to_string_lossy().to_string();
    let lim = limit.unwrap_or(20).min(50).to_string();

    let output = app
        .shell()
        .command("uv")
        .args([
            "run",
            "python",
            &script_str,
            "query",
            &query,
            "--limit",
            &lim,
        ])
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("brain_index query failed: {}", stderr));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let parsed: BrainQueryOutput =
        serde_json::from_str(&stdout).map_err(|e| format!("parse output: {}", e))?;
    Ok(parsed.results)
}

// ---------------------------------------------------------------------------
// Memory actions — invoke the sync/index scripts via shell sidecar
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct ActionResult {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub action: String,
}

/// Dispatch one of the known memory maintenance actions. We keep the script
/// names hardcoded on the Rust side so the capability validator can pin the
/// exact paths it allows.
pub async fn memory_action_inner(
    app: &tauri::AppHandle,
    action: String,
) -> Result<ActionResult, String> {
    use tauri_plugin_shell::ShellExt;
    let scripts_dir = dirs::home_dir()
        .ok_or_else(|| "no HOME".to_string())?
        .join(".ultron/scripts/cockpit");

    // Each action maps to a (script, args) pair.
    let (script_name, args): (&str, Vec<&str>) = match action.as_str() {
        "vault-sync" => ("memory_sync.py", vec!["sync"]),
        "brain-update" => ("brain_index.py", vec!["update"]),
        "qdrant-reembed" => ("embed_vault.py", vec!["index"]),
        "skills-reembed" => ("embed_skills.py", vec![]),
        _ => return Err(format!("unknown memory action '{}'", action)),
    };

    let script_path = scripts_dir.join(script_name);
    let script_str = script_path.to_string_lossy().to_string();

    let mut full_args: Vec<String> = vec!["run".into(), "python".into(), script_str.clone()];
    for a in &args {
        full_args.push((*a).to_string());
    }
    let str_args: Vec<&str> = full_args.iter().map(String::as_str).collect();

    let output = app
        .shell()
        .command("uv")
        .args(str_args)
        .output()
        .await
        .map_err(|e| format!("spawn uv: {}", e))?;

    Ok(ActionResult {
        success: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        exit_code: output.status.code(),
        action,
    })
}

// ---------------------------------------------------------------------------
// Read note from vault (filesystem, sanitized path)
// ---------------------------------------------------------------------------

/// Read a markdown note. Only paths inside the trusted memory roots are
/// allowed so a renegade caller can't read arbitrary files via this command.
pub fn read_vault_note_inner(path: String) -> Result<String, String> {
    use std::path::Path;
    let Some(home) = dirs::home_dir() else {
        return Err("no HOME".to_string());
    };
    let allowed_roots = [
        home.join(".ultron-vault"),
        home.join(".ultron/sessions"),
        home.join(".ultron/cockpit/news"),
        home.join(".ultron/plans"),
        home.join(".ultron/archive"),
        home.join(".ultron/audits"),
        home.join(".ultron/cockpit/audits"),
    ];
    let candidate = Path::new(&path);
    let canonical = match candidate.canonicalize() {
        Ok(p) => p,
        Err(e) => return Err(format!("canonicalize: {}", e)),
    };
    let inside_allowed = allowed_roots.iter().any(|root| {
        root.canonicalize()
            .map(|c| canonical.starts_with(c))
            .unwrap_or(false)
    });
    if !inside_allowed {
        return Err(format!(
            "path '{}' is outside allowed memory roots",
            canonical.display()
        ));
    }
    if canonical.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("only .md files allowed".to_string());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("read: {}", e))
}
