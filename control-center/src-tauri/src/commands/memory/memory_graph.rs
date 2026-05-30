// Control Center 2.9.x — Unified memory graph search command
//
// Backs the new Memory tab tree view. Searches all four local knowledge layers
// in parallel (sync, since each inner fn is already blocking) and returns a
// single aggregated result.
//
// Layers:
//   skills  — grep on name + description from skills::list_skills_with_origin_inner
//   agents  — grep on name + description from agents::list_agents_inner
//   rules   — grep on name + relative path from rules::list_inner
//   mem0    — delegate to mem0::search_inner (async, cloud)
//   kg      — delegate to kg::search_nodes_inner (local JSONL)
//   qdrant  — stub, returns [] (wire in card-qdrant-wire)

use serde::Serialize;

use crate::agents::{list_agents_inner, AgentInfo};
use crate::kg::{search_nodes_inner, KgEntity};
use crate::mem0::{search_inner as mem0_search_inner, Mem0Memory};
use crate::rules::{list_inner as rules_list_inner, RuleFile};
use crate::skills::{list_skills_with_origin_inner, SkillEntry, SkillOrigin};

// ---------------------------------------------------------------------------
// Hit types — thin wrappers that include a relevance flag
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct SkillHit {
    pub name: String,
    pub description: String,
    pub path: String,
    /// "global" | "project" | "plugin"
    pub origin: String,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct AgentHit {
    pub name: String,
    pub description: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct RuleHit {
    pub name: String,
    pub relative: String,
    pub path: String,
    pub preview: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct UnifiedSearchResults {
    pub skills: Vec<SkillHit>,
    pub agents: Vec<AgentHit>,
    pub rules: Vec<RuleHit>,
    pub mem0: Vec<Mem0Memory>,
    pub kg: Vec<KgEntity>,
    /// Semantic hits from Qdrant ultron_sessions collection.
    pub qdrant: Vec<crate::qdrant::QdrantHit>,
}

// ---------------------------------------------------------------------------
// Tree snapshot — used by the tree view's initial load (no query)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Clone)]
pub struct MemoryTreeSnapshot {
    pub skills: Vec<SkillHit>,
    pub agents: Vec<AgentHit>,
    pub rules: Vec<RuleHit>,
    pub kg_entity_count: usize,
    pub kg_entity_types: Vec<(String, usize)>,
}

// ---------------------------------------------------------------------------
// Inner helpers
// ---------------------------------------------------------------------------

fn needle_matches(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(needle)
}

fn filter_skills(query: &str, top_k: usize) -> Vec<SkillHit> {
    let needle = query.to_lowercase();
    let entries: Vec<SkillEntry> = list_skills_with_origin_inner(None).unwrap_or_default();
    entries
        .into_iter()
        .filter(|s| {
            if needle.is_empty() {
                return true;
            }
            needle_matches(&s.name, &needle) || needle_matches(&s.description, &needle)
        })
        .take(top_k)
        .map(|s| SkillHit {
            name: s.name,
            description: s.description,
            path: s.path,
            origin: match s.origin {
                SkillOrigin::Global => "global".to_string(),
                SkillOrigin::Project => "project".to_string(),
                SkillOrigin::Plugin => "plugin".to_string(),
            },
            enabled: s.enabled,
        })
        .collect()
}

fn filter_agents(query: &str, top_k: usize) -> Vec<AgentHit> {
    let needle = query.to_lowercase();
    let agents: Vec<AgentInfo> = list_agents_inner().unwrap_or_default();
    agents
        .into_iter()
        .filter(|a| {
            if needle.is_empty() {
                return true;
            }
            needle_matches(&a.name, &needle)
                || a.description
                    .as_deref()
                    .map(|d| needle_matches(d, &needle))
                    .unwrap_or(false)
        })
        .take(top_k)
        .map(|a| AgentHit {
            name: a.name,
            description: a.description,
            path: a.path,
        })
        .collect()
}

fn filter_rules(query: &str, top_k: usize) -> Vec<RuleHit> {
    let needle = query.to_lowercase();
    let rules: Vec<RuleFile> = rules_list_inner().unwrap_or_default();
    rules
        .into_iter()
        .filter(|r| {
            if needle.is_empty() {
                return true;
            }
            needle_matches(&r.name, &needle)
                || needle_matches(&r.relative, &needle)
                || needle_matches(&r.preview, &needle)
        })
        .take(top_k)
        .map(|r| RuleHit {
            name: r.name,
            relative: r.relative,
            path: r.path,
            preview: r.preview,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Public inner function — called by the async command wrapper
// ---------------------------------------------------------------------------

pub async fn unified_search_inner(
    query: String,
    top_k: usize,
) -> Result<UnifiedSearchResults, String> {
    let needle = query.trim().to_string();
    let top_k = top_k.min(200);

    // Sync layers run on the blocking thread pool so they don't starve the
    // async executor.
    let needle_clone = needle.clone();
    let (skills, agents, rules) =
        tauri::async_runtime::spawn_blocking(move || {
            (
                filter_skills(&needle_clone, top_k),
                filter_agents(&needle_clone, top_k),
                filter_rules(&needle_clone, top_k),
            )
        })
        .await
        .map_err(|e| e.to_string())?;

    // Async layers: mem0 (cloud) and kg (local JSONL).
    let mem0_results = if needle.is_empty() {
        // No query — skip cloud call, return empty so the tree loads fast.
        Vec::new()
    } else {
        mem0_search_inner(needle.clone(), None, Some(top_k as u32))
            .await
            .unwrap_or_default()
    };

    let kg_graph = search_nodes_inner(needle.clone()).unwrap_or_default();

    // Qdrant semantic layer — uses real BGE vectors when the `qdrant` feature
    // is active (default). Falls back to empty when Qdrant is not running.
    let qdrant_results = if needle.is_empty() {
        Vec::new()
    } else {
        let needle_q = needle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            crate::qdrant::search("ultron_sessions", &needle_q, 10)
        })
        .await
        .unwrap_or_else(|join_err| {
            eprintln!("[memory_graph] qdrant spawn_blocking panicked: {join_err}");
            Ok(Vec::new())
        })
        .unwrap_or_else(|qdrant_err| {
            eprintln!("[memory_graph] qdrant search error: {qdrant_err}");
            Vec::new()
        })
    };

    Ok(UnifiedSearchResults {
        skills,
        agents,
        rules,
        mem0: mem0_results,
        kg: kg_graph.entities,
        qdrant: qdrant_results,
    })
}

pub fn tree_snapshot_inner() -> Result<MemoryTreeSnapshot, String> {
    let skills = filter_skills("", 500);
    let agents = filter_agents("", 500);
    let rules = filter_rules("", 500);

    let kg_graph = crate::kg::read_graph_inner().unwrap_or_default();
    let kg_entity_count = kg_graph.entities.len();

    // Count per entity_type.
    let mut type_counts: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    for e in &kg_graph.entities {
        *type_counts.entry(e.entity_type.clone()).or_insert(0) += 1;
    }
    let kg_entity_types: Vec<(String, usize)> = type_counts.into_iter().collect();

    Ok(MemoryTreeSnapshot {
        skills,
        agents,
        rules,
        kg_entity_count,
        kg_entity_types,
    })
}

// ---------------------------------------------------------------------------
// Tauri command wrappers
// ---------------------------------------------------------------------------

/// Unified search across skills, agents, rules, mem0 and the local KG.
/// `top_k` caps results per layer (default 50, max 200).
#[tauri::command]
pub async fn memory_unified_search(
    query: String,
    top_k: Option<usize>,
) -> Result<UnifiedSearchResults, String> {
    unified_search_inner(query, top_k.unwrap_or(50)).await
}

/// Returns the full tree snapshot for the initial Memory tab load.
/// Skips mem0 (no cloud round-trip) so the tree renders instantly.
#[tauri::command]
pub async fn memory_tree_snapshot() -> Result<MemoryTreeSnapshot, String> {
    tauri::async_runtime::spawn_blocking(tree_snapshot_inner)
        .await
        .map_err(|e| e.to_string())?
}
