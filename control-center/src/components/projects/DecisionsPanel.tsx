// ULTRON Control Center — DecisionsPanel (KIRKARDO 24)
//
// Sticky right-side panel (300 px) in ProjectBoard. Displays per-project
// decisions with amber border; click expands detail. No drag-drop interaction
// with kanban cards. "+ Add decision" opens DecisionEditor modal.
//
// Layout decision: fixed-width sidebar (300px), collapsible via a toggle
// chevron in the header. Collapsed state shows only the header strip (32px)
// so the board gains full width. State is component-local (no URL / store
// persistence needed — collapseability is pure UX comfort).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DecisionRecord, DecisionStatus } from "../../types";
import DecisionEditor from "./DecisionEditor";

const STATUS_COLORS: Record<DecisionStatus, string> = {
  proposed:
    "bg-blue-900/40 text-blue-300 border border-blue-700/50",
  accepted:
    "bg-emerald-900/40 text-emerald-300 border border-emerald-700/50",
  superseded:
    "bg-neutral-700/60 text-neutral-400 border border-neutral-600/50",
  rejected:
    "bg-red-900/30 text-red-400 border border-red-700/50",
};

const STATUS_LABELS: Record<DecisionStatus, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  superseded: "Superseded",
  rejected: "Rejected",
};

function epochToRelative(date: string): string {
  const match = date.match(/^epoch:(\d+)$/);
  if (!match) return date;
  const secs = parseInt(match[1], 10);
  const diff = Math.floor(Date.now() / 1000) - secs;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(secs * 1000).toLocaleDateString();
}

interface Props {
  projectId: string;
}

export default function DecisionsPanel({ projectId }: Props) {
  const [records, setRecords] = useState<DecisionRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editor, setEditor] = useState<
    | { mode: "create" }
    | { mode: "edit"; record: DecisionRecord }
    | null
  >(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = (await invoke("decisions_list", {
        projectId,
      })) as DecisionRecord[];
      setRecords(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  function handleSaved(record: DecisionRecord) {
    setRecords((prev) => {
      const idx = prev.findIndex((r) => r.id === record.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = record;
        return next;
      }
      return [record, ...prev];
    });
    setEditor(null);
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this decision? This cannot be undone.")) return;
    setDeleting(id);
    try {
      await invoke("decisions_delete", { projectId, id });
      setRecords((prev) => prev.filter((r) => r.id !== id));
      if (expanded === id) setExpanded(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(null);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => (prev === id ? null : id));
  }

  // ---------------------------------------------------------------------------
  // Render: collapsed strip
  // ---------------------------------------------------------------------------
  if (collapsed) {
    return (
      <div
        className="flex h-full w-8 flex-shrink-0 cursor-pointer flex-col items-center justify-start border-l border-amber-500/30 bg-neutral-900/60 pt-4"
        onClick={() => setCollapsed(false)}
        title="Show Decisions panel"
      >
        <span className="text-xs text-amber-400 [writing-mode:vertical-rl] rotate-180 select-none">
          Decisions ({records.length})
        </span>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Render: full panel
  // ---------------------------------------------------------------------------
  return (
    <>
      <div className="flex h-full w-[300px] flex-shrink-0 flex-col border-l border-amber-500/30 bg-neutral-900/80">
        {/* Panel header */}
        <div className="flex items-center justify-between border-b border-amber-500/20 px-3 py-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-amber-400">
            Decisions
            {records.length > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-900/50 px-1.5 py-0.5 text-amber-300">
                {records.length}
              </span>
            )}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setEditor({ mode: "create" })}
              className="rounded p-1 text-xs text-amber-400 hover:bg-amber-900/30 hover:text-amber-300 transition-colors"
              title="Add decision"
            >
              + Add
            </button>
            <button
              onClick={() => setCollapsed(true)}
              className="rounded p-1 text-neutral-500 hover:text-neutral-300 transition-colors"
              title="Collapse panel"
              aria-label="Collapse decisions panel"
            >
              ›
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
          {/* Loading skeleton */}
          {loading && records.length === 0 && (
            <div className="space-y-2 p-1">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-14 animate-pulse rounded-md bg-neutral-800"
                />
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-md border border-red-700/40 bg-red-900/20 p-2 text-xs text-red-400">
              {error}
              <button
                onClick={load}
                className="ml-2 underline hover:text-red-300"
              >
                retry
              </button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && records.length === 0 && (
            <div className="flex flex-col items-center gap-2 pt-8 text-center">
              <p className="text-xs text-neutral-500">No decisions yet.</p>
              <p className="text-xs text-neutral-600">
                Capture architectural choices, stack picks, and trade-off
                rationale here.
              </p>
              <button
                onClick={() => setEditor({ mode: "create" })}
                className="mt-2 rounded-md border border-amber-600/50 px-3 py-1.5 text-xs text-amber-400 hover:bg-amber-900/30 transition-colors"
              >
                + Add first decision
              </button>
            </div>
          )}

          {/* Decision list */}
          {records.map((rec) => {
            const isExpanded = expanded === rec.id;
            return (
              <div
                key={rec.id}
                className="rounded-md border border-amber-500/20 bg-neutral-800/70 hover:border-amber-500/40 transition-colors"
              >
                {/* Row header — always visible */}
                <div
                  className="flex cursor-pointer items-start justify-between gap-2 p-2"
                  onClick={() => toggleExpand(rec.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p
                      className="truncate text-xs font-medium text-neutral-100"
                      style={{ maxWidth: "200px" }}
                      title={rec.decision}
                    >
                      {rec.decision}
                    </p>
                    <div className="mt-0.5 flex items-center gap-1.5 flex-wrap">
                      <span
                        className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_COLORS[rec.status]}`}
                      >
                        {STATUS_LABELS[rec.status]}
                      </span>
                      <span className="text-[10px] text-neutral-500">
                        {epochToRelative(rec.date)}
                      </span>
                      {rec.author && (
                        <span className="text-[10px] text-neutral-600">
                          {rec.author}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="flex-shrink-0 text-[10px] text-neutral-600">
                    {isExpanded ? "▲" : "▼"}
                  </span>
                </div>

                {/* Expanded detail */}
                {isExpanded && (
                  <div className="border-t border-amber-500/10 px-3 pb-3 pt-2 space-y-2">
                    {/* Rationale */}
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                        Rationale
                      </p>
                      <p className="mt-0.5 text-xs text-neutral-300 whitespace-pre-wrap">
                        {rec.rationale}
                      </p>
                    </div>

                    {/* Alternatives */}
                    {rec.alternatives_considered.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                          Alternatives considered
                        </p>
                        <ul className="mt-0.5 list-disc list-inside space-y-0.5">
                          {rec.alternatives_considered.map((alt, i) => (
                            <li key={i} className="text-xs text-neutral-400">
                              {alt}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Tags */}
                    {rec.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {rec.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-neutral-700/60 px-2 py-0.5 text-[10px] text-neutral-400"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Context URLs */}
                    {rec.context_urls.length > 0 && (
                      <div>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-neutral-500">
                          References
                        </p>
                        <div className="mt-0.5 space-y-0.5">
                          {rec.context_urls.map((url) => (
                            <a
                              key={url}
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate text-[10px] text-amber-400 hover:text-amber-300 underline"
                              title={url}
                            >
                              {url}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Supersedes */}
                    {rec.supersedes_id && (
                      <p className="text-[10px] text-neutral-500">
                        Supersedes: {rec.supersedes_id}
                      </p>
                    )}

                    {/* Actions */}
                    <div className="flex justify-end gap-2 pt-1">
                      <button
                        onClick={() =>
                          setEditor({ mode: "edit", record: rec })
                        }
                        className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleDelete(rec.id)}
                        disabled={deleting === rec.id}
                        className="text-[10px] text-red-500 hover:text-red-400 disabled:opacity-50 transition-colors"
                      >
                        {deleting === rec.id ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Editor modal */}
      {editor && (
        <DecisionEditor
          projectId={projectId}
          record={editor.mode === "edit" ? editor.record : undefined}
          onSaved={handleSaved}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
