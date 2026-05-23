// Reworked "Fix common issues" — quick actions tuned for the
// Claude Code + ECC + Mem0 stack. No ULTRON / Qdrant / brain_index.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";

interface FixCommonIssuesProps {
  onOpenSettings?: () => void;
}

type ActionId =
  | "rescan-projects"
  | "open-claude-log"
  | "open-ecc-plugin"
  | "reset-mem0"
  | "open-settings-json";

interface Action {
  id: ActionId;
  label: string;
  detail: string;
  run: () => Promise<string>; // returns short status message
}

export function FixCommonIssues({ onOpenSettings }: FixCommonIssuesProps) {
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const actions: Action[] = [
    {
      id: "rescan-projects",
      label: "Re-scan projects",
      detail: "Refresh ~/.ultron/projects.json so new entries are picked up.",
      run: async () => {
        const r = (await invoke("scan_projects")) as unknown[];
        return `${r.length} projects`;
      },
    },
    {
      id: "open-claude-log",
      label: "Open Claude Code log",
      detail: "Reveal ~/.claude/logs in the file manager.",
      run: async () => {
        const home = (await invoke("home_dir_str")) as string;
        const sep = home.includes("\\") ? "\\" : "/";
        const path = `${home}${sep}.claude${sep}logs`;
        await openPath(path);
        return "opened";
      },
    },
    {
      id: "open-ecc-plugin",
      label: "Open ECC plugin folder",
      detail: "Open the installed ecc plugin root.",
      run: async () => {
        const info = (await invoke("read_plugin_info")) as {
          root: string | null;
        };
        if (!info.root) throw new Error("plugin not installed");
        await openPath(info.root);
        return "opened";
      },
    },
    {
      id: "reset-mem0",
      label: "Reset Mem0 connection",
      detail: "Re-issue mem0_status to refresh the connection probe.",
      run: async () => {
        const r = (await invoke("mem0_status")) as {
          connected: boolean;
          latency_ms: number | null;
        };
        return r.connected ? `ok ${r.latency_ms ?? "?"}ms` : "disconnected";
      },
    },
    {
      id: "open-settings-json",
      label: "Open settings.json",
      detail: "Reveal ~/.claude/settings.json for manual edits.",
      run: async () => {
        const home = (await invoke("home_dir_str")) as string;
        const sep = home.includes("\\") ? "\\" : "/";
        const path = `${home}${sep}.claude${sep}settings.json`;
        await openPath(path);
        return "opened";
      },
    },
  ];

  async function run(a: Action) {
    setBusy(a.id);
    setErrors((p) => {
      const next = { ...p };
      delete next[a.id];
      return next;
    });
    try {
      const msg = await a.run();
      setResults((p) => ({ ...p, [a.id]: msg }));
    } catch (e) {
      setErrors((p) => ({ ...p, [a.id]: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-8">
      <div className="flex items-baseline justify-between">
        <div>
          <h2 className="text-[14px] font-semibold">Fix common issues</h2>
          <p
            className="mt-1 text-[12px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Quick actions for the Claude Code + ECC + Mem0 stack.
          </p>
        </div>
        {onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Settings
          </button>
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {actions.map((a) => {
          const running = busy === a.id;
          const ok = results[a.id];
          const err = errors[a.id];
          const dot = err
            ? "var(--color-danger)"
            : ok
              ? "var(--color-success)"
              : "var(--color-text-faint)";
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => void run(a)}
              disabled={running}
              title={a.detail}
              className="flex items-center gap-2 rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-60"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: dot }}
              />
              <span>{running ? `${a.label}...` : a.label}</span>
              {ok && (
                <span
                  className="text-[10.5px] tabular-nums"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {ok}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {Object.entries(errors).length > 0 && (
        <ul className="mt-2 space-y-1">
          {Object.entries(errors).map(([id, msg]) => (
            <li
              key={id}
              className="rounded p-2 text-[11px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
                fontFamily: "var(--font-mono, ui-monospace)",
              }}
            >
              {id}: {msg}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
