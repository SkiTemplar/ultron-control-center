//! Write-path secret/PII detection and redaction (OLA A).
//!
//! Canonical guard meant to run BEFORE persisting text to SQLite and BEFORE
//! generating embeddings, so a leaked credential never reaches `brain.db`,
//! Qdrant, logs or backups. It is the authoritative detector for the memory
//! write-path, covering well-known credential shapes, header values, and
//! vendor-token prefixes (including the legacy `m0-` prefix).
//!
//! STATUS (2026-06-06): wired into the single-writer critical path. The
//! detector runs inside `MemoryService::create_candidate` (see
//! `service.rs`: `redact_in_place` over title/summary/content/json + tags,
//! and `classify_sensitivity` to mark the promoted item `Secret`), so no
//! detected credential reaches `brain.db`, Qdrant, logs or backups.
//!
//! Split into two cohesive submodules (cat7.3):
//!   - `secrets`: credential detection/redaction (write-path).
//!   - `pii`:     email/phone/user-path detection (read-path + defence-in-depth).
//! The full public API is re-exported here so callers keep using
//! `memory::redaction::<item>` unchanged.

mod pii;
mod secrets;

pub use pii::{
    classify_sensitivity_with_pii, contains_pii, detect_pii, redact_pii, redact_pii_in_place,
    PiiHit, PiiKind,
};
pub use secrets::{
    classify_sensitivity, contains_secret, detect_secrets, redact, redact_in_place, SecretHit,
    SecretKind,
};
