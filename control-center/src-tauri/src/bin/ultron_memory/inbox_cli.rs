//! Candidate-inbox governance from the CLI. Since 2026-10-18 the app no longer
//! has an inbox view: the Stop hook's `drain --auto` and this CLI are the only
//! ways candidates get decided (headless maintenance and hook-driven cleanup).
//!
//! Desde el 2026-10-23 (calidad-rust-4) cada subcomando es una función propia;
//! el comportamiento no cambia.

use control_center_lib as ul;
use serde_json::{json, Value};
use ul::memory::{auto_approve, Actor, MemoryCandidate, MemoryError, MemoryService};

use crate::cli_args::flag_value;

const USAGE: &str = "usage: ultron-memory inbox <list|drain [--dry-run] [--auto]|approve --id <id>|reject --id <id> [--reason R]|approve-clean|approve-all|auto-approve <on|off>>";

pub(crate) fn inbox_command(sub: &str, args: &[String]) -> Result<Value, String> {
    match sub {
        "list" => list(),
        "approve-clean" | "approve-all" => approve_bulk(sub == "approve-clean"),
        "drain" => drain(args),
        "approve" | "reject" => decide_one(sub, args),
        "auto-approve" => set_auto_approve(args),
        "" => Err(USAGE.to_string()),
        other => Err(format!("unknown inbox subcommand '{other}'")),
    }
}

fn pending_candidates() -> Result<Vec<MemoryCandidate>, String> {
    MemoryService::list_pending_candidates(usize::MAX).map_err(|e| e.to_string())
}

/// Read-only: how many candidates wait, and how many are clean.
fn list() -> Result<Value, String> {
    let pending = pending_candidates()?;
    let clean = pending
        .iter()
        .filter(|c| auto_approve::candidate_is_clean(c))
        .count();
    Ok(json!({
        "pending": pending.len(),
        "clean": clean,
        "flagged": pending.len() - clean,
    }))
}

/// Drain the inbox. `approve-clean` skips secrets/contradictions (same
/// safeguard as the auto-approve hook); `approve-all` promotes everything.
fn approve_bulk(clean_only: bool) -> Result<Value, String> {
    let (mut approved, mut skipped, mut rejected_dup, mut failed) = (0u32, 0u32, 0u32, 0u32);
    for cand in pending_candidates()? {
        if clean_only && !auto_approve::candidate_is_clean(&cand) {
            skipped += 1;
            continue;
        }
        match MemoryService::approve_candidate(&cand.id, Actor::User) {
            Ok(_) => approved += 1,
            // Gate anti-dup (2026-08-10): el candidato quedó rechazado
            // conservando el ACTIVE — no es un fallo, es governance.
            Err(MemoryError::Duplicate(_)) => rejected_dup += 1,
            Err(_) => failed += 1,
        }
    }
    Ok(json!({
        "approved": approved,
        "skipped_flagged": skipped,
        "rejected_duplicate": rejected_dup,
        "failed": failed,
    }))
}

/// Drena el stock pendiente. Dos modos:
///
/// CLASICO (sin flag): LA MISMA politica de 3 bandas que el write-path
/// usa con auto-approve ON (un solo criterio, no dos):
///   - no-clean (secreto/contradiccion/duplicado/unverified) -> QUEDA pending
///     (adjudicacion en sesion; la salvaguarda no se relaja en bulk).
///   - banda A (clean + confidence >= threshold) -> approve (Actor::System).
///   - banda C (confidence < 0.55) -> reject (ruido).
///   - banda B -> queda pending.
///
/// FULL-AUTO (`--auto`, decision del usuario 2026-07-13: "que no tenga yo
/// que aceptar ni negar nada"): cero adjudicacion humana.
///   1. Los unverified se RE-VERIFICAN aqui (reverify_candidate: el juez
///      y el dedup corren sin presupuesto interactivo; la causa del stock
///      era el E5 frio del one-shot de captura agotando el budget 4.5s).
///      Un state-update 1:1 claro auto-supersede en la re-verificacion.
///   2. auto_disposition decide TODO lo demas: secret/PII -> reject
///      (nunca a active), duplicado/contradiccion -> reject conservando
///      el ACTIVE, banda C -> reject (ruido), bandas A y B -> approve.
///      Solo queda pending lo que siga sin poder verificarse (infra
///      caida): el fail-closed del write-path no se relaja ni en auto.
///   3. Las capturas de origen no humano (KeepNonUserOrigin) esperan
///      validacion humana NON_USER_ORIGIN_TTL_DAYS (7); al cumplirlos se
///      rechazan como caducadas (`expired_non_user_origin`, 2026-10-18).
///
/// Bucle y contadores del modo `--auto` en `inbox_auto.rs`.
///
/// `--dry-run` solo cuenta (en --auto tambien evita la re-verificacion,
/// porque esta persiste hallazgos). Feedback 2026-07-02: inbox autonomo.
fn drain(args: &[String]) -> Result<Value, String> {
    let dry = args.iter().any(|a| a == "--dry-run");
    let auto = args.iter().any(|a| a == "--auto");
    let pending = pending_candidates()?;
    if auto {
        drain_auto(pending, dry)
    } else {
        Ok(drain_classic(pending, dry))
    }
}

/// `drain --auto`. Single-flight (2026-09-03): un drain por máquina. El Stop
/// hook lanza uno por turno y por sesión; con varias sesiones vivas se
/// solapaban y re-aprobaban la misma lista pending rancia.
fn drain_auto(pending: Vec<MemoryCandidate>, dry: bool) -> Result<Value, String> {
    let total = pending.len();
    let _lock = if dry {
        None
    } else {
        let path = crate::drain_lock::default_path()?;
        match crate::drain_lock::acquire(&path, crate::drain_lock::STALE_AFTER)? {
            Some(guard) => Some(guard),
            None => {
                return Ok(json!({
                    "mode": "auto",
                    "dry_run": false,
                    "skipped": "drain en curso (lock vivo)",
                    "lock": path.display().to_string(),
                    "total": total,
                }));
            }
        }
    };
    let counts = crate::inbox_auto::drain_auto(
        pending,
        dry,
        ul::memory::model::now_millis(),
        &crate::inbox_auto::ServiceSink,
    );
    Ok(counts.to_json(dry, total))
}

/// Contadores del drain clásico.
#[derive(Default)]
struct ClassicCounts {
    approved: u32,
    rejected: u32,
    rejected_dup: u32,
    kept_b: u32,
    kept_unclean: u32,
    failed: u32,
}

/// Banda A: aprobar (en dry-run solo contar).
fn classic_approve(cand: &MemoryCandidate, dry: bool, n: &mut ClassicCounts) {
    if dry {
        n.approved += 1;
        return;
    }
    match MemoryService::approve_candidate(&cand.id, Actor::System) {
        Ok(_) => n.approved += 1,
        // Gate anti-dup en approve (2026-08-10).
        Err(MemoryError::Duplicate(_)) => n.rejected_dup += 1,
        Err(_) => n.failed += 1,
    }
}

/// Banda C: rechazar como ruido (en dry-run solo contar).
fn classic_reject(cand: &MemoryCandidate, dry: bool, n: &mut ClassicCounts) {
    if dry {
        n.rejected += 1;
        return;
    }
    match MemoryService::reject_candidate(
        &cand.id,
        Actor::System,
        Some("inbox drain: banda C (ruido, confidence < 0.55)".into()),
    ) {
        Ok(()) => n.rejected += 1,
        Err(_) => n.failed += 1,
    }
}

/// `drain` sin `--auto`: política de 3 bandas del write-path.
fn drain_classic(pending: Vec<MemoryCandidate>, dry: bool) -> Value {
    let threshold = auto_approve::auto_approve_threshold();
    let total = pending.len();
    let mut n = ClassicCounts::default();
    for cand in pending {
        if !auto_approve::candidate_is_clean(&cand) {
            n.kept_unclean += 1;
            continue;
        }
        match auto_approve::classify_band(&cand, threshold) {
            auto_approve::AutoBand::Approve => classic_approve(&cand, dry, &mut n),
            auto_approve::AutoBand::Reject => classic_reject(&cand, dry, &mut n),
            auto_approve::AutoBand::Pending => n.kept_b += 1,
        }
    }
    json!({
        "dry_run": dry,
        "threshold": threshold,
        "total": total,
        "approved": n.approved,
        "rejected": n.rejected,
        "rejected_duplicate": n.rejected_dup,
        "kept_band_b": n.kept_b,
        "kept_unclean": n.kept_unclean,
        "failed": n.failed,
    })
}

/// Curacion puntual por id (headless): `inbox approve --id X` / `inbox
/// reject --id X [--reason R]`. Reusa los paths canonicos del service
/// (Actor::User = validacion explicita). Acepta prefijo de id (paridad
/// con forget/deprecate): se resuelve a UUID completo o falla si 0/>1.
fn decide_one(sub: &str, args: &[String]) -> Result<Value, String> {
    let id = flag_value(args, "--id")
        .ok_or_else(|| format!("inbox {sub} requiere --id <candidate-id>"))?;
    let id = resolve_candidate_id_prefix(&id)?;
    if sub == "approve" {
        let item = MemoryService::approve_candidate(&id, Actor::User).map_err(|e| e.to_string())?;
        return Ok(json!({ "approved": id, "item_id": item.id }));
    }
    let reason = flag_value(args, "--reason");
    MemoryService::reject_candidate(&id, Actor::User, reason).map_err(|e| e.to_string())?;
    Ok(json!({ "rejected": id }))
}

/// Persist the auto-approve flag (future CLEAN candidates promote on creation).
fn set_auto_approve(args: &[String]) -> Result<Value, String> {
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
    Ok(json!({ "auto_approve": saved.auto_approve }))
}

/// Resolve a candidate-id prefix to an unambiguous full UUID (mirror of the
/// item-side `resolve_id_prefix` in main.rs). Full UUIDs pass through; a
/// prefix needs `MIN_ID_PREFIX_CHARS` characters and exactly one match, so a
/// short prefix can never act on the wrong candidate.
fn resolve_candidate_id_prefix(prefix: &str) -> Result<String, String> {
    let prefix = prefix.trim();
    if prefix.is_empty() {
        return Err("--id must not be empty".to_string());
    }
    let conn = ul::memory::sqlite_store::open_conn().map_err(|e| e.to_string())?;
    let matches = ul::memory::sqlite_store::find_candidate_ids_by_prefix(&conn, prefix)
        .map_err(|e| e.to_string())?;
    ul::memory::sqlite_store::resolve_unique_id(prefix, matches, "candidate")
}
