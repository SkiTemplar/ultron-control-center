// ULTRON Control Center — Sessions tab.
//
// v2.9.5 (P1 2026-05-27) — Redesign botones + buscador global + auto-tags.
//
// CAMBIOS respecto a v2.9.0:
//   - WorkspaceCard: eliminados "+Root" y "+Create Project" del pie de tarjeta.
//     Los 3 botones fijos son: New (Plus), Custom (Sliders), Send Context (Share2).
//     "Create Project" sube al header del grid como botón icono arriba-derecha.
//   - Header: buscador global "Search sessions by keyword..." que filtra por
//     short_title / preview / tags en TODAS las sesiones de TODOS los workspaces.
//   - Auto-tag: chips de tags debajo del título en cada card. Click en chip filtra.
//     Botón "Auto-tag all" en header (bulk via sessions_bulk_auto_tag).
//     Tags persisten en ~/.ultron/cockpit/sessions-tags.jsonl (carga en mount).
//
// Iconos: Plus (New), Sliders (Custom), Share2 (Send Context), Tag (auto-tag),
//         Search (buscador), RefreshCw, History, Plus (create project badge).

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ClaudeSession,
  SessionProvider,
  SpawnFlags,
  WorkspaceSummary,
} from "../types";
import { RefreshCw, Search } from "./projects/icons";
import { PROVIDERS, GROUP_THRESHOLD } from "./sessions/constants";
import { loadCwd, saveCwd, loadPresets, savePresets, deriveWorkspaceName } from "./sessions/utils";
import { LauncherModal } from "./sessions/LauncherModal";
import { WorkspacesSection } from "./sessions/WorkspacesSection";
import { AllSessionsList } from "./sessions/AllSessionsList";
import type { Presets } from "./sessions/types";

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function Sessions() {
  // --- provider / advanced state (model + cwd kept for flagsForProvider) ---
  const [model] = useState<string>(PROVIDERS["claude"].defaultModel);
  const [cwd] = useState<string>(() => loadCwd());
  const [error, setError] = useState<string | null>(null);
  const [presets] = useState<Presets>(() => loadPresets());
  const [history, setHistory] = useState<ClaudeSession[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspacesLoading, setWorkspacesLoading] = useState(false);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // --- global search (workspaces + sessions) ---
  const [search, setSearch] = useState("");

  // --- which workspace is currently being turned into a project ---
  const [creatingProjectCwd, setCreatingProjectCwd] = useState<string | null>(
    null,
  );

  // --- modals ---
  const [busyCwd, setBusyCwd] = useState<string | null>(null);
  const [modal, setModal] = useState<
    | { mode: "custom"; ws: WorkspaceSummary }
    | { mode: "send-context"; ws: WorkspaceSummary }
    | null
  >(null);

  // --- grouped workspace open/close ---
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [toast]);

  useEffect(() => saveCwd(cwd), [cwd]);
  useEffect(() => savePresets(presets), [presets]);

  // ---------------------------------------------------------------------------
  // Data loaders
  // ---------------------------------------------------------------------------

  function reloadHistory() {
    setHistoryLoading(true);
    invoke<ClaudeSession[]>("list_claude_sessions", { limit: 200 })
      .then((list) => setHistory(list))
      .catch(() => setHistory([]))
      .finally(() => setHistoryLoading(false));
  }

  function reloadWorkspaces() {
    setWorkspacesLoading(true);
    invoke<WorkspaceSummary[]>("list_workspaces")
      .then((list) => setWorkspaces(list))
      .catch(() => setWorkspaces([]))
      .finally(() => setWorkspacesLoading(false));
  }

  useEffect(() => {
    reloadHistory();
    reloadWorkspaces();
  }, []);

  // ---------------------------------------------------------------------------
  // Create a project directly from a workspace (corner "+" on each session
  // card). No folder picker — el cwd del workspace ES la carpeta del proyecto.
  // ---------------------------------------------------------------------------

  async function createProjectFromWorkspace(ws: WorkspaceSummary) {
    if (ws.project_id) return; // ya es un proyecto
    setCreatingProjectCwd(ws.cwd);
    setError(null);
    try {
      const name = ws.project_name ?? deriveWorkspaceName(ws.cwd);
      await invoke("create_project", {
        name,
        path: ws.cwd,
        ide: null,
        language: null,
        tags: null,
        defaultProvider: null,
        defaultShell: null,
        parentFolderOverride: null,
        notes: null,
      });
      setToast(`Proyecto "${name}" creado`);
      reloadWorkspaces();
    } catch (e) {
      setError(String(e));
    } finally {
      setCreatingProjectCwd(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Search + filter logic
  // ---------------------------------------------------------------------------

  const normalisedSearch = search.trim().toLowerCase();

  /**
   * A workspace passes the filter when there's no search, or the text matches
   * its name / cwd / project_id, or any session preview under it.
   */
  const filteredWorkspaces = useMemo(() => {
    if (!normalisedSearch) return workspaces;

    return workspaces.filter((ws) => {
      const name = (
        ws.project_name ?? deriveWorkspaceName(ws.cwd)
      ).toLowerCase();
      const cwdMatch = ws.cwd.toLowerCase().includes(normalisedSearch);
      const nameMatch = name.includes(normalisedSearch);
      const projMatch = (ws.project_id ?? "")
        .toLowerCase()
        .includes(normalisedSearch);

      // Also search in session previews under this workspace.
      const norm = (s: string) =>
        s.replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
      const cwdNorm = norm(ws.cwd);
      const sessionMatch = history.some(
        (s) =>
          norm(s.project_label) === cwdNorm &&
          (s.preview ?? "").toLowerCase().includes(normalisedSearch),
      );

      return cwdMatch || nameMatch || projMatch || sessionMatch;
    });
  }, [workspaces, normalisedSearch, history]);

  // Group logic (same as before)
  const grouped = useMemo(() => {
    const groups = new Map<string, { label: string; items: WorkspaceSummary[] }>();
    for (const ws of filteredWorkspaces) {
      let key: string;
      let label: string;
      if (ws.project_id) {
        const head = ws.project_id.split(/[-_]/, 1)[0] ?? ws.project_id;
        key = `project:${head}`;
        label = head;
      } else {
        const cleaned = ws.cwd.replace(/[\\/]+$/, "");
        const parts = cleaned.split(/[\\/]/).filter(Boolean);
        const tail = parts[parts.length - 2] ?? parts[parts.length - 1] ?? ws.cwd;
        key = `cwd:${tail.toLowerCase()}`;
        label = tail;
      }
      const entry = groups.get(key) ?? { label, items: [] };
      entry.items.push(ws);
      groups.set(key, entry);
    }
    const ungrouped: WorkspaceSummary[] = [];
    const collapsible: { key: string; label: string; items: WorkspaceSummary[] }[] = [];
    for (const [key, value] of groups) {
      if (value.items.length > GROUP_THRESHOLD) {
        collapsible.push({ key, label: value.label, items: value.items });
      } else {
        ungrouped.push(...value.items);
      }
    }
    return { ungrouped, collapsible };
  }, [filteredWorkspaces]);

  // All-sessions list filter
  const filteredHistory = useMemo(() => {
    if (!normalisedSearch) return history;
    return history.filter((s) => {
      const inLabel = s.project_label.toLowerCase().includes(normalisedSearch);
      const inId = s.id.toLowerCase().includes(normalisedSearch);
      const inPreview = (s.preview ?? "").toLowerCase().includes(normalisedSearch);
      return inLabel || inId || inPreview;
    });
  }, [history, normalisedSearch]);

  // ---------------------------------------------------------------------------
  // Workspace actions
  // ---------------------------------------------------------------------------

  function flagsForProvider(extra: Partial<SpawnFlags> = {}): SpawnFlags {
    return {
      dangerouslySkipPermissions: presets.dangerouslySkipPermissions,
      effort: presets.effort ? presets.effort : null,
      model: model || null,
      ...extra,
    };
  }

  async function newInWorkspace(ws: WorkspaceSummary) {
    setBusyCwd(ws.cwd);
    setError(null);
    try {
      await invoke("spawn_session", {
        provider: "claude",
        prompt: null,
        cwd: ws.cwd,
        flags: {},
      });
      setToast(`New session in ${deriveWorkspaceName(ws.cwd)}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyCwd(null);
    }
  }

  async function customInWorkspace(
    ws: WorkspaceSummary,
    opts: { provider: SessionProvider; model: string },
  ) {
    setBusyCwd(ws.cwd);
    setError(null);
    try {
      await invoke("spawn_session", {
        provider: opts.provider,
        prompt: null,
        cwd: ws.cwd,
        flags: { model: opts.model || null },
      });
      const modelLabel = opts.model ? ` (${opts.model})` : "";
      setToast(
        `${opts.provider}${modelLabel} session in ${deriveWorkspaceName(ws.cwd)}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyCwd(null);
    }
  }

  async function sendContextFromWorkspace(
    ws: WorkspaceSummary,
    opts: { provider: SessionProvider; model: string },
  ) {
    if (!ws.latest_session_id) return;
    setBusyCwd(ws.cwd);
    setError(null);
    try {
      const seed = [
        `Continuing context from session: ${ws.latest_session_id}.`,
        `Workspace: ${ws.cwd}.`,
        `Please load the prior transcript (look under ~/.claude/projects/) and continue from where it left off.`,
      ].join(" ");
      await invoke("spawn_session", {
        provider: opts.provider,
        prompt: seed,
        cwd: ws.cwd,
        flags: { model: opts.model || null },
      });
      const modelLabel = opts.model ? ` (${opts.model})` : "";
      setToast(
        `Sent context to new ${opts.provider}${modelLabel} session in ${deriveWorkspaceName(ws.cwd)}`,
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyCwd(null);
    }
  }

  async function resumeSession(s: ClaudeSession) {
    setError(null);
    try {
      await invoke("spawn_session", {
        provider: "claude",
        prompt: null,
        cwd: s.project_label,
        flags: flagsForProvider({ resumeId: s.id }),
      });
    } catch (e) {
      setError(String(e));
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="px-10 py-8">
      {/* -------------------------------------------------------------------- */}
      {/* Header                                                                 */}
      {/* -------------------------------------------------------------------- */}
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold leading-tight">
            Workspaces &amp; sessions
          </h1>
          <p
            className="mt-1 text-[13px]"
            style={{ color: "var(--color-text-secondary)" }}
          >
            Pick a recent workspace to start a fresh Claude session.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Global search */}
          <div className="relative">
            <Search
              size={13}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
              // inline style via parent span — icon is inside the input
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions by keyword..."
              className="rounded pl-8 pr-3 py-1.5 text-[12px]"
              style={{
                background: "var(--color-surface-2)",
                color: "var(--color-text)",
                border: "1px solid var(--color-border-strong)",
                outline: "none",
                width: 260,
              }}
            />
          </div>

          {/* Refresh */}
          <button
            type="button"
            onClick={() => {
              reloadWorkspaces();
              reloadHistory();
            }}
            className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-[11.5px] transition-colors"
            style={{
              background: "var(--color-surface-2)",
              color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)",
            }}
            title="Refresh workspaces and session list"
          >
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>
      </header>

      {/* Toast */}
      {toast && (
        <div
          className="fixed bottom-6 right-6 z-[80] rounded px-3 py-2 text-[12px] shadow-lg"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
        >
          {toast}
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          className="mb-4 rounded px-3 py-2 text-[12px]"
          style={{
            background: "rgba(248, 81, 73, 0.08)",
            border: "1px solid rgba(248, 81, 73, 0.32)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* -------------------------------------------------------------------- */}
      {/* Section 1 — Recent workspaces                                         */}
      {/* -------------------------------------------------------------------- */}
      <WorkspacesSection
        workspacesLoading={workspacesLoading}
        workspaces={workspaces}
        filteredWorkspaces={filteredWorkspaces}
        search={search}
        ungrouped={grouped.ungrouped}
        collapsible={grouped.collapsible}
        openGroups={openGroups}
        busyCwd={busyCwd}
        creatingProjectCwd={creatingProjectCwd}
        onToggleGroup={(key) => {
          setOpenGroups((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
          });
        }}
        onNew={newInWorkspace}
        onCustom={(w) => setModal({ mode: "custom", ws: w })}
        onSendContext={(w) => setModal({ mode: "send-context", ws: w })}
        onCreateProject={createProjectFromWorkspace}
      />

      {/* -------------------------------------------------------------------- */}
      {/* Section 2 — All Claude sessions (power-user resume list)              */}
      {/* -------------------------------------------------------------------- */}
      <AllSessionsList
        history={history}
        filteredHistory={filteredHistory}
        historyLoading={historyLoading}
        showAllSessions={showAllSessions}
        search={search}
        onToggle={() => setShowAllSessions(!showAllSessions)}
        onResume={resumeSession}
      />

      {/* -------------------------------------------------------------------- */}
      {/* Launcher modal (Custom / Send Context)                                */}
      {/* -------------------------------------------------------------------- */}
      {modal && (
        <LauncherModal
          mode={modal.mode}
          workspace={modal.ws}
          busy={busyCwd === modal.ws.cwd}
          onClose={() => setModal(null)}
          onLaunch={(opts) => {
            const ws = modal.ws;
            const m = modal.mode;
            setModal(null);
            if (m === "custom") {
              void customInWorkspace(ws, opts);
            } else {
              void sendContextFromWorkspace(ws, opts);
            }
          }}
        />
      )}
    </div>
  );
}
