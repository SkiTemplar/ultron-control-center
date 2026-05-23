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

/// Write a rule by relative path (e.g. `common/my-rule.md` or `my-rule.md`).
/// Path is normalised + sandboxed inside `~/.claude/rules/`. Creates parent
/// directories as needed. Returns the absolute on-disk path.
pub fn write_inner(name: String, body: String) -> Result<String, String> {
    let root = rules_root()?;
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir rules root: {e}"))?;
    let clean = name.trim().trim_start_matches('/').replace('\\', "/");
    if clean.is_empty() {
        return Err("rule name cannot be empty".into());
    }
    if clean.contains("..") {
        return Err("rule name cannot contain `..`".into());
    }
    let with_ext = if clean.ends_with(".md") {
        clean
    } else {
        format!("{clean}.md")
    };
    let target = root.join(&with_ext);
    // Materialise parent dirs first so canonicalize can resolve a sibling
    // tmpfile next to a file that does not yet exist.
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    // Final sandbox check after parent creation: the parent (which now
    // exists) must canonicalize inside the rules root.
    let parent = target
        .parent()
        .ok_or_else(|| "no parent dir".to_string())?;
    let canonical_parent =
        std::fs::canonicalize(parent).map_err(|e| format!("canonicalize parent: {e}"))?;
    if !canonical_parent.starts_with(&root) {
        return Err(format!(
            "path {} outside rules root",
            canonical_parent.display()
        ));
    }
    // Atomic write via tmp + rename.
    let tmp = target.with_extension("md.tmp");
    std::fs::write(&tmp, body.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("rename: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}
