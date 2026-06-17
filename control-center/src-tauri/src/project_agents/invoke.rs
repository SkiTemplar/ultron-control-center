// project_agents/invoke.rs — Write a sub-agent delegation into an active PTY session.

use base64::Engine;

use super::types::InvokeResult;

/// Write a sub-agent delegation line into the most-recent running PTY for
/// `project_id`.  The text is a plain-text instruction that Claude Code
/// (running inside that PTY) interprets as a sub-agent task.
///
/// Session selection: `pty::list_inner` returns all PTYs for the project.
/// We pick the one with `status == Running` whose `started_at` is lexically
/// largest (the iso-epoch format "epoch:<secs>" sorts correctly that way).
pub fn invoke_from_session_inner(
    project_id: &str,
    agent_name: &str,
    task_prompt: &str,
) -> Result<InvokeResult, String> {
    use crate::pty::{list_inner, write_inner, PtyStatus};

    let sessions = list_inner(project_id.to_string())?;

    let active = sessions
        .iter()
        .filter(|s| s.status == PtyStatus::Running)
        .max_by(|a, b| a.started_at.cmp(&b.started_at))
        .ok_or_else(|| {
            format!(
                "No active terminal session for project '{}'. \
                 Open a terminal session first from the Terminal tab.",
                project_id
            )
        })?;

    let pty_id = active.id.clone();

    // Sanitize task_prompt before writing to the PTY.
    //
    // Rules:
    //   - Reject blank prompts (after trimming).
    //   - Strip control characters below 0x20, except \n (0x0A) and \t (0x09),
    //     to prevent ANSI escape injection (e.g. "\x1b[2J" clearing the screen).
    //   - Truncate to 4 KiB so a pathological caller cannot flood the PTY buffer.
    const MAX_PROMPT_BYTES: usize = 4096;
    let sanitized: String = task_prompt
        .chars()
        .filter(|&c| c == '\n' || c == '\t' || c >= '\x20')
        .collect();
    let sanitized = if sanitized.len() > MAX_PROMPT_BYTES {
        sanitized[..MAX_PROMPT_BYTES].to_string()
    } else {
        sanitized
    };
    let sanitized = sanitized.trim();
    if sanitized.is_empty() {
        return Err("task_prompt is empty after sanitization".to_string());
    }

    // Build the delegation text.  Claude Code understands natural-language
    // sub-agent instructions — "Use the X agent to: <task>" is idiomatic.
    let instruction = format!("Use the {agent_name} agent to: {sanitized}\n");

    // write_inner expects base64-encoded bytes.
    let engine = base64::engine::general_purpose::STANDARD;
    let encoded = engine.encode(instruction.as_bytes());
    write_inner(pty_id.clone(), encoded)?;

    Ok(InvokeResult { pty_id, sent: true })
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    /// Helper that runs the same sanitization logic used in
    /// `invoke_from_session_inner` without needing a live PTY.
    fn sanitize_prompt(input: &str) -> Result<String, &'static str> {
        const MAX_PROMPT_BYTES: usize = 4096;
        let sanitized: String = input
            .chars()
            .filter(|&c| c == '\n' || c == '\t' || c >= '\x20')
            .collect();
        let sanitized = if sanitized.len() > MAX_PROMPT_BYTES {
            sanitized[..MAX_PROMPT_BYTES].to_string()
        } else {
            sanitized
        };
        let s = sanitized.trim().to_string();
        if s.is_empty() {
            Err("empty after sanitization")
        } else {
            Ok(s)
        }
    }

    #[test]
    fn ansi_escape_is_stripped_from_pty_prompt() {
        // ESC [ 2 J (clear screen) must not pass through to the PTY.
        let malicious = "\x1b[2Jlegitimate task";
        let result = sanitize_prompt(malicious).expect("non-empty after strip");
        assert!(
            !result.contains('\x1b'),
            "ANSI escape must be removed; got: {result:?}"
        );
        assert!(result.contains("legitimate task"));
    }

    #[test]
    fn other_c0_control_codes_are_stripped() {
        // \x01 (SOH), \x03 (ETX), \x07 (BEL) — all below 0x20 except \n/\t.
        let input = "\x01hello\x03world\x07";
        let result = sanitize_prompt(input).expect("non-empty after strip");
        assert_eq!(result, "helloworld");
    }

    #[test]
    fn newlines_and_tabs_are_preserved() {
        let input = "line one\nline two\t(tab)";
        let result = sanitize_prompt(input).expect("valid prompt");
        assert_eq!(result, "line one\nline two\t(tab)");
    }

    #[test]
    fn blank_prompt_is_rejected() {
        assert!(sanitize_prompt("   ").is_err());
        assert!(sanitize_prompt("").is_err());
        // Only control chars — becomes empty after strip.
        assert!(sanitize_prompt("\x01\x02\x03").is_err());
    }

    #[test]
    fn prompt_is_truncated_to_4kib() {
        let long = "a".repeat(8192);
        let result = sanitize_prompt(&long).expect("non-empty");
        assert_eq!(result.len(), 4096);
    }
}
