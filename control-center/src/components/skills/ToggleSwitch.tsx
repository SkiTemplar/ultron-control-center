import { base } from "../icons";

/** Texto común del estado activado/desactivado (interruptor y etiqueta fija). */
export function enabledLabel(enabled: boolean): string {
  return enabled ? "Activado" : "Desactivado";
}

export interface ToggleSwitchProps {
  enabled: boolean;
  busy: boolean;
  readonly: boolean;
  onToggle: () => void;
  /** Motivo por el que no se puede cambiar (tooltip de la etiqueta fija). */
  lockedReason?: string;
  /** Tooltip del interruptor cuando está activado (acción de desactivar). */
  disableTitle?: string;
  /** Tooltip del interruptor cuando está desactivado (acción de activar). */
  enableTitle?: string;
  /** Muestra el texto del estado junto al interruptor. */
  withLabel?: boolean;
}

/**
 * Patrón único de estado activado/desactivado: si el elemento admite el
 * cambio, interruptor; si no, etiqueta fija con candado y el motivo en el
 * tooltip. Ambos usan el mismo texto (`enabledLabel`).
 */
export function ToggleSwitch({
  enabled,
  busy,
  readonly,
  onToggle,
  lockedReason = "Solo se pueden activar o desactivar las skills globales",
  disableTitle = "Desactivar la skill",
  enableTitle = "Activar la skill",
  withLabel = false,
}: ToggleSwitchProps) {
  // Un interruptor atenuado que no se puede mover parece «apagado»: los
  // elementos de solo lectura llevan una etiqueta fija con el estado.
  if (readonly) {
    return <LockedState label={enabledLabel(enabled)} enabled={enabled} title={lockedReason} />;
  }
  const control = (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      disabled={busy}
      title={enabled ? disableTitle : enableTitle}
      className="flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40"
      style={{
        background: enabled ? "var(--color-success)" : "var(--color-surface-3)",
        border: "1px solid var(--color-border-strong)",
        padding: "1px",
        cursor: busy ? "not-allowed" : "pointer",
      }}
    >
      <span
        className="block h-3.5 w-3.5 rounded-full transition-transform"
        style={{
          background: "var(--color-text)",
          transform: enabled ? "translateX(16px)" : "translateX(0)",
        }}
      />
    </button>
  );
  if (!withLabel) return control;
  return (
    <span className="inline-flex items-center gap-2">
      {control}
      <span
        className="text-[11.5px]"
        style={{ color: enabled ? "var(--color-success)" : "var(--color-text-tertiary)" }}
      >
        {busy ? "Guardando…" : enabledLabel(enabled)}
      </span>
    </span>
  );
}

/** Etiqueta de estado fija, no interactiva, con un candado. */
export function LockedState({
  label,
  enabled,
  title,
}: {
  label: string;
  enabled: boolean;
  title: string;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{
        background: "var(--color-surface-3)",
        color: enabled ? "var(--color-success)" : "var(--color-text-tertiary)",
        border: "1px solid var(--color-border)",
      }}
      title={title}
    >
      <svg {...base(10)}>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      {label}
    </span>
  );
}
