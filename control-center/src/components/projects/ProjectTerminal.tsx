// ULTRON Control Center 2.0 — Per-project terminal sub-tab
//
// Lists active PTYs for the project (via pty_list), shows them as a polished
// tab-bar with provider chip, card-link badge, status dot and per-session kill.
// Single pane below renders the selected PTY through EmbeddedTerminal.
//
// TODO(next-session): Dorothy-style horizontal/vertical split panes. The
// data model already supports N concurrent PTYs per project; what's missing
// is the layout tree (single | split-h | split-v | tabs-of-splits), a sash
// drag handler, and per-leaf focus tracking. See `ProjectTerminal.split.md`
// (to be drafted) for the proposed layout protocol. Until then we render
// exactly one pane at a time, switched by the tab bar above.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Plus, Terminal as TerminalIcon, X } from "./icons";
import EmbeddedTerminal from "../EmbeddedTerminal";
import type { PtySessionSummary } from "../../types";

type Props = { projectId: string };

type Provider = "claude" | "codex" | "gemini";

const PROVIDERS: Provider[] = ["claude", "codex", "gemini"];

function providerLabel(p: string): string {
  if (p === "claude") return "Claude";
  if (p === "codex") return "Codex";
  if (p === "gemini") return "Gemini";
  return p;
}

function providerTint(p: string): string {
  if (p === "claude") return "#cc785c";
  if (p === "codex") return "#10a37f";
  if (p === "gemini") return "#4285f4";
  return "var(--color-text-muted)";
}

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

  const spawnRaw = async (provider: Provider = "claude") => {
    try {
      await invoke("pty_spawn", {
        projectId,
        cardId: null,
        provider,
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
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-xs text-[var(--color-text-muted)]">
        <div className="flex items-center gap-2 text-[var(--color-text)]">
          <TerminalIcon size={14} />
          <span className="text-sm font-medium">No terminal in this project</span>
        </div>
        <p className="max-w-sm text-center">
          Spawn an AI session and it lives inside the Control Center —
          xterm.js + portable-pty, full TTY. No external windows.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              onClick={() => void spawnRaw(p)}
              className="flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-1.5 hover:bg-[var(--color-surface-2)]"
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: providerTint(p) }}
              />
              <Plus size={11} /> New {providerLabel(p)} session
            </button>
          ))}
        </div>
        {error && <span className="text-[var(--color-error)]">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-2">
        {sessions.map((s, i) => {
          const isActive = s.id === active;
          const tint = providerTint(s.provider);
          return (
            <div
              key={s.id}
              onClick={() => setActive(s.id)}
              className={[
                "group flex cursor-pointer items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs",
                isActive
                  ? "border-[var(--color-accent)] bg-[var(--color-surface-1)] text-[var(--color-text)]"
                  : "border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-surface-1)] hover:text-[var(--color-text)]",
              ].join(" ")}
              title={`${providerLabel(s.provider)} · ${s.id}`}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: tint }}
              />
              <span className="font-mono">
                {providerLabel(s.provider)}
                <span className="ml-1 text-[10px] text-[var(--color-text-muted)]">
                  #{i + 1}
                </span>
              </span>
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
                title={s.status.kind}
              />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void kill(s.id);
                }}
                className="rounded p-0.5 opacity-60 hover:bg-[var(--color-surface-2)] hover:opacity-100"
                aria-label="Kill terminal"
                title="Kill terminal"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <div className="ml-auto flex items-center gap-0.5 pr-1">
          {PROVIDERS.map((p) => (
            <button
              key={p}
              onClick={() => void spawnRaw(p)}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
              title={`New ${providerLabel(p)} terminal`}
            >
              <span
                aria-hidden
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: providerTint(p) }}
              />
              <Plus size={11} />
              <span className="hidden sm:inline">{providerLabel(p)}</span>
            </button>
          ))}
        </div>
      </div>
      {/* TODO(next-session): replace this single-pane mount with a split-pane
          layout tree à la Dorothy (https://github.com/Charlie85270/Dorothy).
          Approach: introduce LayoutNode = Leaf{sessionId} | Split{dir,a,b};
          render recursively with a draggable sash; per-leaf focus tracking;
          persist the tree alongside open-tabs.json. The tabs above stay as a
          quick switcher between "panes". */}
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
