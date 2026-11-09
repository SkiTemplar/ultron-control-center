// backup_status/schedule.rs — horario semanal del backup.
//
// Fuente de verdad única: la tarea registrada en el Programador de tareas de
// Windows con el nombre `BACKUP_TASK_NAME`. El horario se lee de su
// disparador (`schtasks /Query /XML`, independiente del idioma del sistema) y
// se escribe registrando esa misma tarea (`schtasks /Create /F`).
//
// Hallazgo N1 (auditoría 2026-10-23): el código consultaba y registraba
// `UltronBackup-Weekly`, que no existía, mientras la tarea real se llama
// «ULTRON Weekly Backup»; y el horario salía de `backup-config.json`
// (SAT 09:00) aunque la tarea corriera en SUN 10:00. La UI anunciaba un
// horario falso. `backup-config.json` ya no guarda horario: un campo
// `schedule` antiguo se ignora y desaparece al guardar las carpetas.

use serde::{Deserialize, Serialize};

/// Nombre de la tarea programada del backup semanal. Es el de la tarea que
/// ya existe en esta máquina; `scripts/cockpit/install-scheduler.ps1` no
/// registra otra (reconoce la del backup por su acción, no por el nombre).
pub const BACKUP_TASK_NAME: &str = "ULTRON Weekly Backup";

const WEEKDAYS: [(&str, &str); 7] = [
    ("Monday", "MON"),
    ("Tuesday", "TUE"),
    ("Wednesday", "WED"),
    ("Thursday", "THU"),
    ("Friday", "FRI"),
    ("Saturday", "SAT"),
    ("Sunday", "SUN"),
];

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct BackupScheduleInfo {
    /// Nombre de la tarea que se consulta y se registra.
    pub task_name: String,
    /// La tarea existe en el Programador de tareas.
    pub task_registered: bool,
    /// La tarea (o su disparador) no está deshabilitada.
    pub task_enabled: bool,
    /// Días del disparador semanal (`MON`..`SUN`). Vacío si no hay tarea o si
    /// su disparador no es semanal.
    pub days: Vec<String>,
    /// Hora `HH:MM` del disparador semanal.
    pub time: Option<String>,
    /// Fallo al consultar el Programador de tareas (no lanzar `schtasks`).
    pub query_error: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SetBackupSchedulePayload {
    pub day: String,
    pub time: String,
}

fn validate_day(day: &str) -> Result<String, String> {
    let up = day.trim().to_uppercase();
    if WEEKDAYS.iter().any(|(_, code)| *code == up) {
        Ok(up)
    } else {
        Err(format!(
            "día no válido '{}' (se espera MON/TUE/WED/THU/FRI/SAT/SUN)",
            day
        ))
    }
}

fn validate_time(time: &str) -> Result<String, String> {
    let trimmed = time.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return Err(format!("hora no válida '{}' (se espera HH:MM)", time));
    }
    let h: u32 = trimmed[0..2]
        .parse()
        .map_err(|_| format!("hora no válida en '{}'", time))?;
    let m: u32 = trimmed[3..5]
        .parse()
        .map_err(|_| format!("minutos no válidos en '{}'", time))?;
    if h > 23 || m > 59 {
        return Err(format!("hora fuera de rango '{}'", time));
    }
    Ok(trimmed.to_string())
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

/// Primer disparador semanal de la definición XML de la tarea: días y hora.
fn weekly_trigger(xml: &str) -> (Vec<String>, Option<String>) {
    const OPEN: &str = "<CalendarTrigger>";
    const CLOSE: &str = "</CalendarTrigger>";
    let mut rest = xml;
    while let Some(block) = between(rest, OPEN, CLOSE) {
        if let Some(week) = between(block, "<ScheduleByWeek>", "</ScheduleByWeek>") {
            let days_xml = between(week, "<DaysOfWeek>", "</DaysOfWeek>").unwrap_or("");
            let days = WEEKDAYS
                .iter()
                .filter(|(name, _)| days_xml.contains(&format!("<{}", name)))
                .map(|(_, code)| code.to_string())
                .collect();
            let time = between(block, "<StartBoundary>", "</StartBoundary>")
                .and_then(|b| b.split_once('T'))
                .and_then(|(_, t)| t.get(0..5))
                .map(str::to_string);
            return (days, time);
        }
        let consumed = rest
            .find(CLOSE)
            .map(|i| i + CLOSE.len())
            .unwrap_or(rest.len());
        rest = &rest[consumed..];
    }
    (Vec::new(), None)
}

/// Estado del horario a partir del XML de la tarea (`None` = no registrada).
pub(super) fn schedule_from_task_xml(xml: Option<&str>) -> BackupScheduleInfo {
    let (days, time) = xml.map(weekly_trigger).unwrap_or_default();
    BackupScheduleInfo {
        task_name: BACKUP_TASK_NAME.to_string(),
        task_registered: xml.is_some(),
        task_enabled: xml.is_some_and(|x| !x.contains("<Enabled>false</Enabled>")),
        days,
        time,
        query_error: None,
    }
}

/// `schtasks /XML` escribe ANSI al redirigirse, pero declara UTF-16; si
/// algún día sale en UTF-16LE (con BOM) también se decodifica.
fn decode_schtasks_output(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let units: Vec<u16> = bytes[2..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(windows)]
fn schtasks(args: &[&str]) -> Result<std::process::Output, String> {
    use std::os::windows::process::CommandExt;
    std::process::Command::new("schtasks.exe")
        .args(args)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("no se pudo lanzar schtasks: {}", e))
}

/// XML de la tarea, `Ok(None)` si no existe.
#[cfg(windows)]
fn query_task_xml() -> Result<Option<String>, String> {
    let out = schtasks(&["/Query", "/TN", BACKUP_TASK_NAME, "/XML"])?;
    if !out.status.success() {
        return Ok(None);
    }
    Ok(Some(decode_schtasks_output(&out.stdout)))
}

#[cfg(not(windows))]
fn query_task_xml() -> Result<Option<String>, String> {
    Ok(None)
}

pub fn get_backup_schedule_inner() -> Result<BackupScheduleInfo, String> {
    match query_task_xml() {
        Ok(xml) => Ok(schedule_from_task_xml(xml.as_deref())),
        Err(e) => Ok(BackupScheduleInfo {
            query_error: Some(e),
            ..schedule_from_task_xml(None)
        }),
    }
}

#[cfg(windows)]
fn register_weekly_task(day: &str, time: &str) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "no HOME".to_string())?;
    let script_path = home.join(".ultron\\scripts\\backup\\weekly-backup.ps1");
    if !script_path.is_file() {
        return Err(format!(
            "no existe weekly-backup.ps1 en {}",
            script_path.display()
        ));
    }
    let tr = format!(
        "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"",
        script_path.display()
    );
    // /F sobrescribe la tarea del mismo nombre: es el upsert que quiere la UI.
    let args = [
        "/Create",
        "/SC",
        "WEEKLY",
        "/D",
        day,
        "/ST",
        time,
        "/TN",
        BACKUP_TASK_NAME,
        "/TR",
        &tr,
        "/RL",
        "LIMITED",
        "/F",
    ];
    let out = schtasks(&args)?;
    if !out.status.success() {
        return Err(format!(
            "schtasks /Create falló (código {:?}): {}",
            out.status.code(),
            decode_schtasks_output(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn register_weekly_task(_day: &str, _time: &str) -> Result<(), String> {
    Err(
        "el horario solo se registra en el Programador de tareas de Windows; \
         en Linux/macOS programa weekly-backup.sh con cron o un timer de systemd"
            .to_string(),
    )
}

pub fn set_backup_schedule_inner(
    payload: SetBackupSchedulePayload,
) -> Result<BackupScheduleInfo, String> {
    let day = validate_day(&payload.day)?;
    let time = validate_time(&payload.time)?;
    register_weekly_task(&day, &time)?;
    get_backup_schedule_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Forma real de `schtasks /Query /TN "ULTRON Weekly Backup" /XML` en esta
    /// máquina (2026-10-23), recortada.
    const REAL_TASK: &str = r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-07-20T10:00:00</StartBoundary>
      <ScheduleByWeek>
        <WeeksInterval>1</WeeksInterval>
        <DaysOfWeek>
          <Sunday />
        </DaysOfWeek>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Settings>
    <Enabled>true</Enabled>
  </Settings>
</Task>"#;

    #[test]
    fn the_real_task_reports_sunday_at_ten() {
        let info = schedule_from_task_xml(Some(REAL_TASK));
        assert_eq!(info.task_name, "ULTRON Weekly Backup");
        assert!(info.task_registered);
        assert!(info.task_enabled);
        assert_eq!(info.days, vec!["SUN".to_string()]);
        assert_eq!(info.time.as_deref(), Some("10:00"));
    }

    #[test]
    fn no_task_means_no_schedule_not_a_default() {
        let info = schedule_from_task_xml(None);
        assert!(!info.task_registered);
        assert!(info.days.is_empty());
        assert_eq!(info.time, None);
    }

    #[test]
    fn a_disabled_task_is_reported() {
        let xml = REAL_TASK.replace("<Enabled>true</Enabled>", "<Enabled>false</Enabled>");
        assert!(!schedule_from_task_xml(Some(&xml)).task_enabled);
    }

    #[test]
    fn a_logon_trigger_has_no_weekly_schedule() {
        let xml = "<Task><Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers></Task>";
        let info = schedule_from_task_xml(Some(xml));
        assert!(info.task_registered);
        assert!(info.days.is_empty());
        assert_eq!(info.time, None);
    }

    #[test]
    fn several_days_and_a_timezone_offset() {
        let xml = REAL_TASK
            .replace("<Sunday />", "<Monday /><Thursday />")
            .replace("2026-07-20T10:00:00", "2026-07-20T03:30:00+02:00");
        let info = schedule_from_task_xml(Some(&xml));
        assert_eq!(info.days, vec!["MON".to_string(), "THU".to_string()]);
        assert_eq!(info.time.as_deref(), Some("03:30"));
    }

    #[test]
    fn utf16_output_is_decoded() {
        let mut bytes = vec![0xFF, 0xFE];
        for u in "<Task/>".encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_schtasks_output(&bytes), "<Task/>");
    }

    /// Consulta real al Programador de tareas (no hermético): solo a mano,
    /// `cargo test --lib live_query -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_query_reads_the_registered_task() {
        let info = get_backup_schedule_inner().unwrap();
        println!("{:?}", info);
        assert_eq!(info.query_error, None);
    }

    #[test]
    fn day_and_time_are_validated() {
        assert_eq!(validate_day("sun").unwrap(), "SUN");
        assert!(validate_day("DOM").is_err());
        assert_eq!(validate_time("10:00").unwrap(), "10:00");
        assert!(validate_time("24:00").is_err());
        assert!(validate_time("9:00").is_err());
    }
}
