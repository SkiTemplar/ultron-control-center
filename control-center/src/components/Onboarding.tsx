import { useEffect, useRef, useState } from "react";

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
// Re-opening: Settings → General (LifecyclePanel) and the command palette
// ("Show welcome screen") dispatch the in-window "open-onboarding" event
// this component listens for.
// ---------------------------------------------------------------------------

const STORAGE_KEY = "ultron_onboarding_seen";

const FOCUSABLE =
  'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Event name used to re-open the overlay from elsewhere (Settings). */
export const OPEN_ONBOARDING_EVENT = "open-onboarding";

/** Glosario de la jerga básica: una línea por término. */
const GLOSSARY: { term: string; def: string }[] = [
  {
    term: "Skill",
    def: "Una capacidad empaquetada: instrucciones que Claude Code invoca para un tipo de tarea.",
  },
  {
    term: "Agente",
    def: "Un subasistente especializado en un trabajo concreto.",
  },
  {
    term: "MCP",
    def: "Model Context Protocol: conecta Claude con herramientas y datos externos.",
  },
  {
    term: "Memoria",
    def: "Tu memoria persistente (decisiones y sesiones anteriores). La gestionan los hooks; el Panel muestra su estado.",
  },
  {
    term: "Plan",
    def: "Una tarea o funcionalidad que sigues en tu backlog.",
  },
  {
    term: "Sesión",
    def: "Una sesión de trabajo con Claude o Codex.",
  },
  {
    term: "Hook",
    def: "Una automatización que se ejecuta en eventos del ciclo de vida.",
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

  const overlayRef = useRef<HTMLDivElement | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);

  // Modal focus: the rest of the app goes inert while open, focus starts on
  // "Get started" and returns to the previous element on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overlay = overlayRef.current;
    const siblings = Array.from(overlay?.parentElement?.children ?? []).filter(
      (el) => el !== overlay && !el.hasAttribute("inert"),
    );
    for (const el of siblings) el.setAttribute("inert", "");
    startRef.current?.focus();
    return () => {
      for (const el of siblings) el.removeAttribute("inert");
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  // Listen for the re-open request emitted by the Settings button.
  useEffect(() => {
    function reopen() {
      setOpen(true);
    }
    window.addEventListener(OPEN_ONBOARDING_EVENT, reopen);
    return () => window.removeEventListener(OPEN_ONBOARDING_EVENT, reopen);
  }, []);

  // Esc closes while open; Tab / Shift+Tab cycle inside the dialog.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss();
        return;
      }
      if (e.key !== "Tab") return;
      const items = Array.from(
        overlayRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      );
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      const inside = overlayRef.current?.contains(current) ?? false;
      if (e.shiftKey && (current === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
      ref={overlayRef}
      role="dialog"
      aria-modal="true"
      aria-label="Bienvenida a ULTRON"
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
          Bienvenida
        </div>
        <h1
          style={{
            margin: "4px 0 0",
            fontSize: 20,
            fontWeight: 600,
            lineHeight: 1.25,
          }}
        >
          Esto es ULTRON Control Center
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
          ULTRON es un centro de mando personal para Claude Code. Desde esta
          aplicación gestionas tus skills, agentes, proyectos y tu
          sistema, en lugar de ir saltando entre ficheros de configuración y terminales.
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
          Los términos básicos
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
          Por dónde empezar: el <strong style={{ color: "var(--color-text-secondary)" }}>Panel</strong> te da
          el estado del sistema en directo; en <strong style={{ color: "var(--color-text-secondary)" }}>Ajustes</strong>
          configuras ULTRON a tu gusto.
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
            Puedes reabrirlo cuando quieras desde Ajustes → General.
          </span>
          <button
            ref={startRef}
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
            Empezar
          </button>
        </div>
      </div>
    </div>
  );
}
