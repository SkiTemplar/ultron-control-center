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
/// `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/`.
/// For each `<marketplace>/<plugin>` pair we keep only the installed version
/// dir from `installed_plugins.json` (see `plugin_state::pick_version_dir`;
/// the cache keeps stale commit-hash dirs that do not sort as semver, and an
/// uninstalled plugin's leftover cache is skipped). Each entry carries
/// `disabled = true` when the plugin is turned off in settings.json
/// `enabledPlugins` (key `<plugin>@<marketplace>`): casilla 2.2.
pub(crate) fn plugin_skills_dirs() -> Vec<(bool, PathBuf)> {
    plugin_subdirs("skills")
}

/// Subdirectorio `sub` de la versión instalada de cada plugin,
/// junto a si el plugin está deshabilitado. `skills` da el pool de skills;
/// `commands` da los slash commands, que el enrutador también necesita.
pub(crate) fn plugin_subdirs(sub: &str) -> Vec<(bool, PathBuf)> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let cache = home.join(".claude").join("plugins").join("cache");
    let enabled = crate::plugin_state::read_enabled_plugins();
    let installed = crate::plugin_state::read_installed_paths();
    let mut out = Vec::new();
    let Ok(marketplaces) = std::fs::read_dir(&cache) else {
        return out;
    };
    for mkt_entry in marketplaces.flatten() {
        let mkt_path = mkt_entry.path();
        if !mkt_path.is_dir() {
            continue;
        }
        let marketplace = mkt_entry.file_name().to_string_lossy().to_string();
        let Ok(plugin_names) = std::fs::read_dir(&mkt_path) else {
            continue;
        };
        for pname_entry in plugin_names.flatten() {
            let pname_path = pname_entry.path();
            if !pname_path.is_dir() {
                continue;
            }
            let plugin = pname_entry.file_name().to_string_lossy().to_string();
            let disabled = crate::plugin_state::plugin_is_disabled(&plugin, &marketplace, &enabled);
            let key = format!("{plugin}@{marketplace}");
            if let Some(version) =
                crate::plugin_state::pick_version_dir(&pname_path, &key, installed.as_ref())
            {
                let dir = version.join(sub);
                if dir.is_dir() {
                    out.push((disabled, dir));
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
/// **Disabled detection** — only one convention keeps a skill out of the session:
///   1. Suffix `.disabled` on the folder itself (e.g. `kotlin-patterns.disabled`).
///      Legacy and NOT disabled: Claude Code ignores the suffix and loads its
///      `SKILL.md` in every session, so it is reported as `enabled = true` (it
///      is active) and the toggle never writes this form.
///   2. `_disabled/` container parent — the preferred convention since
///      2026-09-06 and the one the toggle writes; Claude Code does not descend
///      into it, so the skill stays out of the session (`enabled = false`).
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

    // A `.disabled` suffix does not stop Claude Code from loading the skill.
    let enabled = !in_disabled_dir;

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
    plugin_disabled: bool,
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

        // Preferred convention (since 2026-09-06): `_disabled/` container.
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

        // Legacy `.disabled` suffix on the folder itself: Claude Code still
        // loads it, so it is listed as an active skill (`read_skill_meta`
        // strips the suffix from the logical name and reports it enabled).

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
            // Plugin disabled in settings.json => its skills are inert (2.2).
            enabled: enabled && !plugin_disabled,
        });
    }
    out
}

/// Slash commands de plugins (`<plugin>/<version>/commands/<name>.md`) como
/// entradas de catálogo.
///
/// El enrutador los necesita: `/commit` o `/code-review` son tan invocables
/// como una skill, pero no viven en `skills/<name>/SKILL.md` y por eso el
/// catálogo los ignoraba. Medido el 2026-08-27 sobre 10 prompts reales, tres
/// (commit, push, review de código) no tenían NINGÚN candidato posible por
/// esto: no era el retriever fallando, era una opción que no existía.
///
/// El nombre se cualifica con el plugin (`commit-commands:commit`) porque es
/// así como se invoca, y porque dos plugins pueden traer un `commit.md` cada
/// uno.
pub fn plugin_command_entries() -> Vec<SkillEntry> {
    let mut out = Vec::new();
    for (plugin_disabled, dir) in plugin_subdirs("commands") {
        // `<marketplace>/<plugin>/<version>/commands` → el plugin está tres
        // niveles por encima del directorio de comandos.
        let plugin = dir
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            let Ok(contents) = std::fs::read_to_string(&path) else {
                continue;
            };
            let description = frontmatter_description(&contents);
            if description.trim().is_empty() {
                continue;
            }
            let name = if plugin.is_empty() {
                stem.to_string()
            } else {
                format!("{plugin}:{stem}")
            };
            out.push(SkillEntry {
                name,
                path: path.to_string_lossy().to_string(),
                description,
                origin: SkillOrigin::Plugin,
                enabled: !plugin_disabled,
            });
        }
    }
    out
}

/// `description:` del frontmatter YAML de un fichero markdown, con el mismo
/// soporte de block scalars que `read_skill_meta`. Vacío si no hay frontmatter
/// o no declara descripción.
pub(crate) fn frontmatter_description(contents: &str) -> String {
    let trimmed = contents.trim_start();
    let Some(after_fence) = trimmed.strip_prefix("---") else {
        return String::new();
    };
    let Some(end) = after_fence.find("\n---") else {
        return String::new();
    };
    let block = &after_fence[..end];
    let lines: Vec<&str> = block.lines().collect();
    for (i, raw) in lines.iter().enumerate() {
        if let Some(rest) = raw.trim().strip_prefix("description:") {
            return parse_yaml_description(rest, &lines[i + 1..]);
        }
    }
    String::new()
}

pub fn list_skills_with_origin_inner(
    project_path: Option<String>,
) -> Result<Vec<SkillEntry>, String> {
    let mut out = Vec::new();
    if let Ok(g) = global_skills_dir() {
        out.extend(collect_skills_from(&g, SkillOrigin::Global, true, false));
    }
    if let Some(p) = project_path.as_deref() {
        let pdir = project_skills_dir(p);
        out.extend(collect_skills_from(
            &pdir,
            SkillOrigin::Project,
            true,
            false,
        ));
    }
    for (disabled, plugin_dir) in plugin_skills_dirs() {
        out.extend(collect_skills_from(
            &plugin_dir,
            SkillOrigin::Plugin,
            false,
            disabled,
        ));
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
/// | Container (preferred since 2026-09-06) | `skills/<name>/` | `skills/_disabled/<name>/` |
/// | Suffix (legacy, never written) | `skills/<name>/` or `skills/<name>.disabled/` | — |
///
/// Toggle resolution order (for enabling):
///   1. Look for `<name>.disabled/` (legacy suffix) — rename to `<name>/`.
///   2. Look for `_disabled/<name>/` (container) — rename to `<name>/`.
///
/// Toggle resolution order (for disabling):
///   1. Look for `<name>/` or `<name>.disabled/` — move to `_disabled/<name>/`.
///
/// Disabling always writes the container. Claude Code lists every
/// `<name>.disabled/SKILL.md` in the session context (~3k tokens for 85 lazy
/// skills), so a suffixed folder is active, but it does not descend into
/// `_disabled/<name>/`: the container is the only form that keeps a skill out
/// of the session (it stays on disk for a direct Read or a later toggle).
pub fn skill_toggle_inner(name: String, enabled: bool) -> Result<SkillEntry, String> {
    skill_toggle_at(&global_skills_dir()?, name, enabled)
}

/// Core del toggle con el root INYECTABLE — separado de `skill_toggle_inner`
/// para poder testearlo hermético contra un tempdir (0 tests del backend de la
/// Skills tab hasta 2026-07-03; la lógica y las convenciones no cambian).
pub(crate) fn skill_toggle_at(
    root: &std::path::Path,
    name: String,
    enabled: bool,
) -> Result<SkillEntry, String> {
    // Path traversal guard: name must not contain path separators.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid skill name: path separators not allowed".to_string());
    }

    let paths = TogglePaths {
        enabled: root.join(&name),
        suffix: root.join(format!("{}.disabled", name)),
        container: root.join("_disabled").join(&name),
    };
    if enabled {
        enable_skill(&paths, &name)
    } else {
        disable_skill(&paths, &name)
    }
}

/// Candidate paths of a global skill under each on-disk convention.
struct TogglePaths {
    enabled: std::path::PathBuf,
    suffix: std::path::PathBuf,
    container: std::path::PathBuf,
}

fn moved_entry(to: &std::path::Path) -> SkillEntry {
    let (n, desc, e, _) = read_skill_meta(to);
    SkillEntry {
        name: n,
        path: to.to_string_lossy().to_string(),
        description: desc,
        origin: SkillOrigin::Global,
        enabled: e,
    }
}

/// Enabling: rename whichever other form exists to `<name>/`. A legacy
/// `<name>.disabled/` already loads; renaming it only normalises the name.
fn enable_skill(p: &TogglePaths, name: &str) -> Result<SkillEntry, String> {
    let from = if p.suffix.exists() {
        &p.suffix
    } else if p.container.exists() {
        &p.container
    } else {
        return Err(format!(
            "skill '{name}' not found in disabled state (checked {name}.disabled and _disabled/{name})"
        ));
    };
    if p.enabled.exists() {
        return Err(format!("skill '{name}' already exists at enabled path"));
    }
    std::fs::rename(from, &p.enabled)
        .map_err(|e| format!("rename {:?} → {:?}: {e}", from, p.enabled))?;
    Ok(moved_entry(&p.enabled))
}

/// Disabling: always write the container convention. A legacy
/// `<name>.disabled/` is active too (Claude Code loads it), so it is a valid
/// source; with both forms on disk the choice is left to the person.
fn disable_skill(p: &TogglePaths, name: &str) -> Result<SkillEntry, String> {
    if p.container.exists() {
        return Err(format!("skill '{name}' already disabled"));
    }
    let from = match (p.enabled.exists(), p.suffix.exists()) {
        (true, false) => &p.enabled,
        (false, true) => &p.suffix,
        (true, true) => {
            return Err(format!(
                "skill '{name}' exists as both {name}/ and {name}.disabled/ and both load: keep one by hand"
            ))
        }
        (false, false) => return Err(format!("skill '{name}' not found at enabled path")),
    };
    if let Some(container) = p.container.parent() {
        std::fs::create_dir_all(container)
            .map_err(|e| format!("create_dir_all {:?}: {e}", container))?;
    }
    std::fs::rename(from, &p.container)
        .map_err(|e| format!("rename {:?} → {:?}: {e}", from, p.container))?;
    Ok(moved_entry(&p.container))
}

/// Enable or disable many global skills in one call. `disabled = true` moves
/// each `<name>/` to `_disabled/<name>/`; `disabled = false` reverses it.
///
/// Loops the existing `skill_toggle_inner` so the on-disk conventions stay
/// identical to the single-item path. Failures are collected per-item rather
/// than aborting the whole batch — one already-disabled skill must not block
/// the rest of the selection.
pub fn skills_bulk_toggle_inner(
    names: Vec<String>,
    disabled: bool,
) -> Result<BulkToggleResult, String> {
    skills_bulk_toggle_at(&global_skills_dir()?, names, disabled)
}

/// Core del bulk con root inyectable (mismo motivo que `skill_toggle_at`).
pub(crate) fn skills_bulk_toggle_at(
    root: &std::path::Path,
    names: Vec<String>,
    disabled: bool,
) -> Result<BulkToggleResult, String> {
    let enabled = !disabled;
    let mut outcomes: Vec<BulkToggleOutcome> = Vec::with_capacity(names.len());
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    for name in &names {
        match skill_toggle_at(root, name.clone(), enabled) {
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

#[cfg(test)]
mod toggle_tests {
    use super::*;

    /// Crea `<root>/<dir_name>/SKILL.md` con frontmatter valido.
    fn make_skill(root: &std::path::Path, dir_name: &str) {
        let d = root.join(dir_name);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("SKILL.md"),
            "---\nname: test-skill\ndescription: skill de prueba hermetica\n---\ncuerpo\n",
        )
        .unwrap();
    }

    #[test]
    fn disable_moves_to_container_convention() {
        let tmp = tempfile::tempdir().unwrap();
        make_skill(tmp.path(), "alpha");
        let entry = skill_toggle_at(tmp.path(), "alpha".into(), false).unwrap();
        assert!(!entry.enabled);
        assert!(tmp.path().join("_disabled").join("alpha").is_dir());
        assert!(!tmp.path().join("alpha.disabled").exists());
        assert!(!tmp.path().join("alpha").exists());
    }

    #[test]
    fn enable_restores_from_suffix_and_from_legacy() {
        let tmp = tempfile::tempdir().unwrap();
        // Convencion sufijo.
        make_skill(tmp.path(), "beta.disabled");
        let e = skill_toggle_at(tmp.path(), "beta".into(), true).unwrap();
        assert!(e.enabled);
        assert!(tmp.path().join("beta").is_dir());
        // Convencion contenedor `_disabled/<name>` (la preferida).
        make_skill(&tmp.path().join("_disabled"), "gamma");
        let e2 = skill_toggle_at(tmp.path(), "gamma".into(), true).unwrap();
        assert!(e2.enabled);
        assert!(tmp.path().join("gamma").is_dir());
        assert!(!tmp.path().join("_disabled").join("gamma").exists());
    }

    #[test]
    fn suffix_disabled_dir_counts_as_active_because_claude_code_loads_it() {
        // Claude Code no mira el sufijo: `<name>.disabled/SKILL.md` entra en
        // la sesión. La pestaña no puede pintarla como desactivada.
        let tmp = tempfile::tempdir().unwrap();
        make_skill(tmp.path(), "eps.disabled");
        let (name, _, enabled, valid) = read_skill_meta(&tmp.path().join("eps.disabled"));
        assert_eq!(name, "eps");
        assert!(enabled, "una carpeta .disabled carga: cuenta como activa");
        assert!(valid);
        let listed = collect_skills_from(tmp.path(), SkillOrigin::Global, false, false);
        assert!(
            listed.iter().any(|s| s.name == "eps" && s.enabled),
            "también aparece entre las activas"
        );
        // El contenedor `_disabled/<name>/` sí queda fuera de la sesión.
        make_skill(&tmp.path().join("_disabled"), "eta");
        let (_, _, enabled, _) = read_skill_meta(&tmp.path().join("_disabled").join("eta"));
        assert!(!enabled);
    }

    #[test]
    fn disabling_a_suffix_skill_moves_it_to_the_container() {
        let tmp = tempfile::tempdir().unwrap();
        make_skill(tmp.path(), "zeta.disabled");
        let entry = skill_toggle_at(tmp.path(), "zeta".into(), false).unwrap();
        assert!(!entry.enabled);
        assert!(tmp.path().join("_disabled").join("zeta").is_dir());
        assert!(!tmp.path().join("zeta.disabled").exists());
        // Desactivar otra vez: ya está en el contenedor.
        let err = skill_toggle_at(tmp.path(), "zeta".into(), false).unwrap_err();
        assert!(err.contains("already disabled"), "{err}");
    }

    #[test]
    fn rejects_path_traversal_names() {
        let tmp = tempfile::tempdir().unwrap();
        for evil in ["../evil", "a/b", r"a\b", ".."] {
            let err = skill_toggle_at(tmp.path(), evil.to_string(), false).unwrap_err();
            assert!(err.contains("path separators"), "{evil}: {err}");
        }
    }

    #[test]
    fn negative_disable_missing_and_enable_conflict() {
        let tmp = tempfile::tempdir().unwrap();
        // Disable de un skill inexistente -> Err.
        assert!(skill_toggle_at(tmp.path(), "nope".into(), false).is_err());
        // Enable de un skill sin forma disabled -> Err.
        assert!(skill_toggle_at(tmp.path(), "nope".into(), true).is_err());
        // Enable cuando el path enabled YA existe -> Err (no pisa nada).
        make_skill(tmp.path(), "delta");
        make_skill(tmp.path(), "delta.disabled");
        let err = skill_toggle_at(tmp.path(), "delta".into(), true).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        // Ambos siguen en disco (no se destruyo nada).
        assert!(tmp.path().join("delta").is_dir());
        assert!(tmp.path().join("delta.disabled").is_dir());
    }

    #[test]
    fn bulk_toggle_collects_per_item_failures_without_aborting() {
        let tmp = tempfile::tempdir().unwrap();
        make_skill(tmp.path(), "ok1");
        make_skill(tmp.path(), "ok2");
        let r = skills_bulk_toggle_at(
            tmp.path(),
            vec!["ok1".into(), "missing".into(), "ok2".into()],
            true, // disabled=true -> deshabilitar
        )
        .unwrap();
        assert_eq!(r.requested, 3);
        assert_eq!(r.succeeded, 2);
        assert_eq!(r.failed, 1);
        // El fallo esta identificado y NO aborto el resto.
        let bad = r.outcomes.iter().find(|o| o.name == "missing").unwrap();
        assert!(!bad.ok);
        assert!(tmp.path().join("_disabled").join("ok1").is_dir());
        assert!(tmp.path().join("_disabled").join("ok2").is_dir());
    }
}
