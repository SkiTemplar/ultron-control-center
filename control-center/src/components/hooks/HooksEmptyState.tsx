import { eventColors } from "./constants";

export function HooksEmptyState({ onAdd, onAi }: { onAdd: () => void; onAi: () => void }) {
  return (
    <div
      className="rounded p-5"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      <div className="mb-1 text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
        No hay hooks configurados
      </div>
      <p
        className="mb-4 text-[12px] leading-relaxed"
        style={{ color: "var(--color-text-secondary)" }}
      >
        Los hooks son comandos de shell que Claude Code ejecuta alrededor de las llamadas a
        herramientas y de los eventos del ciclo de vida de la sesión. Viven en{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>~/.claude/settings.json</code>, bajo la clave{" "}
        <code style={{ fontFamily: "var(--font-mono)" }}>hooks</code>.
      </p>
      <div className="mb-4 grid grid-cols-1 gap-2 md:grid-cols-3">
        {(["PreToolUse", "PostToolUse", "Stop"] as const).map((ev) => {
          const colors = eventColors(ev);
          const desc: Record<string, string> = {
            PreToolUse: "Antes de que se ejecute una herramienta. Exit 2 la bloquea. Útil para auditar comandos y aplicar políticas.",
            PostToolUse: "Después de que una herramienta termine bien. Útil para formatear, pasar el lint o actualizar dependencias.",
            Stop: "Cuando Claude termina de responder. Útil para comprobaciones de fin de sesión (restos de depuración, árbol de git sucio).",
          };
          return (
            <div
              key={ev}
              className="rounded p-2.5"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                boxShadow: `inset 0 3px 0 ${colors.ribbon}`,
              }}
            >
              <div
                className="mb-1 inline-block rounded px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide"
                style={{ background: colors.chipBg, color: colors.chipFg }}
              >
                {ev}
              </div>
              <div
                className="text-[11.5px] leading-snug"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {desc[ev]}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAdd}
          className="rounded px-3 py-1.5 text-[12px] font-medium"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          Añadir el primer hook
        </button>
        <button
          type="button"
          onClick={onAi}
          className="rounded px-3 py-1.5 text-[12px] font-medium"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Describe lo que quieres con tus palabras; Claude redacta el JSON"
        >
          Añadir con IA
        </button>
      </div>
    </div>
  );
}
