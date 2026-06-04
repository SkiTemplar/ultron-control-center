// ULTRON Control Center — Memory auto-approve policy (settings + safeguard)
//
// Persists a single user preference — `auto_approve` — that, when ON, promotes a
// freshly created memory candidate straight to an ACTIVE memory, skipping the
// human inbox. This trades the human-in-the-loop gate for convenience, so it is
// guarded by a HARD SECURITY SALVAGUARDA:
//
//   A candidate is auto-approved ONLY when it is "clean":
//     * its `risk_level` is NOT the secret marker ("secret"), AND
//     * it carries NO `contradiction_candidates`.
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

/// Persisted memory settings. One flag today; the struct leaves room for more
/// without breaking older files (serde fills missing keys with the default).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySettings {
    /// When true, CLEAN candidates are auto-approved on creation (see safeguard).
    /// Default false — auto-approve is strictly opt-in.
    #[serde(default = "default_false")]
    pub auto_approve: bool,
}

fn default_false() -> bool {
    false
}

impl Default for MemorySettings {
    fn default() -> Self {
        Self {
            auto_approve: false,
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

/// SECURITY SALVAGUARDA. A candidate is eligible for auto-approval ONLY when it
/// is "clean": no secret marker and no contradiction findings. Secret-bearing or
/// contradicting candidates ALWAYS require human review — this function returns
/// `false` for them regardless of the `auto_approve` setting. Pure (no I/O) so it
/// is unit-tested without the DB or the settings file.
#[must_use]
pub fn candidate_is_clean(candidate: &MemoryCandidate) -> bool {
    let is_secret = candidate.risk_level.eq_ignore_ascii_case(SECRET_RISK_MARKER);
    let has_contradiction = !candidate.contradiction_candidates.is_empty();
    !is_secret && !has_contradiction
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
}
