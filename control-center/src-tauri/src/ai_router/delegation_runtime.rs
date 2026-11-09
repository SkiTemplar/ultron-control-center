// Estado y ledger del delegador multi-motor (contrato §2 y §3 de
// docs/delegacion-contrato.md).
//
// - `ai_router_delegation_status` no reimplementa la disponibilidad de los
//   motores: lanza `node scripts/delegate.mjs status --json`, que es la única
//   fuente (la consume también Opus desde la terminal).
// - `ai_router_delegation_ledger` lee `cockpit/delegations.jsonl`, que
//   escribe `delegate.mjs` (una línea por intento y una por desenlace).

use std::path::Path;
use std::process::Command;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::exec::run_with_timeout;
use super::providers::truncate;
use super::types::{delegate_script_path, delegations_ledger_path};

/// Plazo de `delegate.mjs status --json` (consulta cuotas y saldos por red).
const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
/// Entradas devueltas cuando el llamante pide `limit = 0`.
const DEFAULT_LEDGER_LIMIT: usize = 100;
const MAX_LEDGER_LIMIT: usize = 2000;

/// Una línea del ledger: un intento (`attempt`, `engine`, `outcome`...) o un
/// desenlace (`final`). Solo `ts` e `id` son obligatorios.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub ts: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attempt: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tier: Option<String>,
    /// `ok | check-fail | engine-fail | no-changes | timeout | skipped`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// `quota | missing-key | disabled | not-installed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_ok: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files_changed: Option<u32>,
    /// Coste real de la tarea (runner `claude`: `total_cost_usd`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Nombre de la carpeta del repo, nunca la ruta.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Motivo del desenlace del intento (contrato §2): `scope`, `check`,
    /// `tree-changed`, `isolation`, `isolation-suspect`, `auth`, `git: …`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Entradas del checkout principal que cambiaron durante el intento sin
    /// poder atribuirlas al motor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub isolation_suspect: Option<u32>,
    /// `merged | discarded` en la línea de desenlace.
    #[serde(default, rename = "final", skip_serializing_if = "Option::is_none")]
    pub final_outcome: Option<String>,
}

/// Parsea el ledger y devuelve las `limit` entradas más recientes primero y
/// cuántas líneas no vacías se saltaron por inválidas. Pura.
pub(crate) fn parse_ledger(text: &str, limit: u32) -> (Vec<LedgerEntry>, usize) {
    let limit = match limit as usize {
        0 => DEFAULT_LEDGER_LIMIT,
        n => n.min(MAX_LEDGER_LIMIT),
    };
    let mut skipped = 0usize;
    let mut entries: Vec<LedgerEntry> = Vec::new();
    for line in text.lines().rev() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<LedgerEntry>(line) {
            Ok(e) if entries.len() < limit => entries.push(e),
            Ok(_) => {}
            Err(_) => skipped += 1,
        }
    }
    (entries, skipped)
}

pub(crate) fn read_ledger(limit: u32) -> Result<Vec<LedgerEntry>, String> {
    let path = delegations_ledger_path()?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {}", path.display(), e))?;
    let (entries, skipped) = parse_ledger(&text, limit);
    if skipped > 0 {
        tracing::warn!(
            path = %path.display(),
            skipped,
            "líneas del ledger de delegaciones que no parsean: se saltan"
        );
    }
    Ok(entries)
}

/// Interpreta la salida de `delegate.mjs status --json`. Un JSON válido en
/// stdout manda aunque el código de salida no sea 0 (el script informa de
/// motores caídos sin fallar); si no hay JSON, el error lleva el código y el
/// final de stderr. Pura.
pub(crate) fn parse_status_output(
    exit_code: Option<i32>,
    stdout: &[u8],
    stderr: &[u8],
) -> Result<Value, String> {
    let out = String::from_utf8_lossy(stdout);
    if let Ok(v) = serde_json::from_str::<Value>(out.trim()) {
        if v.is_object() {
            return Ok(v);
        }
    }
    let err = String::from_utf8_lossy(stderr);
    let detail = if err.trim().is_empty() { out } else { err };
    Err(format!(
        "delegate.mjs status --json no devolvió un objeto JSON (código {}): {}",
        exit_code.map_or_else(|| "?".to_string(), |c| c.to_string()),
        truncate(detail.trim(), 400)
    ))
}

pub(crate) fn run_delegate_status(script: &Path) -> Result<Value, String> {
    if !script.exists() {
        return Err(format!(
            "no existe {}: el delegador no está instalado en este repo",
            script.display()
        ));
    }
    let mut cmd = Command::new("node");
    cmd.arg(script).args(["status", "--json"]);
    if let Some(repo) = script.parent().and_then(Path::parent) {
        cmd.current_dir(repo);
    }
    let out = run_with_timeout(cmd, STATUS_TIMEOUT, None).map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            format!(
                "delegate.mjs status --json no respondió en {} s",
                STATUS_TIMEOUT.as_secs()
            )
        } else {
            format!("no se pudo lanzar node (¿está en el PATH?): {e}")
        }
    })?;
    parse_status_output(out.status.code(), &out.stdout, &out.stderr)
}

#[tauri::command]
pub async fn ai_router_delegation_status() -> Result<Value, String> {
    let script = delegate_script_path()?;
    tauri::async_runtime::spawn_blocking(move || run_delegate_status(&script))
        .await
        .map_err(|e| format!("tarea de estado del delegador: {e}"))?
}

#[tauri::command]
pub async fn ai_router_delegation_ledger(limit: u32) -> Result<Vec<LedgerEntry>, String> {
    read_ledger(limit)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_router::types::TestRootGuard;

    const LEDGER: &str = r#"{"ts":"2026-10-26T10:00:00Z","id":"d1","attempt":1,"engine":"codex","runner":"codex","model":"gpt-5.6-terra","tier":"complex","outcome":"engine-fail","skipReason":null,"durationS":12.5,"checkOk":null,"filesChanged":0,"costUsd":null,"branch":"delegate/d1","title":"t","repo":"ultron"}
esto no es json
{"ts":"2026-10-26T10:01:00Z","id":"d1","attempt":2,"engine":"claude-p","runner":"claude","outcome":"ok","checkOk":true,"filesChanged":3,"costUsd":0.0015}

{"id":"sin-ts"}
{"ts":"2026-10-26T10:02:00Z","id":"d1","final":"merged"}
"#;

    #[test]
    fn el_ledger_va_de_lo_mas_reciente_a_lo_mas_antiguo_y_cuenta_lo_invalido() {
        let (entries, skipped) = parse_ledger(LEDGER, 10);
        assert_eq!(skipped, 2, "la línea rota y la que no trae ts");
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].final_outcome.as_deref(), Some("merged"));
        assert_eq!(entries[1].cost_usd, Some(0.0015));
        assert_eq!(entries[1].check_ok, Some(true));
        assert_eq!(entries[2].skip_reason, None);
        assert_eq!(entries[2].duration_s, Some(12.5));
        let v = serde_json::to_value(&entries[0]).expect("ser");
        assert_eq!(
            v,
            serde_json::json!({"ts":"2026-10-26T10:02:00Z","id":"d1","final":"merged"})
        );
    }

    /// El motivo del fallo llega a la UI: antes serde lo descartaba y el
    /// historial no distinguía un test rojo de un alcance roto.
    #[test]
    fn el_motivo_del_intento_llega_a_la_ui() {
        let line = r#"{"ts":"t","id":"d","attempt":1,"engine":"agy","outcome":"check-fail","reason":"scope","isolationSuspect":2}"#;
        let (entries, skipped) = parse_ledger(line, 10);
        assert_eq!(skipped, 0);
        assert_eq!(entries[0].reason.as_deref(), Some("scope"));
        let v = serde_json::to_value(&entries[0]).expect("ser");
        assert_eq!(v["reason"], "scope");
        assert_eq!(v["isolationSuspect"], 2);
    }

    #[test]
    fn el_limite_se_respeta_y_cero_es_el_valor_por_defecto() {
        assert_eq!(parse_ledger(LEDGER, 1).0.len(), 1);
        assert_eq!(parse_ledger(LEDGER, 0).0.len(), 3);
    }

    #[test]
    fn sin_ledger_no_hay_entradas() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _g = TestRootGuard::new(dir.path());
        assert!(read_ledger(10).expect("read").is_empty());
        std::fs::create_dir_all(dir.path().join("cockpit")).expect("mkdir");
        std::fs::write(dir.path().join("cockpit/delegations.jsonl"), LEDGER).expect("w");
        assert_eq!(read_ledger(10).expect("read").len(), 3);
    }

    #[test]
    fn el_estado_acepta_json_aunque_el_codigo_no_sea_cero() {
        let v = parse_status_output(Some(1), br#"{"chain":["codex"],"engines":[]}"#, b"")
            .expect("json");
        assert_eq!(v["chain"][0], "codex");
    }

    /// Caso negativo: una salida que no es un objeto JSON da error con el
    /// código y stderr, no un valor vacío.
    #[test]
    fn el_estado_sin_json_da_un_error_claro() {
        let err = parse_status_output(Some(2), b"Usage: delegate.mjs", b"boom: falta X")
            .expect_err("no es json");
        assert!(
            err.contains("código 2") && err.contains("boom: falta X"),
            "{err}"
        );
        assert!(parse_status_output(Some(0), b"[1,2]", b"").is_err());
    }

    #[test]
    fn el_estado_sin_script_lo_dice() {
        let err = run_delegate_status(Path::new("Z:/no/existe/scripts/delegate.mjs"))
            .expect_err("sin script");
        assert!(err.contains("no existe"), "{err}");
    }

    /// Extremo a extremo con un `delegate.mjs` falso (requiere node).
    #[test]
    fn el_estado_lanza_node_con_status_json() {
        if !crate::ai_router::store::detect_cli("node") {
            eprintln!("node no está en el PATH: se omite");
            return;
        }
        let dir = tempfile::tempdir().expect("tempdir");
        let scripts = dir.path().join("scripts");
        std::fs::create_dir_all(&scripts).expect("mkdir");
        let script = scripts.join("delegate.mjs");
        std::fs::write(
            &script,
            "console.log(JSON.stringify({args: process.argv.slice(2), configSource: 'file'}));",
        )
        .expect("w");
        let v = run_delegate_status(&script).expect("status");
        assert_eq!(v["args"], serde_json::json!(["status", "--json"]));
    }
}
