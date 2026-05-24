// ULTRON Control Center 2.6 — local Knowledge Graph (card v26-fb-047)
//
// The ECC knowledge graph (`ecc_memory.rs`) is owned by the
// @modelcontextprotocol/server-memory MCP server. It writes via stdio from
// inside Claude Code agent sessions, so the Control Center treats it as
// read-only.
//
// This module provides a *separate*, Control-Center-owned knowledge graph
// stored at `~/.ultron/cockpit/kg.jsonl`. Users can create/edit entities and
// relations directly from the Memory tab without touching the MCP-owned
// store. The on-disk format matches the MCP server's JSONL schema so the two
// stores stay interoperable:
//
//   {"type":"entity","name":"X","entityType":"...","observations":["..."]}
//   {"type":"relation","from":"A","to":"B","relationType":"depends_on"}
//
// The whole file is rewritten on every mutation. The graph is small enough
// (<10MB even with thousands of entities) that this stays simple and avoids
// fsync footguns of in-place edits.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KgEntity {
    pub name: String,
    pub entity_type: String,
    pub observations: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct KgRelation {
    pub from: String,
    pub to: String,
    pub relation_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct KgGraph {
    pub entities: Vec<KgEntity>,
    pub relations: Vec<KgRelation>,
}

fn kg_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no HOME dir")?;
    Ok(home.join(".ultron").join("cockpit").join("kg.jsonl"))
}

/// Read the JSONL graph from disk. Returns an empty graph if no file exists.
pub fn read_graph_inner() -> Result<KgGraph, String> {
    let path = kg_path()?;
    if !path.exists() {
        return Ok(KgGraph::default());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let mut graph = KgGraph::default();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = value
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        match kind {
            "entity" => {
                let name = value
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let entity_type = value
                    .get("entityType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("entity")
                    .to_string();
                let observations: Vec<String> = value
                    .get("observations")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect()
                    })
                    .unwrap_or_default();
                if !name.is_empty() {
                    graph.entities.push(KgEntity {
                        name,
                        entity_type,
                        observations,
                    });
                }
            }
            "relation" => {
                let from = value
                    .get("from")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let to = value
                    .get("to")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let relation_type = value
                    .get("relationType")
                    .and_then(|v| v.as_str())
                    .unwrap_or("relates_to")
                    .to_string();
                if !from.is_empty() && !to.is_empty() {
                    graph.relations.push(KgRelation {
                        from,
                        to,
                        relation_type,
                    });
                }
            }
            _ => {}
        }
    }
    Ok(graph)
}

fn write_graph(graph: &KgGraph) -> Result<(), String> {
    let path = kg_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = std::fs::File::create(&tmp)
            .map_err(|e| format!("create {}: {e}", tmp.display()))?;
        for ent in &graph.entities {
            let line = serde_json::json!({
                "type": "entity",
                "name": ent.name,
                "entityType": ent.entity_type,
                "observations": ent.observations,
            });
            writeln!(f, "{line}").map_err(|e| e.to_string())?;
        }
        for rel in &graph.relations {
            let line = serde_json::json!({
                "type": "relation",
                "from": rel.from,
                "to": rel.to,
                "relationType": rel.relation_type,
            });
            writeln!(f, "{line}").map_err(|e| e.to_string())?;
        }
    }
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Create one or more entities. Idempotent — if an entity with the same
/// name already exists, its observations are merged (deduped) instead of
/// duplicating it.
pub fn create_entities_inner(entities: Vec<KgEntity>) -> Result<KgGraph, String> {
    let mut graph = read_graph_inner()?;
    for new_ent in entities {
        let trimmed_name = new_ent.name.trim().to_string();
        if trimmed_name.is_empty() {
            continue;
        }
        let new_ent = KgEntity {
            name: trimmed_name,
            entity_type: if new_ent.entity_type.trim().is_empty() {
                "entity".into()
            } else {
                new_ent.entity_type.trim().to_string()
            },
            observations: new_ent.observations,
        };
        if let Some(existing) = graph.entities.iter_mut().find(|e| e.name == new_ent.name) {
            // Merge type if existing was the default and incoming differs.
            if existing.entity_type == "entity" && new_ent.entity_type != "entity" {
                existing.entity_type = new_ent.entity_type;
            }
            for obs in new_ent.observations {
                if !existing.observations.iter().any(|o| o == &obs) {
                    existing.observations.push(obs);
                }
            }
        } else {
            graph.entities.push(new_ent);
        }
    }
    write_graph(&graph)?;
    Ok(graph)
}

pub fn delete_entity_inner(name: String) -> Result<KgGraph, String> {
    let mut graph = read_graph_inner()?;
    graph.entities.retain(|e| e.name != name);
    // Cascade: drop relations that referenced the deleted entity.
    graph.relations.retain(|r| r.from != name && r.to != name);
    write_graph(&graph)?;
    Ok(graph)
}

pub fn add_observations_inner(
    name: String,
    observations: Vec<String>,
) -> Result<KgGraph, String> {
    let mut graph = read_graph_inner()?;
    let Some(ent) = graph.entities.iter_mut().find(|e| e.name == name) else {
        return Err(format!("entity '{name}' not found"));
    };
    for obs in observations {
        let obs = obs.trim().to_string();
        if obs.is_empty() {
            continue;
        }
        if !ent.observations.iter().any(|o| o == &obs) {
            ent.observations.push(obs);
        }
    }
    write_graph(&graph)?;
    Ok(graph)
}

pub fn create_relations_inner(relations: Vec<KgRelation>) -> Result<KgGraph, String> {
    let mut graph = read_graph_inner()?;
    let entity_names: std::collections::HashSet<String> =
        graph.entities.iter().map(|e| e.name.clone()).collect();
    for rel in relations {
        let from = rel.from.trim().to_string();
        let to = rel.to.trim().to_string();
        let relation_type = if rel.relation_type.trim().is_empty() {
            "relates_to".to_string()
        } else {
            rel.relation_type.trim().to_string()
        };
        if from.is_empty() || to.is_empty() {
            continue;
        }
        if !entity_names.contains(&from) || !entity_names.contains(&to) {
            return Err(format!(
                "both endpoints must exist as entities (from='{from}', to='{to}')"
            ));
        }
        // Dedupe on (from, to, type).
        let already = graph.relations.iter().any(|r| {
            r.from == from && r.to == to && r.relation_type == relation_type
        });
        if !already {
            graph.relations.push(KgRelation {
                from,
                to,
                relation_type,
            });
        }
    }
    write_graph(&graph)?;
    Ok(graph)
}

pub fn delete_relation_inner(
    from: String,
    to: String,
    relation_type: String,
) -> Result<KgGraph, String> {
    let mut graph = read_graph_inner()?;
    graph
        .relations
        .retain(|r| !(r.from == from && r.to == to && r.relation_type == relation_type));
    write_graph(&graph)?;
    Ok(graph)
}

/// Case-insensitive substring search across entity name, type and
/// observations. Mirrors what the MCP server's `search_nodes` does.
pub fn search_nodes_inner(query: String) -> Result<KgGraph, String> {
    let graph = read_graph_inner()?;
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(graph);
    }
    let matches: Vec<KgEntity> = graph
        .entities
        .iter()
        .filter(|e| {
            e.name.to_lowercase().contains(&needle)
                || e.entity_type.to_lowercase().contains(&needle)
                || e.observations
                    .iter()
                    .any(|o| o.to_lowercase().contains(&needle))
        })
        .cloned()
        .collect();
    let names: std::collections::HashSet<String> =
        matches.iter().map(|e| e.name.clone()).collect();
    let relations: Vec<KgRelation> = graph
        .relations
        .into_iter()
        .filter(|r| names.contains(&r.from) || names.contains(&r.to))
        .collect();
    Ok(KgGraph {
        entities: matches,
        relations,
    })
}
