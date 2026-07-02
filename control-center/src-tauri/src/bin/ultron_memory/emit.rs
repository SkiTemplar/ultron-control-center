//! stdin-JSON ingestion paths: candidate proposal, governed supersede, and
//! code-graph edge insertion. Each helper parses one JSON object read from
//! stdin by the dispatcher in the bin root and calls the canonical
//! `MemoryService` / `sqlite_store` write paths.

use control_center_lib as ul;

/// Build a pending `MemoryCandidate` from a JSON object on stdin and store it
/// (the Stop hook proposes; the human/policy approves in the inbox).
///
/// All fields emitted by capture-symbols.js and stop-compress-session.js are
/// parsed here so they survive into `brain.db`.  Previously only the basic
/// text fields were read; `confidence` (and the code-location fields) were
/// silently dropped, causing every hook-sourced candidate to land with the
/// default confidence=0.5, which is below REJECT_THRESHOLD=0.55 — the
/// auto-approve band-A logic therefore auto-rejected all of them as noise.
/// Project slug = basename del git-root del cwd con el que se invoca el sidecar
/// (los hooks de captura lo spawnean con el cwd de la sesion). Robusto a
/// subcarpetas: una sesion en ~/.ultron/control-center taggea "ultron", no
/// "control-center". Devuelve None fuera de un repo git (-> memoria AMBIENTE,
/// que el read-path inyecta en todas partes). 1.0 write-path.
fn cwd_project() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    let out = std::process::Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(&cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let root = String::from_utf8(out.stdout).ok()?;
    // Normaliza como projectName(cwd) en los hooks: quita los puntos iniciales
    // (".ultron" -> "ultron") para casar con el slug canonico existente.
    std::path::Path::new(root.trim())
        .file_name()
        .map(|n| n.to_string_lossy().trim_start_matches('.').to_string())
        .filter(|s| !s.is_empty())
}

pub(crate) fn emit_candidate(json: &str) -> Result<serde_json::Value, String> {
    use ul::memory::{model::CandidateAction, MemoryCandidate, MemoryService, MemoryType, Scope};
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("parse candidate json: {e}"))?;
    let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("fact");
    let scope = v.get("scope").and_then(|x| x.as_str()).unwrap_or("session");
    let mut c = MemoryCandidate::new(
        MemoryType::parse(kind).unwrap_or(MemoryType::Fact),
        Scope::parse(scope).unwrap_or(Scope::Session),
    );
    c.proposed_title = v.get("title").and_then(|x| x.as_str()).map(String::from);
    c.proposed_summary = v.get("summary").and_then(|x| x.as_str()).map(String::from);
    c.proposed_content = v.get("content").and_then(|x| x.as_str()).map(String::from);

    // --- confidence (BUG #1 FIX) -------------------------------------------
    // capture-symbols.js sends confidence=0.95 (code symbols) or 0.7 (arch).
    // Without this parse the field stayed at the default 0.5, which is below
    // REJECT_THRESHOLD=0.55, causing auto_approve to silently discard every
    // hook-sourced candidate as "noise" (confirmed in audit log).
    if let Some(conf) = v.get("confidence").and_then(serde_json::Value::as_f64) {
        c.confidence = (conf as f32).clamp(0.0, 1.0);
    }

    // --- code-location fields (HIGH FIX) ------------------------------------
    // symbol/file_path/line/signature/capture_source exist in the DB schema
    // (sqlite_store.rs:106-107, 139-140) and are mapped in to_item(), but were
    // never parsed here, so 0/1413 items had them populated (confirmed by audit).
    c.proposed_symbol = v.get("symbol").and_then(|x| x.as_str()).map(String::from);
    c.proposed_file_path = v
        .get("file_path")
        .and_then(|x| x.as_str())
        .map(String::from);
    c.proposed_line = v.get("line").and_then(serde_json::Value::as_i64);
    c.proposed_signature = v
        .get("signature")
        .and_then(|x| x.as_str())
        .map(String::from);
    c.capture_source = v
        .get("capture_source")
        .or_else(|| v.get("source"))
        .and_then(|x| x.as_str())
        .map(String::from);

    // --- recommended_action -------------------------------------------------
    // Hooks may emit "approve"/"review"/"reject"; honour the hint so the
    // auto-approve policy can use it in future band logic.
    if let Some(action_str) = v.get("recommended_action").and_then(|x| x.as_str()) {
        c.recommended_action = match action_str {
            "approve" => CandidateAction::Approve,
            "reject" => CandidateAction::Reject,
            "quarantine" => CandidateAction::Quarantine,
            "merge" => CandidateAction::Merge,
            "supersede" => CandidateAction::Supersede,
            // "edit" or any unknown string -> require human review (edit in inbox).
            _ => CandidateAction::Edit,
        };
    }

    // Project so the promoted item is filterable per-project in recall (e.g.
    // "tortunabo", "bank"). Persisted BOTH as proposed_project_id (direct path)
    // AND as a `project:<id>` tag, because the candidate round-trips through
    // SQLite (no project column) before approval; to_item recovers it from the
    // tag. Without this, CLI-ingested memories land project_id = None.
    // 1.0 write-path: precedencia = payload "project" (explicito) -> git-root del
    // cwd de la sesion (canonico, robusto a subcarpetas) -> None (ambiente). Antes
    // solo miraba el payload (que los hooks NO rellenan) -> 82% del corpus quedaba
    // project_id=NULL ("memoria muerta fuera de ULTRON"). El flag --project (basename,
    // a veces un subdir o el home) se ignora a proposito: git-root es lo correcto.
    let project_id = v
        .get("project")
        .and_then(|x| x.as_str())
        .map(String::from)
        .or_else(cwd_project);
    c.proposed_project_id = project_id.clone();
    let mut tags: Vec<String> = v
        .get("tags")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if let Some(pid) = &project_id {
        let marker = format!("project:{pid}");
        if !tags.iter().any(|t| t == &marker) {
            tags.push(marker);
        }
    }
    c.proposed_tags = tags;
    if let Some(imp) = v.get("importance").and_then(serde_json::Value::as_f64) {
        c.importance = (imp as f32).clamp(0.0, 1.0);
    }
    c.source_session_id = v
        .get("session_id")
        .and_then(|x| x.as_str())
        .map(String::from);
    match MemoryService::create_candidate(&c) {
        Ok(id) => Ok(serde_json::json!({ "candidate_id": id })),
        // Dedupe bloqueante (2026-07-02): no es un error del CLI — es idempotencia.
        // Salida honesta con exit 0: el contenido ya esta cubierto por existing_id.
        Err(ul::memory::MemoryError::Duplicate(existing_id)) => Ok(serde_json::json!({
            "skipped": "duplicate",
            "existing_id": existing_id,
        })),
        Err(e) => Err(e.to_string()),
    }
}

/// 1.3 (memoria viva): construye el NUEVO item desde el JSON de stdin y supersede
/// `old_id` (viejo -> Deprecated/valid_to=now, nuevo -> Active, enlazados). El
/// project_id sigue la misma precedencia que la captura: payload -> git-root(cwd).
/// supersede() ya redacta secretos en el write-path; este es un camino EXPLICITO
/// (no auto): el auto-trigger por contradiccion "misma entidad, distinto valor"
/// queda para una iteracion con clasificador dedicado.
pub(crate) fn emit_supersede(json: &str, old_id: &str) -> Result<serde_json::Value, String> {
    use ul::memory::model::MemoryItem;
    use ul::memory::{Actor, MemoryService, MemoryType, Scope, Source, Status};
    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("parse supersede json: {e}"))?;
    let kind = v.get("type").and_then(|x| x.as_str()).unwrap_or("fact");
    let scope = v.get("scope").and_then(|x| x.as_str()).unwrap_or("project");
    let mut item = MemoryItem::new(
        MemoryType::parse(kind).unwrap_or(MemoryType::Fact),
        Scope::parse(scope).unwrap_or(Scope::Project),
        Source::ToolObserved,
        Status::Active,
    );
    item.title = v.get("title").and_then(|x| x.as_str()).map(String::from);
    item.summary = v.get("summary").and_then(|x| x.as_str()).map(String::from);
    item.content = v.get("content").and_then(|x| x.as_str()).map(String::from);
    item.project_id = v
        .get("project")
        .and_then(|x| x.as_str())
        .map(String::from)
        .or_else(cwd_project);
    if let Some(conf) = v.get("confidence").and_then(serde_json::Value::as_f64) {
        item.confidence = (conf as f32).clamp(0.0, 1.0);
    }
    let new = MemoryService::supersede(old_id, item, Actor::User).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "ok": true,
        "old_id": old_id,
        "new_id": new.id,
        "old_status": "deprecated",
        "new_status": "active",
    }))
}

/// Parse a JSON object from stdin and insert it as a code-graph edge into
/// `brain.db` via the canonical `insert_code_edge` path.
///
/// Required fields: `source`, `target`, `kind`.
/// All other fields are optional (see subcommand docs above).
///
/// Returns `{ "ok": true, "source": "...", "target": "...", "kind": "..." }`
/// on success, or `{ "ok": false, "error": "..." }` on failure.  The
/// function never propagates errors to `run()` — callers can always rely on
/// a well-formed JSON response.
pub(crate) fn emit_edge(json: &str) -> Result<serde_json::Value, String> {
    use ul::memory::sqlite_store::insert_code_edge;

    let v: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("parse edge json: {e}"))?;

    let source = v
        .get("source")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "edge json missing 'source'".to_string())?;
    let target = v
        .get("target")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "edge json missing 'target'".to_string())?;
    let kind = v
        .get("kind")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "edge json missing 'kind'".to_string())?;

    let file = v.get("file").and_then(|x| x.as_str());
    let line_from = v.get("line_from").and_then(serde_json::Value::as_i64);
    let line_to = v.get("line_to").and_then(serde_json::Value::as_i64);
    let provenance = v.get("provenance").and_then(|x| x.as_str());
    let project_id = v
        .get("project")
        .or_else(|| v.get("project_id"))
        .and_then(|x| x.as_str());

    match insert_code_edge(
        source, target, kind, file, line_from, line_to, provenance, project_id,
    ) {
        Ok(()) => Ok(serde_json::json!({
            "ok": true,
            "source": source,
            "target": target,
            "kind": kind,
        })),
        Err(e) => Ok(serde_json::json!({
            "ok": false,
            "error": e.to_string(),
        })),
    }
}
