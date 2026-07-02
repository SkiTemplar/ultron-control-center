// ULTRON Control Center — Memory auto-approve policy (settings + safeguard)
//
// Persists a single user preference — `auto_approve` — that, when ON, promotes a
// freshly created memory candidate straight to an ACTIVE memory, skipping the
// human inbox. This trades the human-in-the-loop gate for convenience, so it is
// guarded by a HARD SECURITY SALVAGUARDA:
//
//   A candidate is auto-approved ONLY when it is "clean":
//     * its `risk_level` is NOT the secret marker ("secret"), AND
//     * it carries NO `contradiction_candidates`, AND
//     * it has NO `duplicate_candidates` (1.2: a duplicate goes to the inbox,
//       never auto-active — that is how 211 identical copies once leaked in).
//
//   Anything secret-bearing or contradicting an active memory ALWAYS stays in the
//   inbox for explicit human adjudication, no matter what the toggle says. This
//   preserves the governance design (write-path Secret-gate H2 + contradiction
//   detector) even with auto-approve enabled.
//
// Persistence follows the existing cockpit-settings pattern (see features.rs):
// a flat JSON file at `~/.ultron/cockpit/memory-settings.json`, atomic write
// (tmp + rename), default-safe reads. FAIL-SAFE: a missing / malformed file —
// or no HOME — reads back as `auto_approve = false` (OFF), so a read error can
// never silently start auto-promoting memories.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::model::MemoryCandidate;

/// Candidate `risk_level` literal set by the write-path when a credential was
/// detected. Mirrors `service::SECRET_RISK_MARKER`; kept here so the safeguard
/// has a single, local source of the literal it gates on.
const SECRET_RISK_MARKER: &str = "secret";

/// Default confidence floor for BAND A (auto-approve). A candidate must reach
/// this confidence AND be clean to be auto-promoted.
///
/// Set to 0.72 — ABOVE the mid-confidence band (inferred decisions land at ~0.70,
/// which must keep falling to BAND B) yet BELOW the real ceiling of the capture
/// write-path. `derive_confidence` (capture.rs) tops out at 0.762 (a
/// router-extracted fact with self-reported `llm_score = 1.0`); the previous 0.85
/// was UNREACHABLE for any conversational capture, so BAND A was dead code — the
/// Stop-hook could never auto-promote even the cleanest, highest-certainty fact
/// (bug 1.1). The narrow [0.72, 0.762] window admits only router-extracted facts
/// whose model self-score is ≥ ~0.86, clean, non-decision, non-architecture.
/// Explicit code-location captures (`capture-symbols.js` emits confidence 0.95)
/// still clear it. Auto-approve stays strictly OPT-IN (default OFF), so this
/// changes nothing until the user enables the toggle. Invariant tested in
/// `capture.rs::factory_threshold_can_auto_approve_top_confidence_capture`.
pub const DEFAULT_AUTO_APPROVE_THRESHOLD: f32 = 0.72;

/// Persisted memory settings. Older files stay readable — serde fills any
/// missing key with its default (so adding fields is backward-compatible).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySettings {
    /// When true, CLEAN candidates that clear `auto_approve_threshold` are
    /// auto-approved on creation (see safeguard + 3-band policy). Default false —
    /// auto-approve is strictly opt-in.
    #[serde(default = "default_false")]
    pub auto_approve: bool,
    /// BAND A confidence floor. A clean candidate with `confidence >= threshold`
    /// is auto-approved; `[reject_threshold, threshold)` (or a decision/architecture
    /// kind) stays pending; below `reject_threshold` is auto-rejected. Defaults to
    /// `DEFAULT_AUTO_APPROVE_THRESHOLD` (0.72) for files written before this field.
    #[serde(default = "default_auto_approve_threshold")]
    pub auto_approve_threshold: f32,
    /// 1.3b (opt-in, default OFF): cuando ON, un candidato que es un state-update
    /// 1:1 CLARO de UN item activo lo AUTO-SUPERSEDE (viejo→deprecated,
    /// nuevo→active) en vez de ir al inbox. Requiere el clasificador 3-way; sin el
    /// flag el comportamiento es idéntico al actual (Quarantine).
    #[serde(default = "default_false")]
    pub auto_supersede: bool,
}

fn default_false() -> bool {
    false
}

fn default_auto_approve_threshold() -> f32 {
    DEFAULT_AUTO_APPROVE_THRESHOLD
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            auto_approve: false,
            auto_approve_threshold: DEFAULT_AUTO_APPROVE_THRESHOLD,
            auto_supersede: false,
        }
    }
}

fn settings_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".ultron/cockpit/memory-settings.json"))
}

/// Read the persisted memory settings. Any failure (no HOME, missing file,
/// malformed JSON) returns the safe default (`auto_approve = false`).
pub fn read_settings() -> MemorySettings {
    let Some(path) = settings_path() else {
        return MemorySettings::default();
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return MemorySettings::default();
    };
    serde_json::from_str::<MemorySettings>(&text).unwrap_or_default()
}

/// Persist the memory settings atomically (tmp + rename). Creates the cockpit
/// directory if absent. Returns the value actually stored on success.
pub fn write_settings(settings: MemorySettings) -> Result<MemorySettings, String> {
    let path = settings_path().ok_or_else(|| "no HOME".to_string())?;
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("mkdir cockpit: {e}"))?;
        }
    }
    let serialized =
        serde_json::to_string_pretty(&settings).map_err(|e| format!("serialize: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &serialized).map_err(|e| format!("write tmp: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(settings)
}

/// Convenience: is auto-approve currently ON? Fail-safe to `false`.
pub fn auto_approve_enabled() -> bool {
    read_settings().auto_approve
}

/// Convenience: is auto-supersede currently ON? Fail-safe to `false` (1.3b).
/// Opt-in, default OFF — sin esto, una contradicción state-update va al inbox.
pub fn auto_supersede_enabled() -> bool {
    read_settings().auto_supersede
}

/// BAND C floor: a clean candidate below this confidence is pure noise and is
/// auto-rejected (status `rejected`, never promoted, purged in background). Fixed
/// constant (not user-tunable) so the noise gate can't be widened by a bad write.
pub const REJECT_THRESHOLD: f32 = 0.55;

/// The three-band decision for a candidate's auto-disposition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoBand {
    /// BAND A: clean + `confidence >= threshold` → promote to active.
    Approve,
    /// BAND B: clean but mid-confidence, OR a decision/architecture kind (always
    /// needs a human eye) → leave pending in the inbox.
    Pending,
    /// BAND C: clean but `confidence < REJECT_THRESHOLD` → auto-reject (noise).
    Reject,
}

/// FAIL-SAFE BAND A floor. Returns the persisted `auto_approve_threshold` when
/// readable; on ANY settings read issue returns `f32::INFINITY`, so nothing can
/// clear BAND A — a settings glitch can never widen auto-approval. (`read_settings`
/// is already default-safe, but a default-filled struct would yield 0.72 here,
/// which is still permissive; an explicit infinity makes the failure mode strict.)
#[must_use]
pub fn auto_approve_threshold() -> f32 {
    let Some(path) = settings_path() else {
        return f32::INFINITY;
    };
    let Ok(text) = fs::read_to_string(&path) else {
        return f32::INFINITY;
    };
    match serde_json::from_str::<MemorySettings>(&text) {
        Ok(s) => s.auto_approve_threshold,
        Err(_) => f32::INFINITY,
    }
}

/// Classify a CLEAN candidate into one of the three auto-disposition bands.
///
/// PRECONDITION: the caller has already confirmed `candidate_is_clean` — secrets
/// and contradictions are handled BEFORE this (they go to quarantine/inbox and
/// must never reach band classification). This function decides only the
/// confidence-driven disposition for clean candidates:
///
///   * BAND A (`Approve`): `confidence >= threshold`.
///   * BAND B (`Pending`): `REJECT_THRESHOLD <= confidence < threshold`.
///   * BAND C (`Reject`): `confidence < REJECT_THRESHOLD` (noise).
///
/// Feedback del usuario 2026-07-02: `decision`/`architecture` ya NO fuerzan Pending —
/// entran por confianza como el resto (el sistema decide solo; cero fricción).
/// La salvaguarda dura sigue intacta: secreto/contradicción/duplicado/unverified
/// NUNCA llegan aquí (no son clean), sea cual sea el tipo.
///
/// Pure (no I/O): the caller passes the fail-safe `threshold`, so this is unit
/// tested without the settings file.
#[must_use]
pub fn classify_band(candidate: &MemoryCandidate, threshold: f32) -> AutoBand {
    if candidate.confidence < REJECT_THRESHOLD {
        AutoBand::Reject
    } else if candidate.confidence >= threshold {
        AutoBand::Approve
    } else {
        AutoBand::Pending
    }
}

/// Tags que marcan que una verificación del write-path NO pudo completarse: el
/// juez de contradicción expiró / su conn falló (`unjudged`), o la búsqueda de
/// duplicados devolvió Err (`dedup-unverified`). FAIL-CLOSED: un candidato así NO
/// es "clean" — sin verdicto verificado espera ojo humano en el inbox, nunca
/// auto-active. (Antes el write-path fallaba OPEN: timeout/Err => sin marca =>
/// `clean` => se auto-aprobaba sin haber comprobado contradicción ni duplicado.)
pub const UNVERIFIED_TAGS: [&str; 2] = ["unjudged", "dedup-unverified"];

/// SECURITY SALVAGUARDA. A candidate is eligible for auto-approval ONLY when it
/// is "clean": no secret marker, no contradiction findings, NO duplicate, and no
/// INCOMPLETE-VERIFICATION marker (see `UNVERIFIED_TAGS`). Secret-bearing,
/// contradicting, DUPLICATE or UNVERIFIED candidates ALWAYS require human review —
/// this returns `false` for them regardless of the `auto_approve` setting. Pure
/// (no I/O) so it is unit-tested without the DB.
#[must_use]
pub fn candidate_is_clean(candidate: &MemoryCandidate) -> bool {
    let is_secret = candidate
        .risk_level
        .eq_ignore_ascii_case(SECRET_RISK_MARKER);
    let has_contradiction = !candidate.contradiction_candidates.is_empty();
    // 1.2: un candidato con duplicados NO es "clean" -> nunca auto-aprobar ni
    // approve-clean un duplicado (asi se acumularon 101 grupos content_hash
    // identicos, uno con 211 copias activas que sesgaban el recall). Va al inbox.
    let has_duplicate = !candidate.duplicate_candidates.is_empty();
    // 1.7 fail-closed: una verificación incompleta (juez timeout / dedup Err) NO
    // puede auto-aprobarse — el candidato espera adjudicación humana en el inbox.
    let has_unverified = candidate
        .proposed_tags
        .iter()
        .any(|t| UNVERIFIED_TAGS.iter().any(|u| t.eq_ignore_ascii_case(u)));
    !is_secret && !has_contradiction && !has_duplicate && !has_unverified
}

#[cfg(test)]
mod tests {
    use super::super::model::{MemoryType, Scope};
    use super::*;

    fn clean_candidate() -> MemoryCandidate {
        // `MemoryCandidate::new` defaults risk_level="low" and no contradictions.
        MemoryCandidate::new(MemoryType::Fact, Scope::Project)
    }

    #[test]
    fn candidate_with_duplicate_is_not_clean() {
        // 1.2: un duplicado NO debe auto-aprobarse ni colarse por approve-clean
        // (asi se acumularon las 211 copias activas que sesgaban el recall).
        let mut c = clean_candidate();
        assert!(candidate_is_clean(&c), "baseline limpio");
        c.duplicate_candidates
            .push("existing-active-id".to_string());
        assert!(
            !candidate_is_clean(&c),
            "un candidato con duplicado_candidates NO es clean"
        );
    }

    #[test]
    fn unjudged_candidate_is_not_clean() {
        // 1.7 fail-closed: si el juez de contradicción no pudo emitir verdicto
        // (timeout / conn falló), el candidato lleva "unjudged" y NO debe
        // auto-aprobarse — espera ojo humano en el inbox (antes fail-OPEN: una
        // Fact que contradice un ACTIVE se colaba a active sin verificar).
        let mut c = clean_candidate();
        assert!(candidate_is_clean(&c), "baseline limpio");
        c.proposed_tags.push("unjudged".to_string());
        assert!(
            !candidate_is_clean(&c),
            "un candidato sin verdicto de contradicción NO es clean"
        );
    }

    #[test]
    fn dedup_unverified_candidate_is_not_clean() {
        // 1.7 fail-closed: si la búsqueda de duplicados falló (Err de FTS5/SQLite),
        // el candidato lleva "dedup-unverified" y NO debe auto-aprobarse — así un
        // fallo transitorio no puede regresar el bug 1.2 (las 211 copias).
        let mut c = clean_candidate();
        c.proposed_tags.push("dedup-unverified".to_string());
        assert!(!candidate_is_clean(&c));
        // Case-insensitive: un marcador en mayúsculas también bloquea.
        let mut c2 = clean_candidate();
        c2.proposed_tags.push("UNJUDGED".to_string());
        assert!(!candidate_is_clean(&c2));
    }

    #[test]
    fn default_settings_are_off() {
        assert!(!MemorySettings::default().auto_approve);
    }

    #[test]
    fn clean_candidate_is_eligible() {
        assert!(candidate_is_clean(&clean_candidate()));
    }

    #[test]
    fn secret_candidate_is_never_eligible() {
        let mut c = clean_candidate();
        c.risk_level = SECRET_RISK_MARKER.to_string();
        assert!(
            !candidate_is_clean(&c),
            "a secret-marked candidate must always require human review"
        );
        // Case-insensitive: an upper/mixed-case marker must still be blocked.
        c.risk_level = "Secret".to_string();
        assert!(!candidate_is_clean(&c));
    }

    #[test]
    fn contradicting_candidate_is_never_eligible() {
        let mut c = clean_candidate();
        c.contradiction_candidates = vec!["item-123".to_string()];
        assert!(
            !candidate_is_clean(&c),
            "a contradicting candidate must always require human review"
        );
    }

    #[test]
    fn default_threshold_is_band_a_floor() {
        assert_eq!(
            MemorySettings::default().auto_approve_threshold,
            DEFAULT_AUTO_APPROVE_THRESHOLD
        );
    }

    #[test]
    fn high_confidence_fact_lands_in_band_a() {
        let mut c = clean_candidate();
        c.confidence = 0.95;
        assert_eq!(
            classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
            AutoBand::Approve
        );
    }

    #[test]
    fn mid_confidence_lands_in_band_b() {
        let mut c = clean_candidate();
        c.confidence = 0.70;
        assert_eq!(
            classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
            AutoBand::Pending
        );
    }

    #[test]
    fn low_confidence_lands_in_band_c() {
        let mut c = clean_candidate();
        c.confidence = 0.40;
        assert_eq!(
            classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
            AutoBand::Reject
        );
    }

    #[test]
    fn high_confidence_decision_lands_in_band_a() {
        // Feedback del usuario 2026-07-02: las decisiones entran solas por confianza
        // (antes forzaban Pending a cualquier confianza = fricción permanente).
        let mut c = MemoryCandidate::new(MemoryType::Decision, Scope::Project);
        c.confidence = 0.99;
        assert_eq!(
            classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
            AutoBand::Approve
        );
    }

    #[test]
    fn mid_confidence_decision_still_pending() {
        // Caso negativo: la confianza sigue mandando — una decisión de confianza
        // media NO se auto-aprueba (banda B, la reviso en sesión).
        let mut c = MemoryCandidate::new(MemoryType::Architecture, Scope::Project);
        c.confidence = 0.65;
        assert_eq!(
            classify_band(&c, DEFAULT_AUTO_APPROVE_THRESHOLD),
            AutoBand::Pending
        );
    }

    #[test]
    fn infinite_threshold_keeps_everything_out_of_band_a() {
        // FAIL-SAFE: a settings read error yields f32::INFINITY, so even a 0.99
        // fact cannot clear BAND A — it degrades to pending, never auto-approve.
        let mut c = clean_candidate();
        c.confidence = 0.99;
        assert_eq!(classify_band(&c, f32::INFINITY), AutoBand::Pending);
    }
}
