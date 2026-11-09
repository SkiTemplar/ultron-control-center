// projects/game_tests.rs — «Jugar»: detección de motor y selección del
// ejecutable sobre árboles temporales (sin depender del disco de la máquina).

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::game::*;
use super::game_launch::describe;

fn touch(path: &Path) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, b"x").unwrap();
}

fn touch_aged(path: &Path, secs_ago: u64) {
    touch(path);
    let when = SystemTime::now() - Duration::from_secs(secs_ago);
    fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(when)
        .unwrap();
}

fn uproject(dir: &Path, name: &str, association: &str) -> PathBuf {
    let path = dir.join(format!("{name}.uproject"));
    fs::create_dir_all(dir).unwrap();
    fs::write(
        &path,
        format!(r#"{{"FileVersion":3,"EngineAssociation":"{association}"}}"#),
    )
    .unwrap();
    path
}

fn unity_project(dir: &Path, product: &str) {
    fs::create_dir_all(dir.join("Assets")).unwrap();
    fs::create_dir_all(dir.join("ProjectSettings")).unwrap();
    fs::write(
        dir.join("ProjectSettings/ProjectVersion.txt"),
        "m_EditorVersion: 6000.0.60f1\n",
    )
    .unwrap();
    fs::write(
        dir.join("ProjectSettings/ProjectSettings.asset"),
        format!("PlayerSettings:\n  companyName: X\n  productName: {product}\n"),
    )
    .unwrap();
}

fn unity_player(dir: &Path, stem: &str) -> PathBuf {
    let exe = dir.join(format!("{stem}.exe"));
    touch(&exe);
    fs::create_dir_all(dir.join(format!("{stem}_Data"))).unwrap();
    touch(&dir.join("UnityCrashHandler64.exe"));
    exe
}

fn editor_never_needed(_: Option<&str>) -> Option<PathBuf> {
    panic!("con build empaquetado no se busca el editor")
}

// --- detección ---------------------------------------------------------------

#[test]
fn detects_unreal_unity_and_nothing() {
    let tmp = tempfile::tempdir().unwrap();
    let ue = tmp.path().join("ue");
    let up = uproject(&ue, "Juego", "5.6");
    assert_eq!(
        detect_game_project(&ue),
        Some(GameProject::Unreal { uproject: up })
    );

    let unity = tmp.path().join("unity");
    unity_project(&unity, "Marble Glide");
    assert_eq!(
        detect_game_project(&unity).map(|g| g.engine()),
        Some(GameEngine::Unity)
    );

    // Caso negativo: un `Assets/` suelto (web, Python…) no es Unity.
    let web = tmp.path().join("web");
    fs::create_dir_all(web.join("Assets")).unwrap();
    assert_eq!(detect_game_project(&web), None);
}

#[test]
fn detects_an_engine_project_one_level_down() {
    let tmp = tempfile::tempdir().unwrap();
    fs::create_dir_all(tmp.path().join(".git")).unwrap();
    let up = uproject(&tmp.path().join("Arcadia"), "Arcadia", "5.6");
    assert_eq!(
        detect_game_project(tmp.path()),
        Some(GameProject::Unreal { uproject: up })
    );

    // `.git` como fichero (worktree o submódulo) también marca la raíz como repo.
    let repo = tmp.path().join("repo");
    touch(&repo.join(".git"));
    unity_project(&repo.join("MarbleGlide"), "Marble Glide");
    assert_eq!(
        detect_game_project(&repo),
        Some(GameProject::Unity {
            project_dir: repo.join("MarbleGlide")
        })
    );
}

#[test]
fn ignores_engine_projects_below_a_root_that_is_not_a_repo() {
    // El home o la carpeta de una asignatura contienen proyectos, no son uno.
    let tmp = tempfile::tempdir().unwrap();
    unity_project(&tmp.path().join("Template"), "Template");
    uproject(&tmp.path().join("SIIN_Project"), "SIIN_Project", "5.6");
    assert_eq!(detect_game_project(tmp.path()), None);
}

// --- Unreal ------------------------------------------------------------------

#[test]
fn unreal_prefers_the_packaged_build_over_the_editor() {
    let tmp = tempfile::tempdir().unwrap();
    let up = uproject(tmp.path(), "Arcadia", "5.6");
    let exe = tmp.path().join("Build/Windows/Arcadia.exe");
    touch(&exe);

    let plan = plan_unreal(&up, editor_never_needed).unwrap();
    assert_eq!(plan.mode, GameLaunchMode::Packaged);
    assert_eq!(plan.program, exe);
    assert!(plan.args.is_empty());
    assert!(describe(&plan).contains("empaquetado"));
}

#[test]
fn unreal_picks_the_newest_packaged_build() {
    let tmp = tempfile::tempdir().unwrap();
    let up = uproject(tmp.path(), "Explored", "5.6");
    touch_aged(
        &tmp.path().join("Saved/StagedBuilds/Windows/Explored.exe"),
        3600,
    );
    let newest = tmp
        .path()
        .join("Saved/Package-Development/Windows/Explored.exe");
    touch_aged(&newest, 10);
    touch_aged(&tmp.path().join("Saved/Package/Windows/Explored.exe"), 7200);

    assert_eq!(
        plan_unreal(&up, editor_never_needed).unwrap().program,
        newest
    );
}

#[test]
fn unreal_without_package_runs_the_editor_in_game_mode() {
    let tmp = tempfile::tempdir().unwrap();
    let up = uproject(tmp.path(), "Menger", "5.6");
    // Ni el binario del target Game ni `Build/Windows` con solo el icono son un build.
    touch(&tmp.path().join("Binaries/Win64/Menger.exe"));
    touch(&tmp.path().join("Build/Windows/Application.ico"));
    let editor = tmp.path().join("UE/Engine/Binaries/Win64/UnrealEditor.exe");
    touch(&editor);

    let mut seen = None;
    let plan = plan_unreal(&up, |assoc| {
        seen = assoc.map(str::to_string);
        Some(editor.clone())
    })
    .unwrap();
    assert_eq!(seen.as_deref(), Some("5.6"));
    assert_eq!(plan.mode, GameLaunchMode::EditorGame);
    assert_eq!(plan.program, editor);
    assert_eq!(
        plan.args,
        vec![
            up.to_string_lossy().to_string(),
            "-game".into(),
            "-windowed".into()
        ]
    );
    assert!(describe(&plan).contains("-game"));
}

#[test]
fn unreal_without_package_nor_engine_is_an_explicit_error() {
    let tmp = tempfile::tempdir().unwrap();
    let up = uproject(tmp.path(), "Huerfano", "9.9");
    let err = plan_unreal(&up, |_| None).unwrap_err();
    assert!(
        err.contains("UnrealEditor.exe") && err.contains("9.9"),
        "{err}"
    );
}

#[test]
fn engine_roots_follow_registry_then_env_then_default() {
    let roots = engine_root_candidates(
        Some("5.6"),
        Some(PathBuf::from("R:/launcher")),
        None,
        Some(PathBuf::from("R:/env")),
        Some(PathBuf::from("C:/PF")),
    );
    assert_eq!(
        roots,
        vec![
            PathBuf::from("R:/launcher"),
            PathBuf::from("R:/env"),
            PathBuf::from("C:/PF").join("Epic Games").join("UE_5.6"),
        ]
    );
    // Un GUID de motor de código fuente no tiene ruta por defecto.
    let guid = engine_root_candidates(
        Some("{ABC}"),
        None,
        None,
        None,
        Some(PathBuf::from("C:/PF")),
    );
    assert!(guid.is_empty());
}

#[test]
fn reads_engine_association_and_unity_product_name() {
    assert_eq!(
        engine_association(r#"{"EngineAssociation":"5.6"}"#).as_deref(),
        Some("5.6")
    );
    assert_eq!(engine_association(r#"{"EngineAssociation":""}"#), None);
    assert_eq!(engine_association("no es json"), None);
    assert_eq!(
        unity_product_name("PlayerSettings:\n  productName: Marble Glide\n").as_deref(),
        Some("Marble Glide")
    );
    assert_eq!(unity_product_name("PlayerSettings:\n"), None);
}

// --- Unity -------------------------------------------------------------------

#[test]
fn unity_without_build_is_an_error_not_a_noop() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("Juego");
    unity_project(&project, "Juego");
    // Basura que no es un player: crash handler suelto y un .exe sin `_Data`.
    touch(&project.join("Builds/Win/UnityCrashHandler64.exe"));
    touch(&project.join("Builds/Win/Juego.exe"));

    let err = plan_unity(&project).unwrap_err();
    assert!(err.contains("compila primero"), "{err}");
}

#[test]
fn unity_launches_the_player_from_its_own_builds_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("Juego");
    unity_project(&project, "Juego");
    let exe = unity_player(&project.join("Builds/Windows"), "Juego");

    let plan = plan_unity(&project).unwrap();
    assert_eq!(
        (plan.engine, plan.mode),
        (GameEngine::Unity, GameLaunchMode::Player)
    );
    assert_eq!(plan.program, exe);
}

#[test]
fn unity_shared_builds_folder_needs_a_matching_name() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("MarbleGlide");
    unity_project(&project, "Marble Glide");
    // `../Builds` es de todo el repo: el player de otro juego no vale.
    unity_player(&tmp.path().join("Builds/_archive/Windows"), "ACHOO");
    assert!(plan_unity(&project)
        .unwrap_err()
        .contains("compila primero"));

    let exe = unity_player(
        &tmp.path().join("Builds/MarbleGlide_Windows"),
        "MarbleGlide",
    );
    assert_eq!(plan_unity(&project).unwrap().program, exe);
}

#[test]
fn unity_prefers_the_named_player_over_a_newer_unrelated_one() {
    let tmp = tempfile::tempdir().unwrap();
    let project = tmp.path().join("Juego");
    unity_project(&project, "Mi Juego");
    let named = unity_player(&project.join("Builds/Release"), "MiJuego");
    fs::File::options()
        .write(true)
        .open(&named)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    unity_player(&project.join("Builds/Prueba"), "Otro");

    assert_eq!(plan_unity(&project).unwrap().program, named);
}
