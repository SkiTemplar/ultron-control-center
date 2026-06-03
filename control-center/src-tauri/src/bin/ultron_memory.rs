//! ultron-memory — CLI sidecar for the Claude Code hooks (Node).
//!
//! Lets the lifecycle hooks (SessionStart / UserPromptSubmit / Stop) reuse the
//! canonical Rust memory + orchestrator logic instead of duplicating it in JS
//! (the whole point of the rework is ONE source of truth, not a parallel stack).
//! Each subcommand prints one JSON object on stdout (machine-readable for hooks).
//!
//!   ultron-memory resume [--project X]          # SessionStart -> bounded resume
//!   ultron-memory orchestrate <prompt> [--project X]  # UserPromptSubmit -> route
//!   ultron-memory recall <query> [--project X]  # hybrid recall context pack
//!   ultron-memory stats                         # memory health counts
//!   ultron-memory reindex                       # rebuild the dense index
//!   ultron-memory candidate                     # Stop -> propose a candidate (stdin JSON)
//!
//! Build: cargo build --release --bin ultron-memory --features qdrant

use std::io::Read;

use control_center_lib as ul;

fn main() {
    match run() {
        Ok(v) => println!("{}", serde_json::to_string(&v).unwrap_or_else(|_| "{}".to_string())),
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
            to_json(ul::commands::memory::recall_unified::recall_pack(&query, 8, project.as_deref())?)
        }
        "stats" => to_json(ul::memory::MemoryService::stats().map_err(|e| e.to_string())?),
        "reindex" => {
            let (indexed, errors) =
                ul::memory::qdrant_index::reindex_all().map_err(|e| e.to_string())?;
            Ok(serde_json::json!({ "indexed": indexed, "errors": errors }))
        }
        "eval" => to_json(ul::memory::evals::run(project.as_deref(), 8)),
        "candidate" => {
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| format!("read stdin: {e}"))?;
            let id = emit_candidate(&buf)?;
            Ok(serde_json::json!({ "candidate_id": id }))
        }
        "" => Err("usage: ultron-memory <resume|orchestrate|recall|stats|reindex|eval|candidate> [args]".to_string()),
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
    if let Some(imp) = v.get("importance").and_then(serde_json::Value::as_f64) {
        c.importance = imp as f32;
    }
    c.source_session_id = v.get("session_id").and_then(|x| x.as_str()).map(String::from);
    MemoryService::create_candidate(&c).map_err(|e| e.to_string())
}

fn to_json<T: serde::Serialize>(v: T) -> Result<serde_json::Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

/// First positional arg(s) after the subcommand, excluding `--project <val>`.
fn positional(args: &[String]) -> Result<String, String> {
    let mut out: Vec<String> = Vec::new();
    let mut i = 2;
    while i < args.len() {
        if args[i] == "--project" {
            i += 2;
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
