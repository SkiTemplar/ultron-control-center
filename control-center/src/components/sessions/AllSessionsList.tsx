import type { ClaudeSession } from "../../types";
import { History } from "../projects/icons";
import { formatBytes, formatRel } from "./utils";

type AllSessionsListProps = {
  history: ClaudeSession[];
  filteredHistory: ClaudeSession[];
  historyLoading: boolean;
  showAllSessions: boolean;
  search: string;
  onToggle: () => void;
  onResume: (s: ClaudeSession) => void;
};

export function AllSessionsList({
  history,
  filteredHistory,
  historyLoading,
  showAllSessions,
  search,
  onToggle,
  onResume,
}: AllSessionsListProps) {
  return (
    <section className="mb-6">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        <History size={13} />
        <span className="text-[12.5px] font-semibold">
          All Claude sessions
        </span>
        <span
          className="text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {historyLoading
            ? "loading…"
            : `${filteredHistory.length} of ${history.length}`}
        </span>
        <span
          className="ml-auto text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {showAllSessions ? "hide" : "show"}
        </span>
      </button>

      {showAllSessions && (
        <div
          className="mt-2 rounded p-4"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          {!historyLoading && filteredHistory.length === 0 && (
            <div
              className="rounded p-4 text-center text-[12px]"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-tertiary)",
              }}
            >
              {history.length === 0
                ? "No sessions recorded yet."
                : `No session matches "${search}".`}
            </div>
          )}
          <div className="space-y-1.5">
            {filteredHistory.map((s) => {
              return (
                <div
                  key={`${s.project_slug}-${s.id}`}
                  className="rounded p-3 transition-colors"
                  style={{
                    background: "var(--color-surface-1)",
                    border: "1px solid var(--color-border)",
                  }}
                >
                  <div className="flex items-baseline gap-3">
                    <span
                      className="truncate text-[11.5px]"
                      style={{
                        fontFamily: "var(--font-mono)",
                        color: "var(--color-text-tertiary)",
                      }}
                      title={s.project_label}
                    >
                      {s.project_label}
                    </span>
                    <span
                      className="ml-auto shrink-0 tabular-nums text-[10.5px]"
                      style={{ color: "var(--color-text-faint)" }}
                    >
                      {formatRel(s.last_activity)} · {s.line_count} turns ·{" "}
                      {formatBytes(s.size_bytes)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onResume(s)}
                      className="shrink-0 rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors"
                      style={{
                        background: "var(--color-accent)",
                        color: "var(--color-accent-text)",
                      }}
                      title={`claude -r ${s.id}`}
                    >
                      Resume
                    </button>
                  </div>
                  {s.preview && (
                    <div
                      className="mt-1 line-clamp-2 text-[12px] leading-relaxed"
                      style={{ color: "var(--color-text-secondary)" }}
                    >
                      {s.preview}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
