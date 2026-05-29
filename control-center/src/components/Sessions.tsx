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
import {
  History,
  Loader,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Sliders,
} from "./projects/icons";

// ---------------------------------------------------------------------------
// Presets — persisted across launches
// ---------------------------------------------------------------------------

const PRESETS_KEY = "ultron.cc.session_presets.v1";

type Presets = {
  dangerouslySkipPermissions: boolean;
  effort: "" | "low" | "medium" | "high" | "xhigh" | "max";
};

const DEFAULT_PRESETS: Presets = {
  dangerouslySkipPermissions: false,
  effort: "",
};

function loadPresets(): Presets {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    if (!raw) return DEFAULT_PRESETS;
    const p = JSON.parse(raw) as Partial<Presets>;
    return { ...DEFAULT_PRESETS, ...p };
  } catch {
    return DEFAULT_PRESETS;
  }
}
function savePresets(p: Presets) {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(p));
  } catch {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRel(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function deriveWorkspaceName(cwd: string): string {
  const cleaned = cwd.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  if (idx < 0) return cleaned || cwd;
  const tail = cleaned.slice(idx + 1);
  return tail || cleaned;
}

// ---------------------------------------------------------------------------
// Provider catalogue
// ---------------------------------------------------------------------------

type ProviderMeta = {
  label: string;
  accent: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  acceptsModel: boolean;
};

const PROVIDERS: Record<SessionProvider, ProviderMeta> = {
  claude: {
    label: "Claude",
    accent: "var(--color-success)",
    acceptsModel: true,
    models: [
      { id: "", label: "default (account current)" },
      { id: "claude-opus-4-7", label: "Opus 4.7 · best quality" },
      { id: "claude-sonnet-4-6", label: "Sonnet 4.6 · balanced" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 · fast" },
    ],
    defaultModel: "",
  },
  gemini: {
    label: "Gemini",
    accent: "var(--color-warn)",
    acceptsModel: true,
    models: [
      { id: "gemini-3.1-pro-preview", label: "3.1 Pro · best quality" },
      { id: "gemini-3.1-flash-lite", label: "3.1 Flash Lite · fast" },
      { id: "gemini-2.5-pro", label: "2.5 Pro · stable" },
      { id: "gemini-2.5-flash", label: "2.5 Flash · stable fast" },
    ],
    defaultModel: "gemini-3.1-pro-preview",
  },
  codex: {
    label: "Codex",
    accent: "#a875ff",
    acceptsModel: true,
    models: [
      { id: "", label: "default (gpt-5.5)" },
      { id: "gpt-5.5", label: "gpt-5.5" },
      { id: "gpt-5.5-thinking", label: "gpt-5.5 thinking" },
    ],
    defaultModel: "",
  },
};

// ---------------------------------------------------------------------------
// Workspace picker — modal-level CWD selector (Advanced launch only)
// ---------------------------------------------------------------------------

const WORKSPACE_KEY = "ultron.cc.session.cwd.v1";

function loadCwd(): string {
  try {
    return localStorage.getItem(WORKSPACE_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveCwd(v: string) {
  try {
    if (v) localStorage.setItem(WORKSPACE_KEY, v);
    else localStorage.removeItem(WORKSPACE_KEY);
  } catch {}
}

// ---------------------------------------------------------------------------
// Provider/model picker modal — shared by Custom and Send-Context flows
// ---------------------------------------------------------------------------

type LauncherModalProps = {
  mode: "custom" | "send-context";
  workspace: WorkspaceSummary;
  busy: boolean;
  onClose: () => void;
  onLaunch: (opts: { provider: SessionProvider; model: string }) => void;
};

function LauncherModal({
  mode,
  workspace,
  busy,
  onClose,
  onLaunch,
}: LauncherModalProps) {
  const [provider, setProvider] = useState<SessionProvider>("claude");
  const [model, setModel] = useState<string>(PROVIDERS.claude.defaultModel);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const headline = workspace.project_name ?? deriveWorkspaceName(workspace.cwd);
  const title =
    mode === "custom" ? "Custom launch" : "Send context to a new session";
  const launchLabel =
    mode === "custom" ? "Launch" : "Launch with context";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="flex w-full max-w-xl flex-col rounded-lg shadow-xl"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border-strong)",
        }}
      >
        <div
          className="flex items-center justify-between border-b px-4 py-2.5"
          style={{ borderColor: "var(--color-border)" }}
        >
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">{title}</div>
            <div
              className="mt-0.5 truncate text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
              title={workspace.cwd}
            >
              {headline}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-0.5 text-[12px]"
            style={{ color: "var(--color-text-tertiary)" }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-4">
          {mode === "send-context" && (
            <div
              className="mb-3 rounded p-2.5 text-[11.5px] leading-relaxed"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-secondary)",
              }}
            >
              Spawns a new session seeded with a reference to{" "}
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  color: "var(--color-text)",
                }}
              >
                {workspace.latest_session_id?.slice(0, 8) ?? "—"}
              </span>
              . The new session will receive a prompt asking it to load and
              continue context from that session.
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2 text-[12px]">
              <span style={{ color: "var(--color-text-tertiary)" }}>Provider</span>
              <select
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as SessionProvider;
                  setProvider(p);
                  setModel(PROVIDERS[p].defaultModel);
                }}
                className="rounded px-2 py-1 text-[12px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
                <option value="gemini">Gemini</option>
              </select>
            </div>
            <div className="flex items-center gap-2 text-[12px]">
              <span style={{ color: "var(--color-text-tertiary)" }}>Model</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="rounded px-2 py-1 text-[12px]"
                style={{
                  background: "var(--color-surface-2)",
                  color: "var(--color-text)",
                  border: "1px solid var(--color-border-strong)",
                }}
              >
                {PROVIDERS[provider].models.map((m) => (
                  <option key={m.id || "default"} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div
          className="flex items-center justify-end gap-2 border-t px-4 py-2.5"
          style={{ borderColor: "var(--color-border)" }}
        >
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1 text-[11.5px]"
            style={{
              background: "transparent",
              color: "var(--color-text-tertiary)",
              border: "1px solid var(--color-border)",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onLaunch({ provider, model })}
            disabled={busy}
            className="rounded px-3 py-1 text-[11.5px] font-medium disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-accent-text)",
            }}
          >
            {launchLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workspace card — 3 fixed buttons + corner "Create project" (only when the
// workspace isn't a registered project yet)
// ---------------------------------------------------------------------------

type WorkspaceCardProps = {
  ws: WorkspaceSummary;
  busy: boolean;
  onNew: (ws: WorkspaceSummary) => void;
  onCustom: (ws: WorkspaceSummary) => void;
  onSendContext: (ws: WorkspaceSummary) => void;
  onCreateProject: (ws: WorkspaceSummary) => void;
  creatingProject: boolean;
};

function WorkspaceCard({
  ws,
  busy,
  onNew,
  onCustom,
  onSendContext,
  onCreateProject,
  creatingProject,
}: WorkspaceCardProps) {
  const headline = ws.project_name ?? deriveWorkspaceName(ws.cwd);
  const canSendContext = !!ws.latest_session_id;
  // Botón "+" de crear-proyecto en la esquina, SOLO cuando este workspace no
  // corresponde aún a un proyecto registrado (ws.project_id vacío).
  const canCreateProject = !ws.project_id;

  return (
    <div
      className="flex h-full flex-col rounded-lg p-4 transition-colors"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
      }}
    >
      {/* Header row */}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3
              className="truncate text-[15px] font-semibold leading-tight"
              style={{ color: "var(--color-text)" }}
              title={headline}
            >
              {headline}
            </h3>
          </div>
          {/* Badges */}
          <div className="flex shrink-0 items-center gap-1">
            <span
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
              style={{
                background: "var(--color-surface-3)",
                color: "var(--color-text-tertiary)",
                border: "1px solid var(--color-border)",
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: PROVIDERS.claude.accent }}
              />
              claude
            </span>
            {ws.project_id ? (
              <span
                className="rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border)",
                }}
                title={ws.project_name ?? ws.project_id}
              >
                {ws.project_name ?? "project"}
              </span>
            ) : (
              // Esquina: crear proyecto desde esta sesión (solo si no existe ya).
              <button
                type="button"
                onClick={() => onCreateProject(ws)}
                disabled={creatingProject || !canCreateProject}
                className="inline-flex h-6 w-6 items-center justify-center rounded transition-colors disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  color: "var(--color-text-tertiary)",
                  border: "1px solid var(--color-border-strong)",
                }}
                title="Crear un proyecto a partir de esta sesión"
                aria-label="Crear proyecto desde esta sesión"
              >
                {creatingProject ? <Loader size={11} /> : <Plus size={12} />}
              </button>
            )}
          </div>
        </div>

        {/* cwd monospace line */}
        <div
          className="mt-1 truncate text-[11px]"
          style={{
            fontFamily: "var(--font-mono)",
            color: "var(--color-text-faint)",
          }}
          title={ws.cwd}
        >
          {ws.cwd}
        </div>

        {/* Meta row */}
        <div
          className="mt-2 flex items-center gap-3 text-[10.5px] tabular-nums"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          <span>{formatRel(ws.last_activity)}</span>
          <span>·</span>
          <span>
            {ws.session_count} session{ws.session_count === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      {/* Action row — exactly 3 fixed buttons */}
      <div className="mt-3 flex items-center gap-1.5">
        {/* New */}
        <button
          type="button"
          onClick={() => onNew(ws)}
          disabled={busy}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-accent)",
            color: "var(--color-accent-text)",
          }}
          title={`New Claude session in ${ws.cwd}`}
        >
          <Plus size={12} />
          New
        </button>

        {/* Custom */}
        <button
          type="button"
          onClick={() => onCustom(ws)}
          disabled={busy}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title="Custom launch — choose provider and model"
        >
          <Sliders size={11} />
          Custom
        </button>

        {/* Send Context */}
        <button
          type="button"
          onClick={() => onSendContext(ws)}
          disabled={busy || !canSendContext}
          className="inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2.5 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-40 whitespace-nowrap"
          style={{
            background: "var(--color-surface-3)",
            color: "var(--color-text)",
            border: "1px solid var(--color-border-strong)",
          }}
          title={
            canSendContext
              ? "Start a new session seeded with context from the latest session"
              : "No prior session to send context from"
          }
        >
          <Share2 size={11} />
          Send ctx
        </button>
      </div>
    </div>
  );
}

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
  const GROUP_THRESHOLD = 5;
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
      <section className="mb-6">
        {/* Section header row: title + count + Create Project button */}
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[14px] font-semibold leading-tight">
              Recent workspaces
            </h2>
            <span
              className="text-[11.5px]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {workspacesLoading
                ? "Loading…"
                : `${filteredWorkspaces.length} of ${workspaces.length}`}
            </span>
          </div>
          {/* El botón de crear proyecto ya no vive aquí: cada session card sin
              proyecto tiene su propio "+" en la esquina (onCreateProject). */}
        </div>

        {!workspacesLoading && workspaces.length === 0 && (
          <div
            className="rounded p-6 text-center text-[12.5px]"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
              color: "var(--color-text-tertiary)",
            }}
          >
            No Claude workspaces yet. Open a Claude session in any folder and
            it will appear here automatically.
          </div>
        )}

        {!workspacesLoading &&
          workspaces.length > 0 &&
          filteredWorkspaces.length === 0 && (
            <div
              className="rounded p-6 text-center text-[12.5px]"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text-tertiary)",
              }}
            >
              No workspace matches "{search}".
            </div>
          )}

        {/* Ungrouped cards */}
        {grouped.ungrouped.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {grouped.ungrouped.map((ws) => (
              <WorkspaceCard
                key={ws.cwd}
                ws={ws}
                busy={busyCwd === ws.cwd}
                onNew={newInWorkspace}
                onCustom={(w) => setModal({ mode: "custom", ws: w })}
                onSendContext={(w) => setModal({ mode: "send-context", ws: w })}
                onCreateProject={createProjectFromWorkspace}
                creatingProject={creatingProjectCwd === ws.cwd}
              />
            ))}
          </div>
        )}

        {/* Collapsible groups */}
        {grouped.collapsible.map((g) => {
          const isOpen = openGroups.has(g.key);
          return (
            <div key={g.key} className="mt-4">
              <button
                type="button"
                onClick={() => {
                  setOpenGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(g.key)) next.delete(g.key);
                    else next.add(g.key);
                    return next;
                  });
                }}
                aria-expanded={isOpen}
                aria-label={`${isOpen ? "Collapse" : "Expand"} ${g.label} workspaces group`}
                className="flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
                style={{
                  background: "var(--color-surface-2)",
                  border: "1px solid var(--color-border)",
                }}
              >
                <span
                  className="inline-block text-[12px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {isOpen ? "▾" : "▸"}
                </span>
                <span className="text-[12.5px] font-semibold">{g.label}</span>
                <span
                  className="text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {g.items.length} workspaces
                </span>
                <span
                  className="ml-auto text-[11.5px]"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  {isOpen ? "hide" : "show"}
                </span>
              </button>
              {isOpen && (
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {g.items.map((ws) => (
                    <WorkspaceCard
                      key={ws.cwd}
                      ws={ws}
                      busy={busyCwd === ws.cwd}
                      onNew={newInWorkspace}
                      onCustom={(w) => setModal({ mode: "custom", ws: w })}
                      onSendContext={(w) =>
                        setModal({ mode: "send-context", ws: w })
                      }
                      onCreateProject={createProjectFromWorkspace}
                      creatingProject={creatingProjectCwd === ws.cwd}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {/* -------------------------------------------------------------------- */}
      {/* Section 2 — All Claude sessions (power-user resume list)              */}
      {/* -------------------------------------------------------------------- */}
      <section className="mb-6">
        <button
          type="button"
          onClick={() => setShowAllSessions(!showAllSessions)}
          className="flex w-full items-center gap-2 rounded px-3 py-2 text-left transition-colors"
          style={{
            background: "var(--color-surface-2)",
            border: "1px solid var(--color-border)",
          }}
        >
          <History size={13} />
          <span className="text-[12.5px] font-semibold">
            All Claude sessions
          </span>
          <span
            className="text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {historyLoading
              ? "loading…"
              : `${filteredHistory.length} of ${history.length}`}
          </span>
          <span
            className="ml-auto text-[11.5px]"
            style={{ color: "var(--color-text-tertiary)" }}
          >
            {showAllSessions ? "hide" : "show"}
          </span>
        </button>

        {showAllSessions && (
          <div
            className="mt-2 rounded p-4"
            style={{
              background: "var(--color-surface-2)",
              border: "1px solid var(--color-border)",
            }}
          >
            {!historyLoading && filteredHistory.length === 0 && (
              <div
                className="rounded p-4 text-center text-[12px]"
                style={{
                  background: "var(--color-surface-1)",
                  border: "1px solid var(--color-border)",
                  color: "var(--color-text-tertiary)",
                }}
              >
                {history.length === 0
                  ? "No sessions recorded yet."
                  : `No session matches "${search}".`}
              </div>
            )}
            <div className="space-y-1.5">
              {filteredHistory.map((s) => {
                return (
                  <div
                    key={`${s.project_slug}-${s.id}`}
                    className="rounded p-3 transition-colors"
                    style={{
                      background: "var(--color-surface-1)",
                      border: "1px solid var(--color-border)",
                    }}
                  >
                    <div className="flex items-baseline gap-3">
                      <span
                        className="truncate text-[11.5px]"
                        style={{
                          fontFamily: "var(--font-mono)",
                          color: "var(--color-text-tertiary)",
                        }}
                        title={s.project_label}
                      >
                        {s.project_label}
                      </span>
                      <span
                        className="ml-auto shrink-0 tabular-nums text-[10.5px]"
                        style={{ color: "var(--color-text-faint)" }}
                      >
                        {formatRel(s.last_activity)} · {s.line_count} turns ·{" "}
                        {formatBytes(s.size_bytes)}
                      </span>
                      <button
                        type="button"
                        onClick={() => resumeSession(s)}
                        className="shrink-0 rounded px-2 py-0.5 text-[11.5px] font-medium transition-colors"
                        style={{
                          background: "var(--color-accent)",
                          color: "var(--color-accent-text)",
                        }}
                        title={`claude -r ${s.id}`}
                      >
                        Resume
                      </button>
                    </div>
                    {s.preview && (
                      <div
                        className="mt-1 line-clamp-2 text-[12px] leading-relaxed"
                        style={{ color: "var(--color-text-secondary)" }}
                      >
                        {s.preview}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

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
