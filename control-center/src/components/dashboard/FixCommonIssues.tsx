// PC-focused quick actions (v2.5).
//
// Each action shells out to a Windows command via run_maintenance_command
// (whitelisted by `kind` in src-tauri/src/maintenance.rs). Destructive
// actions (Restart Explorer, Clear temp files, Reset network adapter)
// require an explicit confirm via confirmDialog before dispatch.

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../../lib/dialog";

interface FixCommonIssuesProps {
  onOpenSettings?: () => void;
}

type ActionId =
  | "pc-flush-dns"
  | "pc-reset-network"
  | "pc-disk-cleanup"
  | "pc-reliability-monitor"
  | "pc-task-manager"
  | "pc-restart-explorer"
  | "pc-clear-temp"
  | "pc-windows-update"
  | "pc-open-hosts";

interface Action {
  id: ActionId;
  label: string;
  detail: string;
  /** When set, a confirm dialog must be acknowledged before dispatch. */
  confirm?: { title: string; message: string };
}

interface MaintenanceResult {
  kind: string;
  success: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  elapsed_ms: number;
}

const ACTIONS: Action[] = [
  {
    id: "pc-flush-dns",
    label: "Flush DNS cache",
    detail: "ipconfig /flushdns — clears stale DNS entries.",
  },
  {
    id: "pc-reset-network",
    label: "Reset network adapter",
    detail: "netsh int ip reset — TCP/IP stack reset. Reboot recommended.",
    confirm: {
      title: "Reset network adapter?",
      message:
        "This resets the Windows TCP/IP stack. Your current connection will drop and a reboot is recommended afterward. Continue?",
    },
  },
  {
    id: "pc-disk-cleanup",
    label: "Disk cleanup",
    detail: "Launches Windows Disk Cleanup.",
  },
  {
    id: "pc-reliability-monitor",
    label: "Reliability Monitor",
    detail: "perfmon /rel — per-day system stability log.",
  },
  {
    id: "pc-task-manager",
    label: "Task Manager",
    detail: "Launches taskmgr.exe.",
  },
  {
    id: "pc-restart-explorer",
    label: "Restart Explorer",
    detail: "Kills + relaunches explorer.exe (fixes shell glitches).",
    confirm: {
      title: "Restart Explorer?",
      message:
        "This will close and relaunch the Windows shell (taskbar, desktop icons). Any open File Explorer windows will be closed. Continue?",
    },
  },
  {
    id: "pc-clear-temp",
    label: "Clear temp files",
    detail: "Deletes %TEMP%\\* (best effort — locked files are skipped).",
    confirm: {
      title: "Clear temporary files?",
      message:
        "Permanently deletes contents of %TEMP%. Locked files (in use by running apps) are skipped. Continue?",
    },
  },
  {
    id: "pc-windows-update",
    label: "Windows Update settings",
    detail: "Opens ms-settings:windowsupdate.",
  },
  {
    id: "pc-open-hosts",
    label: "Open hosts file",
    detail: "Opens C:\\Windows\\System32\\drivers\\etc\\hosts in notepad.",
  },
];

export function FixCommonIssues({ onOpenSettings }: FixCommonIssuesProps) {
  const [busy, setBusy] = useState<ActionId | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function run(a: Action) {
    if (a.confirm) {
      const ok = await confirmDialog(a.confirm.message, {
        title: a.confirm.title,
        kind: "warning",
      });
      if (!ok) return;
    }
    setBusy(a.id);
    setErrors((p) => {
      const next = { ...p };
      delete next[a.id];
      return next;
    });
    try {
      const r = (await invoke("run_maintenance_command", {
        kind: a.id,
      })) as MaintenanceResult;
      const status = r.success
        ? `ok ${r.elapsed_ms}ms`
        : `exit ${r.exit_code ?? "?"}`;
      setResults((p) => ({ ...p, [a.id]: status }));
      if (!r.success) {
        const tail = (r.stderr || r.stdout || "").trim().slice(0, 180);
        if (tail.length > 0) {
          setErrors((p) => ({ ...p, [a.id]: tail }));
        }
      }
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
            PC-focused quick actions. Destructive ones ask for confirmation.
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
        {ACTIONS.map((a) => {
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
              disabled={running || busy !== null}
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
