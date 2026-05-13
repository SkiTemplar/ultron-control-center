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

use serde::Serialize;

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
        .timeout(std::time::Duration::from_secs(2))
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
            .timeout(std::time::Duration::from_secs(2))
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
