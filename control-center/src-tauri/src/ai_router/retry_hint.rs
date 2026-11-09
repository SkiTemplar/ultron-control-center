// Retry hints: how long a provider says to wait after a 429.
//
// Two sources, in order of trust:
//   1. The `Retry-After` HTTP header (delta-seconds form; the HTTP-date form is
//      not used by any provider in the chain and is ignored).
//   2. The error body: Groq/OpenAI-compatible "Please try again in 7m12.3s",
//      Gemini "Please retry in 30.5s" and its `"retryDelay": "30s"` field.
//
// The hint travels from the HTTP wrapper to the retry loop and the health gate
// inside the error message, as a `[retry-after=Ns]` marker appended BEFORE the
// body is truncated (Groq puts the "try again" clause ~200 chars into the body,
// past the truncation point). `FailReason` stays a plain `Copy` enum.

/// Hints at or below this many seconds are waited out inline by `with_retry`;
/// longer ones cool the model down and hand over to the next fallback.
pub(crate) const INLINE_RETRY_MAX_SECS: u64 = 10;

/// Upper bound for any hint: a provider asking for more than a day is treated
/// as "a day" so a malformed value cannot park a model indefinitely.
pub(crate) const MAX_HINT_SECS: u64 = 24 * 3600;

const MARKER_PREFIX: &str = "[retry-after=";

/// Seconds to wait according to the `Retry-After` header or the error body.
pub(crate) fn parse_retry_after(header: Option<&str>, body: &str) -> Option<u64> {
    header
        .and_then(parse_header_seconds)
        .or_else(|| parse_body(body))
        .map(|s| s.min(MAX_HINT_SECS))
}

/// `[retry-after=Ns]` marker to append to an error message.
pub(crate) fn marker(secs: u64) -> String {
    format!(" {}{}s]", MARKER_PREFIX, secs)
}

/// Seconds carried by a `[retry-after=Ns]` marker inside an error message.
pub(crate) fn hint_from_message(msg: &str) -> Option<u64> {
    let start = msg.rfind(MARKER_PREFIX)? + MARKER_PREFIX.len();
    let rest = &msg[start..];
    let end = rest.find("s]")?;
    rest[..end].parse().ok()
}

fn parse_header_seconds(value: &str) -> Option<u64> {
    let v = value.trim();
    v.parse::<u64>().ok().or_else(|| {
        v.parse::<f64>()
            .ok()
            .filter(|f| *f >= 0.0)
            .map(|f| f.ceil() as u64)
    })
}

fn parse_body(body: &str) -> Option<u64> {
    let lower = body.to_ascii_lowercase();
    for needle in [
        "try again in ",
        "retry in ",
        "\"retrydelay\": \"",
        "\"retrydelay\":\"",
    ] {
        if let Some(pos) = lower.find(needle) {
            if let Some(secs) = parse_duration(&lower[pos + needle.len()..]) {
                return Some(secs);
            }
        }
    }
    None
}

/// Parses a leading duration such as `7m12.3s`, `1h2m`, `30.5s`, `450ms` or
/// `23 minutes`. Rounds up to whole seconds; `None` if nothing parses.
fn parse_duration(s: &str) -> Option<u64> {
    let mut total = 0.0_f64;
    let mut matched = false;
    let mut rest = s.trim_start();
    loop {
        let num_len = rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.'))
            .unwrap_or(rest.len());
        if num_len == 0 {
            break;
        }
        let Ok(n) = rest[..num_len].parse::<f64>() else {
            break;
        };
        let after = rest[num_len..].trim_start();
        let unit_len = after
            .find(|c: char| !c.is_ascii_alphabetic())
            .unwrap_or(after.len());
        let factor = match &after[..unit_len] {
            "ms" | "millisecond" | "milliseconds" => 0.001,
            "s" | "sec" | "secs" | "second" | "seconds" => 1.0,
            "m" | "min" | "mins" | "minute" | "minutes" => 60.0,
            "h" | "hr" | "hrs" | "hour" | "hours" => 3600.0,
            _ => break,
        };
        total += n * factor;
        matched = true;
        rest = &after[unit_len..];
    }
    matched.then(|| total.ceil().max(1.0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_seconds_win_over_body() {
        assert_eq!(parse_retry_after(Some("7"), "try again in 5m"), Some(7));
    }

    #[test]
    fn groq_body_with_minutes_and_fractional_seconds() {
        let body = r#"{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD): Limit 200000, Used 199941, Requested 1234. Please try again in 7m12.3s. Need more tokens?"}}"#;
        assert_eq!(parse_retry_after(None, body), Some(433));
    }

    #[test]
    fn groq_body_with_milliseconds() {
        assert_eq!(
            parse_retry_after(None, "Please try again in 450ms."),
            Some(1)
        );
    }

    #[test]
    fn gemini_retry_delay_field() {
        let body = r#"{"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay": "30s"}]}}"#;
        assert_eq!(parse_retry_after(None, body), Some(30));
    }

    #[test]
    fn words_units() {
        assert_eq!(
            parse_retry_after(None, "limit reached, try again in 23 minutes"),
            Some(1380)
        );
        assert_eq!(parse_retry_after(None, "retry in 2 hours"), Some(7200));
    }

    #[test]
    fn no_hint_when_nothing_parses() {
        assert_eq!(parse_retry_after(None, "rate limit exceeded"), None);
        assert_eq!(
            parse_retry_after(Some("Wed, 21 Oct 2026 07:28:00 GMT"), "try again later"),
            None
        );
    }

    #[test]
    fn hint_is_capped_at_one_day() {
        assert_eq!(parse_retry_after(Some("999999"), ""), Some(MAX_HINT_SECS));
    }

    #[test]
    fn marker_round_trips_through_message() {
        let msg = format!("groq 429 Too Many Requests: {{...}}{}", marker(433));
        assert_eq!(hint_from_message(&msg), Some(433));
        assert_eq!(hint_from_message("groq 429: no marker"), None);
    }
}
