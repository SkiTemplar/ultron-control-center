// Shared building blocks of the Library creation wizards (skill and agent):
// field primitives, the step indicator, and the wizard header and footer.

import { ChevronLeft, ChevronRight, Plus, X } from "./icons";

export type WizardStep = 1 | 2 | 3 | 4;

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

export function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="rounded px-2 py-0.5 font-mono text-xs"
      style={{ background: "var(--color-surface-2)" }}
    >
      {children}
    </span>
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

function StepperDots({ step }: { step: WizardStep }) {
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

export function WizardHeader({
  step,
  title,
  onClose,
}: {
  step: WizardStep;
  title: string;
  onClose: () => void;
}) {
  const titles: Record<WizardStep, string> = {
    1: "Elige una plantilla",
    2: "Frontmatter",
    3: "Editor del cuerpo",
    4: "Destino y confirmación",
  };
  return (
    <div
      className="flex items-center gap-3 border-b p-3"
      style={{ borderColor: "var(--color-border)" }}
    >
      <Plus size={16} />
      <h2 className="text-sm font-semibold">{title}</h2>
      <StepperDots step={step} />
      <span
        className="ml-auto text-xs"
        style={{ color: "var(--color-text-muted)" }}
      >
        Paso {step} / 4 — {titles[step]}
      </span>
      <button
        className="rounded p-1 hover:bg-[var(--color-surface-2)]"
        onClick={onClose}
        aria-label="Cerrar"
      >
        <X size={14} />
      </button>
    </div>
  );
}

type WizardFooterProps = {
  step: WizardStep;
  canAdvance: boolean;
  canSubmit: boolean;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** Texto del botón final, p. ej. «Crear skill». */
  submitLabel: string;
};

export function WizardFooter(props: WizardFooterProps) {
  const { step, canAdvance, canSubmit, busy, onBack, onNext, onCancel, onSubmit, submitLabel } = props;
  return (
    <div
      className="flex items-center justify-between gap-2 border-t p-3"
      style={{ borderColor: "var(--color-border)" }}
    >
      <button
        className="inline-flex items-center gap-1 rounded border px-3 py-1 text-xs disabled:opacity-50"
        style={{ borderColor: "var(--color-border)" }}
        onClick={step === 1 ? onCancel : onBack}
        disabled={busy}
      >
        {step === 1 ? "Cancelar" : <><ChevronLeft size={12} /> Atrás</>}
      </button>
      <div className="flex items-center gap-2">
        {step < 4 ? (
          <button
            className="inline-flex items-center gap-1 rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            onClick={onNext}
            disabled={!canAdvance || busy}
          >
            Siguiente <ChevronRight size={12} />
          </button>
        ) : (
          <button
            className="rounded px-3 py-1 text-xs font-medium disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            onClick={onSubmit}
            disabled={!canSubmit || busy}
          >
            {busy ? "Creando…" : submitLabel}
          </button>
        )}
      </div>
    </div>
  );
}
