//! Write-path secret/PII detection and redaction (OLA A).
//!
//! Canonical guard meant to run BEFORE persisting text to SQLite and BEFORE
//! generating embeddings, so a leaked credential never reaches `brain.db`,
//! Qdrant, logs or backups. It consolidates and broadens the narrow
//! `crate::mem0::redact` (which only scrubbed Mem0 `m0-` tokens and bare
//! `Token ` headers) into a reusable detector for the memory write-path.
//!
//! STATUS (2026-06-06): wired into the single-writer critical path. The
//! detector runs inside `MemoryService::create_candidate` (see
//! `service.rs`: `redact_in_place` over title/summary/content/json + tags,
//! and `classify_sensitivity` to mark the promoted item `Secret`), so no
//! detected credential reaches `brain.db`, Qdrant, logs or backups.
//!
//! Detection is dependency-free (no `regex`): it walks whitespace-delimited
//! words and recognises well-known credential shapes by prefix, plus
//! `key=value` assignments, `Bearer`/`Token` headers and PEM private-key blocks.
//! It errs toward NOT flagging ambiguous text (low false-positive bias): a
//! recognised prefix must be followed by a sufficiently long token tail.

use super::model::Sensitivity;

/// Class of secret detected in free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    AnthropicKey,
    OpenAiKey,
    GithubToken,
    GoogleApiKey,
    AwsAccessKey,
    SlackToken,
    GitlabToken,
    Mem0Token,
    BearerHeader,
    TokenHeader,
    PrivateKeyBlock,
    AssignedSecret,
}

impl SecretKind {
    /// Stable label used in redaction placeholders and audit events.
    #[must_use]
    pub fn label(self) -> &'static str {
        match self {
            Self::AnthropicKey => "anthropic_key",
            Self::OpenAiKey => "openai_key",
            Self::GithubToken => "github_token",
            Self::GoogleApiKey => "google_api_key",
            Self::AwsAccessKey => "aws_access_key",
            Self::SlackToken => "slack_token",
            Self::GitlabToken => "gitlab_token",
            Self::Mem0Token => "mem0_token",
            Self::BearerHeader => "bearer",
            Self::TokenHeader => "token",
            Self::PrivateKeyBlock => "private_key",
            Self::AssignedSecret => "secret",
        }
    }
}

/// A detected secret occurrence: its kind and byte span `[start, end)` in the input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretHit {
    pub kind: SecretKind,
    pub start: usize,
    pub end: usize,
}

const fn is_token_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// Length of the maximal leading run of token chars in `s`.
fn token_run_len(s: &str) -> usize {
    s.bytes().take_while(|&b| is_token_char(b)).count()
}

/// Classify a bare token (already trimmed to its leading token-run) by prefix.
/// Returns `None` unless the tail after the prefix is long enough to look real.
fn classify_token(tok: &str) -> Option<SecretKind> {
    // (prefix, kind, min_total_len) — min_total_len guards against matching a
    // bare prefix word like "AKIA" or "sk-" with no credential body.
    const RULES: &[(&str, SecretKind, usize)] = &[
        ("sk-ant-", SecretKind::AnthropicKey, 20),
        ("sk-", SecretKind::OpenAiKey, 16),
        ("github_pat_", SecretKind::GithubToken, 22),
        ("ghp_", SecretKind::GithubToken, 20),
        ("gho_", SecretKind::GithubToken, 20),
        ("ghu_", SecretKind::GithubToken, 20),
        ("ghs_", SecretKind::GithubToken, 20),
        ("ghr_", SecretKind::GithubToken, 20),
        ("AIza", SecretKind::GoogleApiKey, 30),
        ("AKIA", SecretKind::AwsAccessKey, 20),
        ("ASIA", SecretKind::AwsAccessKey, 20),
        ("xoxb-", SecretKind::SlackToken, 20),
        ("xoxp-", SecretKind::SlackToken, 20),
        ("xoxa-", SecretKind::SlackToken, 20),
        ("xoxs-", SecretKind::SlackToken, 20),
        ("glpat-", SecretKind::GitlabToken, 20),
        ("m0-", SecretKind::Mem0Token, 12),
    ];
    for &(prefix, kind, min_len) in RULES {
        if tok.len() >= min_len && tok.starts_with(prefix) {
            return Some(kind);
        }
    }
    None
}

/// Is `name` (the left side of `name=value`) a known secret-bearing key?
fn is_secret_key_name(name: &str) -> bool {
    let cleaned: String = name
        .trim()
        .trim_matches(|c: char| !c.is_ascii_alphanumeric())
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c == '-' { '_' } else { c })
        .collect();
    matches!(
        cleaned.as_str(),
        "password"
            | "passwd"
            | "pwd"
            | "secret"
            | "client_secret"
            | "api_key"
            | "apikey"
            | "access_token"
            | "refresh_token"
            | "token"
            | "auth_token"
            | "authorization"
            | "private_key"
            | "secret_key"
    )
}

/// A value looks like a real secret (not a placeholder/empty) if it has a
/// non-trivial token tail and is not an obvious placeholder.
fn value_looks_secret(value: &str) -> bool {
    let run = token_run_len(value);
    if run < 8 {
        return false;
    }
    let lower = value[..run].to_ascii_lowercase();
    !matches!(
        lower.as_str(),
        "changeme" | "your_token" | "your_api_key" | "placeholder" | "redacted" | "xxxxxxxx"
    )
}

/// Pass 3 (1.6): a labeled secret in PROSE, e.g. "la clave es Patata2024" or
/// "contraseña: hunter2A". A secret KEYWORD, an optional connector (es/son/:/=),
/// then a VALUE that looks like a secret: a token run >= 6 chars containing BOTH a
/// digit AND a letter. The mixed-alphanumeric gate avoids redacting ordinary prose
/// words ("trabajar", "simplicidad", "constancia"). Only the value span is returned.
fn detect_prose_secrets(text: &str) -> Vec<SecretHit> {
    const KW: &[&str] = &[
        "clave",
        "contraseña",
        "contrasena",
        "contrasenia",
        "password",
        "passwd",
        "secret",
        "secreto",
        "token",
        "passphrase",
    ];
    const CONNECTOR: &[&str] = &["es", "son", "era", "=", ":"];
    let norm = |w: &str| {
        w.trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase()
    };
    let bytes = text.as_bytes();
    let mut words: Vec<(&str, usize)> = Vec::new();
    let mut i = 0usize;
    while i < bytes.len() {
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let s = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        words.push((&text[s..i], s));
    }
    let mut hits = Vec::new();
    let mut w = 0usize;
    while w < words.len() {
        if KW.contains(&norm(words[w].0).as_str()) {
            let mut j = w + 1;
            if j < words.len() && CONNECTOR.contains(&norm(words[j].0).as_str()) {
                j += 1;
            }
            if j < words.len() {
                let (vw, vs) = words[j];
                let lead = vw.bytes().take_while(|&b| !is_token_char(b)).count();
                let run = token_run_len(&vw[lead..]);
                let val = &vw[lead..lead + run];
                let has_digit = val.bytes().any(|b| b.is_ascii_digit());
                let has_alpha = val.bytes().any(|b| b.is_ascii_alphabetic());
                if run >= 6 && has_digit && has_alpha {
                    let start = vs + lead;
                    hits.push(SecretHit {
                        kind: SecretKind::AssignedSecret,
                        start,
                        end: start + run,
                    });
                    w = j + 1;
                    continue;
                }
            }
        }
        w += 1;
    }
    hits
}

/// Detect secret material in `text`. Hits are returned ordered by `start`,
/// non-overlapping (earlier/longer match wins).
#[must_use]
pub fn detect_secrets(text: &str) -> Vec<SecretHit> {
    let mut hits: Vec<SecretHit> = Vec::new();
    let bytes = text.as_bytes();

    // Pass 1: PEM private-key blocks (multi-line) take precedence.
    if let Some(begin) = text.find("-----BEGIN ") {
        if text[begin..].contains("PRIVATE KEY") {
            // Extend to the end of the matching END marker line, else end of text.
            let end = match text[begin..].find("-----END ") {
                Some(rel) => {
                    let after = begin + rel;

                    text[after..].find('\n').map_or(text.len(), |nl| after + nl)
                }
                None => text.len(),
            };
            hits.push(SecretHit {
                kind: SecretKind::PrivateKeyBlock,
                start: begin,
                end,
            });
        }
    }

    // Pass 2: word-by-word scan for tokens, headers and assignments.
    let mut i = 0usize;
    // Remember the previous word (for `Bearer <token>` / `Token <token>`).
    let mut prev_word: Option<&str> = None;
    while i < bytes.len() {
        // Skip whitespace.
        if bytes[i].is_ascii_whitespace() {
            i += 1;
            continue;
        }
        let word_start = i;
        while i < bytes.len() && !bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let word_end = i;
        let word = &text[word_start..word_end];

        // Skip if already covered by an earlier hit (e.g. inside a PEM block).
        let covered = hits
            .iter()
            .any(|h| word_start >= h.start && word_start < h.end);
        if covered {
            prev_word = Some(word);
            continue;
        }

        // (a) Header value: previous word was Bearer/Token.
        if let Some(prev) = prev_word {
            let header_kind = match prev {
                "Bearer" => Some(SecretKind::BearerHeader),
                "Token" => Some(SecretKind::TokenHeader),
                _ => None,
            };
            if let Some(kind) = header_kind {
                let run = token_run_len(word);
                // Allow JWT-style dotted values too: extend over '.' separators.
                let dotted = word
                    .bytes()
                    .take_while(|&b| is_token_char(b) || b == b'.')
                    .count();
                let span = run.max(dotted);
                if span >= 8 {
                    hits.push(SecretHit {
                        kind,
                        start: word_start,
                        end: word_start + span,
                    });
                    prev_word = Some(word);
                    continue;
                }
            }
        }

        // (b) Assignment `name=value` (also handles surrounding quotes on value).
        if let Some(eq) = word.find('=') {
            let (name, rest) = word.split_at(eq);
            let value_raw = &rest[1..]; // skip '='
            if is_secret_key_name(name) {
                // Locate the value's leading token-run, skipping an opening quote.
                let voff = value_raw
                    .find(|c: char| c.is_ascii_alphanumeric())
                    .unwrap_or(0);
                let value = &value_raw[voff..];
                if value_looks_secret(value) {
                    let vstart = word_start + name.len() + 1 + voff;
                    let run = token_run_len(value);
                    let kind = classify_token(value).unwrap_or(SecretKind::AssignedSecret);
                    hits.push(SecretHit {
                        kind,
                        start: vstart,
                        end: vstart + run,
                    });
                    prev_word = Some(word);
                    continue;
                }
            }
        }

        // (c) Bare token: trim leading non-token chars (quotes), classify the run.
        let lead_skip = word.bytes().take_while(|&b| !is_token_char(b)).count();
        let inner = &word[lead_skip..];
        let run = token_run_len(inner);
        if run > 0 {
            if let Some(kind) = classify_token(&inner[..run]) {
                let start = word_start + lead_skip;
                hits.push(SecretHit {
                    kind,
                    start,
                    end: start + run,
                });
            }
        }

        prev_word = Some(word);
    }

    // Pass 3 (1.6): labeled secrets in prose ("la clave es Patata2024"). Merge
    // non-overlapping with the prefix/assignment hits above.
    for h in detect_prose_secrets(text) {
        if !hits.iter().any(|e| h.start < e.end && e.start < h.end) {
            hits.push(h);
        }
    }

    hits.sort_by_key(|h| h.start);
    hits
}

/// Conservative write-path classifier: returns [`Sensitivity::Secret`] if any
/// secret is detected, else [`Sensitivity::Internal`]. Never downgrades; the
/// caller may still raise sensitivity further.
#[must_use]
pub fn classify_sensitivity(text: &str) -> Sensitivity {
    if detect_secrets(text).is_empty() {
        Sensitivity::Internal
    } else {
        Sensitivity::Secret
    }
}

/// Return a copy of `text` with every detected secret replaced by
/// `[REDACTED:<kind>]`, preserving all surrounding (non-secret) characters.
#[must_use]
pub fn redact(text: &str) -> String {
    let hits = detect_secrets(text);
    if hits.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for h in &hits {
        if h.start < cursor {
            continue; // overlap guard
        }
        out.push_str(&text[cursor..h.start]);
        out.push_str(&format!("[REDACTED:{}]", h.kind.label()));
        cursor = h.end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// True if `text` contains any detected secret (cheap boolean wrapper).
#[must_use]
pub fn contains_secret(text: &str) -> bool {
    !detect_secrets(text).is_empty()
}

/// Redact secrets in an optional text field in place (write-path helper).
/// Returns `true` if any secret was found and redacted. A `None` or
/// secret-free field is left untouched and returns `false`.
pub fn redact_in_place(field: &mut Option<String>) -> bool {
    if let Some(text) = field {
        if contains_secret(text) {
            *text = redact(text);
            return true;
        }
    }
    false
}

// ---------------------------------------------------------------------------
// PII detection and redaction (READ-PATH + write-path defence-in-depth)
//
// Detects and redacts personal data that is NOT a credential:
//   - Email addresses  → [REDACTED_EMAIL]
//   - Phone numbers    → [REDACTED_PHONE]
//   - User-path strings (C:\Users\<name>\... or /Users/<name>/...) → [REDACTED_PATH]
//
// Design mirrors the credential detector above: dependency-free byte scan,
// low false-positive bias, returns ordered non-overlapping spans.
// ---------------------------------------------------------------------------

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
/// Extends [`classify_sensitivity`] (credential-only) to also catch PII.
/// Never downgrades — if the caller already has a higher classification,
/// that higher value is preserved by the caller using [`raised_sensitivity`].
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
    fn detects_openai_key() {
        let t = "my key is sk-abcdEFGH1234567890ijkl ok";
        let hits = detect_secrets(t);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, SecretKind::OpenAiKey);
    }

    #[test]
    fn detects_anthropic_key_before_generic_openai() {
        let t = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA";
        let hits = detect_secrets(t);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, SecretKind::AnthropicKey);
    }

    #[test]
    fn detects_github_pat() {
        let t = "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
        let hits = detect_secrets(t);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, SecretKind::GithubToken);
    }

    #[test]
    fn detects_bearer_header_value() {
        let t = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig";
        let hits = detect_secrets(t);
        assert!(hits.iter().any(|h| h.kind == SecretKind::BearerHeader));
    }

    #[test]
    fn detects_mem0_token_like_legacy_redact() {
        let t = "leaked m0-supersecretvalue123 in body";
        assert!(contains_secret(t));
        assert_eq!(detect_secrets(t)[0].kind, SecretKind::Mem0Token);
    }

    #[test]
    fn detects_private_key_block() {
        let t = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc...\n-----END RSA PRIVATE KEY-----";
        let hits = detect_secrets(t);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, SecretKind::PrivateKeyBlock);
    }

    #[test]
    fn detects_password_assignment() {
        let t = "password=hunter2hunter2 and more";
        let hits = detect_secrets(t);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, SecretKind::AssignedSecret);
    }

    #[test]
    fn ignores_placeholder_values() {
        assert!(!contains_secret("api_key=changeme"));
        assert!(!contains_secret("token=your_token"));
    }

    #[test]
    fn leaves_normal_text_alone() {
        let t = "El usuario prefiere respuestas en espanol y commits sin atribucion.";
        assert!(!contains_secret(t));
        assert_eq!(redact(t), t);
    }

    #[test]
    fn does_not_flag_bare_prefix_words() {
        // No credential body -> not a secret (low false-positive bias).
        assert!(!contains_secret("the AKIA program and sk- prefix"));
    }

    #[test]
    fn redact_replaces_secret_keeps_surroundings() {
        let t = "before sk-abcdEFGH1234567890ijkl after";
        let out = redact(t);
        assert_eq!(out, "before [REDACTED:openai_key] after");
    }

    #[test]
    fn redact_handles_quoted_token() {
        let t = "key: \"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\"";
        let out = redact(t);
        assert!(out.contains("[REDACTED:github_token]"));
        assert!(out.contains("key: \""));
    }

    #[test]
    fn classify_sets_secret_when_credential_present() {
        assert_eq!(
            classify_sensitivity("sk-abcdEFGH1234567890ijkl"),
            Sensitivity::Secret
        );
        assert_eq!(
            classify_sensitivity("just a normal note"),
            Sensitivity::Internal
        );
    }

    #[test]
    fn redact_in_place_redacts_and_reports() {
        let mut f = Some("password=hunter2hunter2 here".to_string());
        assert!(redact_in_place(&mut f));
        assert!(f.unwrap().contains("[REDACTED:secret]"));
    }

    #[test]
    fn redact_in_place_leaves_clean_and_none_untouched() {
        let mut clean = Some("a normal memory note".to_string());
        assert!(!redact_in_place(&mut clean));
        assert_eq!(clean.as_deref(), Some("a normal memory note"));
        let mut none: Option<String> = None;
        assert!(!redact_in_place(&mut none));
    }

    #[test]
    fn detects_multiple_secrets_ordered() {
        let t = "a sk-abcdEFGH1234567890ijkl b ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 c";
        let hits = detect_secrets(t);
        assert_eq!(hits.len(), 2);
        assert!(hits[0].start < hits[1].start);
    }

    // -----------------------------------------------------------------------
    // PII detector tests
    // -----------------------------------------------------------------------

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
        assert_eq!(
            classify_sensitivity_with_pii("contacto admin@example.com para datos"),
            Sensitivity::Secret,
        );
    }

    #[test]
    fn classify_sensitivity_with_pii_clean_stays_internal() {
        assert_eq!(
            classify_sensitivity_with_pii("arquitectura de memoria ULTRON brain.db"),
            Sensitivity::Internal,
        );
    }

    #[test]
    fn detects_labeled_secret_in_prose() {
        // 1.6: secreto etiquetado en prosa, sin prefijo conocido (sk-/ghp_/...).
        assert!(contains_secret("la clave es Patata2024"));
        assert!(redact("la clave es Patata2024").contains("[REDACTED:secret]"));
        assert!(!redact("la clave es Patata2024").contains("Patata2024"));
        assert!(contains_secret("contraseña: hunter2A"));
        assert!(contains_secret("el token es abc123XYZ"));
    }

    #[test]
    fn prose_secret_gate_avoids_plain_prose_false_positives() {
        // Gate (>=6 chars + digito + letra) -> NO redacta prosa normal.
        assert!(!contains_secret("la clave del exito es trabajar duro"));
        assert!(!contains_secret("la clave es la simplicidad"));
        assert!(!contains_secret("el secreto es la constancia"));
    }
}
