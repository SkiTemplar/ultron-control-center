// Recent delegations strip — pinned above the agent grid.

import { useState } from "react";
import type { DelegationLogEntry } from "./types";
import { diceBearUrl, ageFromEpochField, statusChip } from "./helpers";

interface DelegationsStripProps {
  delegations: DelegationLogEntry[];
}

export function DelegationsStrip({ delegations }: DelegationsStripProps) {
  const [showAllRuns, setShowAllRuns] = useState(false);

  if (delegations.length === 0) return null;

  return (
    <section className="mb-4">
      <div className="mb-1.5 flex items-center justify-between">
        <span
          className="text-[11px] uppercase tracking-wide"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Recent runs ({delegations.length})
        </span>
        {delegations.length > 3 && (
          <button
            type="button"
            onClick={() => setShowAllRuns((v) => !v)}
            className="text-[11px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            {showAllRuns ? "Show fewer" : `Show all ${delegations.length}`}
          </button>
        )}
      </div>
      <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {(showAllRuns ? delegations : delegations.slice(0, 3)).map((d) => {
          const chip = statusChip(d.status);
          return (
            <li
              key={d.id}
              className="flex gap-2 rounded-md p-2 text-xs"
              style={{
                border: "1px solid var(--color-border-strong)",
                background: "var(--color-surface-2)",
              }}
            >
              <img
                src={diceBearUrl(d.agent)}
                alt=""
                width={32}
                height={32}
                className="shrink-0 rounded"
                style={{ background: "var(--color-surface-3)" }}
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span
                    className="truncate font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {d.agent}
                  </span>
                  <span
                    className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium"
                    style={{ background: chip.bg, color: chip.fg }}
                  >
                    {chip.label}
                  </span>
                  {d.cheap_model_requested && (
                    <span
                      className="shrink-0 rounded px-1 py-px text-[9px] uppercase"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-tertiary)",
                      }}
                      title="Spawned with Haiku 4.5 (cheap model)"
                    >
                      Haiku
                    </span>
                  )}
                </div>
                <p
                  className="mt-0.5 line-clamp-2 leading-snug"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {d.task_preview}
                </p>
                <div
                  className="mt-0.5 flex items-center gap-2 text-[10px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  <span>{ageFromEpochField(d.started_at)}</span>
                  {d.cwd && (
                    <span
                      className="truncate"
                      style={{ fontFamily: "var(--font-mono)" }}
                      title={d.cwd}
                    >
                      {d.cwd}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
