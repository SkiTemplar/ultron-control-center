import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  CreateProjectResult,
  ProjectActionResult,
  ProjectInfo,
} from "../types";

// ---------------------------------------------------------------------------
// Status styling
// ---------------------------------------------------------------------------

type StatusKey = "active" | "auto-detected" | "manual" | "archived" | string;

function statusBadge(s: string | null): { color: string; bg: string; label: string } {
  switch (s) {
    case "active":
      return {
        color: "var(--color-success)",
        bg: "rgba(63, 185, 80, 0.08)",
        label: "active",
      };
    case "auto-detected":
      return {
        color: "var(--color-text-secondary)",
        bg: "var(--color-surface-3)",
        label: "auto",
      };
    case "manual":
      return {
        color: "var(--color-warn)",
        bg: "rgba(210, 153, 34, 0.08)",
        label: "manual",
      };
    case "archived":
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: "archived",
      };
    default:
      return {
        color: "var(--color-text-tertiary)",
        bg: "var(--color-surface-2)",
        label: s ?? "—",
      };
  }
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function Row({
  p,
  selected,
  onClick,
  onOpen,
  opening,
  onEdit,
  onDelete,
}: {
  p: ProjectInfo;
  selected: boolean;
  onClick: () => void;
  onOpen: () => void;
  opening: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const b = statusBadge(p.status);
  return (
    <div
      className="flex items-baseline gap-3 rounded p-3 transition-colors"
      style={{
        background: selected ? "var(--color-surface-3)" : "var(--color-surface-2)",
        border: `1px solid ${selected ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      <button
        type="button"
        onClick={onClick}
        className="min-w-0 flex-1 text-left"
      >
        <div className="flex items-baseline gap-2">
          <span
            className="rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide"
            style={{ background: b.bg, color: b.color, minWidth: 56, textAlign: "center" }}
          >
            {b.label}
          </span>
          <span className="text-[13px] font-medium" style={{ color: "var(--color-text)" }}>
            {p.name ?? p.id}
          </span>
          {p.ide && (
            <span
              className="text-[11px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {p.ide}
            </span>
          )}
          {p.language && (
            <span
              className="text-[11px]"
              style={{ color: "var(--color-text-faint)" }}
            >
              · {p.language}
            </span>
          )}
        </div>
        {p.path && (
          <div
            className="mt-1 truncate text-[10.5px]"
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--color-text-tertiary)",
            }}
            title={p.path}
          >
            {p.path}
          </div>
        )}
        {p.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {p.tags.slice(0, 5).map((t) => (
              <span
                key={t}
                className="rounded px-1 py-px text-[9.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border)",
                }}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </button>
      <div className="flex flex-col items-end gap-1">
        {p.last_active && (
          <span
            className="text-[10.5px] tabular-nums"
            style={{ color: "var(--color-text-faint)" }}
          >
            {p.last_active}
          </span>
        )}
        <div className="flex gap-1">
          <button
            type="button"
            onClick={onEdit}
            className="rounded px-2 py-1 text-[10.5px] transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Edit project metadata"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="rounded px-2 py-1 text-[10.5px] transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-danger)",
              border: "1px solid rgba(248, 81, 73, 0.32)",
            }}
            title="Remove from registry (no files touched)"
          >
            ×
          </button>
          <button
            type="button"
            onClick={onOpen}
            disabled={opening || !p.path}
            className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
            title={p.path ? `Open ${p.id} in ${p.ide ?? "default IDE"}` : "No path on file"}
          >
            {opening ? "Opening…" : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter pill
// ---------------------------------------------------------------------------

function Pill({
  active,
  label,
  count,
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] transition-colors"
      style={{
        background: active ? "var(--color-surface-3)" : "transparent",
        color: active ? "var(--color-text)" : "var(--color-text-tertiary)",
        border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      <span>{label}</span>
      <span
        className="tabular-nums"
        style={{ color: active ? "var(--color-text-secondary)" : "var(--color-text-faint)" }}
      >
        {count}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type GroupBy = "none" | "language" | "ide";

const IDE_OPTIONS = [
  "",
  "VSCode",
  "Cursor",
  "Webstorm",
  "Rider",
  "PyCharm",
  "AndroidStudio",
  "UnityHub",
  "Unreal",
  "External",
  "Game",
  "Other",
];

export function Projects() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilters, setStatusFilters] = useState<Set<StatusKey>>(
    () => new Set<StatusKey>(),
  );
  const [languageFilters, setLanguageFilters] = useState<Set<string>>(
    () => new Set<string>(),
  );
  const [ideFilters, setIdeFilters] = useState<Set<string>>(() => new Set<string>());
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [selected, setSelected] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastAction, setLastAction] = useState<ProjectActionResult | null>(null);

  // New/edit project wizard state — same form for both flows; `editingId`
  // distinguishes create vs update so the modal can call the right command
  // and the submit button can reflect the action.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wName, setWName] = useState("");
  const [wPath, setWPath] = useState("");
  const [wIde, setWIde] = useState("");
  const [wLang, setWLang] = useState("");
  const [wTags, setWTags] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("list_projects")) as ProjectInfo[];
      setProjects(r);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      const r = (await invoke("scan_projects")) as ProjectInfo[];
      setProjects(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setScanning(false);
    }
  }

  async function open(id: string) {
    setOpening(id);
    setLastAction(null);
    try {
      const r = (await invoke("open_project", { id })) as ProjectActionResult;
      setLastAction(r);
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: String(e),
        exit_code: null,
      });
    } finally {
      setOpening(null);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function resetWizard() {
    setWName("");
    setWPath("");
    setWIde("");
    setWLang("");
    setWTags("");
    setEditingId(null);
    setCreateError(null);
  }

  function startEdit(p: ProjectInfo) {
    setEditingId(p.id);
    setWName(p.name ?? "");
    setWPath(p.path ?? "");
    setWIde(p.ide ?? "");
    setWLang(p.language ?? "");
    setWTags(p.tags.join(", "));
    setCreateError(null);
    setWizardOpen(true);
  }

  async function saveProject() {
    setCreating(true);
    setCreateError(null);
    try {
      const tagList = wTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (editingId) {
        await invoke("update_project", {
          id: editingId,
          name: wName || null,
          path: wPath || null,
          ide: wIde || null,
          language: wLang || null,
          tags: tagList,
        });
        resetWizard();
        setWizardOpen(false);
        await load();
      } else {
        const r = (await invoke("create_project", {
          name: wName,
          path: wPath,
          ide: wIde || null,
          language: wLang || null,
          tags: tagList.length > 0 ? tagList : null,
        })) as CreateProjectResult;
        if (r.success) {
          resetWizard();
          setWizardOpen(false);
          await load();
        } else {
          setCreateError(r.message);
        }
      }
    } catch (e) {
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await invoke("delete_project", { id: pendingDelete.id });
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  async function pickWizardPath() {
    try {
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Project folder",
      });
      if (typeof path === "string" && path) setWPath(path);
    } catch {}
  }

  async function pickWizardFile() {
    try {
      // For External / Game entries the path is a single executable, shortcut,
      // or browser URL. We don't restrict the extension here — Start-Process
      // handles .exe/.lnk/.bat/.url natively.
      const path = await openDialog({
        directory: false,
        multiple: false,
        title: "App / game executable or shortcut",
      });
      if (typeof path === "string" && path) setWPath(path);
    } catch {}
  }

  // Counts for filter pills
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of projects) {
      const key = p.status ?? "—";
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [projects]);

  const languageCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of projects) {
      const key = (p.language ?? "").trim() || "—";
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [projects]);

  const ideCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of projects) {
      const key = (p.ide ?? "").trim() || "—";
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [projects]);

  const sortByCountDesc = (counts: Record<string, number>) =>
    Object.keys(counts).sort((a, b) =>
      counts[b] - counts[a] !== 0 ? counts[b] - counts[a] : a.localeCompare(b),
    );

  const statusKeys = useMemo(() => sortByCountDesc(statusCounts), [statusCounts]);
  const languageKeys = useMemo(() => sortByCountDesc(languageCounts), [languageCounts]);
  const ideKeys = useMemo(() => sortByCountDesc(ideCounts), [ideCounts]);

  // Filtered + searched
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects
      .filter((p) => {
        if (statusFilters.size === 0) return true;
        return statusFilters.has(p.status ?? "—");
      })
      .filter((p) => {
        if (languageFilters.size === 0) return true;
        return languageFilters.has((p.language ?? "").trim() || "—");
      })
      .filter((p) => {
        if (ideFilters.size === 0) return true;
        return ideFilters.has((p.ide ?? "").trim() || "—");
      })
      .filter((p) => {
        if (!q) return true;
        const hay = [
          p.id,
          p.name ?? "",
          p.path ?? "",
          p.ide ?? "",
          p.language ?? "",
          ...(p.tags ?? []),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
  }, [projects, statusFilters, languageFilters, ideFilters, query]);

  // Group filtered by chosen dimension
  const grouped = useMemo(() => {
    if (groupBy === "none") return [["", filtered]] as [string, ProjectInfo[]][];
    const map = new Map<string, ProjectInfo[]>();
    for (const p of filtered) {
      const key =
        (groupBy === "language" ? p.language : p.ide)?.trim() || "—";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.entries()).sort((a, b) =>
      b[1].length - a[1].length !== 0
        ? b[1].length - a[1].length
        : a[0].localeCompare(b[0]),
    );
  }, [filtered, groupBy]);

  function toggleStatus(s: StatusKey) {
    const next = new Set(statusFilters);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setStatusFilters(next);
  }
  function toggleLang(s: string) {
    const next = new Set(languageFilters);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setLanguageFilters(next);
  }
  function toggleIde(s: string) {
    const next = new Set(ideFilters);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setIdeFilters(next);
  }

  return (
    <div className="px-10 py-8">
      <header className="mb-5 flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">Projects</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            {projects.length} registered · {filtered.length} shown
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              if (wizardOpen) {
                setWizardOpen(false);
                resetWizard();
              } else {
                resetWizard();
                setWizardOpen(true);
              }
            }}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            + New project
          </button>
          <button
            type="button"
            onClick={scan}
            disabled={scanning}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-3)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Re-scan filesystem for projects (ultron scan)"
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "transparent",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
          >
            {loading ? "Loading…" : "Reload"}
          </button>
        </div>
      </header>

      {/* New project wizard */}
      {wizardOpen && (
        <div
          className="mb-5 rounded p-4"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          <div className="mb-3 text-[12px] font-medium" style={{ color: "var(--color-text)" }}>
            {editingId ? `Edit project: ${editingId}` : "New project"}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Name
              </label>
              <input
                type="text"
                value={wName}
                onChange={(e) => setWName(e.target.value)}
                placeholder="e.g. my new game"
                className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  outline: "none",
                }}
              />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Path
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  type="text"
                  value={wPath}
                  onChange={(e) => setWPath(e.target.value)}
                  placeholder="C:\Users\...\project"
                  className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
                  style={{
                    background: "var(--color-surface-1)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                    fontFamily: "var(--font-mono)",
                    outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={pickWizardPath}
                  className="rounded px-2 py-1 text-[11px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                  title="Pick a folder (classic project)"
                >
                  Folder
                </button>
                <button
                  type="button"
                  onClick={pickWizardFile}
                  className="rounded px-2 py-1 text-[11px]"
                  style={{
                    background: "var(--color-surface-3)",
                    color: "var(--color-text-secondary)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                  title="Pick an .exe, .lnk, .bat or .url (app / game / shortcut)"
                >
                  App
                </button>
              </div>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                IDE
              </label>
              <select
                value={wIde}
                onChange={(e) => setWIde(e.target.value)}
                className="mt-1 w-full rounded px-2 py-1.5 text-[12px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {IDE_OPTIONS.map((ide) => (
                  <option key={ide} value={ide}>
                    {ide || "— (none)"}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Language
              </label>
              <input
                type="text"
                value={wLang}
                onChange={(e) => setWLang(e.target.value)}
                placeholder="e.g. typescript, cpp, python"
                className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  outline: "none",
                }}
              />
            </div>
            <div className="col-span-2">
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Tags (comma-separated)
              </label>
              <input
                type="text"
                value={wTags}
                onChange={(e) => setWTags(e.target.value)}
                placeholder="e.g. game, ue5, multiplayer"
                className="mt-1 w-full rounded px-2 py-1.5 text-[12.5px]"
                style={{
                  background: "var(--color-surface-1)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                  outline: "none",
                }}
              />
            </div>
          </div>
          {createError && (
            <p className="mt-2 text-[11.5px]" style={{ color: "var(--color-danger)" }}>
              {createError}
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={saveProject}
              disabled={creating || !wName.trim() || !wPath.trim()}
              className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-accent-text)",
              }}
            >
              {creating
                ? editingId
                  ? "Saving…"
                  : "Creating…"
                : editingId
                  ? "Save"
                  : "Create"}
            </button>
            <button
              type="button"
              onClick={() => { setWizardOpen(false); resetWizard(); }}
              className="rounded px-3 py-1.5 text-[12px]"
              style={{
                background: "transparent",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border-strong)",
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

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

      {/* Search + filters */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Search id, name, path, ide, language, tag…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded px-3 py-1.5 text-[12.5px]"
          style={{
            background: "var(--color-surface-2)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
            outline: "none",
            minWidth: 280,
          }}
        />
      </div>

      {statusKeys.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em] w-16"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Status
          </span>
          {statusKeys.map((s) => (
            <Pill
              key={s}
              label={s}
              count={statusCounts[s]}
              active={statusFilters.has(s)}
              onClick={() => toggleStatus(s)}
            />
          ))}
          {statusFilters.size > 0 && (
            <button
              type="button"
              onClick={() => setStatusFilters(new Set())}
              className="text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              clear
            </button>
          )}
        </div>
      )}

      {languageKeys.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em] w-16"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            Language
          </span>
          {languageKeys.map((s) => (
            <Pill
              key={s}
              label={s}
              count={languageCounts[s]}
              active={languageFilters.has(s)}
              onClick={() => toggleLang(s)}
            />
          ))}
          {languageFilters.size > 0 && (
            <button
              type="button"
              onClick={() => setLanguageFilters(new Set())}
              className="text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              clear
            </button>
          )}
        </div>
      )}

      {ideKeys.length > 1 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span
            className="text-[10px] font-medium uppercase tracking-[0.06em] w-16"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            IDE
          </span>
          {ideKeys.map((s) => (
            <Pill
              key={s}
              label={s}
              count={ideCounts[s]}
              active={ideFilters.has(s)}
              onClick={() => toggleIde(s)}
            />
          ))}
          {ideFilters.size > 0 && (
            <button
              type="button"
              onClick={() => setIdeFilters(new Set())}
              className="text-[10px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              clear
            </button>
          )}
        </div>
      )}

      {/* Group-by switch */}
      <div className="mb-4 flex items-center gap-1.5">
        <span
          className="text-[10px] font-medium uppercase tracking-[0.06em] w-16"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Group by
        </span>
        {(["none", "language", "ide"] as GroupBy[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroupBy(g)}
            className="rounded px-2 py-0.5 text-[11px] transition-colors"
            style={{
              background: groupBy === g ? "var(--color-surface-3)" : "transparent",
              color: groupBy === g ? "var(--color-text)" : "var(--color-text-tertiary)",
              border: `1px solid ${groupBy === g ? "var(--color-border-strong)" : "var(--color-border)"}`,
            }}
          >
            {g}
          </button>
        ))}
      </div>

      {lastAction && !lastAction.success && (
        <div
          className="mb-4 rounded p-3 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.06)",
            border: "1px solid rgba(248, 81, 73, 0.22)",
            color: "var(--color-danger)",
          }}
        >
          Open failed: {lastAction.stderr || lastAction.stdout || `exit ${lastAction.exit_code}`}
        </div>
      )}

      {loading && projects.length === 0 && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>
          Loading…
        </div>
      )}

      {!loading && filtered.length === 0 && projects.length > 0 && (
        <div
          className="rounded p-6 text-center text-[13px]"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-secondary)",
          }}
        >
          No projects match the current filters.
        </div>
      )}

      <div className="space-y-6">
        {grouped.map(([groupKey, items]) => (
          <div key={groupKey}>
            {groupBy !== "none" && (
              <div className="mb-2 flex items-baseline gap-3">
                <h3
                  className="text-[12px] font-medium uppercase tracking-[0.06em]"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {groupKey}
                </h3>
                <div className="h-px flex-1" style={{ background: "var(--color-border)" }} />
                <span className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>
                  {items.length}
                </span>
              </div>
            )}
            <div className="space-y-2">
              {items.map((p) => (
                <Row
                  key={p.id}
                  p={p}
                  selected={selected === p.id}
                  onClick={() => setSelected(p.id)}
                  onOpen={() => open(p.id)}
                  opening={opening === p.id}
                  onEdit={() => startEdit(p)}
                  onDelete={() => setPendingDelete(p)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !deleteBusy && setPendingDelete(null)}
        >
          <div
            className="w-full max-w-[420px] rounded p-5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[14px] font-semibold">Borrar del registro</h3>
            <p
              className="mt-2 text-[12.5px] leading-relaxed"
              style={{ color: "var(--color-text-secondary)" }}
            >
              ¿Quitar <b>{pendingDelete.name ?? pendingDelete.id}</b> de
              projects.json? No se tocan archivos en disco — solo se
              elimina la entrada del registro.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px] font-medium"
                style={{
                  background: "var(--color-danger)",
                  color: "#fff",
                }}
              >
                {deleteBusy ? "Borrando…" : "Borrar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
