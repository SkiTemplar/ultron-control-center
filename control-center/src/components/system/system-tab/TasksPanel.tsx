// System → Tasks — ULTRON scheduled tasks (wiring 2026-08-11, audit 08-09 #35).
//
// Windows Task Scheduler surface for ULTRON's OWN tasks (watchdog Qdrant,
// backups, daily diagnostic…): state, last result, next run, run-now, trigger
// edit and delete. The backend gate lives in src-tauri/src/system.rs: mutating
// actions only accept ULTRON-* task names, and everything shells out to
// scripts/cockpit/system_tasks.ps1 (schtasks wrapper, Windows-only).
//
// Backend commands: list_scheduled_tasks, run_scheduled_task, task_detail,
// rich_system_info, edit_scheduled_task, delete_scheduled_task.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// ---------------------------------------------------------------------------
// Types (mirror src-tauri/src/system.rs serde shapes)
// ---------------------------------------------------------------------------

interface ScheduledTaskInfo {
  name: string;
  state: string;
  last_run: string;
  next_run: string;
  last_result: number;
  description: string | null;
  catch_up: boolean;
}

interface TaskTrigger {
  kind: string;
  start: string;
  enabled: boolean;
  extra: string;
}

interface TaskAction {
  execute: string;
  arguments: string;
  working: string;
}

interface TaskEvent {
  time: string;
  event_id: number;
  message: string;
}

interface TaskDetail {
  name: string;
  description: string | null;
  author: string | null;
  state: string;
  last_run: string;
  next_run: string;
  last_result: number;
  missed_runs: number;
  principal_user: string;
  principal_logon: string;
  run_level: string;
  triggers: TaskTrigger[];
  actions: TaskAction[];
  history: TaskEvent[];
  catch_up: boolean;
}

interface RunTaskResult {
  success: boolean;
  name: string;
  stderr: string;
}

interface EditTaskResult {
  success: boolean;
  name: string;
  trigger_type: string;
  trigger_at: string;
  error: string;
  catch_up: boolean;
}

interface DeleteTaskResult {
  success: boolean;
  name: string;
  error: string;
}

interface RichSystemInfo {
  hostname: string;
  user: string;
  os_name: string;
  uptime_seconds: number;
  cpu_name: string;
  cpu_load_pct: number | null;
  ram_used_gb: number;
  ram_total_gb: number;
  ram_pct_used: number;
  disk_c_free_gb: number;
  disk_c_pct_used: number;
}

const TRIGGER_TYPES = ["Daily", "Weekly", "AtLogon"] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3_600);
  return d > 0 ? `${d}d ${h}h` : `${h}h`;
}

/// schtasks devuelve HRESULTs sin signo; 0 = OK, 0x41303 = "aún no ejecutada",
/// 0x41301 = "en ejecución". Cualquier otro valor se muestra en hex.
function fmtResult(code: number): { label: string; ok: boolean } {
  if (code === 0) return { label: "OK", ok: true };
  const hex = (code >>> 0).toString(16).toUpperCase();
  if (hex === "41303") return { label: "never ran", ok: true };
  if (hex === "41301") return { label: "running", ok: true };
  return { label: `0x${hex}`, ok: false };
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Unexpected error";
}

// ---------------------------------------------------------------------------
// TasksPanel
// ---------------------------------------------------------------------------

export function TasksPanel() {
  const [tasks, setTasks] = useState<ScheduledTaskInfo[]>([]);
  const [info, setInfo] = useState<RichSystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);

  // Expanded detail per task (lazy-loaded on expand).
  const [openName, setOpenName] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Inline trigger editor state.
  const [editName, setEditName] = useState<string | null>(null);
  const [editType, setEditType] = useState<string>("Daily");
  const [editAt, setEditAt] = useState<string>("08:00");
  const [editCatchUp, setEditCatchUp] = useState<boolean>(true);

  // Two-phase confirm for delete.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [t, ri] = await Promise.all([
        invoke("list_scheduled_tasks") as Promise<ScheduledTaskInfo[]>,
        (invoke("rich_system_info") as Promise<RichSystemInfo>).catch(() => null),
      ]);
      setTasks(t ?? []);
      setInfo(ri);
    } catch (e) {
      setError(errMsg(e));
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleDetail = useCallback(async (name: string) => {
    if (openName === name) {
      setOpenName(null);
      setDetail(null);
      return;
    }
    setOpenName(name);
    setDetail(null);
    setDetailLoading(true);
    try {
      const d = (await invoke("task_detail", { name })) as TaskDetail;
      setDetail(d);
    } catch (e) {
      setActionMsg(`Detail failed: ${errMsg(e)}`);
      setOpenName(null);
    } finally {
      setDetailLoading(false);
    }
  }, [openName]);

  const runNow = useCallback(
    async (name: string) => {
      setBusyName(name);
      setActionMsg(null);
      try {
        const r = (await invoke("run_scheduled_task", { name })) as RunTaskResult;
        setActionMsg(
          r.success ? `Triggered '${r.name}'.` : `Run failed: ${r.stderr || "unknown"}`,
        );
        await load();
      } catch (e) {
        setActionMsg(`Run failed: ${errMsg(e)}`);
      } finally {
        setBusyName(null);
      }
    },
    [load],
  );

  const startEdit = useCallback((t: ScheduledTaskInfo) => {
    setEditName(t.name);
    setEditType("Daily");
    setEditAt("08:00");
    setEditCatchUp(t.catch_up);
  }, []);

  const submitEdit = useCallback(async () => {
    if (!editName) return;
    setBusyName(editName);
    setActionMsg(null);
    try {
      const r = (await invoke("edit_scheduled_task", {
        name: editName,
        newTriggerType: editType,
        newTriggerAt: editType === "AtLogon" ? null : editAt,
        catchUp: editCatchUp,
      })) as EditTaskResult;
      setActionMsg(
        r.success
          ? `'${r.name}' → ${r.trigger_type}${r.trigger_at ? ` @ ${r.trigger_at}` : ""}${
              r.catch_up ? " (catch-up on)" : ""
            }.`
          : `Edit failed: ${r.error || "unknown"}`,
      );
      setEditName(null);
      await load();
    } catch (e) {
      setActionMsg(`Edit failed: ${errMsg(e)}`);
    } finally {
      setBusyName(null);
    }
  }, [editName, editType, editAt, editCatchUp, load]);

  const doDelete = useCallback(
    async (name: string) => {
      if (confirmDelete !== name) {
        setConfirmDelete(name);
        window.setTimeout(() => {
          setConfirmDelete((cur) => (cur === name ? null : cur));
        }, 4000);
        return;
      }
      setConfirmDelete(null);
      setBusyName(name);
      setActionMsg(null);
      try {
        const r = (await invoke("delete_scheduled_task", { name })) as DeleteTaskResult;
        setActionMsg(
          r.success ? `Deleted '${r.name}'.` : `Delete failed: ${r.error || "unknown"}`,
        );
        await load();
      } catch (e) {
        setActionMsg(`Delete failed: ${errMsg(e)}`);
      } finally {
        setBusyName(null);
      }
    },
    [confirmDelete, load],
  );

  const btn = (active = false) =>
    ({
      background: active ? "var(--color-surface-3)" : "var(--color-surface-1)",
      border: "1px solid var(--color-border-strong)",
      color: "var(--color-text)",
    }) as const;

  return (
    <section className="mb-6 space-y-3">
      {/* Rich system strip */}
      {info && (
        <div
          className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded px-3 py-2 text-[11.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          <span>
            {info.hostname} · {info.os_name}
          </span>
          <span>uptime {fmtUptime(info.uptime_seconds)}</span>
          <span>
            RAM {info.ram_used_gb.toFixed(1)}/{info.ram_total_gb.toFixed(0)} GB (
            {Math.round(info.ram_pct_used)}%)
          </span>
          <span>C: libre {info.disk_c_free_gb.toFixed(0)} GB</span>
          {info.cpu_load_pct !== null && <span>CPU {info.cpu_load_pct}%</span>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {tasks.length > 0
            ? `${tasks.length} tareas ULTRON en el Task Scheduler de Windows.`
            : "Tareas programadas de ULTRON (watchdog, backups, diagnóstico)."}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded px-3 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && (
        <div
          className="rounded p-3 text-[12.5px]"
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
          className="rounded p-2 text-[12px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          {actionMsg}
        </div>
      )}

      {!loading && tasks.length === 0 && !error && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          No ULTRON scheduled tasks found.
        </div>
      )}

      <div className="space-y-2">
        {tasks.map((t) => {
          const res = fmtResult(t.last_result);
          const busy = busyName === t.name;
          const isOpen = openName === t.name;
          const isEditing = editName === t.name;
          return (
            <div
              key={t.name}
              className="rounded"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => void toggleDetail(t.name)}
                  className="min-w-0 flex-1 text-left"
                  title="Ver detalle (triggers, acciones, historial)"
                >
                  <span className="block truncate text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
                    {t.name}
                  </span>
                  <span className="block truncate text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                    {t.description || t.state}
                    {t.catch_up ? " · catch-up" : ""}
                  </span>
                </button>

                <span
                  className="rounded px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums"
                  style={{
                    border: "1px solid var(--color-border)",
                    color: res.ok ? "var(--color-text-secondary)" : "var(--color-danger)",
                  }}
                  title={`last_result de la última ejecución (${fmtWhen(t.last_run)})`}
                >
                  {res.label}
                </span>
                <span className="hidden text-[11px] tabular-nums sm:inline" style={{ color: "var(--color-text-tertiary)" }}>
                  next {fmtWhen(t.next_run)}
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void runNow(t.name)}
                    disabled={busy}
                    className="rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
                    style={btn()}
                  >
                    {busy ? "…" : "Run"}
                  </button>
                  <button
                    type="button"
                    onClick={() => (isEditing ? setEditName(null) : startEdit(t))}
                    disabled={busy}
                    className="rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
                    style={btn(isEditing)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void doDelete(t.name)}
                    disabled={busy}
                    className="rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
                    style={{
                      background: confirmDelete === t.name ? "var(--color-danger)" : "var(--color-surface-1)",
                      border: "1px solid var(--color-border-strong)",
                      color: confirmDelete === t.name ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                    }}
                  >
                    {confirmDelete === t.name ? "Confirm?" : "Delete"}
                  </button>
                </div>
              </div>

              {/* Inline trigger editor */}
              {isEditing && (
                <div
                  className="flex flex-wrap items-end gap-3 border-t px-3 py-2.5"
                  style={{ borderColor: "var(--color-border)" }}
                >
                  <label className="flex flex-col gap-1 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                    Trigger
                    <select
                      value={editType}
                      onChange={(e) => setEditType(e.target.value)}
                      className="rounded px-2 py-1 text-[12px]"
                      style={btn()}
                    >
                      {TRIGGER_TYPES.map((tt) => (
                        <option key={tt} value={tt}>
                          {tt}
                        </option>
                      ))}
                    </select>
                  </label>
                  {editType !== "AtLogon" && (
                    <label className="flex flex-col gap-1 text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                      Hora (HH:MM)
                      <input
                        type="time"
                        value={editAt}
                        onChange={(e) => setEditAt(e.target.value)}
                        className="rounded px-2 py-1 text-[12px]"
                        style={btn()}
                      />
                    </label>
                  )}
                  <label className="flex items-center gap-1.5 pb-1 text-[12px]" style={{ color: "var(--color-text-secondary)" }}>
                    <input
                      type="checkbox"
                      checked={editCatchUp}
                      onChange={(e) => setEditCatchUp(e.target.checked)}
                    />
                    Catch-up si el PC estaba apagado
                  </label>
                  <button
                    type="button"
                    onClick={() => void submitEdit()}
                    disabled={busyName === t.name}
                    className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                    style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
                  >
                    Apply
                  </button>
                </div>
              )}

              {/* Lazy detail */}
              {isOpen && (
                <div
                  className="space-y-2 border-t px-3 py-2.5 text-[11.5px]"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
                >
                  {detailLoading && <span>Loading detail…</span>}
                  {detail && detail.name === t.name && (
                    <>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <span>runs as {detail.principal_user} ({detail.principal_logon}, {detail.run_level})</span>
                        <span>missed {detail.missed_runs}</span>
                        <span>last {fmtWhen(detail.last_run)}</span>
                      </div>
                      {detail.triggers.length > 0 && (
                        <div>
                          <span style={{ color: "var(--color-text-tertiary)" }}>Triggers: </span>
                          {detail.triggers
                            .map(
                              (tr) =>
                                `${tr.kind}${tr.start ? ` @ ${tr.start}` : ""}${
                                  tr.extra ? ` (${tr.extra})` : ""
                                }${tr.enabled ? "" : " [disabled]"}`,
                            )
                            .join(" · ")}
                        </div>
                      )}
                      {detail.actions.length > 0 && (
                        <div className="truncate">
                          <span style={{ color: "var(--color-text-tertiary)" }}>Action: </span>
                          <code className="text-[11px]">
                            {detail.actions[0].execute} {detail.actions[0].arguments}
                          </code>
                        </div>
                      )}
                      {detail.history.length > 0 && (
                        <div className="space-y-0.5">
                          <span style={{ color: "var(--color-text-tertiary)" }}>Historial:</span>
                          {detail.history.slice(0, 6).map((h, i) => (
                            <div key={i} className="truncate tabular-nums">
                              {fmtWhen(h.time)} · #{h.event_id} {h.message}
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
