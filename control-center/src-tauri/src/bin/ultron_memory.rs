//! ultron-memory — CLI sidecar for the Claude Code hooks (Node).
//!
//! Lets the lifecycle hooks (SessionStart / UserPromptSubmit / Stop) reuse the
//! canonical Rust memory + orchestrator logic instead of duplicating it in JS
//! (the whole point of the rework is ONE source of truth, not a parallel stack).
//! Each subcommand prints one JSON object on stdout (machine-readable for hooks).
//!
//!   ultron-memory resume [--project X]          # SessionStart -> bounded resume
//!   ultron-memory orchestrate <prompt> [--project X]  # UserPromptSubmit -> route
//!   ultron-memory recall <query> [--project X] [--cross]  # hybrid recall pack
//!                                               # --cross|--all-projects =
//!                                               # whole-brain recall (any project;
//!                                               # Secret still excluded)
//!   ultron-memory stats                         # memory health counts
//!   ultron-memory reindex                       # rebuild the dense index
//!   ultron-memory catalog [--agents|--skills]   # (re)index agent/skill catalog
//!   ultron-memory eval [--project X] [--golden] # recall@8 + (optional) golden metrics
//!   ultron-memory eval-full [--project X]        # golden-set ranking metrics only
//!   ultron-memory reconcile                     # read-only SQLite<->Qdrant drift check
//!   ultron-memory warmup                        # SessionStart -> warm E5 (page cache)
//!   ultron-memory candidate                     # Stop -> propose a candidate (stdin JSON)
//!
//! Build: cargo build --release --bin ultron-memory --features qdrant

use std::io::Read;

use control_center_lib as ul;

fn main() {
    match run() {
        Ok(v) => println!(
            "{}",
            serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string())
        ),
        Err(e) => {
            eprintln!("ultron-memory: {e}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<serde_json::Value, String> {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    let project = flag_value(&args, "--project");

    match cmd {
        "resume" => to_json(ul::commands::memory::session_resume::session_resume_inner(project)?),
        "orchestrate" => {
            let prompt = positional(&args)?;
            to_json(ul::orchestrator::orchestrate(&prompt, project.as_deref()))
        }
        "recall" => {
            let query = positional(&args)?;
            // CROSS-PROJECT: --cross / --all-projects relaxes the project filter so
            // the recall searches the WHOLE brain (items from any project), not just
            // the current one. Security is untouched: Secret items stay excluded.
            let cross = has_flag(&args, "--cross") || has_flag(&args, "--all-projects");
            to_json(ul::commands::memory::recall_unified::recall_pack(
                &query,
                8,
                project.as_deref(),
                cross,
                None, // session_id: use default resolution (env → proc-<pid>)
            )?)
        }
        "stats" => to_json(ul::memory::MemoryService::stats().map_err(|e| e.to_string())?),
        "reindex" => {
            let (indexed, errors) =
                ul::memory::qdrant_index::reindex_all().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "indexed": indexed, "errors": errors }))
        }
        // (Re)index the agent/skill catalog (`ultron_catalog`) used by the
        // orchestrator's `delegate_agents` semantic routing. Idempotent.
        //   ultron-memory catalog            # agents + enabled skills (default)
        //   ultron-memory catalog --agents   # agents only
        //   ultron-memory catalog --skills   # enabled skills only
        // `.disabled` skills are never indexed (they must not be routed to).
        "catalog" => {
            let only_agents = has_flag(&args, "--agents");
            let only_skills = has_flag(&args, "--skills");

            let indexed_agents = if only_skills {
                None
            } else {
                Some(ul::memory::catalog::index_agents()?)
            };
            // Skills are additive: surface a skill failure as a field instead of
            // discarding agent counts that were already committed.
            let (indexed_skills, skill_error) = if only_agents {
                (None, None)
            } else {
                match ul::memory::catalog::index_skills() {
                    Ok(c) => (Some(c), None),
                    Err(e) => (None, Some(e)),
                }
            };

            let (a_ok, a_err) = indexed_agents.unwrap_or((0, 0));
            let (s_ok, s_err) = indexed_skills.unwrap_or((0, 0));
            Ok(serde_json::json!({
                "indexed_agents": a_ok,
                "indexed_skills": s_ok,
                "errors": a_err + s_err,
                "skill_error": skill_error,
                "collection": ul::memory::catalog::CATALOG_COLLECTION,
            }))
        }
        "eval" => {
            // Default: the substring-based golden recall@8 report + security gate
            // (unchanged). `--golden` ADDITIVELY merges the ranking-quality metrics
            // (precision@k/recall@k/MRR/nDCG/context-waste) over the REAL golden set
            // under a `golden_metrics` key, without altering the legacy fields.
            let base = ul::memory::evals::run(project.as_deref(), 8);
            let mut v = to_json(base)?;
            if has_flag(&args, "--golden") {
                let gm = ul::memory::evals::run_golden_metrics(project.as_deref(), 8);
                if let serde_json::Value::Object(ref mut map) = v {
                    map.insert("golden_metrics".to_string(), to_json(gm)?);
                }
            }
            Ok(v)
        }
        // Dedicated subcommand: ONLY the ranking-quality metrics over the real
        // golden set (precision@k/recall@k/MRR/nDCG/context-waste + security gate).
        // FAIL-SAFE: degrades to an all-zero `degraded` report if the golden set
        // is missing or Qdrant/E5 is offline.
        "eval-full" => to_json(ul::memory::evals::run_golden_metrics(project.as_deref(), 8)),
        "reconcile" => {
            // Read-only SQLite<->Qdrant drift check (--check, the default mode).
            // --repair is intentionally not wired (it mutates the index; policy
            // requires dry-run + confirmation). Use `reindex` to rebuild instead.
            to_json(ul::memory::qdrant_index::reconcile_check().map_err(|e| e.to_string())?)
        }
        "candidate" => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| format!("read stdin: {e}"))?;
            let id = emit_candidate(&buf)?;
            Ok(serde_json::json!({ "candidate_id": id }))
        }
        // CODEGRAPH (Fase 3a): ingest a directed code-graph edge from stdin.
        //
        // Reads one JSON object from stdin:
        //   {
        //     "source":     "mymod::foo",          // required: emitting symbol/module
        //     "target":     "std::vec::Vec",        // required: callee/import target
        //     "kind":       "imports",              // required: imports|calls|re-exports|…
        //     "file":       "src/lib.rs",           // optional: relative source file
        //     "line_from":  10,                     // optional: line of definition
        //     "line_to":    10,                     // optional: line of reference
        //     "provenance": "capture-symbols-js",   // optional: who produced this edge
        //     "project":    "ultron"                // optional: project slug
        //   }
        //
        // Returns: { "ok": true, "source": "...", "target": "...", "kind": "..." }
        // or       { "ok": false, "error": "..." } on parse/db failure.
        //
        // Duplicate edges (same source+target+kind+file) are silently ignored
        // (idempotent INSERT OR IGNORE).
        "edge" => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| format!("read stdin: {e}"))?;
            emit_edge(&buf)
        }
        "capture" => {
            // Stop hook -> auto-capture: extract durable facts (via AI Router,
            // which also populates router telemetry) and propose them as inbox
            // candidates. Transcript on stdin; never auto-promotes to active.
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| format!("read stdin: {e}"))?;
            to_json(ul::memory::capture::capture_session(&buf, project.as_deref()))
        }
        "warmup" => {
            // SessionStart warmup (cold-recall fix). Force the lazy E5 ONNX model
            // (multilingual-e5-large, 1.3 GB) to initialise by running ONE embed,
            // so the OS page-cache of the .onnx is hot before the first real recall.
            // Each .exe invocation is a fresh process, so this does NOT keep E5
            // resident in RAM for the next process — it only warms the disk cache
            // (~80% of the cold cost). Designed to be spawned DETACHED by the hook.
            // FAIL-SAFE: a stub/offline E5 returns a zero vector; we still report
            // `warmed:false` instead of erroring so the hook never blocks startup.
            let started = std::time::Instant::now();
            let warmed = match ul::qdrant::embed_e5("warmup", true) {
                Ok(v) => v.iter().any(|&x| x != 0.0),
                Err(_) => false,
            };
            Ok(serde_json::json!({
                "warmed": warmed,
                "ms": started.elapsed().as_millis() as u64,
            }))
        }
        "doctor" => {
            // Read-only health report. Prints JSON to stdout and exits with a
            // code mirroring max_severity (0=ok, 1=warn, 2=error) for gates.
            let report = ul::memory::doctor::run_doctor();
            let code = report.exit_code();
            println!(
                "{}",
                serde_json::to_string(&report).unwrap_or_else(|_| "{}".to_string())
            );
            std::process::exit(code);
        }
        "" => Err("usage: ultron-memory <resume|orchestrate|recall [--cross|--all-projects]|stats|reindex|catalog [--agents|--skills]|eval [--golden]|eval-full|reconcile|warmup|doctor|candidate|capture|edge> [--project X] [args]".to_string()),
        other => Err(format!("unknown subcommand '{other}'")),
    }
}

/// Build a pending `MemoryCandidate` from a JSON object on stdin and store it
/// (the Stop hook proposes; the human/policy approves in the inbox).
///
/// All fields emitted by capture-symbols.js and stop-compress-session.js are
/// parsed here so they survive into `brain.db`.  Previously only the basic
/// text fields were read; `confidence` (and the code-location fields) were
/// silently dropped, causing every hook-sourced candidate to land with the
/// default confidence=0.5, which is below REJECT_THRESHOLD=0.55 — the
/// auto-approve band-A logic therefore auto-rejected all of them as noise.
fn emit_candidate(json: &str) -> Result<String, String> {
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
    let project_id = v.get("project").and_then(|x| x.as_str()).map(String::from);
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
    MemoryService::create_candidate(&c).map_err(|e| e.to_string())
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
fn emit_edge(json: &str) -> Result<serde_json::Value, String> {
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

fn to_json<T: serde::Serialize>(v: T) -> Result<serde_json::Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1))
        .cloned()
}

/// Whether a boolean flag (e.g. `--golden`) is present anywhere in `args`.
fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

/// First positional arg(s) after the subcommand, excluding `--project <val>` and
/// the recognised boolean flags (so e.g. `--cross` is not folded into the query).
fn positional(args: &[String]) -> Result<String, String> {
    const BOOL_FLAGS: &[&str] = &[
        "--cross",
        "--all-projects",
        "--golden",
        "--agents",
        "--skills",
    ];
    let mut out: Vec<String> = Vec::new();
    let mut i = 2;
    while i < args.len() {
        if args[i] == "--project" {
            i += 2;
            continue;
        }
        if BOOL_FLAGS.contains(&args[i].as_str()) {
            i += 1;
            continue;
        }
        out.push(args[i].clone());
        i += 1;
    }
    if out.is_empty() {
        return Err("missing argument (prompt/query)".to_string());
    }
    Ok(out.join(" "))
}
