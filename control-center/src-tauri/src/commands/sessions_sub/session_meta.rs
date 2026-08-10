// commands/sessions_sub/session_meta.rs — Inferencia de metadatos de una sesión.
//
// Extraído de session_manager.rs (cat7.3 split). Agrupa la inferencia que NO
// depende del parseo bruto del JSONL: ventana de contexto, clasificación de
// estado por recencia, detección de procesos CLI vivos, y el match de una
// sesión con un proyecto ULTRON (id + nombre legible).

use super::session_manager::SessionInfo;

// ---------------------------------------------------------------------------
// Umbrales de clasificación de estado (sin PID, inferidos por recencia)
// ---------------------------------------------------------------------------

/// Límite superior de "en curso / esperando respuesta del usuario" (segundos).
pub(crate) const THRESHOLD_WORKING_SECS: u64 = 90;
/// Hasta este umbral la sesión se considera "inactiva pero reciente" (5 horas).
pub(crate) const THRESHOLD_IDLE_SECS: u64 = 5 * 3600;

/// Ventana de contexto por defecto de Claude Code (modelos Sonnet/Opus estándar).
pub(crate) const CONTEXT_LIMIT_DEFAULT: u64 = 200_000;
/// Ventana extendida (beta "context-1m", sesiones lanzadas con el modelo `[1m]`).
pub(crate) const CONTEXT_LIMIT_EXTENDED: u64 = 1_000_000;

// ---------------------------------------------------------------------------
// Inferencia de la ventana de contexto real
// ---------------------------------------------------------------------------

/// Infiere la ventana de contexto de la sesión a partir del contexto observado.
///
/// El transcript de Claude Code NO registra de forma estructurada si la sesión
/// usa la ventana extendida de 1M: el campo `model` es `"claude-opus-5"` sin
/// el sufijo `[1m]` (verificado en runtime sobre los `.jsonl` reales). Pero un
/// contexto que supera los 200 000 tokens sólo es físicamente posible en la
/// ventana de 1M — así que el propio uso ES la señal fiable.
///
/// ALCANCE (mandamiento 13): una sesión de 1M cuyo uso *actual* sea inferior a
/// 200 000 tokens se reportará sobre el límite de 200 000. No hay forma de
/// distinguirla de una sesión estándar sin una señal estructurada que el
/// transcript no expone.
pub(crate) fn context_window_for(context_tokens: u64) -> u64 {
    if context_tokens > CONTEXT_LIMIT_DEFAULT {
        CONTEXT_LIMIT_EXTENDED
    } else {
        CONTEXT_LIMIT_DEFAULT
    }
}

// ---------------------------------------------------------------------------
// Clasificación de estado (sin PID map)
// ---------------------------------------------------------------------------

/// Infiere el estado de la sesión a partir de la edad del último evento y el
/// tipo del último evento visible en la cola leída.
///
/// Umbrales documentados como constantes en la cabecera del módulo:
/// - `THRESHOLD_WORKING_SECS` = 90 s  → "working" o "waiting"
/// - `THRESHOLD_IDLE_SECS`    = 5 h   → "idle"
/// - más de 5 h               → "dead"
pub(crate) fn classify_status(
    age_secs: u64,
    last_event_type: &str,
    stop_reason: Option<&str>,
) -> &'static str {
    if age_secs < THRESHOLD_WORKING_SECS {
        // Sesión reciente: distinguir si el asistente terminó su turno o sigue
        // procesando.
        if last_event_type == "assistant"
            && matches!(stop_reason, Some("end_turn") | Some("stop_sequence"))
        {
            // El asistente terminó; está esperando que el usuario responda.
            "waiting"
        } else {
            // Evento user reciente, o assistant sin stop_reason (posiblemente en
            // curso) → consideramos que está trabajando.
            "working"
        }
    } else if age_secs < THRESHOLD_IDLE_SECS {
        "idle"
    } else {
        "dead"
    }
}

// ---------------------------------------------------------------------------
// Detección de sesiones CLI vivas (señal de proceso real, no solo tiempo)
// ---------------------------------------------------------------------------

/// Nº de sesiones CLI de Claude Code vivas, contando procesos `claude.exe`.
/// Señal REAL del SO: el mtime del transcript no distingue una sesión idle pero
/// VIVA (el usuario fue a por café) de una CERRADA, y por eso las cerradas
/// seguían saliendo "idle" hasta el umbral de 5 h. Devuelve `None` cuando no se
/// puede determinar (plataforma no Windows o `tasklist` no disponible) — el
/// llamador cae entonces a la clasificación puramente temporal previa.
///
/// ALCANCE (mandamiento 13): cuenta procesos, NO mapea PID <-> session_id (eso
/// exigiría leer el cwd del PEB de cada proceso). El llamador asume que las
/// sesiones vivas son las `n` más recientes; el resto se marcan cerradas.
pub(crate) fn count_live_cli_sessions() -> Option<usize> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let out = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq claude.exe", "/FO", "CSV", "/NH"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !out.status.success() {
            return None;
        }
        let s = String::from_utf8_lossy(&out.stdout);
        // Cada proceso es una línea CSV entre comillas; "No tasks" => 0 líneas.
        Some(
            s.lines()
                .filter(|l| l.trim_start().starts_with('"'))
                .count(),
        )
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Reclasifica las sesiones según la señal de proceso vivo. Asume `sessions`
/// ordenada por actividad descendente. Solo las `live` sesiones PRINCIPALES más
/// recientes pueden permanecer vivas; cualquier otra que el reloj dejó como
/// working/waiting/idle se marca "dead" (cerrada), de modo que una sesión cuyo
/// proceso CLI ya terminó deja de aparecer como activa. Los subagentes
/// (`agent-*.jsonl`) no son procesos `claude.exe` independientes, así que su
/// estado temporal se respeta y no cuentan para el cupo.
pub(crate) fn apply_liveness(sessions: &mut [SessionInfo], live: usize) {
    let mut main_rank = 0usize;
    for s in sessions.iter_mut() {
        if s.is_subagent {
            continue;
        }
        let within_live = main_rank < live;
        main_rank += 1;
        if !within_live && s.status != "dead" {
            s.status = "dead".to_string();
        }
    }
}

// ---------------------------------------------------------------------------
// Match de sesión con proyecto ULTRON
// ---------------------------------------------------------------------------

/// Intenta encontrar un `ProjectInfo` cuyo `path` sea igual (o prefijo) del
/// `session_cwd`. Devuelve el `id` del primer proyecto que casa.
///
/// Estrategia: primero match exacto (normalizado con barras hacia adelante para
/// evitar diferencias Windows vs Unix), luego prefijo más largo.
pub(crate) fn match_project_id(
    session_cwd: &str,
    projects: &[crate::projects::types::ProjectInfo],
) -> Option<String> {
    // Normalizar separadores para la comparación.
    let norm_cwd = session_cwd.replace('\\', "/").to_lowercase();

    // 1. Match exacto (ignorando barra final).
    let exact = projects.iter().find(|p| {
        p.path
            .as_deref()
            .map(|pp| {
                let np = pp.replace('\\', "/").to_lowercase();
                np.trim_end_matches('/') == norm_cwd.trim_end_matches('/')
            })
            .unwrap_or(false)
    });
    if let Some(p) = exact {
        return Some(p.id.clone());
    }

    // 2. Prefijo más largo: el proyecto cuyo path es el prefijo más específico
    //    del cwd de la sesión (útil cuando la sesión es una subcarpeta).
    projects
        .iter()
        .filter_map(|p| {
            let pp = p.path.as_deref()?;
            let np = pp.replace('\\', "/").to_lowercase();
            let prefix = format!("{}/", np.trim_end_matches('/'));
            if norm_cwd.starts_with(&prefix) || norm_cwd == np.trim_end_matches('/') {
                Some((prefix.len(), p.id.clone()))
            } else {
                None
            }
        })
        .max_by_key(|(len, _)| *len)
        .map(|(_, id)| id)
}

// ---------------------------------------------------------------------------
// Nombre legible de un cwd
// ---------------------------------------------------------------------------

/// Devuelve el nombre del proyecto ULTRON si hay match; de lo contrario extrae
/// el último componente del cwd (separadores Windows y Unix).
pub(crate) fn readable_name(
    cwd: &str,
    matched_id: Option<&str>,
    projects: &[crate::projects::types::ProjectInfo],
) -> String {
    if let Some(id) = matched_id {
        if let Some(p) = projects.iter().find(|p| p.id == id) {
            if let Some(name) = p.name.as_deref().filter(|n| !n.is_empty()) {
                return name.to_string();
            }
        }
    }
    // Último componente del path (separadores mixtos).
    // `rfind` es O(n) pero desde el final, que es lo idiomático para clippy.
    let normalised = cwd.replace('\\', "/");
    normalised
        .split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

// ---------------------------------------------------------------------------
// Tests unitarios de inferencia de metadatos
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_session(id: &str, status: &str, is_subagent: bool) -> SessionInfo {
        SessionInfo {
            session_id: id.to_string(),
            project_path: "C:/x".to_string(),
            project_name: "x".to_string(),
            matched_project_id: None,
            git_branch: None,
            model: None,
            context_tokens: 0,
            context_limit: CONTEXT_LIMIT_DEFAULT,
            context_pct: 0.0,
            cache_read_tokens: 0,
            output_tokens: 0,
            status: status.to_string(),
            last_activity: "2026-06-20T00:00:00Z".to_string(),
            age_seconds: 0,
            last_prompt: None,
            last_activity_summary: None,
            is_subagent,
        }
    }

    // -----------------------------------------------------------------------
    // context_window_for: la ventana se infiere del contexto observado
    // -----------------------------------------------------------------------

    #[test]
    fn ventana_se_infiere_del_contexto_observado() {
        // <= 200k → ventana estándar.
        assert_eq!(context_window_for(0), 200_000);
        assert_eq!(context_window_for(150_000), 200_000);
        assert_eq!(context_window_for(200_000), 200_000);
        // > 200k sólo cabe en la ventana de 1M.
        assert_eq!(context_window_for(200_001), 1_000_000);
        assert_eq!(context_window_for(491_112), 1_000_000);
    }

    #[test]
    fn context_pct_se_acota_a_100() {
        // Para acotar a 100 los tokens deben superar la ventana extendida (1M).
        let tokens_over_limit: u64 = CONTEXT_LIMIT_EXTENDED + 500_000;
        let limit = context_window_for(tokens_over_limit); // = 1M
        let pct = ((tokens_over_limit as f32 / limit as f32) * 100.0).min(100.0);
        assert!(
            (pct - 100.0f32).abs() < f32::EPSILON,
            "context_pct debe acotarse a 100.0 aunque los tokens superen el límite"
        );
    }

    // -----------------------------------------------------------------------
    // classify_status
    // -----------------------------------------------------------------------

    #[test]
    fn classify_status_waiting_y_working_y_idle_y_dead() {
        // Reciente + end_turn → waiting.
        assert_eq!(
            classify_status(10, "assistant", Some("end_turn")),
            "waiting"
        );
        // Reciente + assistant sin stop_reason válido → working.
        assert_eq!(classify_status(10, "assistant", None), "working");
        // Reciente + evento user → working.
        assert_eq!(classify_status(10, "user", None), "working");
        // Entre 90s y 5h → idle.
        assert_eq!(
            classify_status(THRESHOLD_WORKING_SECS, "assistant", Some("end_turn")),
            "idle"
        );
        // > 5h → dead.
        assert_eq!(
            classify_status(THRESHOLD_IDLE_SECS, "assistant", Some("end_turn")),
            "dead"
        );
    }

    // -----------------------------------------------------------------------
    // apply_liveness (detección de proceso vivo)
    // -----------------------------------------------------------------------

    #[test]
    fn apply_liveness_cierra_las_que_exceden_procesos_vivos() {
        // Orden por recencia desc; solo 1 proceso claude.exe vivo.
        let mut sessions = vec![
            make_session("s1", "working", false),
            make_session("s2", "idle", false),
            make_session("s3", "working", false),
        ];
        apply_liveness(&mut sessions, 1);
        assert_eq!(sessions[0].status, "working", "la más reciente sigue viva");
        assert_eq!(sessions[1].status, "dead", "fuera del top-1 => cerrada");
        assert_eq!(sessions[2].status, "dead", "fuera del top-1 => cerrada");
    }

    #[test]
    fn apply_liveness_cero_procesos_cierra_todas() {
        let mut sessions = vec![make_session("s1", "working", false)];
        apply_liveness(&mut sessions, 0);
        assert_eq!(
            sessions[0].status, "dead",
            "sin proceso claude.exe vivo, ninguna sesión está activa"
        );
    }

    #[test]
    fn apply_liveness_no_degrada_subagentes_ni_los_cuenta() {
        // El subagente no es un proceso claude.exe; no consume cupo ni se degrada.
        let mut sessions = vec![
            make_session("main", "working", false),
            make_session("agent-x", "working", true),
            make_session("main2", "working", false),
        ];
        apply_liveness(&mut sessions, 1);
        assert_eq!(sessions[0].status, "working", "1ª principal viva");
        assert_eq!(sessions[1].status, "working", "subagente intacto");
        assert_eq!(sessions[2].status, "dead", "2ª principal fuera del cupo");
    }

    // -----------------------------------------------------------------------
    // readable_name: sin match cae al último componente del cwd
    // -----------------------------------------------------------------------

    #[test]
    fn readable_name_sin_match_usa_ultimo_componente() {
        // Sin proyectos → último componente del cwd (separadores mixtos).
        assert_eq!(readable_name("C:\\Users\\dev\\cosa", None, &[]), "cosa");
        assert_eq!(readable_name("C:/Users/dev/otra/", None, &[]), "otra");
    }

    #[test]
    fn match_project_id_sin_proyectos_es_none() {
        assert!(match_project_id("C:/x", &[]).is_none());
    }
}
