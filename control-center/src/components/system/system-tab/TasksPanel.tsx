// System → Tasks — ULTRON scheduled tasks (wiring 2026-08-11, audit 08-09 #35).
//
// Windows Task Scheduler surface for ULTRON's OWN tasks (backups,
// daily diagnostic…): state, last result, next run, run-now, trigger
// edit and delete. The backend gate lives in src-tauri/src/system.rs: mutating
// actions only accept ULTRON-* task names, and everything shells out to
// scripts/cockpit/system_tasks.ps1 (schtasks wrapper, Windows-only).
//
// Backend commands: list_scheduled_tasks, run_scheduled_task, task_detail,
// rich_system_info, edit_scheduled_task, delete_scheduled_task.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errMsg } from "../../../lib/errors";

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

/** Nombre visible de cada tipo de disparador (el valor se pasa tal cual a schtasks). */
const TRIGGER_LABELS: Record<string, string> = {
  Daily: "Diario",
  Weekly: "Semanal",
  AtLogon: "Al iniciar sesión",
};

/** Estado del Programador de tareas en español; los desconocidos se muestran tal cual. */
const TASK_STATE_LABELS: Record<string, string> = {
  ready: "Lista",
  running: "En ejecución",
  disabled: "Desactivada",
  queued: "En cola",
  unknown: "Desconocido",
};

function taskStateLabel(state: string): string {
  return TASK_STATE_LABELS[state.toLowerCase()] ?? state;
}

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
  return d > 0 ? `${d} d ${h} h` : `${h} h`;
}

/// schtasks devuelve HRESULTs sin signo; 0 = OK, 0x41303 = "aún no ejecutada",
/// 0x41301 = "en ejecución". Cualquier otro valor es un fallo y se muestra
/// como "falló (0x…)" para que el hex no parezca un estado más.
function fmtResult(code: number): { label: string; ok: boolean } {
  if (code === 0) return { label: "OK", ok: true };
  const hex = (code >>> 0).toString(16).toUpperCase();
  if (hex === "41303") return { label: "aún no se ha ejecutado", ok: true };
  if (hex === "41301") return { label: "en ejecución", ok: true };
  return { label: `falló (0x${hex})`, ok: false };
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
      setActionMsg(`No se pudo cargar el detalle: ${errMsg(e)}`);
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
          r.success ? `«${r.name}» lanzada.` : `La ejecución ha fallado: ${r.stderr || "error desconocido"}`,
        );
        await load();
      } catch (e) {
        setActionMsg(`La ejecución ha fallado: ${errMsg(e)}`);
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
          ? `«${r.name}» → ${TRIGGER_LABELS[r.trigger_type] ?? r.trigger_type}${r.trigger_at ? ` a las ${r.trigger_at}` : ""}${
              r.catch_up ? " (recupera las ejecuciones perdidas)" : ""
            }.`
          : `No se pudo editar: ${r.error || "error desconocido"}`,
      );
      setEditName(null);
      await load();
    } catch (e) {
      setActionMsg(`No se pudo editar: ${errMsg(e)}`);
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
          r.success ? `«${r.name}» borrada.` : `No se pudo borrar: ${r.error || "error desconocido"}`,
        );
        await load();
      } catch (e) {
        setActionMsg(`No se pudo borrar: ${errMsg(e)}`);
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
          <span>encendido desde hace {fmtUptime(info.uptime_seconds)}</span>
          <span>
            RAM {info.ram_used_gb.toFixed(1)}/{info.ram_total_gb.toFixed(0)} GB (
            {Math.round(info.ram_pct_used)}%)
          </span>
          <span>C: {info.disk_c_free_gb.toFixed(0)} GB libres</span>
          {info.cpu_load_pct !== null && <span>CPU {info.cpu_load_pct}%</span>}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          {tasks.length > 0
            ? `${tasks.length} tareas de ULTRON en el Programador de tareas de Windows.`
            : "Tareas programadas de ULTRON (watchdog, backups, diagnóstico)."}
        </p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="rounded px-3 py-2 text-[12.5px] font-medium transition-colors disabled:opacity-50"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
        >
          {loading ? "Cargando…" : "Actualizar"}
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
          No se han encontrado tareas programadas de ULTRON.
        </div>
      )}

      <div className="space-y-2">
        {tasks.map((t) => {
          const res = fmtResult(t.last_result);
          const busy = busyName === t.name;
          const isOpen = openName === t.name;
          const isEditing = editName === t.name;
          const isDisabled = t.state.toLowerCase() === "disabled";
          return (
            <div
              key={t.name}
              className="rounded"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              {/* Fixed-width state / result / next columns so they line up
                  across rows; the description no longer hides the state. */}
              <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => void toggleDetail(t.name)}
                  aria-expanded={isOpen}
                  className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  title="Ver el detalle (disparadores, acciones e historial)"
                >
                  <span className="mt-px shrink-0 font-mono text-[12px]" style={{ color: "var(--color-text-tertiary)" }} aria-hidden>
                    {isOpen ? "▾" : "▸"}
                  </span>
                  <span className="min-w-0">
                    <span
                      className="block truncate text-[13px] font-medium"
                      style={{ color: isDisabled ? "var(--color-text-tertiary)" : "var(--color-text)" }}
                    >
                      {t.name}
                    </span>
                    <span className="block truncate text-[11px]" style={{ color: "var(--color-text-tertiary)" }}>
                      {t.description || "Sin descripción"}
                      {t.catch_up ? " · recupera ejecuciones perdidas" : ""}
                    </span>
                  </span>
                </button>

                <span
                  className="w-20 rounded px-1.5 py-0.5 text-center text-[10.5px] font-medium"
                  style={{
                    border: "1px solid var(--color-border)",
                    background: isDisabled ? "transparent" : "var(--color-surface-1)",
                    color: isDisabled ? "var(--color-text-faint, var(--color-text-tertiary))" : "var(--color-text-secondary)",
                  }}
                  title="Estado en el Programador de tareas"
                >
                  {taskStateLabel(t.state)}
                </span>

                <span
                  className="w-28 truncate rounded px-1.5 py-0.5 text-center text-[10.5px] font-medium tabular-nums"
                  style={{
                    border: `1px solid ${res.ok ? "var(--color-border)" : "rgba(248, 81, 73, 0.35)"}`,
                    color: res.ok ? "var(--color-text-secondary)" : "var(--color-danger)",
                  }}
                  title={`last_result de la última ejecución (${fmtWhen(t.last_run)})`}
                >
                  {res.label}
                </span>
                <span className="hidden w-48 truncate text-right text-[11px] tabular-nums sm:inline" style={{ color: "var(--color-text-tertiary)" }}>
                  próxima: {fmtWhen(t.next_run)}
                </span>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void runNow(t.name)}
                    disabled={busy || isDisabled}
                    className="rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
                    style={btn()}
                    title={isDisabled ? "La tarea está desactivada en el Programador de tareas; actívala allí para ejecutarla." : undefined}
                  >
                    {busy ? "…" : "Ejecutar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => (isEditing ? setEditName(null) : startEdit(t))}
                    disabled={busy}
                    className="rounded px-2.5 py-1 text-[11.5px] font-medium disabled:opacity-50"
                    style={btn(isEditing)}
                  >
                    Editar
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
                    {confirmDelete === t.name ? "¿Confirmar?" : "Borrar"}
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
                    Disparador
                    <select
                      value={editType}
                      onChange={(e) => setEditType(e.target.value)}
                      className="rounded px-2 py-1 text-[12px]"
                      style={btn()}
                    >
                      {TRIGGER_TYPES.map((tt) => (
                        <option key={tt} value={tt}>
                          {TRIGGER_LABELS[tt] ?? tt}
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
                    Recuperar la ejecución si el PC estaba apagado
                  </label>
                  <button
                    type="button"
                    onClick={() => void submitEdit()}
                    disabled={busyName === t.name}
                    className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
                    style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
                  >
                    Aplicar
                  </button>
                </div>
              )}

              {/* Lazy detail */}
              {isOpen && (
                <div
                  className="space-y-2 border-t px-3 py-2.5 text-[11.5px]"
                  style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
                >
                  {detailLoading && <span>Cargando el detalle…</span>}
                  {detail && detail.name === t.name && (
                    <>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        <span>se ejecuta como {detail.principal_user} ({detail.principal_logon}, {detail.run_level})</span>
                        <span>perdidas: {detail.missed_runs}</span>
                        <span>última: {fmtWhen(detail.last_run)}</span>
                      </div>
                      {detail.triggers.length > 0 && (
                        <div>
                          <span style={{ color: "var(--color-text-tertiary)" }}>Disparadores: </span>
                          {detail.triggers
                            .map(
                              (tr) =>
                                `${tr.kind}${tr.start ? ` @ ${tr.start}` : ""}${
                                  tr.extra ? ` (${tr.extra})` : ""
                                }${tr.enabled ? "" : " [desactivado]"}`,
                            )
                            .join(" · ")}
                        </div>
                      )}
                      {detail.actions.length > 0 && (
                        <div className="truncate">
                          <span style={{ color: "var(--color-text-tertiary)" }}>Acción: </span>
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
