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
use std::sync::{Mutex, OnceLock};

// Global write lock — serializes ALL read-modify-write paths against
// `kg.jsonl`. Without this, two concurrent `create_entities_inner` calls
// (or any pair of mutators) can interleave their read → mutate → rename
// sequences and the second writer clobbers the first writer's additions.
// The lock is held across read_graph_inner + mutate + write_graph so the
// whole RMW is atomic from the caller's point of view.
fn kg_write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

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
    // Test-only env override — lets integration tests run without
    // touching the user's real `~/.ultron/cockpit/kg.jsonl`. In
    // production this var is never set, so this is a zero-cost branch.
    if let Ok(override_path) = std::env::var("ULTRON_KG_PATH_OVERRIDE") {
        if !override_path.is_empty() {
            return Ok(PathBuf::from(override_path));
        }
    }
    let home = dirs::home_dir().ok_or("no HOME dir")?;
    Ok(home.join(".ultron").join("cockpit").join("kg.jsonl"))
}

/// Read the JSONL graph from disk. Returns an empty graph if no file exists.
pub fn read_graph_inner() -> Result<KgGraph, String> {
    let path = kg_path()?;
    if !path.exists() {
        return Ok(KgGraph::default());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
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
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f =
            std::fs::File::create(&tmp).map_err(|e| format!("create {}: {e}", tmp.display()))?;
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
    let _guard = kg_write_lock()
        .lock()
        .map_err(|e| format!("kg lock poisoned: {e}"))?;
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
    let _guard = kg_write_lock()
        .lock()
        .map_err(|e| format!("kg lock poisoned: {e}"))?;
    let mut graph = read_graph_inner()?;
    graph.entities.retain(|e| e.name != name);
    // Cascade: drop relations that referenced the deleted entity.
    graph.relations.retain(|r| r.from != name && r.to != name);
    write_graph(&graph)?;
    Ok(graph)
}

pub fn add_observations_inner(name: String, observations: Vec<String>) -> Result<KgGraph, String> {
    let _guard = kg_write_lock()
        .lock()
        .map_err(|e| format!("kg lock poisoned: {e}"))?;
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
    let _guard = kg_write_lock()
        .lock()
        .map_err(|e| format!("kg lock poisoned: {e}"))?;
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
        let already = graph
            .relations
            .iter()
            .any(|r| r.from == from && r.to == to && r.relation_type == relation_type);
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
    let _guard = kg_write_lock()
        .lock()
        .map_err(|e| format!("kg lock poisoned: {e}"))?;
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
    let names: std::collections::HashSet<String> = matches.iter().map(|e| e.name.clone()).collect();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    // Serialize tests in this module so they don't race on the shared
    // ULTRON_KG_PATH_OVERRIDE env var. We can't use the production lock
    // here because each test points at a different temp file.
    static TEST_ENV_LOCK: StdMutex<()> = StdMutex::new(());

    struct EnvGuard {
        prev: Option<String>,
    }
    impl EnvGuard {
        fn set(path: &std::path::Path) -> Self {
            let prev = std::env::var("ULTRON_KG_PATH_OVERRIDE").ok();
            std::env::set_var("ULTRON_KG_PATH_OVERRIDE", path);
            EnvGuard { prev }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(v) => std::env::set_var("ULTRON_KG_PATH_OVERRIDE", v),
                None => std::env::remove_var("ULTRON_KG_PATH_OVERRIDE"),
            }
        }
    }

    fn fresh_temp_path() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("kg.jsonl");
        (dir, path)
    }

    #[test]
    fn create_entities_dedupes_by_name_and_merges_observations() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let (_dir, path) = fresh_temp_path();
        let _g = EnvGuard::set(&path);

        let first = create_entities_inner(vec![KgEntity {
            name: "alpha".into(),
            entity_type: "system".into(),
            observations: vec!["a".into(), "b".into()],
        }])
        .expect("first create");
        assert_eq!(first.entities.len(), 1);

        // Re-create with overlapping observations + a new one. Should
        // not duplicate the entity, should dedupe observations.
        let second = create_entities_inner(vec![KgEntity {
            name: "alpha".into(),
            entity_type: "system".into(),
            observations: vec!["b".into(), "c".into()],
        }])
        .expect("second create");
        assert_eq!(second.entities.len(), 1, "entity should be deduped by name");
        let obs = &second.entities[0].observations;
        assert_eq!(obs.len(), 3, "observations should merge without dupes");
        assert!(obs.iter().any(|o| o == "a"));
        assert!(obs.iter().any(|o| o == "b"));
        assert!(obs.iter().any(|o| o == "c"));
    }

    #[test]
    fn create_entities_under_concurrent_writers_does_not_lose_data() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let (_dir, path) = fresh_temp_path();
        let _g = EnvGuard::set(&path);

        // Seed the file so the read_graph_inner path is exercised.
        create_entities_inner(vec![KgEntity {
            name: "seed".into(),
            entity_type: "system".into(),
            observations: vec![],
        }])
        .expect("seed");

        // Spawn two writers each adding 25 unique entities. Without the
        // global write lock these would interleave RMW cycles and the
        // second writer would clobber the first writer's adds, leaving
        // <50 distinct entities. With the lock, total = 50 + 1 (seed).
        let p1 = path.clone();
        let h1 = std::thread::spawn(move || {
            std::env::set_var("ULTRON_KG_PATH_OVERRIDE", &p1);
            for i in 0..25 {
                create_entities_inner(vec![KgEntity {
                    name: format!("t1-{i}"),
                    entity_type: "node".into(),
                    observations: vec![],
                }])
                .expect("t1 create");
            }
        });
        let p2 = path.clone();
        let h2 = std::thread::spawn(move || {
            std::env::set_var("ULTRON_KG_PATH_OVERRIDE", &p2);
            for i in 0..25 {
                create_entities_inner(vec![KgEntity {
                    name: format!("t2-{i}"),
                    entity_type: "node".into(),
                    observations: vec![],
                }])
                .expect("t2 create");
            }
        });
        h1.join().unwrap();
        h2.join().unwrap();

        let graph = read_graph_inner().expect("final read");
        assert_eq!(
            graph.entities.len(),
            51,
            "concurrent writers should not lose entities (seed + 25 + 25)"
        );
    }

    #[test]
    fn create_entities_skips_blank_names() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let (_dir, path) = fresh_temp_path();
        let _g = EnvGuard::set(&path);

        let g = create_entities_inner(vec![
            KgEntity {
                name: "   ".into(),
                entity_type: "x".into(),
                observations: vec![],
            },
            KgEntity {
                name: "real".into(),
                entity_type: "x".into(),
                observations: vec![],
            },
        ])
        .expect("create");
        assert_eq!(g.entities.len(), 1);
        assert_eq!(g.entities[0].name, "real");
    }

    #[test]
    fn delete_entity_cascades_relations() {
        let _lock = TEST_ENV_LOCK.lock().unwrap();
        let (_dir, path) = fresh_temp_path();
        let _g = EnvGuard::set(&path);

        create_entities_inner(vec![
            KgEntity {
                name: "a".into(),
                entity_type: "x".into(),
                observations: vec![],
            },
            KgEntity {
                name: "b".into(),
                entity_type: "x".into(),
                observations: vec![],
            },
        ])
        .unwrap();
        create_relations_inner(vec![KgRelation {
            from: "a".into(),
            to: "b".into(),
            relation_type: "links".into(),
        }])
        .unwrap();

        let g = delete_entity_inner("a".into()).unwrap();
        assert_eq!(g.entities.len(), 1);
        assert!(
            g.relations.is_empty(),
            "relations referencing a should drop"
        );
    }
}
