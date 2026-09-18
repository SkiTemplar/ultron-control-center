// commands/memory/portrait — Memory -> Retrato (2026-09-16).
//
// El retrato lo genera `scripts/memory-portrait.mjs` (claude -p Sonnet sobre
// la memoria personal) en `cockpit/memory-portrait/portrait.json`, gitignorado
// porque contiene datos personales. Estos comandos solo lo leen, marcan
// afirmaciones (confirmada / descartada / sin marca) y lanzan la regeneración.
// La regeneración respeta las marcas: una descartada no vuelve y una
// confirmada se conserva.

use std::path::PathBuf;

use serde_json::Value;

const VALID_STATES: &[&str] = &["none", "confirmed", "discarded"];

fn portrait_path() -> Result<PathBuf, String> {
    Ok(crate::ultron_root()?
        .join("cockpit")
        .join("memory-portrait")
        .join("portrait.json"))
}

/// Retrato actual, o `null` si todavía no se ha generado.
#[tauri::command]
pub fn memory_portrait_get() -> Result<Option<Value>, String> {
    let path = portrait_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("leer retrato: {e}"))?;
    serde_json::from_str(&raw)
        .map(Some)
        .map_err(|e| format!("retrato con JSON inválido: {e}"))
}

/// Cambia el `estado` de la afirmación `claim_id`. Devuelve `false` si no existe.
fn set_claim_state(portrait: &mut Value, claim_id: &str, state: &str) -> bool {
    let Some(bloques) = portrait.get_mut("bloques").and_then(|b| b.as_array_mut()) else {
        return false;
    };
    for bloque in bloques {
        let Some(afirmaciones) = bloque
            .get_mut("afirmaciones")
            .and_then(|a| a.as_array_mut())
        else {
            continue;
        };
        for a in afirmaciones {
            if a.get("id").and_then(|v| v.as_str()) == Some(claim_id) {
                a["estado"] = Value::String(state.to_string());
                return true;
            }
        }
    }
    false
}

/// Marca una afirmación y persiste el retrato (escritura atómica).
#[tauri::command]
pub fn memory_portrait_mark(claim_id: String, state: String) -> Result<Value, String> {
    if !VALID_STATES.contains(&state.as_str()) {
        return Err(format!(
            "estado inválido '{state}' (none|confirmed|discarded)"
        ));
    }
    let path = portrait_path()?;
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("leer retrato: {e}"))?;
    let mut portrait: Value =
        serde_json::from_str(&raw).map_err(|e| format!("retrato con JSON inválido: {e}"))?;
    if !set_claim_state(&mut portrait, &claim_id, &state) {
        return Err(format!("no existe la afirmación '{claim_id}'"));
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(&portrait).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| format!("escribir retrato: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("renombrar retrato: {e}"))?;
    Ok(portrait)
}

/// Lanza la regeneración en segundo plano (tarda 1-3 min). La UI sondea
/// `memory_portrait_get` hasta que cambie `generated_at`.
#[tauri::command]
pub fn memory_portrait_regenerate() -> Result<String, String> {
    let root = crate::ultron_root()?;
    let script = root.join("scripts").join("memory-portrait.mjs");
    if !script.exists() {
        return Err(format!("no existe {}", script.display()));
    }
    let node = which::which("node").map_err(|_| "node no está en el PATH".to_string())?;
    let log_dir = root.join("logs");
    std::fs::create_dir_all(&log_dir).map_err(|e| format!("crear logs: {e}"))?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("memory-portrait.log"))
        .map_err(|e| format!("abrir log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;
    let mut cmd = crate::proc::oculto(node);
    cmd.arg(&script)
        .current_dir(&root)
        .stdout(log)
        .stderr(log_err);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.spawn()
        .map_err(|e| format!("lanzar memory-portrait: {e}"))?;
    Ok("started".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Value {
        json!({
            "bloques": [
                {"id": "quien_es", "afirmaciones": [
                    {"id": "a1", "texto": "x", "estado": "none"},
                    {"id": "a2", "texto": "y", "estado": "none"}
                ]}
            ]
        })
    }

    #[test]
    fn marca_la_afirmacion_indicada_y_solo_esa() {
        let mut p = sample();
        assert!(set_claim_state(&mut p, "a2", "discarded"));
        assert_eq!(p["bloques"][0]["afirmaciones"][1]["estado"], "discarded");
        assert_eq!(p["bloques"][0]["afirmaciones"][0]["estado"], "none");
    }

    #[test]
    fn id_inexistente_devuelve_false_sin_tocar_nada() {
        let mut p = sample();
        let antes = p.clone();
        assert!(!set_claim_state(&mut p, "zz", "confirmed"));
        assert_eq!(p, antes);
    }

    #[test]
    fn retrato_sin_bloques_devuelve_false() {
        let mut p = json!({"resumen": "x"});
        assert!(!set_claim_state(&mut p, "a1", "confirmed"));
    }
}
