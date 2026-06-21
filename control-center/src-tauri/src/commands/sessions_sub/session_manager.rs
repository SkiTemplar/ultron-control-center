// commands/sessions_sub/session_manager.rs — Gestor de Sesiones multi-sesión (READ-ONLY).
//
// Escanea `~/.claude/projects/*/*.jsonl` y devuelve metadatos de cada sesión
// de Claude Code encontrada en disco. No escribe nada ni accede a ningún PID
// map; el estado se infiere por recencia del último evento.
//
// Patrón de lectura: igual que `live_session::read_jsonl_tail` — seek desde el
// final para que el coste sea O(TAIL_LINES), no O(tamaño del fichero). Los
// transcripts pesan MBs; no se leen enteros.
//
// Convención de nombres de fichero:
//   <session-uuid>.jsonl  -> sesión normal (is_subagent = false)
//   agent-*.jsonl         -> subagente      (is_subagent = true)
//   journal.jsonl         -> ignorado siempre
//
// El parseo bruto del JSONL vive en `session_jsonl`; la inferencia de
// metadatos (estado, ventana, liveness, match de proyecto) en `session_meta`
// (cat7.3 split). Este módulo orquesta ambos y expone el comando Tauri.

use std::path::Path;

use serde::Serialize;

use crate::projects::read_ops::list_projects_inner;

use super::session_jsonl::{
    extract_text, now_unix_secs, parse_iso8601_secs, read_jsonl_tail, AssistantMessage,
    TranscriptEvent, UserMessage, MAX_SUMMARY_CHARS, TAIL_LINES,
};
use super::session_meta::{
    apply_liveness, classify_status, context_window_for, count_live_cli_sessions, match_project_id,
    readable_name,
};

// ---------------------------------------------------------------------------
// Struct público de salida (contrato con el frontend — snake_case, sin rename)
// ---------------------------------------------------------------------------

/// Información de una sesión de Claude Code leída desde el transcript JSONL.
#[derive(Debug, Serialize)]
pub struct SessionInfo {
    /// UUID de la sesión (nombre del fichero sin extensión).
    pub session_id: String,
    /// Directorio de trabajo (`cwd`) de la sesión.
    pub project_path: String,
    /// Nombre legible derivado del `ProjectInfo` de ULTRON o del último componente del cwd.
    pub project_name: String,
    /// ID del proyecto ULTRON cuyo `path` coincide con el cwd de la sesión, si hay match.
    pub matched_project_id: Option<String>,
    /// Rama git en el momento del último evento.
    pub git_branch: Option<String>,
    /// Modelo usado en el último turno assistant (ej. "claude-opus-4-8").
    pub model: Option<String>,
    /// Contexto de ENTRADA del último turno assistant: input + cache_read + cache_creation
    /// (sin output, que no ocupa ventana de entrada).
    pub context_tokens: u64,
    /// Ventana de contexto inferida (200 000 estándar / 1 000 000 extendida `[1m]`).
    /// El denominador real usado para `context_pct`. Ver `context_window_for`.
    pub context_limit: u64,
    /// `context_tokens / context_limit * 100`, acotado a 100.0.
    pub context_pct: f32,
    /// `cache_read_input_tokens` del último turno assistant.
    pub cache_read_tokens: u64,
    /// `output_tokens` del último turno assistant.
    pub output_tokens: u64,
    /// Estado inferido: "working" | "waiting" | "idle" | "dead".
    pub status: String,
    /// Timestamp ISO 8601 del último evento.
    pub last_activity: String,
    /// Segundos transcurridos desde `last_activity` (calculado en el momento de la llamada).
    pub age_seconds: u64,
    /// Último mensaje de usuario, recortado a `MAX_SUMMARY_CHARS` chars.
    pub last_prompt: Option<String>,
    /// Resumen del último evento (texto assistant o nombre de tool), ~200 chars.
    pub last_activity_summary: Option<String>,
    /// Verdadero para ficheros cuyo nombre empieza por "agent-".
    pub is_subagent: bool,
}

// ---------------------------------------------------------------------------
// Procesamiento de un único fichero JSONL
// ---------------------------------------------------------------------------

/// Procesa un fichero JSONL de transcript y devuelve un `SessionInfo` o `None`
/// si el fichero está vacío, malformado, o corresponde a `journal.jsonl`.
///
/// Fail-safe: nunca hace panic; los errores se propagan como `None`.
pub(crate) fn parse_session_file(
    path: &Path,
    is_subagent: bool,
    projects: &[crate::projects::types::ProjectInfo],
    now_secs: u64,
) -> Option<SessionInfo> {
    let file_name = path.file_name()?.to_string_lossy().to_string();

    // Ignorar journal.jsonl siempre.
    if file_name == "journal.jsonl" {
        return None;
    }

    // ID de sesión = nombre del fichero sin extensión.
    let session_id = file_name.trim_end_matches(".jsonl").to_string();

    // Leer la cola del fichero — suficiente para el último turno assistant
    // (con usage) + el último mensaje de usuario.
    let events: Vec<TranscriptEvent> = read_jsonl_tail(path, TAIL_LINES);
    if events.is_empty() {
        return None;
    }

    // El evento más reciente CON timestamp marca la recencia de la sesión.
    // Claude Code reescribe al final del fichero eventos de metadata SIN timestamp
    // (permission-mode, last-prompt, ai-title, mode, bridge-session, queue-operation…);
    // si tomáramos `events[0]` a ciegas, su timestamp ausente descartaría la sesión
    // entera (era el bug "faltan sesiones": la sesión en curso no aparecía).
    let last_ts_event = events.iter().find(|e| e.timestamp.is_some())?;
    let last_ts = last_ts_event.timestamp.clone().unwrap_or_default();
    let last_age = now_secs.saturating_sub(parse_iso8601_secs(&last_ts).unwrap_or(now_secs));

    // cwd y gitBranch del último evento (o de cualquier evento en la cola que
    // los tenga — Claude Code los emite en los primeros eventos de la sesión y
    // puede omitirlos en los intermedios).
    let cwd = events
        .iter()
        .find_map(|e| e.cwd.as_deref().filter(|s| !s.is_empty()))
        .unwrap_or("")
        .to_string();
    let git_branch = events
        .iter()
        .find_map(|e| e.git_branch.as_deref().filter(|s| !s.is_empty()))
        .map(str::to_string);

    // Búsqueda del último turno assistant con usage y del último prompt de usuario.
    let mut model: Option<String> = None;
    let mut context_tokens: u64 = 0;
    let mut cache_read_tokens: u64 = 0;
    let mut output_tokens: u64 = 0;
    let mut stop_reason: Option<String> = None;
    let mut last_activity_summary: Option<String> = None;
    let mut last_prompt: Option<String> = None;

    for event in &events {
        let etype = event.event_type.as_deref().unwrap_or("");

        if etype == "assistant" && model.is_none() {
            // Deserializar el campo `message` del evento assistant.
            if let Some(raw_msg) = &event.message {
                if let Ok(msg) = serde_json::from_value::<AssistantMessage>(raw_msg.clone()) {
                    if let Some(u) = &msg.usage {
                        // Contexto de ENTRADA del último turno = tamaño del prompt enviado
                        // (input no cacheado + cache leído + cache creado). El output_tokens
                        // es texto generado, NO ocupa ventana de entrada → no se suma (era la
                        // causa secundaria del context% inflado).
                        context_tokens = u.input_tokens
                            + u.cache_read_input_tokens
                            + u.cache_creation_input_tokens;
                        cache_read_tokens = u.cache_read_input_tokens;
                        output_tokens = u.output_tokens;
                    }
                    model = msg.model.filter(|s| !s.is_empty());
                    stop_reason = msg.stop_reason.clone();
                    // Resumen de actividad: primer bloque de texto del mensaje.
                    if let Some(first_content) = msg.content.first() {
                        last_activity_summary = extract_text(first_content, MAX_SUMMARY_CHARS);
                    }
                }
            }
        }

        // Último prompt de usuario (content como texto).
        if etype == "user" && last_prompt.is_none() {
            if let Some(raw_msg) = &event.message {
                if let Ok(umsg) = serde_json::from_value::<UserMessage>(raw_msg.clone()) {
                    last_prompt = extract_text(&umsg.content, MAX_SUMMARY_CHARS);
                }
            }
        }

        // Salir cuando ya tenemos todo lo que necesitamos.
        if model.is_some() && last_prompt.is_some() {
            break;
        }
    }

    let last_event_type = last_ts_event.event_type.as_deref().unwrap_or("");
    let status = classify_status(last_age, last_event_type, stop_reason.as_deref()).to_string();

    // Ventana real inferida del contexto observado (200k estándar / 1M extendida).
    let context_limit = context_window_for(context_tokens);
    let context_pct = ((context_tokens as f32 / context_limit as f32) * 100.0).min(100.0);

    // Match con proyectos ULTRON.
    let matched_project_id = if cwd.is_empty() {
        None
    } else {
        match_project_id(&cwd, projects)
    };
    let project_name = readable_name(&cwd, matched_project_id.as_deref(), projects);

    Some(SessionInfo {
        session_id,
        project_path: cwd,
        project_name,
        matched_project_id,
        git_branch,
        model,
        context_tokens,
        context_limit,
        context_pct,
        cache_read_tokens,
        output_tokens,
        status,
        last_activity: last_ts,
        age_seconds: last_age,
        last_prompt,
        last_activity_summary,
        is_subagent,
    })
}

// ---------------------------------------------------------------------------
// Función principal (lógica hermética, testeable sin Tauri)
// ---------------------------------------------------------------------------

/// Escanea `~/.claude/projects/*/*.jsonl`, infiere el estado de cada sesión y
/// devuelve la lista ordenada por `last_activity` descendente (más reciente primero).
///
/// - `journal.jsonl` se ignora siempre.
/// - Ficheros `agent-*.jsonl` se marcan con `is_subagent = true`.
/// - Una sesión malformada o vacía se omite sin propagar el error.
pub fn list_active_sessions_inner() -> Result<Vec<SessionInfo>, String> {
    let home =
        dirs::home_dir().ok_or_else(|| "no se puede resolver el directorio home".to_string())?;
    let projects_dir = home.join(".claude").join("projects");

    // Cargar proyectos ULTRON una sola vez para el matching de cwd.
    // Si falla (proyectos no configurados) seguimos sin hacer match.
    let ultron_projects = list_projects_inner().unwrap_or_default();

    let now_secs = now_unix_secs();
    let mut sessions: Vec<SessionInfo> = Vec::new();

    // Iterar sobre las carpetas de proyecto de Claude Code.
    let Ok(project_dirs) = std::fs::read_dir(&projects_dir) else {
        // Si la carpeta no existe aún (usuario sin sesiones) devolvemos vacío.
        return Ok(Vec::new());
    };

    for dir_entry in project_dirs.flatten() {
        let dir_path = dir_entry.path();
        if !dir_path.is_dir() {
            continue;
        }

        let Ok(files) = std::fs::read_dir(&dir_path) else {
            continue;
        };

        for file_entry in files.flatten() {
            let file_path = file_entry.path();
            // Sólo procesar ficheros .jsonl.
            if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let fname = file_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();

            // journal.jsonl se ignora antes de abrir el fichero.
            if fname == "journal.jsonl" {
                continue;
            }

            let is_subagent = fname.starts_with("agent-");

            if let Some(info) =
                parse_session_file(&file_path, is_subagent, &ultron_projects, now_secs)
            {
                sessions.push(info);
            }
        }
    }

    // Ordenar por last_activity descendente (ISO 8601 compara lexicográficamente).
    sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));

    // Señal de proceso real: marcar "dead" las sesiones cuyo proceso CLI ya no
    // existe (resuelve "sesiones cerradas que siguen saliendo idle"). Si no se
    // puede contar (no Windows), se respeta la clasificación temporal.
    if let Some(live) = count_live_cli_sessions() {
        apply_liveness(&mut sessions, live);
    }

    Ok(sessions)
}

// ---------------------------------------------------------------------------
// Comando Tauri (wrapper asíncrono thin sobre la función hermética)
// ---------------------------------------------------------------------------

/// Devuelve todas las sesiones de Claude Code encontradas en disco, ordenadas
/// por actividad reciente. READ-ONLY — nunca escribe ni accede a PIDs.
#[tauri::command]
pub async fn list_active_sessions() -> Result<Vec<SessionInfo>, String> {
    list_active_sessions_inner()
}

// ---------------------------------------------------------------------------
// Tests unitarios herméticos (sin I/O de disco real, sin Tauri)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::sessions_sub::session_meta::THRESHOLD_IDLE_SECS;

    // -----------------------------------------------------------------------
    // Helpers para construir JSONL de ejemplo en los tests
    // -----------------------------------------------------------------------

    /// Genera un evento assistant mínimo en formato JSONL con usage real.
    fn make_assistant_event(ts: &str, stop_reason: &str) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": ts,
            "cwd": "C:/Users/dev/projects/my-app",
            "gitBranch": "main",
            "sessionId": "test-session-001",
            "message": {
                "model": "claude-opus-4-8",
                "stop_reason": stop_reason,
                "usage": {
                    "input_tokens": 1500,
                    "output_tokens": 320,
                    "cache_read_input_tokens": 45000,
                    "cache_creation_input_tokens": 2000
                },
                "content": [
                    {"type": "text", "text": "Aquí está la implementación solicitada."}
                ]
            }
        })
        .to_string()
    }

    /// Genera un evento user mínimo en formato JSONL.
    fn make_user_event(ts: &str, prompt: &str) -> String {
        serde_json::json!({
            "type": "user",
            "timestamp": ts,
            "cwd": "C:/Users/dev/projects/my-app",
            "gitBranch": "main",
            "sessionId": "test-session-001",
            "message": {
                "content": prompt
            }
        })
        .to_string()
    }

    // -----------------------------------------------------------------------
    // Test 1: parseo de usage -> context_tokens
    // -----------------------------------------------------------------------

    #[test]
    fn context_tokens_suma_entrada_sin_output() {
        // Escenario: un transcript con un turno assistant y un turno user.
        let ts_assistant = "2026-06-20T10:00:00Z";
        let ts_user = "2026-06-20T10:00:30Z"; // más reciente

        let jsonl = format!(
            "{}\n{}\n",
            make_assistant_event(ts_assistant, "end_turn"),
            make_user_event(ts_user, "Añade tests unitarios")
        );

        // Escribir en fichero temporal para que parse_session_file lo procese.
        let dir = std::env::temp_dir().join("ultron_session_mgr_test_1");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-001.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        // Usamos un now_secs lejano para que la sesión quede como "dead"
        // (evita que el test dependa del reloj del sistema).
        let far_future = parse_iso8601_secs(ts_user).unwrap() + THRESHOLD_IDLE_SECS + 1;
        let info = parse_session_file(&file, false, &[], far_future).unwrap();

        // input(1500) + cache_read(45000) + cache_creation(2000) = 48500 (output NO suma)
        assert_eq!(
            info.context_tokens, 48_500,
            "context_tokens debe sumar la entrada (input + cache_read + cache_creation), sin output"
        );
        // 48 500 <= 200 000 → ventana estándar.
        assert_eq!(info.context_limit, 200_000);
        assert_eq!(info.cache_read_tokens, 45_000);
        assert_eq!(info.output_tokens, 320);
        assert_eq!(info.model.as_deref(), Some("claude-opus-4-8"));
        assert_eq!(info.session_id, "test-session-001");
        assert!(!info.is_subagent);

        // Limpieza
        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 2: clasificación de status "working"
    // -----------------------------------------------------------------------

    #[test]
    fn status_working_cuando_evento_reciente_sin_stop_reason() {
        // Timestamp muy reciente (1 segundo atrás).
        let now_secs = now_unix_secs();
        let recent_ts = {
            use chrono::{TimeZone, Utc};
            Utc.timestamp_opt(now_secs as i64 - 1, 0)
                .single()
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "2026-06-20T10:00:00Z".to_string())
        };

        let jsonl = format!(
            "{}\n",
            make_assistant_event(&recent_ts, "") // sin stop_reason válido
        );

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_2");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-working.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let info = parse_session_file(&file, false, &[], now_secs).unwrap();

        // age < 90s + último evento assistant SIN "end_turn" -> "working"
        assert_eq!(
            info.status, "working",
            "debe ser 'working' con evento reciente sin stop_reason end_turn"
        );

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 3: clasificación de status "dead"
    // -----------------------------------------------------------------------

    #[test]
    fn status_dead_cuando_ultimo_evento_supera_5_horas() {
        let old_ts = "2026-06-19T00:00:00Z"; // ayer
        let jsonl = format!("{}\n", make_assistant_event(old_ts, "end_turn"));

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_3");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-dead.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        // now = viejo + 6 horas (supera THRESHOLD_IDLE_SECS)
        let old_secs = parse_iso8601_secs(old_ts).unwrap();
        let simulated_now = old_secs + THRESHOLD_IDLE_SECS + 3600;

        let info = parse_session_file(&file, false, &[], simulated_now).unwrap();
        assert_eq!(info.status, "dead", "debe ser 'dead' con age >= 5h");

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 4: "waiting" cuando assistant termina con end_turn en < 90s
    // -----------------------------------------------------------------------

    #[test]
    fn status_waiting_cuando_end_turn_reciente() {
        let now_secs = now_unix_secs();
        let recent_ts = {
            use chrono::{TimeZone, Utc};
            Utc.timestamp_opt(now_secs as i64 - 30, 0)
                .single()
                .map(|dt| dt.to_rfc3339())
                .unwrap_or_else(|| "2026-06-20T10:00:00Z".to_string())
        };

        let jsonl = format!("{}\n", make_assistant_event(&recent_ts, "end_turn"));

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_4");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-waiting.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let info = parse_session_file(&file, false, &[], now_secs).unwrap();
        assert_eq!(
            info.status, "waiting",
            "debe ser 'waiting' con end_turn reciente"
        );

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 5: journal.jsonl se ignora
    // -----------------------------------------------------------------------

    #[test]
    fn journal_jsonl_se_ignora() {
        let dir = std::env::temp_dir().join("ultron_session_mgr_test_5");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("journal.jsonl");
        std::fs::write(
            &file,
            make_assistant_event("2026-06-20T10:00:00Z", "end_turn"),
        )
        .unwrap();

        let result = parse_session_file(&file, false, &[], now_unix_secs());
        assert!(result.is_none(), "journal.jsonl debe retornar None");

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 6: fichero con líneas malformadas no hace panic
    // -----------------------------------------------------------------------

    #[test]
    fn lineas_malformadas_se_ignoran_silenciosamente() {
        let ts = "2026-06-20T08:00:00Z";
        let jsonl = format!(
            "NOT JSON\n\n{{}}\n{}\n",
            make_assistant_event(ts, "end_turn")
        );

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_6");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-malformed.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let old_secs = parse_iso8601_secs(ts).unwrap();
        let simulated_now = old_secs + THRESHOLD_IDLE_SECS + 1;

        // No debe hacer panic; debe devolver Some con los datos del evento válido.
        let result = parse_session_file(&file, false, &[], simulated_now);
        assert!(
            result.is_some(),
            "debe parsear correctamente ignorando líneas malformadas"
        );

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 12: contexto de 491k da ~49% sobre 1M, NO 100% sobre 200k (el bug)
    // -----------------------------------------------------------------------

    #[test]
    fn context_pct_no_satura_en_sesion_de_1m() {
        // Reproduce el caso real medido en runtime: cache_read ~490k.
        let ts = "2026-06-20T10:00:00Z";
        let jsonl = format!(
            "{}\n",
            serde_json::json!({
                "type": "assistant",
                "timestamp": ts,
                "cwd": "C:/Users/dev/projects/my-app",
                "message": {
                    "model": "claude-opus-4-8",
                    "stop_reason": "end_turn",
                    "usage": {
                        "input_tokens": 2,
                        "output_tokens": 784,
                        "cache_read_input_tokens": 490_460,
                        "cache_creation_input_tokens": 650
                    },
                    "content": [{"type": "text", "text": "ok"}]
                }
            })
        );

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_12");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-1m.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let old = parse_iso8601_secs(ts).unwrap();
        let info = parse_session_file(&file, false, &[], old + THRESHOLD_IDLE_SECS + 1).unwrap();

        // entrada = 2 + 490460 + 650 = 491112 (sin output)
        assert_eq!(info.context_tokens, 491_112);
        assert_eq!(
            info.context_limit, 1_000_000,
            "debe detectar la ventana de 1M"
        );
        assert!(
            (info.context_pct - 49.1112).abs() < 0.1,
            "context_pct debe ser ~49%, no saturar a 100% — fue {}",
            info.context_pct
        );

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 13: un evento de metadata SIN timestamp al final no descarta la sesión
    // -----------------------------------------------------------------------

    #[test]
    fn metadata_final_sin_timestamp_no_descarta_sesion() {
        // Caso real: Claude Code reescribe permission-mode/last-prompt SIN timestamp
        // al final del fichero. La sesión debe seguir detectándose, fechada por el
        // último evento que SÍ tiene timestamp (el turno assistant).
        let ts_assistant = "2026-06-20T10:00:00Z";
        let jsonl = format!(
            "{}\n{}\n{}\n",
            make_assistant_event(ts_assistant, "end_turn"),
            serde_json::json!({"type": "last-prompt", "leafUuid": "x", "sessionId": "s"}),
            serde_json::json!({"type": "permission-mode", "mode": "default", "sessionId": "s"}),
        );

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_13");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test-session-metadata-tail.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let old = parse_iso8601_secs(ts_assistant).unwrap();
        let result = parse_session_file(&file, false, &[], old + 10);

        assert!(
            result.is_some(),
            "la sesión NO debe descartarse por metadata final sin timestamp"
        );
        let info = result.unwrap();
        assert_eq!(
            info.last_activity, ts_assistant,
            "debe fecharse por el último evento CON timestamp"
        );
        // age = 10s → reciente y assistant end_turn → waiting.
        assert_eq!(info.status, "waiting");

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 8: is_subagent=true para ficheros agent-*
    // -----------------------------------------------------------------------

    #[test]
    fn agent_fichero_marcado_como_subagent() {
        let ts = "2026-06-20T09:00:00Z";
        let jsonl = format!("{}\n", make_assistant_event(ts, "end_turn"));

        let dir = std::env::temp_dir().join("ultron_session_mgr_test_8");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("agent-abc123.jsonl");
        std::fs::write(&file, &jsonl).unwrap();

        let old_secs = parse_iso8601_secs(ts).unwrap();
        let simulated_now = old_secs + THRESHOLD_IDLE_SECS + 1;

        let info = parse_session_file(&file, true, &[], simulated_now).unwrap();
        assert!(
            info.is_subagent,
            "agent-*.jsonl debe tener is_subagent=true"
        );
        assert_eq!(info.session_id, "agent-abc123");

        let _ = std::fs::remove_file(&file);
    }

    // -----------------------------------------------------------------------
    // Test 10: list_active_sessions_inner no hace panic aunque no haya carpeta
    // -----------------------------------------------------------------------

    #[test]
    fn list_active_sessions_no_panic_sin_carpeta_proyectos() {
        // Este test verifica que la función no hace panic incluso si
        // ~/.claude/projects/ no existe o está vacía. Simplemente devuelve Ok([]).
        // Como es un test de integración parcial (lee disco real), sólo verifica
        // que la llamada no hace panic y devuelve Result::Ok.
        let result = list_active_sessions_inner();
        assert!(
            result.is_ok(),
            "list_active_sessions_inner debe devolver Ok (nunca panic)"
        );
    }
}
