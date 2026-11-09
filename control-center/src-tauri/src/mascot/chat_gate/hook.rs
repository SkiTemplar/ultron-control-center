// Mascota — respuesta del freno al hook PreToolUse de Claude Code y fichero
// de ajustes para `claude --settings` (ver chat_gate.rs).

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::{decide, ensure_known, record, snapshot, str_field, Gate};

/// Tope del hook en segundos: más que la espera de la confirmación (120 s).
const HOOK_TIMEOUT_S: u64 = 150;

/// `None` = sin objeción; `Some(Ok)` = confirmado; `Some(Err)` = denegado.
pub fn hook_output(decision: Option<Result<(), String>>) -> Value {
    match decision {
        None => json!({}),
        Some(Ok(())) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": "Confirmado por el usuario en el bocadillo de Pupus.",
            }
        }),
        Some(Err(msg)) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": msg,
            }
        }),
    }
}

/// `POST /v1/pretool`: cuerpo = entrada del hook PreToolUse de Claude Code.
/// Bloquea mientras el usuario decide (hasta 2 min, approve.rs).
pub fn pretool(app: &AppHandle, v: &Value) -> Value {
    let session = str_field(v, "session_id");
    let tool = str_field(v, "tool_name");
    let input = v.get("tool_input").cloned().unwrap_or(Value::Null);
    ensure_known(session);
    let (tainted, typed) = snapshot(session);
    let step = decide(tool, &input, tainted, &typed);
    let decision = match &step.gate {
        Gate::Pass => None,
        Gate::Ask { reason, summary } => {
            let r = crate::mascot::approve::ask(
                app,
                &json!({"tool": tool, "reason": reason, "summary": summary}),
            );
            if r.get("allow").and_then(Value::as_bool) == Some(true) {
                Some(Ok(()))
            } else {
                let msg = r
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("El usuario no lo ha permitido.");
                Some(Err(format!("{msg} No lo intentes por otro camino.")))
            }
        }
    };
    record(session, &step, !matches!(decision, Some(Err(_))));
    hook_output(decision)
}

// ---------------------------------------------------------------------------
// Fichero de ajustes para `claude --settings`
// ---------------------------------------------------------------------------

/// Ajustes con el hook del freno. Puros, para los tests.
pub fn hook_settings(port: u16, token: &str) -> Value {
    json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": "*",
                "hooks": [{
                    "type": "http",
                    "url": format!("http://127.0.0.1:{port}/v1/pretool"),
                    "headers": {"X-Ultron-Token": token},
                    "timeout": HOOK_TIMEOUT_S,
                    "onFailure": "block",
                }],
            }],
        }
    })
}

/// Escribe los ajustes del freno en la carpeta temporal del usuario (llevan
/// el token del puente, así que no van al repo) y devuelve la ruta. Error si
/// el puente no está escuchando: sin freno, Claude no se lanza con permisos.
pub fn write_hook_settings() -> Result<PathBuf, String> {
    let (port, token) = crate::mascot::bridge::port()
        .zip(crate::mascot::bridge::token())
        .ok_or("el puente de Pupus no está escuchando, así que no hay freno de confirmación")?;
    let dir = std::env::temp_dir().join("ultron-pupus");
    std::fs::create_dir_all(&dir).map_err(|e| format!("crear {}: {e}", dir.display()))?;
    let path = dir.join("chat-settings.json");
    let body = hook_settings(port, &token).to_string();
    // El token solo cambia al arrancar ULTRON: si el fichero ya es este, no se
    // reescribe (otro `claude -p` en marcha puede estar leyéndolo).
    if std::fs::read_to_string(&path).is_ok_and(|old| old == body) {
        return Ok(path);
    }
    // Temporal único: dos turnos a la vez no se pisan el mismo `.tmp`.
    let tmp = dir.join(format!(
        "chat-settings.{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&tmp, &body).map_err(|e| format!("escribir {}: {e}", tmp.display()))?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("renombrar {}: {e}", path.display()));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_salida_del_hook_tiene_el_formato_de_claude_code() {
        assert_eq!(hook_output(None), json!({}));
        let ok = hook_output(Some(Ok(())));
        assert_eq!(ok["hookSpecificOutput"]["permissionDecision"], "allow");
        let no = hook_output(Some(Err("no".into())));
        assert_eq!(no["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(no["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    }

    #[test]
    fn los_ajustes_del_hook_fallan_cerrado_y_esperan_a_la_confirmacion() {
        let s = hook_settings(1234, "tok");
        let h = &s["hooks"]["PreToolUse"][0];
        assert_eq!(h["matcher"], "*");
        let hook = &h["hooks"][0];
        assert_eq!(hook["type"], "http");
        assert_eq!(hook["url"], "http://127.0.0.1:1234/v1/pretool");
        assert_eq!(hook["headers"]["X-Ultron-Token"], "tok");
        assert_eq!(
            hook["onFailure"], "block",
            "sin esto, un puente caído deja pasar todo"
        );
        assert!(
            hook["timeout"].as_u64().unwrap() > 120,
            "más que la espera del bocadillo"
        );
    }

    #[test]
    fn sin_puente_no_hay_ajustes_y_claude_no_se_lanza_con_permisos() {
        // En los tests el puente no arranca (`bridge::start` necesita la app).
        let err = write_hook_settings().expect_err("sin puente no hay freno");
        assert!(err.contains("puente"), "{err}");
    }
}
