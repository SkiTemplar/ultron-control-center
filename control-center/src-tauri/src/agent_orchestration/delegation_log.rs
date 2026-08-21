// agent_orchestration/delegation_log.rs — append-only JSONL delegation log.
//
// Powers the Agents > Runs view (status badges + recent delegations list).
// File location: ~/.ultron/cockpit/delegations.jsonl

use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use super::types::DelegationLogEntry;

pub(super) fn delegations_path() -> Option<PathBuf> {
    Some(
        dirs::home_dir()?
            .join(".ultron")
            .join("cockpit")
            .join("delegations.jsonl"),
    )
}

pub(super) fn now_secs_safe() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(super) fn truncate(s: &str, max: usize) -> String {
    // Strip control characters (incl. \r, \t, vertical-tab) — \n is already
    // collapsed below — so the JSONL line stays grep/jq-friendly even when
    // a task description was pasted from a terminal with weird escapes
    // (KIRKARDO 3 LOW). Spaces survive.
    let cleaned: String = s
        .trim()
        .chars()
        .map(|c| if c == '\n' { ' ' } else { c })
        .filter(|c| !c.is_control() || *c == ' ')
        .collect();
    // Single pass: bound iteration to `max` chars instead of allocating
    // Vec<char> (KIRKARDO 2 MED). The truncated marker '…' only appears
    // when we actually had to cut.
    let mut head = String::with_capacity(max.min(cleaned.len()) + 3);
    let mut truncated = false;
    for (count, ch) in cleaned.chars().enumerate() {
        if count >= max {
            truncated = true;
            break;
        }
        head.push(ch);
    }
    if truncated {
        head.push('…');
    }
    head
}

pub(super) fn log_delegation(entry: DelegationLogEntry) -> Result<(), String> {
    let path = delegations_path().ok_or("no home dir")?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    // KIRKARDO 19 fix: single write_all so two concurrent delegations can't
    // interleave their JSON body with the newline separator and produce a
    // malformed JSONL line on Windows (where O_APPEND atomicity is weaker
    // than POSIX). Avoids the {a}{b}\n\n pattern.
    let mut buf = line.into_bytes();
    buf.push(b'\n');
    f.write_all(&buf).map_err(|e| e.to_string())?;
    Ok(())
}

/// Parse JSONL lines and collapse entries sharing the same id: the LAST
/// occurrence wins (running → done/failed keeps the final state). Returns
/// newest-first, ordering each id by the position of its last occurrence.
fn dedupe_delegation_lines<'a>(lines: impl Iterator<Item = &'a str>) -> Vec<DelegationLogEntry> {
    let mut order: Vec<String> = Vec::new();
    let mut latest: std::collections::HashMap<String, DelegationLogEntry> =
        std::collections::HashMap::new();
    for l in lines.filter(|l| !l.trim().is_empty()) {
        let Ok(e) = serde_json::from_str::<DelegationLogEntry>(l) else {
            continue;
        };
        if let Some(pos) = order.iter().position(|id| id == &e.id) {
            order.remove(pos);
        }
        order.push(e.id.clone());
        latest.insert(e.id.clone(), e);
    }
    order
        .into_iter()
        .rev()
        .filter_map(|id| latest.remove(&id))
        .collect()
}

/// Ceiling in seconds after which a "running" entry with no final append is
/// considered orphaned: 3600 s (max delegation timeout) + margin. If the app
/// dies mid-delegation the final entry never lands, so the row would stay
/// "running" forever without this read-time resolution.
const STALE_RUNNING_SECS: u64 = 3_700;

/// Pure read-time mapping: any "running" entry whose `started_at` is older
/// than `STALE_RUNNING_SECS` relative to `now_epoch` becomes "stale" with an
/// explanatory error. The JSONL on disk is never rewritten. Entries whose
/// `started_at` fails to parse as RFC3339 are left untouched.
fn mark_stale_running(entries: Vec<DelegationLogEntry>, now_epoch: u64) -> Vec<DelegationLogEntry> {
    entries
        .into_iter()
        .map(|mut e| {
            if e.status == "running" {
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(&e.started_at) {
                    let age = (now_epoch as i64).saturating_sub(dt.timestamp());
                    if age > STALE_RUNNING_SECS as i64 {
                        e.status = "stale".to_string();
                        e.error = Some(
                            "la app se cerró con la delegación en curso (o el proceso murió); \
                             sin resultado"
                                .to_string(),
                        );
                    }
                }
            }
            e
        })
        .collect()
}

/// Pure selection step shared by `list_delegations_inner`: optionally keep
/// only entries whose `cwd` matches, THEN cap the result. Filtering before
/// capping is the point — a busy other-project log must not push this
/// project's rows (even running ones) out of the window.
fn select_for_cwd(
    entries: Vec<DelegationLogEntry>,
    cwd: Option<&str>,
    cap: usize,
) -> Vec<DelegationLogEntry> {
    let mut out = entries;
    if let Some(cwd) = cwd {
        out.retain(|e| e.cwd.as_deref() == Some(cwd));
    }
    out.truncate(cap);
    out
}

/// Read up to `limit` of the most recent delegations (newest first). Tolerant
/// to malformed lines — bad records are skipped silently. Returns an empty
/// vec when the file is missing. Returns ONE row per delegation id: the
/// running→final entries appended by the launch path are collapsed into the
/// final state. "running" rows older than `STALE_RUNNING_SECS` (orphaned by an
/// app shutdown mid-delegation) are resolved to "stale" at read time — the
/// JSONL is never rewritten.
///
/// When `cwd` is `Some`, only entries whose `cwd` matches exactly are
/// returned; the filter runs BEFORE the `limit` cap so other projects'
/// activity cannot starve the caller's window. Entries with no `cwd` are
/// excluded by the filter.
pub fn list_delegations_inner(
    limit: usize,
    cwd: Option<&str>,
) -> Result<Vec<DelegationLogEntry>, String> {
    let cap = if limit == 0 || limit > 500 {
        100
    } else {
        limit
    };
    let Some(path) = delegations_path() else {
        return Ok(Vec::new());
    };
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let out = mark_stale_running(dedupe_delegation_lines(text.lines()), now_secs_safe());
    Ok(select_for_cwd(out, cwd, cap))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dedupe_keeps_latest_entry_per_id() {
        let lines = [
            r#"{"id":"dl-1","agent":"debugger","task_preview":"t","cwd":null,"cheap_model_requested":false,"started_at":"2026-08-18T10:00:00Z","status":"running","session_id":null}"#,
            r#"{"id":"dl-1","agent":"debugger","task_preview":"t","cwd":null,"cheap_model_requested":false,"started_at":"2026-08-18T10:01:00Z","status":"done","session_id":"s1"}"#,
            r#"{"id":"dl-2","agent":"qa-expert","task_preview":"u","cwd":null,"cheap_model_requested":false,"started_at":"2026-08-18T10:02:00Z","status":"running","session_id":null}"#,
        ];
        let out = dedupe_delegation_lines(lines.iter().copied());
        assert_eq!(out.len(), 2);
        // Orden: más reciente primero; dl-1 conserva su ÚLTIMA versión (done).
        assert_eq!(out[0].id, "dl-2");
        assert_eq!(out[1].id, "dl-1");
        assert_eq!(out[1].status, "done");
    }

    #[test]
    fn dedupe_repositions_id_on_update_interleaved() {
        // dl-1 se actualiza DESPUÉS de que dl-2 arrancara: su última aparición
        // manda en el orden (rama de reposición de dedupe_delegation_lines).
        let lines = [
            r#"{"id":"dl-1","agent":"debugger","task_preview":"t","cwd":null,"cheap_model_requested":false,"started_at":"2026-08-18T10:00:00Z","status":"running","session_id":null}"#,
            r#"{"id":"dl-2","agent":"qa-expert","task_preview":"u","cwd":null,"cheap_model_requested":false,"started_at":"2026-08-18T10:01:00Z","status":"running","session_id":null}"#,
            r#"{"id":"dl-1","agent":"debugger","task_preview":"t","cwd":null,"cheap_model_requested":false,"started_at":"2026-08-18T10:02:00Z","status":"done","session_id":"s1"}"#,
        ];
        let out = dedupe_delegation_lines(lines.iter().copied());
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "dl-1");
        assert_eq!(out[0].status, "done");
        assert_eq!(out[1].id, "dl-2");
        assert_eq!(out[1].status, "running");
    }

    #[test]
    fn stale_marks_old_running_and_keeps_fresh_running() {
        // Fixture: una "running" de hace 2 horas (huérfana — la app murió) y
        // otra de hace 1 minuto (legítima). `now` se inyecta para hermeticidad.
        let now: u64 = 1_755_500_000;
        let two_hours_ago = now - 7_200;
        let one_min_ago = now - 60;
        let entry = |id: &str, started_epoch: u64| DelegationLogEntry {
            id: id.to_string(),
            agent: "debugger".to_string(),
            task_preview: "t".to_string(),
            cwd: None,
            cheap_model_requested: false,
            started_at: crate::activity_timeline::epoch_secs_to_iso(started_epoch),
            status: "running".to_string(),
            session_id: None,
            error: None,
        };
        let out = mark_stale_running(
            vec![
                entry("dl-old", two_hours_ago),
                entry("dl-fresh", one_min_ago),
            ],
            now,
        );
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "dl-old");
        assert_eq!(out[0].status, "stale");
        assert!(
            out[0].error.as_deref().is_some_and(|e| !e.is_empty()),
            "la entrada stale debe llevar mensaje de error"
        );
        assert_eq!(out[1].id, "dl-fresh");
        assert_eq!(out[1].status, "running");
        assert!(out[1].error.is_none());
    }

    #[test]
    fn stale_leaves_unparseable_started_at_untouched() {
        // Caso negativo (mandamiento 7): started_at corrupto → sin cambios.
        let e = DelegationLogEntry {
            id: "dl-bad".to_string(),
            agent: "debugger".to_string(),
            task_preview: "t".to_string(),
            cwd: None,
            cheap_model_requested: false,
            started_at: "no-es-una-fecha".to_string(),
            status: "running".to_string(),
            session_id: None,
            error: None,
        };
        let out = mark_stale_running(vec![e], 1_755_500_000);
        assert_eq!(out[0].status, "running");
        assert!(out[0].error.is_none());
    }

    /// Fixture builder for the cwd-filter tests: only `id` and `cwd` matter.
    fn entry_with_cwd(id: &str, cwd: Option<&str>) -> DelegationLogEntry {
        DelegationLogEntry {
            id: id.to_string(),
            agent: "debugger".to_string(),
            task_preview: "t".to_string(),
            cwd: cwd.map(str::to_string),
            cheap_model_requested: false,
            started_at: "2026-08-18T10:00:00Z".to_string(),
            status: "done".to_string(),
            session_id: None,
            error: None,
        }
    }

    #[test]
    fn select_for_cwd_filters_before_capping() {
        // 3 entradas de cwd "A" (las más recientes) y 2 de "B". Con
        // Some("B") y limit 1 debe sobrevivir exactamente la más reciente
        // de "B": el filtro va ANTES del cap, o la actividad de "A"
        // expulsaría a "B" de la ventana.
        let entries = vec![
            entry_with_cwd("a-1", Some("A")),
            entry_with_cwd("a-2", Some("A")),
            entry_with_cwd("a-3", Some("A")),
            entry_with_cwd("b-new", Some("B")),
            entry_with_cwd("b-old", Some("B")),
        ];
        let out = select_for_cwd(entries, Some("B"), 1);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "b-new");
    }

    #[test]
    fn select_for_cwd_none_keeps_all_and_filter_drops_null_cwd() {
        // Caso negativo (mandamiento 7): sin filtro se preserva el
        // comportamiento previo (cap global, orden intacto); con filtro,
        // las entradas SIN cwd quedan fuera.
        let entries = vec![
            entry_with_cwd("a-1", Some("A")),
            entry_with_cwd("nil", None),
            entry_with_cwd("b-1", Some("B")),
        ];
        let all = select_for_cwd(entries.clone(), None, 2);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].id, "a-1");
        assert_eq!(all[1].id, "nil");

        let only_b = select_for_cwd(entries, Some("B"), 10);
        assert_eq!(only_b.len(), 1);
        assert_eq!(only_b[0].id, "b-1");
    }

    #[test]
    fn dedupe_tolerates_corrupt_and_blank_lines() {
        // Caso negativo (mandamiento 7): una línea corrupta y una en blanco
        // NO alteran el resultado del fixture limpio.
        let clean = [
            r#"{"id":"dl-1","agent":"debugger","task_preview":"t","cwd":null,"cheap_model_requested":false,"started_at":"2026-08-18T10:00:00Z","status":"running","session_id":null}"#,
            r#"{"id":"dl-2","agent":"qa-expert","task_preview":"u","cwd":null,"cheap_model_requested":false,"started_at":"2026-08-18T10:01:00Z","status":"done","session_id":"s2"}"#,
        ];
        let dirty = [clean[0], "{not json", "", clean[1]];
        let expected = dedupe_delegation_lines(clean.iter().copied());
        let out = dedupe_delegation_lines(dirty.iter().copied());
        assert_eq!(out.len(), expected.len());
        for (a, b) in out.iter().zip(expected.iter()) {
            assert_eq!(a.id, b.id);
            assert_eq!(a.status, b.status);
        }
    }
}
