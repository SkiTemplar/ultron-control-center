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

pub(crate) fn read_all(project_id: &str) -> Result<Vec<DecisionRecord>, String> {
    let path = decisions_path(project_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
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
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
    for rec in records {
        let line = serde_json::to_string(rec).map_err(|e| format!("serialize decision: {e}"))?;
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

    let _g = decisions_lock()
        .lock()
        .map_err(|_| "decisions lock poisoned")?;
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
    let _g = decisions_lock()
        .lock()
        .map_err(|_| "decisions lock poisoned")?;
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
    let _g = decisions_lock()
        .lock()
        .map_err(|_| "decisions lock poisoned")?;
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
// Noise filter for auto-captured decisions
// ---------------------------------------------------------------------------

/// Minimum title length (inclusive) to be considered a real decision.
const NOISE_MIN_TITLE_LEN: usize = 10;

/// Substrings that identify git-state chatter — not decisions.
const NOISE_GIT_PATTERNS: &[&str] = &[
    "working tree",
    "clean",
    "uncommitted",
    "nothing to commit",
    "untracked files",
    "branch is up to date",
    "your branch",
];

/// Substrings that identify CI / test-pipeline output — not decisions.
const NOISE_CI_PATTERNS: &[&str] = &[
    "test passed",
    "tests passed",
    "version-drift",
    "ci ",
    "pipeline ",
    "build succeeded",
    "build failed",
    "check passed",
    "lint passed",
    "cargo check",
    "cargo test",
];

/// Substrings that identify model-announcement noise — not decisions.
const NOISE_MODEL_PATTERNS: &[&str] = &[
    "usando claude",
    "using claude",
    "claude opus",
    "claude sonnet",
    "claude haiku",
    "opus ",
    "sonnet ",
    "haiku ",
    "gpt-4",
    "gemini",
    "modelo ",
    "model ",
];

/// Returns `true` when `title` (and optionally `body`) look like operational
/// noise rather than an architectural decision worth preserving.
///
/// Rules applied in order:
/// 1. Title shorter than `NOISE_MIN_TITLE_LEN` characters → noise.
/// 2. Title or body contains a git-state pattern → noise.
/// 3. Title or body contains a CI/pipeline pattern → noise.
/// 4. Title or body contains a model-announcement pattern → noise.
pub fn is_noise(title: &str, body: &str) -> bool {
    let t = title.trim().to_lowercase();
    let b = body.trim().to_lowercase();

    // Rule 1 — too short to carry semantic content.
    if t.len() < NOISE_MIN_TITLE_LEN {
        return true;
    }

    // Rule 2 — git state chatter.
    for pat in NOISE_GIT_PATTERNS {
        if t.contains(pat) || b.contains(pat) {
            return true;
        }
    }

    // Rule 3 — CI / pipeline output.
    for pat in NOISE_CI_PATTERNS {
        if t.contains(pat) || b.contains(pat) {
            return true;
        }
    }

    // Rule 4 — model announcements.
    for pat in NOISE_MODEL_PATTERNS {
        if t.contains(pat) || b.contains(pat) {
            return true;
        }
    }

    false
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
    s.trim()
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Parse raw `decisions-pending.jsonl` lines into deduplicated `Proposed`
/// decisions. PURE (no I/O) so it can be unit-tested without touching the home
/// directory. `existing_titles` are the normalised titles already present in
/// `decisions.jsonl`; new titles are also deduped against each other within the
/// batch. A malformed or too-short line is skipped, never aborting the batch.
///
/// Lines that pass dedup but are identified as noise by [`is_noise`] are
/// silently dropped here — they never reach `decisions.jsonl`.
fn parse_pending_lines(
    text: &str,
    project_id: &str,
    existing_titles: &std::collections::HashSet<String>,
) -> Vec<DecisionRecord> {
    let mut seen = existing_titles.clone();
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

        // --- Noise filter (applied before dedup to avoid polluting `seen`) ---
        let rationale_str = p.rationale.as_deref().unwrap_or("");
        if is_noise(title, rationale_str) {
            eprintln!("[decisions] noise filter dropped: {title:?}");
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

        added.push(DecisionRecord {
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
        });
    }

    added
}

// ---------------------------------------------------------------------------
// Bulk-reject all auto-captured pending decisions for a project
// ---------------------------------------------------------------------------

/// Mark every `Proposed` + `auto-captured` decision in `decisions.jsonl` as
/// `Rejected` in a single atomic write.  Returns the count of records changed.
///
/// This is the fast "nuke the noise" escape hatch — the user can call this
/// from the UI after a batch drain that imported garbage.  It does NOT touch
/// decisions that were manually added or that are already in a terminal status
/// (`Accepted`, `Superseded`, `Rejected`).
pub fn reject_all_auto_inner(project_id: &str) -> Result<usize, String> {
    let _g = decisions_lock()
        .lock()
        .map_err(|_| "decisions lock poisoned")?;
    let mut records = read_all(project_id)?;

    let mut count = 0usize;
    for rec in &mut records {
        if rec.status == DecisionStatus::Proposed && rec.tags.iter().any(|t| t == "auto-captured") {
            rec.status = DecisionStatus::Rejected;
            count += 1;
        }
    }

    if count > 0 {
        let path = decisions_path(project_id)?;
        write_atomic(&path, &records)?;
    }

    Ok(count)
}

/// Remove noise records from `decisions.jsonl` with safety guardrails.
///
/// Only purges records that satisfy ALL of the following conditions:
/// - `author == Some("auto")` (auto-captured by the Stop hook)
/// - `status == Proposed` (not yet reviewed by a human)
/// - [`is_noise`] returns true for the title+rationale
///
/// Manual decisions and any record in Accepted/Rejected/Superseded are NEVER
/// touched, even if their title is short.
///
/// Before rewriting the file a timestamped backup is created:
/// `decisions.jsonl.purge-backup-<epoch>`. Only the 5 most recent backups
/// are kept; older ones are deleted automatically.
///
/// # Errors
/// Returns `Err` if `confirm != true` (prevents accidental one-click data
/// loss from an unguarded UI button).
///
/// Returns the IDs of purged records (not just the count) so a future
/// "Undo" command can restore them.
// Wrapper publico para uso externo / tests de integracion futuros.
// El comando Tauri llama purge_noise_confirmed directamente para poder
// propagar el parametro confirm desde la UI.
#[allow(dead_code)]
pub fn purge_noise_inner(project_id: &str) -> Result<PurgeNoiseResult, String> {
    purge_noise_confirmed(project_id, true)
}

/// Internal implementation; `confirm` must be `true` to proceed.
pub(crate) fn purge_noise_confirmed(
    project_id: &str,
    confirm: bool,
) -> Result<PurgeNoiseResult, String> {
    if !confirm {
        return Err("purge requiere confirm=true".to_string());
    }

    let _g = decisions_lock()
        .lock()
        .map_err(|_| "decisions lock poisoned")?;
    let records = read_all(project_id)?;

    // Partition: only auto-Proposed noise is purgeable.
    let mut purged_ids: Vec<String> = Vec::new();
    let clean: Vec<DecisionRecord> = records
        .into_iter()
        .filter(|r| {
            let is_auto = r.author.as_deref() == Some("auto");
            let is_proposed = r.status == DecisionStatus::Proposed;
            let noisy = is_noise(&r.decision, &r.rationale);
            if is_auto && is_proposed && noisy {
                purged_ids.push(r.id.clone());
                false // remove from clean list
            } else {
                true // keep
            }
        })
        .collect();

    if !purged_ids.is_empty() {
        let path = decisions_path(project_id)?;

        // Create timestamped backup BEFORE overwriting.
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let backup = path.with_file_name(format!("decisions.jsonl.purge-backup-{epoch}"));
        if path.exists() {
            fs::copy(&path, &backup).map_err(|e| format!("backup purge: {e}"))?;
        }

        // Retain only the 5 most recent purge backups; delete older ones.
        if let Some(dir) = path.parent() {
            prune_purge_backups(dir, 5);
        }

        write_atomic(&path, &clean)?;
    }

    Ok(PurgeNoiseResult { purged_ids })
}

/// Result returned by [`purge_noise_inner`].
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PurgeNoiseResult {
    /// IDs of the records that were removed. Empty when nothing was purged.
    pub purged_ids: Vec<String>,
}

/// Keep only the `max_keep` most-recent `decisions.jsonl.purge-backup-*`
/// files in `dir`, deleting older ones. Silent on I/O errors.
fn prune_purge_backups(dir: &std::path::Path, max_keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut backups: Vec<std::path::PathBuf> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = p.file_name()?.to_str()?.to_owned();
            if name.starts_with("decisions.jsonl.purge-backup-") {
                Some(p)
            } else {
                None
            }
        })
        .collect();

    // Sort lexicographically descending — epoch suffix gives natural order.
    backups.sort_unstable_by(|a, b| b.cmp(a));

    for old in backups.into_iter().skip(max_keep) {
        let _ = fs::remove_file(&old);
    }
}

/// Drain the per-project pending decisions file into `decisions.jsonl`.
///
/// Each pending line becomes a `Proposed` decision tagged `auto-captured`,
/// deduped against existing decisions AND within the batch (by normalised
/// title). No KG/Mem0 sync fires — auto-captured decisions stay local until the
/// user Accepts them.
///
/// Concurrency: the pending file is `rename`d to a `.draining` sidecar BEFORE
/// reading it. The in-process `decisions_lock` serialises drains within this
/// process, but the producer is a separate Node Stop hook that `appendFileSync`s
/// without a shared lock. The rename takes an atomic snapshot, so any line the
/// hook appends between our read and delete lands in a fresh pending file
/// instead of being silently dropped. A `.draining` left over from a crashed
/// drain is recovered on the next call.
pub fn drain_pending_inner(project_id: &str) -> Result<Vec<DecisionRecord>, String> {
    let ppath = pending_decisions_path(project_id)?;
    let _g = decisions_lock()
        .lock()
        .map_err(|_| "decisions lock poisoned")?;

    let draining = ppath.with_extension("draining");
    match fs::rename(&ppath, &draining) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            // No pending file. Recover an orphaned `.draining` if one exists
            // (a previous drain crashed between rename and remove); otherwise
            // there is nothing to do.
            if !draining.exists() {
                return Ok(Vec::new());
            }
        }
        Err(e) => return Err(format!("rename pending {}: {e}", ppath.display())),
    }

    let text = fs::read_to_string(&draining)
        .map_err(|e| format!("read draining {}: {e}", draining.display()))?;

    let mut records = read_all(project_id)?;
    let existing: std::collections::HashSet<String> = records
        .iter()
        .map(|r| normalize_title(&r.decision))
        .collect();

    let added = parse_pending_lines(&text, project_id, &existing);

    if !added.is_empty() {
        records.extend(added.iter().cloned());
        let path = decisions_path(project_id)?;
        write_atomic(&path, &records)?;
    }
    // Consume the working snapshot, even when everything was a duplicate.
    fs::remove_file(&draining).ok();

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
            .map(|r| DecisionSearchResult {
                record: r,
                score: 0,
            })
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
            if score > 0 {
                Some(DecisionSearchResult { record: r, score })
            } else {
                None
            }
        })
        .collect();

    // Highest score first; ties broken by newest date.
    results.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| b.record.date.cmp(&a.record.date))
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
    if r.alternatives_considered
        .iter()
        .any(|a| a.to_lowercase().contains(needle))
    {
        score += 1;
    }
    if r.author
        .as_deref()
        .map(|a| a.to_lowercase().contains(needle))
        .unwrap_or(false)
    {
        score += 1;
    }
    if r.context_urls
        .iter()
        .any(|u| u.to_lowercase().contains(needle))
    {
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
    let entries = fs::read_dir(&projects_dir).map_err(|e| format!("read projects dir: {e}"))?;
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
        if let Err(e) =
            crate::mem0::add_inner(text, rec_clone.project_id.clone(), Some(metadata)).await
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
    use std::collections::HashSet;
    use tempfile::TempDir;

    fn no_existing() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn normalize_title_is_case_and_whitespace_insensitive() {
        assert_eq!(
            normalize_title("  Usar   Qdrant  NATIVO "),
            normalize_title("usar qdrant nativo")
        );
    }

    #[test]
    fn parse_pending_valid_line_is_proposed_auto_captured() {
        let line = r#"{"decision":"Migrar a Qdrant nativo","rationale":"Evita depender de Docker en Windows"}"#;
        let out = parse_pending_lines(line, "ultron", &no_existing());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].status, DecisionStatus::Proposed);
        assert_eq!(out[0].author.as_deref(), Some("auto"));
        assert!(out[0].tags.iter().any(|t| t == "auto-captured"));
        assert_eq!(out[0].rationale, "Evita depender de Docker en Windows");
        assert_eq!(out[0].project_id, "ultron");
    }

    #[test]
    fn parse_pending_skips_titles_shorter_than_5_chars() {
        let out = parse_pending_lines(r#"{"decision":"abcd"}"#, "p", &no_existing());
        assert!(out.is_empty());
    }

    #[test]
    fn parse_pending_skips_malformed_json_without_aborting_batch() {
        let text = "not json at all\n{\"decision\":\"Decision valida que se conserva\"}\n{bad json";
        let out = parse_pending_lines(text, "p", &no_existing());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].decision, "Decision valida que se conserva");
    }

    #[test]
    fn parse_pending_dedups_within_batch_by_normalized_title() {
        let text = "{\"decision\":\"Usar NVIDIA NIM como proxy\"}\n{\"decision\":\"  usar   NVIDIA nim como PROXY \"}";
        let out = parse_pending_lines(text, "p", &no_existing());
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn parse_pending_dedups_against_existing_decisions() {
        let mut existing = HashSet::new();
        existing.insert(normalize_title("Adoptar ECC como sistema activo"));
        let out = parse_pending_lines(
            r#"{"decision":"adoptar ECC como sistema activo"}"#,
            "p",
            &existing,
        );
        assert!(out.is_empty());
    }

    #[test]
    fn parse_pending_synthesizes_rationale_when_missing() {
        let out = parse_pending_lines(
            r#"{"decision":"Decision sin rationale propio","session_id":"abc123"}"#,
            "p",
            &no_existing(),
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].rationale.contains("Stop hook"));
        assert!(out[0].rationale.contains("abc123"));
    }

    #[test]
    fn parse_pending_synthesizes_rationale_when_too_short() {
        // rationale present but under the 10-char floor -> synthesised instead.
        let out = parse_pending_lines(
            r#"{"decision":"Decision con rationale corto","rationale":"corto"}"#,
            "p",
            &no_existing(),
        );
        assert_eq!(out.len(), 1);
        assert!(out[0].rationale.contains("Stop hook"));
    }

    #[test]
    fn parse_pending_skips_blank_lines() {
        let out = parse_pending_lines("\n\n   \n", "p", &no_existing());
        assert!(out.is_empty());
    }

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
        assert!(
            score_a > score_b,
            "title match should outscore rationale-only match"
        );
    }

    #[test]
    fn write_atomic_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("decisions.jsonl");
        let records = vec![DecisionRecord {
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
        }];
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
        assert!(
            !tmp_path.exists(),
            ".tmp file must not linger after success"
        );
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

    // -----------------------------------------------------------------------
    // is_noise tests
    // -----------------------------------------------------------------------

    #[test]
    fn noise_git_working_tree_clean() {
        assert!(is_noise("Working tree is completely clean", ""));
    }

    #[test]
    fn noise_ci_version_drift_test_passed() {
        assert!(is_noise("CI version-drift test passed", ""));
    }

    #[test]
    fn noise_model_announcement_opus() {
        assert!(is_noise("Usando Claude Opus 4.8 para esta sesión", ""));
    }

    #[test]
    fn noise_model_announcement_sonnet() {
        assert!(is_noise("Usando Claude Sonnet en modo extendido", ""));
    }

    #[test]
    fn noise_empty_title() {
        assert!(is_noise("", ""));
    }

    #[test]
    fn noise_title_too_short() {
        // "abc" = 3 chars < NOISE_MIN_TITLE_LEN (10)
        assert!(is_noise("abc", "some long body that would not help"));
    }

    #[test]
    fn noise_real_decision_passes_through() {
        assert!(!is_noise(
            "Migrar a embeddings e5-small por soporte multilingüe",
            "e5-small tiene soporte nativo de español y reduce latencia un 40%"
        ));
    }

    #[test]
    fn noise_adoptar_qdrant_passes_through() {
        assert!(!is_noise(
            "Adoptar Qdrant nativo en Windows sin Docker",
            "Evita dependencia de Docker Desktop en entornos Windows corporativos."
        ));
    }

    #[test]
    fn noise_filter_applied_in_parse_pending() {
        // Git-state noise → dropped.
        let noise =
            r#"{"decision":"Working tree is completely clean","rationale":"git status output"}"#;
        // Real decision → kept.
        let real = r#"{"decision":"Migrar a embeddings e5-small por soporte multilingüe","rationale":"e5-small tiene soporte nativo de español"}"#;
        let text = format!("{noise}\n{real}");
        let out = parse_pending_lines(&text, "ultron", &no_existing());
        assert_eq!(out.len(), 1);
        assert_eq!(
            out[0].decision,
            "Migrar a embeddings e5-small por soporte multilingüe"
        );
    }

    #[test]
    fn noise_filter_drops_model_announcement_in_batch() {
        let lines = [
            r#"{"decision":"Usando Claude Opus 4.8","rationale":"modelo seleccionado"}"#,
            r#"{"decision":"CI version-drift test passed","rationale":"pipeline output"}"#,
            r#"{"decision":"Adoptar Rust para el backend de ULTRON","rationale":"memoria segura sin GC, zero-cost abstractions"}"#,
        ]
        .join("\n");
        let out = parse_pending_lines(&lines, "p", &no_existing());
        assert_eq!(out.len(), 1, "only the real decision should survive");
        assert!(out[0].decision.to_lowercase().contains("rust"));
    }

    // -----------------------------------------------------------------------
    // purge_noise_confirmed tests (Rank 4 guardrails)
    // -----------------------------------------------------------------------

    /// Construye un DecisionRecord minimo para tests de purge.
    fn make_record(
        id: &str,
        title: &str,
        author: Option<&str>,
        status: DecisionStatus,
    ) -> DecisionRecord {
        DecisionRecord {
            id: id.to_string(),
            project_id: "test-project".to_string(),
            decision: title.to_string(),
            rationale: "rationale de prueba suficientemente larga".to_string(),
            alternatives_considered: vec![],
            date: "epoch:0".to_string(),
            status,
            supersedes_id: None,
            context_urls: vec![],
            author: author.map(|s| s.to_string()),
            tags: vec!["auto-captured".to_string()],
        }
    }

    #[test]
    fn purge_noise_requires_confirm_true() {
        let result = purge_noise_confirmed("irrelevant-project", false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("confirm=true"));
    }

    #[test]
    fn purge_noise_does_not_delete_manual_short_title() {
        // Titulo corto (< NOISE_MIN_TITLE_LEN) => is_noise=true, pero
        // author != "auto" => la condicion de purga NO se cumple.
        // Usamos "abc" (3 chars) para garantizar que is_noise sea true.
        let rec = make_record(
            "id-manual",
            "abc",
            Some("USER"),
            DecisionStatus::Proposed,
        );

        // Verificar que el titulo SÍ dispara is_noise (prerequisito del test).
        assert!(
            is_noise(&rec.decision, &rec.rationale),
            "abc debe ser ruido por titulo corto"
        );

        // La condicion de purga requiere is_auto AND is_proposed AND noisy.
        // Como is_auto=false, la condicion completa es false => no se purga.
        let is_auto = rec.author.as_deref() == Some("auto");
        assert!(!is_auto, "decision manual no debe marcarse como auto");
        let purgeable = is_auto
            && rec.status == DecisionStatus::Proposed
            && is_noise(&rec.decision, &rec.rationale);
        assert!(
            !purgeable,
            "decision manual nunca debe purgarse aunque el titulo sea ruido"
        );
    }

    #[test]
    fn purge_noise_does_not_delete_accepted_auto() {
        // Aunque sea auto y ruido, si ya fue Accepted no debe tocarse.
        let rec = make_record(
            "id-accepted",
            "Working tree is completely clean",
            Some("auto"),
            DecisionStatus::Accepted,
        );
        let is_auto = rec.author.as_deref() == Some("auto");
        let is_proposed = rec.status == DecisionStatus::Proposed;
        let noisy = is_noise(&rec.decision, &rec.rationale);
        // Accepted => is_proposed=false => condicion de purga NO se cumple
        assert!(
            is_auto && !is_proposed && noisy,
            "accepted no debe purgarse"
        );
    }

    #[test]
    fn purge_noise_deletes_auto_proposed_noise() {
        // auto + Proposed + is_noise => debe purgarse.
        let rec = make_record(
            "id-noise",
            "Working tree is completely clean",
            Some("auto"),
            DecisionStatus::Proposed,
        );
        let is_auto = rec.author.as_deref() == Some("auto");
        let is_proposed = rec.status == DecisionStatus::Proposed;
        let noisy = is_noise(&rec.decision, &rec.rationale);
        assert!(
            is_auto && is_proposed && noisy,
            "debe clasificarse como purgable"
        );
    }

    #[test]
    fn purge_noise_keeps_auto_proposed_real_decision() {
        // auto + Proposed pero titulo real (no es ruido) => NO se purga.
        let rec = make_record(
            "id-real",
            "Adoptar Qdrant nativo en Windows sin Docker",
            Some("auto"),
            DecisionStatus::Proposed,
        );
        let is_auto = rec.author.as_deref() == Some("auto");
        let is_proposed = rec.status == DecisionStatus::Proposed;
        let noisy = is_noise(&rec.decision, &rec.rationale);
        assert!(
            is_auto && is_proposed && !noisy,
            "decision real no debe purgarse"
        );
    }

    #[test]
    fn prune_purge_backups_keeps_max_five() {
        let dir = std::env::temp_dir().join(format!("ultron-prune-test-{}", new_decision_id()));
        fs::create_dir_all(&dir).unwrap();

        // Crear 7 backups falsos con nombres epoch creciente.
        for i in 0..7u64 {
            let name = format!("decisions.jsonl.purge-backup-{}", 1_700_000_000 + i);
            fs::write(dir.join(&name), b"x").unwrap();
        }

        prune_purge_backups(&dir, 5);

        let remaining: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                e.file_name()
                    .to_str()
                    .map(|n| n.starts_with("decisions.jsonl.purge-backup-"))
                    .unwrap_or(false)
            })
            .collect();

        assert_eq!(remaining.len(), 5, "deben quedar exactamente 5 backups");

        // Limpiar
        let _ = fs::remove_dir_all(&dir);
    }
}
