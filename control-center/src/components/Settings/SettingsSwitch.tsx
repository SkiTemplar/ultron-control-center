// Settings/SettingsSwitch.tsx — interruptor único para los booleanos de
// Settings (autostart, Pupus, MCP de solo lectura). Es un <button> con
// role="switch": dentro de un <label>, el clic en el texto también lo
// conmuta, igual que hacía la casilla nativa.

interface SettingsSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Nombre accesible; obligatorio porque el botón no tiene texto. */
  label: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}

export function SettingsSwitch({
  checked,
  onChange,
  label,
  disabled = false,
  title,
  className = "",
}: SettingsSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${className}`}
      style={{
        background: checked ? "var(--color-success)" : "var(--color-surface-3)",
        border: "1px solid var(--color-border-strong)",
        padding: "1px",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span
        className="block h-3.5 w-3.5 rounded-full transition-transform"
        style={{
          background: "var(--color-text)",
          transform: checked ? "translateX(16px)" : "translateX(0)",
        }}
      />
    </button>
  );
}
