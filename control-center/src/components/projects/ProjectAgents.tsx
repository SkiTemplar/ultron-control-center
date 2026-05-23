// ULTRON Control Center 2.0 — Per-project Agents view
//
// Composes a scope-filtered Agents listing with project-specific pinning + a
// default-agent picker. Heavy lifting (search, install, edit) is delegated to
// the global Agents component built in P2 — here we only wrap with project
// context.
//
// TODO(next-session): full Orchestrator panel — multi-agent dispatch queue,
// per-agent live status (idle/running/blocked), parallel-launch matrix
// ("run agent A on cards 1,3,5 while agent B handles 2,4"), and a kill-all
// switch wired to pty_list + pty_kill. The current view is read-only browse
// + pin only; orchestration UI ships next pass.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pin, PinOff } from "./icons";
import { Agents } from "../Agents";
import type { KanbanBoard } from "../../types";

type Props = { projectId: string };

type AgentEntry = {
  name: string;
  path: string;
  description: string;
  origin: "global" | "project" | "plugin";
};

type PinnedAgents = { pinned: string[] };

export default function ProjectAgents({ projectId }: Props) {
  const [pinned, setPinned] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    try {
      const [p, list, b] = await Promise.all([
        invoke("agents_pinned_load", { projectId }) as Promise<PinnedAgents>,
        invoke("list_agents", { projectPath: null }) as Promise<AgentEntry[]>,
        invoke("kanban_load", { projectId }) as Promise<KanbanBoard>,
      ]);
      setPinned(p.pinned);
      setAgents(list);
      setBoard(b);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const togglePin = useCallback(
    async (slug: string) => {
      const next = pinned.includes(slug)
        ? pinned.filter((p) => p !== slug)
        : [...pinned, slug];
      setPinned(next);
      try {
        await invoke("agents_pinned_save", {
          projectId,
          pinned: { pinned: next },
        });
      } catch (e) {
        setError(String(e));
        await loadAll();
      }
    },
    [pinned, projectId, loadAll],
  );

  const setDefaultAgent = useCallback(
    async (slug: string | null) => {
      if (!board) return;
      const next: KanbanBoard = { ...board, default_agent: slug };
      try {
        await invoke("kanban_save", { board: next });
        setBoard(next);
      } catch (e) {
        setError(String(e));
      }
    },
    [board],
  );

  const sorted = [...agents].sort((a, b) => {
    const ap = pinned.includes(a.name);
    const bp = pinned.includes(b.name);
    if (ap !== bp) return ap ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs">
        <span className="text-[var(--color-text-muted)]">Project default agent:</span>
        <select
          value={board?.default_agent ?? ""}
          onChange={(e) => void setDefaultAgent(e.target.value || null)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
        >
          <option value="">(none)</option>
          {sorted.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        {error && <span className="ml-auto text-[var(--color-error)]">{error}</span>}
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        <div className="mb-3 grid gap-1.5">
          {sorted.map((a) => {
            const isPinned = pinned.includes(a.name);
            return (
              <div
                key={a.name}
                className="flex items-start justify-between rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-xs"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{a.name}</span>
                    <span className="rounded bg-[var(--color-surface-2)] px-1 py-0.5 text-[10px]">
                      {a.origin}
                    </span>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[var(--color-text-muted)]">
                    {a.description}
                  </p>
                </div>
                <button
                  onClick={() => void togglePin(a.name)}
                  className="ml-2 rounded p-1 hover:bg-[var(--color-surface-2)]"
                  aria-label={isPinned ? "Unpin" : "Pin"}
                  title={isPinned ? "Unpin" : "Pin"}
                >
                  {isPinned ? <Pin size={12} /> : <PinOff size={12} />}
                </button>
              </div>
            );
          })}
        </div>
        <details className="mt-4">
          <summary className="cursor-pointer text-xs text-[var(--color-text-muted)]">
            Full agents browser (global library)
          </summary>
          <div className="mt-2 rounded-md border border-[var(--color-border)]">
            <Agents />
          </div>
        </details>
      </div>
    </div>
  );
}
