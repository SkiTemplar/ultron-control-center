// commands/sessions_sub/live_session.rs — Live Session Monitor feed.
//
// Lee, READ-ONLY, los logs que los hooks ya escriben para que la UI muestre EN
// VIVO la actividad de subagentes de la sesion activa de Claude Code:
//   ~/.ultron/.tmp/subagent-harvest.jsonl   — subagentes terminados (SubagentStop).
//   ~/.ultron/.tmp/subagent-lifecycle.jsonl — subagentes en vuelo (SubagentStart/Stop).
//
// Los turnos de orquestación (~/.claude/logs/orchestrate.jsonl) y el modo del
// hook se retiraron del feed el 2026-11-15: el modo ULTRON_ORCHESTRATE=full de
// memory-orchestrate.js ya no existe y nadie escribe ese log.
//
// `delegations` (cockpit/delegations.jsonl) se retiró del feed el 2026-10-17:
// el fichero no tiene escritor desde que se retiró el despacho del kanban.
// `routing` (~/.claude/logs/routing-dispatcher.jsonl) se retiró el 2026-10-23:
// el dispatcher está desconectado desde el 2026-09-29 y ese log solo lo
// escriben los arneses y selftests, así que pintaba como «skills inyectadas»
// ejecuciones de pruebas.
//
// Tolerante a lineas malformadas o de esquema antiguo (se ignoran). Devuelve la
// actividad reciente combinada (la decision "todo combinado" del usuario).

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 200;
/// Bytes medios por linea JSONL — acota la lectura de cola para no releer el
/// fichero entero en cada poll (los logs de hooks crecen sin cota).
const AVG_LINE_BYTES: u64 = 300;

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

/// Fila cruda de `~/.ultron/.tmp/subagent-harvest.jsonl` (la escribe el hook
/// SubagentStop `hooks/scripts/subagent-harvest.js`). Tolerante a drift de shape.
#[derive(Debug, Clone, Deserialize)]
struct SubagentHarvestRow {
    ts: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    chars: Option<u64>,
    #[serde(default)]
    preview: String,
    #[serde(default)]
    label: Option<String>,
}

/// Un subagente COMPLETADO expuesto al frontend. El hook escribe al TERMINAR, así
/// que esto son subagentes acabados (no in-flight): el "arrancó" lo daría un hook
/// SubagentStart (item 3.9). `agent="unknown"` → el frontend lo muestra como
/// "subagente" (la atribución fina del especialista es deuda de 0.3).
#[derive(Debug, Clone, Serialize)]
pub struct SubagentActivity {
    pub ts: Option<String>,
    pub project: Option<String>,
    pub agent: String,
    pub chars: u64,
    pub preview: String,
    pub label: Option<String>,
}

/// Fila cruda de `~/.ultron/.tmp/subagent-lifecycle.jsonl` (hook
/// `subagent-lifecycle.js`, cableado en SubagentStart + SubagentStop).
#[derive(Debug, Clone, Deserialize)]
struct LifecycleRow {
    ts: Option<String>,
    #[serde(default)]
    event: Option<String>,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    agent: Option<String>,
    #[serde(default)]
    label: Option<String>,
}

/// Un subagente EN VUELO: arrancó (SubagentStart) y aún no reportó su
/// SubagentStop. Da el "en vivo" real que 3.2 no cubría (solo terminados).
#[derive(Debug, Clone, Serialize)]
pub struct RunningSubagent {
    pub agent: String,
    pub label: Option<String>,
    pub agent_id: String,
    pub started_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LiveSessionFeed {
    /// Finished subagents newest-first (SubagentStop harvest), ruido filtrado.
    pub subagents: Vec<SubagentActivity>,
    /// Subagentes EN VUELO ahora (SubagentStart sin SubagentStop posterior).
    pub running_subagents: Vec<RunningSubagent>,
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

/// Los subagentes recientes ya TERMINADOS, del harvest, newest-first.
/// Filtra el RUIDO: descarta filas sin texto (chars 0 / preview vacío) — el hook
/// SubagentStop también recibe payloads que no son subagentes reales (p.ej. un
/// Stop de sesión con resultado vacío); una tarjeta vacía sería una cáscara
/// (mand. 11). `agent` vacío/ausente → "unknown" (el frontend lo pinta "subagente").
fn recent_subagents_from_path(path: &Path, limit: usize) -> Vec<SubagentActivity> {
    read_jsonl_tail::<SubagentHarvestRow>(path, limit)
        .into_iter()
        .filter_map(|r| {
            let chars = r.chars.unwrap_or(0);
            let preview = r.preview.trim().to_string();
            if chars == 0 || preview.is_empty() {
                return None;
            }
            let agent = r
                .agent
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("unknown")
                .to_string();
            Some(SubagentActivity {
                ts: r.ts,
                project: r.project,
                agent,
                chars,
                preview,
                label: r.label.filter(|l| !l.trim().is_empty()),
            })
        })
        .collect()
}

/// Reusa `usage::harvest_path` (misma ruta que consume la telemetría 2.1) para no
/// duplicar la ubicación del log. Sin home dir / sin fichero → vacío.
fn recent_subagents(limit: usize) -> Vec<SubagentActivity> {
    match crate::agent_orchestration::usage::harvest_path() {
        Some(path) => recent_subagents_from_path(&path, limit),
        None => Vec::new(),
    }
}

fn lifecycle_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("SUBAGENT_LIFECYCLE_LOG") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    Some(
        dirs::home_dir()?
            .join(".ultron")
            .join(".tmp")
            .join("subagent-lifecycle.jsonl"),
    )
}

/// Subagentes EN VUELO: reduce el log de ciclo de vida por `agent_id` — un
/// agent_id cuyo evento MÁS RECIENTE es "start" (sin un "stop" posterior) sigue
/// vivo. El tail viene newest-first, así que el PRIMER evento visto por agent_id
/// manda. Sin `agent_id` no se puede emparejar start/stop → se ignora.
/// LÍMITE (mand. 13): si el SubagentStop se pierde, el "start" queda como activo
/// hasta salir de la ventana reciente (este corte no lleva TTL por tiempo).
fn running_subagents_from_path(path: &Path, limit: usize) -> Vec<RunningSubagent> {
    let rows = read_jsonl_tail::<LifecycleRow>(path, limit);
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut running: Vec<RunningSubagent> = Vec::new();
    for r in rows {
        let id = match r.agent_id.as_deref().map(str::trim) {
            Some(s) if !s.is_empty() => s.to_string(),
            _ => continue,
        };
        if !seen.insert(id.clone()) {
            continue; // ya resuelto por un evento más nuevo de este agent_id
        }
        if r.event.as_deref() == Some("start") {
            running.push(RunningSubagent {
                agent: r
                    .agent
                    .filter(|a| !a.trim().is_empty())
                    .unwrap_or_else(|| "unknown".to_string()),
                label: r.label.filter(|l| !l.trim().is_empty()),
                agent_id: id,
                started_at: r.ts,
            });
        }
    }
    running
}

fn running_subagents(limit: usize) -> Vec<RunningSubagent> {
    match lifecycle_path() {
        Some(path) => running_subagents_from_path(&path, limit),
        None => Vec::new(),
    }
}

/// Live Session Monitor: combined recent activity of the active Claude Code
/// session. Read-only — never writes. `limit` clamps to [1, 200] (default 20).
#[tauri::command]
pub async fn live_session_feed(limit: Option<usize>) -> Result<LiveSessionFeed, String> {
    let n = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let subagents = recent_subagents(n);
    let running_subagents = running_subagents(n);

    Ok(LiveSessionFeed {
        subagents,
        running_subagents,
        generated_at: now_iso(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_tolerates_missing_file() {
        let out: Vec<serde_json::Value> =
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
        let out: Vec<serde_json::Value> = read_jsonl_tail(&p, 10);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["msg"].as_str(), Some("two")); // newest first
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn feed_clamps_limit() {
        // Smoke: should never panic and respects clamp; files may be absent.
        let feed = tauri::async_runtime::block_on(live_session_feed(Some(99_999))).unwrap();
        assert!(feed.subagents.len() <= MAX_LIMIT);
        assert!(feed.running_subagents.len() <= MAX_LIMIT);
    }

    #[test]
    fn running_subagents_pairs_start_and_stop_by_agent_id() {
        let dir = std::env::temp_dir().join("ultron_lifecycle_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("lifecycle.jsonl");
        std::fs::write(
            &p,
            concat!(
                // sa-1: arrancó y TERMINÓ -> NO activo (caso negativo, mand. 7).
                r#"{"ts":"2026-07-01T10:00:00Z","event":"start","agent_id":"sa-1","agent":"rust-engineer"}"#,
                "\n",
                r#"{"ts":"2026-07-01T10:05:00Z","event":"stop","agent_id":"sa-1","agent":"rust-engineer"}"#,
                "\n",
                // sa-2: arrancó y SIGUE vivo -> activo.
                r#"{"ts":"2026-07-01T10:06:00Z","event":"start","agent_id":"sa-2","agent":"code-reviewer","label":"review feed"}"#,
                "\n",
                // sin agent_id -> ignorado (no se puede emparejar).
                r#"{"ts":"2026-07-01T10:07:00Z","event":"start","agent_id":"","agent":"orphan"}"#,
                "\n",
            ),
        )
        .unwrap();

        let out = running_subagents_from_path(&p, 20);
        assert_eq!(out.len(), 1, "solo sa-2 sigue en vuelo");
        assert_eq!(out[0].agent_id, "sa-2");
        assert_eq!(out[0].agent, "code-reviewer");
        assert_eq!(out[0].label.as_deref(), Some("review feed"));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn recent_subagents_drops_noise_and_defaults_unknown() {
        // 3 filas: un subagente real, uno sin tipo (agent:""), y RUIDO (chars:0,
        // preview vacío — p.ej. un Stop de sesión que el hook también recibe).
        let dir = std::env::temp_dir().join("ultron_subagents_test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("harvest.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"ts":"2026-07-01T10:00:00Z","project":"ultron","agent":"code-reviewer","chars":120,"preview":"revisó el diff","label":"review"}"#,
                "\n",
                r#"{"ts":"2026-07-01T10:01:00Z","project":"ultron","agent":"","chars":80,"preview":"resultado sin tipo"}"#,
                "\n",
                r#"{"ts":"2026-07-01T10:02:00Z","project":"ultron","agent":"unknown","chars":0,"preview":""}"#,
                "\n",
            ),
        )
        .unwrap();

        let out = recent_subagents_from_path(&p, 10);

        // Caso negativo (mand. 11): la fila de ruido NO debe aparecer.
        assert_eq!(out.len(), 2, "la fila chars:0/preview vacío debe filtrarse");
        // newest-first: la fila sin tipo (10:01) va primera; agent:"" -> "unknown".
        assert_eq!(out[0].agent, "unknown");
        assert_eq!(out[0].chars, 80);
        assert!(out[0].label.is_none());
        // el subagente real conserva nombre y label.
        assert_eq!(out[1].agent, "code-reviewer");
        assert_eq!(out[1].label.as_deref(), Some("review"));
        let _ = std::fs::remove_file(&p);
    }
}
