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
//!   ultron-memory capture [--session <id>]      # Stop -> extract facts (stdin transcript)
//!   ultron-memory provenance --id <id|prefix>   # cita episódica verificable (transcript+hash)
//!   ultron-memory eval-contradiction [<path>]   # gate 1.3b del juez 3-way (auto_supersede)
//!   (edge — RETIRADO 2026-07-02: codegraph interno erradicado, mand.12)
//!   ultron-memory deprecate --type <T> [--dry-run]  # bulk-deprecate a type (purge bloat)
//!   ultron-memory stale [--older-than-days N] [--dry-run]  # age-out ACTIVE items -> Status::Stale
//!   ultron-memory dep-backfill                      # backfill one-shot del ledger de deprecaciones
//!
//! Build: cargo build --release --bin ultron-memory --features qdrant

mod cli_args;
mod emit;
mod eval_contradiction;
mod inbox_cli;

use std::io::Read;

use cli_args::{flag_value, has_flag, positional, reject_unknown_flags};
use control_center_lib as ul;
use emit::{emit_candidate, emit_supersede};
use inbox_cli::inbox_command;

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

/// Subcomandos batch (evals/reindex/backfills): minutos de CPU multi-core que,
/// a prioridad normal, multiplican x3-20 la latencia del hot path del hook y
/// revientan su DAEMON_TIMEOUT_MS. JAMAS incluir serve ni los subcomandos del
/// hook (orchestrate/recall/resume/warmup/capture).
const BATCH_CMDS: &[&str] = &[
    "eval",
    "eval-full",
    "eval-contradiction",
    "backfill-projects",
    "reindex",
    "reindex-skills-lazy",
    "catalog",
    "dep-backfill",
    "sweep",
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

fn run() -> Result<serde_json::Value, String> {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(String::as_str).unwrap_or("");
    let project = flag_value(&args, "--project");

    if BATCH_CMDS.contains(&cmd) {
        lower_own_priority();
    }

    match cmd {
        "resume" => to_json(ul::commands::memory::session_resume::session_resume_inner(project)?),
        "orchestrate" => {
            let prompt = positional(&args)?;
            // CLI one-shot fallback for the hot path. dense=TRUE: quality-first
            // (full hybrid recall + semantic match); see serve.rs for rationale.
            to_json(ul::orchestrator::orchestrate(&prompt, project.as_deref(), true))
        }
        // Diagnostico completo del retrieval (cat1, 2026-07-02): dense/sparse/
        // fused con ranks + injected/discarded CON RAZON (token cap, governance,
        // rank). Es build_trace serializado — lo que ve el Retrieval Inspector,
        // ahora disponible headless para diagnosticar el golden set.
        "trace" => {
            let query = positional(&args)?;
            let cross = has_flag(&args, "--cross") || has_flag(&args, "--all-projects");
            to_json(ul::commands::memory::recall_unified::build_trace(
                &query,
                8,
                project.as_deref(),
                cross,
                true,
                true, // paridad con el eval: el trace diagnostica el path de calidad
            )?)
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
                true, // recall manual explicito: calidad con cross-encoder
            )?)
        }
        "stats" => to_json(ul::memory::MemoryService::stats().map_err(|e| e.to_string())?),
        // (2026-07-13) Backfill de project_id del corpus AMBIENTE (NULL):
        // normalize (variantes -> slug canonico) + provenance (session_id del
        // cockpit) + dense vote (vector almacenado en Qdrant, k-NN etiquetado).
        // Dry-run por defecto; --apply escribe (SQLite + evento + payload).
        "backfill-projects" => {
            let opts = ul::memory::backfill::BackfillOpts {
                apply: has_flag(&args, "--apply"),
                min_score: flag_value(&args, "--min-score")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(ul::memory::backfill::DEFAULT_MIN_SCORE),
                min_share: flag_value(&args, "--min-share")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(ul::memory::backfill::DEFAULT_MIN_SHARE),
                knn: flag_value(&args, "--knn")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(ul::memory::backfill::DEFAULT_KNN),
            };
            ul::memory::backfill::run(&opts)
        }
        // Curación puntual: mueve TODOS los items de un project_id a otro slug
        // canónico (ids legado que el normalize no puede plegar). Dry-run salvo --apply.
        "reassign-project" => {
            let from = flag_value(&args, "--from")
                .ok_or_else(|| "reassign-project requiere --from <project_id>".to_string())?;
            let to = flag_value(&args, "--to")
                .ok_or_else(|| "reassign-project requiere --to <slug-canonico>".to_string())?;
            ul::memory::backfill::reassign_project(&from, &to, has_flag(&args, "--apply"))
        }
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
            // cat6.5 (mand.11): rechaza flags desconocidos para no fingir medir con
            // el eval sintetico (recall=1.0) ante un typo como `--gold` por `--golden`.
            reject_unknown_flags(&args, &["--golden", "--project", "--summary"])?;
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
                let mut v = to_json(ul::memory::evals::run_labeled_golden(&golden_path, 8))?;
                // `--summary` (P2 token-eff): quita el desglose per-query (~300
                // lineas de retrieved_ids) y deja solo el aggregate + conteos —
                // lo que consumen el harness y una lectura humana del gate.
                if has_flag(&args, "--summary") {
                    if let serde_json::Value::Object(ref mut map) = v {
                        map.remove("per_query");
                    }
                }
                Ok(v)
            } else {
                let base = ul::memory::evals::run(project.as_deref(), 8);
                let mut v = to_json(base)?;
                if has_flag(&args, "--golden") {
                    let gm = ul::memory::evals::run_golden_metrics(project.as_deref(), 8, true);
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
        "eval-full" => to_json(ul::memory::evals::run_golden_metrics(project.as_deref(), 8, true)),
        // Eval 1.3b: accuracy del juez 3-way classify_contradiction sobre un golden
        // etiquetado a mano. GATE de auto_supersede: pass = todos decididos +
        // accuracy >= 0.85 + false_state_updates == 0. Corre contra el router real.
        //   ultron-memory eval-contradiction [<path>]
        "eval-contradiction" => {
            let default_path = dirs::home_dir()
                .map(|h| {
                    h.join(".ultron/cockpit/memory-rework/evals/contradiction_golden.json")
                        .display()
                        .to_string()
                })
                .unwrap_or_default();
            let path = args
                .get(2)
                .filter(|a| !a.starts_with("--"))
                .cloned()
                .unwrap_or(default_path);
            eval_contradiction::run(&path)
        }
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
            // {candidate_id} o {skipped:"duplicate", existing_id} (ambos exit 0):
            // el dedupe bloqueante del write-path es idempotencia, no un error.
            emit_candidate(&buf)
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
        // (subcomando `edge` retirado 2026-07-02 — codegraph interno erradicado,
        //  mand.12: 0 lectores. El codegraph real es el indexador externo `.codegraph/`.)
        "capture" => {
            // Stop hook -> auto-capture: extract durable facts (via AI Router,
            // which also populates router telemetry) and propose them as inbox
            // candidates. Transcript on stdin; never auto-promotes to active.
            // `--session <id>` stamps source_session_id on every candidate
            // (provenance episódica — see the `provenance` subcommand).
            let session = flag_value(&args, "--session");
            let mut buf = String::new();
            std::io::stdin()
                .read_to_string(&mut buf)
                .map_err(|e| format!("read stdin: {e}"))?;
            to_json(ul::memory::capture::capture_session(
                &buf,
                project.as_deref(),
                session.as_deref(),
            ))
        }
        // Provenance episódica (feedback 2026-07-02): cita VERIFICABLE del origen
        // de una memoria. Devuelve la sesión de captura (source_session_id), el
        // canal (capture_source), el content_hash del texto vivo, y resuelve el
        // transcript real `<session_id>.jsonl` bajo ~/.claude/projects/*/ si aún
        // existe en disco. Read-only; nada se persiste. Un item sin sesión de
        // origen responde `episodic: false` (honesto — no se inventa procedencia).
        //   ultron-memory provenance --id <id|prefix>
        "provenance" => {
            let id_prefix = flag_value(&args, "--id")
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
            Ok(serde_json::json!({
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
            // Solo se precalienta BGE si el HOT PATH lo va a usar (opt-in
            // ULTRON_RERANK_HOT): tras el split, el hook no re-rankea, y calentar
            // ~1 GB extra en cada SessionStart era una tormenta de CPU inutil.
            let reranker_warmed = if ul::qdrant::rerank_hot_enabled() {
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
        //   ultron-memory deprecate --id <id|prefix> [--reason R]   (curacion de eras, 2026-07-02)
        "deprecate" => {
            // Modo por-id: deprecacion RECOVERABLE de un item concreto (hechos de
            // una era superseded: la afirmacion fue real, ya no es verdad vigente).
            // forget es borrado duro (PII); esto conserva el item fuera de recall.
            if let Some(id_prefix) = flag_value(&args, "--id") {
                let resolved_id = resolve_id_prefix(&id_prefix)?;
                let reason = flag_value(&args, "--reason");
                let item = ul::memory::MemoryService::deprecate(
                    &resolved_id,
                    ul::memory::Actor::System,
                    reason,
                )
                .map_err(|e| e.to_string())?;
                return Ok(serde_json::json!({
                    "deprecated": resolved_id,
                    "status": item.status.as_str(),
                    "ok": true,
                }));
            }
            let kind_s = flag_value(&args, "--type")
                .ok_or_else(|| "deprecate requires --type <T> (bulk) o --id <id> (item)".to_string())?;
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
        // Sweep ACTIVE items not MODIFIED in --older-than-days (default 180) and
        // transition them to Status::Stale (no longer recall-eligible). --dry-run
        // only counts. Reuses set_status per id so FTS5 + Qdrant + the event log
        // stay in sync; pinned and user-validated items are protected. Reversible.
        //   ultron-memory stale [--older-than-days N] [--dry-run] [--reason R]
        "stale" => {
            let days: i64 = flag_value(&args, "--older-than-days")
                .and_then(|s| s.parse().ok())
                .unwrap_or(180);
            let dry = has_flag(&args, "--dry-run");
            let reason = flag_value(&args, "--reason");
            let res = ul::memory::MemoryService::mark_stale_aged(
                days,
                dry,
                ul::memory::Actor::System,
                reason,
            )
            .map_err(|e| e.to_string())?;
            to_json(res)
        }
        // Sweep por confianza (audit 2026-08-09): deprecar ACTIVE con confidence
        // < --below (default 0.55, el umbral de ruido de banda C) EXCLUYENDO
        // golden positives (el oráculo no se canibaliza), pinned y user-validated.
        // Reversible (deprecate, no forget). --dry-run solo cuenta.
        //   ultron-memory sweep [--below 0.55] [--dry-run] [--reason R]
        "sweep" => {
            let below: f32 = flag_value(&args, "--below")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.55);
            let dry = has_flag(&args, "--dry-run");
            let reason = flag_value(&args, "--reason");
            let protected = ul::memory::evals::golden_protected_ids();
            let res = ul::memory::MemoryService::sweep_low_confidence(
                below,
                &protected,
                dry,
                ul::memory::Actor::System,
                reason,
            )
            .map_err(|e| e.to_string())?;
            to_json(res)
        }
        // Informe READ-ONLY de víctimas de higiene en los golden sets (patrón
        // b1ea0e5): expect_ids no-ACTIVE con su gemelo activo por content_hash.
        // No muta nada — el remap de los JSON lo aplica quien lee el informe.
        //   ultron-memory golden-remap
        "golden-remap" => Ok(ul::memory::evals::golden_remap_report()),
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
        // Backfill one-shot del ledger de deprecaciones (cat21.4):
        // recorre memory_events WHERE event_type='deprecated' e inserta en
        // deprecation_entries (INSERT OR IGNORE). Idempotente; retorna
        // { scanned, inserted, skipped }. Ejecutar UNA VEZ tras deployar el binario.
        //   ultron-memory dep-backfill
        "dep-backfill" => {
            let res = ul::memory::MemoryService::backfill_deprecations()
                .map_err(|e| e.to_string())?;
            to_json(res)
        }
        // cat7.8: SHA corto de HEAD embebido en build time (build.rs) para verificar
        // exe<->commit sin depender del mtime (un `touch` lo falsea). option_env!
        // degrada a "unknown" si el build no tuvo git disponible.
        "version" => Ok(serde_json::json!({
            "bin": "ultron-memory",
            "pkg_version": env!("CARGO_PKG_VERSION"),
            "git_sha": option_env!("ULTRON_GIT_SHA").unwrap_or("unknown"),
        })),
        "" => Err("usage: ultron-memory <resume|orchestrate|recall [--cross|--all-projects]|stats|reindex|catalog [--agents|--skills]|reindex-skills-lazy|skill-query <prompt> [--top N]|eval [--golden [<path>]]|eval-full|reconcile|warmup|serve|serve-ping|doctor|candidate|supersede --old <id>|capture [--session <id>]|provenance --id <id|prefix>|eval-contradiction [<path>]|forget --id <id|prefix> [--dry-run] [--reason R]|deprecate --type <T> [--dry-run] [--reason R]|stale [--older-than-days N] [--dry-run] [--reason R]|inbox <list|approve-clean|approve-all|auto-approve <on|off>>|dep-backfill|version> [--project X] [args]".to_string()),
        other => Err(format!("unknown subcommand '{other}'")),
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
