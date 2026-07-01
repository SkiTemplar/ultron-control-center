// agent_orchestration/provider_router — multi-IA PTY dispatch.
//
// Decides WHICH agentic CLI runs a delegation without the user asking.
// Pure O(1) logic; no network, no Qdrant. The semantic routing (E5) already
// chose WHAT agent; here we choose IN WHICH provider it runs.

/// PTY-spawnable provider for an agent delegation. The PTY layer
/// (`build_command` in `pty.rs`) only knows how to launch two agentic
/// CLIs; everything else degrades to Claude.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyProvider {
    Claude,
    Codex,
}

impl PtyProvider {
    /// The exact string `pty::build_command` expects. Keeping this in one
    /// place guarantees the orchestrator and the PTY layer never disagree.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }
}

// Code-implementation-heavy agents — Codex CLI. Mirrors the AI Router
// `code-edit` zone (primary codex/gpt-5).
const CODE_HEAVY_AGENTS: &[&str] = &[
    "rust-engineer",
    "cpp-pro",
    "backend-developer",
    "golang-pro",
    "python-pro",
    "typescript-pro",
    "fullstack-developer",
    "refactoring-specialist",
    "legacy-modernizer",
];

/// Decide which agentic CLI should run a delegation, WITHOUT the user asking.
///
/// Strategy (Codex for code-heavy work, Claude as hard fallback for everything else):
///   1. A code-implementation-heavy agent → Codex CLI.
///   2. Otherwise                          → Claude.
///
/// The returned provider is ALWAYS one `build_command` accepts. The caller
/// is responsible for falling back to Claude when the chosen CLI is not on
/// PATH (see `pty::cli_on_path`), so a missing codex binary never breaks a
/// delegation.
pub fn infer_pty_provider(agent_slug: &str) -> PtyProvider {
    let s = agent_slug.trim().to_lowercase();
    if CODE_HEAVY_AGENTS.iter().any(|a| s == *a || s.contains(a)) {
        return PtyProvider::Codex;
    }
    PtyProvider::Claude
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_heavy_agent_routes_to_codex() {
        assert_eq!(infer_pty_provider("rust-engineer"), PtyProvider::Codex);
        assert_eq!(infer_pty_provider("python-pro"), PtyProvider::Codex);
        assert_eq!(
            infer_pty_provider("fullstack-developer"),
            PtyProvider::Codex
        );
    }

    #[test]
    fn unknown_agent_defaults_to_claude() {
        assert_eq!(infer_pty_provider("some-random-agent"), PtyProvider::Claude);
        assert_eq!(infer_pty_provider("security-auditor"), PtyProvider::Claude);
    }

    #[test]
    fn light_agent_defaults_to_claude() {
        // Review/docs/qa agents run on Claude — Gemini CLI retired 2026-06-19.
        assert_eq!(infer_pty_provider("code-reviewer"), PtyProvider::Claude);
        assert_eq!(infer_pty_provider("qa-expert"), PtyProvider::Claude);
        assert_eq!(infer_pty_provider("ultron-docs"), PtyProvider::Claude);
    }

    #[test]
    fn provider_strings_match_build_command_contract() {
        // build_command (pty.rs) matches exactly these two literals.
        for p in [PtyProvider::Claude, PtyProvider::Codex] {
            assert!(matches!(p.as_str(), "claude" | "codex"));
        }
    }
}
