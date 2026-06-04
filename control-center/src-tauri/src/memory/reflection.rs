// ULTRON Control Center -- Memory reflection / consolidation (MEMORY KERNEL)
//
// Generates higher-order memories ("insights") by distilling clusters of recent
// ACTIVE items into a single summary that CITES its source item ids. Grounding
// the insight in concrete source ids is the anti-hallucination guard: an insight
// that cannot point at the items it was derived from is worthless and we drop it.
//
// GOVERNANCE INVARIANT (see service.rs): this module NEVER writes persistent
// memory. It only:
//   1. reads ACTIVE items (read-only),
//   2. asks the AI Router for a distilled summary (best-effort), and
//   3. returns `Insight`s, which `insights_to_candidates` maps into
//      `MemoryCandidate`s (status = Pending) for the human/auto inbox to vet.
//   The single persistent writer remains `MemoryService::create_candidate`.
//
// FAIL-SAFE: no function panics. The LLM call (`ai_router::route`) is isolated in
// `distill_group` so the pure assembly + mapping logic is unit-testable without
// network / API keys / Qdrant. Any failure (route error, empty group, too few
// sources) yields fewer / zero insights -- never an error and never a crash.

use rusqlite::Connection;

use super::model::Status;
use super::model::{MemoryCandidate, MemoryItem, MemoryType, Scope};
use super::sqlite_store as store;

/// Minimum number of source items required before a group is worth distilling.
/// A single item is not a "higher-order" memory -- it is just that item.
const MIN_GROUP_SOURCES: usize = 2;

/// Default confidence applied to a distilled insight when the source items carry
/// no usable confidence signal of their own.
const DEFAULT_INSIGHT_CONFIDENCE: f32 = 0.5;

/// Hard cap on how many active items we ever pull into a single reflection pass,
/// regardless of the caller's `max_sources`, to keep prompts and memory bounded.
const MAX_RECENT_ITEMS: usize = 200;

/// Cap on how many source items we cite / feed per group, to keep the prompt and
/// the citation list bounded and the LLM grounded.
const MAX_SOURCES_PER_GROUP: usize = 8;

/// The AI Router zone used for distillation. `"summarize"` is a seeded zone in
/// `ai_router::seed_zones` mapped to a cheap summarisation model with fallbacks.
const SUMMARIZE_ZONE: &str = "summarize";

/// A higher-order memory distilled from several source items.
///
/// `source_ids` are the ids of the `memory_items` this insight was derived from;
/// they are the grounding/citation set and must be non-empty for the insight to
/// be considered valid.
#[derive(Debug, Clone)]
pub struct Insight {
    /// The distilled, human-readable insight text.
    pub summary: String,
    /// Ids of the source `memory_items` this insight cites (grounding).
    pub source_ids: Vec<String>,
    /// Confidence in `[0.0, 1.0]`, derived from the source items (min) or the
    /// default when no signal is available.
    pub confidence: f32,
}

/// Reflect over recent ACTIVE items and return distilled higher-order insights.
///
/// Steps:
///   1. Pull recent ACTIVE items (optionally filtered to `scope_project`),
///      capped at `max_sources` (and an absolute `MAX_RECENT_ITEMS` ceiling).
///   2. Group them by a cheap heuristic (memory type) -- a first-pass stand-in
///      for vector clustering, intentionally light per the spec.
///   3. For each group with at least `MIN_GROUP_SOURCES` items, ask the AI Router
///      (`summarize` zone) for a distilled insight and attach the cited ids.
///
/// FAIL-SAFE: returns an empty `Vec` (never an error) when the store is empty,
/// when there are too few sources, or when every LLM call fails. Never panics.
#[must_use]
pub fn reflect(conn: &Connection, scope_project: Option<&str>, max_sources: usize) -> Vec<Insight> {
    reflect_with(conn, scope_project, max_sources, distill_group)
}

/// Testable core of [`reflect`]: identical logic but the LLM distillation step is
/// injected via `distill`, so unit tests can supply a deterministic fake and
/// avoid any network / API-key dependency.
///
/// `distill` receives the group's source items and must return `Some(summary)`
/// on success or `None` on any failure (treated as "skip this group").
fn reflect_with<F>(
    conn: &Connection,
    scope_project: Option<&str>,
    max_sources: usize,
    distill: F,
) -> Vec<Insight>
where
    F: Fn(&[MemoryItem]) -> Option<String>,
{
    if max_sources == 0 {
        return Vec::new();
    }

    let recent = recent_active_items(conn, scope_project, max_sources);
    if recent.len() < MIN_GROUP_SOURCES {
        return Vec::new();
    }

    let groups = group_by_type(recent);

    let mut insights: Vec<Insight> = Vec::new();
    for group in groups {
        if group.len() < MIN_GROUP_SOURCES {
            continue;
        }
        // Bound the sources we cite/feed so prompts and citation lists stay small.
        let sources: Vec<MemoryItem> = group.into_iter().take(MAX_SOURCES_PER_GROUP).collect();

        let summary = match distill(&sources) {
            Some(s) => s.trim().to_string(),
            None => continue, // LLM failed or had nothing -> skip group, no error.
        };
        if summary.is_empty() {
            continue;
        }

        let source_ids: Vec<String> = sources.iter().map(|i| i.id.clone()).collect();
        if source_ids.is_empty() {
            continue; // grounding guard: never emit an uncited insight.
        }
        let confidence = group_confidence(&sources);

        insights.push(Insight {
            summary,
            source_ids,
            confidence,
        });
    }

    insights
}

/// Convert insights into PENDING `MemoryCandidate`s for the validation inbox.
///
/// Each insight becomes one candidate (`type = Fact`, `scope = Global`) because
/// the model has no dedicated "reflection" memory type. The cited `source_ids`
/// are preserved on the candidate via `source_event_ids` (the closest existing
/// grounding field on `MemoryCandidate`) so the inbox can show provenance, and
/// `confidence` is carried straight through. Candidates are ALWAYS pending --
/// they never become active memory without going through `MemoryService`.
#[must_use]
pub fn insights_to_candidates(insights: &[Insight]) -> Vec<MemoryCandidate> {
    insights
        .iter()
        .map(|ins| {
            // type=Fact per spec (no Reflection variant); scope Global is the
            // safe default -- the inbox can relabel scope/type on approval.
            let mut cand = MemoryCandidate::new(MemoryType::Fact, Scope::Global);
            cand.proposed_summary = Some(ins.summary.clone());
            // Grounding: cite the source items the insight was derived from.
            cand.source_event_ids = ins.source_ids.clone();
            cand.confidence = ins.confidence.clamp(0.0, 1.0);
            cand
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Internal helpers (pure, except `distill_group` which calls the AI Router)
// ---------------------------------------------------------------------------

/// Pull recent ACTIVE items, optionally filtered to a project, newest first.
///
/// `store::list_items` already orders by `updated_at DESC`. We over-fetch only
/// when a project filter is requested (the store list is not project-scoped) and
/// then post-filter, always honouring both `max_sources` and `MAX_RECENT_ITEMS`.
fn recent_active_items(
    conn: &Connection,
    scope_project: Option<&str>,
    max_sources: usize,
) -> Vec<MemoryItem> {
    let cap = max_sources.min(MAX_RECENT_ITEMS);
    // When filtering by project we over-fetch (up to the ceiling) so the cap
    // applies to matching rows rather than to the unfiltered window.
    let fetch = if scope_project.is_some() {
        MAX_RECENT_ITEMS
    } else {
        cap
    };

    let items = store::list_items(conn, Status::Active, fetch).unwrap_or_default();

    match scope_project {
        Some(pid) => items
            .into_iter()
            .filter(|i| i.project_id.as_deref() == Some(pid))
            .take(cap)
            .collect(),
        None => items.into_iter().take(cap).collect(),
    }
}

/// Group items by their `MemoryType` as a cheap clustering heuristic.
///
/// This is an intentional first-pass stand-in for vector clustering: items of
/// the same kind are likely to be about the same concern, so distilling them
/// together yields a coherent insight without an embedding round-trip. Group
/// order is deterministic (by the type's stable string key) for reproducible
/// output across runs and tests.
fn group_by_type(items: Vec<MemoryItem>) -> Vec<Vec<MemoryItem>> {
    use std::collections::BTreeMap;

    let mut buckets: BTreeMap<&'static str, Vec<MemoryItem>> = BTreeMap::new();
    for item in items {
        buckets.entry(item.kind.as_str()).or_default().push(item);
    }
    buckets.into_values().collect()
}

/// Confidence for a distilled insight: the MINIMUM of the source confidences
/// (an insight is only as trustworthy as its weakest support), falling back to
/// `DEFAULT_INSIGHT_CONFIDENCE` when there is no usable signal. Always clamped to
/// `[0.0, 1.0]`.
fn group_confidence(sources: &[MemoryItem]) -> f32 {
    let min = sources
        .iter()
        .map(|i| i.confidence)
        .filter(|c| c.is_finite())
        .fold(f32::INFINITY, f32::min);

    if min.is_finite() {
        min.clamp(0.0, 1.0)
    } else {
        DEFAULT_INSIGHT_CONFIDENCE
    }
}

/// Build the distillation prompt for a group of source items. The prompt asks
/// the model for ONE grounded insight and explicitly lists the source ids so the
/// distilled text can reference them. Pure -- no I/O -- so it is unit-testable.
fn build_distill_prompt(sources: &[MemoryItem]) -> String {
    let mut prompt = String::from(
        "You are consolidating memory. From the following source memory items, \
         write ONE concise higher-order insight (1-2 sentences) that captures \
         the shared pattern or conclusion. Ground it strictly in the items \
         below; do not invent facts. Output only the insight text.\n\nSOURCES:\n",
    );
    for item in sources {
        let text = item
            .summary
            .clone()
            .or_else(|| item.content.clone())
            .unwrap_or_default();
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        // Cite each source by id so the model (and audit) can ground the insight.
        prompt.push_str(&format!("- [{}] {}\n", item.id, text));
    }
    prompt
}

/// LLM distillation step (the only side-effecting helper). Isolated so that the
/// rest of the module stays pure and testable. Returns `Some(summary)` on a
/// successful, non-empty route response or `None` on any failure -- the caller
/// treats `None` as "skip this group", so a router/key/network failure simply
/// produces fewer insights rather than an error.
///
/// FAIL-SAFE: `ai_router::route` returns `Result<String, String>`; we map both
/// the `Err` arm and an empty/whitespace response to `None`. Never panics.
fn distill_group(sources: &[MemoryItem]) -> Option<String> {
    if sources.len() < MIN_GROUP_SOURCES {
        return None;
    }
    let prompt = build_distill_prompt(sources);
    match crate::ai_router::route(SUMMARIZE_ZONE, &prompt) {
        Ok(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => None,
    }
}

// ---------------------------------------------------------------------------
// Tests -- pure: in-memory conn + injected fake distiller (no LLM / Qdrant / net)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::super::model::{Source, Status};
    use super::*;
    use rusqlite::Connection;

    fn mem_conn() -> Connection {
        let conn = Connection::open_in_memory().expect("open in-memory");
        store::apply_schema(&conn).expect("schema");
        conn
    }

    fn active_item(kind: MemoryType, summary: &str, project: Option<&str>) -> MemoryItem {
        let mut it = MemoryItem::new(
            kind,
            Scope::Project,
            Source::AssistantInferred,
            Status::Active,
        );
        it.summary = Some(summary.to_string());
        it.project_id = project.map(|p| p.to_string());
        it
    }

    fn mk_insight(summary: &str, ids: &[&str], confidence: f32) -> Insight {
        Insight {
            summary: summary.to_string(),
            source_ids: ids.iter().map(|s| s.to_string()).collect(),
            confidence,
        }
    }

    // -- insights_to_candidates -------------------------------------------

    #[test]
    fn maps_n_insights_to_n_pending_candidates() {
        let insights = vec![
            mk_insight("insight a", &["s1", "s2"], 0.4),
            mk_insight("insight b", &["s3"], 0.8),
            mk_insight("insight c", &["s4", "s5", "s6"], 0.6),
        ];
        let cands = insights_to_candidates(&insights);
        assert_eq!(cands.len(), 3, "N insights -> N candidates");
        for c in &cands {
            assert_eq!(
                c.status,
                super::super::model::CandidateStatus::Pending,
                "reflection candidates must be pending, never active"
            );
        }
    }

    #[test]
    fn candidate_preserves_summary_confidence_and_source_ids() {
        let insights = vec![mk_insight("destilado", &["src-1", "src-2"], 0.42)];
        let cands = insights_to_candidates(&insights);
        let c = &cands[0];
        assert_eq!(c.proposed_summary.as_deref(), Some("destilado"));
        assert!((c.confidence - 0.42).abs() < 1e-6, "confidence preserved");
        assert_eq!(
            c.source_event_ids,
            vec!["src-1".to_string(), "src-2".to_string()]
        );
        assert_eq!(
            c.proposed_type,
            MemoryType::Fact,
            "no Reflection type -> Fact"
        );
    }

    #[test]
    fn candidate_confidence_is_clamped() {
        let insights = vec![
            mk_insight("hi", &["a"], 1.7),
            mk_insight("lo", &["b"], -0.3),
        ];
        let cands = insights_to_candidates(&insights);
        assert!((cands[0].confidence - 1.0).abs() < 1e-6);
        assert!((cands[1].confidence - 0.0).abs() < 1e-6);
    }

    #[test]
    fn empty_insights_yield_empty_candidates() {
        assert!(insights_to_candidates(&[]).is_empty());
    }

    // -- reflect_with (pure core, injected distiller) ---------------------

    #[test]
    fn reflect_returns_empty_when_store_empty() {
        let conn = mem_conn();
        let out = reflect_with(&conn, None, 10, |_| Some("x".to_string()));
        assert!(out.is_empty(), "no items -> no insights");
    }

    #[test]
    fn reflect_returns_empty_with_too_few_sources() {
        let conn = mem_conn();
        store::insert_item(&conn, &active_item(MemoryType::Fact, "lonely fact", None)).unwrap();
        // Only one item total -> below MIN_GROUP_SOURCES.
        let out = reflect_with(&conn, None, 10, |_| {
            Some("should not be called".to_string())
        });
        assert!(
            out.is_empty(),
            "a single source cannot form a higher-order memory"
        );
    }

    #[test]
    fn reflect_distills_a_group_and_cites_source_ids() {
        let conn = mem_conn();
        let a = active_item(MemoryType::Fact, "router falls back on quota", None);
        let b = active_item(MemoryType::Fact, "router retries cheaper provider", None);
        store::insert_item(&conn, &a).unwrap();
        store::insert_item(&conn, &b).unwrap();

        let out = reflect_with(&conn, None, 10, |srcs| {
            // Deterministic fake distiller: assert grounding then emit a summary.
            assert!(srcs.len() >= MIN_GROUP_SOURCES);
            Some("router uses cost-aware fallback chain".to_string())
        });

        assert_eq!(out.len(), 1, "two same-type items distil into one insight");
        let ins = &out[0];
        assert_eq!(ins.summary, "router uses cost-aware fallback chain");
        assert_eq!(ins.source_ids.len(), 2, "insight cites both sources");
        assert!(ins.source_ids.contains(&a.id));
        assert!(ins.source_ids.contains(&b.id));
    }

    #[test]
    fn reflect_skips_group_when_distiller_fails() {
        let conn = mem_conn();
        store::insert_item(
            &conn,
            &active_item(MemoryType::Decision, "use sqlite", None),
        )
        .unwrap();
        store::insert_item(
            &conn,
            &active_item(MemoryType::Decision, "use qdrant", None),
        )
        .unwrap();

        // Distiller fails (simulating route() Err / empty) -> fail-safe empty.
        let out = reflect_with(&conn, None, 10, |_| None);
        assert!(
            out.is_empty(),
            "a failed LLM distillation drops the group, no panic"
        );
    }

    #[test]
    fn reflect_skips_empty_distiller_summary() {
        let conn = mem_conn();
        store::insert_item(&conn, &active_item(MemoryType::Task, "task one", None)).unwrap();
        store::insert_item(&conn, &active_item(MemoryType::Task, "task two", None)).unwrap();
        let out = reflect_with(&conn, None, 10, |_| Some("   ".to_string()));
        assert!(
            out.is_empty(),
            "whitespace-only summary is treated as no insight"
        );
    }

    #[test]
    fn reflect_groups_by_type_independently() {
        let conn = mem_conn();
        // Two facts + two decisions -> two distinct groups -> two insights.
        store::insert_item(&conn, &active_item(MemoryType::Fact, "fact a", None)).unwrap();
        store::insert_item(&conn, &active_item(MemoryType::Fact, "fact b", None)).unwrap();
        store::insert_item(
            &conn,
            &active_item(MemoryType::Decision, "decision a", None),
        )
        .unwrap();
        store::insert_item(
            &conn,
            &active_item(MemoryType::Decision, "decision b", None),
        )
        .unwrap();

        let out = reflect_with(&conn, None, 50, |srcs| {
            Some(format!("insight over {} items", srcs.len()))
        });
        assert_eq!(
            out.len(),
            2,
            "facts and decisions each form their own group"
        );
    }

    #[test]
    fn reflect_filters_by_project() {
        let conn = mem_conn();
        store::insert_item(
            &conn,
            &active_item(MemoryType::Fact, "ultron fact 1", Some("ultron")),
        )
        .unwrap();
        store::insert_item(
            &conn,
            &active_item(MemoryType::Fact, "ultron fact 2", Some("ultron")),
        )
        .unwrap();
        store::insert_item(
            &conn,
            &active_item(MemoryType::Fact, "bank fact", Some("bank")),
        )
        .unwrap();

        let out = reflect_with(&conn, Some("ultron"), 50, |srcs| {
            // Only the two ultron facts should reach the distiller.
            assert_eq!(srcs.len(), 2);
            assert!(srcs
                .iter()
                .all(|i| i.project_id.as_deref() == Some("ultron")));
            Some("ultron insight".to_string())
        });
        assert_eq!(out.len(), 1);
    }

    #[test]
    fn reflect_returns_empty_for_zero_max_sources() {
        let conn = mem_conn();
        store::insert_item(&conn, &active_item(MemoryType::Fact, "a", None)).unwrap();
        store::insert_item(&conn, &active_item(MemoryType::Fact, "b", None)).unwrap();
        let out = reflect_with(&conn, None, 0, |_| Some("x".to_string()));
        assert!(out.is_empty(), "max_sources=0 short-circuits to empty");
    }

    // -- confidence helper -------------------------------------------------

    #[test]
    fn group_confidence_is_min_of_sources() {
        let mut a = active_item(MemoryType::Fact, "a", None);
        a.confidence = 0.9;
        let mut b = active_item(MemoryType::Fact, "b", None);
        b.confidence = 0.3;
        let conf = group_confidence(&[a, b]);
        assert!(
            (conf - 0.3).abs() < 1e-6,
            "weakest source bounds the insight"
        );
    }

    #[test]
    fn group_confidence_defaults_when_no_finite_signal() {
        // Empty slice -> no finite values -> default.
        let conf = group_confidence(&[]);
        assert!((conf - DEFAULT_INSIGHT_CONFIDENCE).abs() < 1e-6);
    }

    // -- prompt builder ----------------------------------------------------

    #[test]
    fn build_distill_prompt_cites_each_source_id() {
        let a = active_item(MemoryType::Fact, "alpha summary", None);
        let b = active_item(MemoryType::Fact, "beta summary", None);
        let prompt = build_distill_prompt(&[a.clone(), b.clone()]);
        assert!(prompt.contains(&a.id), "prompt must cite source id a");
        assert!(prompt.contains(&b.id), "prompt must cite source id b");
        assert!(prompt.contains("alpha summary"));
        assert!(prompt.contains("beta summary"));
    }

    #[test]
    fn build_distill_prompt_skips_empty_text_items() {
        let a = active_item(MemoryType::Fact, "real text", None);
        let mut blank = active_item(MemoryType::Fact, "", None);
        blank.summary = None;
        blank.content = None;
        let prompt = build_distill_prompt(&[a.clone(), blank.clone()]);
        assert!(prompt.contains(&a.id));
        assert!(
            !prompt.contains(&blank.id),
            "items with no text are not cited"
        );
    }
}
