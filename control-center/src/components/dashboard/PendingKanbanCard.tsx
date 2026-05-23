// Pending cards for the most-recent project. We pick the project with the
// freshest `last_active` as the "active project" stand-in — the Projects tab
// itself owns the canonical selection and we don't share state with it.

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
        const pending = board.cards
          .filter((c) => !doneColumns.has(c.column_id))
          .sort((a, b) => a.order - b.order)
          .slice(0, 5)
          .map((c) => ({ id: c.id, title: c.title }));
        const doneCount = board.cards.length - pending.length;
        if (!cancelled) {
          setState({
            projectName: active.name ?? active.id,
            pending,
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
      title={
        state
          ? `Pending - ${state.projectName}`
          : "Pending kanban"
      }
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
        <SmallButton onClick={onOpenProjects} title="Open Projects tab">
          open
        </SmallButton>
      }
    >
      {state && state.pending.length > 0 && (
        <ul className="space-y-1">
          {state.pending.map((c) => (
            <li
              key={c.id}
              className="truncate text-[11.5px]"
              style={{ color: "var(--color-text)" }}
              title={c.title}
            >
              <span
                className="mr-1.5 inline-block h-1 w-1 rounded-full align-middle"
                style={{ background: "var(--color-text-tertiary)" }}
              />
              {c.title}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
