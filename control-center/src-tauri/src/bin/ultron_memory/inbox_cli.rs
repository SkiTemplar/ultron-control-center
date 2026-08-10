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
            let mut rejected_dup = 0u32;
            let mut failed = 0u32;
            for cand in pending {
                if clean_only && !auto_approve::candidate_is_clean(&cand) {
                    skipped += 1;
                    continue;
                }
                match MemoryService::approve_candidate(&cand.id, Actor::User) {
                    Ok(_) => approved += 1,
                    // Gate anti-dup (2026-08-10): el candidato quedó rechazado
                    // conservando el ACTIVE — no es un fallo, es governance.
                    Err(ul::memory::MemoryError::Duplicate(_)) => rejected_dup += 1,
                    Err(_) => failed += 1,
                }
            }
            Ok(serde_json::json!({
                "approved": approved,
                "skipped_flagged": skipped,
                "rejected_duplicate": rejected_dup,
                "failed": failed,
            }))
        }
        // Drena el stock pendiente. Dos modos:
        //
        // CLASICO (sin flag): LA MISMA politica de 3 bandas que el write-path
        // usa con auto-approve ON (un solo criterio, no dos):
        //   - no-clean (secreto/contradiccion/duplicado/unverified) -> QUEDA pending
        //     (adjudicacion en sesion; la salvaguarda no se relaja en bulk).
        //   - banda A (clean + confidence >= threshold) -> approve (Actor::System).
        //   - banda C (confidence < 0.55) -> reject (ruido).
        //   - banda B -> queda pending.
        //
        // FULL-AUTO (`--auto`, decision del usuario 2026-07-13: "que no tenga yo
        // que aceptar ni negar nada"): cero adjudicacion humana.
        //   1. Los unverified se RE-VERIFICAN aqui (reverify_candidate: el juez
        //      y el dedup corren sin presupuesto interactivo; la causa del stock
        //      era el E5 frio del one-shot de captura agotando el budget 4.5s).
        //      Un state-update 1:1 claro auto-supersede en la re-verificacion.
        //   2. auto_disposition decide TODO lo demas: secret/PII -> reject
        //      (nunca a active), duplicado/contradiccion -> reject conservando
        //      el ACTIVE, banda C -> reject (ruido), bandas A y B -> approve.
        //      Solo queda pending lo que siga sin poder verificarse (infra
        //      caida): el fail-closed del write-path no se relaja ni en auto.
        //
        // `--dry-run` solo cuenta (en --auto tambien evita la re-verificacion,
        // porque esta persiste hallazgos). Feedback 2026-07-02: inbox autonomo.
        "drain" => {
            let dry = args.iter().any(|a| a == "--dry-run");
            let auto = args.iter().any(|a| a == "--auto");
            let threshold = auto_approve::auto_approve_threshold();
            let pending =
                MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())?;
            let total = pending.len();

            if auto {
                let (mut approved, mut superseded, mut kept_unverified, mut failed) =
                    (0u32, 0u32, 0u32, 0u32);
                let (mut rej_secret, mut rej_dup, mut rej_conflict, mut rej_noise) =
                    (0u32, 0u32, 0u32, 0u32);
                for cand in pending {
                    // Re-verificacion primero (persiste; en dry-run se salta y
                    // el candidato se clasifica con lo que ya se sabe de el).
                    let cand = if !dry && auto_approve::candidate_is_unverified(&cand) {
                        MemoryService::reverify_candidate(&cand).unwrap_or(cand)
                    } else {
                        cand
                    };
                    if cand.status == ul::memory::CandidateStatus::Approved {
                        superseded += 1; // auto-supersede ejecutado en reverify
                        continue;
                    }
                    use auto_approve::{AutoDisposition, RejectKind};
                    match auto_approve::auto_disposition(&cand) {
                        AutoDisposition::Approve => {
                            if dry {
                                approved += 1;
                            } else {
                                match MemoryService::approve_candidate(&cand.id, Actor::System) {
                                    Ok(_) => approved += 1,
                                    // Gate anti-dup en approve: cuenta como dup, no fallo.
                                    Err(ul::memory::MemoryError::Duplicate(_)) => rej_dup += 1,
                                    Err(_) => failed += 1,
                                }
                            }
                        }
                        AutoDisposition::KeepUnverified => kept_unverified += 1,
                        AutoDisposition::Reject(kind) => {
                            let (counter, reason): (&mut u32, String) = match kind {
                                RejectKind::Secret => (
                                    &mut rej_secret,
                                    "drain --auto: secret/PII — nunca a active".into(),
                                ),
                                RejectKind::Duplicate => (
                                    &mut rej_dup,
                                    format!(
                                        "drain --auto: near-dup de {} (el ACTIVE se conserva)",
                                        cand.duplicate_candidates.join(", ")
                                    ),
                                ),
                                RejectKind::Contradiction => (
                                    &mut rej_conflict,
                                    format!(
                                        "drain --auto: contradice {} — gana el ACTIVE",
                                        cand.contradiction_candidates.join(", ")
                                    ),
                                ),
                                RejectKind::Noise => (
                                    &mut rej_noise,
                                    "drain --auto: banda C (ruido, confidence < 0.55)".into(),
                                ),
                            };
                            if dry {
                                *counter += 1;
                            } else {
                                match MemoryService::reject_candidate(
                                    &cand.id,
                                    Actor::System,
                                    Some(reason),
                                ) {
                                    Ok(()) => *counter += 1,
                                    Err(_) => failed += 1,
                                }
                            }
                        }
                    }
                }
                return Ok(serde_json::json!({
                    "mode": "auto",
                    "dry_run": dry,
                    "total": total,
                    "approved": approved,
                    "superseded": superseded,
                    "rejected_secret": rej_secret,
                    "rejected_duplicate": rej_dup,
                    "rejected_contradiction": rej_conflict,
                    "rejected_noise": rej_noise,
                    "kept_unverified": kept_unverified,
                    "failed": failed,
                }));
            }

            let (mut approved, mut rejected, mut kept_b, mut kept_unclean, mut failed) =
                (0u32, 0u32, 0u32, 0u32, 0u32);
            let mut rejected_dup = 0u32;
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
                                // Gate anti-dup en approve (2026-08-10).
                                Err(ul::memory::MemoryError::Duplicate(_)) => rejected_dup += 1,
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
                "rejected_duplicate": rejected_dup,
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
            "usage: ultron-memory inbox <list|drain [--dry-run] [--auto]|approve --id <id>|reject --id <id> [--reason R]|approve-clean|approve-all|auto-approve <on|off>>"
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
