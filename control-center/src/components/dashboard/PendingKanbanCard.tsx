// Pending cards for the most-recent project. We pick the project with the
// freshest `last_active` as the "active project" stand-in — the Projects tab
// itself owns the canonical selection and we don't share state with it.
//
// v2.7 redesign: bigger card, 13px content baseline, room for 5 items + a
// done-count footer so the user gets a real sense of inbox load.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { KanbanBoard, ProjectInfo } from "../../types";
import { Card, SmallButton } from "./Card";

interface PendingKanbanCardProps {
  onOpenProjects?: () => void;
}

interface PendingState {
  projectName: string;
  pending: { id: string; title: string }[];
  totalPending: number;
  doneCount: number;
}

export function PendingKanbanCard({ onOpenProjects }: PendingKanbanCardProps) {
  const [state, setState] = useState<PendingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const projects = await invoke<ProjectInfo[]>("list_projects");
        const sorted = projects
          .slice()
          .sort((a, b) => {
            const at = a.last_active ?? "";
            const bt = b.last_active ?? "";
            return at < bt ? 1 : at > bt ? -1 : 0;
          });
        const active = sorted[0];
        if (!active) {
          if (!cancelled) setState(null);
          return;
        }
        const board = await invoke<KanbanBoard>("kanban_load", {
          projectId: active.id,
        });
        const doneColumns = new Set(
          board.columns
            .filter((c) => /done|complete|archiv/i.test(c.name))
            .map((c) => c.id),
        );
        const allPending = board.cards
          .filter((c) => !doneColumns.has(c.column_id))
          .sort((a, b) => a.order - b.order);
        const pending = allPending.slice(0, 5).map((c) => ({
          id: c.id,
          title: c.title,
        }));
        const doneCount = board.cards.length - allPending.length;
        if (!cancelled) {
          setState({
            projectName: active.name ?? active.id,
            pending,
            totalPending: allPending.length,
            doneCount,
          });
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card
      title="Pending"
      subtitle={state ? state.projectName : undefined}
      loading={loading}
      error={error}
      empty={
        !loading && !error && !state
          ? "No active project."
          : !loading && state && state.pending.length === 0
            ? "Inbox clear."
            : null
      }
      action={
        <SmallButton
          onClick={onOpenProjects}
          size="md"
          title="Open Projects tab"
        >
          Open
        </SmallButton>
      }
    >
      {state && state.pending.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            <span
              className="text-[20px] font-semibold leading-none tabular-nums"
              style={{ color: "var(--color-text)" }}
            >
              {state.totalPending}
            </span>
            <span
              className="text-[12.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {state.totalPending === 1 ? "card pending" : "cards pending"}
            </span>
            {state.doneCount > 0 && (
              <span
                className="ml-auto tabular-nums text-[11px]"
                style={{ color: "var(--color-text-faint)" }}
              >
                {state.doneCount} done
              </span>
            )}
          </div>
          <ul className="space-y-1.5">
            {state.pending.map((c) => (
              <li
                key={c.id}
                className="flex items-baseline gap-2 truncate text-[13px]"
                style={{ color: "var(--color-text)" }}
                title={c.title}
              >
                <span
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: "var(--color-text-tertiary)" }}
                />
                <span className="truncate">{c.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
