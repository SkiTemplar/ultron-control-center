//! Write-path secret/PII detection and redaction (OLA A).
//!
//! Canonical guard meant to run BEFORE persisting text to SQLite and BEFORE
//! generating embeddings, so a leaked credential never reaches `brain.db`,
//! Qdrant, logs or backups. It consolidates and broadens the narrow
//! `crate::mem0::redact` (which only scrubbed Mem0 `m0-` tokens and bare
//! `Token ` headers) into a reusable detector for the memory write-path.
//!
//! STATUS (2026-06-04): this module is built and unit-tested in isolation.
//! Wiring it into `MemoryService::create_candidate` is GATED on explicit
//! confirmation because it touches the single-writer critical path; see
//! `cockpit/memory-rework/STATE-RECONCILIATION-2026-06-04.md` and `CONTRACTS-2026-06-04.md`.
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
        ("sk-", SecretKind::OpenAiKey, 20),
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
}
