//! Control Center 2.0 — Slash command registry.
//!
//! Walks `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/**/*.md`
//! and `~/.claude/commands/**/*.md` (user-local) to produce a flat list of
//! every slash command Claude Code can dispatch. Each `.md` is one slash
//! command: the file path encodes the namespace and the YAML frontmatter
//! carries the metadata (`description`, `argument-hint`, `model`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlashCommand {
    /// Bare command name (file stem) — e.g. `aside`, `feature-dev`.
    pub name: String,
    /// Plugin slug — `ecc`, `superpowers`, `commit-commands`, …
    /// Special values: `user` for `~/.claude/commands/*`.
    pub plugin: String,
    /// Marketplace folder — `ecc`, `claude-plugins-official`,
    /// `superpowers-marketplace`, `openai-codex`, …
    /// Special value: `user` for the user-local namespace.
    pub marketplace: String,
    /// First non-empty paragraph from the body (or the YAML `description`
    /// field if present).
    pub description: String,
    /// Optional `argument-hint:` from frontmatter — surfaced as a usage
    /// example in the UI.
    pub argument_hint: Option<String>,
    /// Optional `model:` override from frontmatter.
    pub model: Option<String>,
    /// Absolute on-disk path to the `.md` source.
    pub path: String,
}

/// Walk the standard locations and collect every slash command.
///
/// Order:
///   1. `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/**/*.md`
///   2. `~/.claude/commands/**/*.md`
pub fn list_all_commands() -> Result<Vec<SlashCommand>, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let mut out: Vec<SlashCommand> = Vec::new();

    let plugins_root = home.join(".claude").join("plugins").join("cache");
    if plugins_root.exists() {
        scan_plugins(&plugins_root, &mut out);
    }

    let user_root = home.join(".claude").join("commands");
    if user_root.exists() {
        scan_user(&user_root, &mut out);
    }

    out.sort_by(|a, b| {
        a.marketplace
            .cmp(&b.marketplace)
            .then(a.plugin.cmp(&b.plugin))
            .then(a.name.cmp(&b.name))
    });
    Ok(out)
}

fn scan_plugins(root: &Path, out: &mut Vec<SlashCommand>) {
    // Layout: <root>/<marketplace>/<plugin>/<version>/commands/**/*.md
    let marketplaces = match std::fs::read_dir(root) {
        Ok(it) => it,
        Err(_) => return,
    };
    for mp in marketplaces.flatten() {
        if !mp.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let marketplace = mp.file_name().to_string_lossy().to_string();
        let mp_path = mp.path();
        let plugins = match std::fs::read_dir(&mp_path) {
            Ok(it) => it,
            Err(_) => continue,
        };
        for plugin in plugins.flatten() {
            if !plugin.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let plugin_slug = plugin.file_name().to_string_lossy().to_string();
            let plugin_path = plugin.path();
            // Walk every version dir and pick the most recently modified
            // one as the canonical version for this plugin. The cache
            // usually contains only one version, so this is just a
            // safety net for upgrades that left the old folder around.
            let mut chosen_dir: Option<(PathBuf, std::time::SystemTime)> = None;
            let versions = match std::fs::read_dir(&plugin_path) {
                Ok(it) => it,
                Err(_) => continue,
            };
            for v in versions.flatten() {
                if !v.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let modified = v
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                match &chosen_dir {
                    None => chosen_dir = Some((v.path(), modified)),
                    Some((_, prev)) if modified > *prev => {
                        chosen_dir = Some((v.path(), modified));
                    }
                    _ => {}
                }
            }
            if let Some((version_dir, _)) = chosen_dir {
                let commands_dir = version_dir.join("commands");
                if commands_dir.is_dir() {
                    scan_commands_dir(&commands_dir, &marketplace, &plugin_slug, out);
                }
            }
        }
    }
}

fn scan_user(root: &Path, out: &mut Vec<SlashCommand>) {
    scan_commands_dir(root, "user", "user", out);
}

fn scan_commands_dir(dir: &Path, marketplace: &str, plugin: &str, out: &mut Vec<SlashCommand>) {
    for entry in WalkDir::new(dir).follow_links(false) {
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
        let body = std::fs::read_to_string(path).unwrap_or_default();
        let (description, argument_hint, model) = parse_metadata(&body);
        out.push(SlashCommand {
            name,
            plugin: plugin.to_string(),
            marketplace: marketplace.to_string(),
            description,
            argument_hint,
            model,
            path: path.to_string_lossy().to_string(),
        });
    }
}

/// Parse the YAML frontmatter and the first prose paragraph. Returns
/// `(description, argument_hint, model)`.
///
/// The frontmatter `description:` (when present) wins over the prose. We
/// strip the leading `# Title` heading so the prose is real summary text.
fn parse_metadata(body: &str) -> (String, Option<String>, Option<String>) {
    let mut description_fm: Option<String> = None;
    let mut argument_hint: Option<String> = None;
    let mut model: Option<String> = None;

    let mut prose_start = body;
    let trimmed = body.trim_start();
    if trimmed.starts_with("---") {
        if let Some(end) = trimmed[3..].find("\n---") {
            let fm = &trimmed[3..3 + end];
            for line in fm.lines() {
                let line = line.trim();
                if let Some(rest) = line.strip_prefix("description:") {
                    description_fm = Some(unquote(rest.trim()));
                } else if let Some(rest) = line.strip_prefix("argument-hint:") {
                    argument_hint = Some(unquote(rest.trim()));
                } else if let Some(rest) = line.strip_prefix("model:") {
                    let v = unquote(rest.trim());
                    if !v.is_empty() {
                        model = Some(v);
                    }
                }
            }
            // Body after `---\n...\n---\n`.
            prose_start = &trimmed[3 + end + 4..];
        }
    }

    let description = description_fm.unwrap_or_else(|| extract_prose_summary(prose_start));
    (description, argument_hint, model)
}

fn unquote(s: &str) -> String {
    let trimmed = s.trim();
    if (trimmed.starts_with('"') && trimmed.ends_with('"'))
        || (trimmed.starts_with('\'') && trimmed.ends_with('\''))
    {
        if trimmed.len() >= 2 {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

fn extract_prose_summary(body: &str) -> String {
    let mut paragraph = String::new();
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        if line.starts_with("```") || line.starts_with("<!--") {
            continue;
        }
        if !paragraph.is_empty() {
            paragraph.push(' ');
        }
        paragraph.push_str(line);
        if paragraph.len() > 320 {
            break;
        }
    }
    let trimmed = paragraph.trim();
    if trimmed.len() <= 280 {
        return trimmed.to_string();
    }
    let cut = trimmed.char_indices().nth(277).map(|(i, _)| i).unwrap_or(277);
    format!("{}…", &trimmed[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_frontmatter_description() {
        let body = "---\ndescription: Run the linter.\n---\n\n# Lint\n\nIgnored body.";
        let (desc, hint, model) = parse_metadata(body);
        assert_eq!(desc, "Run the linter.");
        assert!(hint.is_none());
        assert!(model.is_none());
    }

    #[test]
    fn falls_back_to_prose_when_no_frontmatter_description() {
        let body = "---\nname: foo\n---\n\n# Title\n\nReal body line.\nSecond line.\n";
        let (desc, _, _) = parse_metadata(body);
        assert_eq!(desc, "Real body line. Second line.");
    }

    #[test]
    fn pulls_argument_hint_and_model() {
        let body = "---\nargument-hint: '<path>'\nmodel: claude-opus-4\n---\n\nbody";
        let (_, hint, model) = parse_metadata(body);
        assert_eq!(hint.as_deref(), Some("<path>"));
        assert_eq!(model.as_deref(), Some("claude-opus-4"));
    }
}
