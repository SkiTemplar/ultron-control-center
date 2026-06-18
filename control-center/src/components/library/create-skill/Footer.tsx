import type { Step } from "./types";
import { ChevronLeft, ChevronRight } from "../icons";

type FooterProps = {
  step: Step;
  canAdvance: boolean;
  canSubmit: boolean;
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export function Footer(props: FooterProps) {
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
            {busy ? "Creating..." : "Create skill"}
          </button>
        )}
      </div>
    </div>
  );
}
