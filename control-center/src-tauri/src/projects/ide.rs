// projects/ide.rs — Resolve an IDE slug to a launcher that actually exists
// on this machine, and spawn it.
//
// Why this is not just `where <cli>`: JetBrains installers (and the Android
// Studio one) do **not** put their CLI shim on PATH. Probing PATH alone made
// `open_in_ide` silently fall through to the next candidate, so a project
// configured as `"ide": "rider"` opened in VS Code instead. Resolution order
// per launcher is now:
//   1. the bare name, when it is on PATH;
//   2. the JetBrains Toolbox shim script (always points at the current build);
//   3. a standard install directory (Program Files / LOCALAPPDATA).
// When none of those hit we report `NotInstalled` so the caller can say so
// instead of opening a different editor behind the user's back.

use std::path::{Path, PathBuf};

/// Why launching an IDE failed. `NotInstalled` is the case callers must not
/// paper over with a fallback editor.
#[derive(Debug)]
pub enum IdeLaunchError {
    /// The requested IDE has no launcher on PATH nor in a known install dir.
    NotInstalled(String),
    /// A launcher was found but the process could not be started.
    Spawn(String),
}

impl std::fmt::Display for IdeLaunchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdeLaunchError::NotInstalled(m) => write!(f, "{}", m),
            IdeLaunchError::Spawn(m) => write!(f, "{}", m),
        }
    }
}

/// Auto-detect order used when a project has no preferred IDE.
pub(crate) const AUTODETECT_ORDER: &[&str] = &[
    "code",
    "cursor",
    "code-insiders",
    "idea",
    "rider",
    "webstorm",
    "pycharm",
    "clion",
    "goland",
    "phpstorm",
    "rustrover",
    "datagrip",
    "studio",
    "fleet",
    "nvim",
    "subl",
    "zed",
];

/// Map a normalised IDE slug (see `normalise::normalise_ide`) to its CLI
/// launcher name.
pub(crate) fn slug_to_cli(slug: &str) -> Option<&'static str> {
    match slug {
        "vscode" => Some("code"),
        "cursor" => Some("cursor"),
        "code-insiders" => Some("code-insiders"),
        "intellij" => Some("idea"),
        "rider" => Some("rider"),
        "webstorm" => Some("webstorm"),
        "pycharm" => Some("pycharm"),
        "clion" => Some("clion"),
        "goland" => Some("goland"),
        "phpstorm" => Some("phpstorm"),
        "rustrover" => Some("rustrover"),
        "datagrip" => Some("datagrip"),
        "androidstudio" => Some("studio"),
        "fleet" => Some("fleet"),
        "nvim" => Some("nvim"),
        "sublime" => Some("subl"),
        "zed" => Some("zed"),
        "obsidian" => Some("obsidian"),
        _ => None,
    }
}

/// Human-facing name for an error message ("rider" -> "Rider").
pub(crate) fn display_name(cli: &str) -> &'static str {
    match cli {
        "code" => "VS Code",
        "code-insiders" => "VS Code Insiders",
        "cursor" => "Cursor",
        "idea" => "IntelliJ IDEA",
        "rider" => "Rider",
        "webstorm" => "WebStorm",
        "pycharm" => "PyCharm",
        "clion" => "CLion",
        "goland" => "GoLand",
        "phpstorm" => "PhpStorm",
        "rustrover" => "RustRover",
        "datagrip" => "DataGrip",
        "studio" => "Android Studio",
        "fleet" => "Fleet",
        "nvim" => "Neovim",
        "subl" => "Sublime Text",
        "zed" => "Zed",
        "obsidian" => "Obsidian",
        _ => "IDE",
    }
}

/// JetBrains launchers: `(install-directory keyword, bin/ executable)`.
/// The keyword is matched case-insensitively against directory names, which
/// carry the version ("JetBrains Rider 2025.2").
fn jetbrains_product(cli: &str) -> Option<(&'static str, &'static str)> {
    match cli {
        "idea" => Some(("intellij idea", "idea64.exe")),
        "rider" => Some(("rider", "rider64.exe")),
        "webstorm" => Some(("webstorm", "webstorm64.exe")),
        "pycharm" => Some(("pycharm", "pycharm64.exe")),
        "clion" => Some(("clion", "clion64.exe")),
        "goland" => Some(("goland", "goland64.exe")),
        "phpstorm" => Some(("phpstorm", "phpstorm64.exe")),
        "rustrover" => Some(("rustrover", "rustrover64.exe")),
        "datagrip" => Some(("datagrip", "datagrip64.exe")),
        "fleet" => Some(("fleet", "fleet.exe")),
        _ => None,
    }
}

/// Pick the newest of several side-by-side installs. Directory names embed
/// the version ("... 2024.3" vs "... 2025.2"), which sorts in release order,
/// so the last name wins.
pub(crate) fn pick_latest(mut paths: Vec<String>) -> Option<String> {
    paths.sort();
    paths.pop()
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// JetBrains Toolbox writes `<cli>.cmd` shims here and keeps them pointed at
/// the current build, so they beat scanning install directories.
fn toolbox_shim(cli: &str) -> Option<String> {
    let scripts = env_dir("LOCALAPPDATA")?
        .join("JetBrains")
        .join("Toolbox")
        .join("scripts");
    for name in [
        format!("{}.cmd", cli),
        format!("{}.bat", cli),
        cli.to_string(),
    ] {
        let cand = scripts.join(name);
        if cand.is_file() {
            return Some(cand.to_string_lossy().into_owned());
        }
    }
    None
}

/// Scan the standard JetBrains install roots for `<product ...>/bin/<exe>`.
fn jetbrains_install(cli: &str) -> Option<String> {
    let (keyword, exe) = jetbrains_product(cli)?;
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(dir) = env_dir(var) {
            roots.push(dir.join("JetBrains"));
        }
    }
    // Toolbox "install to a custom location" layout.
    if let Some(dir) = env_dir("LOCALAPPDATA") {
        roots.push(dir.join("Programs"));
    }

    let mut hits: Vec<String> = Vec::new();
    for root in roots {
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if !name.contains(keyword) {
                continue;
            }
            let bin = entry.path().join("bin").join(exe);
            if bin.is_file() {
                hits.push(bin.to_string_lossy().into_owned());
            }
        }
    }
    pick_latest(hits)
}

/// Non-JetBrains editors that ship a launcher in a fixed location.
fn fixed_install(cli: &str) -> Option<String> {
    let local = env_dir("LOCALAPPDATA");
    let pf = env_dir("ProgramFiles");
    let candidates: Vec<PathBuf> = match cli {
        "code" => [
            local
                .as_ref()
                .map(|d| d.join("Programs").join("Microsoft VS Code")),
            pf.as_ref().map(|d| d.join("Microsoft VS Code")),
        ]
        .into_iter()
        .flatten()
        .map(|d| d.join("bin").join("code.cmd"))
        .collect(),
        "code-insiders" => [
            local
                .as_ref()
                .map(|d| d.join("Programs").join("Microsoft VS Code Insiders")),
            pf.as_ref().map(|d| d.join("Microsoft VS Code Insiders")),
        ]
        .into_iter()
        .flatten()
        .map(|d| d.join("bin").join("code-insiders.cmd"))
        .collect(),
        "cursor" => local
            .as_ref()
            .map(|d| {
                d.join("Programs")
                    .join("cursor")
                    .join("resources")
                    .join("app")
                    .join("bin")
                    .join("cursor.cmd")
            })
            .into_iter()
            .collect(),
        "studio" => pf
            .as_ref()
            .map(|d| {
                d.join("Android")
                    .join("Android Studio")
                    .join("bin")
                    .join("studio64.exe")
            })
            .into_iter()
            .collect(),
        "obsidian" => local
            .as_ref()
            .map(|d| d.join("Programs").join("Obsidian").join("Obsidian.exe"))
            .into_iter()
            .collect(),
        _ => Vec::new(),
    };
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// What to hand the launcher for `path`. Editors take the folder itself;
/// Obsidian ignores a folder argument and only opens vaults through its
/// `obsidian://` URI, so the folder is resolved to the vault that contains it.
pub(crate) fn launch_target(cli: &str, path: &str) -> String {
    if cli != "obsidian" {
        return path.to_string();
    }
    let registry = env_dir("APPDATA")
        .map(|d| d.join("obsidian").join("obsidian.json"))
        .and_then(|f| std::fs::read_to_string(f).ok())
        .unwrap_or_default();
    obsidian_uri(&registry, path)
}

/// `obsidian://open?vault=<id>` for the registered vault whose root is `path`
/// or contains it (deepest root wins); `obsidian://open?path=<path>` when no
/// registered vault matches. `registry` is the content of Obsidian's
/// `obsidian.json`; unreadable or malformed content falls back to `path=`.
fn obsidian_uri(registry: &str, path: &str) -> String {
    let norm = |p: &str| p.replace('/', "\\").trim_end_matches('\\').to_lowercase();
    let target = norm(path);
    let vault = serde_json::from_str::<serde_json::Value>(registry)
        .ok()
        .and_then(|v| v.get("vaults").and_then(|x| x.as_object()).cloned())
        .into_iter()
        .flatten()
        .filter_map(|(id, v)| {
            let root = norm(v.get("path")?.as_str()?);
            let inside = target == root || target.starts_with(&format!("{root}\\"));
            inside.then_some((root.len(), id))
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, id)| id);
    match vault {
        Some(id) => format!("obsidian://open?vault={}", percent_encode(&id)),
        None => format!("obsidian://open?path={}", percent_encode(path)),
    }
}

/// RFC 3986 percent-encoding of everything outside the unreserved set.
fn percent_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Choose the launcher to spawn out of what `where` / `which` printed, one
/// path per line.
///
/// Windows matters here: VS Code's `bin/` holds both `code` (a POSIX shell
/// script for Git Bash / WSL) and `code.cmd`, and `where` lists the
/// extensionless one first. Taking line one, or the bare CLI name, hands
/// cmd.exe something it cannot run — `%~dp0` inside the shim then resolves
/// against the caller's working directory and the launch dies with exit 9009
/// ("not recognised as an internal or external command"), which surfaced as
/// an IDE button that silently did nothing. Prefer a real Windows executable.
fn pick_launcher(output: &str) -> Option<String> {
    let lines: Vec<&str> = output
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if cfg!(windows) {
        const RUNNABLE: [&str; 3] = [".cmd", ".bat", ".exe"];
        if let Some(hit) = lines.iter().find(|l| {
            let lower = l.to_ascii_lowercase();
            RUNNABLE.iter().any(|ext| lower.ends_with(ext))
        }) {
            return Some((*hit).to_string());
        }
    }
    lines.first().map(|l| (*l).to_string())
}

/// Absolute path of `cli` as resolved off PATH, or `None` when it is not
/// there. Returning the path rather than a bool is what keeps the bare name
/// out of the spawn — see `pick_launcher`.
fn locate_on_path(cli: &str) -> Option<String> {
    let probe = if cfg!(windows) { "where" } else { "which" };
    let out = std::process::Command::new(probe).arg(cli).output().ok()?;
    if !out.status.success() {
        return None;
    }
    pick_launcher(&String::from_utf8_lossy(&out.stdout))
}

/// Resolution order, with every probe injected so the ordering itself is
/// testable without touching this machine's disk or PATH.
///
/// JetBrains products resolve to their native `<product>64.exe` *before*
/// PATH. Their `bin/<cli>.bat` shim locates its JRE from inside the batch
/// script, and invoked by bare name off PATH that lookup fails here:
/// `cmd /C ""rider" "<path>""` prints "No JRE found" and exits 0, so the IDE
/// button spawned a process that died immediately while reporting success --
/// a silent no-op. Launching `rider64.exe` directly has no such step.
/// Everything else keeps PATH first: VS Code and friends ship a working shim,
/// and PATH is what the user configured.
fn resolve_with(
    cli: &str,
    locate: impl Fn(&str) -> Option<String>,
    shim: impl Fn(&str) -> Option<String>,
    install: impl Fn(&str) -> Option<String>,
    fixed: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let from_path = || locate(cli);
    if jetbrains_product(cli).is_some() {
        return install(cli).or_else(|| shim(cli)).or_else(from_path);
    }
    from_path()
        .or_else(|| shim(cli))
        .or_else(|| install(cli))
        .or_else(|| fixed(cli))
}

/// Resolve a launcher name to something spawnable: always an absolute path,
/// whether it came off PATH or from a known install directory. `None` means
/// the IDE is not installed on this machine.
pub(crate) fn resolve_launcher(cli: &str) -> Option<String> {
    resolve_with(
        cli,
        locate_on_path,
        toolbox_shim,
        jetbrains_install,
        fixed_install,
    )
}

/// Reject a target that could break out of the `cmd /C` payload below.
fn target_safe(target: &str) -> Result<(), IdeLaunchError> {
    if target.chars().any(|c| c == '"' || c.is_control()) {
        return Err(IdeLaunchError::Spawn(
            "path contains quotes or control characters".into(),
        ));
    }
    Ok(())
}

/// `true` when `program` has to go through `cmd /C`: a `.cmd` / `.bat` shim,
/// or a bare name resolved off PATH rather than an absolute executable.
#[cfg_attr(not(windows), allow(dead_code))]
fn needs_shell(program: &str) -> bool {
    let lower = program.to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat") || !Path::new(program).is_file()
}

/// Start `program` with `target` as its only argument.
#[cfg(windows)]
pub(crate) fn spawn_launcher(program: &str, target: &str) -> Result<(), IdeLaunchError> {
    use std::os::windows::process::CommandExt;
    target_safe(target)?;
    let mut cmd = if needs_shell(program) {
        // `cmd /C ""<prog>" "<target>""` — the outer pair is cmd.exe's own
        // quoting rule for when the command itself is quoted. Built with
        // raw_arg because Rust's normal escaping does not match cmd.exe's.
        let mut c = std::process::Command::new("cmd");
        c.arg("/C");
        c.raw_arg(format!("\"\"{}\" \"{}\"\"", program, target));
        c
    } else {
        let mut c = std::process::Command::new(program);
        c.arg(target);
        c
    };
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.spawn()
        .map_err(|e| IdeLaunchError::Spawn(format!("spawn {}: {}", program, e)))?;
    Ok(())
}

/// Start `program` with `target` as its only argument.
#[cfg(not(windows))]
pub(crate) fn spawn_launcher(program: &str, target: &str) -> Result<(), IdeLaunchError> {
    target_safe(target)?;
    std::process::Command::new(program)
        .arg(target)
        .spawn()
        .map_err(|e| IdeLaunchError::Spawn(format!("spawn {}: {}", program, e)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_maps_to_its_cli() {
        assert_eq!(slug_to_cli("rider"), Some("rider"));
        assert_eq!(slug_to_cli("vscode"), Some("code"));
        assert_eq!(slug_to_cli("androidstudio"), Some("studio"));
    }

    #[test]
    fn unknown_slug_has_no_cli() {
        assert_eq!(slug_to_cli("visualstudio"), None);
        assert_eq!(slug_to_cli(""), None);
    }

    #[test]
    fn every_valid_ide_slug_has_a_launcher() {
        for slug in crate::projects::normalise::VALID_IDES {
            assert!(
                slug_to_cli(slug).is_some(),
                "VALID_IDES slug '{}' has no launcher mapping",
                slug
            );
        }
    }

    #[test]
    fn pick_latest_takes_the_highest_version() {
        let got = pick_latest(vec![
            "C:/JetBrains/JetBrains Rider 2024.3/bin/rider64.exe".to_string(),
            "C:/JetBrains/JetBrains Rider 2025.2/bin/rider64.exe".to_string(),
            "C:/JetBrains/JetBrains Rider 2025.1/bin/rider64.exe".to_string(),
        ]);
        assert_eq!(
            got.as_deref(),
            Some("C:/JetBrains/JetBrains Rider 2025.2/bin/rider64.exe")
        );
    }

    #[test]
    fn pick_latest_is_none_when_nothing_was_found() {
        assert_eq!(pick_latest(Vec::new()), None);
    }

    #[test]
    fn jetbrains_products_cover_the_jetbrains_slugs() {
        for cli in [
            "idea", "rider", "webstorm", "pycharm", "clion", "goland", "datagrip",
        ] {
            assert!(jetbrains_product(cli).is_some(), "{} unmapped", cli);
        }
        assert!(jetbrains_product("code").is_none());
    }

    /// Regression: `rider` resolved off PATH is the `.bat` shim, which dies
    /// with "No JRE found" and still exits 0 -- the IDE button did nothing.
    #[test]
    fn jetbrains_prefers_the_native_exe_over_path() {
        let got = resolve_with(
            "rider",
            |_| Some("P:/path/rider.bat".to_string()),
            |_| Some("shim.cmd".to_string()),
            |_| Some("R:/JetBrains Rider 2025.2/bin/rider64.exe".to_string()),
            |_| None,
        );
        assert_eq!(
            got.as_deref(),
            Some("R:/JetBrains Rider 2025.2/bin/rider64.exe")
        );
    }

    #[test]
    fn jetbrains_falls_back_to_the_toolbox_shim_then_to_path() {
        let shim_only = resolve_with(
            "rider",
            |_| Some("P:/path/rider.bat".to_string()),
            |_| Some("shim.cmd".to_string()),
            |_| None,
            |_| None,
        );
        assert_eq!(shim_only.as_deref(), Some("shim.cmd"));

        let path_only = resolve_with(
            "rider",
            |_| Some("P:/path/rider.bat".to_string()),
            |_| None,
            |_| None,
            |_| None,
        );
        assert_eq!(path_only.as_deref(), Some("P:/path/rider.bat"));

        let nothing = resolve_with("rider", |_| None, |_| None, |_| None, |_| None);
        assert_eq!(nothing, None);
    }

    #[test]
    fn non_jetbrains_editors_still_prefer_path() {
        let found = resolve_with(
            "code",
            |_| Some("P:/on-path/code.cmd".to_string()),
            |_| None,
            |_| None,
            |_| Some("C:/vsc/code.cmd".to_string()),
        );
        assert_eq!(found.as_deref(), Some("P:/on-path/code.cmd"));

        let off_path = resolve_with(
            "code",
            |_| None,
            |_| None,
            |_| None,
            |_| Some("C:/vsc/code.cmd".to_string()),
        );
        assert_eq!(off_path.as_deref(), Some("C:/vsc/code.cmd"));
    }

    /// Regression (2026-09-21): `where code` lists the extensionless POSIX
    /// script before `code.cmd`. Picking line one — or passing the bare name
    /// `code` — made `cmd /C` fail with exit 9009 and the IDE button did
    /// nothing at all.
    #[test]
    fn picks_the_windows_shim_over_the_extensionless_script() {
        let out = "C:\\Users\\r\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code\r\n\
                   C:\\Users\\r\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd\r\n";
        let got = pick_launcher(out);
        if cfg!(windows) {
            assert_eq!(
                got.as_deref(),
                Some("C:\\Users\\r\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd")
            );
        } else {
            assert!(got.is_some());
        }
    }

    #[test]
    fn falls_back_to_the_first_line_when_nothing_is_runnable() {
        let got = pick_launcher("/usr/local/bin/code\n");
        assert_eq!(got.as_deref(), Some("/usr/local/bin/code"));
    }

    #[test]
    fn no_output_resolves_to_nothing() {
        assert_eq!(pick_launcher(""), None);
        assert_eq!(pick_launcher("   \r\n  \n"), None);
    }

    /// A path with spaces, accents and an em-dash must survive resolution
    /// untouched: `PPR — Paradigmas de la Programación` is a real project.
    #[test]
    fn keeps_a_path_with_spaces_and_non_ascii_intact() {
        let p = "C:\\Users\\r\\CARRERA\\PPR — Paradigmas de la Programación\\code.cmd";
        assert_eq!(pick_launcher(&format!("{p}\r\n")).as_deref(), Some(p));
    }

    #[test]
    fn a_launcher_that_cannot_exist_resolves_to_none() {
        assert_eq!(resolve_launcher("ultron-no-such-ide"), None);
    }

    const OBSIDIAN_REGISTRY: &str = r#"{"vaults":{
        "aaa":{"path":"C:\\Users\\r\\notes","ts":1},
        "bbb":{"path":"C:\\Users\\r\\CARRERA\\TFG — Trabajo","ts":2}}}"#;

    #[test]
    fn obsidian_opens_the_registered_vault_by_id() {
        let uri = obsidian_uri(OBSIDIAN_REGISTRY, "C:\\Users\\r\\CARRERA\\TFG — Trabajo");
        assert_eq!(uri, "obsidian://open?vault=bbb");
        // Case and trailing separator must not break the match.
        let uri = obsidian_uri(OBSIDIAN_REGISTRY, "c:/users/r/carrera/tfg — trabajo/");
        assert_eq!(uri, "obsidian://open?vault=bbb");
    }

    #[test]
    fn obsidian_matches_a_folder_inside_a_vault_but_not_a_sibling_prefix() {
        let inside = obsidian_uri(OBSIDIAN_REGISTRY, "C:\\Users\\r\\notes\\daily");
        assert_eq!(inside, "obsidian://open?vault=aaa");
        let sibling = obsidian_uri(OBSIDIAN_REGISTRY, "C:\\Users\\r\\notes-old");
        assert!(sibling.starts_with("obsidian://open?path="), "{sibling}");
    }

    #[test]
    fn obsidian_falls_back_to_an_encoded_path_without_a_registry() {
        let uri = obsidian_uri("not json", "C:\\a b\\TFG — X");
        assert_eq!(
            uri,
            "obsidian://open?path=C%3A%5Ca%20b%5CTFG%20%E2%80%94%20X"
        );
        assert!(!uri.contains('"') && !uri.contains(' '));
    }

    #[test]
    fn launch_target_leaves_editor_paths_untouched() {
        assert_eq!(launch_target("code", "C:\\x y"), "C:\\x y");
    }

    #[test]
    fn spawn_rejects_a_target_with_quotes() {
        let err = spawn_launcher("code", "C:\\tmp\\a\"b").unwrap_err();
        assert!(matches!(err, IdeLaunchError::Spawn(_)));
    }
}
