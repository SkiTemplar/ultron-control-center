// ULTRON Control Center — AI Router: piezas visuales mínimas que comparten
// las tarjetas del panel de delegación (mismo estilo que ZoneCard/ProxyControl).

import type { ReactNode } from "react";

export function DelegationCard({
  title,
  hint,
  actions,
  children,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className="rounded-lg p-4"
      style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border)" }}
    >
      <header className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[14px] font-semibold" style={{ color: "var(--color-text)" }}>
            {title}
          </h2>
          {hint && (
            <p className="mt-0.5 text-[11.5px] leading-relaxed" style={{ color: "var(--color-text-tertiary)" }}>
              {hint}
            </p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function SmallButton({
  onClick,
  disabled,
  title,
  primary,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      style={
        primary
          ? { background: "var(--color-accent)", color: "var(--color-accent-text)" }
          : {
              background: "var(--color-surface-2, var(--color-surface-1))",
              border: "1px solid var(--color-border-strong)",
              color: "var(--color-text-secondary)",
            }
      }
    >
      {children}
    </button>
  );
}

const BANNER_COLORS = {
  error: { bg: "rgba(248, 81, 73, 0.06)", border: "rgba(248, 81, 73, 0.22)", fg: "var(--color-danger)" },
  warn: { bg: "rgba(248, 140, 0, 0.06)", border: "rgba(248, 140, 0, 0.30)", fg: "var(--color-warning, #f8a000)" },
  ok: { bg: "rgba(63, 185, 80, 0.06)", border: "rgba(63, 185, 80, 0.22)", fg: "var(--color-success)" },
} as const;

export function Banner({
  kind,
  messages,
}: {
  kind: keyof typeof BANNER_COLORS;
  messages: string[];
}) {
  if (messages.length === 0) return null;
  const c = BANNER_COLORS[kind];
  return (
    <div
      role={kind === "error" ? "alert" : "status"}
      className="mt-3 rounded p-2.5 text-[12px]"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.fg }}
    >
      {messages.length === 1 ? (
        <p>{messages[0]}</p>
      ) : (
        <ul className="ml-4 list-disc space-y-0.5">
          {messages.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Pill({ ok, children, title }: { ok: boolean | null; children: ReactNode; title?: string }) {
  const color =
    ok === null ? "var(--color-text-tertiary)" : ok ? "var(--color-success)" : "var(--color-danger)";
  return (
    <span
      title={title}
      className="rounded px-1.5 py-px text-[10.5px] font-medium"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 28%, transparent)`,
      }}
    >
      {children}
    </span>
  );
}

export const INPUT_STYLE = {
  background: "var(--color-bg)",
  border: "1px solid var(--color-border-strong)",
  color: "var(--color-text)",
  fontFamily: "var(--font-mono)",
} as const;
