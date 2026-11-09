//! Bucle FULL-AUTO de `inbox drain --auto`: decide cada candidato pendiente
//! con `auto_approve::auto_disposition_at` y aplica la decisión a través de
//! `DrainSink`. Las escrituras quedan detrás del trait para poder probar el
//! bucle (dry-run incluido) sin `brain.db`.

use control_center_lib as ul;
use ul::memory::auto_approve::{self, AutoDisposition, RejectKind};
use ul::memory::{Actor, CandidateStatus, MemoryCandidate, MemoryError, MemoryService};

/// Efectos de escritura del drain full-auto.
pub(crate) trait DrainSink {
    /// Re-corre las verificaciones incompletas (persiste hallazgos).
    fn reverify(&self, candidate: &MemoryCandidate) -> Result<MemoryCandidate, MemoryError>;
    fn approve(&self, id: &str) -> Result<(), MemoryError>;
    fn reject(&self, id: &str, reason: String) -> Result<(), MemoryError>;
}

/// Implementación real: el `MemoryService` (escritor único) con `Actor::System`.
pub(crate) struct ServiceSink;

impl DrainSink for ServiceSink {
    fn reverify(&self, candidate: &MemoryCandidate) -> Result<MemoryCandidate, MemoryError> {
        MemoryService::reverify_candidate(candidate)
    }

    fn approve(&self, id: &str) -> Result<(), MemoryError> {
        MemoryService::approve_candidate(id, Actor::System).map(|_| ())
    }

    fn reject(&self, id: &str, reason: String) -> Result<(), MemoryError> {
        MemoryService::reject_candidate(id, Actor::System, Some(reason))
    }
}

/// Contadores del JSON de salida de `drain --auto`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct AutoDrainCounts {
    pub approved: u32,
    pub superseded: u32,
    pub rejected_secret: u32,
    pub rejected_duplicate: u32,
    pub rejected_contradiction: u32,
    pub rejected_noise: u32,
    pub expired_non_user_origin: u32,
    pub kept_unverified: u32,
    pub kept_non_user_origin: u32,
    pub already_decided: u32,
    pub failed: u32,
}

impl AutoDrainCounts {
    pub(crate) fn to_json(&self, dry: bool, total: usize) -> serde_json::Value {
        serde_json::json!({
            "mode": "auto",
            "dry_run": dry,
            "total": total,
            "approved": self.approved,
            "superseded": self.superseded,
            "rejected_secret": self.rejected_secret,
            "rejected_duplicate": self.rejected_duplicate,
            "rejected_contradiction": self.rejected_contradiction,
            "rejected_noise": self.rejected_noise,
            "expired_non_user_origin": self.expired_non_user_origin,
            "kept_unverified": self.kept_unverified,
            "kept_non_user_origin": self.kept_non_user_origin,
            "already_decided": self.already_decided,
            "failed": self.failed,
        })
    }

    fn reject_counter(&mut self, kind: RejectKind) -> &mut u32 {
        match kind {
            RejectKind::Secret => &mut self.rejected_secret,
            RejectKind::Duplicate => &mut self.rejected_duplicate,
            RejectKind::Contradiction => &mut self.rejected_contradiction,
            RejectKind::Noise => &mut self.rejected_noise,
            RejectKind::ExpiredNonUserOrigin => &mut self.expired_non_user_origin,
        }
    }
}

/// Motivo auditable que se guarda en la fila del candidato rechazado.
fn reject_reason(kind: RejectKind, candidate: &MemoryCandidate) -> String {
    match kind {
        RejectKind::Secret => "drain --auto: secret/PII — nunca a active".into(),
        RejectKind::Duplicate => format!(
            "drain --auto: near-dup de {} (el ACTIVE se conserva)",
            candidate.duplicate_candidates.join(", ")
        ),
        RejectKind::Contradiction => format!(
            "drain --auto: contradice {} — gana el ACTIVE",
            candidate.contradiction_candidates.join(", ")
        ),
        RejectKind::Noise => format!(
            "drain --auto: banda C (ruido, confidence < {})",
            auto_approve::REJECT_THRESHOLD
        ),
        RejectKind::ExpiredNonUserOrigin => format!(
            "drain --auto: caducada sin validar (origen no humano, >= {} días pending)",
            auto_approve::NON_USER_ORIGIN_TTL_DAYS
        ),
    }
}

/// Drena `pending` en modo full-auto. En `dry` solo cuenta: no re-verifica
/// (la re-verificación persiste hallazgos) ni llama a `approve`/`reject`.
pub(crate) fn drain_auto(
    pending: Vec<MemoryCandidate>,
    dry: bool,
    now_ms: i64,
    sink: &dyn DrainSink,
) -> AutoDrainCounts {
    let mut counts = AutoDrainCounts::default();
    for cand in pending {
        drain_one(cand, dry, now_ms, sink, &mut counts);
    }
    counts
}

fn drain_one(
    cand: MemoryCandidate,
    dry: bool,
    now_ms: i64,
    sink: &dyn DrainSink,
    counts: &mut AutoDrainCounts,
) {
    let cand = if !dry && auto_approve::candidate_is_unverified(&cand) {
        sink.reverify(&cand).unwrap_or(cand)
    } else {
        cand
    };
    if cand.status == CandidateStatus::Approved {
        counts.superseded += 1; // auto-supersede ejecutado en reverify
        return;
    }
    match auto_approve::auto_disposition_at(&cand, now_ms) {
        AutoDisposition::Approve => {
            if dry {
                counts.approved += 1;
                return;
            }
            match sink.approve(&cand.id) {
                Ok(()) => counts.approved += 1,
                // Gate anti-dup en approve: cuenta como dup, no fallo.
                Err(MemoryError::Duplicate(_)) => counts.rejected_duplicate += 1,
                // Otro proceso lo decidió antes: no-op, no fallo.
                Err(MemoryError::AlreadyDecided(_)) => counts.already_decided += 1,
                Err(_) => counts.failed += 1,
            }
        }
        AutoDisposition::KeepUnverified => counts.kept_unverified += 1,
        AutoDisposition::KeepNonUserOrigin => counts.kept_non_user_origin += 1,
        AutoDisposition::Reject(kind) => {
            if dry {
                *counts.reject_counter(kind) += 1;
                return;
            }
            match sink.reject(&cand.id, reject_reason(kind, &cand)) {
                Ok(()) => *counts.reject_counter(kind) += 1,
                Err(MemoryError::AlreadyDecided(_)) => counts.already_decided += 1,
                Err(_) => counts.failed += 1,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use ul::memory::{MemoryType, Scope};

    const MILLIS_PER_DAY: i64 = 24 * 60 * 60 * 1000;
    const FIXED_NOW_MS: i64 = 1_800_000_000_000;

    /// Sink que registra cada escritura en vez de tocar `brain.db`.
    #[derive(Default)]
    struct RecordingSink {
        approved: RefCell<Vec<String>>,
        rejected: RefCell<Vec<(String, String)>>,
        reverified: RefCell<u32>,
    }

    impl RecordingSink {
        fn writes(&self) -> usize {
            self.approved.borrow().len()
                + self.rejected.borrow().len()
                + *self.reverified.borrow() as usize
        }
    }

    impl DrainSink for RecordingSink {
        fn reverify(&self, c: &MemoryCandidate) -> Result<MemoryCandidate, MemoryError> {
            *self.reverified.borrow_mut() += 1;
            Ok(c.clone())
        }

        fn approve(&self, id: &str) -> Result<(), MemoryError> {
            self.approved.borrow_mut().push(id.to_string());
            Ok(())
        }

        fn reject(&self, id: &str, reason: String) -> Result<(), MemoryError> {
            self.rejected.borrow_mut().push((id.to_string(), reason));
            Ok(())
        }
    }

    /// Captura de sesión `origin:unknown` (KeepNonUserOrigin) de `days` días.
    fn non_user_capture(days: i64) -> MemoryCandidate {
        let mut c = MemoryCandidate::new(MemoryType::Fact, Scope::Project);
        c.confidence = 0.9;
        c.capture_source = Some("stop_capture".to_string());
        c.proposed_tags.push("origin:unknown".to_string());
        c.created_at = FIXED_NOW_MS - days * MILLIS_PER_DAY;
        c
    }

    #[test]
    fn expired_non_user_capture_is_rejected_with_own_reason() {
        let sink = RecordingSink::default();
        let c = non_user_capture(8);
        let id = c.id.clone();
        let counts = drain_auto(vec![c], false, FIXED_NOW_MS, &sink);
        assert_eq!(counts.expired_non_user_origin, 1);
        assert_eq!(counts.kept_non_user_origin, 0);
        assert_eq!(counts.rejected_noise, 0);
        let rejected = sink.rejected.borrow();
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].0, id);
        assert!(
            rejected[0].1.contains("caducada sin validar"),
            "motivo propio: {}",
            rejected[0].1
        );
    }

    #[test]
    fn recent_non_user_capture_stays_pending() {
        // Caso negativo: con 6 días no se escribe nada y se cuenta como kept.
        let sink = RecordingSink::default();
        let counts = drain_auto(vec![non_user_capture(6)], false, FIXED_NOW_MS, &sink);
        assert_eq!(counts.kept_non_user_origin, 1);
        assert_eq!(counts.expired_non_user_origin, 0);
        assert_eq!(sink.writes(), 0);
    }

    #[test]
    fn dry_run_counts_expired_without_writing() {
        let sink = RecordingSink::default();
        let mut unverified = non_user_capture(1);
        unverified.proposed_tags.push("unjudged".to_string());
        let pending = vec![non_user_capture(8), non_user_capture(6), unverified];
        let counts = drain_auto(pending, true, FIXED_NOW_MS, &sink);
        assert_eq!(counts.expired_non_user_origin, 1);
        assert_eq!(counts.kept_non_user_origin, 1);
        assert_eq!(counts.kept_unverified, 1);
        assert_eq!(sink.writes(), 0, "dry-run no debe escribir ni re-verificar");
        let json = counts.to_json(true, 3);
        assert_eq!(json["expired_non_user_origin"], 1);
        assert_eq!(json["dry_run"], true);
    }
}
