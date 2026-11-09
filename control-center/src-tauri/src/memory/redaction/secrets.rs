//! Credential/secret detection and redaction (write-path).
//!
//! Detection is dependency-free (no `regex`): it walks whitespace-delimited
//! words and recognises well-known credential shapes by prefix, plus
//! `key=value` assignments, `Bearer`/`Token` headers and PEM private-key blocks.
//! It errs toward NOT flagging ambiguous text (low false-positive bias): a
//! recognised prefix must be followed by a sufficiently long token tail.
//!
//! A word is not a single token: `NOMBRE_TOKEN=valor`, compact JSON
//! (`{"token":"valor","k":"ghp_..."}`), query strings and URLs with credentials
//! carry several fields without whitespace. Hasta la auditoría 2026-11-01 solo se
//! miraba el primer `=` y la primera racha de la palabra, y un PAT de GitHub con
//! nombre compuesto delante llegó en claro a `memory_candidates` y
//! `memory_events`.

use crate::memory::model::Sensitivity;

#[path = "secret_values.rs"]
mod values;
use values::{looks_generated, symbol_password, value_looks_secret, value_offset, value_span_len};

/// Class of secret detected in free text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SecretKind {
    AnthropicKey,
    OpenAiKey,
    GroqKey,
    XaiKey,
    HuggingFaceToken,
    SupabaseToken,
    StripeKey,
    NpmToken,
    GithubToken,
    GoogleApiKey,
    AwsAccessKey,
    SlackToken,
    GitlabToken,
    VendorToken,
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
            Self::GroqKey => "groq_key",
            Self::XaiKey => "xai_key",
            Self::HuggingFaceToken => "huggingface_token",
            Self::SupabaseToken => "supabase_token",
            Self::StripeKey => "stripe_key",
            Self::NpmToken => "npm_token",
            Self::GithubToken => "github_token",
            Self::GoogleApiKey => "google_api_key",
            Self::AwsAccessKey => "aws_access_key",
            Self::SlackToken => "slack_token",
            Self::GitlabToken => "gitlab_token",
            Self::VendorToken => "vendor_token",
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
        ("gsk_", SecretKind::GroqKey, 24),
        ("xai-", SecretKind::XaiKey, 24),
        ("hf_", SecretKind::HuggingFaceToken, 24),
        ("sbp_", SecretKind::SupabaseToken, 24),
        ("sk_live_", SecretKind::StripeKey, 24),
        ("rk_live_", SecretKind::StripeKey, 24),
        ("npm_", SecretKind::NpmToken, 24),
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
        ("m0-", SecretKind::VendorToken, 12),
    ];
    for &(prefix, kind, min_len) in RULES {
        if tok.len() >= min_len && tok.starts_with(prefix) {
            return Some(kind);
        }
    }
    None
}

/// Sufijos de un nombre compuesto que lleva un secreto (`GITHUB_TOKEN`,
/// `ANTHROPIC_API_KEY`, `DB_PASSWORD`). `_key` a secas queda fuera a propósito:
/// `SORT_KEY` o `PRIMARY_KEY` son vocabulario normal.
const SECRET_NAME_SUFFIXES: &[&str] = &[
    "_token",
    "_api_key",
    "_apikey",
    "_secret",
    "_secret_key",
    "_access_key",
    "_private_key",
    "_password",
    "_passwd",
    "_pwd",
    "_pat",
    "_credential",
    "_credentials",
];

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
            | "contraseña"
            | "contrasena"
    ) || cleaned.starts_with("ultron_key_")
        || SECRET_NAME_SUFFIXES.iter().any(|s| cleaned.ends_with(s))
}

/// Asignaciones `nombre=valor` y `nombre:valor` dentro de una palabra, en
/// cualquier posición: `GITHUB_TOKEN=x`, `{"a":1,"token":"x"}`, `?api_key=x&b=1`.
fn detect_assignments(word: &str, word_start: usize) -> Vec<SecretHit> {
    let mut hits = Vec::new();
    let mut consumed = 0usize;
    for (sep, b) in word.bytes().enumerate() {
        if (b != b'=' && b != b':') || sep < consumed {
            continue;
        }
        let left = word[..sep].trim_end_matches(['"', '\'', '\\', '`']);
        // Por caracteres: `contraseña=` tiene una letra no ASCII en el nombre.
        let name_len: usize = left
            .chars()
            .rev()
            .take_while(|&c| c == '-' || c == '_' || c.is_alphanumeric())
            .map(char::len_utf8)
            .sum();
        if !is_secret_key_name(&left[left.len() - name_len..]) {
            continue;
        }
        let Some(voff) = value_offset(&word[sep + 1..]) else {
            continue;
        };
        let vstart = sep + 1 + voff;
        let value = &word[vstart..];
        if !value_looks_secret(value) {
            continue;
        }
        let span = value_span_len(value);
        let run = token_run_len(value);
        hits.push(SecretHit {
            kind: classify_token(&value[..run]).unwrap_or(SecretKind::AssignedSecret),
            start: word_start + vstart,
            end: word_start + vstart + span,
        });
        consumed = vstart + span;
    }
    hits
}

/// Contraseña en la autoridad de una URL: `https://usuario:valor@host/ruta`.
fn detect_url_credential(word: &str, word_start: usize) -> Option<SecretHit> {
    let authority_start = word.find("://")? + 3;
    let tail = &word[authority_start..];
    let authority = &tail[..tail.find(['/', '?', '#']).unwrap_or(tail.len())];
    let at = authority.rfind('@')?;
    let colon = authority[..at].find(':')?;
    let password = &authority[colon + 1..at];
    if password.len() < 6 || password.starts_with(['$', '%', '{', '<', '[']) {
        return None;
    }
    let start = word_start + authority_start + colon + 1;
    Some(SecretHit {
        kind: classify_token(password).unwrap_or(SecretKind::AssignedSecret),
        start,
        end: start + password.len(),
    })
}

/// Rachas de token de la palabra con un prefijo conocido. La primera se clasifica
/// como siempre; las siguientes (`NOMBRE=ghp_...`, `/ruta/sk-...`) exigen además
/// forma de valor generado, porque en rutas y URLs abundan los nombres de paquete.
fn detect_bare_tokens(word: &str, word_start: usize) -> Vec<SecretHit> {
    let mut hits = Vec::new();
    let mut offset = 0usize;
    let mut is_first = true;
    while offset < word.len() {
        offset += word[offset..]
            .bytes()
            .take_while(|&b| !is_token_char(b))
            .count();
        let run = token_run_len(&word[offset..]);
        if run == 0 {
            break;
        }
        let tok = &word[offset..offset + run];
        if let Some(kind) = classify_token(tok).filter(|_| is_first || looks_generated(tok)) {
            hits.push(SecretHit {
                kind,
                start: word_start + offset,
                end: word_start + offset + run,
            });
        }
        is_first = false;
        offset += run;
    }
    hits
}

/// Tipo de cabecera si `prev` es `Bearer` o `Token`. `Bearer` también vale al final
/// de un fragmento pegado (`"authorization":"Bearer valor"`).
fn header_kind(prev: &str) -> Option<SecretKind> {
    if prev == "Token" {
        return Some(SecretKind::TokenHeader);
    }
    let head = prev.strip_suffix("Bearer")?;
    let glued = head.chars().last().is_some_and(char::is_alphanumeric);
    (!glued).then_some(SecretKind::BearerHeader)
}

/// Valor de una cabecera `Bearer`/`Token`, incluido el de forma JWT con puntos.
fn header_hit(prev: Option<&str>, word: &str, word_start: usize) -> Option<SecretHit> {
    let kind = header_kind(prev?)?;
    let dotted = word
        .bytes()
        .take_while(|&b| is_token_char(b) || b == b'.')
        .count();
    let span = token_run_len(word).max(dotted);
    (span >= 8).then_some(SecretHit {
        kind,
        start: word_start,
        end: word_start + span,
    })
}

/// Todas las coincidencias de una palabra, sin solapes. Manda la URL, que corta el
/// valor en la `@` (`x-access-token:valor@host`); después las asignaciones, que dan
/// el tramo entero del valor, y por último la clasificación por prefijo.
fn detect_in_word(word: &str, word_start: usize) -> Vec<SecretHit> {
    let mut hits: Vec<SecretHit> = detect_url_credential(word, word_start)
        .into_iter()
        .collect();
    let found = [
        detect_assignments(word, word_start),
        detect_bare_tokens(word, word_start),
    ];
    for h in found.into_iter().flatten() {
        if !hits.iter().any(|e| h.start < e.end && e.start < h.end) {
            hits.push(h);
        }
    }
    hits
}

/// Bloques PEM de clave privada (multilínea), cada uno hasta el final de la línea de
/// su `END`. Un `fullchain.pem` lleva certificados delante de la clave y un fichero
/// puede llevar varias claves: se mira la etiqueta de cada `BEGIN`. Un certificado es
/// público y no se redacta.
fn private_key_blocks(text: &str) -> Vec<SecretHit> {
    const BEGIN: &str = "-----BEGIN ";
    let mut hits = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(BEGIN) {
        let begin = from + rel;
        let after_begin = begin + BEGIN.len();
        let tail = &text[after_begin..];
        let label = &tail[..tail.find("-----").unwrap_or(tail.len())];
        let label = label.lines().next().unwrap_or(label);
        // Un bloque ajeno sin `END` no puede saltarse la clave que venga detrás.
        from = after_begin;
        if !label.contains("PRIVATE KEY") {
            continue;
        }
        let end = match text[begin..].find("-----END ") {
            Some(rel_end) => {
                let after = begin + rel_end;
                text[after..].find('\n').map_or(text.len(), |nl| after + nl)
            }
            None => text.len(),
        };
        hits.push(SecretHit {
            kind: SecretKind::PrivateKeyBlock,
            start: begin,
            end,
        });
        from = end;
    }
    hits
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
    const CONNECTOR: &[&str] = &["es", "son", "era"];
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
        let keyword = norm(words[w].0);
        if KW.contains(&keyword.as_str()) || is_secret_key_name(&keyword) {
            let mut j = w + 1;
            // `norm` deja en vacío un `=` o `:` suelto: se comparan en crudo.
            if j < words.len()
                && (CONNECTOR.contains(&norm(words[j].0).as_str())
                    || matches!(words[j].0, "=" | ":"))
            {
                j += 1;
            }
            if j < words.len() {
                let (vw, vs) = words[j];
                let lead = vw.bytes().take_while(|&b| !is_token_char(b)).count();
                let run = token_run_len(&vw[lead..]);
                let val = &vw[lead..lead + run];
                let has_digit = val.bytes().any(|b| b.is_ascii_digit());
                let has_alpha = val.bytes().any(|b| b.is_ascii_alphabetic());
                let span = value_span_len(&vw[lead..]);
                let looks_mixed = run >= 6 && has_digit && has_alpha;
                if looks_mixed || symbol_password(&vw[lead..lead + span]) {
                    let start = vs + lead;
                    hits.push(SecretHit {
                        kind: SecretKind::AssignedSecret,
                        start,
                        end: start + span.max(run),
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
    let bytes = text.as_bytes();

    // Pass 1: PEM private-key blocks (multi-line) take precedence.
    let mut hits: Vec<SecretHit> = private_key_blocks(text);

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
        let word = &text[word_start..i];

        // Skip if already covered by an earlier hit (e.g. inside a PEM block).
        let covered = hits
            .iter()
            .any(|h| word_start >= h.start && word_start < h.end);
        if !covered {
            match header_hit(prev_word, word, word_start) {
                Some(hit) => hits.push(hit),
                None => hits.extend(detect_in_word(word, word_start)),
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

// Formas sin espacios (asignaciones con nombre compuesto, JSON compacto, URL).
#[cfg(test)]
#[path = "secrets_tests.rs"]
mod compound_tests;

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
    fn detects_vendor_m0_token_pattern() {
        let t = "leaked m0-supersecretvalue123 in body";
        assert!(contains_secret(t));
        assert_eq!(detect_secrets(t)[0].kind, SecretKind::VendorToken);
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

    /// Prefijos de proveedores habituales. Las claves se montan en tiempo de
    /// ejecución para que el fuente no contenga una credencial literal.
    #[test]
    fn detects_common_provider_prefixes() {
        let tail = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
        let cases = [
            ("gsk_", SecretKind::GroqKey),
            ("sk-ant-api03-", SecretKind::AnthropicKey),
            ("sk-proj-", SecretKind::OpenAiKey),
            ("AIzaSy", SecretKind::GoogleApiKey),
            ("ghp_", SecretKind::GithubToken),
            ("github_pat_11", SecretKind::GithubToken),
            ("sbp_", SecretKind::SupabaseToken),
            ("hf_", SecretKind::HuggingFaceToken),
            ("xai-", SecretKind::XaiKey),
            ("sk_live_", SecretKind::StripeKey),
            ("rk_live_", SecretKind::StripeKey),
            ("npm_", SecretKind::NpmToken),
        ];
        for (prefix, kind) in cases {
            let key = format!("{prefix}{tail}");
            let text = format!("401 invalid key {key} (retry)");
            let hits = detect_secrets(&text);
            assert_eq!(hits.len(), 1, "{prefix}: {hits:?}");
            assert_eq!(hits[0].kind, kind, "{prefix}");
            let out = redact(&text);
            assert!(
                !out.contains(&key[..prefix.len() + 4]),
                "{prefix} escapa: {out}"
            );
            assert!(out.ends_with(" (retry)"), "{out}");
        }
    }

    #[test]
    fn bare_new_prefixes_without_body_are_not_secrets() {
        assert!(!contains_secret("gsk_ sbp_ hf_ xai- npm_ prefijos sueltos"));
        assert!(!contains_secret("usa gsk_short o hf_token en la doc"));
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
