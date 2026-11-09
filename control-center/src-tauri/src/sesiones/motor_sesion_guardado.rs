// sesiones/motor_sesion_guardado.rs — Persistencia de las sesiones de motor
// (submódulo de `motor_sesion`): `cockpit/sesiones/motor-sesiones.json`,
// ignorado por git, con escritura atómica (tmp + rename). Los tests nunca
// tocan el cockpit real (`store_path` = `None`).
//
// Tope de `MAX_SESIONES` sesiones (se podan las cerradas más antiguas; una
// abierta no se poda) y `MAX_TURNOS` turnos por sesión (los más recientes).
// Con la sesión abierta, sus turnos se leen del registro de `motor`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{lock, Mapa, SesionMotor, Turno, MAX_SESIONES, MAX_TURNOS};
use crate::sesiones::motor;
use crate::sesiones::types::EngineTask;

fn store_path() -> Option<PathBuf> {
    if cfg!(test) {
        return None; // los tests nunca tocan el cockpit real
    }
    directorio_guardado()
        .ok()
        .map(|r| r.join("motor-sesiones.json"))
}

pub fn directorio_guardado() -> Result<PathBuf, String> {
    crate::ultron_root().map(|r| r.join("cockpit").join("sesiones"))
}

/// Forma en disco de una sesión de motor.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Guardada {
    id: String,
    engine: String,
    project_id: Option<String>,
    project_name: String,
    cwd: String,
    title: String,
    #[serde(default)]
    title_manual: bool,
    model: Option<String>,
    #[serde(default = "modo_guardado_por_defecto")]
    permission_mode: crate::sesiones::types::PermissionMode,
    started_at: String,
    last_activity_at: String,
    open: bool,
    thread_id: Option<String>,
    #[serde(default)]
    turns: Vec<Value>,
}

fn modo_guardado_por_defecto() -> crate::sesiones::types::PermissionMode {
    crate::sesiones::types::PermissionMode::Default
}

/// Los `max` turnos más recientes, en orden cronológico.
pub fn recortar(mut turnos: Vec<EngineTask>, max: usize) -> Vec<EngineTask> {
    turnos.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    let sobran = turnos.len().saturating_sub(max);
    turnos.drain(..sobran);
    turnos
}

/// Quita las sesiones cerradas más antiguas hasta dejar `max` (las abiertas
/// no se podan).
pub fn podar_cerradas(m: &mut Mapa, max: usize) -> Vec<String> {
    if m.len() <= max {
        return Vec::new();
    }
    let mut cerradas: Vec<(String, String)> = m
        .values()
        .filter(|s| !s.open)
        .map(|s| (s.last_activity_at.clone(), s.id.clone()))
        .collect();
    cerradas.sort();
    let sobran = m.len() - max;
    cerradas
        .into_iter()
        .take(sobran)
        .map(|(_, id)| {
            m.remove(&id);
            id
        })
        .collect()
}

fn desde(g: Guardada) -> SesionMotor {
    SesionMotor {
        id: g.id,
        engine: g.engine,
        project_id: g.project_id,
        project_name: g.project_name,
        cwd: g.cwd,
        title: g.title,
        title_manual: g.title_manual,
        model: g.model,
        permission_mode: g.permission_mode,
        started_at: g.started_at,
        last_activity_at: g.last_activity_at,
        open: g.open,
        thread_id: g.thread_id,
        turns: recortar(motor::tareas_de(g.turns), MAX_TURNOS),
        turno: Turno::Libre,
        working_since: None,
    }
}

/// `vivos`: turnos del registro de `motor` (los de las sesiones abiertas).
fn hacia(s: &SesionMotor, vivos: &[EngineTask]) -> Guardada {
    let turnos: Vec<EngineTask> = if s.open {
        vivos
            .iter()
            .filter(|t| t.session_id.as_deref() == Some(s.id.as_str()))
            .cloned()
            .collect()
    } else {
        s.turns.clone()
    };
    Guardada {
        id: s.id.clone(),
        engine: s.engine.clone(),
        project_id: s.project_id.clone(),
        project_name: s.project_name.clone(),
        cwd: s.cwd.clone(),
        title: s.title.clone(),
        title_manual: s.title_manual,
        model: s.model.clone(),
        permission_mode: s.permission_mode,
        started_at: s.started_at.clone(),
        last_activity_at: s.last_activity_at.clone(),
        open: s.open,
        thread_id: s.thread_id.clone(),
        turns: recortar(turnos, MAX_TURNOS)
            .iter()
            .filter_map(|t| serde_json::to_value(t).ok())
            .collect(),
    }
}

/// Sesiones guardadas en `path` (las abiertas, libres; un turno que figuraba
/// en curso pasa a `error`).
pub fn cargar_de(path: &Path) -> Vec<SesionMotor> {
    let raw = match std::fs::read_to_string(path) {
        Ok(r) => r,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            tracing::warn!(error = %e, "no se pudieron leer las sesiones de motor guardadas");
            return Vec::new();
        }
    };
    let guardadas: Vec<Guardada> = serde_json::from_str(&raw).unwrap_or_else(|e| {
        tracing::warn!(error = %e, "sesiones de motor guardadas no válidas: se ignoran");
        Vec::new()
    });
    guardadas.into_iter().map(desde).collect()
}

/// Escribe en `path` las sesiones con el tope aplicado (escritura atómica).
pub fn guardar_en(
    path: &Path,
    sesiones: &[SesionMotor],
    vivos: &[EngineTask],
) -> Result<(), String> {
    let mut m: Mapa = sesiones.iter().map(|s| (s.id.clone(), s.clone())).collect();
    let _ = podar_cerradas(&mut m, MAX_SESIONES);
    let mut datos: Vec<Guardada> = m.values().map(|s| hacia(s, vivos)).collect();
    datos.sort_by(|a, b| a.started_at.cmp(&b.started_at));
    escribir(path, &datos)
}

fn escribir(path: &Path, datos: &[Guardada]) -> Result<(), String> {
    let json = serde_json::to_string(datos).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Registro inicial: las sesiones guardadas; las abiertas de Codex siembran
/// su hilo para que el siguiente turno lo retome.
pub(super) fn cargar_inicial() -> Mapa {
    let Some(path) = store_path() else {
        return HashMap::new();
    };
    let mut m: Mapa = cargar_de(&path)
        .into_iter()
        .map(|s| (s.id.clone(), s))
        .collect();
    let podadas = podar_cerradas(&mut m, MAX_SESIONES);
    for id in podadas {
        crate::sesiones::motor_vivo::olvidar(&id);
    }
    for s in m.values().filter(|s| s.open) {
        if let Some(th) = &s.thread_id {
            super::sembrar_hilo(&s.engine, &s.id, th);
        }
    }
    m
}

/// Serializa las escrituras del fichero (comparten el `.tmp`).
fn escritura() -> &'static Mutex<()> {
    static E: Mutex<()> = Mutex::new(());
    &E
}

/// Guarda el registro. Los turnos vivos se leen de `motor` antes de tomar el
/// candado de las sesiones (regla de candados de `motor_sesion`), ya dentro
/// de la escritura serializada: una copia vieja no pisa a una más nueva.
pub fn guardar() {
    let Some(path) = store_path() else {
        return;
    };
    let Ok(_e) = escritura().lock() else {
        tracing::warn!("escritura de sesiones de motor envenenada");
        return;
    };
    let vivos: Vec<EngineTask> = motor::list(None)
        .into_iter()
        .filter(|t| t.kind == motor::KIND_CHAT)
        .collect();
    let sesiones: Vec<SesionMotor> = match lock() {
        Ok(m) => m.values().cloned().collect(),
        Err(e) => {
            tracing::warn!(error = %e, "no se pudieron guardar las sesiones de motor");
            return;
        }
    };
    if let Err(e) = guardar_en(&path, &sesiones, &vivos) {
        tracing::warn!(error = %e, "no se pudieron guardar las sesiones de motor");
    }
}
