// ULTRON Control Center 2.0 — Rules viewer
//
// Walks `~/.claude/rules/` recursively and returns the list of .md files
// with a short preview (first 3 non-empty lines).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RuleFile {
    pub name: String,
    pub path: String,
    pub relative: String,
    pub preview: String,
}

fn rules_root() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    Ok(home.join(".claude").join("rules"))
}

pub fn list_inner() -> Result<Vec<RuleFile>, String> {
    let root = rules_root()?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in WalkDir::new(&root).follow_links(false) {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("(unnamed)")
            .to_string();
        let relative = path
            .strip_prefix(&root)
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| name.clone());
        let preview = std::fs::read_to_string(path)
            .ok()
            .map(|s| {
                s.lines()
                    .filter(|l| !l.trim().is_empty())
                    .take(3)
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        out.push(RuleFile {
            name,
            path: path.to_string_lossy().to_string(),
            relative,
            preview,
        });
    }
    out.sort_by(|a, b| a.relative.cmp(&b.relative));
    Ok(out)
}

pub fn read_inner(path: String) -> Result<String, String> {
    let root = rules_root()?;
    let canonical = std::fs::canonicalize(&path)
        .map_err(|e| format!("canonicalize {path}: {e}"))?;
    // Sandbox: only allow paths within ~/.claude/rules/.
    if !canonical.starts_with(&root) {
        return Err(format!(
            "path {} outside rules root",
            canonical.display()
        ));
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("read {path}: {e}"))
}
