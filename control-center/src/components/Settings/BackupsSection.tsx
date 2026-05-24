import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ---------------------------------------------------------------------------
// Backups (rewrite 2026-05-24, backups-redesign):
//
// Single-panel UX with five rows: destination, folders, schedule, last
// backup + force-run. The three legacy sub-panels (BackupRootEditor,
// BackupSourcesEditor, DiskBackupStatus) collapsed into one component so
// the user sees everything they need to think about in one place — no
// presets, no candidates list, no schedule explainer block.
//
// Backend surface used:
//   - get_backup_root / set_backup_root          (destination)
//   - get_backup_sources / set_backup_sources    (folder list)
//   - get_backup_schedule / set_backup_schedule  (day/time + schtasks)
//   - backup_status                              (last-run timestamps)
//   - run_backup_now                             (force-run button)
//
// Folder paths are stored as $HOME-relative names when the user picks a
// subfolder of $HOME (portable across user accounts) and as absolute
// paths otherwise. The backend + weekly-backup.ps1 accept both shapes.
// ---------------------------------------------------------------------------

type BackupEntry = {
  name: string;
  path: string;
  last_modified: string | null;
  age_hours: number | null;
  exists: boolean;
  status: string;
};

type BackupStatusReport = {
  root: string;
  root_exists: boolean;
  entries: BackupEntry[];
  overall_status: string;
};

type BackupRootInfo = {
  current: string;
  suggested: string;
  exists: boolean;
  user_configured: boolean;
  config_path: string;
};

type BackupSourceCandidate = {
  name: string;
  absolute: string;
  exists: boolean;
  selected: boolean;
  is_default: boolean;
};

type BackupSourcesInfo = {
  configured: string[];
  defaults: string[];
  active: string[];
  candidates: BackupSourceCandidate[];
  config_path: string;
  user_configured: boolean;
};

type BackupScheduleInfo = {
  day: string;
  time: string;
  task_registered: boolean;
  user_configured: boolean;
};

const WEEKDAYS: { code: string; label: string }[] = [
  { code: "MON", label: "Monday" },
  { code: "TUE", label: "Tuesday" },
  { code: "WED", label: "Wednesday" },
  { code: "THU", label: "Thursday" },
  { code: "FRI", label: "Friday" },
  { code: "SAT", label: "Saturday" },
  { code: "SUN", label: "Sunday" },
];

function relativeTime(iso?: string | null): string {
  if (!iso) return "never";
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return iso;
  const diff = Date.now() - ts.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} day${d === 1 ? "" : "s"} ago`;
  const months = Math.floor(d / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

function nextRunLabel(day: string, time: string): string {
  const label = WEEKDAYS.find((w) => w.code === day)?.label ?? day;
  return `${label} at ${time}`;
}

function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/");
}

function displayFolder(stored: string): string {
  if (isAbsolutePath(stored)) return stored;
  return `~/${stored.replace(/\\/g, "/")}`;
}

function normalisePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// BackupsPanel — the unified Backups settings section.
// ---------------------------------------------------------------------------

export function BackupsPanel() {
  // Destination
  const [root, setRoot] = useState<BackupRootInfo | null>(null);
  const [rootBusy, setRootBusy] = useState(false);

  // Folders
  const [sources, setSources] = useState<BackupSourcesInfo | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [initialFolders, setInitialFolders] = useState<string[]>([]);
  const [foldersBusy, setFoldersBusy] = useState(false);

  // Schedule
  const [schedule, setSchedule] = useState<BackupScheduleInfo | null>(null);
  const [scheduleDay, setScheduleDay] = useState<string>("MON");
  const [scheduleTime, setScheduleTime] = useState<string>("09:00");
  const [scheduleBusy, setScheduleBusy] = useState(false);

  // Status + force-run
  const [status, setStatus] = useState<BackupStatusReport | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [running, setRunning] = useState(false);

  // Shared
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Derived: home prefix used to convert picked absolute paths into
  // home-relative names. We infer it from the first source candidate the
  // backend returned (it always returns at least the default sources).
  const home = useMemo(() => {
    const first = sources?.candidates?.[0];
    if (!first) return "";
    const tail = first.name;
    const abs = first.absolute;
    const idx = abs.toLowerCase().lastIndexOf(tail.toLowerCase());
    if (idx > 0) return abs.slice(0, idx).replace(/[\\/]+$/, "");
    return "";
  }, [sources]);

  async function loadRoot() {
    try {
      const r = (await invoke("get_backup_root")) as BackupRootInfo;
      setRoot(r);
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadSources() {
    try {
      const r = (await invoke("get_backup_sources")) as BackupSourcesInfo;
      setSources(r);
      setFolders([...r.active]);
      setInitialFolders([...r.active]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadSchedule() {
    try {
      const r = (await invoke("get_backup_schedule")) as BackupScheduleInfo;
      setSchedule(r);
      setScheduleDay(r.day);
      setScheduleTime(r.time);
    } catch (e) {
      // Schedule is non-critical for the rest of the UI; show the error
      // inline only if nothing else has surfaced yet.
      setError((prev) => prev ?? String(e));
    }
  }

  async function loadStatus() {
    setStatusLoading(true);
    try {
      const r = (await invoke("backup_status")) as BackupStatusReport;
      setStatus(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setStatusLoading(false);
    }
  }

  useEffect(() => {
    void loadRoot();
    void loadSources();
    void loadSchedule();
    void loadStatus();
  }, []);

  function flashSuccess(msg: string) {
    setSuccess(msg);
    window.setTimeout(() => setSuccess(null), 3500);
  }

  // ---------------------------------------------------------------------
  // Destination
  // ---------------------------------------------------------------------
  async function browseDestination() {
    setError(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Select backup destination",
        defaultPath: root?.current || root?.suggested || undefined,
      });
      if (typeof picked !== "string" || !picked.trim()) return;
      setRootBusy(true);
      const r = (await invoke("set_backup_root", {
        path: picked.trim(),
      })) as BackupRootInfo;
      setRoot(r);
      flashSuccess(`Destination set to ${r.current}.`);
      void loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setRootBusy(false);
    }
  }

  // ---------------------------------------------------------------------
  // Folders
  // ---------------------------------------------------------------------
  async function addFolder() {
    setError(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a folder to back up",
        defaultPath: home || undefined,
      });
      if (typeof picked !== "string" || !picked.trim()) return;
      // Store $HOME-relative when applicable, absolute otherwise.
      let stored = picked.trim();
      if (home && stored.toLowerCase().startsWith(home.toLowerCase())) {
        stored = stored.slice(home.length).replace(/^[\\/]+/, "");
        if (!stored) {
          setError("Pick a subfolder of your home directory, not the home itself.");
          return;
        }
      }
      const norm = normalisePath(stored);
      if (folders.some((p) => normalisePath(p) === norm)) {
        setError("That folder is already in the list.");
        return;
      }
      setFolders((prev) => [...prev, stored]);
    } catch (e) {
      setError(String(e));
    }
  }

  function removeFolder(path: string) {
    setFolders((prev) => prev.filter((p) => p !== path));
  }

  const foldersDirty = useMemo(() => {
    if (folders.length !== initialFolders.length) return true;
    const a = folders.map(normalisePath).sort();
    const b = initialFolders.map(normalisePath).sort();
    return a.some((v, i) => v !== b[i]);
  }, [folders, initialFolders]);

  async function saveFolders() {
    setError(null);
    setFoldersBusy(true);
    try {
      const r = (await invoke("set_backup_sources", {
        sources: folders,
      })) as BackupSourcesInfo;
      setSources(r);
      setFolders([...r.active]);
      setInitialFolders([...r.active]);
      flashSuccess(
        r.active.length === 0
          ? "Cleared — no folders are being backed up right now."
          : `Saved ${r.active.length} folder${r.active.length === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setFoldersBusy(false);
    }
  }

  // ---------------------------------------------------------------------
  // Schedule
  // ---------------------------------------------------------------------
  const scheduleDirty = useMemo(() => {
    if (!schedule) return true;
    return scheduleDay !== schedule.day || scheduleTime !== schedule.time;
  }, [schedule, scheduleDay, scheduleTime]);

  async function saveSchedule() {
    setError(null);
    setScheduleBusy(true);
    try {
      const r = (await invoke("set_backup_schedule", {
        day: scheduleDay,
        time: scheduleTime,
      })) as BackupScheduleInfo;
      setSchedule(r);
      setScheduleDay(r.day);
      setScheduleTime(r.time);
      flashSuccess(
        r.task_registered
          ? `Schedule saved — runs every ${nextRunLabel(r.day, r.time)}.`
          : `Schedule preference saved. Task Scheduler integration pending on this platform.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setScheduleBusy(false);
    }
  }

  // ---------------------------------------------------------------------
  // Force backup now
  // ---------------------------------------------------------------------
  async function forceBackup() {
    setError(null);
    setRunning(true);
    try {
      const result = await invoke("run_backup_now");
      const ok =
        typeof result === "object" && result !== null && (result as { success?: boolean }).success;
      flashSuccess(ok ? "Backup finished." : "Backup ran with errors — see logs.");
      void loadStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  // Newest mirror across all entries.
  const newest = useMemo(() => {
    if (!status) return null;
    const sorted = [...status.entries]
      .filter((e) => e.last_modified)
      .sort((a, b) => {
        const at = a.last_modified ?? "";
        const bt = b.last_modified ?? "";
        return at < bt ? 1 : at > bt ? -1 : 0;
      });
    return sorted[0] ?? null;
  }, [status]);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  return (
    <div
      className="rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <h3 className="text-[13px] font-semibold">Backup</h3>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Mirrors the folders below to the destination on the configured weekly
        schedule. New and changed files are copied; deletions at the source
        also remove the mirrored copy.
      </p>

      {/* Destination */}
      <div className="mt-4">
        <label
          className="mb-1.5 block text-[11.5px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Destination
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="truncate rounded px-3 py-1.5 text-[12.5px]"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              fontFamily: "var(--font-mono)",
              minWidth: 280,
              flex: "1 1 280px",
            }}
            title={root?.current ?? ""}
          >
            {root?.current ?? "—"}
          </div>
          <button
            type="button"
            onClick={browseDestination}
            disabled={rootBusy}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Open the folder picker"
          >
            {rootBusy ? "Saving…" : "Browse"}
          </button>
        </div>
        {root && !root.exists && (
          <div
            className="mt-1 text-[10.5px]"
            style={{ color: "var(--color-warn)" }}
          >
            Destination does not exist yet — create it before the next backup runs.
          </div>
        )}
      </div>

      {/* Folders */}
      <div className="mt-5">
        <div className="mb-1.5 flex items-baseline justify-between">
          <label
            className="text-[11.5px] font-semibold"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Folders to back up
          </label>
          <button
            type="button"
            onClick={addFolder}
            disabled={foldersBusy}
            className="rounded px-2.5 py-1 text-[11.5px] transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            + Add folder
          </button>
        </div>
        {folders.length === 0 ? (
          <div
            className="rounded px-3 py-2 text-[11.5px]"
            style={{
              background: "var(--color-surface-1)",
              border: "1px dashed var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No folders configured. Click "+ Add folder" to pick one.
          </div>
        ) : (
          <div
            className="overflow-hidden rounded"
            style={{ border: "1px solid var(--color-border)" }}
          >
            {folders.map((path, idx) => (
              <div
                key={path}
                className="flex items-center gap-3 px-3 py-2"
                style={{
                  borderTop: idx === 0 ? "none" : "1px solid var(--color-border)",
                  background: "var(--color-surface-1)",
                }}
              >
                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-[12px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text)",
                    }}
                    title={path}
                  >
                    {displayFolder(path)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeFolder(path)}
                  disabled={foldersBusy}
                  className="rounded px-2 py-0.5 text-[10.5px] transition-colors disabled:opacity-40"
                  style={{
                    background: "transparent",
                    color: "var(--color-text-tertiary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        {foldersDirty && (
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={saveFolders}
              disabled={foldersBusy}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              {foldersBusy ? "Saving…" : "Save folders"}
            </button>
            <button
              type="button"
              onClick={() => setFolders([...initialFolders])}
              disabled={foldersBusy}
              className="rounded px-2.5 py-1.5 text-[11.5px] transition-colors disabled:opacity-40"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Discard
            </button>
          </div>
        )}
      </div>

      {/* Schedule */}
      <div className="mt-5">
        <label
          className="mb-1.5 block text-[11.5px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Schedule
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Day
          </label>
          <select
            value={scheduleDay}
            onChange={(e) => setScheduleDay(e.target.value)}
            disabled={scheduleBusy}
            className="rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {WEEKDAYS.map((d) => (
              <option key={d.code} value={d.code}>
                {d.label}
              </option>
            ))}
          </select>
          <label
            className="ml-2 text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Time
          </label>
          <input
            type="time"
            value={scheduleTime}
            onChange={(e) => setScheduleTime(e.target.value)}
            disabled={scheduleBusy}
            className="rounded px-2 py-1 text-[12px]"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              fontFamily: "var(--font-mono)",
            }}
          />
          <button
            type="button"
            onClick={saveSchedule}
            disabled={scheduleBusy || !scheduleDirty}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: scheduleDirty ? "var(--color-accent)" : "var(--color-surface-1)",
              color: scheduleDirty ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
              border: scheduleDirty ? "none" : "1px solid var(--color-border-strong)",
            }}
          >
            {scheduleBusy ? "Saving…" : "Save schedule"}
          </button>
        </div>
        <div
          className="mt-1.5 text-[11.5px]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Next run: {nextRunLabel(scheduleDay, scheduleTime)}
          {schedule && !schedule.task_registered && (
            <span style={{ color: "var(--color-warn)" }}>
              {" "}
              (Windows Task Scheduler entry not yet registered)
            </span>
          )}
        </div>
      </div>

      {/* Last backup + force-run */}
      <div className="mt-5">
        <label
          className="mb-1.5 block text-[11.5px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Last backup
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="text-[13px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            {statusLoading
              ? "Loading…"
              : newest
                ? relativeTime(newest.last_modified)
                : status && status.root_exists
                  ? "never"
                  : "destination not found"}
          </span>
          {status && newest && (
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              ({newest.name})
            </span>
          )}
          <button
            type="button"
            onClick={forceBackup}
            disabled={running}
            className="ml-auto rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title="Run the weekly backup script right now"
          >
            {running ? "Running…" : "Force backup now"}
          </button>
        </div>
      </div>

      {/* Inline error / success */}
      {error && (
        <div
          className="mt-3 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mt-3 rounded p-2 text-[11.5px]"
          style={{
            background: "rgba(63, 185, 80, 0.08)",
            border: "1px solid rgba(63, 185, 80, 0.22)",
            color: "var(--color-success)",
          }}
        >
          {success}
        </div>
      )}
    </div>
  );
}

// Legacy exports (BackupRootEditor / BackupSourcesEditor / DiskBackupStatus)
// removed in the 2026-05-24 redesign. The single BackupsPanel above replaces
// all three. Settings/index.tsx imports BackupsPanel directly.
