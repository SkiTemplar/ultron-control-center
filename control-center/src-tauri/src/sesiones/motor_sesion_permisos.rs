//! Modo persistido y desvío de permisos de las sesiones de motor.
use super::*;
use crate::sesiones::types::OpResult;

pub(super) fn preferencias_iniciales() -> super::super::types::SessionPrefs {
    #[cfg(test)]
    return super::super::types::SessionPrefs::default();
    #[cfg(not(test))]
    super::super::ajustes::prefs_actuales()
}

pub fn set_permission_mode(id: &str, mode: PermissionMode) -> Result<OpResult, String> {
    let sesion = get(id)?;
    if let Err(error) = super::super::motor_vivo::aplicar_modo(id, &sesion.engine, mode) {
        return Ok(OpResult {
            ok: false,
            error: Some(error),
            ..OpResult::default()
        });
    }
    {
        let mut mapa = lock()?;
        let s = mapa
            .get_mut(id)
            .filter(|s| s.open)
            .ok_or("la sesión de motor está cerrada")?;
        s.permission_mode = mode;
    }
    cambiado();
    Ok(OpResult {
        ok: true,
        text: Some(format!(
            "Modo de permisos: {}",
            super::super::lanzamiento::modo_cli(mode)
        )),
        ..OpResult::default()
    })
}

impl SesionMotor {
    fn trabajando(&self) -> bool {
        self.turno != Turno::Libre
    }

    /// Proyección para la UI (contrato: `engine` presente, sin Claude).
    pub fn info(&self) -> SessionInfo {
        let waiting = super::super::motor_vivo::espera_permiso(&self.id);
        let status = if waiting.is_some() {
            SessionStatus::Waiting
        } else if self.trabajando() {
            SessionStatus::Working
        } else {
            SessionStatus::Idle
        };
        SessionInfo {
            project_id: self.project_id.clone(),
            project_name: self.project_name.clone(),
            title: self.title.clone(),
            status,
            waiting,
            permission_mode: Some(self.permission_mode),
            model: self.model.clone(),
            started_at: self.started_at.clone(),
            working_since: self.working_since.clone(),
            last_activity_at: self.last_activity_at.clone(),
            engine: Some(self.engine.clone()),
            ..SessionInfo::nueva(&self.id, &self.cwd, self.permission_mode)
        }
    }
}

/// Ajustes visibles de una sesión de motor abierta (`sesiones_settings`):
/// modelo y proyecto. Sin esfuerzo ni ajustes de Claude Code; `None` si el id
/// no es una sesión de motor abierta.
pub fn ajustes(id: &str) -> Option<super::super::types::SessionSettings> {
    let m = lock().ok()?;
    let s = m.get(id).filter(|s| s.open)?;
    Some(super::super::types::SessionSettings {
        model: s.model.clone(),
        effort: None,
        permission_mode: Some(super::super::lanzamiento::modo_cli(s.permission_mode).into()),
        socratic: None,
        project_id: s.project_id.clone(),
        launch_permission_mode: Some(s.permission_mode),
    })
}
