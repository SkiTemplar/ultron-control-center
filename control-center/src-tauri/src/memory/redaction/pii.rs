//! PII detection and redaction (READ-PATH + write-path defence-in-depth).
//!
//! Detects and redacts personal data that is NOT a credential:
//!   - Email addresses  → `[REDACTED_EMAIL]`
//!   - Phone numbers    → `[REDACTED_PHONE]`
//!   - User-path strings (`C:\Users\<name>\...` or `/Users/<name>/...`) → `[REDACTED_PATH]`
//!
//! Design mirrors the credential detector in `secrets.rs`: dependency-free byte
//! scan, low false-positive bias, returns ordered non-overlapping spans.

use super::secrets::detect_secrets;
use crate::memory::model::Sensitivity;

/// Class of PII detected in free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiiKind {
    Email,
    Phone,
    UserPath,
}

impl PiiKind {
    /// Stable placeholder used in redacted text.
    #[must_use]
    pub fn placeholder(self) -> &'static str {
        match self {
            Self::Email => "[REDACTED_EMAIL]",
            Self::Phone => "[REDACTED_PHONE]",
            Self::UserPath => "[REDACTED_PATH]",
        }
    }
}

/// A detected PII occurrence: kind and byte span `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PiiHit {
    pub kind: PiiKind,
    pub start: usize,
    pub end: usize,
}

/// Detect PII spans in `text`. Returns ordered, non-overlapping hits.
///
/// Patterns (all dependency-free):
/// - **Email**: `word@word.tld` — at-sign with non-whitespace on both sides,
///   right side must contain a dot. Matches the outermost non-whitespace run.
/// - **Phone**: a run of digits (0-9), spaces and `+`/`-`/`()`/`.` of ≥ 7
///   digits total, anchored at a word boundary (no preceding letter/digit).
/// - **User path**: a substring starting with `C:\Users\` (case-insensitive) or
///   `/Users/` followed by at least one non-whitespace character.
#[must_use]
pub fn detect_pii(text: &str) -> Vec<PiiHit> {
    let mut hits: Vec<PiiHit> = Vec::new();
    let bytes = text.as_bytes();
    let len = bytes.len();

    let overlaps = |start: usize, end: usize, existing: &[PiiHit]| {
        existing.iter().any(|h| start < h.end && end > h.start)
    };

    // --- Pass 1: User paths (longest-match first so they don't get split) ---
    // Windows: C:\Users\<name>  (case-insensitive prefix)
    // Unix:    /Users/<name>/   (case-sensitive)
    let text_lower = text.to_ascii_lowercase();
    let mut search_from = 0usize;
    while search_from < len {
        let remaining = &text_lower[search_from..];
        let offset = if let Some(p) = remaining
            .find("c:\\users\\")
            .or_else(|| remaining.find("c:/users/"))
        {
            p
        } else if let Some(p) = remaining.find("/users/") {
            p
        } else {
            break;
        };
        let start = search_from + offset;
        // Extend to next whitespace (or end) for the full path token.
        let end = text[start..]
            .bytes()
            .position(|b| b.is_ascii_whitespace())
            .map(|p| start + p)
            .unwrap_or(len);
        // Only emit if the path has at least a separator char after the prefix.
        let prefix_end = start
            + text_lower[start..]
                .find(['/', '\\'])
                .map(|p| {
                    // advance past the separator in "Users/<name>"
                    let after = start + p + 1;
                    text[after..]
                        .bytes()
                        .position(|b| b.is_ascii_whitespace() || b == b'/' || b == b'\\')
                        .map(|q| p + 1 + q)
                        .unwrap_or(text_lower.len() - start)
                })
                .unwrap_or(0);
        let _ = prefix_end; // used only for minimum-length guard below
        if end > start + 8 && !overlaps(start, end, &hits) {
            hits.push(PiiHit {
                kind: PiiKind::UserPath,
                start,
                end,
            });
        }
        search_from = if end > start { end } else { start + 1 };
    }

    // --- Pass 2: Emails ---
    // Walk whitespace-delimited tokens; classify by presence of '@' with
    // non-trivial left and right sides, right side must contain a dot.
    let mut i = 0usize;
    while i < len {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let word_start = i;
        while i < len && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let word_end = i;
        let word = &text[word_start..word_end];

        if overlaps(word_start, word_end, &hits) {
            continue;
        }

        if let Some(at) = word.find('@') {
            let local = &word[..at];
            let domain = &word[at + 1..];
            // Require non-empty local, domain with a dot, and domain not starting
            // with a dot (guard against decorative "@" usage).
            if !local.is_empty()
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && domain.len() >= 3
            {
                // Strip trailing punctuation (comma, period, closing paren/bracket).
                let trail = word_end
                    - word
                        .chars()
                        .rev()
                        .take_while(|c| matches!(c, ',' | '.' | ')' | ']' | '"' | '\''))
                        .count();
                let end = trail.max(word_start + at + 2); // at minimum include "@x"
                hits.push(PiiHit {
                    kind: PiiKind::Email,
                    start: word_start,
                    end,
                });
            }
        }
    }

    // --- Pass 3: Phone numbers ---
    // Scan for runs that contain ≥ 7 digits interspersed with allowed separator
    // chars (+, -, space, (, ), .) and are bounded by non-digit/non-alpha chars.
    let mut j = 0usize;
    while j < len {
        // Skip if already covered or if we're in the middle of an alphanumeric word.
        if j > 0 && (bytes[j - 1].is_ascii_alphanumeric()) {
            j += 1;
            continue;
        }
        if bytes[j].is_ascii_alphabetic() {
            // Skip alpha tokens (avoid matching inside words like "123abc").
            while j < len && !bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            continue;
        }
        // Attempt to greedily consume a phone-like run starting here.
        let run_start = j;
        let mut digit_count = 0usize;
        let mut k = j;
        while k < len {
            let b = bytes[k];
            if b.is_ascii_digit() {
                digit_count += 1;
                k += 1;
            } else if matches!(b, b'+' | b'-' | b'(' | b')' | b'.') && k == j
                || matches!(b, b' ' | b'-' | b'.' | b'(' | b')')
                    && k > j
                    && k + 1 < len
                    && bytes[k + 1].is_ascii_digit()
            {
                k += 1;
            } else {
                break;
            }
        }
        if digit_count >= 7 && k > run_start {
            // Strip any trailing separators to avoid matching e.g. "123-456-789-"
            let mut end = k;
            while end > run_start && !bytes[end - 1].is_ascii_digit() {
                end -= 1;
            }
            if end > run_start && !overlaps(run_start, end, &hits) {
                hits.push(PiiHit {
                    kind: PiiKind::Phone,
                    start: run_start,
                    end,
                });
            }
            j = end;
        } else {
            j += 1;
        }
    }

    hits.sort_by_key(|h| h.start);
    // Resolve overlaps (earlier hit wins; later hit that overlaps is dropped).
    let mut resolved: Vec<PiiHit> = Vec::with_capacity(hits.len());
    for h in hits {
        if resolved
            .last()
            .is_none_or(|last: &PiiHit| h.start >= last.end)
        {
            resolved.push(h);
        }
    }
    resolved
}

/// Return a copy of `text` with every detected PII replaced by its placeholder.
#[must_use]
pub fn redact_pii(text: &str) -> String {
    let hits = detect_pii(text);
    if hits.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len() + hits.len() * 8);
    let mut cursor = 0usize;
    for h in &hits {
        if h.start < cursor {
            continue;
        }
        out.push_str(&text[cursor..h.start]);
        out.push_str(h.kind.placeholder());
        cursor = h.end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// True if `text` contains any PII (email, phone, or user path).
#[must_use]
pub fn contains_pii(text: &str) -> bool {
    !detect_pii(text).is_empty()
}

/// Redact PII in an optional field in place. Returns `true` if PII was found.
/// Used in the READ-PATH (assemble_pack) so PII never reaches prompt context
/// even if it was stored before this guard existed.
pub fn redact_pii_in_place(field: &mut Option<String>) -> bool {
    if let Some(text) = field {
        if contains_pii(text) {
            *text = redact_pii(text);
            return true;
        }
    }
    false
}

/// Write-path classifier that elevates PII (email/phone/user-path) to
/// [`Sensitivity::Secret`] so the sensitivity gate in `assemble_pack`
/// (`sensitivity != Secret`) excludes future items containing raw PII.
///
/// Extends [`super::classify_sensitivity`] (credential-only) to also catch PII.
/// Never downgrades — if the caller already has a higher classification,
/// that higher value is preserved by the caller.
#[must_use]
pub fn classify_sensitivity_with_pii(text: &str) -> Sensitivity {
    if !detect_secrets(text).is_empty() || contains_pii(text) {
        Sensitivity::Secret
    } else {
        Sensitivity::Internal
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_email_synthetic() {
        let t = "contacta a test@example.com para detalles";
        let hits = detect_pii(t);
        assert_eq!(hits.len(), 1, "should detect exactly one email");
        assert_eq!(hits[0].kind, PiiKind::Email);
        let redacted = redact_pii(t);
        assert!(
            redacted.contains("[REDACTED_EMAIL]"),
            "email must be replaced"
        );
        assert!(
            !redacted.contains("test@example.com"),
            "raw email must be absent"
        );
    }

    #[test]
    fn detects_phone_with_plus_prefix() {
        let t = "llama al +34 698 123 456 hoy";
        let hits = detect_pii(t);
        assert!(
            hits.iter().any(|h| h.kind == PiiKind::Phone),
            "should detect phone"
        );
        let redacted = redact_pii(t);
        assert!(
            redacted.contains("[REDACTED_PHONE]"),
            "phone must be replaced"
        );
    }

    #[test]
    fn detects_windows_user_path() {
        let t = "archivo en C:/Users/TestUser/secreto.txt es privado";
        let hits = detect_pii(t);
        assert!(
            hits.iter().any(|h| h.kind == PiiKind::UserPath),
            "should detect Windows user path"
        );
        let redacted = redact_pii(t);
        assert!(
            redacted.contains("[REDACTED_PATH]"),
            "path must be replaced"
        );
        assert!(!redacted.contains("TestUser"), "username must be absent");
    }

    #[test]
    fn detects_unix_user_path() {
        let t = "config at /Users/someuser/config.json";
        let hits = detect_pii(t);
        assert!(
            hits.iter().any(|h| h.kind == PiiKind::UserPath),
            "should detect Unix user path"
        );
        let redacted = redact_pii(t);
        assert!(
            redacted.contains("[REDACTED_PATH]"),
            "unix path must be replaced"
        );
    }

    #[test]
    fn detects_multiple_pii_kinds() {
        let t =
            "contacto john.doe@example.com tel +34 698 123 456 ruta C:/Users/TestUser/secret.txt";
        let hits = detect_pii(t);
        let kinds: Vec<PiiKind> = hits.iter().map(|h| h.kind).collect();
        assert!(kinds.contains(&PiiKind::Email), "email expected");
        assert!(kinds.contains(&PiiKind::Phone), "phone expected");
        assert!(kinds.contains(&PiiKind::UserPath), "path expected");
    }

    #[test]
    fn negative_case_clean_text_has_no_pii() {
        let t = "El sistema ULTRON usa FTS5 + Qdrant para recall hibrido.";
        assert!(
            !contains_pii(t),
            "clean technical text must not trigger PII detector"
        );
        assert_eq!(redact_pii(t), t, "clean text must be returned unchanged");
    }

    #[test]
    fn redact_pii_in_place_redacts_and_reports() {
        let mut field = Some("enviar a user@example.com la info".to_string());
        assert!(redact_pii_in_place(&mut field));
        let text = field.unwrap();
        assert!(text.contains("[REDACTED_EMAIL]"));
        assert!(!text.contains("user@example.com"));
    }

    #[test]
    fn redact_pii_in_place_leaves_clean_and_none_untouched() {
        let mut clean = Some("nota sin PII".to_string());
        assert!(!redact_pii_in_place(&mut clean));
        assert_eq!(clean.as_deref(), Some("nota sin PII"));
        let mut none: Option<String> = None;
        assert!(!redact_pii_in_place(&mut none));
    }

    #[test]
    fn classify_sensitivity_with_pii_elevates_email_to_secret() {
        use crate::memory::model::Sensitivity;
        assert_eq!(
            classify_sensitivity_with_pii("contacto admin@example.com para datos"),
            Sensitivity::Secret,
        );
    }

    #[test]
    fn classify_sensitivity_with_pii_clean_stays_internal() {
        use crate::memory::model::Sensitivity;
        assert_eq!(
            classify_sensitivity_with_pii("arquitectura de memoria ULTRON brain.db"),
            Sensitivity::Internal,
        );
    }
}
