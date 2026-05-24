// ULTRON Control Center 2.6 — Per-project Agents view
//
// v2.6 rewrite: clean two-section layout.
//   1. Pinned agents — Library-style card grid (origin badge + description +
//      "Remove from project" button). Empty state nudges the user to add
//      one with the picker below.
//   2. Workflows — predefined multi-agent recipe tiles (Chief of staff,
//      Backend review, Frontend review, Code audit). No workflow backend
//      exists yet (v2.6); clicking a tile fires a toast placeholder so the
//      UI shows the intent without faking execution.
//   3. "+ Add agent to project" opens an overlay picker listing every
//      available agent (global / project / plugin) with a one-click pin.
//
// Backend wiring stays the same: `agents_pinned_load`, `agents_pinned_save`,
// `list_agents`, `kanban_load` / `kanban_save` for the default-agent select.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pin, PinOff, Plus, X } from "./icons";
import type { KanbanBoard } from "../../types";

type Props = { projectId: string };

type AgentEntry = {
  name: string;
  path: string;
  description: string;
  origin: "global" | "project" | "plugin";
};

type PinnedAgents = { pinned: string[] };

type Workflow = {
  id: string;
  label: string;
  description: string;
  accent: string;
};

const WORKFLOWS: Workflow[] = [
  {
    id: "chief-of-staff",
    label: "Chief of staff",
    description:
      "Triage open cards, summarise pending work, and assign next actions across pinned agents.",
    accent: "var(--color-accent)",
  },
  {
    id: "backend-review",
    label: "Backend review",
    description:
      "Run a focused review on backend code: API surface, persistence, error handling.",
    accent: "#7aa2f7",
  },
  {
    id: "frontend-review",
    label: "Frontend review",
    description:
      "Audit UI: component structure, accessibility, design tokens, render perf.",
    accent: "#f7768e",
  },
  {
    id: "code-audit",
    label: "Code audit",
    description:
      "Repo-wide static audit: dead code, unused deps, secret leaks, lint debt.",
    accent: "#e0af68",
  },
];

function originStyle(origin: AgentEntry["origin"]): {
  background: string;
  color: string;
  border: string;
} {
  switch (origin) {
    case "global":
      return {
        background: "var(--color-surface-3)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
      };
    case "project":
      return {
        background: "rgba(136, 136, 204, 0.16)",
        color: "#b6b6ff",
        border: "1px solid rgba(136, 136, 204, 0.40)",
      };
    case "plugin":
      return {
        background: "rgba(231, 187, 99, 0.16)",
        color: "#e0af68",
        border: "1px solid rgba(231, 187, 99, 0.40)",
      };
  }
}

export default function ProjectAgents({ projectId }: Props) {
  const [pinned, setPinned] = useState<string[]>([]);
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);

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

  // Auto-dismiss toast after 3s — used by workflow placeholders.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // ESC closes the picker overlay.
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen]);

  const setPinnedRemote = useCallback(
    async (next: string[]) => {
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
    [projectId, loadAll],
  );

  const pinAgent = useCallback(
    (slug: string) => {
      if (pinned.includes(slug)) return;
      void setPinnedRemote([...pinned, slug]);
    },
    [pinned, setPinnedRemote],
  );

  const unpinAgent = useCallback(
    (slug: string) => {
      void setPinnedRemote(pinned.filter((p) => p !== slug));
    },
    [pinned, setPinnedRemote],
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

  // Pinned-agent cards: filter the global list by `pinned[]` and keep the
  // user's pin order so reordering (future) maps to display order.
  const pinnedAgents = useMemo(() => {
    const byName = new Map(agents.map((a) => [a.name, a] as const));
    return pinned
      .map((name) => byName.get(name))
      .filter((a): a is AgentEntry => Boolean(a));
  }, [agents, pinned]);

  // Picker list: every agent NOT currently pinned, filtered by the query.
  const pickerCandidates = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return agents
      .filter((a) => !pinned.includes(a.name))
      .filter((a) =>
        q === ""
          ? true
          : a.name.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, pinned, pickerQuery]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header: default-agent select + add-agent action */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs">
        <span className="text-[var(--color-text-muted)]">Default agent:</span>
        <select
          value={board?.default_agent ?? ""}
          onChange={(e) => void setDefaultAgent(e.target.value || null)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
          title="Used when a kanban card has no explicit agent override."
        >
          <option value="">(none)</option>
          {pinnedAgents.map((a) => (
            <option key={a.name} value={a.name}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            setPickerQuery("");
            setPickerOpen(true);
          }}
          className="ml-auto inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-2)]"
          title="Pick an agent from the global catalogue and pin it to this project."
        >
          <Plus size={12} />
          Add agent to project
        </button>
        {error && (
          <span className="ml-2 text-[var(--color-error)]" title={error}>
            error
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {/* Pinned agents — Library-style cards */}
        <section className="mb-5">
          <h3 className="mb-2 text-[11.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Pinned agents ({pinnedAgents.length})
          </h3>
          {pinnedAgents.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-0)] p-4 text-center text-xs text-[var(--color-text-muted)]">
              No agents pinned yet. Use{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setPickerQuery("");
                  setPickerOpen(true);
                }}
              >
                Add agent to project
              </button>{" "}
              to surface the agents you want for this workspace.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {pinnedAgents.map((a) => {
                const chip = originStyle(a.origin);
                return (
                  <div
                    key={a.name}
                    className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-xs transition-colors hover:border-[var(--color-border-strong)]"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Pin size={12} />
                        <span className="font-semibold text-[var(--color-text)]">
                          {a.name}
                        </span>
                      </div>
                      <span
                        className="rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                        style={chip}
                      >
                        {a.origin}
                      </span>
                    </div>
                    <p className="line-clamp-3 flex-1 text-[var(--color-text-muted)]">
                      {a.description || (
                        <span className="italic text-[var(--color-text-faint)]">
                          No description.
                        </span>
                      )}
                    </p>
                    <div className="mt-1 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => unpinAgent(a.name)}
                        className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-[11.5px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                        title="Unpin this agent from the project (does not delete the agent)."
                      >
                        <PinOff size={11} /> Remove from project
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Workflows — predefined multi-agent recipe tiles. Placeholder UX
            until the orchestration backend lands. */}
        <section>
          <h3 className="mb-2 text-[11.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Workflows
          </h3>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {WORKFLOWS.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() =>
                  setToast(`Workflow "${w.label}" would launch (backend coming soon)`)
                }
                className="flex flex-col items-start gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-left text-xs transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"
                title={`Launch the ${w.label} workflow (placeholder).`}
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ background: w.accent }}
                  />
                  <span className="font-semibold text-[var(--color-text)]">
                    {w.label}
                  </span>
                </div>
                <p className="text-[var(--color-text-muted)]">{w.description}</p>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Toast — workflow-launch placeholder feedback. */}
      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-3)] px-3 py-2 text-xs text-[var(--color-text)] shadow-lg"
        >
          {toast}
        </div>
      )}

      {/* Picker overlay — pin a new agent from the global catalogue. */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Add agent to project"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="my-auto flex w-full max-w-2xl flex-col rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
              <h2 className="text-sm font-semibold">Add agent to project</h2>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                aria-label="Close"
                className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-3)]"
              >
                <X size={12} />
              </button>
            </div>
            <div className="border-b border-[var(--color-border)] p-2">
              <input
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Filter agents by name or description…"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1.5 text-xs outline-none"
                autoFocus
              />
            </div>
            <div className="max-h-[60vh] overflow-y-auto p-2">
              {pickerCandidates.length === 0 ? (
                <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                  {pinned.length === agents.length
                    ? "Every available agent is already pinned."
                    : "No agents match your filter."}
                </div>
              ) : (
                <ul className="grid gap-1.5">
                  {pickerCandidates.map((a) => {
                    const chip = originStyle(a.origin);
                    return (
                      <li
                        key={a.name}
                        className="flex items-start justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold">{a.name}</span>
                            <span
                              className="rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                              style={chip}
                            >
                              {a.origin}
                            </span>
                          </div>
                          <p className="mt-0.5 line-clamp-2 text-[var(--color-text-muted)]">
                            {a.description}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => pinAgent(a.name)}
                          className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-1 text-[11.5px] hover:bg-[var(--color-surface-3)]"
                          title="Pin this agent to the project."
                        >
                          <Pin size={11} /> Pin
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-3)]"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
