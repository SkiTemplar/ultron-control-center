// ULTRON Control Center -- Memory Kernel: cheap-brain LLM tasks (MEMORY KERNEL).
//
// This module is the "cheap brain" of the memory kernel: it channels the
// kernel's small, frequent LLM chores through the AI Router's free pool
// (`crate::ai_router::route`) instead of spending premium Claude tokens.
//
// Tasks routed here:
//   - extract_candidates : pull 0..n atomic facts out of a transcript
//   - rewrite_query      : HyDE-lite query expansion for recall
//   - judge_contradiction: decide whether two summaries contradict
//
// Design rules (all FAIL-SAFE, never panic):
//   1. Every public function degrades gracefully. If the router is offline,
//      rate-limited, or returns garbage, callers still get a usable answer:
//        - extract_candidates -> empty Vec (nothing learned this turn)
//        - rewrite_query      -> at least the original query (always)
//        - judge_contradiction-> None (undecidable, caller falls back)
//   2. This module is READ-ONLY with respect to memory. It NEVER writes
//      `MemoryItem`s or candidates. It only proposes plain data (`ProposedFact`)
//      that an upstream caller (the MemoryService, the single writer) may turn
//      into a `MemoryCandidate`. See memory/service.rs "regla de oro".
//   3. The LLM boundary is isolated behind `call_json`, so the pure parsing /
//      assembly logic stays unit-testable with no network, no API keys, no E5,
//      and no Qdrant.
//
// The AI Router contract (verified against ai_router.rs):
//   `crate::ai_router::route(zone_id: &str, prompt: &str) -> Result<String, String>`
// It returns plain assistant text. There is no temperature / response_schema
// parameter yet, so we ask for JSON in the prompt and parse it tolerantly:
// models love to wrap JSON in prose or ```json fences, so we extract the first
// balanced `{...}` or `[...]` block before deserializing.

use serde::de::DeserializeOwned;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Zone constants -- which AI Router zone each task maps to.
//
// These zone ids are seeded in `ai_router::seed_zones`. If a zone is missing
// at runtime, `route` returns Err and our fail-safe paths kick in.
// ---------------------------------------------------------------------------

/// Cheap utility zone (Groq primary, Haiku fallback) for fact extraction.
const ZONE_EXTRACT: &str = "utility";
/// Light single-turn zone for query rewriting.
const ZONE_REWRITE: &str = "light";
/// Trivial zone for the contradiction yes/no judgement.
const ZONE_JUDGE: &str = "utility";

/// Upper bound on facts accepted from a single extraction, to keep a runaway
/// model from flooding the candidate pipeline.
const MAX_FACTS: usize = 16;
/// Upper bound on query variants returned (excluding the always-present
/// original), so a chatty model cannot blow up the recall fan-out.
const MAX_QUERY_VARIANTS: usize = 4;

// ---------------------------------------------------------------------------
// Public output types
// ---------------------------------------------------------------------------

/// A single atomic fact proposed by the extractor.
///
/// Plain strings on purpose: this is a *proposal*, not a governed memory. The
/// caller decides whether `kind` / `scope` map onto real `MemoryType` / `Scope`
/// variants (via their `parse`) before building a `MemoryCandidate`. Keeping
/// them as strings means a model typo never panics this module.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ProposedFact {
    /// The atomic fact, phrased as a self-contained statement.
    pub summary: String,
    /// Proposed memory type as a string (e.g. "fact", "preference", "decision").
    /// May be empty when the model did not classify it.
    #[serde(default)]
    pub kind: String,
    /// Proposed scope as a string (e.g. "global", "project", "session").
    /// May be empty when the model did not classify it.
    #[serde(default)]
    pub scope: String,
}

// ---------------------------------------------------------------------------
// Wire types -- shapes we ask the model to produce. Tolerant on purpose.
// ---------------------------------------------------------------------------

/// One raw fact entry as it arrives from the model. Field aliases absorb the
/// common spellings a model might emit so a near-miss key still parses.
#[derive(Debug, Clone, Deserialize)]
struct RawFact {
    #[serde(default, alias = "fact", alias = "text", alias = "statement")]
    summary: String,
    #[serde(default, alias = "type", alias = "memory_type")]
    kind: String,
    #[serde(default)]
    scope: String,
}

/// Wrapper for the contradiction judgement. `contradicts` is the canonical key;
/// `contradiction` / `contradictory` are tolerated aliases.
#[derive(Debug, Clone, Deserialize)]
struct ContradictionVerdict {
    #[serde(alias = "contradiction", alias = "contradictory", alias = "result")]
    contradicts: bool,
}

/// Wrapper for query rewriting. `queries` is canonical; `variants` /
/// `rewrites` are tolerated.
#[derive(Debug, Clone, Deserialize)]
struct RewriteResult {
    #[serde(default, alias = "variants", alias = "rewrites", alias = "expansions")]
    queries: Vec<String>,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Extract 0..n atomic facts from a conversation transcript.
///
/// Asks the cheap utility zone to return a JSON array of
/// `{summary, type, scope}` objects. Parsing is tolerant; anything that does
/// not yield a usable `summary` is dropped. On any failure (router down,
/// blank input, unparseable output) this returns an empty `Vec` -- learning
/// nothing this turn is always safe.
///
/// `project_id` is woven into the prompt as a hint so the model can prefer a
/// `project` scope when the content is project-specific; it is never trusted
/// blindly and never written anywhere.
///
/// NEVER writes memory. The caller turns these into `MemoryCandidate`s.
#[must_use]
pub fn extract_candidates(transcript: &str, project_id: Option<&str>) -> Vec<ProposedFact> {
    let trimmed = transcript.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let prompt = build_extract_prompt(trimmed, project_id);
    let raw: Vec<RawFact> = match call_json(ZONE_EXTRACT, &prompt) {
        Some(v) => v,
        None => return Vec::new(),
    };

    raw.into_iter()
        .filter_map(normalize_fact)
        .take(MAX_FACTS)
        .collect()
}

/// Expand / reformulate a query for recall (HyDE-lite).
///
/// Returns the original query first, followed by 0..N model-proposed variants
/// (deduplicated, blanks dropped, capped at `MAX_QUERY_VARIANTS`). The original
/// is ALWAYS present, even when the router fails -- so a caller can safely use
/// `rewrite_query(q)` as a drop-in superset of `[q]`.
#[must_use]
pub fn rewrite_query(query: &str) -> Vec<String> {
    let original = query.trim().to_string();
    // Always start with the original (even if empty -- caller asked for it).
    let mut out: Vec<String> = vec![original.clone()];

    if original.is_empty() {
        return out;
    }

    let prompt = build_rewrite_prompt(&original);
    let parsed: Option<RewriteResult> = call_json(ZONE_REWRITE, &prompt);

    if let Some(result) = parsed {
        for variant in result.queries {
            let v = variant.trim().to_string();
            if v.is_empty() {
                continue;
            }
            // Skip exact duplicates (case-insensitive) of anything we have.
            let dup = out.iter().any(|existing| existing.eq_ignore_ascii_case(&v));
            if dup {
                continue;
            }
            out.push(v);
            // out always holds the original plus accepted variants; stop once
            // we have collected MAX_QUERY_VARIANTS variants beyond the original.
            if out.len() > MAX_QUERY_VARIANTS {
                break;
            }
        }
    }

    out
}

/// Judge whether two memory summaries contradict each other.
///
/// Returns:
///   - `Some(true)`  -> the model is confident they contradict
///   - `Some(false)` -> the model is confident they do NOT contradict
///   - `None`        -> undecidable (router down, blank input, unparseable)
///
/// Callers MUST treat `None` as "do not act" (fail-safe): an unverified
/// contradiction should never silently deprecate a memory.
#[must_use]
pub fn judge_contradiction(a: &str, b: &str) -> Option<bool> {
    let a = a.trim();
    let b = b.trim();
    if a.is_empty() || b.is_empty() {
        return None;
    }

    let prompt = build_judge_prompt(a, b);
    let verdict: ContradictionVerdict = call_json(ZONE_JUDGE, &prompt)?;
    Some(verdict.contradicts)
}

// ---------------------------------------------------------------------------
// Prompt builders -- kept private and pure (string in, string out).
// ---------------------------------------------------------------------------

fn build_extract_prompt(transcript: &str, project_id: Option<&str>) -> String {
    let scope_hint = match project_id {
        Some(pid) if !pid.trim().is_empty() => format!(
            "If a fact is specific to this project, set scope to \"project\" \
             (project id: {}). Otherwise use \"global\", \"user\", or \"session\".",
            pid.trim()
        ),
        _ => "Use one of: \"global\", \"user\", \"project\", \"session\".".to_string(),
    };

    format!(
        "You extract durable, atomic facts worth remembering from a conversation \
         transcript. Each fact must be a single self-contained statement.\n\
         Allowed type values: preference, fact, decision, constraint, task, \
         codebase_fact, error_resolution, architecture.\n\
         {scope_hint}\n\
         If nothing is worth remembering, return an empty array [].\n\
         Respond with ONLY a JSON array, no markdown fences, no prose:\n\
         [{{\"summary\":\"...\",\"type\":\"fact\",\"scope\":\"global\"}}]\n\n\
         Transcript:\n{transcript}"
    )
}

fn build_rewrite_prompt(query: &str) -> String {
    format!(
        "You expand a search query into a few alternative phrasings that would \
         retrieve the same information from a memory store. Keep them short and \
         semantically equivalent; vary wording and synonyms, not meaning.\n\
         Return 2-4 variants. Do NOT include the original query.\n\
         Respond with ONLY JSON, no markdown fences, no prose:\n\
         {{\"queries\":[\"...\",\"...\"]}}\n\n\
         Query: {query}"
    )
}

fn build_judge_prompt(a: &str, b: &str) -> String {
    format!(
        "You decide whether two statements directly contradict each other. \
         Two statements contradict only if they cannot both be true at the same \
         time about the same subject. Differences in detail or topic are NOT \
         contradictions.\n\
         Respond with ONLY JSON, no markdown fences, no prose:\n\
         {{\"contradicts\":true}} or {{\"contradicts\":false}}\n\n\
         Statement A: {a}\n\
         Statement B: {b}"
    )
}

// ---------------------------------------------------------------------------
// Fact normalization -- map a tolerant RawFact into a clean ProposedFact.
// ---------------------------------------------------------------------------

/// Trim and validate a raw fact. Returns `None` when there is no usable
/// summary (the only field we strictly require).
fn normalize_fact(raw: RawFact) -> Option<ProposedFact> {
    let summary = raw.summary.trim().to_string();
    if summary.is_empty() {
        return None;
    }
    Some(ProposedFact {
        summary,
        kind: raw.kind.trim().to_ascii_lowercase(),
        scope: raw.scope.trim().to_ascii_lowercase(),
    })
}

// ---------------------------------------------------------------------------
// LLM boundary -- the ONLY function that talks to the router. Everything above
// is pure and unit-testable; everything below is isolated I/O.
// ---------------------------------------------------------------------------

/// Route `prompt` through zone `zone`, then tolerantly parse the returned text
/// as JSON of type `T`.
///
/// FAIL-SAFE: returns `None` on any router error or parse failure -- never
/// panics, never propagates. Logs to stderr in debug-friendly form so the
/// event is not completely silent during development.
fn call_json<T: DeserializeOwned>(zone: &str, prompt: &str) -> Option<T> {
    // Hermetic tests: `route` is this module's ONLY network seam. Under
    // `cargo test` a real provider call would be non-deterministic and would
    // depend on whatever API keys happen to be in the ambient environment, so
    // the `*_when_router_unavailable` contract tests below would flake on a dev
    // machine that has keys set. Short-circuit to the fail-safe path; the pure
    // parsing logic is exercised directly via `parse_json_tolerant`.
    if cfg!(test) {
        return None;
    }
    match crate::ai_router::route(zone, prompt) {
        Ok(text) => parse_json_tolerant::<T>(&text),
        Err(e) => {
            eprintln!("[memory::ai_tasks] route({zone}) failed: {e}");
            None
        }
    }
}

/// Parse JSON of type `T` from possibly-messy model output.
///
/// Strategy (in order):
///   1. Try the whole (trimmed) text as JSON.
///   2. Extract the first balanced `{...}` or `[...]` block and try that.
///
/// This handles the common cases where a model wraps JSON in prose or in
/// ```json fences. Returns `None` if nothing parses -- never panics.
///
/// Pure and side-effect free: this is the seam exercised by the unit tests.
fn parse_json_tolerant<T: DeserializeOwned>(text: &str) -> Option<T> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Fast path: the whole payload is valid JSON.
    if let Ok(value) = serde_json::from_str::<T>(trimmed) {
        return Some(value);
    }

    // Slow path: salvage the first balanced object/array block.
    let block = extract_first_json_block(trimmed)?;
    serde_json::from_str::<T>(block).ok()
}

/// Find the first balanced `{...}` or `[...]` block in `text` and return it as
/// a string slice. String-literal aware: braces/brackets inside JSON strings
/// (and escaped quotes) do not affect nesting depth.
///
/// Returns `None` when no balanced block exists. Pure; no allocation beyond the
/// returned borrow.
fn extract_first_json_block(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();

    // Locate the first opening delimiter and remember which closer matches it.
    let mut start = None;
    let mut open = b'{';
    let mut close = b'}';
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'{' {
            start = Some(i);
            open = b'{';
            close = b'}';
            break;
        }
        if b == b'[' {
            start = Some(i);
            open = b'[';
            close = b']';
            break;
        }
    }
    let start = start?;

    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escaped = false;

    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }

        match b {
            b'"' => in_string = true,
            x if x == open => depth += 1,
            x if x == close => {
                depth -= 1;
                if depth == 0 {
                    // `i` is the index of the matching closer; slice is inclusive.
                    return text.get(start..=i);
                }
            }
            _ => {}
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Tests -- PURE. No network, no API keys, no Qdrant, no E5.
//
// We exercise the parsing seam (`parse_json_tolerant`, `extract_first_json_block`,
// `normalize_fact`) and the always-include-original contract of `rewrite_query`
// (which holds even when `route` fails, because no router is reachable in the
// test harness -- so the LLM branch yields nothing and the fail-safe path runs).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // --- extract_first_json_block ------------------------------------------

    #[test]
    fn extracts_object_from_surrounding_prose() {
        let text = "Sure! Here is the result:\n```json\n{\"contradicts\": true}\n```\nDone.";
        let block = extract_first_json_block(text).expect("should find a block");
        assert_eq!(block, "{\"contradicts\": true}");
    }

    #[test]
    fn extracts_array_block() {
        let text = "prose [\n  {\"summary\":\"x\"}\n] trailing";
        let block = extract_first_json_block(text).expect("should find an array");
        assert_eq!(block, "[\n  {\"summary\":\"x\"}\n]");
    }

    #[test]
    fn ignores_braces_inside_strings() {
        // The closing brace inside the string must not end the block early.
        let text = "{\"summary\":\"a } b\",\"kind\":\"fact\"}";
        let block = extract_first_json_block(text).expect("balanced despite inner brace");
        assert_eq!(block, text);
    }

    #[test]
    fn handles_escaped_quote_inside_string() {
        let text = "noise {\"summary\":\"he said \\\"hi\\\" }\"} more";
        let block = extract_first_json_block(text).expect("balanced with escaped quote");
        assert_eq!(block, "{\"summary\":\"he said \\\"hi\\\" }\"}");
    }

    #[test]
    fn returns_none_when_no_block_present() {
        assert!(extract_first_json_block("just some prose, no json").is_none());
    }

    #[test]
    fn returns_none_for_unbalanced_block() {
        assert!(extract_first_json_block("{\"summary\":\"x\"").is_none());
    }

    // --- parse_json_tolerant ------------------------------------------------

    #[test]
    fn parses_clean_json_directly() {
        let v: ContradictionVerdict =
            parse_json_tolerant("{\"contradicts\": false}").expect("clean json parses");
        assert!(!v.contradicts);
    }

    #[test]
    fn parses_json_wrapped_in_fences_and_prose() {
        let raw = "Here you go:\n```json\n{\"contradicts\": true}\n```";
        let v: ContradictionVerdict = parse_json_tolerant(raw).expect("salvaged from fences");
        assert!(v.contradicts);
    }

    #[test]
    fn parse_returns_none_on_blank() {
        let v: Option<ContradictionVerdict> = parse_json_tolerant("   \n  ");
        assert!(v.is_none());
    }

    #[test]
    fn parse_returns_none_on_garbage() {
        let v: Option<ContradictionVerdict> = parse_json_tolerant("totally not json");
        assert!(v.is_none());
    }

    #[test]
    fn parses_fact_array_with_aliases() {
        // "fact" and "type" are aliases for summary/kind respectively.
        let raw = "[{\"fact\":\"uses bge-m3\",\"type\":\"decision\",\"scope\":\"project\"}]";
        let facts: Vec<RawFact> = parse_json_tolerant(raw).expect("array parses");
        assert_eq!(facts.len(), 1);
        assert_eq!(facts[0].summary, "uses bge-m3");
        assert_eq!(facts[0].kind, "decision");
        assert_eq!(facts[0].scope, "project");
    }

    #[test]
    fn parses_rewrite_with_variants_alias() {
        let raw = "{\"variants\":[\"a\",\"b\"]}";
        let r: RewriteResult = parse_json_tolerant(raw).expect("variants alias parses");
        assert_eq!(r.queries, vec!["a".to_string(), "b".to_string()]);
    }

    // --- normalize_fact -----------------------------------------------------

    #[test]
    fn normalize_drops_blank_summary() {
        let raw = RawFact {
            summary: "   ".to_string(),
            kind: "fact".to_string(),
            scope: "global".to_string(),
        };
        assert!(normalize_fact(raw).is_none());
    }

    #[test]
    fn normalize_trims_and_lowercases_enums() {
        let raw = RawFact {
            summary: "  the user prefers UV  ".to_string(),
            kind: "  Preference ".to_string(),
            scope: "  USER ".to_string(),
        };
        let fact = normalize_fact(raw).expect("valid fact");
        assert_eq!(fact.summary, "the user prefers UV");
        assert_eq!(fact.kind, "preference");
        assert_eq!(fact.scope, "user");
    }

    // --- rewrite_query (fail-safe contract) ---------------------------------

    #[test]
    fn rewrite_query_always_includes_original() {
        // No router is reachable in the test harness, so the LLM branch yields
        // nothing; the result must still contain exactly the original query.
        let out = rewrite_query("last session ultron");
        assert!(
            out.contains(&"last session ultron".to_string()),
            "original query must always be present"
        );
        assert_eq!(out[0], "last session ultron", "original must be first");
    }

    #[test]
    fn rewrite_query_trims_original() {
        let out = rewrite_query("  oauth refactor  ");
        assert_eq!(out[0], "oauth refactor");
    }

    #[test]
    fn rewrite_query_empty_returns_single_empty() {
        let out = rewrite_query("   ");
        assert_eq!(out, vec![String::new()]);
    }

    // --- extract_candidates (fail-safe contract) ----------------------------

    #[test]
    fn extract_candidates_blank_transcript_is_empty() {
        assert!(extract_candidates("   \n ", None).is_empty());
        assert!(extract_candidates("", Some("ultron")).is_empty());
    }

    #[test]
    fn extract_candidates_returns_empty_when_router_unavailable() {
        // Non-blank transcript but no reachable router -> empty (never panics).
        let out = extract_candidates("the user decided to use bge-m3.", Some("ultron"));
        assert!(out.is_empty());
    }

    // --- judge_contradiction (fail-safe contract) ---------------------------

    #[test]
    fn judge_contradiction_blank_inputs_are_undecidable() {
        assert_eq!(judge_contradiction("", "b"), None);
        assert_eq!(judge_contradiction("a", "   "), None);
    }

    #[test]
    fn judge_contradiction_undecidable_when_router_unavailable() {
        // Both non-blank but no router -> None (fail-safe, never panics).
        assert_eq!(judge_contradiction("sky is blue", "sky is green"), None);
    }

    // --- ProposedFact shape -------------------------------------------------

    #[test]
    fn proposed_fact_deserializes_with_defaults() {
        // kind/scope are optional; only summary is required.
        let f: ProposedFact = serde_json::from_str("{\"summary\":\"x\"}").unwrap();
        assert_eq!(f.summary, "x");
        assert_eq!(f.kind, "");
        assert_eq!(f.scope, "");
    }
}
