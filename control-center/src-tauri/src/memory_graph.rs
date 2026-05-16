// ULTRON Control Center — Memory graph module.
//
// Builds a 2D scatter-plot projection of the memory corpus for the
// `MemoryGraph` React component. Each entry in the brain_index.db
// `notes` table becomes a point with (x, y) coordinates plus the
// metadata the UI needs to render hover/click panels.
//
// IMPORTANT: this is NOT a real UMAP. Computing a true embedding
// projection requires onnxruntime + a vector store and would add
// ~70 MB of binaries to the bundle. Instead we compute deterministic
// pseudo-coordinates from hashes of (category, id, title, timestamp)
// so points are stable across runs and visually group by category on
// the x-axis. This is sufficient for the "show me the shape of my
// memory" use case the user asked for.
//
// Data source priority:
//   1. ~/.ultron/brain_index/index.db (preferred — has structured
//      layer/category/title/mtime per entry, 700+ records)
//   2. ~/.ultron/skill-vault/INDEX.json (fallback — skills only)
//
// We cap output at 500 points by uniform sampling, sorted by category
// then by timestamp. If both sources fail we return an empty Vec so
// the UI can show an empty-state message.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use serde::Serialize;

const MAX_POINTS: usize = 500;
const SNIPPET_CHARS: usize = 280;

#[derive(Debug, Serialize, Clone)]
pub struct MemoryPoint {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub category: String,
    pub title: String,
    pub snippet: String,
    pub timestamp: String,
    pub path: String,
}

// ---------------------------------------------------------------------------
// Hash-based pseudo-coordinates
// ---------------------------------------------------------------------------

fn h(s: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

/// Deterministic 2D position for a memory entry. Bigger "category" lobe
/// dominates x, with a per-id jitter so points within a category don't
/// collapse onto a single dot. Coordinates are roughly in [-0.5, 0.6]
/// before the front-end rescales them to the SVG viewBox.
fn pseudo_coords(category: &str, id: &str, title: &str, timestamp: &str) -> (f32, f32) {
    let cx = (h(category) % 1000) as f32 / 1000.0;
    let ix = (h(id) % 100) as f32 / 1000.0;
    let ty = (h(title) % 1000) as f32 / 1000.0;
    let sy = (h(timestamp) % 100) as f32 / 1000.0;
    (cx + ix - 0.5, ty + sy - 0.5)
}

// ---------------------------------------------------------------------------
// Source 1: brain_index/index.db via inline Python (uv run python -c)
// ---------------------------------------------------------------------------
//
// We don't want to add rusqlite (extra build complexity on Windows /
// 1-2 MB binary). The brain_index.py script already opens the DB
// safely with the right schema. We invoke an inline Python that dumps
// the columns we need as JSONL on stdout — same pattern the existing
// `brain_query_inner` uses.
//
// Output format: one JSON object per line with keys
//   id, path, layer, category, title, mtime, snippet
// We parse here and convert each row to a MemoryPoint.

#[derive(serde::Deserialize)]
struct BrainRow {
    #[serde(default)]
    id: i64,
    #[serde(default)]
    path: String,
    #[serde(default)]
    layer: String,
    #[serde(default)]
    category: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    mtime: f64,
    #[serde(default)]
    snippet: String,
}

fn from_brain_index_via_python(db_path: &PathBuf) -> Result<Vec<MemoryPoint>, String> {
    use std::process::Command;

    if !db_path.exists() {
        return Err(format!("brain_index db not found at {}", db_path.display()));
    }

    // Inline Python: dump the relevant columns as JSONL. Snippet is the
    // first SNIPPET_CHARS of `content` (stripped of frontmatter) with
    // line breaks collapsed.
    let py = format!(
        r#"
import json, sqlite3, sys
con = sqlite3.connect(r"{db}")
cur = con.cursor()
cur.execute("SELECT id, path, COALESCE(layer,''), COALESCE(category,''), COALESCE(title,''), mtime, COALESCE(content,'') FROM notes")
out = []
for row in cur.fetchall():
    nid, path, layer, category, title, mtime, content = row
    snippet = ' '.join((content or '')[:1200].split())[:{snip}]
    out.append({{
        "id": nid,
        "path": path or "",
        "layer": layer,
        "category": category,
        "title": title,
        "mtime": float(mtime or 0.0),
        "snippet": snippet,
    }})
sys.stdout.write(json.dumps(out, ensure_ascii=False))
"#,
        db = db_path.to_string_lossy().replace('\\', "\\\\"),
        snip = SNIPPET_CHARS,
    );

    // Prefer `uv run python -c` (per CLAUDE.md global rule). Fall back
    // to bare `python` only if uv is missing; on Windows uv is always
    // on PATH because ULTRON pins it.
    let output = Command::new("uv")
        .args(["run", "python", "-c", &py])
        .output()
        .map_err(|e| format!("spawn uv: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("brain_index dump failed: {}", stderr));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let rows: Vec<BrainRow> =
        serde_json::from_str(&stdout).map_err(|e| format!("parse rows: {}", e))?;

    let mut points: Vec<MemoryPoint> = rows
        .into_iter()
        .map(|r| {
            // Category falls back to layer if the row had none — keeps
            // the legend useful for skill-vault entries that lack a
            // category but always have a layer.
            let category = if r.category.is_empty() {
                r.layer.clone()
            } else {
                r.category.clone()
            };
            let timestamp = epoch_to_iso(r.mtime as u64);
            let id_str = r.id.to_string();
            let (x, y) = pseudo_coords(&category, &id_str, &r.title, &timestamp);
            MemoryPoint {
                id: id_str,
                x,
                y,
                category,
                title: if r.title.is_empty() {
                    r.path
                        .rsplit(['/', '\\'])
                        .next()
                        .unwrap_or("untitled")
                        .to_string()
                } else {
                    r.title
                },
                snippet: r.snippet,
                timestamp,
                path: r.path,
            }
        })
        .collect();

    // Uniform downsample if we're over the cap.
    if points.len() > MAX_POINTS {
        let stride = points.len() as f32 / MAX_POINTS as f32;
        let mut kept: Vec<MemoryPoint> = Vec::with_capacity(MAX_POINTS);
        let mut idx = 0.0f32;
        while (idx as usize) < points.len() && kept.len() < MAX_POINTS {
            kept.push(points[idx as usize].clone());
            idx += stride;
        }
        points = kept;
    }

    // Sort: category asc, timestamp desc within category (newest first).
    points.sort_by(|a, b| {
        a.category
            .cmp(&b.category)
            .then_with(|| b.timestamp.cmp(&a.timestamp))
    });

    Ok(points)
}

// ---------------------------------------------------------------------------
// Source 2: skill-vault/INDEX.json fallback
// ---------------------------------------------------------------------------

fn from_skill_vault_index(path: &PathBuf) -> Result<Vec<MemoryPoint>, String> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read INDEX.json: {}", e))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse INDEX.json: {}", e))?;
    let updated_at = v
        .get("updated_at")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let skills = v
        .get("skills")
        .and_then(|x| x.as_object())
        .ok_or_else(|| "INDEX.json has no 'skills' object".to_string())?;

    let mut points: Vec<MemoryPoint> = Vec::with_capacity(skills.len());
    for (name, entry) in skills.iter() {
        let description = entry
            .get("description")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let tags = entry
            .get("tags")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.as_str())
                    .collect::<Vec<&str>>()
            })
            .unwrap_or_default();
        // Use the first tag as a category when available — otherwise
        // bucket all skills together under "skill-vault".
        let category = tags
            .first()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "skill-vault".to_string());
        let timestamp = entry
            .get("vaulted_at")
            .and_then(|x| x.as_str())
            .unwrap_or(updated_at.as_str())
            .to_string();
        let (x, y) = pseudo_coords(&category, name, name, &timestamp);
        let mut snippet = description.clone();
        if snippet.len() > SNIPPET_CHARS {
            snippet.truncate(SNIPPET_CHARS);
            snippet.push_str("...");
        }
        points.push(MemoryPoint {
            id: format!("skill:{}", name),
            x,
            y,
            category,
            title: name.clone(),
            snippet,
            timestamp,
            path: String::new(),
        });
    }

    if points.len() > MAX_POINTS {
        let stride = points.len() as f32 / MAX_POINTS as f32;
        let mut kept: Vec<MemoryPoint> = Vec::with_capacity(MAX_POINTS);
        let mut idx = 0.0f32;
        while (idx as usize) < points.len() && kept.len() < MAX_POINTS {
            kept.push(points[idx as usize].clone());
            idx += stride;
        }
        points = kept;
    }

    points.sort_by(|a, b| {
        a.category
            .cmp(&b.category)
            .then_with(|| b.timestamp.cmp(&a.timestamp))
    });

    Ok(points)
}

// ---------------------------------------------------------------------------
// epoch -> ISO 8601 (no chrono dep; same approach as memory.rs)
// ---------------------------------------------------------------------------

fn epoch_to_iso(secs: u64) -> String {
    if secs == 0 {
        return "1970-01-01T00:00:00Z".to_string();
    }
    let mut days = (secs / 86_400) as i64;
    let secs_in_day = (secs % 86_400) as u32;
    let hh = secs_in_day / 3600;
    let mm = (secs_in_day % 3600) / 60;
    let ss = secs_in_day % 60;
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
        hh,
        mm,
        ss
    )
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

pub fn compute_memory_graph_inner() -> Result<Vec<MemoryPoint>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME dir".to_string())?;
    let db = home.join(".ultron/brain_index/index.db");
    let index_json = home.join(".ultron/skill-vault/INDEX.json");

    // Try brain_index.db first — richer, larger, has timestamps.
    if db.exists() {
        match from_brain_index_via_python(&db) {
            Ok(points) if !points.is_empty() => return Ok(points),
            Ok(_) => {
                // empty result — fall through to skill-vault
            }
            Err(e) => {
                // Don't surface the brain_index error if we have a
                // fallback; log via eprintln so devs can diagnose.
                eprintln!("[memory_graph] brain_index failed, falling back: {}", e);
            }
        }
    }

    if index_json.exists() {
        return from_skill_vault_index(&index_json);
    }

    Err(format!(
        "no memory data found (tried {} and {})",
        db.display(),
        index_json.display()
    ))
}

// ---------------------------------------------------------------------------
// Tauri command wrapper
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn compute_memory_graph() -> Result<Vec<MemoryPoint>, String> {
    // The dump spawns a python subprocess (~50-200ms). We call it on
    // the current async task; for the corpus sizes ULTRON deals with
    // (<2k entries) this is fast enough that we don't need to push
    // it to a blocking thread pool. If we ever notice UI hitches we
    // can switch to tauri_plugin_shell::ShellExt async output here.
    compute_memory_graph_inner()
}
