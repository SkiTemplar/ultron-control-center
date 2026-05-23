import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

// ---------------------------------------------------------------------------
// Backups (post-rewrite 2026-05-23): predefined toggles + custom-folder list.
//
// User feedback: "listing every folder under $HOME is horror". The new UX is:
//   1. Three preset toggles for the only things USER cares about backing
//      up — Personal, Carrera, Claude. Each preset maps to one or more
//      $HOME-relative source names; the backend already stores those in
//      ~/.ultron/cockpit/backup-config.json via set_backup_sources.
//   2. A "Custom folders" list where the user can pick *any* folder via the
//      native folder picker. Paths inside $HOME are stored relative; paths
//      outside $HOME are stored absolute (the backend accepts both).
//   3. Backup root editor (D: drive by default — the schedule script targets
//      whichever path lives here).
//   4. Disk mirror status (read-only, shows last backup per folder).
//
// Schedule semantics surfaced in UI copy:
//   - The backup runs ONLY on Saturdays (next subagent owns the scheduled
//     task; this file only renders the text).
//   - Mirror = `robocopy /MIR`: files removed at the source are also removed
//     from the destination on the next pass.
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

// ---------------------------------------------------------------------------
// Backup root editor — unchanged from v15.2 F7.
// ---------------------------------------------------------------------------

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
        <h3 className="text-[13px] font-semibold">Backup destination</h3>
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
        Where every selected folder is mirrored every Saturday. Default:{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.suggested ?? "D:\\BACKUP"}
        </span>
        . Override saved to{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.config_path ?? "~/.ultron/.tmp/backup-root.txt"}
        </span>
        .
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
          title="Clear the override and fall back to D:\\BACKUP / ~/BACKUP"
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
            ? "Destination exists."
            : "Destination does not exist yet — create it before the next Saturday backup runs."}
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

// ---------------------------------------------------------------------------
// BackupSourcesEditor (rewrite 2026-05-23):
//   - Three named PRESETS as toggles (Personal, Carrera, Claude).
//   - A custom-folder LIST with a folder picker (no enumeration of $HOME).
//
// The backend command set_backup_sources expects a flat string[] of source
// names. We expand each preset into its underlying paths on save and
// collapse them back on load so the UI stays preset-shaped even if the
// config file was edited by hand.
// ---------------------------------------------------------------------------

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

interface PresetDef {
  id: "personal" | "carrera" | "claude";
  label: string;
  description: string;
  /** $HOME-relative paths the backend stores in backup-config.json. */
  paths: string[];
}

const PRESETS: PresetDef[] = [
  {
    id: "personal",
    label: "Personal",
    description: "~/Documents/Personal",
    paths: ["Documents/Personal"],
  },
  {
    id: "carrera",
    label: "Carrera",
    description: "~/Documents/Carrera",
    paths: ["Documents/Carrera"],
  },
  {
    id: "claude",
    label: "Claude",
    description: "~/.claude and ~/.ultron (both core agent state)",
    paths: [".claude", ".ultron"],
  },
];

/** Lowercased path comparator that tolerates Windows separators. */
function normalisePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function pathSetEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a.map(normalisePath));
  for (const x of b) if (!sa.has(normalisePath(x))) return false;
  return true;
}

/** Split the flat backend list into (preset toggles, leftover custom paths). */
function splitActive(active: string[]): {
  presetIds: Set<PresetDef["id"]>;
  custom: string[];
} {
  const remaining = new Set(active.map((s) => s.trim()).filter(Boolean));
  const presetIds = new Set<PresetDef["id"]>();
  for (const preset of PRESETS) {
    const present = preset.paths.every((p) =>
      Array.from(remaining).some((r) => normalisePath(r) === normalisePath(p)),
    );
    if (present) {
      presetIds.add(preset.id);
      for (const p of preset.paths) {
        for (const r of Array.from(remaining)) {
          if (normalisePath(r) === normalisePath(p)) remaining.delete(r);
        }
      }
    }
  }
  return { presetIds, custom: Array.from(remaining) };
}

export function BackupSourcesEditor({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<BackupSourcesInfo | null>(null);
  const [home, setHome] = useState<string>("");
  const [presets, setPresets] = useState<Set<PresetDef["id"]>>(new Set());
  const [custom, setCustom] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [initial, setInitial] = useState<{
    presets: Set<PresetDef["id"]>;
    custom: string[];
  } | null>(null);

  async function load() {
    try {
      const r = (await invoke("get_backup_sources")) as BackupSourcesInfo;
      setInfo(r);
      // Derive $HOME from the first candidate's absolute path (the backend
      // returns absolute = $HOME + name for the home-relative sources).
      const first = r.candidates[0];
      if (first) {
        const tail = first.name;
        const abs = first.absolute;
        // strip trailing /name or \name to reconstruct $HOME
        const idx = abs.toLowerCase().lastIndexOf(tail.toLowerCase());
        if (idx > 0) setHome(abs.slice(0, idx).replace(/[\\/]+$/, ""));
      }
      const split = splitActive(r.active);
      setPresets(split.presetIds);
      setCustom(split.custom);
      setInitial({ presets: new Set(split.presetIds), custom: [...split.custom] });
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    load();
  }, []);

  const dirty = useMemo(() => {
    if (!initial) return false;
    if (initial.presets.size !== presets.size) return true;
    for (const id of initial.presets) if (!presets.has(id)) return true;
    if (initial.custom.length !== custom.length) return true;
    return !pathSetEquals(initial.custom, custom);
  }, [initial, presets, custom]);

  function togglePreset(id: PresetDef["id"]) {
    setPresets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function addCustom() {
    setError(null);
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a folder to back up",
        defaultPath: home || undefined,
      });
      if (typeof picked !== "string" || !picked.trim()) return;
      // Convert to $HOME-relative when possible so the source string is
      // portable across user accounts; otherwise store the absolute path.
      let stored = picked.trim();
      if (home && stored.toLowerCase().startsWith(home.toLowerCase())) {
        stored = stored.slice(home.length).replace(/^[\\/]+/, "");
        if (!stored) {
          setError("Pick a subfolder of your home directory, not $HOME itself.");
          return;
        }
      }
      // De-dupe (case-insensitive) against existing custom + preset paths.
      const norm = normalisePath(stored);
      const presetPaths = PRESETS.flatMap((p) =>
        presets.has(p.id) ? p.paths : [],
      );
      const collisions = [...custom, ...presetPaths].some(
        (p) => normalisePath(p) === norm,
      );
      if (collisions) {
        setError("That folder is already in the list.");
        return;
      }
      setCustom((prev) => [...prev, stored]);
    } catch (e) {
      setError(String(e));
    }
  }

  function removeCustom(path: string) {
    setCustom((prev) => prev.filter((p) => p !== path));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const sources = [
        ...PRESETS.flatMap((p) => (presets.has(p.id) ? p.paths : [])),
        ...custom,
      ];
      const r = (await invoke("set_backup_sources", { sources })) as BackupSourcesInfo;
      setInfo(r);
      const split = splitActive(r.active);
      setPresets(split.presetIds);
      setCustom(split.custom);
      setInitial({ presets: new Set(split.presetIds), custom: [...split.custom] });
      const total = sources.length;
      setSuccess(
        total === 0
          ? "Cleared — no folders are being backed up right now."
          : `Saved ${total} folder${total === 1 ? "" : "s"}.`,
      );
      window.setTimeout(() => setSuccess(null), 3500);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    if (!initial) return;
    setPresets(new Set(initial.presets));
    setCustom([...initial.custom]);
    setError(null);
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
        <h3 className="text-[13px] font-semibold">What to back up</h3>
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
        Saved to{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>
          {info?.config_path ?? "~/.ultron/cockpit/backup-config.json"}
        </span>
        . The Saturday task mirrors each selected folder to the destination
        above using{" "}
        <span style={{ fontFamily: "var(--font-mono)" }}>robocopy /MIR</span>
        : new and changed files are copied, and files removed from the source
        are also removed from the mirror on the next pass.
      </p>

      {/* Preset toggles */}
      <div
        className="mt-3 overflow-hidden rounded"
        style={{ border: "1px solid var(--color-border)" }}
      >
        {PRESETS.map((preset) => {
          const on = presets.has(preset.id);
          return (
            <label
              key={preset.id}
              className="flex cursor-pointer items-center gap-3 px-3 py-2"
              style={{
                borderTop: "1px solid var(--color-border)",
                background: on
                  ? "rgba(63, 185, 80, 0.05)"
                  : "var(--color-surface-1)",
              }}
            >
              <input
                type="checkbox"
                checked={on}
                onChange={() => togglePreset(preset.id)}
                disabled={busy}
              />
              <div className="min-w-0 flex-1">
                <div
                  className="text-[12.5px] font-medium"
                  style={{ color: "var(--color-text)" }}
                >
                  {preset.label}
                </div>
                <div
                  className="truncate text-[10.5px]"
                  style={{
                    fontFamily: "var(--font-mono)",
                    color: "var(--color-text-faint)",
                  }}
                >
                  {preset.description}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {/* Custom folders */}
      <div className="mt-4">
        <div className="mb-2 flex items-baseline justify-between">
          <div
            className="text-[12px] font-semibold"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Custom folders
          </div>
          <button
            type="button"
            onClick={addCustom}
            disabled={busy}
            className="rounded px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-surface-1)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Add folder…
          </button>
        </div>
        {custom.length === 0 ? (
          <div
            className="rounded px-3 py-2 text-[11.5px]"
            style={{
              background: "var(--color-surface-1)",
              border: "1px dashed var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No custom folders. Click "Add folder…" to pick any directory.
          </div>
        ) : (
          <div
            className="overflow-hidden rounded"
            style={{ border: "1px solid var(--color-border)" }}
          >
            {custom.map((path) => {
              const isAbsolute = /^[a-zA-Z]:[\\/]/.test(path);
              const display = isAbsolute ? path : `~/${path.replace(/\\/g, "/")}`;
              return (
                <div
                  key={path}
                  className="flex items-center gap-3 px-3 py-2"
                  style={{
                    borderTop: "1px solid var(--color-border)",
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
                      {display}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeCustom(path)}
                    disabled={busy}
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
              );
            })}
          </div>
        )}
      </div>

      {/* Save / discard */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: dirty ? "var(--color-accent)" : "var(--color-surface-1)",
            color: dirty ? "var(--color-accent-text)" : "var(--color-text-tertiary)",
            border: dirty ? "none" : "1px solid var(--color-border)",
          }}
        >
          {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={discard}
            disabled={busy}
            className="rounded px-2.5 py-1.5 text-[11.5px] transition-colors disabled:opacity-40"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            Discard
          </button>
        )}
      </div>

      {/* Schedule explainer */}
      <div
        className="mt-4 rounded px-3 py-2 text-[11.5px]"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-tertiary)",
        }}
      >
        <strong style={{ color: "var(--color-text-secondary)" }}>
          When this runs:
        </strong>{" "}
        every Saturday on first PC boot of the day. The scheduled task
        catches up if the machine was off (Settings &gt; Schedules &gt;
        Backup-Weekly).
      </div>

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

// ---------------------------------------------------------------------------
// DiskBackupStatus — unchanged.
// ---------------------------------------------------------------------------

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
          Last backup{report?.root ? ` (${report.root})` : ""}
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
        One row per top-level subfolder under the destination. Age is the
        last time the Saturday mirror touched it.
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
          Destination not found: {report.root}. The disk is not mounted or
          the first backup has never run.
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
          The destination exists but has no subfolders — the first backup
          has not completed yet.
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
