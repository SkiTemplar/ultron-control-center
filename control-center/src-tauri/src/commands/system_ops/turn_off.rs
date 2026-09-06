// Turn Off — apagado programado del PC (System → Turn Off). Delega toda la
// lógica en `crate::turn_off`; estos wrappers solo despachan a un hilo
// bloqueante porque cada llamada hace I/O de fichero y, en `schedule`/
// `cancel`, además lanza `shutdown.exe`.
use crate::turn_off;

#[tauri::command]
pub async fn turn_off_schedule(hours: f64) -> Result<turn_off::TurnOffState, String> {
    tauri::async_runtime::spawn_blocking(move || turn_off::schedule_inner(hours))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn turn_off_cancel() -> Result<turn_off::TurnOffState, String> {
    tauri::async_runtime::spawn_blocking(turn_off::cancel_inner)
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[tauri::command]
pub async fn turn_off_status() -> Result<turn_off::TurnOffState, String> {
    tauri::async_runtime::spawn_blocking(turn_off::status_inner)
        .await
        .map_err(|e| format!("join: {e}"))?
}
