// ULTRON Control Center — One-shot ETL into the canonical store (Fase A3)
//
// Migrates the live, scattered memory substrates into `memory_items`:
//   - Qdrant `ultron_sessions` (62 pts) -> active items (per-point idempotent)
//   - kg.jsonl entities                 -> active items (codebase_fact/architecture/decision)
//   - decisions.jsonl (unreviewed)      -> CANDIDATES (pending) — never auto-active
//   - ~/.ultron-vault distilled tuples  -> active items (decision/pattern/seed)
//
// Safety: backs up brain.db before running; every source is idempotent; reads
// are tolerant (a bad row is counted as an error, not a batch abort). The whole
// run is read-only against the source substrates — nothing is deleted.

use serde::Serialize;

use super::model::{
    estimate_tokens, MemoryItem, MemoryType, Scope, Source, Status,
};
use super::service::MemoryService;
use super::sqlite_store as store;
use super::MemoryError;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Default)]
pub struct SourceReport {
    pub imported: i64,
    pub skipped_existing: i64,
    pub skipped_noise: i64,
    pub skipped_stub: i64,
    pub errors: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MigrationReport {
    pub backup_path: Option<String>,
    pub sessions: SourceReport,
    pub kg: SourceReport,
    pub decisions_candidates: SourceReport,
    pub vault: SourceReport,
}

// ---------------------------------------------------------------------------
// Pure mappers (unit-testable)
// ---------------------------------------------------------------------------

/// Map the free-string `kind` of `ultron_sessions` to a canonical `MemoryType`.
fn map_session_kind(kind: &str) -> MemoryType {
    match kind {
        "decision" => MemoryType::Decision,
        "bug" => MemoryType::ErrorResolution,
        "todo" => MemoryType::Task,
        "file" => MemoryType::CodebaseFact,
        // "feature" and anything unknown -> Fact
        _ => MemoryType::Fact,
    }
}

/// Normalise the hook's `project` (basename(cwd)) into a project_id: strips the
/// leading '.' so ".ultron" -> "ultron". Empty -> None.
fn normalize_project(p: &str) -> Option<String> {
    let p = p.trim();
    if p.is_empty() {
        return None;
    }
    Some(p.trim_start_matches('.').to_string())
}

/// Parse an ISO `YYYY-MM-DD` date into Unix milliseconds (midnight UTC).
/// Version-robust: avoids NaiveDateTime/timezone APIs by diffing against epoch.
fn date_to_millis(date: &str) -> Option<i64> {
    let d = chrono::NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d").ok()?;
    let epoch = chrono::NaiveDate::from_ymd_opt(1970, 1, 1)?;
    Some(d.signed_duration_since(epoch).num_milliseconds())
}

// ---------------------------------------------------------------------------
// Per-source ETL
// ---------------------------------------------------------------------------

/// Qdrant `ultron_sessions` -> active session memories. Per-point idempotent via
/// `qdrant_point_id`; skips zero-vector stubs.
pub fn etl_sessions(report: &mut SourceReport) -> Result<(), MemoryError> {
    let conn = store::open_conn()?;
    let points = match crate::qdrant::scroll("ultron_sessions", 10_000) {
        Ok(p) => p,
        Err(e) => {
            report.note = format!("qdrant scroll failed: {e}");
            report.errors += 1;
            return Ok(());
        }
    };
    for p in points {
        let pl = &p.payload;
        if pl
            .get("embed_stub")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            report.skipped_stub += 1;
            continue;
        }
        if store::item_exists_by_qdrant_id(&conn, &p.id) {
            report.skipped_existing += 1;
            continue;
        }
        let text = pl
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if text.is_empty() {
            report.errors += 1;
            continue;
        }
        let kind = pl.get("kind").and_then(|v| v.as_str()).unwrap_or("fact");
        let importance = pl
            .get("importance")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.5) as f32;
        let used_ai = pl
            .get("used_ai")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true);
        let project = pl.get("project").and_then(|v| v.as_str()).unwrap_or("");
        let date = pl.get("date").and_then(|v| v.as_str()).unwrap_or("");

        let mut item = MemoryItem::new(
            map_session_kind(kind),
            Scope::Project,
            Source::ImportedSessions,
            Status::Active,
        );
        item.summary = Some(text.clone());
        item.content = Some(text);
        item.importance = importance.clamp(0.0, 1.0);
        item.project_id = normalize_project(project);
        item.source_session_id = pl
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        item.qdrant_point_id = Some(p.id.clone());
        if let Some(ms) = date_to_millis(date) {
            item.created_at = ms;
            item.updated_at = ms;
        }
        item.tags = vec!["imported_sessions".to_string()];
        if !used_ai {
            item.tags.push("heuristic".to_string());
        }
        item.token_estimate = estimate_tokens(&item.searchable_text());

        match MemoryService::add_imported(&item) {
            Ok(()) => report.imported += 1,
            Err(_) => report.errors += 1,
        }
    }
    Ok(())
}

/// kg.jsonl entities -> active items. Source-level idempotent.
pub fn etl_kg(report: &mut SourceReport) -> Result<(), MemoryError> {
    let conn = store::open_conn()?;
    if store::count_by_source(&conn, Source::ImportedKg) > 0 {
        report.note = "already imported (skipped)".to_string();
        return Ok(());
    }
    let graph = crate::kg::read_graph_inner()
        .map_err(|e| MemoryError::ParseError(format!("kg read: {e}")))?;
    for ent in &graph.entities {
        let kind = match ent.entity_type.as_str() {
            "decision" => MemoryType::Decision,
            "architecture" => MemoryType::Architecture,
            "system" | "subsystem" => MemoryType::CodebaseFact,
            _ => MemoryType::Fact,
        };
        let body = if ent.observations.is_empty() {
            ent.name.clone()
        } else {
            format!("{}: {}", ent.name, ent.observations.join("; "))
        };
        let mut item = MemoryItem::new(kind, Scope::Project, Source::ImportedKg, Status::Active);
        item.title = Some(ent.name.clone());
        item.summary = Some(body.clone());
        item.content = Some(body);
        item.project_id = Some("ultron".to_string());
        item.tags = vec!["imported_kg".to_string(), ent.entity_type.clone()];
        item.token_estimate = estimate_tokens(&item.searchable_text());
        match MemoryService::add_imported(&item) {
            Ok(()) => report.imported += 1,
            Err(_) => report.errors += 1,
        }
    }
    Ok(())
}

/// decisions.jsonl ETL — módulo decisions eliminado (KIRKARDO 24), no-op.
pub fn etl_decisions(_report: &mut SourceReport) -> Result<(), MemoryError> {
    Ok(())
}

/// ~/.ultron-vault distilled tuples -> active items (decision/pattern/seed).
/// The distilled jsonl is the cleanest, pre-extracted vault source. Source-level
/// idempotent. (Richer .md prose import is a follow-up refinement.)
pub fn etl_vault(report: &mut SourceReport) -> Result<(), MemoryError> {
    let conn = store::open_conn()?;
    if store::count_by_source(&conn, Source::ImportedVault) > 0 {
        report.note = "already imported (skipped)".to_string();
        return Ok(());
    }
    let Some(home) = dirs::home_dir() else {
        report.note = "no HOME dir".to_string();
        return Ok(());
    };
    let distilled = home
        .join(".ultron-vault")
        .join("50_SESSIONS_LOG")
        .join("distilled");
    if !distilled.exists() {
        report.note = format!("vault distilled dir not found: {}", distilled.display());
        return Ok(());
    }
    let entries = match std::fs::read_dir(&distilled) {
        Ok(e) => e,
        Err(e) => {
            report.note = format!("read_dir: {e}");
            report.errors += 1;
            return Ok(());
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                report.errors += 1;
                continue;
            }
        };
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => {
                    report.errors += 1;
                    continue;
                }
            };
            let action = v.get("action").and_then(|a| a.as_str()).unwrap_or("");
            let kind = match action {
                "decision" => MemoryType::Decision,
                "pattern" => MemoryType::Fact,
                "seed" => MemoryType::Task,
                // "compacted" and other meta rows are not memories.
                _ => {
                    report.skipped_noise += 1;
                    continue;
                }
            };
            let target = v
                .get("target")
                .and_then(|t| t.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if target.is_empty() {
                continue;
            }
            let domain = v
                .get("domain")
                .and_then(|d| d.as_str())
                .unwrap_or("general")
                .to_string();
            let mut item =
                MemoryItem::new(kind, Scope::Global, Source::ImportedVault, Status::Active);
            item.summary = Some(target.clone());
            item.content = Some(target);
            item.source_session_id = v.get("sid").and_then(|s| s.as_str()).map(str::to_string);
            item.tags = vec!["imported_vault".to_string(), domain];
            if let Some(ms) = v
                .get("ts")
                .and_then(|t| t.as_str())
                .and_then(date_to_millis)
            {
                item.created_at = ms;
                item.updated_at = ms;
            }
            item.token_estimate = estimate_tokens(&item.searchable_text());
            match MemoryService::add_imported(&item) {
                Ok(()) => report.imported += 1,
                Err(_) => report.errors += 1,
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/// Copy brain.db to a timestamped backup before mutating. Returns its path.
fn backup_brain_db() -> Option<String> {
    let home = dirs::home_dir()?;
    let src = home.join(".ultron").join("brain.db");
    if !src.exists() {
        return None;
    }
    let dst = home
        .join(".ultron")
        .join(format!("brain.db.bak-{}", super::model::now_millis()));
    std::fs::copy(&src, &dst)
        .ok()
        .map(|_| dst.display().to_string())
}

/// Run the full one-shot migration (backup + all sources). Idempotent.
pub fn run_full_etl() -> MigrationReport {
    let mut report = MigrationReport {
        backup_path: backup_brain_db(),
        ..Default::default()
    };
    let _ = etl_sessions(&mut report.sessions);
    let _ = etl_kg(&mut report.kg);
    let _ = etl_decisions(&mut report.decisions_candidates);
    let _ = etl_vault(&mut report.vault);
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_kind_maps_to_canonical_types() {
        assert_eq!(map_session_kind("decision"), MemoryType::Decision);
        assert_eq!(map_session_kind("bug"), MemoryType::ErrorResolution);
        assert_eq!(map_session_kind("todo"), MemoryType::Task);
        assert_eq!(map_session_kind("file"), MemoryType::CodebaseFact);
        assert_eq!(map_session_kind("feature"), MemoryType::Fact);
        assert_eq!(map_session_kind("weird"), MemoryType::Fact);
    }

    #[test]
    fn project_basename_is_normalised() {
        assert_eq!(normalize_project(".ultron").as_deref(), Some("ultron"));
        assert_eq!(
            normalize_project("control-center").as_deref(),
            Some("control-center")
        );
        assert_eq!(normalize_project("  "), None);
    }

    #[test]
    fn iso_date_parses_to_midnight_utc_millis() {
        // 1970-01-02 = 86_400_000 ms after epoch.
        assert_eq!(date_to_millis("1970-01-02"), Some(86_400_000));
        assert_eq!(date_to_millis("2026-06-01"), Some(1_780_272_000_000));
        assert_eq!(date_to_millis("not-a-date"), None);
    }
}
