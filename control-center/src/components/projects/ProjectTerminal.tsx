// ULTRON Control Center 2.0 — Per-project terminal sub-tab
//
// Lists active PTYs for the project (via pty_list), shows them as an internal
// tab-bar when there's more than one. The selected PTY mounts EmbeddedTerminal.
// Includes a "+ New session" button that spawns a raw claude session (no card).

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Plus, X } from "./icons";
import EmbeddedTerminal from "../EmbeddedTerminal";
import type { PtySessionSummary } from "../../types";

type Props = { projectId: string };

export default function ProjectTerminal({ projectId }: Props) {
  const [sessions, setSessions] = useState<PtySessionSummary[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = (await invoke("pty_list", { projectId })) as PtySessionSummary[];
      setSessions(list);
      setActive((cur) => {
        if (cur && list.some((s) => s.id === cur)) return cur;
        return list.length > 0 ? list[list.length - 1].id : null;
      });
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Subscribe to pty:exit for any session in this project (refresh on exit).
  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];
    let cancelled = false;
    (async () => {
      for (const s of sessions) {
        const un = await listen(`pty:exit:${s.id}`, () => {
          if (!cancelled) void refresh();
        });
        unlisteners.push(un);
      }
    })();
    return () => {
      cancelled = true;
      for (const un of unlisteners) un();
    };
  }, [sessions, refresh]);

  const spawnRaw = async () => {
    try {
      await invoke("pty_spawn", {
        projectId,
        cardId: null,
        provider: "claude",
        agent: null,
        cwd: ".",
        prompt: null,
      });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const kill = async (id: string) => {
    try {
      await invoke("pty_kill", { sessionId: id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  if (sessions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-xs text-[var(--color-text-muted)]">
        <span>No active PTY in this project.</span>
        <button
          onClick={spawnRaw}
          className="flex items-center gap-1 rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-2)]"
        >
          <Plus size={11} /> New claude session
        </button>
        {error && <span className="text-[var(--color-error)]">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-2">
        {sessions.map((s) => {
          const isActive = s.id === active;
          return (
            <div
              key={s.id}
              onClick={() => setActive(s.id)}
              className={[
                "group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-1 text-xs",
                isActive
                  ? "border-[var(--color-accent)] text-[var(--color-text)]"
                  : "border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
              ].join(" ")}
            >
              <span className="font-mono">{s.provider}</span>
              {s.card_id && (
                <span className="rounded bg-[var(--color-surface-2)] px-1 py-0.5 text-[10px]">
                  card {s.card_id.slice(-6)}
                </span>
              )}
              <span
                className={[
                  "h-1.5 w-1.5 rounded-full",
                  s.status.kind === "running"
                    ? "bg-green-500"
                    : "bg-[var(--color-text-muted)]",
                ].join(" ")}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void kill(s.id);
                }}
                className="opacity-60 hover:opacity-100"
                aria-label="Kill"
                title="Kill"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button
          onClick={spawnRaw}
          className="ml-auto flex items-center gap-1 px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          <Plus size={11} /> New session
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {active && (
          <EmbeddedTerminal
            key={active}
            sessionId={active}
            onExit={() => void refresh()}
          />
        )}
      </div>
      {error && (
        <div className="border-t border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}
    </div>
  );
}
