// claude_theme.rs — per-project Claude Code colour themes.
//
// Claude Code reads custom themes from `~/.claude/themes/<slug>.json` with
// the shape `{ "name": ..., "base": "dark"|"light", "overrides": { ... } }`
// and a session selects one via the `theme` setting set to `custom:<slug>`,
// where `<slug>` is the file name without the extension (verified against
// the CLI binary: the loader is called with the file slug and `name` is a
// display label only).
//
// So: a project with an accent colour gets a generated theme file and its
// sessions are spawned with `--settings '{"theme":"custom:<slug>"}'`. The
// terminal background is untouched (the user keeps pure black) — only
// Claude's own accent colours change, which is exactly what `/theme` does.

use std::fs;
use std::path::PathBuf;

/// Prefix for every generated file, so a stray theme is obviously ours and
/// never collides with a hand-written one (`ultron.json`, `ultron-blue.json`).
const SLUG_PREFIX: &str = "ultron-proj-";

/// Sanitise a project id into something safe as a file name AND as a value
/// interpolated into the spawn payload: lowercase ascii alnum plus `-`.
fn sanitise_id(project_id: &str) -> String {
    let mut out = String::with_capacity(project_id.len());
    let mut last_dash = false;
    for ch in project_id.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.chars().take(48).collect()
}

/// `#rrggbb` -> (r, g, b). Returns None for anything else — callers treat
/// that as "no colour" rather than substituting a default, so a bad value
/// never silently repaints a session.
fn parse_hex(hex: &str) -> Option<(u8, u8, u8)> {
    let h = hex.strip_prefix('#')?;
    if h.len() != 6 || !h.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some((
        u8::from_str_radix(&h[0..2], 16).ok()?,
        u8::from_str_radix(&h[2..4], 16).ok()?,
        u8::from_str_radix(&h[4..6], 16).ok()?,
    ))
}

fn to_hex((r, g, b): (u8, u8, u8)) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Linear blend towards black (`factor` < 1) or white (`factor` > 1),
/// clamped. Used to derive the border / auto-accept shades from the single
/// colour the user picked, so they never have to choose eleven hexes.
fn shade(rgb: (u8, u8, u8), factor: f32) -> (u8, u8, u8) {
    let f = |c: u8| -> u8 {
        let v = if factor <= 1.0 {
            c as f32 * factor
        } else {
            let head = 255.0 - c as f32;
            c as f32 + head * (factor - 1.0)
        };
        v.round().clamp(0.0, 255.0) as u8
    };
    (f(rgb.0), f(rgb.1), f(rgb.2))
}

pub fn themes_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("themes"))
}

/// Write (or refresh) the theme file for a project and return the value to
/// put in `settings.theme` — `custom:<slug>`.
///
/// Idempotent and cheap: it rewrites the file on every spawn so editing the
/// colour in the project modal is reflected in the next session without any
/// extra bookkeeping. Errors are returned, not swallowed — the caller drops
/// the theme and spawns a normal session rather than failing the launch.
pub fn ensure_project_theme(
    project_id: &str,
    display_name: &str,
    hex: &str,
) -> Result<String, String> {
    let rgb = parse_hex(hex).ok_or_else(|| format!("colour is not #rrggbb: {hex}"))?;
    let id = sanitise_id(project_id);
    if id.is_empty() {
        return Err(format!("project id has no usable characters: {project_id}"));
    }
    let slug = format!("{SLUG_PREFIX}{id}");
    let dir = themes_dir().ok_or_else(|| "no HOME".to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let label = if display_name.trim().is_empty() {
        format!("ULTRON {id}")
    } else {
        format!("ULTRON {}", display_name.trim())
    };

    // Same override keys the hand-written ULTRON themes use, so the two
    // families stay visually consistent. Only the accent-derived ones move
    // with the project colour; success/error/warning stay semantic (a green
    // "success" must not turn red because the project is red).
    let theme = serde_json::json!({
        "name": label,
        "base": "dark",
        "overrides": {
            "claude": to_hex(rgb),
            "planMode": to_hex(rgb),
            "autoAccept": to_hex(shade(rgb, 0.82)),
            "promptBorder": to_hex(shade(rgb, 0.5)),
            "success": "#3ddc84",
            "error": "#ff5555",
            "warning": "#ffb86c",
            "bashBorder": "#5c5c66",
            "suggestion": "#9aa0a6",
            "diffAdded": "#1f3d2b",
            "diffRemoved": "#42212a"
        }
    });

    let path = dir.join(format!("{slug}.json"));
    let body = serde_json::to_string_pretty(&theme).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, format!("{body}\n")).map_err(|e| format!("write {}: {e}", path.display()))?;
    Ok(format!("custom:{slug}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitises_ids_into_safe_slugs() {
        assert_eq!(sanitise_id("legacy-fc"), "legacy-fc");
        assert_eq!(sanitise_id("Legacy FC"), "legacy-fc");
        assert_eq!(sanitise_id("../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitise_id("__home"), "home");
    }

    #[test]
    fn rejects_ids_with_no_usable_characters() {
        assert_eq!(sanitise_id("///"), "");
        let err = ensure_project_theme("///", "x", "#38bdf8").unwrap_err();
        assert!(err.contains("no usable characters"), "got: {err}");
    }

    #[test]
    fn rejects_malformed_colours() {
        assert!(parse_hex("#38bdf8").is_some());
        assert!(parse_hex("38bdf8").is_none());
        assert!(parse_hex("#38bdf").is_none());
        assert!(parse_hex("#gggggg").is_none());
        let err = ensure_project_theme("demo", "Demo", "azul").unwrap_err();
        assert!(err.contains("not #rrggbb"), "got: {err}");
    }

    #[test]
    fn shade_moves_towards_black_and_white_without_wrapping() {
        assert_eq!(shade((100, 200, 50), 0.5), (50, 100, 25));
        assert_eq!(shade((0, 0, 0), 0.5), (0, 0, 0));
        assert_eq!(shade((255, 255, 255), 1.5), (255, 255, 255));
        assert_eq!(shade((100, 100, 100), 1.5), (178, 178, 178));
    }
}
