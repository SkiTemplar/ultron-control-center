//! Subcomandos de captura, procedencia y salud del sidecar (`candidate`,
//! `supersede`, `capture`, `provenance`, `doctor`).
//!
//! Separados de `run()` en main.rs (calidad-rust-4, 2026-10-23). Cada función
//! es el brazo de antes, sin cambios de comportamiento.

use std::io::Read;

use control_center_lib as ul;
use serde_json::{json, Value};

use crate::cli_args::flag_value;
use crate::emit::{emit_candidate, emit_supersede};
use crate::{resolve_id_prefix, to_json};

fn read_stdin() -> Result<String, String> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| format!("read stdin: {e}"))?;
    Ok(buf)
}

/// `candidate` (stdin JSON): {candidate_id} o {skipped:"duplicate",
/// existing_id} (ambos exit 0): el dedupe bloqueante del write-path es
/// idempotencia, no un error.
pub(crate) fn candidate() -> Result<Value, String> {
    emit_candidate(&read_stdin()?)
}

/// 1.3 (memoria viva): supersede gobernado. `--old <id>` + NUEVO item por
/// stdin -> el viejo pasa a Deprecated (valid_to=now, recuperable), el nuevo
/// a Active, enlazados supersedes/superseded_by. El estado se actualiza en
/// vez de acumular.
pub(crate) fn supersede(args: &[String]) -> Result<Value, String> {
    let old_id =
        flag_value(args, "--old").ok_or_else(|| "supersede requiere --old <id>".to_string())?;
    emit_supersede(&read_stdin()?, &old_id)
}

/// Stop hook -> auto-capture: extract durable facts (via AI Router, which
/// also populates router telemetry) and propose them as inbox candidates.
/// Transcript on stdin; never auto-promotes to active. `--session <id>`
/// stamps source_session_id on every candidate (provenance episódica — see
/// the `provenance` subcommand).
pub(crate) fn capture(args: &[String], project: Option<&str>) -> Result<Value, String> {
    let session = flag_value(args, "--session");
    let buf = read_stdin()?;
    to_json(ul::memory::capture::capture_session(
        &buf,
        project,
        session.as_deref(),
    ))
}

/// Provenance episódica (feedback 2026-07-02): cita VERIFICABLE del origen
/// de una memoria. Devuelve la sesión de captura (source_session_id), el
/// canal (capture_source), el content_hash del texto vivo, y resuelve el
/// transcript real `<session_id>.jsonl` bajo ~/.claude/projects/*/ si aún
/// existe en disco. Read-only; nada se persiste. Un item sin sesión de
/// origen responde `episodic: false` (honesto — no se inventa procedencia).
///   ultron-memory provenance --id <id|prefix>
pub(crate) fn provenance(args: &[String]) -> Result<Value, String> {
    let id_prefix = flag_value(args, "--id")
        .ok_or_else(|| "provenance requires --id <id|prefix>".to_string())?;
    let resolved_id = resolve_id_prefix(&id_prefix)?;
    let item = ul::memory::MemoryService::get(&resolved_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("item '{resolved_id}' not found"))?;
    let content_hash = ul::memory::texthash::content_hash(&item.searchable_text());
    let transcript = item
        .source_session_id
        .as_deref()
        .and_then(ul::commands::sessions_sub::session_summary::find_transcript);
    Ok(json!({
        "id": item.id,
        "episodic": item.source_session_id.is_some(),
        "source_session_id": item.source_session_id,
        "capture_source": item.capture_source,
        "created_at": item.created_at,
        "content_hash": content_hash,
        "transcript": transcript.as_ref().map(|p| p.display().to_string()),
        "transcript_exists": transcript.is_some(),
    }))
}

/// Read-only health report. Prints JSON to stdout and exits with a code
/// mirroring max_severity (0=ok, 1=warn, 2=error) for gates.
pub(crate) fn doctor() -> ! {
    let report = ul::memory::doctor::run_doctor();
    let code = report.exit_code();
    println!(
        "{}",
        serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string())
    );
    std::process::exit(code);
}
