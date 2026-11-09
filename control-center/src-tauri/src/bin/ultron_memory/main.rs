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
//!   ultron-memory reconcile --fix [--dry-run]   # repair just the drift (missing/orphans)
//!   ultron-memory warmup                        # SessionStart -> warm E5 (page cache)
//!   ultron-memory serve                         # persistent daemon: E5 resident, sub-second orchestrate
//!   ultron-memory serve-ping                    # is a live daemon reachable? (read-only)
//!   ultron-memory candidate                     # Stop -> propose a candidate (stdin JSON)
//!   ultron-memory capture [--session <id>]      # Stop -> extract facts (stdin transcript)
//!   ultron-memory provenance --id <id|prefix>   # cita episódica verificable (transcript+hash)
//!   (edge — RETIRADO 2026-07-02: codegraph interno erradicado, mand.12)
//!   ultron-memory deprecate --type <T> [--dry-run]  # bulk-deprecate a type (purge bloat)
//!   ultron-memory stale [--older-than-days N] [--dry-run]  # age-out ACTIVE items -> Status::Stale
//!   ultron-memory scrub-secrets [--dry-run]     # redacta credenciales ya persistidas (detector actual) + VACUUM
//!   ultron-memory gc [--days 90] [--dry-run]    # mantenimiento: decaimiento de ACTIVE sin recall +
//!                                               # poda del log (items muertos, eventos sin item y huerfanos)
//!   ultron-memory dedupe [--dry-run] [--reason R]      # deprecar copias exactas de ACTIVE (sobrevive 1 por grupo)
//!   ultron-memory deprecations apply [--dry-run]  # cierra deadlines vencidos de deprecation_entries (archiva o marca deleted)
//!
//! Build: cargo build --release --bin ultron-memory --features qdrant

mod capture_cli;
mod cli_args;
mod cli_spec;
mod drain_lock;
mod emit;
mod inbox_auto;
mod inbox_cli;
mod index_cli;
mod maintenance_cli;
mod recall_cli;

use cli_args::flag_value;
use control_center_lib as ul;
use inbox_cli::inbox_command;

fn main() {
    // Config desde ~/.ultron/.env (mismo patrón no-override que lib.rs): sin
    // esto las ULTRON_* solo llegaban si el shell/hook exportaba la variable —
    // el daemon (serve) arrancado por un hook no las veía y un A/B por env var
    // medía la config vieja (gotcha 2026-08-16). El proceso lee el .env al
    // ARRANCAR: cambiar un valor exige reiniciar el daemon para que lo vea.
    // Las keys del router que falten aquí (un hook de una sesión de ULTRON
    // hereda un entorno sin keys) no se cargan en el entorno: las resuelve
    // `ai_router::key_source` desde HKCU\Environment, en memoria y solo si se
    // enruta, para que no las hereden los hijos ni pague `reg` quien no enruta.
    if let Some(home) = dirs::home_dir() {
        let _ = dotenvy::from_filename(home.join(".ultron").join(".env"));
    }
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

/// Subcomandos batch (evals/reindex/backfills): minutos de CPU multi-core que,
/// a prioridad normal, multiplican x3-20 la latencia del hot path del hook y
/// revientan su DAEMON_TIMEOUT_MS. JAMAS incluir serve ni los subcomandos del
/// hook (orchestrate/recall/resume/warmup/capture).
const BATCH_CMDS: &[&str] = &[
    "eval",
    "eval-full",
    "backfill-projects",
    "reindex",
    "reindex-skills-lazy",
    "catalog",
    "sweep",
    "hubs",
];

/// Baja la prioridad del PROPIO proceso a BELOW_NORMAL (best-effort, solo
/// Windows). No-op si la llamada falla: la prioridad nunca bloquea el batch.
#[cfg(windows)]
fn lower_own_priority() {
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS,
    };
    // SAFETY: GetCurrentProcess devuelve un pseudo-handle siempre valido del
    // proceso actual; SetPriorityClass no toca memoria de Rust.
    unsafe {
        SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS);
    }
}

#[cfg(not(windows))]
fn lower_own_priority() {}

/// Línea de uso cuando falta el subcomando.
const USAGE: &str = "usage: ultron-memory <resume|orchestrate|recall [--cross|--all-projects]|stats|reindex|catalog [--agents|--skills]|reindex-skills-lazy|skill-query <prompt> [--top N]|skill-judge <prompt>|eval [--golden [<path>]]|eval-full|reconcile [--fix [--dry-run]]|fts-rebuild|secret-backfill [--dry-run]|pii-backfill [--dry-run]|scrub-secrets [--dry-run]|warmup|serve|serve-ping|doctor|candidate|supersede --old <id>|capture [--session <id>]|provenance --id <id|prefix>|forget --id <id|prefix> [--dry-run] [--reason R]|deprecate --type <T> [--dry-run] [--reason R]|stale [--older-than-days N] [--dry-run] [--reason R]|gc [--days 90] [--dry-run]|dedupe [--dry-run]|deprecations apply [--dry-run]|inbox <list|approve-clean|approve-all|auto-approve <on|off>>|version> [--project X] [args]";

fn run() -> Result<serde_json::Value, String> {
    let args: Vec<String> = std::env::args().collect();
    // `--help`/`-h` = ayuda sin ejecutar; flag desconocido = error. Antes de
    // despachar: `sweep --help` y `stale --help` ejecutaban escrituras masivas.
    if let Some(help) = cli_spec::preflight(&args)? {
        return Ok(help);
    }
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    let project = flag_value(&args, "--project");

    if BATCH_CMDS.contains(&cmd) {
        lower_own_priority();
    }
    dispatch(cmd, &args, project.as_deref())
}

/// Un brazo por subcomando; el cuerpo de cada uno vive en su módulo
/// (recall_cli, index_cli, capture_cli, maintenance_cli, inbox_cli).
fn dispatch(
    cmd: &str,
    args: &[String],
    project: Option<&str>,
) -> Result<serde_json::Value, String> {
    match cmd {
        "resume" => to_json(ul::commands::memory::session_resume::session_resume_inner(
            project.map(str::to_string),
        )?),
        "orchestrate" => recall_cli::orchestrate(args, project),
        "trace" => recall_cli::trace(args, project),
        "recall" => recall_cli::recall(args, project),
        "stats" => to_json(ul::memory::MemoryService::stats().map_err(|e| e.to_string())?),
        "backfill-projects" => index_cli::backfill_projects(args),
        "curate" => index_cli::curate(args),
        "reassign-project" => index_cli::reassign_project(args),
        "hubs" => recall_cli::hubs(args),
        "reindex" => index_cli::reindex(),
        "catalog" => index_cli::catalog(args),
        "eval" => recall_cli::eval(args, project),
        "eval-full" => recall_cli::eval_full(project),
        "reconcile" => index_cli::reconcile(args),
        "candidate" => capture_cli::candidate(),
        "supersede" => capture_cli::supersede(args),
        // (subcomando `edge` retirado 2026-07-02 — codegraph interno erradicado,
        //  mand.12: 0 lectores. El codegraph real es el indexador externo `.codegraph/`.)
        "capture" => capture_cli::capture(args, project),
        "provenance" => capture_cli::provenance(args),
        "warmup" => capture_cli::warmup(),
        "doctor" => capture_cli::doctor(),
        // Mantenimiento (forget, archive, deprecate, stale, gc, sweep, dedupe,
        // fts-rebuild, secret-backfill, scrub-secrets, deprecations): ver `maintenance_cli.rs`.
        "forget" | "archive" | "deprecate" | "stale" | "fts-rebuild" | "secret-backfill"
        | "pii-backfill" | "scrub-secrets" | "gc" | "sweep" | "dedupe" | "deprecations" => {
            maintenance_cli::maintenance_command(cmd, args, project)
        }
        // Informe READ-ONLY de víctimas de higiene en los golden sets (patrón
        // b1ea0e5): expect_ids no-ACTIVE con su gemelo activo por content_hash.
        "golden-remap" => Ok(ul::memory::evals::golden_remap_report()),
        "reindex-skills-lazy" => index_cli::reindex_skills_lazy(),
        "skill-query" => index_cli::skill_query(args),
        "skill-judge" => index_cli::skill_judge(args),
        // Persistent orchestrator daemon: keeps E5 resident so UserPromptSubmit
        // orchestration drops from ~3.5s to sub-second. Blocks forever serving
        // requests, OR returns `already_running` when a live daemon owns the
        // lockfile. Spawned DETACHED by the SessionStart memory-warmup hook.
        "serve" => ul::serve::run_daemon(),
        // Report whether a live daemon is reachable (lockfile + ping). Read-only.
        "serve-ping" => Ok(ul::serve::ping_status()),
        // Candidate inbox governance from the CLI (no running app needed): ver
        // `inbox_cli.rs`. approve-* reuse MemoryService::approve_candidate.
        "inbox" => inbox_command(args.get(2).map(String::as_str).unwrap_or(""), args),
        // cat7.8 + K1: SHA corto de HEAD y estado del árbol embebidos en build
        // time (build.rs) para verificar exe<->commit sin depender del mtime. Con
        // `dirty: true` el SHA no describe el código del binario.
        "version" => Ok(ul::build_stamp::version_json(
            "ultron-memory",
            ul::build_stamp::current(),
        )),
        "" => Err(USAGE.to_string()),
        other => Err(format!("unknown subcommand '{other}'")),
    }
}

fn to_json<T: serde::Serialize>(v: T) -> Result<serde_json::Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// Resolve a full item id or an id prefix (≥ `MIN_ID_PREFIX_CHARS`
/// characters, compared literally) to an unambiguous full item id, ACTIVE or
/// not. Errors on an empty, too short, absent or ambiguous prefix; the rules
/// live in `sqlite_store::resolve_unique_id` (tested there).
fn resolve_id_prefix(prefix: &str) -> Result<String, String> {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return Err("--id must not be empty".to_string());
    }
    let conn = ul::memory::sqlite_store::open_conn().map_err(|e| e.to_string())?;
    let matches =
        ul::memory::sqlite_store::find_ids_by_prefix(&conn, prefix).map_err(|e| e.to_string())?;
    ul::memory::sqlite_store::resolve_unique_id(prefix, matches, "item")
}
