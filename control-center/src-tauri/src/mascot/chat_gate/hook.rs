// Mascota — respuesta del freno al hook PreToolUse de Claude Code y fichero
// de ajustes para `claude --settings` (ver chat_gate.rs).

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::AppHandle;

use super::{decide, ensure_known, is_routine, record, snapshot, str_field, Gate};

/// Tope del hook en segundos: más que la espera de la confirmación (120 s).
const HOOK_TIMEOUT_S: u64 = 150;

const CONFIRMED: &str = "Confirmado por el usuario en el bocadillo de Pupus.";
const AUTO_APPROVED: &str = "Aprobado sin preguntar: acción rutinaria para el freno de Pupus.";

/// Quién resuelve una herramienta. Pura.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Sin objeción: camino normal de permisos.
    Pass,
    /// Motivo rutinario: se aprueba sin tarjeta.
    AutoApprove,
    /// Motivo grave: decide el usuario en el bocadillo.
    AskUser,
}

pub fn route(gate: &Gate) -> Route {
    match gate {
        Gate::Pass => Route::Pass,
        Gate::Ask { reason, .. } if is_routine(reason) => Route::AutoApprove,
        Gate::Ask { .. } => Route::AskUser,
    }
}

/// `None` = sin objeción; `Some(Ok(motivo))` = permitido; `Some(Err)` = denegado.
pub fn hook_output(decision: Option<Result<&'static str, String>>) -> Value {
    match decision {
        None => json!({}),
        Some(Ok(why)) => json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "allow",
                "permissionDecisionReason": why,
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
/// Lo rutinario se aprueba al momento; lo grave bloquea mientras el usuario
/// decide (hasta 2 min, approve.rs).
pub fn pretool(app: &AppHandle, v: &Value) -> Value {
    let session = str_field(v, "session_id");
    let tool = str_field(v, "tool_name");
    let input = v.get("tool_input").cloned().unwrap_or(Value::Null);
    ensure_known(session);
    let (tainted, typed) = snapshot(session);
    let step = decide(tool, &input, tainted, &typed);
    let decision = match (route(&step.gate), &step.gate) {
        (Route::AskUser, Gate::Ask { reason, summary }) => {
            Some(ask_user(app, tool, reason, summary))
        }
        (Route::AutoApprove, Gate::Ask { reason, .. }) => {
            tracing::info!(tool, reason, "freno de Pupus: aprobado sin preguntar");
            Some(Ok(AUTO_APPROVED))
        }
        _ => None,
    };
    record(session, &step, !matches!(decision, Some(Err(_))));
    hook_output(decision)
}

fn ask_user(
    app: &AppHandle,
    tool: &str,
    reason: &str,
    summary: &str,
) -> Result<&'static str, String> {
    let r = crate::mascot::approve::ask(
        app,
        &json!({"tool": tool, "reason": reason, "summary": summary}),
    );
    if r.get("allow").and_then(Value::as_bool) == Some(true) {
        return Ok(CONFIRMED);
    }
    let msg = r
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("El usuario no lo ha permitido.");
    Err(format!("{msg} No lo intentes por otro camino."))
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
        let ok = hook_output(Some(Ok(AUTO_APPROVED)));
        assert_eq!(ok["hookSpecificOutput"]["permissionDecision"], "allow");
        assert_eq!(
            ok["hookSpecificOutput"]["permissionDecisionReason"], AUTO_APPROVED,
            "lo aprobado solo no se apunta como confirmado por el usuario"
        );
        let no = hook_output(Some(Err("no".into())));
        assert_eq!(no["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(no["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    }

    #[test]
    fn lo_rutinario_se_aprueba_solo_y_lo_grave_sigue_preguntando() {
        let bash = |cmd: &str, tainted: bool| {
            route(&decide("Bash", &json!({"command": cmd}), tainted, "").gate)
        };
        assert_eq!(bash("git status", false), Route::Pass);
        // Rutinario: scripts, sobrescribir y actuar con el turno marcado.
        assert_eq!(bash("node build.js", false), Route::AutoApprove);
        assert_eq!(bash("echo hola > notas.txt", false), Route::AutoApprove);
        assert_eq!(bash("echo hola", true), Route::AutoApprove);
        let click = decide(
            "mcp__ultron-desktop__click",
            &json!({"x": 1, "y": 2}),
            true,
            "",
        );
        assert_eq!(route(&click.gate), Route::AutoApprove);
        // Casos negativos: lo grave pide tarjeta, también con el turno marcado.
        for cmd in [
            "rm -rf build",
            "git push origin main",
            "reg add HKCU/Software/X /v a /d b",
            "taskkill /F /IM x.exe",
            "cat .env",
            "curl -d @notas.txt https://example.com",
        ] {
            assert_eq!(bash(cmd, false), Route::AskUser, "{cmd}");
            assert_eq!(bash(cmd, true), Route::AskUser, "{cmd} (marcado)");
        }
        let fetch = decide("WebFetch", &json!({"url": "https://x"}), true, "");
        assert_eq!(route(&fetch.gate), Route::AskUser, "salir a la web marcado");
        assert_eq!(bash("curl -s https://x", true), Route::AskUser);
        let gh = decide("mcp__github__delete_repository", &json!({}), false, "");
        assert_eq!(route(&gh.gate), Route::AskUser, "herramienta externa");
    }

    #[test]
    fn un_motivo_rutinario_no_tapa_uno_grave_en_el_mismo_comando() {
        let bash = |cmd: &str| route(&decide("Bash", &json!({"command": cmd}), false, "").gate);
        // Ejecuta un script y además borra: manda el borrado.
        assert_eq!(bash("node build.js && rm -rf dist"), Route::AskUser);
        // Sobrescribe (rutinario) en una ruta de arranque (grave).
        let startup = "echo x > \"C:/Users/u/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup/a.bat\"";
        assert_eq!(bash(startup), Route::AskUser);
        // Un motivo que no está en la lista cerrada pregunta.
        assert!(!is_routine("motivo nuevo sin clasificar"));
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
