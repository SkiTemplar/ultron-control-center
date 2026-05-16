import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  DeleteTaskResult,
  EditTaskResult,
  RichSystemInfo,
  RunTaskResult,
  ScheduledTaskInfo,
  ScheduledTriggerType,
  TaskDetail,
} from "../types";
import { Hooks } from "./Hooks";
import { useFeatures } from "../lib/features";

// v15.2 F7: System now hosts four inner sub-tabs:
//   - Schedules : scheduled task list (formerly the whole pane)
//   - Processes : top processes view (re-uses RichInfo top-procs card)
//   - Tweaks    : per-host tweaks (placeholder; F7+ will add registry tweaks)
//   - Hooks     : embedded Hooks admin (moved from sidebar)
type SystemSubTab = "schedules" | "processes" | "tweaks" | "hooks";

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

/**
 * Translate Windows Task Scheduler result codes into a human-readable
 * description. Only the most common values are mapped; unknown codes
 * fall back to the hex representation.
 */
function explainTaskResult(code: number): { label: string; severity: "ok" | "warn" | "error" | "neutral" } {
  switch (code) {
    case 0:
      return { label: "OK (last run succeeded)", severity: "ok" };
    case 0x1:
      return { label: "0x1 — generic error / non-zero exit from action", severity: "error" };
    case 0x2:
      return { label: "0x2 — file not found", severity: "error" };
    case 0x10:
      return { label: "0x10 — terminated unexpectedly", severity: "error" };
    case 0x41300:
      return { label: "0x41300 — task is ready (not yet run)", severity: "neutral" };
    case 0x41301:
      return { label: "0x41301 — task is currently running", severity: "warn" };
    case 0x41302:
      return { label: "0x41302 — task is disabled", severity: "neutral" };
    case 0x41303:
      return { label: "0x41303 — task has not yet run", severity: "neutral" };
    case 0x41304:
      return { label: "0x41304 — no more runs scheduled", severity: "neutral" };
    case 0x41306:
      return { label: "0x41306 — task terminated by user", severity: "warn" };
    case 0x80041309:
      return { label: "0x80041309 — task not registered", severity: "error" };
    default:
      return { label: `0x${code.toString(16)} — non-zero exit (see history below)`, severity: "error" };
  }
}

function taskDot(state: string, code: number): string {
  if (state === "Running") return "var(--color-warn)";
  if (state === "Disabled") return "var(--color-text-tertiary)";
  const sev = explainTaskResult(code).severity;
  if (sev === "error") return "var(--color-danger)";
  if (sev === "warn") return "var(--color-warn)";
  return "var(--color-success)";
}

// ---------------------------------------------------------------------------
// Detail panel (expanded under a task)
// ---------------------------------------------------------------------------

// Phase 8 helper: compute the next firing time in the local timezone, so the
// modal can show "Next run: …" before the user hits save. Covers only the
// three trigger types the backend supports (Daily / Weekly Monday / AtLogon).
function computeNextRun(
  triggerType: ScheduledTriggerType,
  triggerAt: string,
): Date | null {
  if (triggerType === "AtLogon") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(triggerAt);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(hh, mm, 0, 0);
  if (triggerType === "Daily") {
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }
  // Weekly Monday. JS Sunday=0 … Monday=1.
  const targetDow = 1;
  let delta = (targetDow - next.getDay() + 7) % 7;
  if (delta === 0 && next <= now) delta = 7;
  next.setDate(next.getDate() + delta);
  return next;
}

function formatNextRun(d: Date | null): string {
  if (!d) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()];
  return `${wd} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function EditTriggerModal({
  name,
  initialCatchUp,
  onClose,
  onSaved,
}: {
  name: string;
  initialCatchUp: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [triggerType, setTriggerType] = useState<ScheduledTriggerType>("Daily");
  const [triggerAt, setTriggerAt] = useState("09:00");
  const [catchUp, setCatchUp] = useState<boolean>(initialCatchUp);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nextRun = computeNextRun(triggerType, triggerAt);

  // Equivalent cron for the chosen visual config — purely informational.
  function cronEquivalent(): string {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(triggerAt);
    const mm = m ? Number(m[2]) : 0;
    const hh = m ? Number(m[1]) : 0;
    if (triggerType === "Daily") return `${mm} ${hh} * * *`;
    if (triggerType === "Weekly") return `${mm} ${hh} * * 1`;
    return "@reboot (logon)";
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload: {
        name: string;
        newTriggerType: ScheduledTriggerType;
        newTriggerAt?: string;
        catchUp?: boolean;
      } = { name, newTriggerType: triggerType, catchUp };
      if (triggerType !== "AtLogon") {
        payload.newTriggerAt = triggerAt;
      }
      const r = (await invoke("edit_scheduled_task", payload)) as EditTaskResult;
      if (!r.success) {
        setError(r.error || "edit failed");
        return;
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded p-4"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Edit schedule
        </div>
        <div
          className="mb-3 truncate text-[11px]"
          style={{
            color: "var(--color-text-tertiary)",
            fontFamily: "var(--font-mono)",
          }}
          title={name}
        >
          {name}
        </div>
        <div className="space-y-3">
          {/* Visual trigger-type selector — segmented control. */}
          <div>
            <div
              className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Run
            </div>
            <div
              className="flex gap-1 rounded p-0.5"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              {([
                { v: "Daily", label: "Every day" },
                { v: "Weekly", label: "Mondays" },
                { v: "AtLogon", label: "At logon" },
              ] as { v: ScheduledTriggerType; label: string }[]).map((opt) => {
                const selected = triggerType === opt.v;
                return (
                  <button
                    type="button"
                    key={opt.v}
                    onClick={() => setTriggerType(opt.v)}
                    className="flex-1 rounded px-2 py-1.5 text-[11.5px] font-medium transition-colors"
                    style={{
                      background: selected
                        ? "var(--color-accent)"
                        : "transparent",
                      color: selected
                        ? "var(--color-accent-text)"
                        : "var(--color-text-secondary)",
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {triggerType !== "AtLogon" && (
            <div>
              <div
                className="mb-1 text-[10px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                Time
              </div>
              <input
                type="time"
                value={triggerAt}
                onChange={(e) => setTriggerAt(e.target.value)}
                className="w-full rounded px-2 py-1.5 text-[14px] tabular-nums"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text)",
                }}
              />
            </div>
          )}

          {/* Next-run preview — computed in the browser, no round-trip. */}
          <div
            className="rounded p-2 text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            <span style={{ color: "var(--color-text-tertiary)" }}>Next run </span>
            <span className="tabular-nums" style={{ color: "var(--color-text)" }}>
              {triggerType === "AtLogon"
                ? "every time you log in"
                : formatNextRun(nextRun)}
            </span>
          </div>

          {/* Phase 8: catch-up toggle → StartWhenAvailable. */}
          <label
            className="flex cursor-pointer items-start gap-2 rounded p-2"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            <input
              type="checkbox"
              checked={catchUp}
              onChange={(e) => setCatchUp(e.target.checked)}
              className="mt-0.5"
            />
            <span className="min-w-0 flex-1">
              <span
                className="block text-[12px] font-medium"
                style={{ color: "var(--color-text)" }}
              >
                Catch up if missed
              </span>
              <span
                className="mt-0.5 block text-[11px] leading-snug"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                If the PC was off or asleep at the scheduled time, run as
                soon as it comes back online. (Windows: StartWhenAvailable)
              </span>
            </span>
          </label>

          {/* Advanced — collapsed by default. Shows equivalent cron only. */}
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((s) => !s)}
              className="text-[11px] font-medium"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {showAdvanced ? "▾" : "▸"} Advanced (raw cron expression)
            </button>
            {showAdvanced && (
              <div
                className="mt-1 rounded p-2 text-[11px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-secondary)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                <div style={{ color: "var(--color-text)" }}>{cronEquivalent()}</div>
                <div
                  className="mt-1 text-[10.5px]"
                  style={{
                    fontFamily: "var(--font-sans, inherit)",
                    color: "var(--color-text-tertiary)",
                  }}
                >
                  Read-only preview. Free-form cron editing is not wired
                  into Set-ScheduledTask; use the visual selectors above.
                </div>
              </div>
            )}
          </div>

          {error && (
            <div
              className="rounded p-2 text-[11.5px]"
              style={{
                background: "rgba(248, 81, 73, 0.06)",
                border: "1px solid rgba(248, 81, 73, 0.22)",
                color: "var(--color-danger)",
              }}
            >
              {error}
            </div>
          )}
        </div>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DetailPanel({
  name,
  onChanged,
}: {
  name: string;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<TaskDetail>("task_detail", { name })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [name]);

  async function handleDelete() {
    const ok = window.confirm(
      `Delete scheduled task "${name}"? This calls Unregister-ScheduledTask and cannot be undone.`,
    );
    if (!ok) return;
    setDeleteBusy(true);
    setActionMsg(null);
    try {
      const r = (await invoke("delete_scheduled_task", { name })) as DeleteTaskResult;
      if (r.success) {
        setActionMsg("Deleted.");
        onChanged();
      } else {
        setActionMsg(`Delete failed: ${r.error || "unknown"}`);
      }
    } catch (e) {
      setActionMsg(`Delete failed: ${e}`);
    } finally {
      setDeleteBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="mt-2 text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
        Loading detail…
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="mt-2 rounded p-2 text-[11.5px]"
        style={{
          background: "rgba(248, 81, 73, 0.06)",
          border: "1px solid rgba(248, 81, 73, 0.22)",
          color: "var(--color-danger)",
        }}
      >
        {error}
      </div>
    );
  }
  if (!detail) return null;

  const resultExplain = explainTaskResult(detail.last_result);

  return (
    <div
      className="mt-3 space-y-3 rounded p-3"
      style={{
        background: "var(--color-surface-1)",
        border: "1px solid var(--color-border)",
      }}
    >
      {/* Result explained */}
      <div>
        <SectionLabel>Last result</SectionLabel>
        <div
          className="mt-1 text-[12px]"
          style={{
            color:
              resultExplain.severity === "error"
                ? "var(--color-danger)"
                : resultExplain.severity === "warn"
                  ? "var(--color-warn)"
                  : "var(--color-text)",
          }}
        >
          {resultExplain.label}
        </div>
        {detail.missed_runs > 0 && (
          <div className="mt-1 text-[11px]" style={{ color: "var(--color-warn)" }}>
            {detail.missed_runs} missed run(s)
          </div>
        )}
      </div>

      {/* Principal & runlevel */}
      <div>
        <SectionLabel>Principal</SectionLabel>
        <div className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
          {detail.principal_user} · {detail.principal_logon} · run as {detail.run_level}
        </div>
      </div>

      {/* Catch-up window — Phase 8 */}
      <div>
        <SectionLabel>Catch-up window</SectionLabel>
        <div className="mt-1 text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
          {detail.catch_up ? (
            <span style={{ color: "var(--color-success)" }}>
              On — will run on next boot if scheduled time was missed.
            </span>
          ) : (
            <span style={{ color: "var(--color-text-tertiary)" }}>
              Off — task is skipped if the PC is off at the scheduled time.
            </span>
          )}
        </div>
      </div>

      {/* Triggers */}
      {detail.triggers.length > 0 && (
        <div>
          <SectionLabel>Triggers</SectionLabel>
          <ul className="mt-1 space-y-1">
            {detail.triggers.map((t, i) => (
              <li key={i} className="text-[11.5px]" style={{ color: "var(--color-text-secondary)" }}>
                <span style={{ color: "var(--color-text)" }}>{t.kind || "Trigger"}</span>
                {t.enabled ? "" : " (disabled)"}
                {t.start && (
                  <>
                    {" "}
                    · starts <span className="tabular-nums">{t.start}</span>
                  </>
                )}
                {t.extra && <> · {t.extra}</>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Actions */}
      {detail.actions.length > 0 && (
        <div>
          <SectionLabel>Action</SectionLabel>
          {detail.actions.map((a, i) => (
            <div key={i} className="mt-1">
              <div
                className="truncate text-[11px]"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-text)",
                }}
                title={`${a.execute} ${a.arguments}`}
              >
                {a.execute}
              </div>
              {a.arguments && (
                <div
                  className="mt-0.5 truncate text-[10.5px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-tertiary)",
                  }}
                  title={a.arguments}
                >
                  {a.arguments}
                </div>
              )}
              {a.working && (
                <div
                  className="text-[10.5px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-faint)",
                  }}
                >
                  cwd: {a.working}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* History */}
      {detail.history.length > 0 && (
        <div>
          <SectionLabel>Recent events (last 14 days)</SectionLabel>
          <ul className="mt-1 space-y-1">
            {detail.history.slice(0, 8).map((e, i) => (
              <li
                key={i}
                className="flex items-start gap-2 text-[10.5px]"
                style={{ color: "var(--color-text-secondary)" }}
              >
                <span
                  className="shrink-0 tabular-nums"
                  style={{ color: "var(--color-text-faint)", minWidth: 130 }}
                >
                  {e.time.replace("T", " ").replace("Z", "")}
                </span>
                <span
                  className="shrink-0"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  #{e.event_id}
                </span>
                <span
                  className="line-clamp-2"
                  style={{ color: "var(--color-text)" }}
                >
                  {e.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Mutations */}
      <div
        className="flex items-center gap-2 pt-2"
        style={{ borderTop: "1px solid var(--color-border)" }}
      >
        <button
          type="button"
          onClick={() => setShowEdit(true)}
          className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Re-point this task's trigger (Set-ScheduledTask)"
        >
          Edit trigger
        </button>
        <button
          type="button"
          onClick={handleDelete}
          disabled={deleteBusy}
          className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
            border: "1px solid rgba(248, 81, 73, 0.32)",
          }}
          title="Unregister this scheduled task"
        >
          {deleteBusy ? "Deleting…" : "Delete"}
        </button>
        {actionMsg && (
          <span
            className="ml-2 text-[11px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {actionMsg}
          </span>
        )}
      </div>

      {showEdit && (
        <EditTriggerModal
          name={name}
          initialCatchUp={!!detail.catch_up}
          onClose={() => setShowEdit(false)}
          onSaved={onChanged}
        />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="text-[10px] font-medium uppercase tracking-[0.06em]"
      style={{ color: "var(--color-text-tertiary)" }}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task row
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  busy,
  expanded,
  onRun,
  onToggle,
  onChanged,
}: {
  task: ScheduledTaskInfo;
  busy: boolean;
  expanded: boolean;
  onRun: () => void;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const dot = taskDot(task.state, task.last_result);
  const resultLabel = explainTaskResult(task.last_result).label;

  return (
    <div
      className="rounded p-3"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: dot }}
        />
        <button
          type="button"
          onClick={onToggle}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
              {task.name}
            </span>
            <span
              className="text-[10.5px] uppercase tracking-wide"
              style={{ color: dot }}
            >
              {task.state.toLowerCase()}
            </span>
          </div>
          {task.description && (
            <div
              className="mt-1 text-[11.5px] leading-snug"
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
            <span title={task.next_run || undefined}>
              <span style={{ color: "var(--color-text-faint)" }}>next</span>{" "}
              {formatRelativeIso(task.next_run)}
            </span>
            <span title={resultLabel}>
              <span style={{ color: "var(--color-text-faint)" }}>result</span>{" "}
              <span
                style={{
                  color:
                    explainTaskResult(task.last_result).severity === "error"
                      ? "var(--color-danger)"
                      : "var(--color-text-secondary)",
                }}
              >
                0x{task.last_result.toString(16)}
              </span>
            </span>
            {task.catch_up && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                style={{
                  background: "rgba(63, 185, 80, 0.10)",
                  color: "var(--color-success)",
                  border: "1px solid rgba(63, 185, 80, 0.32)",
                }}
                title="StartWhenAvailable: if the PC was off at the scheduled time, this task runs on next boot."
              >
                catch-up
              </span>
            )}
            <span
              className="ml-auto text-[10px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              {expanded ? "Hide details" : "Show details"}
            </span>
          </div>
        </button>
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
      {expanded && <DetailPanel name={task.name} onChanged={onChanged} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rich system info cards
// ---------------------------------------------------------------------------

function MeterBar({ pct, dangerOver = 85 }: { pct: number; dangerOver?: number }) {
  const color =
    pct >= dangerOver
      ? "var(--color-danger)"
      : pct >= 70
        ? "var(--color-warn)"
        : "var(--color-success)";
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full"
      style={{ background: "var(--color-surface-3)" }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(100, pct))}%`,
          height: "100%",
          background: color,
          transition: "width 250ms ease",
        }}
      />
    </div>
  );
}

function RichInfo({ info }: { info: RichSystemInfo }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      {/* Host / OS */}
      <Card title="Host">
        <KV label="Computer" v={`${info.hostname} · ${info.user}`} />
        <KV label="OS" v={`${info.os_name} (${info.os_version})`} />
        <KV label="Uptime" v={formatUptime(info.uptime_seconds)} />
      </Card>

      {/* CPU */}
      <Card title="CPU">
        <KV label="Model" v={info.cpu_name} mono />
        <KV
          label="Cores"
          v={`${info.cpu_cores} physical · ${info.cpu_threads} threads`}
        />
        {info.cpu_load_pct !== null && (
          <div className="mt-2">
            <div className="mb-1 flex items-baseline justify-between text-[11px]">
              <span style={{ color: "var(--color-text-tertiary)" }}>Load</span>
              <span className="tabular-nums" style={{ color: "var(--color-text)" }}>
                {info.cpu_load_pct}%
              </span>
            </div>
            <MeterBar pct={info.cpu_load_pct} />
          </div>
        )}
      </Card>

      {/* Memory */}
      <Card title="Memory">
        <div className="flex items-baseline justify-between text-[12px]">
          <span style={{ color: "var(--color-text-tertiary)" }}>RAM</span>
          <span className="tabular-nums" style={{ color: "var(--color-text)" }}>
            {info.ram_used_gb} / {info.ram_total_gb} GB
            <span className="ml-2" style={{ color: "var(--color-text-tertiary)" }}>
              {info.ram_pct_used}%
            </span>
          </span>
        </div>
        <div className="mt-1.5">
          <MeterBar pct={info.ram_pct_used} />
        </div>
        <div className="mt-3 flex items-baseline justify-between text-[12px]">
          <span style={{ color: "var(--color-text-tertiary)" }}>Disk C:\</span>
          <span className="tabular-nums" style={{ color: "var(--color-text)" }}>
            {(info.disk_c_total_gb - info.disk_c_free_gb).toFixed(1)} / {info.disk_c_total_gb} GB
            <span className="ml-2" style={{ color: "var(--color-text-tertiary)" }}>
              {info.disk_c_pct_used}%
            </span>
          </span>
        </div>
        <div className="mt-1.5">
          <MeterBar pct={info.disk_c_pct_used} dangerOver={90} />
        </div>
      </Card>

      {/* GPU */}
      <Card title="GPU">
        {info.gpus.length === 0 ? (
          <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            No GPU detected.
          </div>
        ) : (
          <div className="space-y-2">
            {info.gpus.map((g, i) => (
              <div key={i}>
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="truncate" style={{ color: "var(--color-text)" }} title={g.name}>
                    {g.name}
                  </span>
                  {g.temp_c !== null && (
                    <span className="tabular-nums" style={{ color: "var(--color-text-tertiary)" }}>
                      {g.temp_c}°C
                    </span>
                  )}
                </div>
                {g.util_pct !== null && (
                  <div className="mt-1">
                    <div className="mb-0.5 flex items-baseline justify-between text-[10.5px]">
                      <span style={{ color: "var(--color-text-tertiary)" }}>GPU util</span>
                      <span className="tabular-nums" style={{ color: "var(--color-text)" }}>
                        {g.util_pct}%
                      </span>
                    </div>
                    <MeterBar pct={g.util_pct} />
                  </div>
                )}
                {g.mem_used_mb !== null && g.mem_total_mb !== null && g.mem_total_mb > 0 && (
                  <div className="mt-1.5">
                    <div className="mb-0.5 flex items-baseline justify-between text-[10.5px]">
                      <span style={{ color: "var(--color-text-tertiary)" }}>VRAM</span>
                      <span className="tabular-nums" style={{ color: "var(--color-text)" }}>
                        {(g.mem_used_mb / 1024).toFixed(1)} / {(g.mem_total_mb / 1024).toFixed(1)} GB
                      </span>
                    </div>
                    <MeterBar pct={(g.mem_used_mb / g.mem_total_mb) * 100} />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Battery / Network — combined small card */}
      <Card title="Power & network">
        {info.battery ? (
          <>
            <div className="flex items-baseline justify-between text-[12px]">
              <span style={{ color: "var(--color-text-tertiary)" }}>
                Battery {info.battery.plugged_in ? "(plugged)" : "(on battery)"}
              </span>
              <span className="tabular-nums" style={{ color: "var(--color-text)" }}>
                {info.battery.percent}%
              </span>
            </div>
            <div className="mt-1.5">
              <MeterBar pct={100 - info.battery.percent} dangerOver={80} />
            </div>
          </>
        ) : (
          <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            No battery (desktop).
          </div>
        )}
        {info.network && (
          <div className="mt-3 space-y-1 text-[11.5px]">
            <KV label="Iface" v={info.network.interface} />
            <KV label="IPv4" v={info.network.ipv4 || "—"} mono />
            <KV label="Gateway" v={info.network.gateway || "—"} mono />
            {info.network.dns && <KV label="DNS" v={info.network.dns} mono />}
          </div>
        )}
      </Card>

      {/* Top processes */}
      <Card title="Top processes (RAM)">
        {info.top_procs.length === 0 ? (
          <div className="text-[12px]" style={{ color: "var(--color-text-tertiary)" }}>
            —
          </div>
        ) : (
          <ul className="space-y-1">
            {info.top_procs.map((p) => (
              <li
                key={`${p.name}-${p.pid}`}
                className="flex items-baseline justify-between text-[11.5px]"
              >
                <span style={{ color: "var(--color-text)" }}>{p.name}</span>
                <span
                  className="tabular-nums"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {p.ram_mb >= 1024
                    ? `${(p.ram_mb / 1024).toFixed(1)} GB`
                    : `${p.ram_mb.toFixed(0)} MB`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--color-text-secondary)" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

function KV({ label, v, mono = false }: { label: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-3 text-[12px]">
      <span
        className="w-16 shrink-0 text-[10px] uppercase tracking-wide"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        {label}
      </span>
      <span
        className="min-w-0 flex-1 truncate"
        style={{
          color: "var(--color-text)",
          fontFamily: mono ? "var(--font-mono)" : undefined,
          fontSize: mono ? 11 : undefined,
        }}
        title={typeof v === "string" ? v : undefined}
      >
        {v}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function System() {
  const [subTab, setSubTab] = useState<SystemSubTab>("schedules");
  const { features } = useFeatures();
  const hooksEnabled = features.hooks !== false;

  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([]);
  const [rich, setRich] = useState<RichSystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningName, setRunningName] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunTaskResult | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const [t, r] = await Promise.all([
        invoke<ScheduledTaskInfo[]>("list_scheduled_tasks"),
        invoke<RichSystemInfo>("rich_system_info"),
      ]);
      setTasks(t);
      setRich(r);
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

  // v15.2 F7: when Hooks sub-tab is active we delegate full rendering to the
  // Hooks component (it already has its own header/refresh/etc). The outer
  // System chrome (sub-tab bar) still wraps so the user can flip back.
  if (subTab === "hooks") {
    return (
      <div className="flex h-full flex-col">
        <SystemHeader subTab={subTab} setSubTab={setSubTab} hooksEnabled={hooksEnabled} onRefresh={load} loading={loading} />
        <div className="flex-1 overflow-auto">
          {hooksEnabled ? (
            <Hooks />
          ) : (
            <div className="px-10 py-8">
              <div
                className="rounded p-6 text-[13px]"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                Hooks feature is disabled. Enable it from the sidebar's "Features" panel.
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <SystemHeader subTab={subTab} setSubTab={setSubTab} hooksEnabled={hooksEnabled} onRefresh={load} loading={loading} />

      <div className="px-10">
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

      {/* Sub-tab: Schedules — scheduled task list */}
      {subTab === "schedules" && (
      <section className="mb-6">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold">Scheduled tasks</h2>
          <button
            type="button"
            onClick={async () => {
              try {
                const instr = (await invoke("instruction_path", {
                  kind: "tasks",
                })) as string;
                await invoke("spawn_session", {
                  provider: "claude",
                  prompt:
                    "Vamos a registrar una nueva scheduled task de Windows. Lee el GUIDE.md de esta carpeta para conocer la convención (prefix ULTRON-, wrapper PowerShell, exit-swallow, log en cockpit/scheduler-logs/). Después pregúntame qué quiero programar y prepara el New-ScheduledTaskAction completo, lo registramos y validamos con Get-ScheduledTaskInfo.",
                  cwd: instr,
                  flags: { dangerouslySkipPermissions: false },
                });
              } catch (e) {
                console.error("create task with AI failed", e);
              }
            }}
            className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Abre sesión Claude en instructions/tasks/ con el GUIDE.md auto-cargado"
          >
            Create with AI
          </button>
        </div>
        {tasks.length === 0 && !loading && (
          <div
            className="rounded p-6 text-center text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-secondary)",
            }}
          >
            No ULTRON-* tasks registered.
          </div>
        )}
        <div className="space-y-2">
          {tasks.map((t) => (
            <TaskRow
              key={t.name}
              task={t}
              busy={runningName === t.name}
              expanded={expanded === t.name}
              onToggle={() => setExpanded(expanded === t.name ? null : t.name)}
              onRun={() => run(t.name)}
              onChanged={load}
            />
          ))}
        </div>

        {/* Rich system info still shown under Schedules — gives a one-glance
            health check next to the scheduled task list. */}
        {rich && (
          <div className="mt-6">
            <RichInfo info={rich} />
          </div>
        )}
      </section>
      )}

      {/* Sub-tab: Processes — full top-process list with refresh button. */}
      {subTab === "processes" && rich && (
        <section className="mb-6">
          <h2 className="mb-2 text-[13px] font-semibold">Processes (top by RAM)</h2>
          <div
            className="rounded p-3"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            {rich.top_procs.length === 0 ? (
              <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                No processes returned.
              </div>
            ) : (
              <ul className="space-y-1">
                {rich.top_procs.map((p) => (
                  <li
                    key={`${p.name}-${p.pid}`}
                    className="flex items-baseline justify-between text-[12.5px]"
                  >
                    <span style={{ color: "var(--color-text)" }}>
                      {p.name}{" "}
                      <span style={{ color: "var(--color-text-faint)" }}>
                        ({p.pid})
                      </span>
                    </span>
                    <span
                      className="tabular-nums"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      {p.ram_mb >= 1024
                        ? `${(p.ram_mb / 1024).toFixed(1)} GB`
                        : `${p.ram_mb.toFixed(0)} MB`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* Sub-tab: Tweaks — registry/perf tweaks (F7+ placeholder). */}
      {subTab === "tweaks" && (
        <section className="mb-6">
          <h2 className="mb-2 text-[13px] font-semibold">System tweaks</h2>
          <div
            className="rounded p-6 text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            <p className="mb-2" style={{ color: "var(--color-text-secondary)" }}>
              Per-host system tweaks (registry, scheduled defrag, fast-boot,
              gaming optimisations) will land here in v15.2+ once we wire
              them safely. For now this is a placeholder.
            </p>
            <p>
              Use the Hooks sub-tab to manage Claude Code hooks, or the
              Schedules sub-tab to manage Windows scheduled tasks.
            </p>
          </div>
        </section>
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inner sub-tab header (shared across all System sub-tabs).
// ---------------------------------------------------------------------------

function SystemHeader({
  subTab,
  setSubTab,
  hooksEnabled,
  onRefresh,
  loading,
}: {
  subTab: SystemSubTab;
  setSubTab: (t: SystemSubTab) => void;
  hooksEnabled: boolean;
  onRefresh: () => void;
  loading: boolean;
}) {
  const TABS: { id: SystemSubTab; label: string; hidden?: boolean }[] = [
    { id: "schedules", label: "Schedules" },
    { id: "processes", label: "Processes" },
    { id: "tweaks", label: "Tweaks" },
    { id: "hooks", label: "Hooks", hidden: !hooksEnabled },
  ];
  return (
    <header className="mb-5 flex flex-wrap items-baseline justify-between gap-4 px-10 pt-8">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold leading-tight">System</h1>
        <p
          className="mt-1 text-[13px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Scheduled tasks · processes · per-host tweaks · Claude Code hooks.
        </p>
        <div
          className="mt-3 inline-flex rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {TABS.filter((t) => !t.hidden).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setSubTab(t.id)}
              className="rounded px-3 py-1 text-[12px] font-medium transition-colors"
              style={{
                background: subTab === t.id ? "var(--color-surface-3)" : "transparent",
                color: subTab === t.id ? "var(--color-text)" : "var(--color-text-tertiary)",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      {subTab !== "hooks" && (
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      )}
    </header>
  );
}
