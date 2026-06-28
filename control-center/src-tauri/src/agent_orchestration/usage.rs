// agent_orchestration/usage.rs — subagent harvest aggregation (casilla 2.1).
//
// Reads ~/.ultron/.tmp/subagent-harvest.jsonl (or $SUBAGENT_HARVEST_LOG) and
// aggregates per-agent usage stats.  Ports scripts/agent-usage.mjs lines 34-47
// and 57 faithfully; the JS is the authoritative spec.
//
// Public surface:
//   - AgentUsage / LabelCount — serde(camelCase) structs consumed by the TS frontend.
//   - aggregate_agent_usage(project) — pure aggregation (resolves path, testable).
//   - agent_usage_stats — #[tauri::command] thin wrapper.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Public structs (contract — do NOT rename without updating TS side)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    pub agent: String,
    pub count: u64,
    pub chars: u64,
    pub last_ts: String,
    pub top_labels: Vec<LabelCount>,
}

#[derive(serde::Serialize)]
pub struct LabelCount {
    pub label: String,
    pub n: u64,
}

// ---------------------------------------------------------------------------
// Internal harvest row schema
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct HarvestRow {
    ts: Option<String>,
    project: Option<String>,
    agent: Option<String>,
    #[serde(default)]
    chars: Option<u64>,
    label: Option<String>,
}

// ---------------------------------------------------------------------------
// Path resolution — mirrors agent-usage.mjs lines 24-25
// ---------------------------------------------------------------------------

fn harvest_path() -> Option<PathBuf> {
    // env override wins (same as the JS script)
    if let Ok(p) = std::env::var("SUBAGENT_HARVEST_LOG") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| {
        h.join(".ultron")
            .join(".tmp")
            .join("subagent-harvest.jsonl")
    })
}

// ---------------------------------------------------------------------------
// Pure aggregation — separated so tests can supply an explicit path
// ---------------------------------------------------------------------------

fn aggregate_from_path(path: &Path, project: Option<&str>) -> Result<Vec<AgentUsage>, String> {
    // Missing file -> Ok(empty) per contract (absence of harvest = no data)
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;

    // Parse JSONL — tolerant to bad lines (same as mjs load())
    let rows: Vec<HarvestRow> = text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();

    // Filter by project if requested (mjs line 35)
    let filtered: Vec<&HarvestRow> = if let Some(proj) = project {
        rows.iter()
            .filter(|r| r.project.as_deref() == Some(proj))
            .collect()
    } else {
        rows.iter().collect()
    };

    // Aggregate per agent (mjs lines 38-46)
    struct Accum {
        count: u64,
        chars: u64,
        last: String,
        labels: HashMap<String, u64>,
    }

    let mut by_agent: HashMap<String, Accum> = HashMap::new();
    for r in filtered {
        // empty string also falls back to "unknown" (mjs: `r.agent || "unknown"`)
        let key = r
            .agent
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("unknown")
            .to_string();
        let entry = by_agent.entry(key).or_insert_with(|| Accum {
            count: 0,
            chars: 0,
            last: String::new(),
            labels: HashMap::new(),
        });
        entry.count += 1;
        entry.chars += r.chars.unwrap_or(0); // null/missing -> 0 (mjs: `r.chars || 0`)
        let ts = r.ts.as_deref().unwrap_or("");
        // lexicographic ISO8601 comparison is correct for timestamps
        if ts > entry.last.as_str() {
            entry.last = ts.to_string();
        }
        if let Some(lbl) = &r.label {
            *entry.labels.entry(lbl.clone()).or_insert(0) += 1;
        }
    }

    // Build result; compute top_labels (mjs line 57: top 5 desc by frequency)
    let mut agents: Vec<AgentUsage> = by_agent
        .into_iter()
        .map(|(agent, acc)| {
            let mut pairs: Vec<(String, u64)> = acc.labels.into_iter().collect();
            pairs.sort_by(|a, b| b.1.cmp(&a.1));
            pairs.truncate(5);
            let top_labels = pairs
                .into_iter()
                .map(|(label, n)| LabelCount { label, n })
                .collect();
            AgentUsage {
                agent,
                count: acc.count,
                chars: acc.chars,
                last_ts: acc.last,
                top_labels,
            }
        })
        .collect();

    // Sort DESC by count (mjs line 47)
    agents.sort_by(|a, b| b.count.cmp(&a.count));
    Ok(agents)
}

// ---------------------------------------------------------------------------
// Public wrapper — resolves path and delegates to pure inner
// ---------------------------------------------------------------------------

pub fn aggregate_agent_usage(project: Option<&str>) -> Result<Vec<AgentUsage>, String> {
    match harvest_path() {
        Some(path) => aggregate_from_path(&path, project),
        None => Ok(Vec::new()),
    }
}

// ---------------------------------------------------------------------------
// Tauri command — sync (file I/O is fast; 1-2 ms for typical harvest sizes)
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_usage_stats(project: Option<String>) -> Result<Vec<AgentUsage>, String> {
    aggregate_agent_usage(project.as_deref())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use tempfile::NamedTempFile;

    // Helper: write lines to a tempfile and return it (kept alive by caller).
    fn make_harvest(lines: &[&str]) -> NamedTempFile {
        let mut f = NamedTempFile::new().expect("tempfile");
        for line in lines {
            writeln!(f, "{line}").expect("write");
        }
        f
    }

    #[test]
    fn test_missing_harvest_returns_empty() {
        // Case: path does not exist -> Ok(vec![]).
        // Use a fresh tempdir child so the path is guaranteed absent and the
        // test stays hermetic on Windows (a bare "/nonexistent/..." would
        // resolve against the current drive root, not a guaranteed-missing path).
        let dir = tempfile::tempdir().expect("tempdir");
        let nonexistent = dir.path().join("does_not_exist.jsonl");
        let result = aggregate_from_path(&nonexistent, None);
        assert!(result.is_ok(), "should be Ok even when file is missing");
        assert_eq!(result.unwrap().len(), 0);
    }

    #[test]
    fn test_aggregate_counts_chars_and_last_ts() {
        let harvest = make_harvest(&[
            r#"{"ts":"2026-06-07T10:00:00.000Z","project":"ultron","agent":"code-reviewer","chars":100,"preview":"x"}"#,
            r#"{"ts":"2026-06-07T11:00:00.000Z","project":"ultron","agent":"code-reviewer","chars":200,"preview":"y","label":"review"}"#,
            r#"{"ts":"2026-06-07T09:00:00.000Z","project":"ultron","agent":"debugger","chars":50,"preview":"z"}"#,
        ]);

        let agents = aggregate_from_path(harvest.path(), None).expect("aggregate");

        // Sorted DESC by count: code-reviewer(2) before debugger(1)
        assert_eq!(agents.len(), 2);
        let cr = &agents[0];
        assert_eq!(cr.agent, "code-reviewer");
        assert_eq!(cr.count, 2);
        assert_eq!(cr.chars, 300);
        assert_eq!(cr.last_ts, "2026-06-07T11:00:00.000Z");
        assert_eq!(cr.top_labels.len(), 1);
        assert_eq!(cr.top_labels[0].label, "review");
        assert_eq!(cr.top_labels[0].n, 1);

        let dbg = &agents[1];
        assert_eq!(dbg.agent, "debugger");
        assert_eq!(dbg.count, 1);
        assert_eq!(dbg.chars, 50);
        assert!(dbg.top_labels.is_empty());
    }

    #[test]
    fn test_project_filter() {
        let harvest = make_harvest(&[
            r#"{"ts":"2026-06-07T10:00:00.000Z","project":"ultron","agent":"code-reviewer","chars":100,"preview":"x"}"#,
            r#"{"ts":"2026-06-07T11:00:00.000Z","project":"other","agent":"debugger","chars":200,"preview":"y"}"#,
        ]);

        let agents = aggregate_from_path(harvest.path(), Some("ultron")).expect("aggregate");
        assert_eq!(
            agents.len(),
            1,
            "only ultron rows should survive the filter"
        );
        assert_eq!(agents[0].agent, "code-reviewer");
        assert_eq!(agents[0].count, 1);
    }

    #[test]
    fn test_corrupt_lines_are_skipped() {
        // Contract: tolerant to bad lines (same as mjs load()). Garbage rows
        // must not kill aggregation of the valid ones (mandamiento 7: negative case).
        let harvest = make_harvest(&[
            r#"{"ts":"2026-06-07T10:00:00.000Z","project":"ultron","agent":"code-reviewer","chars":100,"preview":"x"}"#,
            "not-json",
            "{broken",
            "   ",
            r#"{"ts":"2026-06-07T11:00:00.000Z","project":"ultron","agent":"code-reviewer","chars":200,"preview":"y"}"#,
        ]);

        let agents = aggregate_from_path(harvest.path(), None).expect("aggregate");
        let cr = agents
            .iter()
            .find(|a| a.agent == "code-reviewer")
            .expect("code-reviewer survives the garbage");
        assert_eq!(
            cr.count, 2,
            "both valid rows aggregate despite corrupt lines"
        );
        assert_eq!(cr.chars, 300);
        assert_eq!(cr.last_ts, "2026-06-07T11:00:00.000Z");
    }

    #[test]
    fn test_empty_agent_and_null_chars_match_js_semantics() {
        // Fidelity vs scripts/agent-usage.mjs: `agent:""` is falsy -> "unknown";
        // `chars:null` -> 0 (r.chars || 0) and the row must survive (not be dropped).
        let harvest = make_harvest(&[
            r#"{"ts":"2026-06-07T10:00:00.000Z","project":"ultron","agent":"","chars":50,"preview":"x"}"#,
            r#"{"ts":"2026-06-07T12:00:00.000Z","project":"ultron","agent":null,"chars":null,"preview":"y"}"#,
        ]);

        let agents = aggregate_from_path(harvest.path(), None).expect("aggregate");
        assert_eq!(
            agents.len(),
            1,
            "empty and null agent both bucket under 'unknown'"
        );
        let unknown = &agents[0];
        assert_eq!(unknown.agent, "unknown");
        assert_eq!(unknown.count, 2, "the null-chars row is NOT dropped");
        assert_eq!(unknown.chars, 50, "null chars counts as 0");
        assert_eq!(unknown.last_ts, "2026-06-07T12:00:00.000Z");
    }
}
