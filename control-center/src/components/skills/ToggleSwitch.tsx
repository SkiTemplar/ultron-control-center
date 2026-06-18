export interface ToggleSwitchProps {
  enabled: boolean;
  busy: boolean;
  readonly: boolean;
  onToggle: () => void;
}

export function ToggleSwitch({ enabled, busy, readonly, onToggle }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      disabled={busy || readonly}
      title={
        readonly
          ? "Only global skills can be toggled"
          : enabled
            ? "Disable skill"
            : "Enable skill"
      }
      className="flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40"
      style={{
        background: enabled ? "var(--color-success)" : "var(--color-surface-3)",
        border: "1px solid var(--color-border-strong)",
        padding: "1px",
        cursor: busy || readonly ? "not-allowed" : "pointer",
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
}
