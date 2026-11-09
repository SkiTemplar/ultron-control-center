// projects/game.rs — «Jugar»: detección de proyectos de Unreal Engine y Unity y
// selección del ejecutable que abre el juego sin editor.
//
// Lógica pura sobre el disco (lee directorios y metadatos, no lanza nada); el
// spawn y la lectura del registro de Windows viven en `game_launch.rs`.
//
// Prioridades:
//   Unreal — 1) build empaquetado (`Build/`, `Builds/`, `Packaged/`, `Package/`,
//               `Saved/Package*/`, `Saved/Archives/`, `Saved/StagedBuilds/`, con
//               `<plataforma>/<Proyecto>.exe`); entre varios, el más reciente.
//            2) sin empaquetar: `UnrealEditor.exe "<.uproject>" -game -windowed`.
//            `Binaries/Win64/<Proyecto>.exe` NO cuenta como build: es el binario
//            del target Game sin contenido cocinado ni staging y no arranca solo.
//   Unity  — player de Windows (`<Nombre>.exe` con su carpeta `<Nombre>_Data`) en
//            `Builds/` o `Build/` del proyecto, o en `../Builds/` (raíz del repo,
//            el layout del BuildScript de MarbleGlide; ahí solo vale si el nombre
//            casa con `productName` o con la carpeta del proyecto). Sin player:
//            error explícito, nunca un no-op.
//   Ambos  — un nivel por debajo de la raíz solo si esta es un repo git: el home
//            o la carpeta de una asignatura contienen proyectos, no son uno.

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GameEngine {
    Unreal,
    Unity,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GameLaunchMode {
    /// Build empaquetado de Unreal.
    Packaged,
    /// Unreal sin empaquetar: `UnrealEditor.exe <uproject> -game -windowed`.
    EditorGame,
    /// Player de Windows de Unity.
    Player,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GameProject {
    Unreal { uproject: PathBuf },
    Unity { project_dir: PathBuf },
}

impl GameProject {
    pub fn engine(&self) -> GameEngine {
        match self {
            GameProject::Unreal { .. } => GameEngine::Unreal,
            GameProject::Unity { .. } => GameEngine::Unity,
        }
    }
}

/// Qué lanzar y cómo. `program` es siempre una ruta absoluta existente.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GameLaunchPlan {
    pub engine: GameEngine,
    pub mode: GameLaunchMode,
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Subcarpetas que no se miran al buscar un proyecto de motor un nivel por debajo.
const SKIPPED_CHILD_DIRS: &[&str] = &[
    "node_modules",
    "Library",
    "Intermediate",
    "Saved",
    "Binaries",
    "DerivedDataCache",
    "Build",
    "Builds",
    "Logs",
    "Temp",
];
const MAX_CHILD_DIRS: usize = 64;
const UE_PLATFORM_DIRS: &[&str] = &["Windows", "WindowsNoEditor", "Win64"];
const UE_PACKAGE_ROOTS: &[&str] = &[
    "Build",
    "Builds",
    "Packaged",
    "Package",
    "Saved/Archives",
    "Saved/StagedBuilds",
];
const UNITY_SEARCH_DEPTH: usize = 3;

/// Detecta si `root` (o una subcarpeta directa) es un proyecto de Unreal o Unity.
/// En la raíz se lista el directorio; en las subcarpetas solo se comprueban
/// rutas fijas (`<hijo>/<hijo>.uproject`, `ProjectSettings/ProjectVersion.txt`)
/// para que `list_projects` no pague un `read_dir` por cada subcarpeta.
/// Las subcarpetas solo se miran si `root` es un repo git (`.git`, directorio o
/// fichero): un contenedor de proyectos como el home o la carpeta de una
/// asignatura no es un juego aunque tenga uno dentro.
pub fn detect_game_project(root: &Path) -> Option<GameProject> {
    if let Some(found) = detect_in_root(root) {
        return Some(found);
    }
    if !root.join(".git").exists() {
        return None;
    }
    child_dirs(root)
        .into_iter()
        .find_map(|child| detect_in_child(&child))
}

fn detect_in_root(dir: &Path) -> Option<GameProject> {
    if let Some(uproject) = find_uproject(dir) {
        return Some(GameProject::Unreal { uproject });
    }
    is_unity_project(dir).then(|| GameProject::Unity {
        project_dir: dir.to_path_buf(),
    })
}

fn detect_in_child(dir: &Path) -> Option<GameProject> {
    let name = dir.file_name()?.to_string_lossy().to_string();
    let uproject = dir.join(format!("{name}.uproject"));
    if uproject.is_file() {
        return Some(GameProject::Unreal { uproject });
    }
    dir.join("ProjectSettings")
        .join("ProjectVersion.txt")
        .is_file()
        .then(|| GameProject::Unity {
            project_dir: dir.to_path_buf(),
        })
}

fn is_unity_project(dir: &Path) -> bool {
    dir.join("Assets").is_dir() && dir.join("ProjectSettings").is_dir()
}

fn find_uproject(dir: &Path) -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && has_extension(p, "uproject"))
        .collect();
    found.sort();
    found.into_iter().next()
}

fn child_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .filter(|p| {
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            !name.starts_with('.')
                && !SKIPPED_CHILD_DIRS
                    .iter()
                    .any(|s| s.eq_ignore_ascii_case(&name))
        })
        .collect();
    dirs.sort();
    dirs.truncate(MAX_CHILD_DIRS);
    dirs
}

fn has_extension(path: &Path, ext: &str) -> bool {
    path.extension()
        .map(|e| e.eq_ignore_ascii_case(ext))
        .unwrap_or(false)
}

fn modified(path: &Path) -> SystemTime {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH)
}

/// El más reciente por fecha de modificación; a igualdad, el primero de la lista.
pub fn pick_newest(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for path in candidates {
        let time = modified(&path);
        if best.as_ref().map(|(t, _)| time > *t).unwrap_or(true) {
            best = Some((time, path));
        }
    }
    best.map(|(_, p)| p)
}

// ---------------------------------------------------------------------------
// Unreal
// ---------------------------------------------------------------------------

/// `EngineAssociation` del .uproject (`"5.6"` o el GUID de un motor de código fuente).
pub fn engine_association(uproject_json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(uproject_json).ok()?;
    value
        .get("EngineAssociation")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn unreal_package_roots(project_dir: &Path) -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = UE_PACKAGE_ROOTS
        .iter()
        .map(|r| project_dir.join(r))
        .collect();
    let saved = project_dir.join("Saved");
    if let Ok(entries) = std::fs::read_dir(&saved) {
        let mut packages: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.is_dir()
                    && p.file_name()
                        .map(|n| {
                            n.to_string_lossy()
                                .to_ascii_lowercase()
                                .starts_with("package")
                        })
                        .unwrap_or(false)
            })
            .collect();
        packages.sort();
        roots.extend(packages);
    }
    roots
}

/// Ejecutables de builds empaquetados que existen, en orden de prioridad.
pub fn unreal_packaged_candidates(uproject: &Path) -> Vec<PathBuf> {
    let (Some(project_dir), Some(stem)) = (uproject.parent(), uproject.file_stem()) else {
        return Vec::new();
    };
    let exe_name = format!("{}.exe", stem.to_string_lossy());
    unreal_package_roots(project_dir)
        .into_iter()
        .flat_map(|root| UE_PLATFORM_DIRS.iter().map(move |p| root.join(p)))
        .map(|dir| dir.join(&exe_name))
        .filter(|exe| exe.is_file())
        .collect()
}

/// Plan para Unreal: build empaquetado si lo hay; si no, el editor en modo
/// `-game`. `find_editor` recibe el `EngineAssociation` y solo se llama cuando
/// no hay empaquetado.
pub fn plan_unreal(
    uproject: &Path,
    find_editor: impl FnOnce(Option<&str>) -> Option<PathBuf>,
) -> Result<GameLaunchPlan, String> {
    if let Some(exe) = pick_newest(unreal_packaged_candidates(uproject)) {
        return Ok(GameLaunchPlan {
            engine: GameEngine::Unreal,
            mode: GameLaunchMode::Packaged,
            program: exe,
            args: Vec::new(),
        });
    }
    let raw = std::fs::read_to_string(uproject)
        .map_err(|e| format!("no se pudo leer {}: {}", uproject.display(), e))?;
    let association = engine_association(&raw);
    let editor = find_editor(association.as_deref()).ok_or_else(|| {
        format!(
            "No hay build empaquetado y no se encontró UnrealEditor.exe para EngineAssociation {:?} \
             (registro de Epic, UE_ROOT o Program Files\\Epic Games\\UE_<versión>)",
            association.as_deref().unwrap_or("(vacío)")
        )
    })?;
    Ok(GameLaunchPlan {
        engine: GameEngine::Unreal,
        mode: GameLaunchMode::EditorGame,
        program: editor,
        args: vec![
            uproject.to_string_lossy().to_string(),
            "-game".into(),
            "-windowed".into(),
        ],
    })
}

/// Raíces de motor candidatas en orden: instalación del launcher para esa
/// asociación, build de código fuente registrado, `UE_ROOT` y la ruta por defecto.
pub fn engine_root_candidates(
    association: Option<&str>,
    installed_dir: Option<PathBuf>,
    source_build_dir: Option<PathBuf>,
    ue_root_env: Option<PathBuf>,
    program_files: Option<PathBuf>,
) -> Vec<PathBuf> {
    let default_install = association
        .filter(|a| !a.starts_with('{'))
        .zip(program_files)
        .map(|(a, pf)| pf.join("Epic Games").join(format!("UE_{a}")));
    [
        installed_dir,
        source_build_dir,
        ue_root_env,
        default_install,
    ]
    .into_iter()
    .flatten()
    .collect()
}

/// `UnrealEditor.exe` dentro de una raíz de motor, si existe.
pub fn editor_in_engine_root(root: &Path) -> Option<PathBuf> {
    let exe = root
        .join("Engine")
        .join("Binaries")
        .join("Win64")
        .join("UnrealEditor.exe");
    exe.is_file().then_some(exe)
}

// ---------------------------------------------------------------------------
// Unity
// ---------------------------------------------------------------------------

/// `productName` de `ProjectSettings/ProjectSettings.asset` (YAML de Unity).
pub fn unity_product_name(project_settings: &str) -> Option<String> {
    project_settings
        .lines()
        .find_map(|l| l.trim_start().strip_prefix("productName:"))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn normalise_name(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn is_unity_player(exe: &Path) -> bool {
    let Some(stem) = exe.file_stem().map(|s| s.to_string_lossy().to_string()) else {
        return false;
    };
    if stem.to_ascii_lowercase().starts_with("unitycrashhandler") {
        return false;
    }
    exe.parent()
        .map(|d| d.join(format!("{stem}_Data")).is_dir())
        .unwrap_or(false)
}

fn collect_players(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(Result::ok).map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if path.is_file() && has_extension(&path, "exe") && is_unity_player(&path) {
            out.push(path);
        } else if path.is_dir() && depth > 1 && !is_player_support_dir(&path) {
            collect_players(&path, depth - 1, out);
        }
    }
}

fn is_player_support_dir(dir: &Path) -> bool {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    name.starts_with('.') || name.ends_with("_Data") || name == "MonoBleedingEdge"
}

/// Plan para Unity: el player más adecuado o un error que dice dónde se buscó.
pub fn plan_unity(project_dir: &Path) -> Result<GameLaunchPlan, String> {
    let settings = std::fs::read_to_string(
        project_dir
            .join("ProjectSettings")
            .join("ProjectSettings.asset"),
    )
    .unwrap_or_default();
    let mut wanted: Vec<String> = unity_product_name(&settings)
        .iter()
        .map(|n| normalise_name(n))
        .collect();
    if let Some(dir_name) = project_dir.file_name() {
        wanted.push(normalise_name(&dir_name.to_string_lossy()));
    }
    let matches_name = |exe: &PathBuf| {
        exe.file_stem()
            .map(|s| wanted.contains(&normalise_name(&s.to_string_lossy())))
            .unwrap_or(false)
    };

    let own_dirs = [project_dir.join("Builds"), project_dir.join("Build")];
    let shared_dir = project_dir.parent().map(|p| p.join("Builds"));

    let mut own = Vec::new();
    for dir in &own_dirs {
        collect_players(dir, UNITY_SEARCH_DEPTH, &mut own);
    }
    let mut shared = Vec::new();
    if let Some(dir) = &shared_dir {
        collect_players(dir, UNITY_SEARCH_DEPTH, &mut shared);
    }

    let named: Vec<PathBuf> = own
        .iter()
        .chain(shared.iter())
        .filter(|e| matches_name(e))
        .cloned()
        .collect();
    let chosen = pick_newest(named).or_else(|| pick_newest(own));
    let exe = chosen.ok_or_else(|| {
        let searched: Vec<String> = own_dirs
            .iter()
            .chain(shared_dir.iter())
            .map(|d| d.display().to_string())
            .collect();
        format!(
            "No hay build de Unity: compila primero (se buscó un player <Nombre>.exe con su carpeta \
             <Nombre>_Data en {})",
            searched.join(", ")
        )
    })?;
    Ok(GameLaunchPlan {
        engine: GameEngine::Unity,
        mode: GameLaunchMode::Player,
        program: exe,
        args: Vec::new(),
    })
}
