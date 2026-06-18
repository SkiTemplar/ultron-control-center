import type { KanbanArchive } from "../../../types";

type ArchiveViewerModalProps = {
  openedArchive: KanbanArchive;
  onClose: () => void;
};

export function ArchiveViewerModal({ openedArchive, onClose }: ArchiveViewerModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="my-8 w-full max-w-3xl rounded-md bg-[var(--color-surface-1)] p-4 shadow-lg"
        style={{ border: "1px solid var(--color-border-strong)" }}
      >
        <div className="flex items-baseline justify-between">
          <div>
            <h3 className="text-[14px] font-semibold text-[var(--color-text)]">
              Archive · {openedArchive.name}
            </h3>
            <p className="mt-0.5 text-[11.5px] text-[var(--color-text-tertiary)]">
              {openedArchive.cards.length} card
              {openedArchive.cards.length === 1 ? "" : "s"} · archived{" "}
              {openedArchive.archived_at}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[11.5px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Close
          </button>
        </div>
        <div className="mt-3 max-h-[60vh] space-y-1.5 overflow-y-auto pr-1">
          {openedArchive.cards.map((c) => (
            <div
              key={c.id}
              className="rounded-md p-2 text-xs"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="font-medium text-[var(--color-text)]">
                {c.title}
              </div>
              {c.description && (
                <div className="mt-0.5 whitespace-pre-wrap text-[11px] text-[var(--color-text-secondary)]">
                  {c.description}
                </div>
              )}
              {c.tags.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.tags.map((t) => (
                    <span
                      key={t}
                      className="rounded px-1.5 py-0.5 text-[9.5px]"
                      style={{
                        background: "var(--color-surface-0)",
                        color: "var(--color-text-tertiary)",
                      }}
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
