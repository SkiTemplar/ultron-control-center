import { useEffect, useState } from "react";

// ---------------------------------------------------------------------------
// Onboarding — first-run welcome overlay.
//
// The very first time the Control Center opens (no `ultron_onboarding_seen`
// key in localStorage) this centered modal explains, in plain English, what
// ULTRON is and what the core jargon means — before the user lands on the
// Dashboard and gets hit with terms with zero context.
//
// Detection is frontend-only: a single localStorage flag. No Rust changes.
// It is dismissable (button / Esc / backdrop click) and NOT permanently
// blocking — closing it sets the flag so it never auto-shows again.
//
// Re-opening: GeneralSection has a "Show welcome screen" button that
// dispatches the in-window "open-onboarding" event this component listens
// for. (Settings → General was chosen over LifecyclePanel because the
// welcome screen is an orientation aid, not an app-lifecycle action.)
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ultron_onboarding_seen";

/** Event name used to re-open the overlay from elsewhere (Settings). */
export const OPEN_ONBOARDING_EVENT = "open-onboarding";

/** Core-jargon glossary — one line each. */
const GLOSSARY: { term: string; def: string }[] = [
  {
    term: "Skill",
    def: "A packaged capability — instructions Claude Code invokes for a kind of task.",
  },
  {
    term: "Agent",
    def: "A specialized sub-assistant focused on one concrete job.",
  },
  {
    term: "MCP",
    def: "Model Context Protocol — connects Claude to external tools and data.",
  },
  {
    term: "Vault",
    def: "Your persistent memory: notes, decisions and past sessions.",
  },
  {
    term: "Plan",
    def: "A single task or feature tracked in your backlog.",
  },
  {
    term: "Session",
    def: "One working session with Claude or Codex.",
  },
  {
    term: "Hook",
    def: "An automation that runs on lifecycle events.",
  },
];

export function Onboarding() {
  // Show on mount when the first-run flag is absent. localStorage can throw
  // in locked-down webview contexts — if it does, fail closed (don't show)
  // so a storage error never traps the user behind a modal.
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) == null;
    } catch {
      return false;
    }
  });

  // Listen for the re-open request emitted by the Settings button.
  useEffect(() => {
    function reopen() {
      setOpen(true);
    }
    window.addEventListener(OPEN_ONBOARDING_EVENT, reopen);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, reopen);
  }, []);

  // Esc closes while open.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function dismiss() {
    try {
      localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    } catch {
      // Storage unavailable — close anyway. Worst case the overlay
      // re-appears next launch; that's a minor annoyance, not a trap.
    }
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to ULTRON"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.62)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 10000,
        padding: 24,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        style={{
          width: "min(34rem, 94vw)",
          maxHeight: "88vh",
          overflowY: "auto",
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
          borderRadius: 8,
          boxShadow: "0 16px 48px rgba(0, 0, 0, 0.65)",
          padding: 24,
          fontFamily: "var(--font-sans)",
          color: "var(--color-text)",
        }}
      >
        {/* Header */}
        <div
          style={{
            fontSize: 10.5,
            color: "var(--color-text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Welcome
        </div>
        <h1
          style={{
            margin: "4px 0 0",
            fontSize: 20,
            fontWeight: 600,
            lineHeight: 1.25,
          }}
        >
          This is the ULTRON Control Center
        </h1>

        {/* What is ULTRON */}
        <p
          style={{
            marginTop: 10,
            fontSize: 13,
            lineHeight: 1.6,
            color: "var(--color-text-secondary)",
          }}
        >
          ULTRON is a personal command center for Claude Code. From this one
          app you manage your skills, agents, memory, projects and your
          system — instead of juggling scattered config files and terminals.
        </p>

        {/* Glossary */}
        <div
          style={{
            marginTop: 16,
            fontSize: 11,
            color: "var(--color-text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          The core terms
        </div>
        <dl style={{ margin: "8px 0 0" }}>
          {GLOSSARY.map(({ term, def }) => (
            <div
              key={term}
              style={{
                display: "flex",
                gap: 10,
                padding: "6px 0",
                borderBottom: "1px solid var(--color-border)",
              }}
            >
              <dt
                style={{
                  flex: "0 0 4.5rem",
                  fontSize: 12.5,
                  fontWeight: 600,
                  color: "var(--color-text)",
                }}
              >
                {term}
              </dt>
              <dd
                style={{
                  margin: 0,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: "var(--color-text-secondary)",
                }}
              >
                {def}
              </dd>
            </div>
          ))}
        </dl>

        {/* Where to start */}
        <p
          style={{
            marginTop: 14,
            fontSize: 12,
            lineHeight: 1.6,
            color: "var(--color-text-tertiary)",
          }}
        >
          Where to start: the <strong style={{ color: "var(--color-text-secondary)" }}>Dashboard</strong> gives you
          the live system status; head to <strong style={{ color: "var(--color-text-secondary)" }}>Settings</strong> to
          configure ULTRON to your taste.
        </p>

        {/* Action */}
        <div
          style={{
            marginTop: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <span
            style={{ fontSize: 10.5, color: "var(--color-text-faint)" }}
          >
            Reopen anytime from Settings → General.
          </span>
          <button
            type="button"
            onClick={dismiss}
            style={{
              fontSize: 12.5,
              fontWeight: 500,
              padding: "7px 16px",
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
              border: "1px solid var(--color-accent)",
              borderRadius: 5,
              cursor: "pointer",
            }}
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}
