import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  CreateProjectResult,
  LauncherItem,
  LauncherItemKind,
  ProjectActionResult,
  ProjectInfo,
} from "../types";

// ---------------------------------------------------------------------------
// Launcher item rendering helpers
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<string, string> = {
  exe: "exe",
  folder: "folder",
  claude: "claude",
  codex: "codex",
};

/** Short label for a chip when the user didn't set one — falls back to the
 *  last path/cwd component so long Windows paths stay readable. */
function itemLabel(item: LauncherItem): string {
  if (item.label && item.label.trim()) return item.label.trim();
  const src = item.path ?? item.cwd ?? "";
  if (!src) return item.kind;
  const tail = src.replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() ?? src;
  return `${KIND_LABEL[item.kind] ?? item.kind}: ${tail}`;
}

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
  onLaunchAll,
  onLaunchItem,
  onAddItem,
  onRemoveItem,
  busyItem,
  launchingAll,
}: {
  p: ProjectInfo;
  selected: boolean;
  onClick: () => void;
  onOpen: () => void;
  opening: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onLaunchAll: () => void;
  onLaunchItem: (index: number) => void;
  onAddItem: () => void;
  onRemoveItem: (index: number) => void;
  busyItem: number | null;
  launchingAll: boolean;
}) {
  const b = statusBadge(p.status);
  const items = p.items ?? [];
  return (
    <div
      className="flex flex-col gap-2 rounded p-3 transition-colors"
      style={{
        background: selected ? "var(--color-surface-3)" : "var(--color-surface-2)",
        border: `1px solid ${selected ? "var(--color-border-strong)" : "var(--color-border)"}`,
      }}
    >
      <div className="flex items-baseline gap-3">
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
          <div className="proj-action-group flex flex-wrap items-center justify-end gap-1">
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
            {items.length > 1 && (
              <button
                type="button"
                onClick={onLaunchAll}
                disabled={launchingAll}
                className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                title={`Launch all ${items.length} items sequentially`}
              >
                {launchingAll ? "Launching…" : `Launch all (${items.length})`}
              </button>
            )}
            {/* Legacy "Open" button — only when there are no launcher items
                AND the project still has a `path`. Once the user adds items
                the new model takes over completely. */}
            {items.length === 0 && p.path && (
              <button
                type="button"
                onClick={onOpen}
                disabled={opening}
                className="rounded px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
                title={`Open ${p.id} (legacy)`}
              >
                {opening ? "Opening…" : "Open"}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Launcher item chips — compact row at the bottom of the card. The
          launch button is an icon-only square (folder / cloud / exe glyph)
          so a row with many items stays readable; full kind + path is in
          the chip tooltip. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {items.map((it, i) => {
          const kindIcon =
            it.kind === "folder"
              ? "📁"
              : it.kind === "claude" || it.kind === "codex"
                ? "☁"
                : "▶";
          const launchTitle =
            it.kind === "folder"
              ? `Open folder: ${it.path ?? ""}`
              : it.kind === "claude"
                ? `Start Claude session in ${it.cwd ?? "cwd"}`
                : it.kind === "codex"
                  ? `Start Codex session in ${it.cwd ?? "cwd"}`
                  : `Launch ${it.path ?? itemLabel(it)}`;
          return (
            <div
              key={i}
              className="flex items-center gap-1 rounded pl-2 pr-0.5 py-0.5 text-[11px]"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
              title={
                it.path
                  ? `${it.kind}: ${it.path}${it.args && it.args.length > 0 ? " " + it.args.join(" ") : ""}`
                  : it.cwd
                    ? `${it.kind}: ${it.cwd}`
                    : it.kind
              }
            >
              <span
                className="text-[9.5px] uppercase tracking-wide"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                {KIND_LABEL[it.kind] ?? it.kind}
              </span>
              <span
                className="max-w-[220px] truncate"
                style={{ fontFamily: "var(--font-mono)" }}
              >
                {itemLabel(it).replace(/^[a-z]+:\s*/, "")}
              </span>
              <button
                type="button"
                onClick={() => onLaunchItem(i)}
                disabled={busyItem === i}
                className="flex h-5 w-5 items-center justify-center rounded text-[11px] transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title={launchTitle}
                aria-label={launchTitle}
              >
                {busyItem === i ? "…" : kindIcon}
              </button>
              <button
                type="button"
                onClick={() => onRemoveItem(i)}
                className="flex h-5 w-4 items-center justify-center rounded text-[11px]"
                style={{
                  background: "transparent",
                  color: "var(--color-danger)",
                }}
                title="Remove this item from the project"
                aria-label="Remove item"
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAddItem}
          className="rounded px-2 py-0.5 text-[11px]"
          style={{
            background: "transparent",
            color: "var(--color-text-tertiary)",
            border: "1px dashed var(--color-border-strong)",
          }}
          title="Add a new launcher item to this project"
        >
          + Add item
        </button>
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

type GroupBy = "none" | "language" | "tag";
type SortBy = "recent" | "alpha" | "type";

// Parse the `last_active` string (ISO timestamp or a relative label like
// "2h ago") into a sortable number. Higher = more recent. Unknown → 0 so
// undated projects sink to the bottom.
function lastActiveScore(p: ProjectInfo): number {
  if (!p.last_active) return 0;
  const t = Date.parse(p.last_active);
  if (!Number.isNaN(t)) return t;
  // Fallback: ranks ISO-ish strings lexicographically.
  return p.last_active.charCodeAt(0);
}

const ITEM_KINDS: { value: LauncherItemKind; label: string; hint: string }[] = [
  { value: "exe", label: "Executable", hint: "Spawn a .exe / .lnk / .bat with optional args" },
  { value: "folder", label: "Folder", hint: "Open the folder in Windows Explorer" },
  { value: "claude", label: "Claude session", hint: "New wt.exe tab running claude in cwd" },
  { value: "codex", label: "Codex session", hint: "New wt.exe tab running codex in cwd" },
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
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [sortBy, setSortBy] = useState<SortBy>("recent");
  const [selected, setSelected] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastAction, setLastAction] = useState<ProjectActionResult | null>(null);

  // Per-row busy markers — keyed by project id so multiple rows can be
  // launching concurrently without stepping on each other.
  const [busyItem, setBusyItem] = useState<Record<string, number | null>>({});
  const [launchingAll, setLaunchingAll] = useState<Record<string, boolean>>({});

  // New/edit project wizard state — same form for both flows; `editingId`
  // distinguishes create vs update.
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wName, setWName] = useState("");
  const [wPath, setWPath] = useState("");
  const [wTags, setWTags] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // Add-item modal state.
  const [itemTarget, setItemTarget] = useState<ProjectInfo | null>(null);
  const [iKind, setIKind] = useState<LauncherItemKind>("exe");
  const [iPath, setIPath] = useState("");
  const [iCwd, setICwd] = useState("");
  const [iArgs, setIArgs] = useState("");
  const [iLabel, setILabel] = useState("");
  const [itemSaving, setItemSaving] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);

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

  async function openLegacy(id: string) {
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

  async function launchItem(projectId: string, index: number) {
    setBusyItem((m) => ({ ...m, [projectId]: index }));
    setLastAction(null);
    try {
      await invoke("launch_item", { projectId, index });
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: `launch_item: ${String(e)}`,
        exit_code: null,
      });
    } finally {
      setBusyItem((m) => ({ ...m, [projectId]: null }));
    }
  }

  async function launchAll(projectId: string) {
    setLaunchingAll((m) => ({ ...m, [projectId]: true }));
    setLastAction(null);
    try {
      const launched = (await invoke("launch_all_items", { projectId })) as number;
      const project = projects.find((p) => p.id === projectId);
      const total = project?.items?.length ?? 0;
      if (launched < total) {
        setLastAction({
          success: false,
          stdout: "",
          stderr: `Only ${launched}/${total} items launched — check terminal logs`,
          exit_code: null,
        });
      }
    } catch (e) {
      setLastAction({
        success: false,
        stdout: "",
        stderr: `launch_all_items: ${String(e)}`,
        exit_code: null,
      });
    } finally {
      setLaunchingAll((m) => ({ ...m, [projectId]: false }));
    }
  }

  useEffect(() => {
    load();
  }, []);

  function resetWizard() {
    setWName("");
    setWPath("");
    setWTags("");
    setEditingId(null);
    setCreateError(null);
  }

  function startEdit(p: ProjectInfo) {
    setEditingId(p.id);
    setWName(p.name ?? "");
    setWPath(p.path ?? "");
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
          ide: null,
          language: null,
          tags: tagList,
        });
        resetWizard();
        setWizardOpen(false);
        await load();
      } else {
        const r = (await invoke("create_project", {
          name: wName,
          // Empty path is allowed — the project becomes a pure launch group.
          path: wPath,
          ide: null,
          language: null,
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

  function openAddItem(p: ProjectInfo) {
    setItemTarget(p);
    setIKind("exe");
    setIPath("");
    setICwd("");
    setIArgs("");
    setILabel("");
    setItemError(null);
  }

  async function pickItemFile() {
    try {
      const path = await openDialog({
        directory: false,
        multiple: false,
        title: "Pick an executable, shortcut or batch file",
      });
      if (typeof path === "string" && path) setIPath(path);
    } catch {}
  }

  async function pickItemFolder() {
    try {
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a folder",
      });
      if (typeof path === "string" && path) {
        if (iKind === "folder") setIPath(path);
        else setICwd(path);
      }
    } catch {}
  }

  async function saveItem() {
    if (!itemTarget) return;
    setItemSaving(true);
    setItemError(null);
    try {
      const trimmed = (s: string) => (s.trim() ? s.trim() : null);
      // Split args on whitespace, honouring simple double-quoted segments so
      // `--launch-product="league of"` and `--name "with spaces"` both work.
      const args: string[] = [];
      if (iKind === "exe" && iArgs.trim()) {
        const re = /"([^"]*)"|(\S+)/g;
        let m;
        while ((m = re.exec(iArgs)) !== null) {
          args.push(m[1] !== undefined ? m[1] : m[2]);
        }
      }
      const item: LauncherItem = {
        kind: iKind,
        path: iKind === "exe" || iKind === "folder" ? trimmed(iPath) : null,
        cwd: iKind === "claude" || iKind === "codex" ? trimmed(iCwd) : null,
        args: args.length > 0 ? args : null,
        label: trimmed(iLabel),
      };
      await invoke("add_launcher_item", {
        projectId: itemTarget.id,
        item,
      });
      setItemTarget(null);
      await load();
    } catch (e) {
      setItemError(String(e));
    } finally {
      setItemSaving(false);
    }
  }

  async function removeItem(projectId: string, index: number) {
    try {
      await invoke("remove_launcher_item", { projectId, index });
      await load();
    } catch (e) {
      setError(String(e));
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

  const sortByCountDesc = (counts: Record<string, number>) =>
    Object.keys(counts).sort((a, b) =>
      counts[b] - counts[a] !== 0 ? counts[b] - counts[a] : a.localeCompare(b),
    );

  const statusKeys = useMemo(() => sortByCountDesc(statusCounts), [statusCounts]);
  const languageKeys = useMemo(() => sortByCountDesc(languageCounts), [languageCounts]);

  // Filtered + searched
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = projects
      .filter((p) => {
        if (statusFilters.size === 0) return true;
        return statusFilters.has(p.status ?? "—");
      })
      .filter((p) => {
        if (languageFilters.size === 0) return true;
        return languageFilters.has((p.language ?? "").trim() || "—");
      })
      .filter((p) => {
        if (!q) return true;
        const hay = [
          p.id,
          p.name ?? "",
          p.path ?? "",
          p.language ?? "",
          ...(p.tags ?? []),
          ...((p.items ?? []).map(
            (it) => `${it.kind} ${it.path ?? ""} ${it.cwd ?? ""} ${it.label ?? ""}`,
          )),
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });

    // Apply sort. We always copy the array (don't mutate the source) so
    // re-renders with a new sort key see fresh order.
    const sorted = [...matched];
    if (sortBy === "recent") {
      sorted.sort((a, b) => lastActiveScore(b) - lastActiveScore(a));
    } else if (sortBy === "alpha") {
      sorted.sort((a, b) =>
        (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, {
          sensitivity: "base",
        }),
      );
    } else if (sortBy === "type") {
      sorted.sort((a, b) => {
        const aType = (a.language ?? a.type_ ?? "").toLowerCase();
        const bType = (b.language ?? b.type_ ?? "").toLowerCase();
        const t = aType.localeCompare(bType);
        if (t !== 0) return t;
        return (a.name ?? a.id).localeCompare(b.name ?? b.id);
      });
    }
    return sorted;
  }, [projects, statusFilters, languageFilters, query, sortBy]);

  // Group filtered by chosen dimension
  const grouped = useMemo(() => {
    if (groupBy === "none") return [["", filtered]] as [string, ProjectInfo[]][];
    const map = new Map<string, ProjectInfo[]>();
    for (const p of filtered) {
      const key =
        groupBy === "language"
          ? (p.language ?? "").trim() || "—"
          : (p.tags[0] ?? "").trim() || "—";
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

  return (
    <div className="cc-page projects-page px-10 py-8">
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
            title="Walk del filesystem en busca de proyectos nuevos (ultron.ps1 scan + rewrite de projects.json). Tarda más; ejecuta sólo cuando hayas añadido carpetas en disco."
          >
            {scanning ? "Scanning…" : "Rescan disk"}
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
            title="Re-lee projects.json sin tocar disco. Útil si has editado proyectos en otra herramienta."
          >
            {loading ? "Loading…" : "Refresh list"}
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
                placeholder="e.g. League of Legends"
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
                Path (optional — leave blank for pure launch group)
              </label>
              <div className="mt-1 flex gap-2">
                <input
                  type="text"
                  value={wPath}
                  onChange={(e) => setWPath(e.target.value)}
                  placeholder="C:\Users\... (or leave empty)"
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
                  title="Pick a folder"
                >
                  Folder
                </button>
              </div>
            </div>
            <div className="col-span-2">
              <label className="text-[10px] uppercase tracking-wide" style={{ color: "var(--color-text-tertiary)" }}>
                Tags (comma-separated)
              </label>
              <input
                type="text"
                value={wTags}
                onChange={(e) => setWTags(e.target.value)}
                placeholder="e.g. gaming, work, personal"
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
              disabled={creating || !wName.trim()}
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
          <p
            className="mt-3 text-[11px] leading-relaxed"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            After creating the project, use "+ Add item" on the row to attach
            launcher items (executables, folders, Claude/Codex sessions).
          </p>
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
          placeholder="Search id, name, path, language, tag, item…"
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
        <label
          className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.06em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Sort
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="rounded px-2 py-1 text-[11.5px]"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)",
              outline: "none",
            }}
            title="Order projects by recency, name or detected language/type"
          >
            <option value="recent">Most recent</option>
            <option value="alpha">Alphabetical</option>
            <option value="type">By type</option>
          </select>
        </label>
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

      {/* Group-by switch */}
      <div className="mb-4 flex items-center gap-1.5">
        <span
          className="text-[10px] font-medium uppercase tracking-[0.06em] w-16"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Group by
        </span>
        {(["none", "language", "tag"] as GroupBy[]).map((g) => (
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
          {lastAction.stderr || lastAction.stdout || `exit ${lastAction.exit_code}`}
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
                  onOpen={() => openLegacy(p.id)}
                  opening={opening === p.id}
                  onEdit={() => startEdit(p)}
                  onDelete={() => setPendingDelete(p)}
                  onLaunchAll={() => launchAll(p.id)}
                  onLaunchItem={(i) => launchItem(p.id, i)}
                  onAddItem={() => openAddItem(p)}
                  onRemoveItem={(i) => removeItem(p.id, i)}
                  busyItem={busyItem[p.id] ?? null}
                  launchingAll={!!launchingAll[p.id]}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Add launcher item modal */}
      {itemTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !itemSaving && setItemTarget(null)}
        >
          <div
            className="w-full max-w-[520px] rounded p-5"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-border-strong)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[14px] font-semibold">
              Add item — {itemTarget.name ?? itemTarget.id}
            </h3>
            <p
              className="mt-1 text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Pick a kind and supply its path. The item appears as a chip on
              the project row; clicking "Launch all" fires every item in order.
            </p>
            <div className="mt-3 space-y-3">
              <div>
                <label
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Kind
                </label>
                <select
                  value={iKind}
                  onChange={(e) => setIKind(e.target.value as LauncherItemKind)}
                  className="mt-1 w-full rounded px-2 py-1.5 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                  }}
                >
                  {ITEM_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label} — {k.hint}
                    </option>
                  ))}
                </select>
              </div>

              {(iKind === "exe" || iKind === "folder") && (
                <div>
                  <label
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Path
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      value={iPath}
                      onChange={(e) => setIPath(e.target.value)}
                      placeholder={
                        iKind === "exe"
                          ? "C:/Riot Games/Riot Client/RiotClientServices.exe"
                          : "C:/Users/USER/.ultron/control-center"
                      }
                      className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
                      style={{
                        background: "var(--color-surface-2)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                        fontFamily: "var(--font-mono)",
                        outline: "none",
                      }}
                    />
                    <button
                      type="button"
                      onClick={iKind === "exe" ? pickItemFile : pickItemFolder}
                      className="rounded px-2 py-1 text-[11px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      Pick
                    </button>
                  </div>
                </div>
              )}

              {(iKind === "claude" || iKind === "codex") && (
                <div>
                  <label
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Cwd
                  </label>
                  <div className="mt-1 flex gap-2">
                    <input
                      type="text"
                      value={iCwd}
                      onChange={(e) => setICwd(e.target.value)}
                      placeholder="C:/Users/USER/.ultron"
                      className="flex-1 rounded px-2 py-1.5 text-[11.5px]"
                      style={{
                        background: "var(--color-surface-2)",
                        color: "var(--color-text)",
                        border: "1px solid var(--color-border-strong)",
                        fontFamily: "var(--font-mono)",
                        outline: "none",
                      }}
                    />
                    <button
                      type="button"
                      onClick={pickItemFolder}
                      className="rounded px-2 py-1 text-[11px]"
                      style={{
                        background: "var(--color-surface-3)",
                        color: "var(--color-text-secondary)",
                        border: "1px solid var(--color-border-strong)",
                      }}
                    >
                      Pick
                    </button>
                  </div>
                </div>
              )}

              {iKind === "exe" && (
                <div>
                  <label
                    className="text-[10px] uppercase tracking-wide"
                    style={{ color: "var(--color-text-tertiary)" }}
                  >
                    Args (optional, space-separated; use double-quotes for spaces)
                  </label>
                  <input
                    type="text"
                    value={iArgs}
                    onChange={(e) => setIArgs(e.target.value)}
                    placeholder='--launch-product=league_of_legends --launch-patchline=live'
                    className="mt-1 w-full rounded px-2 py-1.5 text-[11.5px]"
                    style={{
                      background: "var(--color-surface-2)",
                      color: "var(--color-text)",
                      border: "1px solid var(--color-border-strong)",
                      fontFamily: "var(--font-mono)",
                      outline: "none",
                    }}
                  />
                </div>
              )}

              <div>
                <label
                  className="text-[10px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Label (optional)
                </label>
                <input
                  type="text"
                  value={iLabel}
                  onChange={(e) => setILabel(e.target.value)}
                  placeholder="e.g. Launch League"
                  className="mt-1 w-full rounded px-2 py-1.5 text-[12px]"
                  style={{
                    background: "var(--color-surface-2)",
                    color: "var(--color-text)",
                    border: "1px solid var(--color-border-strong)",
                    outline: "none",
                  }}
                />
              </div>
            </div>
            {itemError && (
              <p
                className="mt-2 text-[11.5px]"
                style={{ color: "var(--color-danger)" }}
              >
                {itemError}
              </p>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setItemTarget(null)}
                disabled={itemSaving}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{
                  background: "transparent",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveItem}
                disabled={
                  itemSaving ||
                  ((iKind === "exe" || iKind === "folder") && !iPath.trim()) ||
                  ((iKind === "claude" || iKind === "codex") && !iCwd.trim())
                }
                className="rounded px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-accent)",
                  color: "var(--color-accent-text)",
                }}
              >
                {itemSaving ? "Saving…" : "Add"}
              </button>
            </div>
          </div>
        </div>
      )}

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
