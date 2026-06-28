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
//!   ultron-memory eval [--project X] [--golden [<path>]] # recall@8; --golden <path>=external oracle (cat19)
//!   ultron-memory eval-full [--project X]        # golden-set ranking metrics only
//!   ultron-memory reconcile                     # read-only SQLite<->Qdrant drift check
//!   ultron-memory warmup                        # SessionStart -> warm E5 (page cache)
//!   ultron-memory serve                         # persistent daemon: E5 resident, sub-second orchestrate
//!   ultron-memory serve-ping                    # is a live daemon reachable? (read-only)
//!   ultron-memory candidate                     # Stop -> propose a candidate (stdin JSON)
//!   ultron-memory deprecate --type <T> [--dry-run]  # bulk-deprecate a type (purge bloat)
//!
//! Build: cargo build --release --bin ultron-memory --features qdrant

use std::io::Read;

use control_center_lib as ul;

fn main() {
    // cat15: trace to stderr so the JSON result on stdout (the hook IPC
    // channel) stays clean. Honours RUST_LOG; defaults to info.
    control_center_lib::init_tracing_stderr();
    match run() {
        Ok(v) => println!(
            "{}",
            serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string())
        ),
        Err(e) => {
            tracing::error!(error = %e, "ultron-memory failed");
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
            // CLI one-shot fallback for the hot path. dense=TRUE: quality-first
            // (full hybrid recall + semantic match); see serve.rs for rationale.
            to_json(ul::orchestrator::orchestrate(&prompt, project.as_deref(), true))
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
            // `--golden <path>` (with a path argument) loads an EXTERNAL hand-labeled
            // JSON file (schema: `{ "labeled": [...] }`, cat19 FASE A oracle) and
            // returns a `LabeledGoldenReport` directly — the external oracle takes
            // precedence over the embedded golden metrics when a path is given.
            //
            // `--golden` alone (boolean, no path) ADDITIVELY merges the internal
            // ranking-quality metrics (precision@k/recall@k/MRR/nDCG/context-waste)
            // under a `golden_metrics` key, same as before.
            //
            // Default (no flag): the substring-based recall@8 report + security gate.
            if let Some(golden_path) = flag_value(&args, "--golden") {
                // cat19 FASE A: external oracle path provided.
                to_json(ul::memory::evals::run_labeled_golden(&golden_path, 8))
            } else {
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
        // 1.3 (memoria viva): supersede gobernado. `--old <id>` + NUEVO item por
        // stdin -> el viejo pasa a Deprecated (valid_to=now, recuperable), el nuevo
        // a Active, enlazados supersedes/superseded_by. Hace VIVA supersede()
        // (antes 0 callers = codigo muerto). El estado se actualiza en vez de acumular.
        "supersede" => {
            let old_id = flag_value(&args, "--old")
                .ok_or_else(|| "supersede requiere --old <id>".to_string())?;
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| format!("read stdin: {e}"))?;
            emit_supersede(&buf, &old_id)
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
            // Cross-encoder warmup: only when ULTRON_RERANK is active.
            // Guard prevents the ~1 GB BGERerankerV2M3 download for users who
            // have not opted in. FAIL-SAFE: errors are logged but never block
            // the session or change the `warmed` (E5) status.
            let reranker_warmed = if ul::qdrant::reranker_enabled() {
                match ul::qdrant::warmup_reranker() {
                    Ok(()) => true,
                    Err(e) => {
                        tracing::warn!(error = %e, "reranker warmup failed (non-fatal)");
                        false
                    }
                }
            } else {
                false
            };
            Ok(serde_json::json!({
                "warmed": warmed,
                "reranker_warmed": reranker_warmed,
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
        // Governed, selective hard-delete by item id.
        //
        // Event-sourced: removes the row from brain.db (SQLite SoT) + its Qdrant
        // point (dense index), then appends a `MemoryEvent` (Updated, reason
        // "forgotten") with a `before` snapshot — the only surviving audit record.
        // Reuses the exact `MemoryService::forget` path wired to the Tauri
        // `memory_forget` command (see commands/memory/inbox.rs).
        //
        // Accepts a full UUID or an unambiguous id PREFIX (≥ 4 hex chars). When a
        // prefix is supplied the sidecar resolves it against brain.db (exact-start
        // search) and rejects the call when the prefix is absent or ambiguous
        // (matches > 1 item) — so a partial id can never delete the wrong item.
        //
        // Flags:
        //   --id <id|prefix>   required — the item to forget
        //   --dry-run          print what WOULD be forgotten without mutating
        //   --reason <R>       optional free-text reason (logged in the audit event)
        //
        // Usage:
        //   ultron-memory forget --id 7cd41c41 --dry-run
        //   ultron-memory forget --id 7cd41c41 --reason "PII purge audit-2026-06-25"
        //   ultron-memory forget --id 84afaee2-3b1a-4c2f-8e0d-000000000000 --reason "PII"
        "forget" => {
            let id_prefix = flag_value(&args, "--id")
                .ok_or_else(|| "forget requires --id <id|prefix>".to_string())?;
            let dry = has_flag(&args, "--dry-run");
            let reason = flag_value(&args, "--reason");

            // Resolve prefix → full id via the canonical store.
            let resolved_id = resolve_id_prefix(&id_prefix)?;

            if dry {
                // Dry-run: fetch + display the item that would be forgotten.
                let item = ul::memory::MemoryService::get(&resolved_id)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("item '{resolved_id}' not found"))?;
                Ok(serde_json::json!({
                    "dry_run": true,
                    "would_forget": {
                        "id": item.id,
                        "type": item.kind.as_str(),
                        "status": item.status.as_str(),
                        "sensitivity": item.sensitivity.as_str(),
                        "summary": item.summary,
                    }
                }))
            } else {
                ul::memory::MemoryService::forget(
                    &resolved_id,
                    ul::memory::Actor::System,
                    reason,
                )
                .map_err(|e| e.to_string())?;
                Ok(serde_json::json!({
                    "forgotten": resolved_id,
                    "ok": true,
                }))
            }
        }

        // Bulk-deprecate every ACTIVE item of a type (purge bloat, e.g.
        // codebase_fact). --dry-run only counts. Reuses set_status per id so
        // FTS5 + Qdrant stay in sync; appends a Deprecated event per item.
        //   ultron-memory deprecate --type codebase_fact [--dry-run] [--project X] [--reason R]
        "deprecate" => {
            let kind_s = flag_value(&args, "--type")
                .ok_or_else(|| "deprecate requires --type <T>".to_string())?;
            let kind = ul::memory::MemoryType::parse(&kind_s)
                .ok_or_else(|| format!("invalid memory type '{kind_s}'"))?;
            let dry = has_flag(&args, "--dry-run");
            let reason = flag_value(&args, "--reason");
            let res = ul::memory::MemoryService::deprecate_by_type(
                kind,
                dry,
                project.as_deref(),
                reason,
                ul::memory::Actor::System,
            )
            .map_err(|e| e.to_string())?;
            to_json(res)
        }
        // Persistent orchestrator daemon: keeps E5 resident so UserPromptSubmit
        // orchestration drops from ~3.5s (cold model load every spawn) to sub-second.
        // `run_daemon` blocks forever serving requests, OR returns immediately with
        // `already_running` when a live daemon already owns the lockfile. Spawned
        // DETACHED by the SessionStart memory-warmup hook.
        // (Re)index ALL skills (enabled + disabled) into `ultron_skills_lazy`.
        // Used to measure acc@3 of E5 routing over the full lazy-dispatch corpus
        // before wiring the hot path. Never touches `ultron_catalog`.
        //   ultron-memory reindex-skills-lazy
        "reindex-skills-lazy" => {
            let (ok, err) = ul::memory::catalog::index_skills_lazy()?;
            to_json(serde_json::json!({
                "indexed": ok,
                "errors": err,
                "collection": ul::memory::catalog::SKILLS_LAZY_COLLECTION,
            }))
        }
        // Semantic skill search over the full lazy corpus (enabled + disabled).
        //   ultron-memory skill-query <prompt> [--top N]   (default N=5)
        // Returns a JSON array of hits ordered by E5 cosine similarity desc.
        "skill-query" => {
            let top: u32 = flag_value(&args, "--top")
                .and_then(|s| s.parse().ok())
                .unwrap_or(5);
            // Build prompt: collect positional tokens after the subcommand,
            // skipping value flags (--top N, --project P) and bare flags (--*).
            let mut parts: Vec<String> = Vec::new();
            let mut i = 2usize;
            while i < args.len() {
                match args[i].as_str() {
                    "--project" | "--top" => {
                        i += 2; // skip flag + its value
                    }
                    s if s.starts_with("--") => {
                        i += 1; // skip unknown boolean flag
                    }
                    _ => {
                        parts.push(args[i].clone());
                        i += 1;
                    }
                }
            }
            let prompt = parts.join(" ");
            if prompt.trim().is_empty() {
                return Err("skill-query requires a prompt argument".to_string());
            }
            let hits = ul::memory::catalog::search_skills_lazy(&prompt, top);
            let result: Vec<serde_json::Value> = hits
                .into_iter()
                .map(|h| {
                    serde_json::json!({
                        "name": h.name,
                        "score": h.score,
                        "kind": h.kind,
                        "description": h.description,
                    })
                })
                .collect();
            to_json(result)
        }
        "serve" => ul::serve::run_daemon(),
        // Report whether a live daemon is reachable (lockfile + ping). Read-only.
        "serve-ping" => Ok(ul::serve::ping_status()),
        // Candidate inbox governance from the CLI (no running app needed).
        //   ultron-memory inbox list                  # pending + clean counts
        //   ultron-memory inbox approve-clean         # promote only CLEAN candidates
        //   ultron-memory inbox approve-all           # promote ALL (incl. flagged)
        //   ultron-memory inbox auto-approve <on|off> # persist the auto-approve flag
        // approve-* reuse MemoryService::approve_candidate (Actor::User) per id, the
        // same path the Tauri inbox uses; clean = no secret marker, no contradiction.
        "inbox" => {
            let sub = args.get(2).map(String::as_str).unwrap_or("");
            inbox_command(sub, &args)
        }
        "" => Err("usage: ultron-memory <resume|orchestrate|recall [--cross|--all-projects]|stats|reindex|catalog [--agents|--skills]|reindex-skills-lazy|skill-query <prompt> [--top N]|eval [--golden [<path>]]|eval-full|reconcile|warmup|serve|serve-ping|doctor|candidate|supersede --old <id>|capture|edge|forget --id <id|prefix> [--dry-run] [--reason R]|deprecate --type <T> [--dry-run] [--reason R]|inbox <list|approve-clean|approve-all|auto-approve <on|off>>> [--project X] [args]".to_string()),
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
    MemoryService::create_candidate(&c).map_err(|e| e.to_string())
}

/// 1.3 (memoria viva): construye el NUEVO item desde el JSON de stdin y supersede
/// `old_id` (viejo -> Deprecated/valid_to=now, nuevo -> Active, enlazados). El
/// project_id sigue la misma precedencia que la captura: payload -> git-root(cwd).
/// supersede() ya redacta secretos en el write-path; este es un camino EXPLICITO
/// (no auto): el auto-trigger por contradiccion "misma entidad, distinto valor"
/// queda para una iteracion con clasificador dedicado.
fn emit_supersede(json: &str, old_id: &str) -> Result<serde_json::Value, String> {
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

/// Candidate-inbox governance from the CLI. Mirrors the Tauri `memory_inbox_*`
/// commands (commands/memory/inbox.rs) so the inbox can be drained without a
/// running app — useful for headless maintenance and hook-driven cleanup.
fn inbox_command(sub: &str, args: &[String]) -> Result<serde_json::Value, String> {
    use ul::memory::{auto_approve, Actor, MemoryService};

    match sub {
        // Read-only: how many candidates wait, and how many are clean.
        "list" => {
            let pending =
                MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())?;
            let clean = pending
                .iter()
                .filter(|c| auto_approve::candidate_is_clean(c))
                .count();
            Ok(serde_json::json!({
                "pending": pending.len(),
                "clean": clean,
                "flagged": pending.len() - clean,
            }))
        }
        // Drain the inbox. `approve-clean` skips secrets/contradictions (same
        // safeguard as the auto-approve hook); `approve-all` promotes everything.
        "approve-clean" | "approve-all" => {
            let clean_only = sub == "approve-clean";
            let pending =
                MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())?;
            let mut approved = 0u32;
            let mut skipped = 0u32;
            let mut failed = 0u32;
            for cand in pending {
                if clean_only && !auto_approve::candidate_is_clean(&cand) {
                    skipped += 1;
                    continue;
                }
                match MemoryService::approve_candidate(&cand.id, Actor::User) {
                    Ok(_) => approved += 1,
                    Err(_) => failed += 1,
                }
            }
            Ok(serde_json::json!({
                "approved": approved,
                "skipped_flagged": skipped,
                "failed": failed,
            }))
        }
        // Persist the auto-approve flag (future CLEAN candidates promote on creation).
        "auto-approve" => {
            let enabled = match args.get(3).map(String::as_str).unwrap_or("") {
                "on" | "true" | "1" => true,
                "off" | "false" | "0" => false,
                "" => return Err("inbox auto-approve requires <on|off>".to_string()),
                other => return Err(format!("invalid auto-approve value '{other}' (use on|off)")),
            };
            let settings = auto_approve::MemorySettings {
                auto_approve: enabled,
                ..auto_approve::read_settings()
            };
            let saved = auto_approve::write_settings(settings)?;
            Ok(serde_json::json!({ "auto_approve": saved.auto_approve }))
        }
        "" => Err(
            "usage: ultron-memory inbox <list|approve-clean|approve-all|auto-approve <on|off>>"
                .to_string(),
        ),
        other => Err(format!("unknown inbox subcommand '{other}'")),
    }
}

fn to_json<T: serde::Serialize>(v: T) -> Result<serde_json::Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// Resolve an id prefix (≥ 1 hex char) to an unambiguous full item id.
///
/// Returns the full id when exactly one ACTIVE or non-active item starts with
/// the prefix. Errors when:
/// - The prefix is empty or contains only whitespace.
/// - No item id starts with the prefix.
/// - More than one item id starts with the prefix (ambiguous).
///
/// Accepts a full UUID as well (pass-through when the item exists).
fn resolve_id_prefix(prefix: &str) -> Result<String, String> {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return Err("--id must not be empty".to_string());
    }
    // Open a read-only connection for the prefix scan.
    let conn = ul::memory::sqlite_store::open_conn().map_err(|e| e.to_string())?;
    let matches =
        ul::memory::sqlite_store::find_ids_by_prefix(&conn, prefix).map_err(|e| e.to_string())?;
    match matches.len() {
        0 => Err(format!("no item found with id prefix '{prefix}'")),
        1 => Ok(matches.into_iter().next().unwrap()),
        n => Err(format!(
            "prefix '{prefix}' is ambiguous — matches {n} items; use a longer prefix"
        )),
    }
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
