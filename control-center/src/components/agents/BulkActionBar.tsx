// Bulk enable / disable bar — visible in select mode, mirrors Skills.tsx.

import { AGENT_ACCENT, AGENT_ACCENT_SOFT } from "./types";

interface BulkActionBarProps {
  checkedCount: number;
  bulkBusy: boolean;
  onBulkEnable: () => void;
  onBulkDisable: () => void;
}

export function BulkActionBar({
  checkedCount,
  bulkBusy,
  onBulkEnable,
  onBulkDisable,
}: BulkActionBarProps) {
  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-xs"
      style={{
        background: AGENT_ACCENT_SOFT,
        border: `1px solid ${AGENT_ACCENT}`,
        color: "var(--color-text)",
      }}
    >
      <span style={{ color: "var(--color-text-secondary)" }}>
        {checkedCount} seleccionado{checkedCount === 1 ? "" : "s"} (solo global)
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBulkEnable}
          disabled={bulkBusy || checkedCount === 0}
          className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
          style={{
            borderColor: "var(--color-success)",
            background: "transparent",
            color: "var(--color-success)",
          }}
        >
          {bulkBusy ? "Aplicando…" : "Activar seleccionados"}
        </button>
        <button
          type="button"
          onClick={onBulkDisable}
          disabled={bulkBusy || checkedCount === 0}
          className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
          style={{
            borderColor: "var(--color-danger)",
            background: "transparent",
            color: "var(--color-danger)",
          }}
        >
          {bulkBusy ? "Aplicando…" : "Desactivar seleccionados"}
        </button>
      </div>
    </div>
  );
}
