// projects/game_launch.rs — «Jugar»: resuelve el plan de `game.rs` contra el
// sistema (projects.json, registro de Epic, variables de entorno) y lanza el
// juego como proceso independiente. La selección del ejecutable es pura y
// está en `game.rs`; aquí solo hay efectos.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use super::game::{
    detect_game_project, editor_in_engine_root, engine_root_candidates, plan_unity, plan_unreal,
    GameEngine, GameLaunchMode, GameLaunchPlan, GameProject,
};
use super::registry::registry_path;

/// Respuesta de `project_play_game`: qué motor, en qué modo y con qué binario.
/// `message` es la explicación en castellano que la tarjeta enseña tal cual.
#[derive(Debug, Clone, Serialize)]
pub struct GameLaunchResult {
    pub engine: GameEngine,
    pub mode: GameLaunchMode,
    pub executable: String,
    pub message: String,
}

pub async fn project_play_game_inner(id: String) -> Result<GameLaunchResult, String> {
    validate_project_id(&id)?;
    let root = project_path(&id)?;
    tauri::async_runtime::spawn_blocking(move || play_game_at(&root))
        .await
        .map_err(|e| format!("project_play_game: tarea interrumpida: {e}"))?
}

fn play_game_at(root: &Path) -> Result<GameLaunchResult, String> {
    let project = detect_game_project(root).ok_or_else(|| {
        format!(
            "{} no es un proyecto de Unreal Engine ni de Unity",
            root.display()
        )
    })?;
    let plan = match &project {
        GameProject::Unreal { uproject } => plan_unreal(uproject, find_unreal_editor)?,
        GameProject::Unity { project_dir } => plan_unity(project_dir)?,
    };
    spawn_detached(&plan.program, &plan.args)?;
    Ok(GameLaunchResult {
        engine: plan.engine,
        mode: plan.mode,
        executable: plan.program.display().to_string(),
        message: describe(&plan),
    })
}

/// Texto para la UI: deja claro qué modo se usó.
pub(crate) fn describe(plan: &GameLaunchPlan) -> String {
    let exe = plan.program.display();
    match plan.mode {
        GameLaunchMode::Packaged => format!("Build empaquetado de Unreal: {exe}"),
        GameLaunchMode::EditorGame => format!(
            "Sin build empaquetado: juego sin editor (UnrealEditor -game -windowed) con {}",
            plan.args.first().map(String::as_str).unwrap_or("")
        ),
        GameLaunchMode::Player => format!("Build de Unity: {exe}"),
    }
}

fn validate_project_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if ok {
        Ok(())
    } else {
        Err(format!("invalid project id '{id}'"))
    }
}

/// Ruta del proyecto leída de projects.json (nunca la manda el front).
fn project_path(id: &str) -> Result<PathBuf, String> {
    let registry = registry_path().ok_or_else(|| "no HOME".to_string())?;
    let raw = std::fs::read_to_string(&registry).map_err(|e| format!("read projects.json: {e}"))?;
    let root: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("parse: {e}"))?;
    let path = root
        .get("projects")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|p| p.get("id").and_then(|x| x.as_str()) == Some(id))
        })
        .ok_or_else(|| format!("project '{id}' not found"))?
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("project '{id}' has no path configured"))?;
    let path = PathBuf::from(path);
    if !path.is_dir() {
        return Err(format!("project path does not exist: {}", path.display()));
    }
    Ok(path)
}

fn find_unreal_editor(association: Option<&str>) -> Option<PathBuf> {
    let installed = association.and_then(|a| {
        read_registry_string(
            RegistryHive::LocalMachine,
            &format!("SOFTWARE\\EpicGames\\Unreal Engine\\{a}"),
            "InstalledDirectory",
        )
    });
    let source_build = association.and_then(|a| {
        read_registry_string(
            RegistryHive::CurrentUser,
            "Software\\Epic Games\\Unreal Engine\\Builds",
            a,
        )
    });
    let ue_root = std::env::var_os("UE_ROOT").map(PathBuf::from);
    let program_files = std::env::var_os("ProgramFiles").map(PathBuf::from);
    engine_root_candidates(
        association,
        installed.map(PathBuf::from),
        source_build.map(PathBuf::from),
        ue_root,
        program_files,
    )
    .iter()
    .find_map(|root| editor_in_engine_root(root))
}

#[derive(Clone, Copy)]
enum RegistryHive {
    LocalMachine,
    CurrentUser,
}

#[cfg(windows)]
fn read_registry_string(hive: RegistryHive, subkey: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };
    let wide = |s: &str| {
        s.encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<u16>>()
    };
    let root = match hive {
        RegistryHive::LocalMachine => HKEY_LOCAL_MACHINE,
        RegistryHive::CurrentUser => HKEY_CURRENT_USER,
    };
    let (subkey, value) = (wide(subkey), wide(value));
    let mut buf = vec![0u16; 1024];
    let mut size = (buf.len() * 2) as u32;
    // SAFETY: cadenas terminadas en NUL que viven durante la llamada y un
    // búfer de `size` bytes; RegGetValueW garantiza el NUL final con RRF_RT_REG_SZ.
    let rc = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buf.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if rc != ERROR_SUCCESS {
        return None;
    }
    let len = (size as usize / 2).saturating_sub(1).min(buf.len());
    let text = String::from_utf16_lossy(&buf[..len]);
    let text = text.trim_end_matches('\0').trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(not(windows))]
fn read_registry_string(_hive: RegistryHive, _subkey: &str, _value: &str) -> Option<String> {
    None
}

/// Lanza el juego como proceso independiente: sin heredar stdio, en su propio
/// grupo de procesos y sin consola, con cwd = carpeta del ejecutable. No se
/// espera al hijo; si ULTRON se cierra, el juego sigue abierto.
fn spawn_detached(program: &Path, args: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = program.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    }
    cmd.spawn()
        .map(drop)
        .map_err(|e| format!("no se pudo lanzar {}: {}", program.display(), e))
}
