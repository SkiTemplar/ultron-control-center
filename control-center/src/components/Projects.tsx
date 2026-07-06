// Projects — top-level orchestrator for the Projects tab.
// P1 split refactor: 3594 L → ~370 L orchestrator.
// Sub-components live in ./projects/:
//   types.ts, utils.ts, LauncherIcons.tsx
//   ProjectCard.tsx, ProjectRow.tsx
//   FolderTreeView.tsx, BlocksProjectView.tsx
//   ProjectWizardModal.tsx, AddItemModal.tsx

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import BatchDropdown from "./projects/BatchDropdown";
import type {
  CreateProjectResult,
  LauncherItem,
  LauncherItemKind,
  ProjectActionResult,
  ProjectExecutable,
  ProjectInfo,
  ProjectShell,
  SessionProvider,
  KanbanBoard,
} from "../types";
import { useProjectsTabs } from "../state/ProjectsTabsContext";
import NewOpenGlProjectModal from "./projects/NewOpenGlProjectModal";
import { ProjectCard } from "./projects/ProjectCard";
import { ProjectRow } from "./projects/ProjectRow";
import { FolderTreeView } from "./projects/FolderTreeView";
import { BlocksProjectView } from "./projects/BlocksProjectView";
import { ProjectWizardModal } from "./projects/ProjectWizardModal";
import { AddItemModal } from "./projects/AddItemModal";
import {
  buildFolderTree,
  lastActiveScore,
} from "./projects/utils";
import type {
  CardStats,
  HierarchyMode,
  ProjectsProps,
  SortBy,
  ViewMode,
} from "./projects/types";

export function Projects({ onOpenProject }: ProjectsProps = {}) {
  // ---------------------------------------------------------------------------
  // View state
  // ---------------------------------------------------------------------------
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try { return localStorage.getItem("projects.viewMode") === "list" ? "list" : "cards"; }
    catch { return "cards"; }
  });
  useEffect(() => {
    try { localStorage.setItem("projects.viewMode", viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  const [hierarchy, setHierarchy] = useState<HierarchyMode>(() => {
    try {
      const v = localStorage.getItem("projects.hierarchy");
      if (v === "flat" || v === "tree" || v === "blocks") return v;
    } catch { /* ignore */ }
    return "flat";
  });
  useEffect(() => {
    try { localStorage.setItem("projects.hierarchy", hierarchy); } catch { /* ignore */ }
  }, [hierarchy]);

  const [blockPath, setBlockPath] = useState<string[]>([]);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set<string>());
  const [sortBy, setSortBy] = useState<SortBy>("recent");
  const [query, setQuery] = useState("");

  // ---------------------------------------------------------------------------
  // Data state
  // ---------------------------------------------------------------------------
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [lastAction, setLastAction] = useState<ProjectActionResult | null>(null);
  const [stats, setStats] = useState<Record<string, CardStats>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<Record<string, number | null>>({});
  const [launchingAll, setLaunchingAll] = useState<Record<string, boolean>>({});

  // ---------------------------------------------------------------------------
  // Wizard (create / edit) state
  // ---------------------------------------------------------------------------
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [wName, setWName] = useState("");
  const [wPath, setWPath] = useState("");
  const [wTags, setWTags] = useState("");
  const [wIde, setWIde] = useState("");
  const [wDefaultProvider, setWDefaultProvider] = useState<SessionProvider>("claude");
  const [wDefaultShell, setWDefaultShell] = useState<ProjectShell | "">("");
  const [wParentFolderOverride, setWParentFolderOverride] = useState("");
  const [wNotes, setWNotes] = useState("");
  const [wExecutables, setWExecutables] = useState<ProjectExecutable[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectInfo | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [openglModalOpen, setOpenglModalOpen] = useState(false);

  // ---------------------------------------------------------------------------
  // Add-item modal state
  // ---------------------------------------------------------------------------
  const [itemTarget, setItemTarget] = useState<ProjectInfo | null>(null);
  const [iKind, setIKind] = useState<LauncherItemKind>("folder");
  const [iPath, setIPath] = useState("");
  const [iCwd, setICwd] = useState("");
  const [iArgs, setIArgs] = useState("");
  const [iLabel, setILabel] = useState("");
  const [iProvider, setIProvider] = useState<SessionProvider>("claude");
  const [itemSaving, setItemSaving] = useState(false);
  const [itemError, setItemError] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Workspace navigation
  // ---------------------------------------------------------------------------
  const tabsCtx = useProjectsTabs();
  // Bump last_active so "Most recent" ordering tracks real usage. Optimistic:
  // patch local state so the project jumps to the top immediately, then persist
  // (best-effort — the visible order is already correct without the round-trip).
  function touchProject(id: string) {
    const nowIso = new Date().toISOString();
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, last_active: nowIso } : p)));
    void invoke("touch_project", { id }).catch(() => { /* non-fatal */ });
  }
  function openInWorkspace(id: string, name: string) {
    touchProject(id);
    if (onOpenProject) { onOpenProject({ id, name }); return; }
    tabsCtx.open({ id, title: name });
  }

  // ---------------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------------
  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("list_projects")) as ProjectInfo[];
      setProjects(r);
      setError(null);
      void refreshStats(r);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function refreshStats(list: ProjectInfo[]) {
    const next: Record<string, CardStats> = {};
    await Promise.all(
      list.map(async (p) => {
        const entry: CardStats = { pending: null };
        try {
          const b = (await invoke("kanban_load", { projectId: p.id })) as KanbanBoard;
          const doneColIds = new Set(b.columns.filter((c) => /done|complete/i.test(c.name)).map((c) => c.id));
          entry.pending = b.cards.filter((c) => !doneColIds.has(c.column_id)).length;
        } catch { /* leave null */ }
        next[p.id] = entry;
      }),
    );
    setStats(next);
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

  useEffect(() => { load(); }, []);

  // ESC closes wizard
  useEffect(() => {
    if (!wizardOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setWizardOpen(false); resetWizard(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wizardOpen]);

  // ---------------------------------------------------------------------------
  // Project actions
  // ---------------------------------------------------------------------------
  async function openLegacy(id: string) {
    touchProject(id);
    if (onOpenProject) { const p = projects.find((x) => x.id === id); onOpenProject({ id, name: p?.name ?? id }); return; }
    setOpening(id);
    setLastAction(null);
    try {
      const r = (await invoke("open_project", { id })) as ProjectActionResult;
      setLastAction(r);
    } catch (e) {
      setLastAction({ success: false, stdout: "", stderr: String(e), exit_code: null });
    } finally {
      setOpening(null);
    }
  }

  async function cardOpenFolder(p: ProjectInfo) {
    if (!p.path) return;
    try { await openPath(p.path); }
    catch (e) { setLastAction({ success: false, stdout: "", stderr: `open folder: ${String(e)}`, exit_code: null }); }
  }

  async function cardOpenIde(p: ProjectInfo) {
    if (!p.path) return;
    touchProject(p.id);
    try { await invoke("open_project_in_ide", { path: p.path, preferredIde: p.ide ?? null }); }
    catch (e) { setLastAction({ success: false, stdout: "", stderr: `open IDE: ${String(e)}`, exit_code: null }); }
  }

  async function cardOpenAi(p: ProjectInfo) {
    touchProject(p.id);
    const provider: SessionProvider = (p.default_provider as SessionProvider | null | undefined) ?? "claude";
    try {
      // V1: launch an external CLI session (wt.exe wrapper). No embedded
      // terminal, no workspace deep-link.
      await invoke("spawn_session", {
        provider,
        cwd: p.path ?? null,
        prompt: null,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch (e) {
      setLastAction({ success: false, stdout: "", stderr: `spawn ${provider}: ${String(e)}`, exit_code: null });
    }
  }

  async function launchItem(projectId: string, index: number) {
    touchProject(projectId);
    setBusyItem((m) => ({ ...m, [projectId]: index }));
    setLastAction(null);
    try { await invoke("launch_item", { projectId, index }); }
    catch (e) { setLastAction({ success: false, stdout: "", stderr: `launch_item: ${String(e)}`, exit_code: null }); }
    finally { setBusyItem((m) => ({ ...m, [projectId]: null })); }
  }

  async function launchAll(projectId: string) {
    touchProject(projectId);
    setLaunchingAll((m) => ({ ...m, [projectId]: true }));
    setLastAction(null);
    try {
      const launched = (await invoke("launch_all_items", { projectId })) as number;
      const project = projects.find((p) => p.id === projectId);
      const total = (project?.items ?? []).filter((it) => it.kind !== "folder").length;
      if (launched < total) {
        setLastAction({ success: false, stdout: "", stderr: `Only ${launched}/${total} items launched — check terminal logs`, exit_code: null });
      }
    } catch (e) {
      setLastAction({ success: false, stdout: "", stderr: `launch_all_items: ${String(e)}`, exit_code: null });
    } finally {
      setLaunchingAll((m) => ({ ...m, [projectId]: false }));
    }
  }

  async function removeItem(projectId: string, index: number) {
    try { await invoke("remove_launcher_item", { projectId, index }); await load(); }
    catch (e) { setError(String(e)); }
  }

  async function setDefaultProvider(projectId: string, provider: SessionProvider) {
    const providers: SessionProvider[] = ["claude", "codex"];
    setProjects((prev) =>
      prev.map((proj) => {
        if (proj.id !== projectId) return proj;
        const items = proj.items ?? null;
        let nextItems = items;
        if (items && items.length > 0) {
          const hasTarget = items.some((it) => it.kind === provider);
          if (!hasTarget) {
            let mutated = false;
            nextItems = items.map((it) => {
              if (!mutated && providers.includes(it.kind as SessionProvider)) { mutated = true; return { ...it, kind: provider }; }
              return it;
            });
          }
        }
        return { ...proj, default_provider: provider, items: nextItems };
      }),
    );
    try { await invoke("set_default_provider", { projectId, provider }); }
    catch (e) { setError(String(e)); await load(); }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try { await invoke("delete_project", { id: pendingDelete.id }); setPendingDelete(null); await load(); }
    catch (e) { setError(String(e)); }
    finally { setDeleteBusy(false); }
  }

  // ---------------------------------------------------------------------------
  // Wizard helpers
  // ---------------------------------------------------------------------------
  function resetWizard() {
    setWName(""); setWPath(""); setWTags(""); setWIde("");
    setWDefaultProvider("claude"); setWDefaultShell("");
    setWParentFolderOverride(""); setWNotes(""); setWExecutables([]);
    setEditingId(null); setCreateError(null);
  }

  function startEdit(p: ProjectInfo) {
    setEditingId(p.id);
    setWName(p.name ?? ""); setWPath(p.path ?? "");
    setWTags(p.tags.join(", ")); setWIde(p.ide ?? "");
    setWDefaultProvider((p.default_provider as SessionProvider | null | undefined) ?? "claude");
    setWDefaultShell((p.default_shell as ProjectShell | null | undefined) ?? "");
    setWParentFolderOverride(p.parent_folder_override ?? "");
    setWNotes(p.notes ?? "");
    setWExecutables((p.executables ?? []).map((e) => ({ name: e.name, path: e.path })));
    setCreateError(null);
    setWizardOpen(true);
  }

  async function saveProject() {
    setCreating(true); setCreateError(null);
    try {
      const tagList = wTags.split(",").map((t) => t.trim()).filter(Boolean);
      const idePayload = wIde === "" ? "" : wIde;
      const shellPayload: string | null = wDefaultShell === "" ? null : wDefaultShell;
      const parentFolderTrimmed = wParentFolderOverride.trim();
      const notesTrimmed = wNotes.trim();
      if (editingId) {
        const cleanedExecs = wExecutables.map((e) => ({ name: e.name.trim(), path: e.path.trim() })).filter((e) => e.name && e.path);
        await invoke("update_project", {
          id: editingId, name: wName || null, path: wPath || null, ide: idePayload,
          language: null, tags: tagList, defaultProvider: wDefaultProvider,
          defaultShell: wDefaultShell === "" ? "" : wDefaultShell,
          parentFolderOverride: parentFolderTrimmed, notes: notesTrimmed, executables: cleanedExecs,
        });
        resetWizard(); setWizardOpen(false); await load();
      } else {
        const r = (await invoke("create_project", {
          name: wName, path: wPath, ide: idePayload || null, language: null,
          tags: tagList.length > 0 ? tagList : null, defaultProvider: wDefaultProvider,
          defaultShell: shellPayload, parentFolderOverride: parentFolderTrimmed || null, notes: notesTrimmed || null,
        })) as CreateProjectResult;
        if (r.success) { resetWizard(); setWizardOpen(false); await load(); }
        else { setCreateError(r.message); }
      }
    } catch (e) { setCreateError(String(e)); }
    finally { setCreating(false); }
  }

  async function pickWizardPath() {
    try {
      const path = await openDialog({ directory: true, multiple: false, title: "Project folder" });
      if (typeof path === "string" && path) setWPath(path);
    } catch { /* cancelled */ }
  }

  // ---------------------------------------------------------------------------
  // Add-item helpers
  // ---------------------------------------------------------------------------
  function openAddItem(p: ProjectInfo) {
    setItemTarget(p); setIKind("folder"); setIPath(""); setICwd("");
    setIArgs(""); setILabel(""); setItemError(null);
  }

  async function pickItemFile() {
    try {
      const path = await openDialog({ directory: false, multiple: false, title: "Pick an executable, shortcut or batch file" });
      if (typeof path === "string" && path) setIPath(path);
    } catch { /* cancelled */ }
  }

  async function pickItemFolder() {
    try {
      const path = await openDialog({ directory: true, multiple: false, title: "Pick a folder" });
      if (typeof path === "string" && path) { if (iKind === "folder") setIPath(path); else setICwd(path); }
    } catch { /* cancelled */ }
  }

  async function saveItem() {
    if (!itemTarget) return;
    setItemSaving(true); setItemError(null);
    try {
      const trimmed = (s: string) => (s.trim() ? s.trim() : null);
      const args: string[] = [];
      if (iKind === "exe" && iArgs.trim()) {
        const re = /"([^"]*)"|(\S+)/g;
        let m;
        while ((m = re.exec(iArgs)) !== null) args.push(m[1] !== undefined ? m[1] : m[2]);
      }
      const needsPath = iKind === "exe" || iKind === "folder" || iKind === "ide";
      const needsCwd = iKind === "session" || iKind === "claude" || iKind === "codex";
      const item: LauncherItem = {
        kind: iKind,
        path: needsPath ? trimmed(iPath) || (iKind === "ide" ? itemTarget.path ?? null : null) : null,
        cwd: needsCwd ? trimmed(iCwd) : null,
        args: args.length > 0 ? args : null,
        label: trimmed(iLabel),
        provider: iKind === "session" ? iProvider : null,
      };
      await invoke("add_launcher_item", { projectId: itemTarget.id, item });
      setItemTarget(null); await load();
    } catch (e) { setItemError(String(e)); }
    finally { setItemSaving(false); }
  }

  // ---------------------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------------------
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = projects.filter((p) => {
      if (!q) return true;
      const hay = [p.id, p.name ?? "", p.path ?? "", p.language ?? "", ...(p.tags ?? []),
        ...((p.items ?? []).map((it) => `${it.kind} ${it.path ?? ""} ${it.cwd ?? ""} ${it.label ?? ""}`))]
        .join(" ").toLowerCase();
      return hay.includes(q);
    });
    const sorted = [...matched];
    if (sortBy === "recent") sorted.sort((a, b) => lastActiveScore(b) - lastActiveScore(a));
    else if (sortBy === "alpha") sorted.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id, undefined, { sensitivity: "base" }));
    else if (sortBy === "type") {
      sorted.sort((a, b) => {
        const t = (a.language ?? a.type_ ?? "").toLowerCase().localeCompare((b.language ?? b.type_ ?? "").toLowerCase());
        return t !== 0 ? t : (a.name ?? a.id).localeCompare(b.name ?? b.id);
      });
    }
    return sorted;
  }, [projects, query, sortBy]);

  const folderTree = useMemo(() => buildFolderTree(filtered), [filtered]);

  const tagPool = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) for (const t of p.tags ?? []) { const tr = t.trim(); if (tr) set.add(tr); }
    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [projects]);

  const wTagsParsed = useMemo(
    () => wTags.split(",").map((t) => t.trim()).filter(Boolean),
    [wTags],
  );

  function toggleWizardTag(tag: string) {
    const has = wTagsParsed.some((t) => t.toLowerCase() === tag.toLowerCase());
    const next = has ? wTagsParsed.filter((t) => t.toLowerCase() !== tag.toLowerCase()) : [...wTagsParsed, tag];
    setWTags(next.join(", "));
  }

  function toggleFolder(fullPath: string) {
    setCollapsedFolders((prev) => { const next = new Set(prev); if (next.has(fullPath)) next.delete(fullPath); else next.add(fullPath); return next; });
  }

  function openWizard() { resetWizard(); setWizardOpen(true); }
  function closeWizard() { setWizardOpen(false); resetWizard(); }

  // ---------------------------------------------------------------------------
  // Shared props for tree/blocks views
  // ---------------------------------------------------------------------------
  const sharedCardProps = {
    stats, openInWorkspace, cardOpenFolder, cardOpenIde, cardOpenAi,
    startEdit, setPendingDelete,
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="cc-page projects-page px-10 py-8">
      {/* Header */}
      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold leading-tight">Projects</h1>
          <p className="mt-1 text-[13px]" style={{ color: "var(--color-text-secondary)" }}>
            {projects.length} registered · {filtered.length} shown
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Run Batch — siempre visible en el header de la lista de proyectos */}
          <BatchDropdown headerStyle />
          <button type="button" onClick={() => setOpenglModalOpen(true)}
            className="rounded px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
            title="Scaffold a new OpenGL/vcpkg project"
          >
            + OpenGL Project
          </button>
          <button type="button" onClick={scan} disabled={scanning}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{ background: "var(--color-surface-3)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)" }}
            title="Walk filesystem for new projects"
          >
            {scanning ? "Scanning…" : "Rescan disk"}
          </button>
          <button type="button" onClick={load} disabled={loading}
            className="rounded px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{ background: "transparent", color: "var(--color-text-secondary)", border: "1px solid var(--color-border-strong)" }}
            title="Re-read projects.json without touching the disk"
          >
            {loading ? "Loading…" : "Refresh list"}
          </button>
        </div>
      </header>

      {/* Create / edit wizard modal */}
      {wizardOpen && (
        <ProjectWizardModal
          editingId={editingId} wName={wName} wPath={wPath} wTags={wTags} wIde={wIde}
          wDefaultProvider={wDefaultProvider} wDefaultShell={wDefaultShell}
          wParentFolderOverride={wParentFolderOverride} wNotes={wNotes} wExecutables={wExecutables}
          creating={creating} createError={createError} tagPool={tagPool} wTagsParsed={wTagsParsed}
          onClose={closeWizard} onSave={saveProject} onPickPath={pickWizardPath} onToggleTag={toggleWizardTag}
          setWName={setWName} setWPath={setWPath} setWTags={setWTags} setWIde={setWIde}
          setWDefaultProvider={setWDefaultProvider} setWDefaultShell={setWDefaultShell}
          setWParentFolderOverride={setWParentFolderOverride} setWNotes={setWNotes}
          setWExecutables={setWExecutables}
        />
      )}

      {/* Error banner */}
      {error && (
        <div className="mb-4 rounded p-3 text-[12.5px]"
          style={{ background: "rgba(248, 81, 73, 0.06)", border: "1px solid rgba(248, 81, 73, 0.22)", color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {/* Search + sort + view toggle + new project CTA */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input type="text" placeholder="Search id, name, path, language, tag, item…"
          value={query} onChange={(e) => setQuery(e.target.value)}
          className="flex-1 rounded px-3 py-1.5 text-[12.5px]"
          style={{ background: "var(--color-surface-2)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)", outline: "none", minWidth: 280 }}
        />
        <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.06em]" style={{ color: "var(--color-text-tertiary)" }}>
          Sort
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}
            className="rounded px-2 py-1 text-[11.5px]"
            style={{ background: "var(--color-surface-2)", color: "var(--color-text)", border: "1px solid var(--color-border-strong)", outline: "none" }}
          >
            <option value="recent">Most recent</option>
            <option value="alpha">Alphabetical</option>
            <option value="type">By type</option>
          </select>
        </label>
        <div className="flex items-center gap-px overflow-hidden rounded"
          style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border-strong)" }}
          aria-label="View mode"
        >
          {(["cards", "list"] as ViewMode[]).map((m) => {
            const active = viewMode === m;
            return (
              <button key={m} type="button" onClick={() => setViewMode(m)}
                className="px-2 py-1 text-[11.5px] font-medium capitalize transition-colors"
                style={{ background: active ? "var(--color-accent)" : "transparent", color: active ? "var(--color-accent-text)" : "var(--color-text-secondary)" }}
                aria-pressed={active}
              >
                {m}
              </button>
            );
          })}
        </div>
        <button type="button" onClick={wizardOpen ? closeWizard : openWizard}
          className="rounded px-3 py-1.5 text-[11.5px] font-medium transition-colors"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          title="Create a new project (wizard)"
        >
          + New project
        </button>
      </div>

      {/* Hierarchy toggle */}
      <div className="mb-4 flex items-center gap-1.5">
        <span className="w-16 text-[10px] font-medium uppercase tracking-[0.06em]" style={{ color: "var(--color-text-tertiary)" }}>
          Layout
        </span>
        {(["blocks", "tree", "flat"] as HierarchyMode[]).map((m) => {
          const active = hierarchy === m;
          return (
            <button key={m} type="button"
              onClick={() => { setHierarchy(m); if (m !== "blocks") setBlockPath([]); }}
              className="rounded px-2 py-0.5 text-[11.5px] transition-colors"
              style={{ background: active ? "var(--color-surface-3)" : "transparent", color: active ? "var(--color-text)" : "var(--color-text-tertiary)", border: `1px solid ${active ? "var(--color-border-strong)" : "var(--color-border)"}` }}
              title={m === "blocks" ? "Big tiles per parent folder — drill in by clicking" : m === "tree" ? "Group by common parent folder" : "Flat grid"}
            >
              {m}
            </button>
          );
        })}
      </div>

      {/* Last-action error */}
      {lastAction && !lastAction.success && (
        <div className="mb-4 rounded p-3 text-[12px]"
          style={{ background: "rgba(248, 81, 73, 0.06)", border: "1px solid rgba(248, 81, 73, 0.22)", color: "var(--color-danger)" }}>
          {lastAction.stderr || lastAction.stdout || `exit ${lastAction.exit_code}`}
        </div>
      )}

      {loading && projects.length === 0 && (
        <div className="text-[12.5px]" style={{ color: "var(--color-text-tertiary)" }}>Loading…</div>
      )}
      {!loading && filtered.length === 0 && projects.length > 0 && (
        <div className="rounded p-6 text-center text-[13px]"
          style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)", color: "var(--color-text-secondary)" }}>
          No projects match the current filters.
        </div>
      )}

      {/* Main project grid */}
      <div className="space-y-6">
        {hierarchy === "blocks" ? (
          <BlocksProjectView root={folderTree} path={blockPath} onPathChange={setBlockPath} {...sharedCardProps} />
        ) : hierarchy === "tree" ? (
          <FolderTreeView
            node={folderTree} depth={0} viewMode={viewMode} collapsed={collapsedFolders}
            onToggleFolder={toggleFolder} {...sharedCardProps}
            selected={selected} setSelected={setSelected} opening={opening}
            openLegacy={openLegacy} launchAll={launchAll} launchItem={launchItem}
            openAddItem={openAddItem} removeItem={removeItem} setDefaultProvider={setDefaultProvider}
            busyItem={busyItem} launchingAll={launchingAll}
          />
        ) : viewMode === "cards" ? (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
            {filtered.map((p) => (
              <ProjectCard key={p.id} p={p} stats={stats[p.id] ?? null}
                onOpenWorkspace={() => openInWorkspace(p.id, p.name ?? p.id)}
                onOpenFolder={() => void cardOpenFolder(p)}
                onOpenIde={() => void cardOpenIde(p)}
                onOpenAi={() => void cardOpenAi(p)}
                onEdit={() => startEdit(p)}
                onDelete={() => setPendingDelete(p)}
              />
            ))}
            {/* In-grid CTA tile */}
            <button type="button" onClick={wizardOpen ? closeWizard : openWizard}
              className="flex min-h-[140px] flex-col items-center justify-center gap-1.5 rounded transition-colors"
              style={{ background: "var(--color-surface-2)", color: "var(--color-text-secondary)", border: "1px dashed var(--color-border-strong)" }}
              title="Create a new project (wizard)"
            >
              <span className="text-[22px] font-light leading-none" style={{ color: "var(--color-accent)" }}>+</span>
              <span className="text-[12px] font-medium">New project</span>
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((p) => (
              <ProjectRow key={p.id} p={p}
                selected={selected === p.id} onClick={() => setSelected(p.id)}
                onOpen={() => openLegacy(p.id)} opening={opening === p.id}
                onEdit={() => startEdit(p)} onDelete={() => setPendingDelete(p)}
                onLaunchAll={() => launchAll(p.id)}
                onLaunchItem={(i) => launchItem(p.id, i)}
                onAddItem={() => openAddItem(p)}
                onRemoveItem={(i) => removeItem(p.id, i)}
                onSetDefaultProvider={(prov) => setDefaultProvider(p.id, prov)}
                busyItem={busyItem[p.id] ?? null}
                launchingAll={!!launchingAll[p.id]}
              />
            ))}
          </div>
        )}
      </div>

      {/* Add-item modal */}
      {itemTarget && (
        <AddItemModal
          itemTarget={itemTarget} iKind={iKind} iPath={iPath} iCwd={iCwd}
          iArgs={iArgs} iLabel={iLabel} iProvider={iProvider}
          itemSaving={itemSaving} itemError={itemError}
          onClose={() => setItemTarget(null)} onSave={saveItem}
          onPickFile={pickItemFile} onPickFolder={pickItemFolder}
          setIKind={setIKind} setIPath={setIPath} setICwd={setICwd}
          setIArgs={setIArgs} setILabel={setILabel} setIProvider={setIProvider}
        />
      )}

      {/* Delete confirm modal */}
      {pendingDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-6"
          style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={() => !deleteBusy && setPendingDelete(null)}
        >
          <div className="w-full max-w-[420px] rounded p-5"
            style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-border-strong)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-[14px] font-semibold">Delete from registry</h3>
            <p className="mt-2 text-[12.5px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
              Remove <b>{pendingDelete.name ?? pendingDelete.id}</b> from projects.json?
              No files on disk are touched — only the registry entry is removed.
            </p>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button type="button" onClick={() => setPendingDelete(null)} disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px]"
                style={{ background: "transparent", color: "var(--color-text-tertiary)", border: "1px solid var(--color-border-strong)" }}
              >
                Cancel
              </button>
              <button type="button" onClick={confirmDelete} disabled={deleteBusy}
                className="rounded px-3 py-1.5 text-[12px] font-medium"
                style={{ background: "var(--color-danger)", color: "#fff" }}
              >
                {deleteBusy ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* OpenGL scaffolder modal */}
      <NewOpenGlProjectModal
        open={openglModalOpen}
        onClose={() => setOpenglModalOpen(false)}
        onCreated={(projectPath) => {
          setLastAction({ success: true, stdout: `OpenGL project created at ${projectPath}`, stderr: "", exit_code: 0 });
          void load();
        }}
      />
    </div>
  );
}

export default Projects;
