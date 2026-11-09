// Settings/api-keys/KeyGroupSection.tsx — sección plegable del catálogo de
// claves (Suscripciones, De pago, Gratuitas, Investigación, Personalizadas).

import type { ReactNode } from "react";

interface KeyGroupSectionProps {
  title: string;
  /** Resumen a la derecha del título (p. ej. «3/10 configuradas»). */
  summary?: string;
  description?: ReactNode;
  defaultOpen?: boolean;
  onToggle?: (open: boolean) => void;
  children: ReactNode;
}

export function KeyGroupSection({
  title,
  summary,
  description,
  defaultOpen = false,
  onToggle,
  children,
}: KeyGroupSectionProps) {
  return (
    <details
      open={defaultOpen}
      onToggle={(e) => onToggle?.(e.currentTarget.open)}
      className="mt-3 rounded"
      style={{ border: "1px solid var(--color-border)", background: "var(--color-surface-1)" }}
    >
      <summary
        className="flex cursor-pointer select-none items-center justify-between gap-3 px-3 py-2.5"
        style={{ color: "var(--color-text)" }}
      >
        <span className="text-[13px] font-semibold">{title}</span>
        {summary && (
          <span className="text-[11px] tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
            {summary}
          </span>
        )}
      </summary>
      <div className="border-t px-3 pb-3 pt-3" style={{ borderColor: "var(--color-border)", background: "var(--color-bg)" }}>
        {description && (
          <p className="mb-3 text-[12px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
            {description}
          </p>
        )}
        {children}
      </div>
    </details>
  );
}
