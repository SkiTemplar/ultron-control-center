//! Candidate-inbox governance from the CLI. Mirrors the Tauri `memory_inbox_*`
//! commands (commands/memory/inbox.rs) so the inbox can be drained without a
//! running app — useful for headless maintenance and hook-driven cleanup.

use control_center_lib as ul;

pub(crate) fn inbox_command(sub: &str, args: &[String]) -> Result<serde_json::Value, String> {
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
        // Drena el stock pendiente aplicando LA MISMA politica de 3 bandas que el
        // write-path usa con auto-approve ON (un solo criterio, no dos):
        //   - no-clean (secreto/contradiccion/duplicado/unverified) -> QUEDA pending
        //     (adjudicacion en sesion; la salvaguarda no se relaja en bulk).
        //   - banda A (clean + confidence >= threshold) -> approve (Actor::System).
        //   - banda C (confidence < 0.55) -> reject (ruido).
        //   - banda B -> queda pending.
        // `--dry-run` solo cuenta. Feedback del usuario 2026-07-02: inbox autonomo.
        "drain" => {
            let dry = args.iter().any(|a| a == "--dry-run");
            let threshold = auto_approve::auto_approve_threshold();
            let pending =
                MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())?;
            let total = pending.len();
            let (mut approved, mut rejected, mut kept_b, mut kept_unclean, mut failed) =
                (0u32, 0u32, 0u32, 0u32, 0u32);
            for cand in pending {
                if !auto_approve::candidate_is_clean(&cand) {
                    kept_unclean += 1;
                    continue;
                }
                match auto_approve::classify_band(&cand, threshold) {
                    auto_approve::AutoBand::Approve => {
                        if dry {
                            approved += 1;
                        } else {
                            match MemoryService::approve_candidate(&cand.id, Actor::System) {
                                Ok(_) => approved += 1,
                                Err(_) => failed += 1,
                            }
                        }
                    }
                    auto_approve::AutoBand::Reject => {
                        if dry {
                            rejected += 1;
                        } else {
                            match MemoryService::reject_candidate(
                                &cand.id,
                                Actor::System,
                                Some("inbox drain: banda C (ruido, confidence < 0.55)".into()),
                            ) {
                                Ok(()) => rejected += 1,
                                Err(_) => failed += 1,
                            }
                        }
                    }
                    auto_approve::AutoBand::Pending => kept_b += 1,
                }
            }
            Ok(serde_json::json!({
                "dry_run": dry,
                "threshold": threshold,
                "total": total,
                "approved": approved,
                "rejected": rejected,
                "kept_band_b": kept_b,
                "kept_unclean": kept_unclean,
                "failed": failed,
            }))
        }
        // Curacion puntual por id (headless): `inbox approve --id X` / `inbox
        // reject --id X [--reason R]`. Reusa los paths canonicos del service
        // (Actor::User = validacion explicita). Acepta prefijo de id (paridad
        // con forget/deprecate): se resuelve a UUID completo o falla si 0/>1.
        "approve" | "reject" => {
            let id = crate::cli_args::flag_value(args, "--id")
                .ok_or_else(|| format!("inbox {sub} requiere --id <candidate-id>"))?;
            let id = resolve_candidate_id_prefix(&id)?;
            if sub == "approve" {
                let item = MemoryService::approve_candidate(&id, Actor::User)
                    .map_err(|e| e.to_string())?;
                Ok(serde_json::json!({ "approved": id, "item_id": item.id }))
            } else {
                let reason = crate::cli_args::flag_value(args, "--reason");
                MemoryService::reject_candidate(&id, Actor::User, reason)
                    .map_err(|e| e.to_string())?;
                Ok(serde_json::json!({ "rejected": id }))
            }
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
            "usage: ultron-memory inbox <list|drain [--dry-run]|approve --id <id>|reject --id <id> [--reason R]|approve-clean|approve-all|auto-approve <on|off>>"
                .to_string(),
        ),
        other => Err(format!("unknown inbox subcommand '{other}'")),
    }
}

/// Resolve a candidate-id prefix to an unambiguous full UUID (mirror of the
/// item-side `resolve_id_prefix` in main.rs). Full UUIDs pass through as the
/// single match; 0 or >1 matches error so a short prefix can never act on the
/// wrong candidate.
fn resolve_candidate_id_prefix(prefix: &str) -> Result<String, String> {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return Err("--id must not be empty".to_string());
    }
    let conn = ul::memory::sqlite_store::open_conn().map_err(|e| e.to_string())?;
    let matches = ul::memory::sqlite_store::find_candidate_ids_by_prefix(&conn, prefix)
        .map_err(|e| e.to_string())?;
    match matches.len() {
        0 => Err(format!("no candidate found with id prefix '{prefix}'")),
        1 => Ok(matches.into_iter().next().unwrap()),
        n => Err(format!(
            "prefix '{prefix}' is ambiguous — matches {n} candidates; use a longer prefix"
        )),
    }
}
