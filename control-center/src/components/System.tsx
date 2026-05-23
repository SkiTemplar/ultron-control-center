import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirmDialog } from "../lib/dialog";
import type {
  DeleteTaskResult,
  EditTaskResult,
  InstalledApp,
  InstalledAppsReport,
  RichSystemInfo,
  RunTaskResult,
  ScheduledTaskInfo,
  ScheduledTriggerType,
  TaskDetail,
  UninstallAppResult,
} from "../types";
import { Hooks } from "./Hooks";
import { Diagnostics } from "./system/Diagnostics";
import { useFeatures } from "../lib/features";
import { useRoutingTitle } from "../lib/button-prompts";

// v15.2 F8 UX: System now hosts four inner sub-tabs (Processes/Tweaks removed):
//   - Overview  : RAM / CPU / disk health + read-only top procs (informational)
//   - Apps      : inventory of installed apps with open-folder + uninstall
//   - Schedules : scheduled task list (formerly the whole pane)
//   - Hooks     : embedded Hooks admin (moved from sidebar)
type SystemSubTab = "overview" | "apps" | "schedules" | "hooks" | "diagnostics";

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
  initialTriggerType,
  initialTriggerAt,
  onClose,
  onSaved,
}: {
  name: string;
  initialCatchUp: boolean;
  // v15.5.18 review: (data loss bug): if the modal opens for a Weekly /
  // AtLogon task with defaults "Daily" + "09:00", clicking Save silently
  // overwrites the real trigger. Pass the current task's trigger so the
  // form starts populated.
  initialTriggerType?: ScheduledTriggerType;
  initialTriggerAt?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [triggerType, setTriggerType] = useState<ScheduledTriggerType>(
    initialTriggerType ?? "Daily",
  );
  const [triggerAt, setTriggerAt] = useState(initialTriggerAt ?? "09:00");
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
    const ok = await confirmDialog(
      `Delete scheduled task "${name}"? This calls Unregister-ScheduledTask and cannot be undone.`,
      { title: "Delete scheduled task", kind: "warning" },
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

      {showEdit && (() => {
        const first = detail.triggers?.[0];
        let mappedType: ScheduledTriggerType = "Daily";
        let mappedAt: string | undefined;
        if (first) {
          const k = (first.kind || "").toLowerCase();
          if (k.includes("logon") || k.includes("boot")) mappedType = "AtLogon";
          else if (k.includes("week")) mappedType = "Weekly";
          else mappedType = "Daily";
          if (first.start) {
            const matched = /(\d{1,2}):(\d{2})/.exec(first.start);
            if (matched) {
              const hh = matched[1].padStart(2, "0");
              mappedAt = `${hh}:${matched[2]}`;
            }
          }
        }
        return (
          <EditTriggerModal
            name={name}
            initialCatchUp={!!detail.catch_up}
            initialTriggerType={mappedType}
            initialTriggerAt={mappedAt}
            onClose={() => setShowEdit(false)}
            onSaved={onChanged}
          />
        );
      })()}
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
// Apps panel — sub-tab "Apps" under System
// ---------------------------------------------------------------------------

type AppProviderFilter = "all" | "winget" | "store" | "msi" | "manual";

function providerBadgeColor(provider: string): { bg: string; fg: string } {
  switch (provider) {
    case "winget":
      return {
        bg: "rgba(56, 139, 253, 0.12)",
        fg: "var(--color-accent, #58a6ff)",
      };
    case "store":
      return {
        bg: "rgba(163, 113, 247, 0.12)",
        fg: "#a371f7",
      };
    case "msi":
      return {
        bg: "rgba(63, 185, 80, 0.12)",
        fg: "var(--color-success)",
      };
    case "manual":
    default:
      return {
        bg: "rgba(187, 187, 187, 0.10)",
        fg: "var(--color-text-secondary)",
      };
  }
}

function providerLabel(provider: string): string {
  switch (provider) {
    case "winget":
      return "winget";
    case "store":
      return "Store";
    case "msi":
      return "MSI";
    case "manual":
      return "Manual";
    default:
      return provider || "?";
  }
}

/** Single-row uninstall modal. The user must type the exact app name to
 *  confirm — same gesture the OS uses for irreversible mutations. We
 *  surface the resolved command in a collapsible block so the user can
 *  see what we're about to run before they pull the trigger. */
function UninstallModal({
  appInfo,
  onClose,
  onDone,
}: {
  appInfo: InstalledApp;
  onClose: () => void;
  onDone: (result: UninstallAppResult) => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = typed.trim() === appInfo.name.trim() && !busy;

  async function go() {
    if (!armed) return;
    setBusy(true);
    setError(null);
    try {
      const r = (await invoke("uninstall_app", {
        name: appInfo.name,
        provider: appInfo.provider,
        packageId: appInfo.package_id,
      })) as UninstallAppResult;
      onDone(r);
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
        <div className="mb-2 text-[13px] font-semibold" style={{ color: "var(--color-text)" }}>
          Uninstall {appInfo.name}?
        </div>
        <div
          className="mb-3 text-[11.5px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          This will invoke the {providerLabel(appInfo.provider)} uninstaller. The
          action is irreversible and may require admin elevation depending on
          the package. Type the app name below to confirm.
        </div>
        <input
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={appInfo.name}
          className="w-full rounded px-2 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
            fontFamily: "var(--font-mono)",
          }}
        />
        {error && (
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
        )}
        <div className="mt-3 flex items-center justify-end gap-2">
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
            onClick={go}
            disabled={!armed}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "rgba(248, 81, 73, 0.85)",
              color: "white",
            }}
          >
            {busy ? "Uninstalling…" : "Uninstall"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AppsPanel() {
  const [report, setReport] = useState<InstalledAppsReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<AppProviderFilter>("all");
  const [pendingUninstall, setPendingUninstall] = useState<InstalledApp | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);

  async function load(force: boolean) {
    setLoading(true);
    setError(null);
    try {
      const r = (await invoke("list_installed_apps", { force })) as InstalledAppsReport;
      setReport(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
  }, []);

  const filtered = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.apps.filter((a) => {
      if (providerFilter !== "all" && a.provider !== providerFilter) return false;
      if (!q) return true;
      const hay = `${a.name} ${a.publisher || ""} ${a.package_id || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [report, query, providerFilter]);

  const counts = useMemo(() => {
    const map: Record<string, number> = { winget: 0, store: 0, msi: 0, manual: 0 };
    for (const a of report?.apps || []) {
      map[a.provider] = (map[a.provider] || 0) + 1;
    }
    return map;
  }, [report]);

  const wingetMissing = (report?.source_errors || []).some((m) => /winget/i.test(m));

  async function handleOpenFolder(app: InstalledApp) {
    if (!app.install_location) return;
    setActionMsg(null);
    try {
      await invoke("open_app_folder", { installLocation: app.install_location });
      setActionMsg(`Opened ${app.install_location}`);
    } catch (e) {
      setActionMsg(`Failed to open folder: ${e}`);
    }
  }

  return (
    <section className="mb-6">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search by name, publisher, id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-[240px] flex-1 rounded px-2.5 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
        />
        <div
          className="flex items-center gap-0.5 rounded p-0.5"
          style={{
            background: "var(--color-surface-1)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {(["all", "winget", "store", "msi", "manual"] as AppProviderFilter[]).map((p) => {
            const selected = providerFilter === p;
            const count = p === "all" ? report?.apps.length || 0 : counts[p] || 0;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setProviderFilter(p)}
                className="rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors"
                style={{
                  background: selected ? "var(--color-surface-3)" : "transparent",
                  color: selected ? "var(--color-text)" : "var(--color-text-tertiary)",
                }}
                title={`Filter by ${p}`}
              >
                {p === "all" ? "All" : providerLabel(p)}
                <span
                  className="ml-1.5 text-[10.5px] tabular-nums"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => load(true)}
          disabled={loading}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title="Bypass the 1h cache and re-scan"
        >
          {loading ? "Scanning…" : "Refresh"}
        </button>
      </div>

      {report?.cached && (
        <div
          className="mb-2 text-[10.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Cached snapshot from {report.generated_at} — hit Refresh to re-scan.
        </div>
      )}

      {wingetMissing && (
        <div
          className="mb-2 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(210, 153, 34, 0.06)",
            border: "1px solid rgba(210, 153, 34, 0.22)",
            color: "var(--color-warn)",
          }}
        >
          winget not available on PATH — modern packages may be missing from
          the list. Registry-tracked apps (MSI / manual) are still shown.
        </div>
      )}

      {error && (
        <div
          className="mb-2 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {actionMsg && (
        <div
          className="mb-2 rounded p-2 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {actionMsg}
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div
          className="rounded p-6 text-center text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {report?.apps.length
            ? "No apps match the current filter."
            : "No installed apps detected."}
        </div>
      )}

      {filtered.length > 0 && (
        <div
          className="overflow-hidden rounded"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <div
            className="grid items-center gap-3 px-3 py-2 text-[10px] uppercase tracking-[0.06em]"
            style={{
              gridTemplateColumns: "minmax(0, 2.6fr) 70px 80px minmax(0, 1.4fr) 150px",
              borderBottom: "1px solid var(--color-border)",
              background: "var(--color-surface-1)",
              color: "var(--color-text-tertiary)",
            }}
          >
            <span>Name</span>
            <span>Provider</span>
            <span>Version</span>
            <span>Install location</span>
            <span className="text-right">Actions</span>
          </div>
          <div>
            {filtered.map((appInfo, i) => {
              const colors = providerBadgeColor(appInfo.provider);
              const hasFolder = !!appInfo.install_location;
              return (
                <div
                  key={`${appInfo.provider}|${appInfo.name}|${appInfo.package_id || i}`}
                  className="grid items-center gap-3 px-3 py-2 text-[12px]"
                  style={{
                    gridTemplateColumns:
                      "minmax(0, 2.6fr) 70px 80px minmax(0, 1.4fr) 150px",
                    borderTop: i === 0 ? "none" : "1px solid var(--color-border)",
                  }}
                >
                  <div className="min-w-0">
                    <div
                      className="truncate font-medium"
                      style={{ color: "var(--color-text)" }}
                      title={appInfo.name}
                    >
                      {appInfo.name}
                    </div>
                    {(appInfo.publisher || appInfo.package_id) && (
                      <div
                        className="truncate text-[10.5px]"
                        style={{ color: "var(--color-text-tertiary)" }}
                        title={`${appInfo.publisher || ""}${
                          appInfo.publisher && appInfo.package_id ? " · " : ""
                        }${appInfo.package_id || ""}`}
                      >
                        {appInfo.publisher}
                        {appInfo.publisher && appInfo.package_id ? " · " : ""}
                        {appInfo.package_id && (
                          <span style={{ fontFamily: "var(--font-mono)" }}>
                            {appInfo.package_id}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <span
                    className="inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                    style={{ background: colors.bg, color: colors.fg }}
                  >
                    {providerLabel(appInfo.provider)}
                  </span>
                  <span
                    className="truncate tabular-nums text-[11px]"
                    style={{ color: "var(--color-text-secondary)" }}
                    title={appInfo.version || ""}
                  >
                    {appInfo.version || "—"}
                  </span>
                  <span
                    className="truncate text-[11px]"
                    style={{
                      color: hasFolder
                        ? "var(--color-text-secondary)"
                        : "var(--color-text-faint)",
                      fontFamily: hasFolder ? "var(--font-mono)" : undefined,
                    }}
                    title={appInfo.install_location || "unknown"}
                  >
                    {appInfo.install_location || "—"}
                  </span>
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      type="button"
                      onClick={() => handleOpenFolder(appInfo)}
                      disabled={!hasFolder}
                      className="rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:opacity-30"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                      title={
                        hasFolder
                          ? "Open install folder in Explorer"
                          : "No install location reported"
                      }
                    >
                      Folder
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingUninstall(appInfo)}
                      className="rounded px-2 py-1 text-[10.5px] font-medium transition-colors"
                      style={{
                        background: "rgba(248, 81, 73, 0.08)",
                        color: "var(--color-danger)",
                        border: "1px solid rgba(248, 81, 73, 0.32)",
                      }}
                      title={`Uninstall via ${providerLabel(appInfo.provider)}`}
                    >
                      Uninstall
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {pendingUninstall && (
        <UninstallModal
          appInfo={pendingUninstall}
          onClose={() => setPendingUninstall(null)}
          onDone={(r) => {
            setActionMsg(
              r.success
                ? `Uninstalled ${pendingUninstall.name}.`
                : `Uninstall failed (exit ${r.exit_code ?? "?"}): ${
                    r.stderr || r.stdout || "unknown error"
                  }`,
            );
            // Refresh in the background so the row disappears on success.
            load(true);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function System() {
  // v15.3.6: default to Schedules (was overview). Reordered per user.
  // Eval #4 Linux: Schedules is Windows-only (system.rs returns Err on Linux).
  // Default sub-tab to "overview" so Linux users don't land on an unusable
  // empty table on first open.
  const _isWin =
    typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
  const [subTab, setSubTab] = useState<SystemSubTab>(_isWin ? "schedules" : "overview");
  const { features } = useFeatures();
  const hooksEnabled = features.hooks !== false;

  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([]);
  const [rich, setRich] = useState<RichSystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [runningName, setRunningName] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunTaskResult | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const scheduleTaskTitle = useRoutingTitle(
    "system.schedule_task_ai",
    "Register a new Windows scheduled task with AI. cwd=instructions/tasks/ with GUIDE.md auto-loaded.",
  );

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
                Hooks feature is disabled. Enable it from Settings → Features.
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

      {/* Sub-tab: Apps — inventory of installed apps with open-folder + uninstall. */}
      {subTab === "apps" && <AppsPanel />}

      {/* Sub-tab: Diagnostics — P6 native PC diagnostic + AI analysis + history + schedule. */}
      {subTab === "diagnostics" && <Diagnostics />}

      {/* Sub-tab: Overview — RAM/CPU/disk + read-only top processes. */}
      {subTab === "overview" && (
        <section className="mb-6">
          {!rich && !loading && (
            <div
              className="rounded p-6 text-center text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-tertiary)",
              }}
            >
              No system info available.
            </div>
          )}
          {rich && <RichInfo info={rich} />}
        </section>
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
                // v15.2.40: prompt + provider/model/agent come from the
                // central catalog (key "system.schedule_task_ai") and
                // the `system_analyse` AI Router zone. Auto-mode picks
                // the best subagent via embed_agents.py query.
                const { resolveAndSpawn } = await import("../lib/button-prompts");
                await resolveAndSpawn({
                  key: "system.schedule_task_ai",
                  cwd: instr,
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
            title={scheduleTaskTitle}
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
  // v15.3.6: reorder per user request — Schedules is the most-used sub-tab,
  // followed by Hooks, then Overview, then Apps last.
  const TABS: { id: SystemSubTab; label: string; hidden?: boolean }[] = [
    { id: "schedules", label: "Schedules" },
    { id: "diagnostics", label: "Diagnostics" },
    { id: "hooks", label: "Hooks", hidden: !hooksEnabled },
    { id: "overview", label: "Overview" },
    { id: "apps", label: "Apps" },
  ];
  return (
    <header className="mb-5 flex flex-wrap items-baseline justify-between gap-4 px-10 pt-8">
      <div className="min-w-0">
        <h1 className="text-[20px] font-semibold leading-tight">System</h1>
        <p
          className="mt-1 text-[13px]"
          style={{ color: "var(--color-text-secondary)" }}
        >
          System health overview · scheduled tasks · Claude Code hooks.
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
      {subTab !== "hooks" && subTab !== "apps" && subTab !== "diagnostics" && (
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

