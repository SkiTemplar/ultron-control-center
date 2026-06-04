// ULTRON Control Center — AI-create instructions folder resolver.
//
// Each creator (Skills, MCPs, Plans, scheduled tasks, memory notes) has a
// dedicated folder under ~/.ultron/instructions/<kind>/ with a GUIDE.md
// that explains conventions, validators and post-create steps. When the
// user clicks "Create with AI" in a tab, the Tauri command returns the
// path; the frontend uses it as `cwd` for a Claude session so the model
// reads the GUIDE.md automatically instead of re-deriving the rules each
// time.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Serialize, Clone)]
pub struct InstructionEntry {
    pub kind: String,
    pub path: String,
    pub exists: bool,
    pub label: String,
}

const KINDS: &[(&str, &str)] = &[
    ("skills", "Skill"),
    ("mcps", "MCP server"),
    ("plans", "Plan"),
    ("tasks", "Scheduled task"),
    ("memory", "Memory note"),
];

fn root() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/instructions"))
}

pub fn list_instruction_folders_inner() -> Result<Vec<InstructionEntry>, String> {
    let root = root().ok_or_else(|| "no HOME".to_string())?;
    let mut out: Vec<InstructionEntry> = Vec::with_capacity(KINDS.len());
    for (kind, label) in KINDS {
        let p = root.join(kind);
        out.push(InstructionEntry {
            kind: kind.to_string(),
            path: p.to_string_lossy().to_string(),
            exists: p.join("GUIDE.md").exists(),
            label: label.to_string(),
        });
    }
    Ok(out)
}

pub fn instruction_path_inner(kind: String) -> Result<String, String> {
    if !KINDS.iter().any(|(k, _)| *k == kind.as_str()) {
        return Err(format!("unknown instruction kind '{}'", kind));
    }
    let p = root().ok_or_else(|| "no HOME".to_string())?.join(&kind);
    Ok(p.to_string_lossy().to_string())
}
