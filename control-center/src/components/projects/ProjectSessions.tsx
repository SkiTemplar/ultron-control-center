// ULTRON Control Center 2.0 — Per-project Sessions sub-tab
//
// Lists past Claude Code sessions discovered at ~/.claude/projects/<slug>/*.jsonl
// for the active project's path. Click "Resume" spawns a new PTY with a
// `/resume <session_id>` prompt hint.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Play, RefreshCw } from "./icons";

type Props = {
  projectId: string;
  projectPath: string;
};

type ClaudeSessionSummary = {
  session_id: string;
  path: string;
  modified_at: string;
  first_user_message: string | null;
};

export default function ProjectSessions({ projectId, projectPath }: Props) {
  const [items, setItems] = useState<ClaudeSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectPath) return;
    setLoading(true);
    try {
      const list = (await invoke("project_sessions_list", {
        projectPath,
      })) as ClaudeSessionSummary[];
      setItems(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const resume = useCallback(
    async (sessionId: string) => {
      try {
        await invoke("pty_spawn", {
          projectId,
          cardId: null,
          provider: "claude",
          agent: null,
          cwd: projectPath || ".",
          prompt: `/resume ${sessionId}`,
        });
      } catch (e) {
        setError(String(e));
      }
    },
    [projectId, projectPath],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs">
        <span className="font-semibold">
          Sessions{" "}
          <span className="text-[var(--color-text-muted)]">({items.length})</span>
        </span>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="rounded p-1 hover:bg-[var(--color-surface-2)]"
          aria-label="Refresh"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {error && (
        <div className="border-b border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2 text-xs">
        {items.length === 0 ? (
          <div className="rounded border border-dashed border-[var(--color-border)] p-4 text-center text-[var(--color-text-muted)]">
            {loading ? "Loading…" : "No sessions found for this project."}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {items.map((s) => (
              <li
                key={s.session_id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[10px] text-[var(--color-text-muted)]">
                      {s.session_id}
                    </p>
                    {s.first_user_message && (
                      <p className="mt-0.5 line-clamp-2">{s.first_user_message}</p>
                    )}
                    <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                      {s.modified_at}
                    </p>
                  </div>
                  <button
                    onClick={() => void resume(s.session_id)}
                    className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-surface-2)]"
                  >
                    <Play size={11} /> Resume
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
