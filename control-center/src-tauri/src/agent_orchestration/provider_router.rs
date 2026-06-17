// agent_orchestration/provider_router — multi-IA PTY dispatch.
//
// Decides WHICH agentic CLI runs a delegation without the user asking.
// Pure O(1) logic; no network, no Qdrant. The semantic routing (E5) already
// chose WHAT agent; here we choose IN WHICH provider it runs.

/// PTY-spawnable provider for an agent delegation. The PTY layer
/// (`build_command` in `pty.rs`) only knows how to launch three agentic
/// CLIs; everything else degrades to Claude.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PtyProvider {
    Claude,
    Codex,
    Gemini,
}

impl PtyProvider {
    /// The exact string `pty::build_command` expects. Keeping this in one
    /// place guarantees the orchestrator and the PTY layer never disagree.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Gemini => "gemini",
        }
    }
}

// Light agents: review/docs/qa/news — Gemini CLI (free via OAuth) is
// plenty. Mirrors the AI Router `code-review` / `summarize` zones.
const LIGHT_AGENTS: &[&str] = &[
    "code-reviewer",
    "qa-expert",
    "ultron-docs",
    "ultron-changelog",
    "ultron-news",
    "documentation-engineer",
    "accessibility-tester",
    "knowledge-synthesizer",
    "dx-optimizer",
];

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
/// Strategy (cheapest correct provider first, Claude as hard fallback):
///   1. `use_cheap_model` OR a "light" agent  → Gemini CLI (free via OAuth).
///   2. A code-implementation-heavy agent      → Codex CLI.
///   3. Otherwise                               → Claude (current behaviour).
///
/// The returned provider is ALWAYS one `build_command` accepts. The caller
/// is responsible for falling back to Claude when the chosen CLI is not on
/// PATH (see `pty::cli_on_path`), so a missing codex/gemini install never
/// breaks a delegation.
pub fn infer_pty_provider(agent_slug: &str, use_cheap_model: bool) -> PtyProvider {
    let s = agent_slug.trim().to_lowercase();

    if use_cheap_model || LIGHT_AGENTS.iter().any(|a| s == *a || s.contains(a)) {
        return PtyProvider::Gemini;
    }
    if CODE_HEAVY_AGENTS.iter().any(|a| s == *a || s.contains(a)) {
        return PtyProvider::Codex;
    }
    PtyProvider::Claude
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cheap_flag_routes_to_gemini() {
        assert_eq!(infer_pty_provider("python-pro", true), PtyProvider::Gemini);
    }

    #[test]
    fn light_agent_routes_to_gemini_without_flag() {
        assert_eq!(
            infer_pty_provider("code-reviewer", false),
            PtyProvider::Gemini
        );
    }

    #[test]
    fn code_heavy_agent_routes_to_codex() {
        assert_eq!(
            infer_pty_provider("rust-engineer", false),
            PtyProvider::Codex
        );
    }

    #[test]
    fn unknown_agent_defaults_to_claude() {
        assert_eq!(
            infer_pty_provider("some-random-agent", false),
            PtyProvider::Claude
        );
    }

    #[test]
    fn provider_strings_match_build_command_contract() {
        // build_command (pty.rs) matches exactly these three literals.
        for p in [PtyProvider::Claude, PtyProvider::Codex, PtyProvider::Gemini] {
            assert!(matches!(p.as_str(), "claude" | "codex" | "gemini"));
        }
    }

    #[test]
    fn cheap_flag_overrides_code_heavy() {
        // Explicit cheap request beats the code-heavy default.
        assert_eq!(
            infer_pty_provider("rust-engineer", true),
            PtyProvider::Gemini
        );
    }
}
