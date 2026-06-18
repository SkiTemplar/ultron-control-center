import type { Step } from "./types";
import { Plus, X } from "../icons";

function StepperDots({ step }: { step: Step }) {
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
      <h2 className="text-sm font-semibold">New skill</h2>
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
