// ULTRON Control Center — Turn Off module.
//
// Apagado programado del PC. El plazo lo cumple Windows (`shutdown.exe`), no
// un temporizador propio de la app: así el apagado sobrevive a que se cierre
// el Control Center. Este módulo solo pide/cancela el apagado y persiste el
// plazo en ~/.ultron/cockpit/turn-off.json para poder repintar la cuenta
// atrás real si se reabre la app.
//
// La lógica pura (validación de horas, cálculo de segundos, vencimiento del
// registro) vive separada de la ejecución de `shutdown.exe` para poder
// testearla sin tocar el proceso real ni el sistema operativo.

use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::ultron_root;

/// Horas mínimas aceptadas al programar el apagado.
pub const MIN_HOURS: f64 = 0.1;
/// Horas máximas aceptadas al programar el apagado.
pub const MAX_HOURS: f64 = 24.0;

/// Código de salida de `shutdown /a` cuando no había ningún apagado
/// pendiente que abortar. Se trata como éxito: el estado deseado por el
/// usuario ("nada programado") ya se cumple.
const SHUTDOWN_NO_ABORT_PENDING: i32 = 1116;

/// Estado expuesto al frontend. `deadline_epoch_secs` es el instante (epoch,
/// UTC) en el que Windows apagará el equipo; el frontend recalcula la cuenta
/// atrás en cliente a partir de ese valor.
#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct TurnOffState {
    pub active: bool,
    pub deadline_epoch_secs: Option<i64>,
    pub hours: Option<f64>,
}

impl TurnOffState {
    fn inactive() -> Self {
        Self::default()
    }
}

/// Forma persistida en disco. Distinta de `TurnOffState` porque en reposo
/// (fichero ausente) no hay nada que serializar: el fichero solo existe
/// mientras hay un apagado programado.
#[derive(Debug, Serialize, Deserialize, Clone)]
struct TurnOffRecord {
    deadline_epoch_secs: i64,
    hours: f64,
    scheduled_at: i64,
}

fn turn_off_state_path() -> Result<PathBuf, String> {
    Ok(ultron_root()?.join("cockpit").join("turn-off.json"))
}

/// Valida el rango de horas y devuelve los segundos (redondeados) que se le
/// pasan a `shutdown /t`.
pub fn hours_to_seconds(hours: f64) -> Result<u32, String> {
    if !hours.is_finite() {
        return Err("Las horas deben ser un número válido.".to_string());
    }
    if hours < MIN_HOURS || hours > MAX_HOURS {
        return Err(format!(
            "Las horas deben estar entre {MIN_HOURS} y {MAX_HOURS}."
        ));
    }
    Ok((hours * 3600.0).round() as u32)
}

fn now_epoch_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn build_record(hours: f64, seconds: u32) -> TurnOffRecord {
    let now = now_epoch_secs();
    TurnOffRecord {
        deadline_epoch_secs: now + i64::from(seconds),
        hours,
        scheduled_at: now,
    }
}

/// Convierte el registro persistido en el estado expuesto al frontend. Un
/// plazo ya vencido (deadline en el pasado) se traduce siempre a inactivo:
/// quien llama es responsable de borrar el fichero en ese caso.
fn record_to_state(record: &TurnOffRecord, now: i64) -> TurnOffState {
    if record.deadline_epoch_secs <= now {
        return TurnOffState::inactive();
    }
    TurnOffState {
        active: true,
        deadline_epoch_secs: Some(record.deadline_epoch_secs),
        hours: Some(record.hours),
    }
}

fn read_record() -> Option<TurnOffRecord> {
    let path = turn_off_state_path().ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_record(record: &TurnOffRecord) -> Result<(), String> {
    let path = turn_off_state_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir cockpit: {e}"))?;
    }
    let json = serde_json::to_string_pretty(record).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, json).map_err(|e| format!("write turn-off.json: {e}"))
}

fn clear_record() -> Result<(), String> {
    let path = turn_off_state_path()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("rm turn-off.json: {e}"))?;
    }
    Ok(())
}

/// Lee el estado persistido. Si el plazo ya venció (p. ej. Windows apagó y
/// volvió a arrancar, o el usuario dejó pasar el reloj), limpia el fichero
/// y devuelve inactivo en vez de mentir sobre un apagado que ya no existe.
pub fn status_inner() -> Result<TurnOffState, String> {
    let Some(record) = read_record() else {
        return Ok(TurnOffState::inactive());
    };
    let state = record_to_state(&record, now_epoch_secs());
    if !state.active {
        clear_record()?;
    }
    Ok(state)
}

/// Programa el apagado. Si ya había uno activo lo cancela primero
/// (`shutdown /a`) y reprograma con el nuevo plazo — evita acumular
/// apagados encadenados en Windows.
pub fn schedule_inner(hours: f64) -> Result<TurnOffState, String> {
    let seconds = hours_to_seconds(hours)?;
    if read_record().is_some() {
        // Best-effort: `shutdown /s` reemplaza igualmente cualquier apagado
        // pendiente, así que un fallo aquí no es fatal para la reprogramación.
        let _ = run_shutdown_abort();
    }
    run_shutdown_schedule(seconds)?;
    let record = build_record(hours, seconds);
    write_record(&record)?;
    Ok(record_to_state(&record, now_epoch_secs()))
}

/// Cancela el apagado programado y borra el registro persistido. El código
/// 1116 de `shutdown /a` ("no hay apagado que abortar") se trata como éxito.
pub fn cancel_inner() -> Result<TurnOffState, String> {
    run_shutdown_abort()?;
    clear_record()?;
    Ok(TurnOffState::inactive())
}

// ---------------------------------------------------------------------------
// Ejecución de shutdown.exe — solo Windows. En cualquier otro SO se devuelve
// un error explícito; nunca un no-op silencioso.
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
fn run_shutdown_schedule(seconds: u32) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("shutdown.exe");
    cmd.args(["/s", "/t", &seconds.to_string()]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("shutdown /s spawn: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(format!(
        "shutdown /s falló (código {:?}): {stderr}",
        out.status.code()
    ))
}

#[cfg(target_os = "windows")]
fn run_shutdown_abort() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("shutdown.exe");
    cmd.args(["/a"]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| format!("shutdown /a spawn: {e}"))?;
    if out.status.success() || out.status.code() == Some(SHUTDOWN_NO_ABORT_PENDING) {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    Err(format!(
        "shutdown /a falló (código {:?}): {stderr}",
        out.status.code()
    ))
}

#[cfg(not(target_os = "windows"))]
fn run_shutdown_schedule(_seconds: u32) -> Result<(), String> {
    Err("Turn Off solo está disponible en Windows.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn run_shutdown_abort() -> Result<(), String> {
    Err("Turn Off solo está disponible en Windows.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hours_to_seconds_rechaza_por_debajo_del_minimo() {
        assert!(hours_to_seconds(0.05).is_err());
    }

    #[test]
    fn hours_to_seconds_rechaza_por_encima_del_maximo() {
        assert!(hours_to_seconds(24.1).is_err());
    }

    #[test]
    fn hours_to_seconds_rechaza_no_finito() {
        assert!(hours_to_seconds(f64::NAN).is_err());
        assert!(hours_to_seconds(f64::INFINITY).is_err());
    }

    #[test]
    fn hours_to_seconds_acepta_el_rango_valido() {
        assert_eq!(hours_to_seconds(MIN_HOURS).unwrap(), 360);
        assert_eq!(hours_to_seconds(MAX_HOURS).unwrap(), 86_400);
    }

    #[test]
    fn hours_to_seconds_convierte_decimales() {
        // 1.5 h = 5400 s exactos.
        assert_eq!(hours_to_seconds(1.5).unwrap(), 5_400);
    }

    #[test]
    fn record_to_state_activo_cuando_el_plazo_no_ha_vencido() {
        let record = TurnOffRecord {
            deadline_epoch_secs: 1_000,
            hours: 1.0,
            scheduled_at: 0,
        };
        let state = record_to_state(&record, 500);
        assert!(state.active);
        assert_eq!(state.deadline_epoch_secs, Some(1_000));
        assert_eq!(state.hours, Some(1.0));
    }

    #[test]
    fn record_to_state_inactivo_cuando_el_plazo_ya_vencio() {
        let record = TurnOffRecord {
            deadline_epoch_secs: 1_000,
            hours: 1.0,
            scheduled_at: 0,
        };
        let state = record_to_state(&record, 1_000);
        assert_eq!(state, TurnOffState::inactive());

        let state_pasado = record_to_state(&record, 1_500);
        assert_eq!(state_pasado, TurnOffState::inactive());
    }

    #[test]
    fn build_record_calcula_el_deadline_a_partir_de_ahora() {
        let record = build_record(2.0, 7_200);
        assert_eq!(record.deadline_epoch_secs, record.scheduled_at + 7_200);
        assert_eq!(record.hours, 2.0);
    }
}
