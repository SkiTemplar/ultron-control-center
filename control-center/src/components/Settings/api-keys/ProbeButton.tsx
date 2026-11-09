// Settings/api-keys/ProbeButton.tsx — «Probar» + resultado en línea: cuántos
// modelos ve el proveedor o el error devuelto por el backend.

import type { ProbeState } from "./useModelProbe";

interface ProbeButtonProps {
  state: ProbeState | undefined;
  onProbe: () => void;
}

function resultText(state: ProbeState | undefined): { text: string; color: string; title?: string } | null {
  if (!state || state.status === "running") return null;
  if (state.status === "error") return { text: state.message, color: "var(--color-danger)" };
  const n = state.models.length;
  return {
    text: n === 0 ? "Responde, pero no lista ningún modelo." : `Ve ${n} modelo${n === 1 ? "" : "s"}.`,
    color: n === 0 ? "var(--color-warning, #f8a000)" : "var(--color-success)",
    title: state.models.slice(0, 40).join("\n"),
  };
}

export function ProbeButton({ state, onProbe }: ProbeButtonProps) {
  const running = state?.status === "running";
  const result = resultText(state);
  return (
    <div className="mt-1.5 flex items-start gap-2">
      <button
        type="button"
        onClick={onProbe}
        disabled={running}
        className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
          color: "var(--color-text-secondary)",
        }}
        title="Pide la lista de modelos al proveedor con la key guardada"
      >
        {running ? "Probando…" : "Probar"}
      </button>
      {result && (
        <span className="min-w-0 pt-0.5 text-[11px]" style={{ color: result.color }} title={result.title}>
          {result.text}
        </span>
      )}
    </div>
  );
}
