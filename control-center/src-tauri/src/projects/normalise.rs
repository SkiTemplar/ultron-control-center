// projects/normalise.rs — Normalisation helpers for provider, shell, and IDE fields.

/// Allowed values for `Project.default_provider`. Centralised so backend
/// commands (set_default_provider, create_project, update_project) and the
/// load-time normaliser stay in lock-step.
pub(crate) const VALID_PROVIDERS: &[&str] = &["claude", "codex"];

/// fb-016 — allowed values for `Project.default_shell`. Anything outside
/// the allowlist collapses to None at load time so the PTY layer falls
/// back to the global default. Aliases ("pwsh" -> "powershell") accepted
/// in the normaliser below.
pub(crate) const VALID_SHELLS: &[&str] = &["powershell", "powershell-admin", "cmd", "bash"];

/// Allowed values for the per-project preferred IDE. Used by the editor
/// modal dropdown and consumed by `open_project_in_ide` to skip auto-detect.
/// Legacy values (e.g. "external", "app", "game", anything else) collapse
/// to `None` at load time so the row falls back to the auto-detect path.
pub(crate) const VALID_IDES: &[&str] = &[
    "vscode",
    "cursor",
    "code-insiders",
    "intellij",
    "rider",
    "webstorm",
    "pycharm",
    "clion",
    "androidstudio",
    "fleet",
    "nvim",
    "sublime",
    "zed",
];

/// fb-016 — coerce a raw `default_shell` to one of the four supported
/// shells or None. Accepts a small set of aliases so manually-edited
/// registries keep working ("pwsh" -> "powershell", "powershell admin"
/// with spaces, etc).
pub(crate) fn normalise_shell(raw: Option<&str>) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let lower = s.to_ascii_lowercase();
    let canonical = match lower.as_str() {
        "powershell" | "pwsh" | "ps" => Some("powershell"),
        "powershell-admin" | "powershell admin" | "pwsh-admin" | "admin" => {
            Some("powershell-admin")
        }
        "cmd" | "cmd.exe" => Some("cmd"),
        "bash" | "git-bash" | "wsl" => Some("bash"),
        _ => None,
    };
    canonical.map(|s| s.to_string()).or_else(|| {
        if VALID_SHELLS.contains(&lower.as_str()) {
            Some(lower)
        } else {
            None
        }
    })
}

/// v2.7.2 — coerce a raw project colour to a canonical lowercase `#rrggbb`
/// string, or `None`. Accepts the shorthand forms users actually type: with
/// or without the leading `#`, and 3-digit hex (`#0af` -> `#00aaff`).
/// Anything else (named colours, rgb(), garbage) collapses to `None` so a
/// bad value degrades to "no colour" instead of poisoning the theme
/// generator downstream.
pub(crate) fn normalise_color(raw: Option<&str>) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let hex = s.strip_prefix('#').unwrap_or(s).to_ascii_lowercase();
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    match hex.len() {
        6 => Some(format!("#{hex}")),
        3 => {
            let expanded: String = hex.chars().flat_map(|c| [c, c]).collect();
            Some(format!("#{expanded}"))
        }
        _ => None,
    }
}

pub(crate) fn normalise_provider(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            let lower = s.to_ascii_lowercase();
            if VALID_PROVIDERS.contains(&lower.as_str()) {
                lower
            } else {
                "claude".to_string()
            }
        }
        None => "claude".to_string(),
    }
}

/// Coerce a raw `ide` field from projects.json to one of the supported
/// editor slugs or `None`. We accept a few aliases ("code" -> vscode,
/// "vs code" -> vscode) so manually-edited registry files keep working.
pub(crate) fn normalise_ide(raw: Option<&str>) -> Option<String> {
    let s = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let lower = s.to_ascii_lowercase();
    let canonical = match lower.as_str() {
        "vscode" | "vs code" | "code" => Some("vscode"),
        "cursor" => Some("cursor"),
        "code-insiders" | "code insiders" | "vscode-insiders" | "insiders" => Some("code-insiders"),
        "intellij" | "idea" | "intellij idea" => Some("intellij"),
        "rider" => Some("rider"),
        "webstorm" => Some("webstorm"),
        "pycharm" => Some("pycharm"),
        "clion" | "c-lion" | "c lion" => Some("clion"),
        "androidstudio" | "android studio" | "android-studio" => Some("androidstudio"),
        "fleet" => Some("fleet"),
        "nvim" | "neovim" => Some("nvim"),
        "sublime" | "sublime text" | "subl" => Some("sublime"),
        "zed" => Some("zed"),
        _ => None,
    };
    canonical.map(|s| s.to_string()).or_else(|| {
        // Pass through anything else that already happens to be in the
        // allowlist (defensive — covers future additions to VALID_IDES).
        if VALID_IDES.contains(&lower.as_str()) {
            Some(lower)
        } else {
            None
        }
    })
}
