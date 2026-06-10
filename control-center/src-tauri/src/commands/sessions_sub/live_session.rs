// commands/sessions_sub/live_session.rs — Live Session Monitor feed.
//
// Lee, READ-ONLY, los logs que los hooks ya escriben para que la UI muestre EN
// VIVO la actividad de la sesion activa de Claude Code:
//   ~/.claude/logs/orchestrate.jsonl        — memory-orchestrate.js: route / workflow /
//                                              agentes a delegar / skills / memorias por turno
//   ~/.claude/logs/routing-dispatcher.jsonl  — routing-dispatcher: skill injection + confidence
//   ~/.ultron/cockpit/delegations.jsonl      — agentes delegados (reusa list_delegations_inner)
//
// Tolerante a lineas malformadas o de esquema antiguo (se ignoran). Devuelve la
// actividad reciente combinada (la decision "todo combinado" del usuario).

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use crate::agent_orchestration::{list_delegations_inner, DelegationLogEntry};

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 200;
/// Bytes medios por linea JSONL — acota la lectura de cola para no releer el
/// fichero entero en cada poll (routing-dispatcher.jsonl crece por cada prompt).
const AVG_LINE_BYTES: u64 = 300;

fn claude_logs_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".claude").join("logs"))
}

/// Read the last `limit` valid JSON lines of a `.jsonl` file, newest first.
/// Lee SOLO la cola (seek desde el final) para que el coste sea O(limit) y no
/// O(file_size): vital con polling cada 3 s sobre logs que crecen sin cota.
/// Tolerante: lineas en blanco/malformadas/de esquema viejo se ignoran; la
/// primera linea (posiblemente cortada por el seek) se descarta. Empty si falta.
fn read_jsonl_tail<T: serde::de::DeserializeOwned>(path: &Path, limit: usize) -> Vec<T> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let file_len = file.seek(SeekFrom::End(0)).unwrap_or(0);
    // Cola suficiente para `limit` lineas con margen (x4) para lineas malas.
    let want = (limit as u64 + 4)
        .saturating_mul(AVG_LINE_BYTES)
        .saturating_mul(4);
    let start = file_len.saturating_sub(want);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    // from_utf8_lossy evita panics si el seek partio un caracter multibyte.
    let text = String::from_utf8_lossy(&bytes);
    // Si no arrancamos en el inicio, la primera linea puede venir cortada.
    let body: &str = if start > 0 {
        match text.find('\n') {
            Some(i) => &text[i + 1..],
            None => "",
        }
    } else {
        &text
    };
    let mut out: Vec<T> = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<T>(l).ok())
        .collect();
    if out.len() > limit {
        out = out.split_off(out.len() - limit);
    }
    out.reverse(); // newest first
    out
}

// ---------------------------------------------------------------------------
// Log entry shapes (campos opcionales para tolerar variaciones del JSONL)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowLite {
    pub id: Option<String>,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentLite {
    pub name: String,
    #[serde(default)]
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillLite {
    pub name: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryLite {
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub summary: String,
}

/// One turn of orchestration as logged by memory-orchestrate.js.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrchestrateLogEntry {
    pub ts: Option<String>,
    pub session_id: Option<String>,
    pub project: Option<String>,
    pub prompt: Option<String>,
    pub route: Option<String>,
    #[serde(default)]
    pub workflow: Option<WorkflowLite>,
    #[serde(default)]
    pub agents: Vec<AgentLite>,
    #[serde(default)]
    pub skills: Vec<SkillLite>,
    #[serde(default)]
    pub memories: Vec<MemoryLite>,
    #[serde(default)]
    pub cross_project: bool,
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// One routing decision as logged by routing-dispatcher.js / v2 / v3.
/// `skills` is left as a free-form value because the log shape varies by msg.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingLogEntry {
    pub ts: Option<String>,
    pub level: Option<String>,
    pub msg: Option<String>,
    pub top: Option<String>,
    pub score: Option<f64>,
    pub confidence: Option<f64>,
    #[serde(default)]
    pub skills: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveSessionFeed {
    /// Orchestrations newest-first (route / workflow / agents / skills / memories).
    pub orchestrations: Vec<OrchestrateLogEntry>,
    /// Raw routing decisions newest-first (skill injection + confidence).
    pub routing: Vec<RoutingLogEntry>,
    /// Delegated agents newest-first (status: launched/done/timeout/failed).
    pub delegations: Vec<DelegationLogEntry>,
    pub generated_at: String,
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    crate::activity_timeline::epoch_secs_to_iso(secs)
}

/// Live Session Monitor: combined recent activity of the active Claude Code
/// session. Read-only — never writes. `limit` clamps to [1, 200] (default 20).
#[tauri::command]
pub fn live_session_feed(limit: Option<usize>) -> Result<LiveSessionFeed, String> {
    let n = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let logs = claude_logs_dir().ok_or("no home dir")?;

    let orchestrations = read_jsonl_tail::<OrchestrateLogEntry>(&logs.join("orchestrate.jsonl"), n);
    let routing = read_jsonl_tail::<RoutingLogEntry>(&logs.join("routing-dispatcher.jsonl"), n);
    let delegations = list_delegations_inner(n).unwrap_or_default();

    Ok(LiveSessionFeed {
        orchestrations,
        routing,
        delegations,
        generated_at: now_iso(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_tolerates_missing_file() {
        let out: Vec<OrchestrateLogEntry> =
            read_jsonl_tail(Path::new("C:/__definitely_missing__/x.jsonl"), 10);
        assert!(out.is_empty());
    }

    #[test]
    fn tail_skips_malformed_and_returns_newest_first() {
        let dir = std::env::temp_dir().join("ultron_live_session_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("routing.jsonl");
        std::fs::write(
            &p,
            "{\"ts\":\"a\",\"msg\":\"one\"}\nNOT JSON\n{\"ts\":\"b\",\"msg\":\"two\"}\n",
        )
        .unwrap();
        let out: Vec<RoutingLogEntry> = read_jsonl_tail(&p, 10);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].msg.as_deref(), Some("two")); // newest first
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn feed_clamps_limit() {
        // Smoke: should never panic and respects clamp; files may be absent.
        let feed = live_session_feed(Some(99_999)).unwrap();
        assert!(feed.routing.len() <= MAX_LIMIT);
        assert!(feed.orchestrations.len() <= MAX_LIMIT);
    }
}
