import type { Step } from "./types";

export function FieldLabel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span
        className="mb-1 block text-xs"
        style={{ color: "var(--color-text-muted)" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

export function HelperText({
  children,
  error = false,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className="mt-1 text-xs"
      style={{
        color: error ? "var(--color-error)" : "var(--color-text-muted)",
      }}
    >
      {children}
    </div>
  );
}

export function ScopeRadio(props: {
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
}) {
  const { label, sub, active, onClick } = props;
  return (
    <button
      onClick={onClick}
      className="flex flex-1 flex-col items-start gap-1 rounded border p-2 text-left"
      style={{
        borderColor: active ? "var(--color-accent)" : "var(--color-border)",
        background: active
          ? "var(--color-surface-2)"
          : "var(--color-surface-1)",
      }}
    >
      <span className="text-sm font-medium">{label}</span>
      <span
        className="font-mono text-[10px]"
        style={{ color: "var(--color-text-muted)" }}
      >
        {sub}
      </span>
    </button>
  );
}

export function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-2 py-0.5">
      <span style={{ color: "var(--color-text-muted)" }}>{k}</span>
      <span className="truncate font-mono">{v}</span>
    </div>
  );
}

export function StepperDots({ step }: { step: Step }) {
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className="h-1.5 w-6 rounded-full"
          style={{
            background:
              n <= step ? "var(--color-accent)" : "var(--color-surface-3)",
          }}
        />
      ))}
    </div>
  );
}
