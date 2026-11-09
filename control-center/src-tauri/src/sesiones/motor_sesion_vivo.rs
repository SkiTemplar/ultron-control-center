//! Transiciones del turno persistente; nunca se entra con el registro vivo tomado.
use super::{cambiado, lock, Turno};
use crate::sesiones::types::now_iso;

pub fn fijar_hilo(id: &str, hilo: &str) -> Result<(), String> {
    let engine = {
        let mut mapa = lock()?;
        let sesion = mapa
            .get_mut(id)
            .filter(|s| s.open)
            .ok_or_else(|| "la sesión se cerró durante el arranque".to_string())?;
        sesion.thread_id = Some(hilo.into());
        sesion.engine.clone()
    };
    super::sembrar_hilo(&engine, id, hilo);
    cambiado();
    Ok(())
}

pub fn fijar_vivo(id: &str, turno: &str) -> Result<(), String> {
    {
        let mut mapa = lock()?;
        let sesion = mapa
            .get_mut(id)
            .filter(|s| s.open && s.turno == Turno::Lanzando)
            .ok_or_else(|| "reserva del turno persistente perdida".to_string())?;
        sesion.turno = Turno::Vivo(turno.into());
    }
    cambiado();
    Ok(())
}

pub fn terminar_vivo(id: &str, turno: &str) {
    if let Ok(mut mapa) = lock() {
        if let Some(s) = mapa
            .get_mut(id)
            .filter(|s| s.turno == Turno::Vivo(turno.into()))
        {
            s.turno = Turno::Libre;
            s.working_since = None;
            s.last_activity_at = now_iso();
        }
    }
    cambiado();
    crate::sesiones::motor_cola::drenar(id);
}

pub fn titulo_vivo(id: &str, titulo: &str) {
    if let Ok(mut mapa) = lock() {
        if let Some(s) = mapa.get_mut(id).filter(|s| !s.title_manual) {
            s.title = titulo.into();
        }
    }
    cambiado();
}
