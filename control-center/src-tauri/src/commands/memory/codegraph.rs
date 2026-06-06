// ULTRON Control Center — Codegraph Tauri commands (Fase 3b)
//
// Exposes the code-graph layer built in Fase 3a (`schema_v4`: `edges` +
// `unresolved_refs` tables) to the frontend through three Tauri commands:
//
//   memory_impact_analysis — callers / callees lookup for a given symbol.
//   memory_graph_metrics   — aggregate counters (total edges, by kind,
//                             unresolved_refs count) for diagnostic UIs.
//   memory_drain_unresolved — drain `unresolved_refs` whose targets are now
//                              known in `memory_items`, promoting them to
//                              `edges` with provenance="drain-unresolved".
//
// All three are thin async wrappers that offload the blocking SQLite I/O
// to `tauri::async_runtime::spawn_blocking` so they do not starve the
// async executor.

use crate::memory::schema_v4::CodeEdge;
use crate::memory::sqlite_store;

// ---------------------------------------------------------------------------
// memory_impact_analysis
// ---------------------------------------------------------------------------

/// Return the code-graph edges for `symbol` in the requested direction.
///
/// # Parameters
///
/// * `symbol`    — fully-qualified symbol name to look up (exact match).
/// * `direction` — `"callers"` (fan-in / impact analysis) or
///                 `"callees"` (fan-out / dependency view) or
///                 `"both"` (union of callers + callees, de-duplicated by id).
/// * `limit`     — maximum rows per direction (default 100, hard cap 500).
/// * `project`   — optional project slug; when provided, results are filtered
///                 to edges whose `project_id` matches (or is NULL).
///
/// # Errors
///
/// Returns a string error on DB I/O failure.
#[tauri::command]
pub async fn memory_impact_analysis(
    symbol: String,
    direction: String,
    limit: Option<usize>,
    project: Option<String>,
) -> Result<Vec<CodeEdge>, String> {
    let limit = limit.unwrap_or(100).min(500);
    let project_filter = project.clone();

    tauri::async_runtime::spawn_blocking(move || {
        impact_analysis_inner(&symbol, &direction, limit, project_filter.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking panicked: {e}"))?
}

/// Synchronous inner logic — called from the async wrapper via
/// `spawn_blocking` and directly from unit tests.
pub(crate) fn impact_analysis_inner(
    symbol: &str,
    direction: &str,
    limit: usize,
    project: Option<&str>,
) -> Result<Vec<CodeEdge>, String> {
    let fetch =
        |dir: &str| sqlite_store::query_code_edges(symbol, dir, limit).map_err(|e| e.to_string());

    let mut edges: Vec<CodeEdge> = match direction {
        "callers" => fetch("callers")?,
        "callees" => fetch("callees")?,
        "both" => {
            let mut callers = fetch("callers")?;
            let callees = fetch("callees")?;
            // Merge, keeping unique ids (callers first so impact analysis
            // surfaces fan-in at the top of the result list).
            let mut seen = std::collections::HashSet::new();
            callers.retain(|e| seen.insert(e.id));
            let mut both = callers;
            for e in callees {
                if seen.insert(e.id) {
                    both.push(e);
                }
            }
            both
        }
        other => {
            return Err(format!(
                "invalid direction '{other}': expected 'callers', 'callees', or 'both'"
            ))
        }
    };

    // Optional project filter — keeps edges belonging to the requested
    // project OR cross-project (project_id IS NULL) so synthetic edges
    // are not silently hidden.
    if let Some(proj) = project {
        edges.retain(|e| e.project_id.as_deref().is_none_or(|pid| pid == proj));
    }

    Ok(edges)
}

// ---------------------------------------------------------------------------
// memory_graph_metrics
// ---------------------------------------------------------------------------

/// Diagnostic counters for the code-graph layer.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GraphMetrics {
    /// Total rows in the `edges` table.
    pub total_edges: i64,
    /// Rows per `kind` label (e.g. "calls", "imports", …).
    pub edges_by_kind: Vec<KindCount>,
    /// Total rows in `unresolved_refs`.
    pub unresolved_refs: i64,
}

/// A `(kind, count)` pair returned inside [`GraphMetrics`].
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KindCount {
    pub kind: String,
    pub count: i64,
}

/// Return aggregate counts for the code-graph layer.
///
/// Useful for the memory diagnostic dashboard and the CLI `edge metrics`
/// subcommand.
///
/// # Errors
///
/// Returns a string error on DB I/O failure.
#[tauri::command]
pub async fn memory_graph_metrics() -> Result<GraphMetrics, String> {
    tauri::async_runtime::spawn_blocking(graph_metrics_inner)
        .await
        .map_err(|e| format!("spawn_blocking panicked: {e}"))?
}

/// Synchronous inner logic — used by the async wrapper and directly in tests.
pub(crate) fn graph_metrics_inner() -> Result<GraphMetrics, String> {
    use crate::memory::schema_v4::graph_metrics;
    use crate::memory::sqlite_store::open_conn;

    let conn = open_conn().map_err(|e| e.to_string())?;
    let raw = graph_metrics(&conn).map_err(|e| e.to_string())?;
    Ok(GraphMetrics {
        total_edges: raw.total_edges,
        edges_by_kind: raw
            .edges_by_kind
            .into_iter()
            .map(|(kind, count)| KindCount { kind, count })
            .collect(),
        unresolved_refs: raw.unresolved_refs,
    })
}

// ---------------------------------------------------------------------------
// memory_drain_unresolved
// ---------------------------------------------------------------------------

/// Result returned by `memory_drain_unresolved`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DrainResult {
    /// Number of `unresolved_refs` rows promoted to `edges`.
    pub promoted: usize,
    /// Number of rows that could not be promoted (target still absent).
    pub remaining: usize,
}

/// Promote `unresolved_refs` whose targets are now present in `memory_items`
/// to full `edges` rows.
///
/// Idempotent — safe to call repeatedly; already-promoted refs are deleted
/// from `unresolved_refs` on first promotion and will not appear again.
///
/// # Errors
///
/// Returns a string error on DB I/O failure.
#[tauri::command]
pub async fn memory_drain_unresolved() -> Result<DrainResult, String> {
    tauri::async_runtime::spawn_blocking(|| {
        use crate::memory::schema_v4::drain_unresolved_refs;
        use crate::memory::sqlite_store::open_conn;

        let conn = open_conn().map_err(|e| e.to_string())?;
        let stats = drain_unresolved_refs(&conn).map_err(|e| e.to_string())?;
        Ok(DrainResult {
            promoted: stats.promoted,
            remaining: stats.remaining,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking panicked: {e}"))?
}
