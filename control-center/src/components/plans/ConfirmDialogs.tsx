// ConfirmDialogs — delete and archive-resolved confirmation modals.
// Extracted from Plans.tsx as part of the cat7 split refactor.

import type { PlanItem } from "./types";

export function DeleteConfirmDialog({
  plan,
  busy,
  onConfirm,
  onCancel,
}: {
  plan: PlanItem;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={() => !busy && onCancel()}
    >
      <div
        className="w-full max-w-[420px] rounded p-5"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[14px] font-semibold">Borrar plan</h3>
        <p
          className="mt-2 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          ¿Quitar <b>{plan.title || plan.id}</b> de
          PLANS.json? El cambio es atómico (tmp+rename). La spec en
          disco no se toca.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--color-danger)",
              color: "#fff",
            }}
          >
            {busy ? "Borrando…" : "Borrar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ArchiveConfirmDialog({
  resolvedCount,
  busy,
  onConfirm,
  onCancel,
}: {
  resolvedCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-6"
      style={{ background: "rgba(0,0,0,0.55)" }}
      onClick={() => !busy && onCancel()}
    >
      <div
        className="w-full max-w-[440px] rounded p-5"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[14px] font-semibold">Archivar resueltos</h3>
        <p
          className="mt-2 text-[12.5px] leading-relaxed"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Mueve los {resolvedCount} planes con status="resolved" a
          plans/_archive/resolved-YYYY-MM.json y los quita de PLANS.json.
          Se conservan en disco, no se borran. Atómico (tmp+rename).
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px] font-medium"
            style={{
              background: "var(--color-danger)",
              color: "#fff",
            }}
          >
            {busy ? "Archivando…" : `Archivar ${resolvedCount}`}
          </button>
        </div>
      </div>
    </div>
  );
}
