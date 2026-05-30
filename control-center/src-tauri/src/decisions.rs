// ULTRON Control Center — Decision Registry (KIRKARDO 24)
//
// Per-project decisions persisted at
//   ~/.ultron/cockpit/projects/<project_id>/decisions.jsonl
//
// Each line is one serialised `DecisionRecord`. Mutations do a full rewrite
// via tmp + rename (same strategy as kanban.rs and kg.rs). A process-wide
// `OnceLock<Mutex<()>>` serialises all read-modify-write paths.
//
// Auto-sync: when a record transitions to `Accepted` the record is mirrored
// to the local KG (kind = "decision") and, if Mem0 is configured, to Mem0.
// Both side-effects are best-effort — failures log a warning but do NOT
// block the status update.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------
// Process-wide write lock
// ---------------------------------------------------------------------------

static DECISIONS_WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn decisions_lock() -> &'static Mutex<()> {
    DECISIONS_WRITE_LOCK.get_or_init(|| Mutex::new(()))
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DecisionStatus {
    Proposed,
    Accepted,
    Superseded,
    Rejected,
}

impl std::fmt::Display for DecisionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            DecisionStatus::Proposed => "proposed",
            DecisionStatus::Accepted => "accepted",
            DecisionStatus::Superseded => "superseded",
            DecisionStatus::Rejected => "rejected",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DecisionRecord {
    /// dec-<microtime>-<counter>
    pub id: String,
    pub project_id: String,
    /// Short title — the "what was decided"
    pub decision: String,
    /// The reasoning — "why this choice over alternatives"
    pub rationale: String,
    /// Each element is one alternative that was considered
    #[serde(default)]
    pub alternatives_considered: Vec<String>,
    /// "epoch:<secs>"
    pub date: String,
    pub status: DecisionStatus,
    /// id of the record this one supersedes (if any)
    #[serde(default)]
    pub supersedes_id: Option<String>,
    /// GitHub PRs, issues, external references, etc.
    #[serde(default)]
    pub context_urls: Vec<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Payload accepted by `add_inner` — all required fields, optional ones
/// get sensible defaults.
#[derive(Debug, Deserialize)]
pub struct DecisionPayload {
    pub decision: String,
    pub rationale: String,
    #[serde(default)]
    pub alternatives_considered: Vec<String>,
    #[serde(default)]
    pub status: Option<DecisionStatus>,
    #[serde(default)]
    pub supersedes_id: Option<String>,
    #[serde(default)]
    pub context_urls: Vec<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// Patch accepted by `update_inner` — every field is optional.
#[derive(Debug, Deserialize, Default)]
pub struct DecisionPatch {
    #[serde(default)]
    pub decision: Option<String>,
    #[serde(default)]
    pub rationale: Option<String>,
    #[serde(default)]
    pub alternatives_considered: Option<Vec<String>>,
    #[serde(default)]
    pub status: Option<DecisionStatus>,
    #[serde(default)]
    pub supersedes_id: Option<Option<String>>,
    #[serde(default)]
    pub context_urls: Option<Vec<String>>,
    #[serde(default)]
    pub author: Option<Option<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

pub fn decisions_path(project_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no HOME dir")?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("decisions.jsonl"))
}

/// Pending file written by the Stop hook with auto-detected decisions awaiting
/// review. Drained into `decisions.jsonl` by `drain_pending_inner`.
pub fn pending_decisions_path(project_id: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no HOME dir")?;
    Ok(home
        .join(".ultron")
        .join("cockpit")
        .join("projects")
        .join(project_id)
        .join("decisions-pending.jsonl"))
}

// ---------------------------------------------------------------------------
// ID + timestamp helpers
// ---------------------------------------------------------------------------

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("epoch:{secs}")
}

fn new_decision_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_micros())
        .unwrap_or(0);
    format!("dec-{t}-{n}")
}

// ---------------------------------------------------------------------------
// Persistence: read / write all records for a project
// ---------------------------------------------------------------------------

fn read_all(project_id: &str) -> Result<Vec<DecisionRecord>, String> {
    let path = decisions_path(project_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<DecisionRecord>(trimmed) {
            Ok(r) => out.push(r),
            Err(e) => eprintln!("[decisions] skip malformed line {i}: {e}"),
        }
    }
    Ok(out)
}

fn write_atomic(path: &PathBuf, records: &[DecisionRecord]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    let mut f = fs::File::create(&tmp)
        .map_err(|e| format!("create tmp: {e}"))?;
    for rec in records {
        let line = serde_json::to_string(rec)
            .map_err(|e| format!("serialize decision: {e}"))?;
        writeln!(f, "{line}").map_err(|e| format!("write tmp: {e}"))?;
    }
    f.sync_all().ok();
    fs::rename(&tmp, path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Inner CRUD
// ---------------------------------------------------------------------------

pub fn add_inner(project_id: &str, payload: DecisionPayload) -> Result<DecisionRecord, String> {
    if payload.decision.trim().len() < 5 {
        return Err("decision title must be at least 5 characters".to_string());
    }
    if payload.rationale.trim().len() < 10 {
        return Err("rationale must be at least 10 characters".to_string());
    }

    let _g = decisions_lock().lock().map_err(|_| "decisions lock poisoned")?;
    let mut records = read_all(project_id)?;

    let rec = DecisionRecord {
        id: new_decision_id(),
        project_id: project_id.to_string(),
        decision: payload.decision.trim().to_string(),
        rationale: payload.rationale.trim().to_string(),
        alternatives_considered: payload.alternatives_considered,
        date: now_iso(),
        status: payload.status.unwrap_or(DecisionStatus::Proposed),
        supersedes_id: payload.supersedes_id,
        context_urls: payload.context_urls,
        author: payload.author,
        tags: payload.tags,
    };

    let is_accepted = rec.status == DecisionStatus::Accepted;
    records.push(rec.clone());

    let path = decisions_path(project_id)?;
    write_atomic(&path, &records)?;

    if is_accepted {
        fire_auto_sync(&rec);
    }

    Ok(rec)
}

pub fn update_inner(
    project_id: &str,
    id: &str,
    patch: DecisionPatch,
) -> Result<DecisionRecord, String> {
    let _g = decisions_lock().lock().map_err(|_| "decisions lock poisoned")?;
    let mut records = read_all(project_id)?;

    let pos = records
        .iter()
        .position(|r| r.id == id)
        .ok_or_else(|| format!("decision {id} not found"))?;

    let was_accepted = records[pos].status == DecisionStatus::Accepted;

    if let Some(v) = patch.decision {
        if v.trim().len() < 5 {
            return Err("decision title must be at least 5 characters".to_string());
        }
        records[pos].decision = v.trim().to_string();
    }
    if let Some(v) = patch.rationale {
        if v.trim().len() < 10 {
            return Err("rationale must be at least 10 characters".to_string());
        }
        records[pos].rationale = v.trim().to_string();
    }
    if let Some(v) = patch.alternatives_considered {
        records[pos].alternatives_considered = v;
    }
    if let Some(v) = patch.status {
        records[pos].status = v;
    }
    if let Some(v) = patch.supersedes_id {
        records[pos].supersedes_id = v;
    }
    if let Some(v) = patch.context_urls {
        records[pos].context_urls = v;
    }
    if let Some(v) = patch.author {
        records[pos].author = v;
    }
    if let Some(v) = patch.tags {
        records[pos].tags = v;
    }

    let out = records[pos].clone();
    let path = decisions_path(project_id)?;
    write_atomic(&path, &records)?;

    // Auto-sync on transition to Accepted (not if it was already Accepted).
    if !was_accepted && out.status == DecisionStatus::Accepted {
        fire_auto_sync(&out);
    }

    Ok(out)
}

pub fn list_inner(project_id: &str) -> Result<Vec<DecisionRecord>, String> {
    let mut records = read_all(project_id)?;
    // Newest first (epoch strings compare correctly lexicographically).
    records.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(records)
}

pub fn delete_inner(project_id: &str, id: &str) -> Result<(), String> {
    let _g = decisions_lock().lock().map_err(|_| "decisions lock poisoned")?;
    let mut records = read_all(project_id)?;
    let before = records.len();
    records.retain(|r| r.id != id);
    if records.len() == before {
        return Err(format!("decision {id} not found"));
    }
    let path = decisions_path(project_id)?;
    write_atomic(&path, &records)
}

// ---------------------------------------------------------------------------
// Auto-capture: drain the Stop-hook pending file into proposed decisions
// ---------------------------------------------------------------------------

/// One line of `decisions-pending.jsonl` as written by the Stop hook.
#[derive(Debug, Deserialize)]
struct PendingDecision {
    decision: String,
    #[serde(default)]
    rationale: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
}

/// Normalised title used for dedup (case + whitespace insensitive).
fn normalize_title(s: &str) -> String {
    s.trim().to_lowercase().split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Drain the per-project pending decisions file into `decisions.jsonl`.
///
/// Each pending line becomes a `Proposed` decision tagged `auto-captured`,
/// deduped against existing decisions AND within the batch (by normalised
/// title). The pending file is removed once consumed. No KG/Mem0 sync fires —
/// auto-captured decisions stay local until the user Accepts them. Best-effort:
/// a malformed pending line is skipped, never aborting the whole drain.
pub fn drain_pending_inner(project_id: &str) -> Result<Vec<DecisionRecord>, String> {
    let ppath = pending_decisions_path(project_id)?;
    if !ppath.exists() {
        return Ok(Vec::new());
    }

    let _g = decisions_lock().lock().map_err(|_| "decisions lock poisoned")?;

    let text = fs::read_to_string(&ppath)
        .map_err(|e| format!("read pending {}: {e}", ppath.display()))?;

    let mut records = read_all(project_id)?;
    let mut seen: std::collections::HashSet<String> =
        records.iter().map(|r| normalize_title(&r.decision)).collect();

    let mut added: Vec<DecisionRecord> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(p) = serde_json::from_str::<PendingDecision>(trimmed) else {
            continue;
        };
        let title = p.decision.trim();
        if title.len() < 5 {
            continue;
        }
        let norm = normalize_title(title);
        if seen.contains(&norm) {
            continue;
        }
        seen.insert(norm);

        let mut tags = p.tags;
        if !tags.iter().any(|t| t == "auto-captured") {
            tags.push("auto-captured".to_string());
        }

        let rationale = match p.rationale {
            Some(r) if r.trim().len() >= 10 => r.trim().to_string(),
            _ => format!(
                "Captado automáticamente del Stop hook{}. Revisar y aceptar o rechazar.",
                p.session_id
                    .as_deref()
                    .map(|s| format!(" (sesión {s})"))
                    .unwrap_or_default()
            ),
        };

        let rec = DecisionRecord {
            id: new_decision_id(),
            project_id: project_id.to_string(),
            decision: title.to_string(),
            rationale,
            alternatives_considered: vec![],
            date: now_iso(),
            status: DecisionStatus::Proposed,
            supersedes_id: None,
            context_urls: vec![],
            author: Some("auto".to_string()),
            tags,
        };
        records.push(rec.clone());
        added.push(rec);
    }

    if !added.is_empty() {
        let path = decisions_path(project_id)?;
        write_atomic(&path, &records)?;
    }
    // Always consume the pending file, even when everything was a duplicate.
    fs::remove_file(&ppath).ok();

    Ok(added)
}

// ---------------------------------------------------------------------------
// Multi-field search with scoring
//
// Scoring weights (per match):
//   decision title  : 3
//   rationale       : 2
//   tags            : 2
//   alternatives    : 1
//   author          : 1
//   context_urls    : 1
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct DecisionSearchResult {
    pub record: DecisionRecord,
    pub score: u32,
}

pub fn search_inner(
    query: &str,
    project_id: Option<&str>,
) -> Result<Vec<DecisionSearchResult>, String> {
    let needle = query.to_lowercase();
    if needle.trim().is_empty() {
        // Empty query: return all, score 0, sorted by date desc.
        let records = match project_id {
            Some(pid) => list_inner(pid)?,
            None => gather_all_projects()?,
        };
        return Ok(records
            .into_iter()
            .map(|r| DecisionSearchResult { record: r, score: 0 })
            .collect());
    }

    let records = match project_id {
        Some(pid) => list_inner(pid)?,
        None => gather_all_projects()?,
    };

    let mut results: Vec<DecisionSearchResult> = records
        .into_iter()
        .filter_map(|r| {
            let score = score_record(&r, &needle);
            if score > 0 { Some(DecisionSearchResult { record: r, score }) } else { None }
        })
        .collect();

    // Highest score first; ties broken by newest date.
    results.sort_by(|a, b| {
        b.score.cmp(&a.score).then_with(|| b.record.date.cmp(&a.record.date))
    });
    Ok(results)
}

fn score_record(r: &DecisionRecord, needle: &str) -> u32 {
    let mut score = 0u32;
    if r.decision.to_lowercase().contains(needle) {
        score += 3;
    }
    if r.rationale.to_lowercase().contains(needle) {
        score += 2;
    }
    if r.tags.iter().any(|t| t.to_lowercase().contains(needle)) {
        score += 2;
    }
    if r.alternatives_considered.iter().any(|a| a.to_lowercase().contains(needle)) {
        score += 1;
    }
    if r.author.as_deref().map(|a| a.to_lowercase().contains(needle)).unwrap_or(false) {
        score += 1;
    }
    if r.context_urls.iter().any(|u| u.to_lowercase().contains(needle)) {
        score += 1;
    }
    score
}

/// Collect decisions from every project directory found under
/// `~/.ultron/cockpit/projects/`. Unknown / malformed projects are skipped.
fn gather_all_projects() -> Result<Vec<DecisionRecord>, String> {
    let home = dirs::home_dir().ok_or("no HOME dir")?;
    let projects_dir = home.join(".ultron").join("cockpit").join("projects");
    if !projects_dir.exists() {
        return Ok(Vec::new());
    }
    let mut all: Vec<DecisionRecord> = Vec::new();
    let entries = fs::read_dir(&projects_dir)
        .map_err(|e| format!("read projects dir: {e}"))?;
    for entry in entries.flatten() {
        let meta = entry.metadata().ok();
        if meta.map(|m| m.is_dir()).unwrap_or(false) {
            if let Some(pid) = entry.file_name().to_str() {
                if let Ok(mut recs) = read_all(pid) {
                    all.append(&mut recs);
                }
            }
        }
    }
    all.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(all)
}

// ---------------------------------------------------------------------------
// Auto-sync: KG + Mem0 on Accepted (best-effort, non-fatal)
// ---------------------------------------------------------------------------

fn fire_auto_sync(rec: &DecisionRecord) {
    // Build the KG entity synchronously (kg operations are cheap local I/O).
    let entity_name = format!("decision:{}", rec.id);
    let mut observations = vec![
        format!("decision: {}", rec.decision),
        format!("rationale: {}", rec.rationale),
        format!("project: {}", rec.project_id),
        format!("status: {}", rec.status),
    ];
    if !rec.alternatives_considered.is_empty() {
        observations.push(format!(
            "alternatives: {}",
            rec.alternatives_considered.join("; ")
        ));
    }
    if !rec.tags.is_empty() {
        observations.push(format!("tags: {}", rec.tags.join(", ")));
    }

    let kg_entity = crate::kg::KgEntity {
        name: entity_name.clone(),
        entity_type: "decision".to_string(),
        observations,
    };

    if let Err(e) = crate::kg::create_entities_inner(vec![kg_entity]) {
        eprintln!("[decisions] KG sync warning for {}: {e}", rec.id);
    }

    // Mem0 add is async. We spawn onto the Tauri async runtime so we don't
    // build a second Tokio runtime (which would panic inside an existing one).
    // The call is fire-and-forget: the decisions write lock has already been
    // released before this function is called, so there is no deadlock risk.
    let rec_clone = rec.clone();
    tauri::async_runtime::spawn(async move {
        let text = format!(
            "Decision accepted in project `{}`: {}. Rationale: {}",
            rec_clone.project_id, rec_clone.decision, rec_clone.rationale
        );
        let metadata = serde_json::json!({
            "decision_id": rec_clone.id,
            "project_id": rec_clone.project_id,
            "status": rec_clone.status.to_string(),
            "tags": rec_clone.tags,
        });
        if let Err(e) = crate::mem0::add_inner(
            text,
            rec_clone.project_id.clone(),
            Some(metadata),
        )
        .await
        {
            eprintln!("[decisions] mem0 sync warning for {}: {e}", rec_clone.id);
        }
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn decision_id_is_unique() {
        let a = new_decision_id();
        let b = new_decision_id();
        assert_ne!(a, b);
        assert!(a.starts_with("dec-"));
    }

    #[test]
    fn score_record_weights() {
        let rec = DecisionRecord {
            id: "test".into(),
            project_id: "p".into(),
            decision: "use postgres".into(),
            rationale: "postgres is reliable".into(),
            alternatives_considered: vec!["sqlite".into()],
            date: "epoch:0".into(),
            status: DecisionStatus::Accepted,
            supersedes_id: None,
            context_urls: vec![],
            author: None,
            tags: vec!["postgres".into()],
        };
        // "postgres" matches decision (3) + rationale (2) + tags (2) = 7
        assert_eq!(score_record(&rec, "postgres"), 7);
        // "sqlite" matches alternatives (1)
        assert_eq!(score_record(&rec, "sqlite"), 1);
        // no match
        assert_eq!(score_record(&rec, "redis"), 0);
    }

    #[test]
    fn score_prefers_title_matches() {
        let rec_title = DecisionRecord {
            id: "a".into(),
            project_id: "p".into(),
            decision: "use react".into(),
            rationale: "stable library".into(),
            alternatives_considered: vec![],
            date: "epoch:1".into(),
            status: DecisionStatus::Proposed,
            supersedes_id: None,
            context_urls: vec![],
            author: None,
            tags: vec![],
        };
        let rec_rationale = DecisionRecord {
            id: "b".into(),
            project_id: "p".into(),
            decision: "choose frontend framework".into(),
            rationale: "react is well supported".into(),
            alternatives_considered: vec![],
            date: "epoch:0".into(),
            status: DecisionStatus::Proposed,
            supersedes_id: None,
            context_urls: vec![],
            author: None,
            tags: vec![],
        };
        let score_a = score_record(&rec_title, "react");
        let score_b = score_record(&rec_rationale, "react");
        assert!(score_a > score_b, "title match should outscore rationale-only match");
    }

    #[test]
    fn write_atomic_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("decisions.jsonl");
        let records = vec![
            DecisionRecord {
                id: "dec-1".into(),
                project_id: "proj".into(),
                decision: "use rust".into(),
                rationale: "memory safety matters here".into(),
                alternatives_considered: vec!["go".into()],
                date: "epoch:100".into(),
                status: DecisionStatus::Accepted,
                supersedes_id: None,
                context_urls: vec![],
                author: Some("USER".into()),
                tags: vec!["backend".into()],
            },
        ];
        write_atomic(&path, &records).unwrap();
        assert!(path.exists());
        let text = std::fs::read_to_string(&path).unwrap();
        let parsed: DecisionRecord = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(parsed.id, "dec-1");
        assert_eq!(parsed.decision, "use rust");
    }

    #[test]
    fn write_atomic_no_tmp_left() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("decisions.jsonl");
        write_atomic(&path, &[]).unwrap();
        let tmp_path = path.with_extension("jsonl.tmp");
        assert!(!tmp_path.exists(), ".tmp file must not linger after success");
    }

    #[test]
    fn decision_status_display() {
        assert_eq!(DecisionStatus::Proposed.to_string(), "proposed");
        assert_eq!(DecisionStatus::Accepted.to_string(), "accepted");
        assert_eq!(DecisionStatus::Superseded.to_string(), "superseded");
        assert_eq!(DecisionStatus::Rejected.to_string(), "rejected");
    }

    #[test]
    fn decisions_lock_is_same_static() {
        let a = decisions_lock() as *const Mutex<()>;
        let b = decisions_lock() as *const Mutex<()>;
        assert_eq!(a, b);
    }
}
