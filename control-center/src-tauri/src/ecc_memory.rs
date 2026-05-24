// ULTRON Control Center 2.3 — ECC knowledge-graph reader (local, read-only)
//
// The ECC plugin ships the `@modelcontextprotocol/server-memory` MCP server,
// which persists a simple JSONL knowledge graph. Each non-empty line is an
// object with a `type` discriminator:
//
//   {"type":"entity","name":"X","entityType":"...","observations":["..."]}
//   {"type":"relation","from":"A","to":"B","relationType":"depends_on"}
//
// The default storage path is `<server-memory dist>/memory.jsonl`, but the
// MCP entry may override it via the `MEMORY_FILE_PATH` env var. The Control
// Center cannot drive the MCP stdio (that's reserved for Claude Code
// agents), so this module simply reads the file directly and surfaces an
// immutable snapshot for the Memory tab.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EccEntity {
    pub name: String,
    pub entity_type: String,
    pub observations: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EccRelation {
    pub from: String,
    pub to: String,
    pub relation_type: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EccMemorySnapshot {
    /// Resolved absolute path of the JSONL file that was read. `None` when
    /// no storage file was found on disk — the frontend uses this to render
    /// the "not detected" state alongside `searched_paths`.
    pub source_path: Option<String>,
    /// All paths the loader probed, in order. Always populated so the UI can
    /// show the user where the file is expected.
    pub searched_paths: Vec<String>,
    pub entities: Vec<EccEntity>,
    pub relations: Vec<EccRelation>,
    /// ISO-8601 UTC timestamp of when this snapshot was generated.
    pub generated_at: String,
}

/// Candidate locations for the memory JSONL, in priority order.
fn candidate_paths() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();

    // 1. Explicit env override — mirrors the MCP server's own logic.
    if let Ok(p) = std::env::var("MEMORY_FILE_PATH") {
        out.push(PathBuf::from(p));
    }

    if let Some(home) = dirs::home_dir() {
        // 2. The npm-installed @modelcontextprotocol/server-memory default
        //    storage location on Windows (next to its dist/index.js).
        out.push(
            home.join("AppData")
                .join("Roaming")
                .join("npm")
                .join("node_modules")
                .join("@modelcontextprotocol")
                .join("server-memory")
                .join("dist")
                .join("memory.jsonl"),
        );
        // 3. Legacy filename — same dir, pre-migration.
        out.push(
            home.join("AppData")
                .join("Roaming")
                .join("npm")
                .join("node_modules")
                .join("@modelcontextprotocol")
                .join("server-memory")
                .join("dist")
                .join("memory.json"),
        );
        // 4. ECC convention — some setups stash the graph under the plugin
        //    cache or ~/.claude/memory/.
        out.push(home.join(".claude").join("memory").join("memory.jsonl"));
        out.push(home.join(".claude").join("memory.jsonl"));
    }

    out
}

/// First existing path among `candidate_paths`, or `None`.
pub fn ecc_memory_path() -> Option<PathBuf> {
    candidate_paths().into_iter().find(|p| p.exists())
}

/// Parse the JSONL graph into a snapshot. Always returns Ok — when no file
/// is found, returns an empty snapshot with `source_path = None` so the
/// frontend can render the "not detected" state without an error toast.
pub fn ecc_memory_read() -> Result<EccMemorySnapshot, String> {
    let searched: Vec<String> = candidate_paths()
        .iter()
        .map(|p| p.display().to_string())
        .collect();
    let now = chrono::Utc::now().to_rfc3339();

    let Some(path) = ecc_memory_path() else {
        return Ok(EccMemorySnapshot {
            source_path: None,
            searched_paths: searched,
            entities: Vec::new(),
            relations: Vec::new(),
            generated_at: now,
        });
    };

    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;

    let mut entities: Vec<EccEntity> = Vec::new();
    let mut relations: Vec<EccRelation> = Vec::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue, // skip malformed lines instead of failing the whole load
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
                    entities.push(EccEntity {
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
                    relations.push(EccRelation {
                        from,
                        to,
                        relation_type,
                    });
                }
            }
            _ => {}
        }
    }

    Ok(EccMemorySnapshot {
        source_path: Some(path.display().to_string()),
        searched_paths: searched,
        entities,
        relations,
        generated_at: now,
    })
}

/// Bootstrap the ECC memory JSONL at `~/.claude/memory.jsonl` with a seed
/// entity so the file exists and downstream MCP / GUI calls have a target.
///
/// Returns the absolute path of the file that was created or already
/// existed. Idempotent: if a file is already present at one of the
/// candidate paths, this is a no-op and the existing path is returned.
pub fn bootstrap_ecc_memory_inner() -> Result<String, String> {
    if let Some(existing) = ecc_memory_path() {
        return Ok(existing.display().to_string());
    }
    let home = dirs::home_dir().ok_or("no home dir")?;
    let target = home.join(".claude").join("memory.jsonl");
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    // Seed with a single entity so consumers that expect non-empty JSONL
    // (and the GUI's status pill) report "loaded" instead of "empty".
    let seed = serde_json::json!({
        "type": "entity",
        "name": "ULTRON",
        "entityType": "system",
        "observations": [
            "Bootstrapped from Control Center on first use.",
            "Replace or extend via the memory MCP (create_entities / add_observations)."
        ]
    });
    let line = serde_json::to_string(&seed)
        .map_err(|e| format!("serialize seed: {e}"))?;
    std::fs::write(&target, format!("{line}\n"))
        .map_err(|e| format!("write {}: {e}", target.display()))?;
    Ok(target.display().to_string())
}
