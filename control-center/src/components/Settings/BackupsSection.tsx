import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { BackupScheduleRow } from "./BackupScheduleRow";
import {
  forceBackupMessage,
  lastRunView,
  toneColor,
  type BackupLastRun,
  type BackupTone,
} from "../dashboard/backupLastRun";

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
//   - backup_status                              (mirror ages + real last-run result)
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
  last_result: string | null;
};

type BackupStatusReport = {
  root: string;
  root_configured: boolean;
  root_exists: boolean;
  entries: BackupEntry[];
  overall_status: string;
  last_run: BackupLastRun | null;
  last_run_error: string | null;
};

type BackupRootInfo = {
  /** `null` = sin destino configurado: la copia semanal aborta. */
  current: string | null;
  /** Carpeta inicial del selector (D:\BACKUP si esa unidad está montada). */
  suggested: string | null;
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

function relativeTime(iso?: string | null): string {
  if (!iso) return "nunca";
  const ts = new Date(iso);
  if (Number.isNaN(ts.getTime())) return iso;
  const diff = Date.now() - ts.getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "ahora mismo";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `hace ${d} día${d === 1 ? "" : "s"}`;
  const months = Math.floor(d / 30);
  return `hace ${months} mes${months === 1 ? "" : "es"}`;
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

  // Status + force-run
  const [status, setStatus] = useState<BackupStatusReport | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [running, setRunning] = useState(false);

  // Shared
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [runMsg, setRunMsg] = useState<{ tone: BackupTone; text: string } | null>(null);

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

  async function loadStatus(): Promise<BackupStatusReport | null> {
    setStatusLoading(true);
    try {
      const r = (await invoke("backup_status")) as BackupStatusReport;
      setStatus(r);
      return r;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setStatusLoading(false);
    }
  }

  useEffect(() => {
    void loadRoot();
    void loadSources();
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
        title: "Elige el destino de la copia",
        defaultPath: root?.current || root?.suggested || undefined,
      });
      if (typeof picked !== "string" || !picked.trim()) return;
      setRootBusy(true);
      const r = (await invoke("set_backup_root", {
        path: picked.trim(),
      })) as BackupRootInfo;
      setRoot(r);
      flashSuccess(`Destino: ${r.current}.`);
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
        title: "Elige una carpeta para copiar",
        defaultPath: home || undefined,
      });
      if (typeof picked !== "string" || !picked.trim()) return;
      // Store $HOME-relative when applicable, absolute otherwise.
      let stored = picked.trim();
      if (home && stored.toLowerCase().startsWith(home.toLowerCase())) {
        stored = stored.slice(home.length).replace(/^[\\/]+/, "");
        if (!stored) {
          setError("Elige una subcarpeta de tu carpeta de usuario, no la carpeta entera.");
          return;
        }
      }
      const norm = normalisePath(stored);
      if (folders.some((p) => normalisePath(p) === norm)) {
        setError("Esa carpeta ya está en la lista.");
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
          ? "Lista vacía: ahora mismo no se copia ninguna carpeta."
          : `${r.active.length} carpeta${r.active.length === 1 ? "" : "s"} guardada${r.active.length === 1 ? "" : "s"}.`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setFoldersBusy(false);
    }
  }

  // ---------------------------------------------------------------------
  // Force backup now
  // ---------------------------------------------------------------------
  async function forceBackup() {
    setError(null);
    setRunMsg(null);
    setRunning(true);
    try {
      const result = (await invoke("run_backup_now")) as {
        success: boolean;
        exit_code: number | null;
        stderr?: string;
      };
      // El resumen por fuente sale de backup-last-run.json, recién escrito.
      const fresh = await loadStatus();
      setRunMsg(forceBackupMessage(result, fresh?.last_run));
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
      <h3 className="text-[13px] font-semibold">Copia espejo semanal</h3>
      <p
        className="mt-1 text-[11.5px] leading-relaxed"
        style={{ color: "var(--color-text-tertiary)" }}
      >
        Replica las carpetas de abajo en el destino según el horario semanal.
        Copia los ficheros nuevos y modificados. Lo que se borra en el origen
        sale de la copia y pasa a <code>_borrados\&lt;fecha&gt;</code> dentro del
        destino, donde se guarda 28 días; las versiones sobrescritas no se guardan.
      </p>

      {/* Destination */}
      <div className="mt-4">
        <label
          className="mb-1.5 block text-[11.5px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Destino
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
            {root ? (root.current ?? "Sin destino") : "—"}
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
            title="Abrir el selector de carpetas"
          >
            {rootBusy ? "Guardando…" : "Examinar"}
          </button>
        </div>
        {root && !root.current && (
          <div
            className="mt-1 text-[10.5px]"
            style={{ color: "var(--color-danger)" }}
          >
            Sin destino la copia semanal aborta sin copiar nada. Elige una carpeta en otra unidad:
            un espejo en el mismo disco que las carpetas no es un backup.
          </div>
        )}
        {root?.current && !root.exists && (
          <div
            className="mt-1 text-[10.5px]"
            style={{ color: "var(--color-warn)" }}
          >
            El destino no existe: conecta la unidad o créalo antes de la próxima copia.
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
            Carpetas que se copian
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
            + Añadir carpeta
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
            No hay carpetas. Pulsa «+ Añadir carpeta» para elegir una.
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
                  Quitar
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
              {foldersBusy ? "Guardando…" : "Guardar carpetas"}
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
              Descartar
            </button>
          </div>
        )}
      </div>

      <BackupScheduleRow onError={setError} onSuccess={flashSuccess} />

      {/* Last backup + force-run */}
      <div className="mt-5">
        <label
          className="mb-1.5 block text-[11.5px] font-semibold"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Última copia
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="text-[13px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            {statusLoading
              ? "Cargando…"
              : newest
                ? relativeTime(newest.last_modified)
                : status && status.root_exists
                  ? "nunca"
                  : status && !status.root_configured
                    ? "sin destino configurado"
                    : "destino no encontrado"}
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
            title="Ejecuta ahora el script de la copia semanal"
          >
            {running ? "Copiando…" : "Copiar ahora"}
          </button>
        </div>
        {status && !statusLoading && (
          <LastRunLine
            view={lastRunView(status.last_run, status.last_run_error)}
            onError={(msg) => setError(msg)}
          />
        )}
        {runMsg && (
          <div
            className="mt-2 rounded p-2 text-[11.5px]"
            role="status"
            style={{
              background: "color-mix(in srgb, " + toneColor(runMsg.tone) + " 8%, transparent)",
              color: toneColor(runMsg.tone),
            }}
          >
            {runMsg.text}
          </div>
        )}
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

// Resultado real del último run con enlace a sus logs.
function LastRunLine({
  view,
  onError,
}: {
  view: ReturnType<typeof lastRunView>;
  onError: (msg: string) => void;
}) {
  async function open(path: string) {
    try {
      await openPath(path);
    } catch (e) {
      onError(`No se pudo abrir el log: ${String(e)}`);
    }
  }
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px]"
      style={{ color: toneColor(view.tone) }}
    >
      <span className="min-w-0 flex-1">{view.text}</span>
      {view.logPath && (
        <button
          type="button"
          onClick={() => void open(view.logPath as string)}
          className="rounded px-2 py-0.5 text-[11px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-strong)",
          }}
          title={view.logPath}
        >
          Ver log
        </button>
      )}
      {view.robocopyLogPath && (
        <button
          type="button"
          onClick={() => void open(view.robocopyLogPath as string)}
          className="rounded px-2 py-0.5 text-[11px]"
          style={{
            background: "var(--color-surface-1)",
            color: "var(--color-text-secondary)",
            border: "1px solid var(--color-border-strong)",
          }}
          title={view.robocopyLogPath}
        >
          Log de robocopy
        </button>
      )}
    </div>
  );
}

// Legacy exports (BackupRootEditor / BackupSourcesEditor / DiskBackupStatus)
// removed in the 2026-05-24 redesign. The single BackupsPanel above replaces
// all three. Settings/index.tsx imports BackupsPanel directly.
