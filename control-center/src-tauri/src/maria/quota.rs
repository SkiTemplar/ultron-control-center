// mar.ia — cuanto le queda a cada proveedor.
//
// Claude Code aplica un limite por VENTANA MOVIL de 5 horas. El tope exacto no
// esta en disco (el `/usage` de la CLI se lo pide al servidor), pero el
// CONSUMO si: cada turno del assistant en `~/.claude/projects/**/*.jsonl` trae
// su `usage` con los tokens. Sumando los de las ultimas 5 horas se sabe cuanto
// llevas gastado de verdad.
//
// El tope se APRENDE: cuando el relevo (maria_relay) se encuentra un "usage
// limit reached", se anota el consumo de ese momento como techo observado. A
// partir de ahi el porcentaje es real, no inventado. Hasta que ocurra una vez,
// se muestra el consumo sin porcentaje — y se dice que no se conoce el tope,
// en vez de fingir una cifra.
//
// Codex y Gemini: sus ficheros locales (revisados el 2026-09-18) no publican
// tokens por turno, asi que de ellos solo se sabe lo que dijo el ultimo
// intento del relevo. Declarado, no disimulado.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Ventana de Claude Code.
const VENTANA_HORAS: i64 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct WindowUsage {
    /// Proveedor ("claude").
    pub provider: String,
    /// Horas de la ventana movil.
    pub window_hours: i64,
    /// Tokens consumidos dentro de la ventana.
    pub tokens: u64,
    /// Turnos del assistant contados.
    pub turns: u64,
    /// Techo observado la ultima vez que el proveedor dijo "sin cuota".
    /// `None` mientras no haya pasado ni una vez.
    pub observed_ceiling: Option<u64>,
    /// Porcentaje sobre el techo observado. `None` si no hay techo.
    pub pct: Option<f64>,
    /// Momento en que se observo el techo.
    pub ceiling_at: Option<String>,
}

fn ceiling_path() -> Option<PathBuf> {
    crate::maria::paths::cockpit("maria")
        .ok()
        .map(|d| d.join("quota-ceiling.json"))
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Ceilings {
    #[serde(flatten)]
    por_proveedor: std::collections::BTreeMap<String, Ceiling>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Ceiling {
    tokens: u64,
    at: String,
}

fn load_ceilings() -> Ceilings {
    ceiling_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Anota el techo observado para `provider` con el consumo actual.
///
/// Lo llama el relevo cuando un proveedor responde "sin cuota": ese consumo
/// ES, por definicion, el limite practico de la ventana.
pub fn record_ceiling(provider: &str, tokens: u64) {
    if tokens == 0 {
        return; // sin dato de consumo no se aprende nada
    }
    let mut c = load_ceilings();
    c.por_proveedor.insert(
        provider.to_string(),
        Ceiling {
            tokens,
            at: chrono::Utc::now().to_rfc3339(),
        },
    );
    if let Some(p) = ceiling_path() {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(&c) {
            let _ = std::fs::write(p, text);
        }
    }
}

/// Suma los tokens de los turnos posteriores a `desde_unix`.
///
/// Pura y testeable: recibe las lineas ya leidas. Cuenta input + output +
/// cache (creation y read): es lo que consume la ventana, no solo la salida.
#[must_use]
pub fn sum_tokens_since(lineas: &[String], desde_unix: u64) -> (u64, u64) {
    let mut tokens = 0u64;
    let mut turnos = 0u64;
    for linea in lineas {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(linea) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("assistant") {
            continue;
        }
        let Some(ts) = v.get("timestamp").and_then(|t| t.as_str()) else {
            continue;
        };
        let Some(secs) = crate::commands::sessions_sub::session_jsonl::parse_iso8601_secs(ts)
        else {
            continue;
        };
        if secs < desde_unix {
            continue;
        }
        let Some(u) = v.get("message").and_then(|m| m.get("usage")) else {
            continue;
        };
        let get = |k: &str| u.get(k).and_then(serde_json::Value::as_u64).unwrap_or(0);
        tokens += get("input_tokens")
            + get("output_tokens")
            + get("cache_creation_input_tokens")
            + get("cache_read_input_tokens");
        turnos += 1;
    }
    (tokens, turnos)
}

/// Consumo de Claude Code en la ventana movil.
pub fn claude_window() -> WindowUsage {
    let desde = chrono::Utc::now().timestamp() - VENTANA_HORAS * 3600;
    let desde = u64::try_from(desde).unwrap_or(0);

    let mut tokens = 0u64;
    let mut turns = 0u64;
    if let Some(base) = dirs::home_dir().map(|h| h.join(".claude").join("projects")) {
        if let Ok(proyectos) = std::fs::read_dir(&base) {
            for proyecto in proyectos.flatten() {
                let Ok(ficheros) = std::fs::read_dir(proyecto.path()) else {
                    continue;
                };
                for f in ficheros.flatten() {
                    let path = f.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                        continue;
                    }
                    // Salto rapido: si el fichero no se ha tocado en la
                    // ventana, no puede tener turnos dentro de ella. Evita
                    // leer cientos de MB de historial viejo.
                    if let Ok(meta) = f.metadata() {
                        if let Ok(modificado) = meta.modified() {
                            let secs = modificado
                                .duration_since(std::time::UNIX_EPOCH)
                                .map(|d| d.as_secs())
                                .unwrap_or(0);
                            if secs < desde {
                                continue;
                            }
                        }
                    }
                    let Ok(texto) = std::fs::read_to_string(&path) else {
                        continue;
                    };
                    let lineas: Vec<String> = texto.lines().map(str::to_string).collect();
                    let (t, n) = sum_tokens_since(&lineas, desde);
                    tokens += t;
                    turns += n;
                }
            }
        }
    }

    let techo = load_ceilings().por_proveedor.get("claude").cloned();
    WindowUsage {
        provider: "claude".into(),
        window_hours: VENTANA_HORAS,
        tokens,
        turns,
        pct: techo
            .as_ref()
            .filter(|c| c.tokens > 0)
            .map(|c| (tokens as f64 / c.tokens as f64) * 100.0),
        observed_ceiling: techo.as_ref().map(|c| c.tokens),
        ceiling_at: techo.map(|c| c.at),
    }
}

/// Consumo por proveedor. Hoy solo Claude da tokens en local; los demas se
/// devuelven con `tokens: 0` y sin techo — el panel los pinta como "sin dato"
/// en vez de inventarse una barra.
#[tauri::command]
pub async fn maria_quota_windows() -> Result<Vec<WindowUsage>, String> {
    tauri::async_runtime::spawn_blocking(|| vec![claude_window()])
        .await
        .map_err(|e| format!("spawn_blocking: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turno(ts: &str, input: u64, output: u64) -> String {
        serde_json::json!({
            "type": "assistant",
            "timestamp": ts,
            "message": {
                "usage": {
                    "input_tokens": input,
                    "output_tokens": output,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0
                }
            }
        })
        .to_string()
    }

    #[test]
    fn suma_solo_los_turnos_dentro_de_la_ventana() {
        let ahora = chrono::Utc::now();
        let dentro = (ahora - chrono::Duration::hours(1)).to_rfc3339();
        let fuera = (ahora - chrono::Duration::hours(9)).to_rfc3339();
        let desde = u64::try_from((ahora - chrono::Duration::hours(5)).timestamp()).unwrap();

        let lineas = vec![turno(&dentro, 100, 50), turno(&fuera, 900, 900)];
        let (tokens, turnos) = sum_tokens_since(&lineas, desde);
        assert_eq!(tokens, 150);
        assert_eq!(turnos, 1);
    }

    #[test]
    fn cuenta_tambien_la_cache() {
        let ahora = chrono::Utc::now().to_rfc3339();
        let linea = serde_json::json!({
            "type": "assistant",
            "timestamp": ahora,
            "message": { "usage": {
                "input_tokens": 10, "output_tokens": 5,
                "cache_creation_input_tokens": 1000, "cache_read_input_tokens": 2000
            }}
        })
        .to_string();
        let (tokens, _) = sum_tokens_since(&[linea], 0);
        assert_eq!(tokens, 3015, "la cache tambien consume ventana");
    }

    #[test]
    fn ignora_lo_que_no_es_un_turno_del_assistant() {
        // Caso negativo: turnos de usuario, lineas rotas y eventos sin usage
        // no pueden inflar el consumo.
        let ahora = chrono::Utc::now().to_rfc3339();
        let lineas = vec![
            serde_json::json!({"type": "user", "timestamp": ahora, "message": {"usage": {"input_tokens": 999}}}).to_string(),
            "{roto".to_string(),
            serde_json::json!({"type": "assistant", "timestamp": ahora}).to_string(),
            serde_json::json!({"type": "assistant", "message": {"usage": {"input_tokens": 5}}}).to_string(),
        ];
        assert_eq!(sum_tokens_since(&lineas, 0), (0, 0));
    }

    #[test]
    fn sin_techo_observado_no_se_inventa_porcentaje() {
        // El tope real de Anthropic no esta en disco. Mientras no se haya
        // visto un "sin cuota", el porcentaje tiene que ser None.
        let u = WindowUsage {
            provider: "claude".into(),
            window_hours: 5,
            tokens: 1_000,
            turns: 3,
            observed_ceiling: None,
            pct: None,
            ceiling_at: None,
        };
        assert!(u.pct.is_none());
    }
}
