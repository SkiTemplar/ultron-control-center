// sesiones/delegaciones.rs — Delegaciones de `scripts/delegate.mjs` lanzadas
// por una sesión, para el árbol de Agentes (`sesiones_delegations`).
//
// Cada run deja `<delegaciones>/<id>/meta.json` (se reescribe al empezar y al
// acabar cada intento) y, al terminar, `result.json`. El run se ata a su
// sesión por `session`, que el script toma de `ULTRON_SESION_ID`: un run
// lanzado fuera de Sessions, o por una versión anterior del script, no lleva
// sesión y no sale en ningún árbol.
//
// Un run sin `result.json` está en marcha salvo que `meta.json` lleve sin
// escribirse más que el plazo del intento y un margen: entonces el proceso
// murió sin cerrar y se marca `stale`, no terminado.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use serde_json::Value;

/// Tope de filas por sesión (las más recientes).
const MAX_RUNS: usize = 8;
/// Plazo por intento si `meta.json` no lo trae (`DEFAULT_TIMEOUT_S` del script).
const TIMEOUT_S_POR_DEFECTO: u64 = 1800;
/// Margen sobre el plazo del intento: el check y el commit van después del motor.
const MARGEN_SIN_SENAL_MS: u64 = 10 * 60 * 1000;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationAttempt {
    pub attempt: u32,
    pub engine: String,
    pub model: Option<String>,
    /// `ok` | `check-fail` | `engine-fail` | `skipped`…, tal cual lo escribe el script.
    pub outcome: String,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DelegationRun {
    pub id: String,
    pub title: String,
    pub tier: String,
    /// `running` | `done` | `error` | `stale`.
    pub status: String,
    /// Motor y modelo del intento en curso; terminado, los del intento que
    /// pasó el check o, si ninguno, los del último que se ejecutó.
    pub engine: Option<String>,
    pub model: Option<String>,
    /// Número del intento al que corresponden `engine` y `model`.
    pub attempt: u32,
    pub started_at: String,
    pub attempts: Vec<DelegationAttempt>,
}

fn texto(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn numero(v: &Value, k: &str) -> u32 {
    v.get(k)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

fn intento(v: &Value) -> Option<DelegationAttempt> {
    Some(DelegationAttempt {
        attempt: numero(v, "attempt"),
        engine: texto(v, "engine")?,
        model: texto(v, "model"),
        outcome: texto(v, "outcome")?,
        reason: texto(v, "reason"),
    })
}

fn leer_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

fn escrito_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Estado del run: `result.json` manda; sin él, en marcha o sin señal.
fn estado(dir: &Path, meta: &Value, ahora_ms: u64) -> &'static str {
    if let Some(res) = leer_json(&dir.join("result.json")) {
        return if res.get("code").and_then(Value::as_i64) == Some(0) {
            "done"
        } else {
            "error"
        };
    }
    let plazo_s = meta
        .get("timeoutS")
        .and_then(Value::as_u64)
        .unwrap_or(TIMEOUT_S_POR_DEFECTO);
    let limite = plazo_s
        .saturating_mul(1000)
        .saturating_add(MARGEN_SIN_SENAL_MS);
    if ahora_ms.saturating_sub(escrito_ms(&dir.join("meta.json"))) > limite {
        "stale"
    } else {
        "running"
    }
}

/// Motor, modelo e intento que representan al run.
fn protagonista(
    meta: &Value,
    attempts: &[DelegationAttempt],
    en_marcha: bool,
) -> (Option<String>, Option<String>, u32) {
    if let Some(c) = meta.get("current").filter(|c| en_marcha && c.is_object()) {
        return (texto(c, "engine"), texto(c, "model"), numero(c, "attempt"));
    }
    let reales = || attempts.iter().filter(|a| a.outcome != "skipped");
    let elegido = reales()
        .find(|a| a.outcome == "ok")
        .or_else(|| reales().last());
    match elegido {
        Some(a) => (Some(a.engine.clone()), a.model.clone(), a.attempt),
        None => (None, None, 0),
    }
}

fn run_de(dir: &Path, sesion: &str, ahora_ms: u64) -> Option<DelegationRun> {
    let meta = leer_json(&dir.join("meta.json"))?;
    if meta.get("session").and_then(Value::as_str) != Some(sesion) {
        return None;
    }
    let attempts: Vec<DelegationAttempt> = meta
        .get("attempts")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(intento).collect())
        .unwrap_or_default();
    let status = estado(dir, &meta, ahora_ms);
    let (engine, model, attempt) =
        protagonista(&meta, &attempts, status != "done" && status != "error");
    Some(DelegationRun {
        id: texto(&meta, "id")?,
        title: texto(&meta, "title").unwrap_or_default(),
        tier: texto(&meta, "tier").unwrap_or_default(),
        status: status.to_string(),
        engine,
        model,
        attempt,
        started_at: texto(&meta, "startedAt").unwrap_or_default(),
        attempts,
    })
}

/// Runs de la sesión en `dir`, del más antiguo al más reciente (los últimos
/// `MAX_RUNS`). Un directorio que no existe no es un error: aún no se delegó.
pub fn leer(dir: &Path, sesion: &str, ahora_ms: u64) -> Result<Vec<DelegationRun>, String> {
    if sesion.is_empty() {
        return Ok(Vec::new());
    }
    let entradas = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("read {}: {e}", dir.display())),
    };
    let mut runs: Vec<DelegationRun> = entradas
        .filter_map(Result::ok)
        .filter_map(|e| run_de(&e.path(), sesion, ahora_ms))
        .collect();
    runs.sort_by(|a, b| {
        a.started_at
            .cmp(&b.started_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let sobran = runs.len().saturating_sub(MAX_RUNS);
    Ok(runs.split_off(sobran))
}

/// Directorio de delegaciones, con el mismo override que `delegate.mjs`.
fn directorio() -> Result<PathBuf, String> {
    match std::env::var("ULTRON_DELEGATE_DIR") {
        Ok(d) if !d.trim().is_empty() => Ok(PathBuf::from(d)),
        _ => crate::ai_router::types::delegations_dir(),
    }
}

pub fn de_sesion(sesion: &str) -> Result<Vec<DelegationRun>, String> {
    leer(&directorio()?, sesion, super::agentes::ahora_ms())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const AHORA: u64 = u64::MAX / 2;

    fn run(dir: &Path, id: &str, meta: Value, code: Option<i64>) {
        let d = dir.join(id);
        std::fs::create_dir_all(&d).expect("mkdir");
        std::fs::write(d.join("meta.json"), meta.to_string()).expect("meta");
        if let Some(code) = code {
            std::fs::write(d.join("result.json"), json!({ "code": code }).to_string())
                .expect("res");
        }
    }

    fn meta(id: &str, sesion: Value, started: &str) -> Value {
        json!({"id": id, "title": "Crear x", "tier": "standard", "session": sesion,
            "startedAt": started, "attempts": [], "current": null})
    }

    /// Reloj justo después de la escritura: nada está sin señal.
    fn reciente(dir: &Path, id: &str) -> u64 {
        escrito_ms(&dir.join(id).join("meta.json")) + 1000
    }

    #[test]
    fn en_marcha_muestra_el_motor_y_el_modelo_del_intento_en_curso() {
        let t = tempfile::tempdir().expect("tmp");
        let mut m = meta("r1", json!("s1"), "2026-11-19T10:00:00Z");
        m["attempts"] = json!([{"attempt":1,"engine":"claude-p","model":"claude-sonnet-5-5","outcome":"check-fail","reason":"check"}]);
        m["current"] = json!({"attempt":2,"engine":"codex","model":"gpt-6.1-terra"});
        run(t.path(), "r1", m, None);
        let runs = leer(t.path(), "s1", reciente(t.path(), "r1")).expect("leer");
        assert_eq!(runs.len(), 1);
        let r = &runs[0];
        assert_eq!(
            (
                r.status.as_str(),
                r.engine.as_deref(),
                r.model.as_deref(),
                r.attempt
            ),
            ("running", Some("codex"), Some("gpt-6.1-terra"), 2)
        );
        assert_eq!(r.attempts[0].reason.as_deref(), Some("check"));
    }

    #[test]
    fn terminado_muestra_el_intento_que_paso_el_check_y_el_codigo_manda() {
        let t = tempfile::tempdir().expect("tmp");
        let intentos = json!([
            {"attempt":1,"engine":"claude-p","model":"claude-opus-5-5","outcome":"engine-fail"},
            {"attempt":2,"engine":"codex","model":"gpt-6.1-sol","outcome":"ok"},
            {"attempt":3,"engine":"agy","model":null,"outcome":"skipped"}]);
        let mut ok = meta("ok", json!("s1"), "1");
        ok["attempts"] = intentos.clone();
        run(t.path(), "ok", ok, Some(0));
        let mut rojo = meta("rojo", json!("s1"), "2");
        rojo["attempts"] = json!([{"attempt":1,"engine":"claude-p","model":"claude-haiku-5-5","outcome":"check-fail"},
            {"attempt":2,"engine":"agy","outcome":"skipped"}]);
        // Un `current` que quedó escrito no se pinta en un run ya cerrado.
        rojo["current"] = json!({"attempt":9,"engine":"fantasma","model":"x"});
        run(t.path(), "rojo", rojo, Some(2));
        let runs = leer(t.path(), "s1", AHORA).expect("leer");
        let vista: Vec<_> = runs
            .iter()
            .map(|r| {
                (
                    r.status.as_str(),
                    r.engine.as_deref(),
                    r.model.as_deref(),
                    r.attempt,
                )
            })
            .collect();
        assert_eq!(
            vista,
            vec![
                ("done", Some("codex"), Some("gpt-6.1-sol"), 2),
                ("error", Some("claude-p"), Some("claude-haiku-5-5"), 1),
            ]
        );
    }

    #[test]
    fn caso_negativo_otra_sesion_sin_sesion_o_meta_roto_no_salen() {
        let t = tempfile::tempdir().expect("tmp");
        run(t.path(), "otra", meta("otra", json!("s2"), "1"), None);
        run(t.path(), "suelta", meta("suelta", Value::Null, "1"), None);
        std::fs::create_dir_all(t.path().join("rota")).expect("mkdir");
        std::fs::write(t.path().join("rota/meta.json"), "{no json").expect("w");
        std::fs::write(t.path().join("fichero.txt"), "x").expect("w");
        assert!(leer(t.path(), "s1", AHORA).expect("leer").is_empty());
        assert!(leer(t.path(), "", AHORA).expect("leer").is_empty());
        assert!(leer(&t.path().join("no-existe"), "s1", AHORA)
            .expect("leer")
            .is_empty());
    }

    #[test]
    fn sin_resultado_y_callado_mas_que_el_plazo_es_sin_senal_no_terminado() {
        let t = tempfile::tempdir().expect("tmp");
        let mut m = meta("r1", json!("s1"), "1");
        m["timeoutS"] = json!(60);
        m["current"] = json!({"attempt":1,"engine":"codex","model":"m"});
        run(t.path(), "r1", m, None);
        let escrito = escrito_ms(&t.path().join("r1/meta.json"));
        let dentro = escrito + 60_000 + MARGEN_SIN_SENAL_MS;
        assert_eq!(
            leer(t.path(), "s1", dentro).expect("leer")[0].status,
            "running"
        );
        let fuera = leer(t.path(), "s1", dentro + 1).expect("leer");
        assert_eq!(fuera[0].status, "stale");
        assert_eq!(
            fuera[0].engine.as_deref(),
            Some("codex"),
            "sigue diciendo qué motor era"
        );
    }

    #[test]
    fn solo_los_ultimos_runs_en_orden_de_lanzamiento() {
        let t = tempfile::tempdir().expect("tmp");
        for i in 0..(MAX_RUNS + 3) {
            let id = format!("r{i:02}");
            run(
                t.path(),
                &id,
                meta(&id, json!("s1"), &format!("2026-11-19T10:{i:02}:00Z")),
                Some(0),
            );
        }
        let runs = leer(t.path(), "s1", AHORA).expect("leer");
        assert_eq!(runs.len(), MAX_RUNS);
        assert_eq!(runs[0].id, "r03");
        assert_eq!(runs[MAX_RUNS - 1].id, format!("r{:02}", MAX_RUNS + 2));
    }
}
