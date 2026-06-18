import type { KanbanArchiveSummary } from "../../../types";

type ArchiveGridProps = {
  archivesLoading: boolean;
  archives: KanbanArchiveSummary[];
  onOpenArchive: (name: string) => void;
};

export function ArchiveGrid({ archivesLoading, archives, onOpenArchive }: ArchiveGridProps) {
  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-3">
      <div className="mb-2 text-[11.5px] text-[var(--color-text-tertiary)]">
        {archivesLoading
          ? "Loading archives…"
          : archives.length === 0
            ? "No archives yet — use 'Archive Done' to create one."
            : `${archives.length} archive group${archives.length === 1 ? "" : "s"}`}
      </div>
      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
      >
        {archives.map((a) => (
          <button
            key={a.name}
            type="button"
            onClick={() => void onOpenArchive(a.name)}
            className="flex h-[120px] flex-col justify-between rounded-md p-3 text-left transition-all hover:-translate-y-px"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              boxShadow: "inset 0 2px 0 var(--color-border)",
            }}
            title={`${a.card_count} card${a.card_count === 1 ? "" : "s"} archived ${a.archived_at}`}
          >
            <div className="text-[10px] uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
              Archive
            </div>
            <div className="truncate text-[14px] font-semibold text-[var(--color-text)]">
              {a.name}
            </div>
            <div className="flex items-center justify-between text-[10.5px] text-[var(--color-text-faint)]">
              <span>{a.archived_at}</span>
              <span
                className="rounded px-1.5 py-0.5 tabular-nums"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-secondary)",
                }}
              >
                {a.card_count}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
