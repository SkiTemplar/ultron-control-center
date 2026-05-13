import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  RunTaskResult,
  ScheduledTaskInfo,
  SystemInfo,
} from "../types";

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const minutes = Math.floor(secs / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatRelativeIso(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diff = Date.now() - d.getTime();
  if (diff < 0) {
    // Future date
    const ahead = -diff;
    if (ahead < 60_000) return "in <1m";
    if (ahead < 3_600_000) return `in ${Math.floor(ahead / 60_000)}m`;
    if (ahead < 86_400_000) return `in ${Math.floor(ahead / 3_600_000)}h`;
    return `in ${Math.floor(ahead / 86_400_000)}d`;
  }
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function taskStateBadge(state: string, lastResult: number): {
  color: string;
  label: string;
} {
  if (state === "Running") return { color: "var(--color-warn)", label: "running" };
  if (state === "Disabled") return { color: "var(--color-text-tertiary)", label: "disabled" };
  if (lastResult !== 0 && lastResult !== 267011 /* never run */) {
    return { color: "var(--color-danger)", label: `last result 0x${lastResult.toString(16)}` };
  }
  return { color: "var(--color-success)", label: state.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Scheduled task row
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  busy,
  onRun,
}: {
  task: ScheduledTaskInfo;
  busy: boolean;
  onRun: () => void;
}) {
  const b = taskStateBadge(task.state, task.last_result);
  return (
    <div
      className="flex items-start gap-3 rounded p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <span
        className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: b.color }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            {task.name}
          </span>
          <span
            className="text-[10.5px] uppercase tracking-wide"
            style={{ color: b.color }}
          >
            {b.label}
          </span>
        </div>
        {task.description && (
          <div
            className="mt-1 text-[11.5px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {task.description}
          </div>
        )}
        <div
          className="mt-1.5 flex flex-wrap items-baseline gap-3 text-[11px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <span>
            <span style={{ color: "var(--color-text-faint)" }}>last</span>{" "}
            {formatRelativeIso(task.last_run)}
          </span>
          <span>
            <span style={{ color: "var(--color-text-faint)" }}>next</span>{" "}
            {formatRelativeIso(task.next_run)}
          </span>
          <span>
            <span style={{ color: "var(--color-text-faint)" }}>result</span> 0x
            {task.last_result.toString(16)}
          </span>
        </div>
      </div>
      <button
        type="button"
        onClick={onRun}
        disabled={busy}
        className="shrink-0 rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
        style={{
          background: "var(--color-accent)",
          color: "var(--color-accent-text)",
        }}
        title="Trigger the task now via Start-ScheduledTask"
      >
        {busy ? "Running…" : "Run now"}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// System info card
// ---------------------------------------------------------------------------

function SystemInfoCard({ info }: { info: SystemInfo }) {
  const diskPctColor =
    info.disk_c_pct_used > 90
      ? "var(--color-danger)"
      : info.disk_c_pct_used > 80
        ? "var(--color-warn)"
        : "var(--color-success)";
  return (
    <section
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <h2 className="text-[13px] font-semibold">System</h2>
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
        <Field label="Hostname" value={info.hostname} />
        <Field label="User" value={info.user} />
        <Field label="OS" value={`${info.os_name} (${info.os_version})`} />
        <Field label="Uptime" value={formatUptime(info.uptime_seconds)} />
        <Field
          label="C:\ free"
          value={
            <span>
              <span className="tabular-nums">{info.disk_c_free_gb}</span> /
              <span className="tabular-nums"> {info.disk_c_total_gb}</span> GB
              <span
                className="ml-2 tabular-nums"
                style={{ color: diskPctColor }}
              >
                {info.disk_c_pct_used}% used
              </span>
            </span>
          }
        />
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span
        className="w-20 shrink-0 text-[10px] uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </span>
      <span style={{ color: "var(--color-text)" }}>{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function System() {
  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([]);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningName, setRunningName] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunTaskResult | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [t, i] = await Promise.all([
        invoke<ScheduledTaskInfo[]>("list_scheduled_tasks"),
        invoke<SystemInfo>("system_info"),
      ]);
      setTasks(t);
      setInfo(i);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function run(name: string) {
    setRunningName(name);
    setLastRun(null);
    try {
      const r = (await invoke("run_scheduled_task", { name })) as RunTaskResult;
      setLastRun(r);
      // Refresh after a brief moment to pick up new LastRun
      setTimeout(load, 1500);
    } catch (e) {
      setLastRun({ success: false, name, stderr: String(e) });
    } finally {
      setRunningName(null);
    }
  }

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="px-10 py-8">
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">System</h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Scheduled tasks · backups · system info — refresh cada 60s
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      {error && (
        <div
          className="mb-4 rounded p-3 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {lastRun && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: lastRun.success
              ? "rgba(63, 185, 80, 0.06)"
              : "rgba(248, 81, 73, 0.06)",
            border: `1px solid ${lastRun.success ? "rgba(63, 185, 80, 0.22)" : "rgba(248, 81, 73, 0.22)"}`,
            color: lastRun.success
              ? "var(--color-success)"
              : "var(--color-danger)",
          }}
        >
          {lastRun.success
            ? `Triggered ${lastRun.name}. Last run timestamp will update shortly.`
            : `Failed to start ${lastRun.name}: ${lastRun.stderr}`}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        {/* Scheduled tasks — spans 2 cols */}
        <section className="col-span-2">
          <h2 className="mb-2 text-[13px] font-semibold">Scheduled tasks</h2>
          {tasks.length === 0 && !loading && (
            <div
              className="rounded p-6 text-center text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              No ULTRON-* tasks registered. Install with{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                ultron schedule install
              </span>
              .
            </div>
          )}
          <div className="space-y-2">
            {tasks.map((t) => (
              <TaskRow
                key={t.name}
                task={t}
                busy={runningName === t.name}
                onRun={() => run(t.name)}
              />
            ))}
          </div>
        </section>

        {/* System info */}
        <div>{info && <SystemInfoCard info={info} />}</div>
      </div>
    </div>
  );
}
