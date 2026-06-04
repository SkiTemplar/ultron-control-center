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
        "" => Err("usage: ultron-memory <resume|orchestrate|recall [--cross|--all-projects]|stats|reindex|catalog [--agents|--skills]|eval [--golden]|eval-full|reconcile|doctor|candidate|capture> [--project X] [args]".to_string()),
        other => Err(format!("unknown subcommand '{other}'")),
    }
}

/// Build a pending `MemoryCandidate` from a JSON object on stdin and store it
/// (the Stop hook proposes; the human/policy approves in the inbox).
fn emit_candidate(json: &str) -> Result<String, String> {
    use ul::memory::{MemoryCandidate, MemoryService, MemoryType, Scope};
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
        c.importance = imp as f32;
    }
    c.source_session_id = v
        .get("session_id")
        .and_then(|x| x.as_str())
        .map(String::from);
    MemoryService::create_candidate(&c).map_err(|e| e.to_string())
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
    const BOOL_FLAGS: &[&str] = &["--cross", "--all-projects", "--golden", "--agents", "--skills"];
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
