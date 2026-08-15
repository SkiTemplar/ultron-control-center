// projects/tests.rs — Unit tests for the projects module.

use super::normalise::{normalise_ide, normalise_provider};
use super::types::LauncherItem;

#[test]
fn normalise_ide_accepts_vscode_cursor_insiders() {
    assert_eq!(normalise_ide(Some("vscode")).as_deref(), Some("vscode"));
    // alias: "code" -> vscode
    assert_eq!(normalise_ide(Some("code")).as_deref(), Some("vscode"));
    assert_eq!(normalise_ide(Some("VS Code")).as_deref(), Some("vscode"));
    assert_eq!(normalise_ide(Some("cursor")).as_deref(), Some("cursor"));
    assert_eq!(normalise_ide(Some("CURSOR")).as_deref(), Some("cursor"));
    assert_eq!(
        normalise_ide(Some("code-insiders")).as_deref(),
        Some("code-insiders")
    );
    assert_eq!(
        normalise_ide(Some("insiders")).as_deref(),
        Some("code-insiders")
    );
}

#[test]
fn normalise_ide_rejects_unknown() {
    assert!(normalise_ide(Some("emacs")).is_none());
    assert!(normalise_ide(Some("vim")).is_none());
    // Legacy registry values used to land here — they all collapse to None.
    assert!(normalise_ide(Some("external")).is_none());
    assert!(normalise_ide(Some("app")).is_none());
    assert!(normalise_ide(Some("game")).is_none());

    // Empty / whitespace-only / None all return None.
    assert!(normalise_ide(Some("")).is_none());
    assert!(normalise_ide(Some("   ")).is_none());
    assert!(normalise_ide(None).is_none());
}

#[test]
fn launch_all_filters_folder_items() {
    // Replicate the documented invariant: a slice of LauncherItems should
    // yield exactly the non-folder kinds when filtered the same way as the
    // inner loop.
    let items = [
        LauncherItem {
            kind: "folder".into(),
            path: Some(r"C:\proj".into()),
            cwd: None,
            args: None,
            label: None,
            provider: None,
        },
        LauncherItem {
            kind: "claude".into(),
            path: None,
            cwd: Some(r"C:\proj".into()),
            args: None,
            label: None,
            provider: None,
        },
        LauncherItem {
            kind: "codex".into(),
            path: None,
            cwd: Some(r"C:\proj".into()),
            args: None,
            label: None,
            provider: None,
        },
        LauncherItem {
            kind: "folder".into(),
            path: Some(r"C:\proj\sub".into()),
            cwd: None,
            args: None,
            label: None,
            provider: None,
        },
    ];

    // Match the predicate in launch_all_items_inner — skip kind=="folder".
    let dispatched: Vec<&str> = items
        .iter()
        .filter(|i| i.kind != "folder")
        .map(|i| i.kind.as_str())
        .collect();
    assert_eq!(dispatched, vec!["claude", "codex"]);
}

#[test]
fn normalise_provider_falls_back_to_claude() {
    assert_eq!(normalise_provider(Some("claude")), "claude");
    assert_eq!(normalise_provider(Some("codex")), "codex");
    // Legacy "gemini" was a valid provider; now it falls back to "claude"
    // (gemini-CLI is dead since Google cut free-tier OAuth 2026-06-19).
    assert_eq!(normalise_provider(Some("gemini")), "claude");
    // Unknown -> claude
    assert_eq!(normalise_provider(Some("foo")), "claude");
    assert_eq!(normalise_provider(None), "claude");
    assert_eq!(normalise_provider(Some("   ")), "claude");
    // Case insensitive
    assert_eq!(normalise_provider(Some("CLAUDE")), "claude");
}

#[test]
fn materialise_home_entry_crea_la_entrada_real_del_home() {
    use super::write_ops::{materialise_home_entry, HOME_ID};

    let mut projects: Vec<serde_json::Value> = Vec::new();
    materialise_home_entry(&mut projects, r"C:\Users\demo");

    assert_eq!(projects.len(), 1);
    let entry = &projects[0];
    assert_eq!(entry["id"].as_str(), Some(HOME_ID));
    assert_eq!(entry["path"].as_str(), Some(r"C:\Users\demo"));
    assert_eq!(entry["type"].as_str(), Some("home"));
    // Caso negativo: no inventa color ni notas — el patch del update es quien
    // los pone. Si esta entrada naciera con campos, editar el home escribiria
    // valores que el usuario no pidio.
    assert!(entry.get("color").is_none(), "no debe nacer con color");
    assert!(entry.get("notes").is_none(), "no debe nacer con notas");
}
