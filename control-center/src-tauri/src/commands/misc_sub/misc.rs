// Miscellaneous commands that don't fit into any of the other domain groups.
// Path helpers exposed to the frontend, instruction folders, usage report,
// and activity timeline.

use crate::{activity_timeline, instructions, plan_limits, usage};

/// Frontend-facing helper: returns the absolute path to the ULTRON root
/// (`~/.ultron`) as a UTF-8 string. The TS helper `getUltronRoot()` in
/// `src/lib/paths.ts` invokes this so the frontend never has to hardcode
/// `C:\Users\<name>\.ultron` to compute child paths.
#[tauri::command]
pub fn ultron_root_str() -> Result<String, String> {
    Ok(crate::ultron_root()?.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn instruction_path(kind: String) -> Result<String, String> {
    instructions::instruction_path_inner(kind)
}

/// Recorre todos los transcripts de `~/.claude/projects` (medido 2026-10-18:
/// ~12 s en caliente con 3,2 GB), así que va en `spawn_blocking`: ejecutado
/// directamente en el `async fn` ocupaba un hilo del runtime de Tauri durante
/// todo el recorrido y retrasaba las respuestas de los demás comandos.
#[tauri::command]
pub async fn claude_usage() -> Result<usage::UsageReport, String> {
    tauri::async_runtime::spawn_blocking(usage::claude_usage_inner)
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))?
}

/// Plan quota (5h window + weekly) straight from Anthropic, so the Usage tab
/// shows what `/usage` shows without opening a terminal. Blocking HTTP, hence
/// `spawn_blocking`: the async runtime must not stall on the round-trip.
#[tauri::command]
pub async fn claude_plan_limits(force: Option<bool>) -> Result<plan_limits::PlanLimits, String> {
    tauri::async_runtime::spawn_blocking(move || {
        plan_limits::plan_limits_inner(force.unwrap_or(false))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn compute_activity_timeline(
    days: u32,
) -> Result<activity_timeline::TimelineSummary, String> {
    activity_timeline::compute_activity_timeline_inner(days)
}

/// Lee el horario de uso tal cual (JSON crudo). `Ok(None)` solo si el fichero no
/// existe (ritmo lineal, el caso normal sin horario); si existe pero no se puede
/// leer o no es JSON, `Err` con el motivo, para que la tarjeta muestre
/// «horario inválido» en vez de pasar a lineal en silencio. La validacion de las
/// reglas y la ponderacion viven en el frontend (`usage/usageSchedule.ts`), con
/// las mismas reglas que `usage-schedule.js`.
fn read_usage_schedule(path: &std::path::Path) -> Result<Option<serde_json::Value>, String> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("no se puede leer usage-schedule.json: {e}")),
    };
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("usage-schedule.json no es JSON válido: {e}"))
}

/// Horario de uso (`~/.ultron/cockpit/usage-schedule.json`, personal e ignorado
/// por git) para que la tarjeta de cuota pondere el ritmo semanal igual que la
/// statusline y el hook usage-pace-guard. `None` = sin fichero (ritmo lineal);
/// `Err` = fichero ilegible o JSON roto (la tarjeta lo muestra).
#[tauri::command]
pub async fn usage_schedule_get() -> Result<Option<serde_json::Value>, String> {
    let path = crate::ultron_root()?
        .join("cockpit")
        .join("usage-schedule.json");
    read_usage_schedule(&path)
}

#[cfg(test)]
mod usage_schedule_tests {
    use super::read_usage_schedule;

    fn temp_file(name: &str, content: Option<&str>) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("usage-schedule-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        match content {
            Some(c) => std::fs::write(&path, c).unwrap(),
            None => {
                let _ = std::fs::remove_file(&path);
            }
        }
        path
    }

    #[test]
    fn lee_un_json_valido() {
        let p = temp_file("ok.json", Some(r#"{"lowWeight":0.12,"low":{}}"#));
        let v = read_usage_schedule(&p)
            .expect("deberia leerse")
            .expect("deberia haber horario");
        assert_eq!(v["lowWeight"], 0.12);
    }

    /// Sin fichero no es un error: `Ok(None)` y ritmo lineal.
    #[test]
    fn sin_fichero_devuelve_none() {
        let r = read_usage_schedule(&temp_file("no-existe.json", None));
        assert!(matches!(r, Ok(None)), "{r:?}");
    }

    /// Caso negativo (auditoria 2026-10-26, L6): un JSON roto ya no se descarta
    /// en silencio; el error llega a la tarjeta con el motivo.
    #[test]
    fn json_roto_devuelve_error_con_motivo() {
        let err = read_usage_schedule(&temp_file("roto.json", Some("{ no es json")))
            .expect_err("un JSON roto debe ser un error");
        assert!(err.contains("no es JSON"), "{err}");
    }
}
