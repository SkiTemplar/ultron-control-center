// skills/origin.rs — Origin-aware skill listing and toggle operations.
//
// New `SkillEntry` type that surfaces the *origin* of every skill (global /
// project / plugin) so the Skills.tsx viewer can paint scope chips and let
// the user toggle global skills on/off via a rename to `_disabled/`. Lives
// next to the registry-driven `SkillInfo` (still used by the older preview
// + CRUD path) — both coexist until the frontend is fully migrated.

use std::path::PathBuf;

use super::types::{BulkToggleOutcome, BulkToggleResult, SkillEntry, SkillOrigin};

pub(crate) fn global_skills_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("no home dir")?;
    Ok(home.join(".claude").join("skills"))
}

pub(crate) fn project_skills_dir(project_path: &str) -> PathBuf {
    PathBuf::from(project_path).join(".claude").join("skills")
}

/// Plugin skills live three levels deep:
/// `~/.claude/plugins/cache/<plugin-id>/<plugin-name>/<version>/skills/`.
/// For each `<plugin-id>/<plugin-name>` pair we keep only the latest
/// version dir (sorted lexicographically descending — works for stable
/// semver tags; `-rc`/`-alpha` suffixes fall back to a sane lex order).
pub(crate) fn plugin_skills_dirs() -> Vec<PathBuf> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let cache = home.join(".claude").join("plugins").join("cache");
    let mut out = Vec::new();
    let Ok(plugin_ids) = std::fs::read_dir(&cache) else {
        return out;
    };
    for pid_entry in plugin_ids.flatten() {
        let pid_path = pid_entry.path();
        if !pid_path.is_dir() {
            continue;
        }
        let Ok(plugin_names) = std::fs::read_dir(&pid_path) else {
            continue;
        };
        for pname_entry in plugin_names.flatten() {
            let pname_path = pname_entry.path();
            if !pname_path.is_dir() {
                continue;
            }
            // Collect version dirs, keep the lex-desc latest.
            let mut versions: Vec<PathBuf> = match std::fs::read_dir(&pname_path) {
                Ok(rd) => rd
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| p.is_dir())
                    .collect(),
                Err(_) => continue,
            };
            versions.sort_by(|a, b| {
                let an = a.file_name().and_then(|s| s.to_str()).unwrap_or("");
                let bn = b.file_name().and_then(|s| s.to_str()).unwrap_or("");
                bn.cmp(an)
            });
            if let Some(latest) = versions.first() {
                let skills = latest.join("skills");
                if skills.is_dir() {
                    out.push(skills);
                }
            }
        }
    }
    out
}

/// Resolve a YAML `description:` value, supporting both the inline form and
/// block scalars. ULTRON personas (`alfred`, `terry-davis`, `tio-gilito`, …)
/// and several long technical skills (`ui-ux-pro-max`, `senior-engineer`, …)
/// declare their description as a folded (`>`) or literal (`|`) block scalar
/// spanning many indented lines. Reading only the first line dropped 26 active
/// skills from the catalog (empty description → `is_valid_skill = false`).
///
/// - Inline: `description: some text`  → returns `some text` (quote-trimmed).
/// - Block (`>`, `|`, with optional `-`/`+` chomp): folds the following lines
///   that are MORE indented than the `description:` key, joining them with a
///   single space (folded semantics are good enough for embedding; we don't
///   need to preserve hard line breaks for a one-line passage).
pub(crate) fn parse_yaml_description(after_key: &str, following: &[&str]) -> String {
    let head = after_key.trim();
    let is_block = matches!(head, ">" | "|" | ">-" | "|-" | ">+" | "|+");
    if !is_block {
        return head.trim_matches(|c| c == '"' || c == '\'').to_string();
    }
    // Block scalar: collect subsequent lines that are indented (i.e. belong to
    // the value), stopping at the first non-indented, non-empty line (the next
    // top-level key such as `kind:` / `tier:`).
    let mut parts: Vec<String> = Vec::new();
    for raw in following {
        if raw.trim().is_empty() {
            continue; // blank line inside a block scalar → paragraph break
        }
        let indented = raw.starts_with(' ') || raw.starts_with('\t');
        if !indented {
            break; // back to column 0 → next YAML key, value is done
        }
        parts.push(raw.trim().to_string());
    }
    parts.join(" ")
}

/// Parse `(name, description, enabled, is_valid_skill)` from a skill dir.
///
/// A real skill is a DIRECTORY containing `SKILL.md` whose YAML frontmatter
/// declares at least `name:` and `description:`. Anything else is rejected
/// as a false positive.
///
/// **Disabled detection** — two conventions are supported in parallel:
///   1. Suffix `.disabled` on the folder itself (e.g. `kotlin-patterns.disabled`).
///      This is what `Rename-Item` produces on Windows and what the new toggle
///      logic writes.
///   2. Legacy `_disabled/` subdirectory parent — kept for backwards compat
///      with old toggle logic that moved folders into a `_disabled` container.
pub(crate) fn read_skill_meta(dir: &std::path::Path) -> (String, String, bool, bool) {
    let raw_dir_name = dir
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("(unnamed)");

    // Convention 1: suffix `.disabled`
    let has_suffix = raw_dir_name.ends_with(".disabled");
    // Convention 2: parent dir named `_disabled`
    let in_disabled_dir = dir
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .map(|s| s == "_disabled")
        .unwrap_or(false);

    let enabled = !has_suffix && !in_disabled_dir;

    // The logical name strips the `.disabled` suffix so the UI always shows
    // the clean skill name regardless of enabled state.
    let name = if has_suffix {
        raw_dir_name
            .strip_suffix(".disabled")
            .unwrap_or(raw_dir_name)
            .to_string()
    } else {
        raw_dir_name.to_string()
    };

    let skill_md = dir.join("SKILL.md");
    if !skill_md.is_file() {
        return (name, String::new(), enabled, false);
    }
    let contents = match std::fs::read_to_string(&skill_md) {
        Ok(c) => c,
        Err(_) => return (name, String::new(), enabled, false),
    };
    // Require a YAML frontmatter with at least name + description.
    let trimmed = contents.trim_start();
    let mut has_name = false;
    let mut description = String::new();
    if let Some(after_fence) = trimmed.strip_prefix("---") {
        if let Some(end) = after_fence.find("\n---") {
            let block = &after_fence[..end];
            let lines: Vec<&str> = block.lines().collect();
            for (i, raw) in lines.iter().enumerate() {
                let t = raw.trim();
                if let Some(rest) = t.strip_prefix("name:") {
                    if !rest.trim().is_empty() {
                        has_name = true;
                    }
                } else if let Some(rest) = t.strip_prefix("description:") {
                    description = parse_yaml_description(rest, &lines[i + 1..]);
                }
            }
        }
    }
    let is_valid_skill = has_name && !description.trim().is_empty();
    (name, description, enabled, is_valid_skill)
}

pub(crate) fn collect_skills_from(
    root: &std::path::Path,
    origin: SkillOrigin,
    include_disabled: bool,
) -> Vec<SkillEntry> {
    let mut out = Vec::new();
    if !root.exists() {
        return out;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for e in entries.flatten() {
        let path = e.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");

        // Legacy convention: `_disabled/` container directory.
        // Recurse into it and surface each child as a disabled skill.
        if dir_name == "_disabled" {
            if include_disabled {
                if let Ok(disabled) = std::fs::read_dir(&path) {
                    for d in disabled.flatten() {
                        let dp = d.path();
                        if dp.is_dir() {
                            let (n, desc, _, valid) = read_skill_meta(&dp);
                            if !valid {
                                continue;
                            }
                            out.push(SkillEntry {
                                name: n,
                                path: dp.to_string_lossy().to_string(),
                                description: desc,
                                origin: origin.clone(),
                                enabled: false,
                            });
                        }
                    }
                }
            }
            continue;
        }

        // Convention 1: `.disabled` suffix on the folder itself.
        // `read_skill_meta` strips the suffix from the logical name and sets
        // `enabled = false` so we only need to gate on `include_disabled`.
        let has_disabled_suffix = dir_name.ends_with(".disabled");
        if has_disabled_suffix && !include_disabled {
            continue;
        }

        let (n, desc, enabled, valid) = read_skill_meta(&path);
        if !valid {
            // Skip directories without a SKILL.md or without the required
            // YAML frontmatter (`name:` + `description:`). Prevents random
            // markdown subfolders from being surfaced as skills.
            continue;
        }
        out.push(SkillEntry {
            name: n,
            path: path.to_string_lossy().to_string(),
            description: desc,
            origin: origin.clone(),
            enabled,
        });
    }
    out
}

pub fn list_skills_with_origin_inner(
    project_path: Option<String>,
) -> Result<Vec<SkillEntry>, String> {
    let mut out = Vec::new();
    if let Ok(g) = global_skills_dir() {
        out.extend(collect_skills_from(&g, SkillOrigin::Global, true));
    }
    if let Some(p) = project_path.as_deref() {
        let pdir = project_skills_dir(p);
        out.extend(collect_skills_from(&pdir, SkillOrigin::Project, true));
    }
    for plugin_dir in plugin_skills_dirs() {
        out.extend(collect_skills_from(&plugin_dir, SkillOrigin::Plugin, false));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// Toggle a global skill between enabled and disabled.
///
/// **Two on-disk conventions are supported:**
///
/// | Convention | Enabled path | Disabled path |
/// |------------|--------------|---------------|
/// | Suffix (preferred, `Rename-Item` output) | `skills/<name>/` | `skills/<name>.disabled/` |
/// | Legacy container | `skills/<name>/` | `skills/_disabled/<name>/` |
///
/// Toggle resolution order (for enabling):
///   1. Look for `<name>.disabled/` (suffix convention) — rename to `<name>/`.
///   2. Look for `_disabled/<name>/` (legacy) — rename to `<name>/`.
///
/// Toggle resolution order (for disabling):
///   1. Look for `<name>/` — rename to `<name>.disabled/` (suffix convention).
///
/// Disabling always writes the suffix convention going forward. That keeps the
/// output consistent with what `Rename-Item` produces on Windows.
pub fn skill_toggle_inner(name: String, enabled: bool) -> Result<SkillEntry, String> {
    // Path traversal guard: name must not contain path separators.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid skill name: path separators not allowed".to_string());
    }

    let root = global_skills_dir()?;

    // Candidate paths for each convention.
    let path_enabled = root.join(&name);
    let path_suffix_disabled = root.join(format!("{}.disabled", name));
    let path_legacy_disabled = root.join("_disabled").join(&name);

    if enabled {
        // Re-enabling: find whichever disabled form exists.
        let from = if path_suffix_disabled.exists() {
            path_suffix_disabled
        } else if path_legacy_disabled.exists() {
            path_legacy_disabled
        } else {
            return Err(format!(
                "skill '{name}' not found in disabled state (checked {}.disabled and _disabled/{name})",
                name
            ));
        };
        if path_enabled.exists() {
            return Err(format!("skill '{name}' already exists at enabled path"));
        }
        std::fs::rename(&from, &path_enabled)
            .map_err(|e| format!("rename {:?} → {:?}: {e}", from, path_enabled))?;
        let (n, desc, e, _) = read_skill_meta(&path_enabled);
        return Ok(SkillEntry {
            name: n,
            path: path_enabled.to_string_lossy().to_string(),
            description: desc,
            origin: SkillOrigin::Global,
            enabled: e,
        });
    }

    // Disabling: always write the suffix convention.
    if !path_enabled.exists() {
        return Err(format!("skill '{name}' not found at enabled path"));
    }
    if path_suffix_disabled.exists() {
        return Err(format!(
            "skill '{name}' already disabled (suffix path exists)"
        ));
    }
    std::fs::rename(&path_enabled, &path_suffix_disabled).map_err(|e| {
        format!(
            "rename {:?} → {:?}: {e}",
            path_enabled, path_suffix_disabled
        )
    })?;
    let (n, desc, e, _) = read_skill_meta(&path_suffix_disabled);
    Ok(SkillEntry {
        name: n,
        path: path_suffix_disabled.to_string_lossy().to_string(),
        description: desc,
        origin: SkillOrigin::Global,
        enabled: e,
    })
}

/// Enable or disable many global skills in one call. `disabled = true` moves
/// each `<name>/` to `<name>.disabled/`; `disabled = false` reverses it.
///
/// Loops the existing `skill_toggle_inner` so the on-disk conventions stay
/// identical to the single-item path. Failures are collected per-item rather
/// than aborting the whole batch — one already-disabled skill must not block
/// the rest of the selection.
pub fn skills_bulk_toggle_inner(
    names: Vec<String>,
    disabled: bool,
) -> Result<BulkToggleResult, String> {
    let enabled = !disabled;
    let mut outcomes: Vec<BulkToggleOutcome> = Vec::with_capacity(names.len());
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    for name in &names {
        match skill_toggle_inner(name.clone(), enabled) {
            Ok(_) => {
                succeeded += 1;
                outcomes.push(BulkToggleOutcome {
                    name: name.clone(),
                    ok: true,
                    error: None,
                });
            }
            Err(e) => {
                failed += 1;
                outcomes.push(BulkToggleOutcome {
                    name: name.clone(),
                    ok: false,
                    error: Some(e),
                });
            }
        }
    }
    Ok(BulkToggleResult {
        requested: names.len(),
        succeeded,
        failed,
        outcomes,
    })
}
