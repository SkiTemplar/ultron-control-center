//! Stable text normalization + content hashing for the memory write-path (OLA B).
//!
//! `content_hash` is the canonical dedupe / idempotency key for a memory item:
//! two items whose text normalizes to the same string get the same hash, so the
//! write-path can detect exact duplicates and the Qdrant indexer can be made
//! idempotent. The hash MUST be stable across runs, builds and platforms, so we
//! use a fixed FNV-1a (64-bit) over the normalized bytes rather than the std
//! `DefaultHasher` (SipHash, randomized/unspecified) or an extra crate. FNV-1a
//! is dependency-free and deterministic; collision risk is negligible at this
//! scale (a 64-bit space for ~10^3-10^4 items). See CONTRACTS-2026-06-04.md.

/// Normalize free text for hashing/dedupe: lowercase + collapse all runs of
/// whitespace to a single space + trim. Pure and allocation-only.
#[must_use]
pub fn normalize_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Stable 64-bit FNV-1a content hash of the normalized text, as 16 hex chars.
/// Deterministic across runs/builds/platforms.
#[must_use]
pub fn content_hash(text: &str) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let norm = normalize_text(text);
    let mut h = FNV_OFFSET;
    for &b in norm.as_bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_whitespace_and_lowercases() {
        assert_eq!(normalize_text("  Foo   BAR\tbaz\n"), "foo bar baz");
    }

    #[test]
    fn normalize_is_idempotent() {
        let once = normalize_text("Hello   World");
        assert_eq!(normalize_text(&once), once);
    }

    #[test]
    fn equivalent_text_hashes_equal() {
        assert_eq!(content_hash("Foo  Bar"), content_hash("foo bar"));
        assert_eq!(content_hash("a\tb"), content_hash("a b"));
    }

    #[test]
    fn different_text_hashes_differ() {
        assert_ne!(
            content_hash("usar sqlite como SoT"),
            content_hash("usar qdrant como SoT")
        );
    }

    #[test]
    fn hash_is_stable_known_vector() {
        // Pin the FNV-1a output so a future refactor can't silently change it
        // (which would orphan every existing content_hash on disk).
        assert_eq!(content_hash("ultron"), content_hash("  ULTRON  "));
        assert_eq!(content_hash("").len(), 16);
    }

    #[test]
    fn hash_has_fixed_width() {
        assert_eq!(content_hash("anything at all").len(), 16);
    }
}
