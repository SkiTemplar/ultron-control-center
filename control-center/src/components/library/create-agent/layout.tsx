import { ChevronLeft, ChevronRight, Plus, X } from "../icons";
import type { Step } from "./types";
import { StepperDots } from "./atoms";

export function Header({ step, onClose }: { step: Step; onClose: () => void }) {
  const titles: Record<Step, string> = {
    1: "Pick a template",
    2: "Frontmatter",
    3: "Body editor",
    4: "Target & confirm",
  };
  return (
    <div
      className="flex items-center gap-3 border-b p-3"
      style={{ borderColor: "var(--color-border)" }}
    >
      <Plus size={16} />
      <h2 className="text-sm font-semibold">New agent</h2>
      <StepperDots step={step} />
      <span
        className="ml-auto text-xs"
        style={{ color: "var(--color-text-muted)" }}
      >
        Step {step} / 4 — {titles[step]}
      </span>
      <button
        className="rounded p-1 hover:bg-[var(--color-surface-2)]"
        onClick={onClose}
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function Footer(props: {
  step: Step;
  canAdvance: boolean;
  canSubmit: boolean;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { step, canAdvance, canSubmit, busy, onBack, onNext, onCancel, onSubmit } = props;
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
        {step === 1 ? "Cancel" : <><ChevronLeft size={12} /> Back</>}
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
            Next <ChevronRight size={12} />
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
            {busy ? "Creating..." : "Create agent"}
          </button>
        )}
      </div>
    </div>
  );
}
