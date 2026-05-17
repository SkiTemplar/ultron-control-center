import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ---------------------------------------------------------------------------
// Disk backup status — surfaces the configured backup root mirror freshness.
// The actual root path comes from the backend (ULTRON_BACKUP_ROOT env override
// or %USERPROFILE%\BACKUP fallback), so the frontend just renders report.root.
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

function formatHours(h: number | null): string {
  if (h == null) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${Math.round(h)}h`;
  const days = Math.floor(h / 24);
  const rem = Math.round(h % 24);
  return rem > 0 ? `${days}d ${rem}h` : `${days}d`;
}

function statusTint(s: string): { bg: string; color: string; border: string } {
  switch (s) {
    case "ok":
      return {
        bg: "rgba(63, 185, 80, 0.08)",
        color: "var(--color-success)",
        border: "rgba(63, 185, 80, 0.22)",
      };
    case "stale":
      return {
        bg: "rgba(210, 153, 34, 0.06)",
        color: "var(--color-warn)",
        border: "rgba(210, 153, 34, 0.22)",
      };
    case "cold":
    case "missing":
      return {
        bg: "rgba(248, 81, 73, 0.06)",
        color: "var(--color-danger)",
        border: "rgba(248, 81, 73, 0.22)",
      };
    default:
      return {
        bg: "var(--color-surface-2)",
        color: "var(--color-text-tertiary)",
        border: "var(--color-border)",
      };
  }
}

// v15.2 F7: editable backup root. Reads the current path from the backend
// (which resolves user-config → env → D:\BACKUP → ~/BACKUP), lets the user
// set a new one, and shows whether the path currently exists.
type BackupRootInfo = {
  current: string;
  suggested: string;
  exists: boolean;
  user_configured: boolean;
  config_path: string;
};

export function BackupRootEditor({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<BackupRootInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function load() {
    try {
      const r = (await invoke("get_backup_root")) as BackupRootInfo;
      setInfo(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function save(path: string) {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const r = (await invoke("set_backup_root", { path })) as BackupRootInfo;
      setInfo(r);
      setSuccess(`Backup root set to ${r.current}${r.exists ? "" : " (path does not exist yet)"}.`);
      window.setTimeout(() => setSuccess(null), 3500);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // v15.2 F8 UX: replace the free-text input with the Tauri native folder
  // picker. Avoids the user pasting half-typed Windows paths.
  async function browse() {
    setError(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Select backup root folder",
        defaultPath: info?.current || info?.suggested || undefined,
      });
      if (typeof picked === "string" && picked.trim()) {
        await save(picked.trim());
      }
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div
      className="mb-5 rounded p-4"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold">Backup root path</h3>
        {info?.user_configured && (
          <span
            className="text-[10.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            user-configured
          </span>
        )}
      </div>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Where ULTRON mirrors its weekly backups. Default:{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.suggested ?? "D:\\BACKUP"}
        </span>
        . Override persisted to{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.config_path ?? "~/.ultron/.tmp/backup-root.txt"}
        </span>
        ; weekly-backup.ps1 honours{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>$env:ULTRON_BACKUP_ROOT</span>.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
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
          title={info?.current ?? ""}
        >
          {info?.current ?? "—"}
        </div>
        <button
          type="button"
          onClick={browse}
          disabled={busy}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title="Open the Windows folder picker"
        >
          {busy ? "Saving…" : "Browse…"}
        </button>
        <button
          type="button"
          onClick={() => save("")}
          disabled={busy || !info?.user_configured}
          className="rounded px-2.5 py-1.5 text-[11.5px] transition-colors disabled:opacity-40"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Clear the user override and fall back to env / D:\\BACKUP / ~/BACKUP"
        >
          Reset to default
        </button>
      </div>
      {info && (
        <div
          className="mt-2 text-[11px]"
          style={{
            color: info.exists ? "var(--color-text-tertiary)" : "var(--color-warn)",
          }}
        >
          {info.exists
            ? "Path exists. Mirror status below reflects this root."
            : "Path does not exist yet — create it before the next weekly backup runs."}
        </div>
      )}
      {error && (
        <div
          className="mt-2 rounded p-2 text-[11px]"
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
          className="mt-2 rounded p-2 text-[11px]"
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

export function DiskBackupStatus() {
  const [report, setReport] = useState<BackupStatusReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("backup_status")) as BackupStatusReport;
      setReport(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[13px] font-semibold">
          Disk mirror{report?.root ? ` (${report.root})` : ""}
        </h3>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className="text-[11px] transition-colors disabled:opacity-50"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>
      <p
        className="mb-3 text-[11.5px]"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Estado del mirror semanal (robocopy /MIR vía
        <span style={{ fontFamily: "var(--font-mono)" }}> weekly-backup.ps1</span>).
        Mtime del top-level subdir = última pasada efectiva.
      </p>

      {error && (
        <div
          className="mb-3 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {!loading && report && !report.root_exists && (
        <div
          className="rounded p-4 text-[12.5px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          Root no encontrado: {report.root}. El disco no está montado o nunca
          se ejecutó el primer backup.
        </div>
      )}

      {!loading && report && report.root_exists && report.entries.length === 0 && (
        <div
          className="rounded p-4 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-tertiary)",
          }}
        >
          El root existe pero no hay subcarpetas — primer backup aún no
          se completó.
        </div>
      )}

      {!loading && report && report.entries.length > 0 && (
        <div
          className="rounded"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          {report.entries.map((e, i) => {
            const tint = statusTint(e.status);
            return (
              <div
                key={e.name}
                className="flex items-baseline gap-3 px-3 py-2.5"
                style={{
                  borderTop:
                    i === 0 ? "none" : "1px solid var(--color-border)",
                }}
              >
                <span
                  className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
                  style={{
                    background: tint.bg,
                    color: tint.color,
                    border: `1px solid ${tint.border}`,
                    minWidth: 52,
                    textAlign: "center",
                  }}
                >
                  {e.status}
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className="text-[12.5px] font-medium"
                    style={{ color: "var(--color-text)" }}
                  >
                    {e.name}
                  </div>
                  <div
                    className="mt-0.5 truncate text-[10.5px]"
                    style={{
                      fontFamily: "var(--font-mono)",
                      color: "var(--color-text-faint)",
                    }}
                    title={e.path}
                  >
                    {e.path}
                  </div>
                </div>
                <span
                  className="shrink-0 tabular-nums text-[11.5px]"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {formatHours(e.age_hours)}
                </span>
                <span
                  className="shrink-0 text-[10.5px]"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  {e.last_modified ? e.last_modified.slice(0, 10) : "—"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
