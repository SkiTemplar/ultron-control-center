// ULTRON Control Center 2.9.5 — Agents viewer (aligned with Skills/Rules UI).
//
// Brings Agents to full parity with the Skills and Rules layout:
//   - Same 2-pane layout: category sidebar chips + content grid + LibraryDetailPane.
//   - Same 140px tall cards with violet inset ribbon (Bot accent) + selected state.
//   - Same header/search bar structure as Skills.tsx.
//   - Active/Disabled/All tab strip (already present, kept).
//   - Scope chips (already present, kept).
//   - Category pills row (same shape as Rules.tsx, now always visible in grid/tree modes).
//   - LibraryDetailPane wired for the selected agent (edit + AI + open externally).
//   - Recent delegations strip preserved below the filter controls.
//   - Color: violet — rgba(167, 139, 250, …) consistent with LibraryDetailPane agent accent.
//
// FIX (2026-05-30): Botón "Asignar tarea" conectado a delegate_task_launch.
//   - Modal con selector de agente + textarea de instrucción + checkbox modelo económico.
//   - Strip de runs recientes conectado a list_delegations (polling 30s + evento workflow:delegated).

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openPath } from "@tauri-apps/plugin-opener";
import type { AgentEntry, RemoteItem, SkillOrigin } from "../types";
import { SearchGitHubModal } from "./library/SearchGitHubModal";
import { InstallConfirmModal } from "./library/InstallConfirmModal";
import { CreateAgentModal } from "./library/CreateAgentModal";
import { Bot, Github, Plus } from "./library/icons";
import { TreeView, type TreeOrigin } from "./library/TreeView";
import { BlocksView, type BlocksItem } from "./library/BlocksView";
import { ViewToggle, useLibraryViewMode } from "./library/ViewToggle";
import { LibraryDetailPane } from "./library/LibraryDetailPane";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProjectLite = { id: string; name: string };

type ScopeFilter = "all" | SkillOrigin;

type EnableFilter = "active" | "disabled" | "all";

type DelegationLogEntry = {
  id: string;
  agent: string;
  task_preview: string;
  cwd: string | null;
  used_cheap_model: boolean;
  started_at: string;
  status: string;
  session_id: string | null;
};

// Shape de DelegateRequest que espera el backend (delegate_task_launch).
type DelegateRequest = {
  agent: string;
  task: string;
  use_cheap_model: boolean;
  cwd: string | null;
  workday_id: string | null;
  timeout_secs: number | null;
  project_id: string | null;
};

// ---------------------------------------------------------------------------
// Subcomponente: Modal "Asignar tarea a agente"
// ---------------------------------------------------------------------------

interface AssignTaskModalProps {
  agents: AgentEntry[];
  preselectedAgent: string | null;
  onClose: () => void;
  onLaunched: () => void;
}

function AssignTaskModal({ agents, preselectedAgent, onClose, onLaunched }: AssignTaskModalProps) {
  const [selectedAgent, setSelectedAgent] = useState<string>(preselectedAgent ?? "");
  const [task, setTask] = useState("");
  const [useCheap, setUseCheap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Autofocus en textarea al montar.
  useEffect(() => {
    const t = setTimeout(() => textareaRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  // Esc cierra.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const activeAgents = agents.filter((a) => a.enabled && a.origin === "global");
  const allAgents = agents.filter((a) => a.origin === "global");
  const agentOptions = activeAgents.length > 0 ? activeAgents : allAgents;

  async function handleSubmit() {
    if (busy) return;
    const agentTrimmed = selectedAgent.trim();
    const taskTrimmed = task.trim();
    if (!agentTrimmed) { setLocalError("Selecciona un agente."); return; }
    if (!taskTrimmed) { setLocalError("La instrucción no puede estar vacía."); return; }
    if (taskTrimmed.length > 16_000) { setLocalError("La instrucción supera 16 000 caracteres."); return; }
    setBusy(true);
    setLocalError(null);
    try {
      const req: DelegateRequest = {
        agent: agentTrimmed,
        task: taskTrimmed,
        use_cheap_model: useCheap,
        cwd: null,
        workday_id: null,
        timeout_secs: null,
        project_id: null,
      };
      await invoke("delegate_task_launch", { request: req });
      onLaunched();
      onClose();
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Asignar tarea a agente"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: "min(36rem, 94vw)",
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border-strong)",
          borderRadius: 8,
          boxShadow: "0 12px 40px rgba(0,0,0,0.65)",
          padding: 20,
          color: "var(--color-text)",
          fontFamily: "var(--font-sans)",
        }}
      >
        {/* Cabecera */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 16 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>Asignar tarea a agente</span>
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: 16, lineHeight: 1, background: "transparent",
              border: "none", color: "var(--color-text-tertiary)", cursor: "pointer", padding: "0 2px",
            }}
            aria-label="Cerrar"
          >
            ×
          </button>
        </div>

        {/* Selector de agente */}
        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ display: "block", fontSize: 11.5, color: "var(--color-text-secondary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Agente
          </span>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            disabled={busy}
            style={{
              width: "100%", padding: "6px 8px", fontSize: 13,
              background: "var(--color-surface-1)", color: "var(--color-text)",
              border: "1px solid var(--color-border-strong)", borderRadius: 4, outline: "none",
            }}
          >
            <option value="">-- Elige un agente --</option>
            {agentOptions.map((a) => (
              <option key={a.path} value={a.name}>{a.name}</option>
            ))}
          </select>
        </label>

        {/* Instrucción */}
        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ display: "block", fontSize: 11.5, color: "var(--color-text-secondary)", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.06em" }}>
            Instrucción
          </span>
          <textarea
            ref={textareaRef}
            value={task}
            onChange={(e) => setTask(e.target.value)}
            disabled={busy}
            rows={6}
            placeholder="Describe la tarea que debe ejecutar el agente…"
            style={{
              width: "100%", resize: "vertical",
              background: "var(--color-surface-1)", color: "var(--color-text)",
              border: "1px solid var(--color-border)", borderRadius: 4,
              padding: 8, fontSize: 12.5, fontFamily: "var(--font-mono)",
              lineHeight: 1.5, outline: "none", boxSizing: "border-box",
            }}
          />
          <div style={{ fontSize: 10.5, color: task.length > 15_000 ? "var(--color-danger)" : "var(--color-text-faint)", marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
            {task.length} / 16 000
          </div>
        </label>

        {/* Modelo económico */}
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, cursor: "pointer", fontSize: 12.5 }}>
          <input
            type="checkbox"
            checked={useCheap}
            onChange={(e) => setUseCheap(e.target.checked)}
            disabled={busy}
            style={{ accentColor: "var(--color-accent)", width: 14, height: 14 }}
          />
          <span style={{ color: "var(--color-text-secondary)" }}>
            Usar modelo económico (Haiku 4.5 — 3× más rápido, menor costo)
          </span>
        </label>

        {/* Error */}
        {localError && (
          <div style={{
            marginBottom: 12, padding: "7px 10px", fontSize: 11.5,
            background: "rgba(248,81,73,0.08)", border: "1px solid rgba(248,81,73,0.30)",
            color: "var(--color-danger)", borderRadius: 4,
          }}>
            {localError}
          </div>
        )}

        {/* Acciones */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            style={{
              fontSize: 12, padding: "5px 14px",
              background: "var(--color-surface-3)", color: "var(--color-text-secondary)",
              border: "1px solid var(--color-border-strong)", borderRadius: 4, cursor: "pointer",
            }}
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={busy || !selectedAgent || !task.trim()}
            style={{
              fontSize: 12, padding: "5px 14px", fontWeight: 500,
              background: "var(--color-accent)", color: "var(--color-accent-text)",
              border: "1px solid var(--color-accent)", borderRadius: 4,
              cursor: busy || !selectedAgent || !task.trim() ? "default" : "pointer",
              opacity: busy || !selectedAgent || !task.trim() ? 0.55 : 1,
            }}
          >
            {busy ? "Lanzando…" : "Asignar tarea"}
          </button>
        </div>

        <div style={{ marginTop: 10, fontSize: 10.5, color: "var(--color-text-faint)" }}>
          La sesión se abre en una ventana de terminal separada. Esc para cancelar.
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCOPES: { id: ScopeFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "global", label: "Global" },
  { id: "project", label: "Project" },
  { id: "plugin", label: "Plugin" },
];

const NO_CATEGORY = "uncategorized";

// Violet accent — consistent with LibraryDetailPane "agent" kind and icons.tsx Bot=violet.
const AGENT_ACCENT = "rgba(167, 139, 250, 0.55)";
const AGENT_ACCENT_SOFT = "rgba(167, 139, 250, 0.16)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Derive a category from the on-disk path. Examples:
///   ~/.claude/agents/sec/reviewer.md → "sec"
///   ~/.claude/agents/reviewer.md     → "uncategorized"
///   .../plugins/cache/<id>/<plugin>/<ver>/agents/foo.md → "<plugin>"
function deriveCategory(a: AgentEntry): string {
  const norm = a.path.replace(/\\/g, "/");
  if (a.origin === "plugin") {
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/agents\//);
    if (m && m[1]) return m[1];
  }
  const m = norm.match(/\/agents\/([^/]+)\/[^/]+\.md/);
  if (m && m[1]) return m[1];
  return NO_CATEGORY;
}

function deriveTopGroup(a: AgentEntry): string {
  if (a.origin === "global") return "Global";
  if (a.origin === "project") return "Project";
  return deriveCategory(a);
}

function deriveSubGroup(a: AgentEntry): string | null {
  const norm = a.path.replace(/\\/g, "/");
  if (a.origin === "plugin") {
    const m = norm.match(/\/agents\/([^/]+)\/[^/]+\.md/);
    if (m && m[1]) return m[1];
    return null;
  }
  const cat = deriveCategory(a);
  if (cat === NO_CATEGORY) return null;
  return cat;
}

/// Workspace folder + primary file for the detail pane. For agents there is
/// no multi-file "workspace" concept (unlike SKILL.md folders) so we simply
/// open the parent directory alongside the .md file.
function agentWorkspace(a: AgentEntry): { folder: string; file: string } {
  const file = a.path;
  const lastSep = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return {
    folder: lastSep > 0 ? file.slice(0, lastSep) : "",
    file,
  };
}

function diceBearUrl(slug: string): string {
  const seed = encodeURIComponent(slug || "agent");
  return `https://api.dicebear.com/7.x/bottts/svg?seed=${seed}&backgroundColor=1a1a2e,222238`;
}

function ageFromEpochField(s: string): string {
  const m = /^epoch:(\d+)$/.exec(s);
  if (!m) return s;
  const secs = parseInt(m[1], 10);
  if (!Number.isFinite(secs)) return s;
  const diff = Math.max(0, Date.now() / 1000 - secs);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusChip(status: string): { bg: string; fg: string; label: string } {
  if (status === "launched") {
    return { bg: "rgba(63, 185, 80, 0.14)", fg: "rgb(63, 185, 80)", label: "Launched" };
  }
  if (status === "failed") {
    return { bg: "rgba(248, 81, 73, 0.14)", fg: "rgb(248, 81, 73)", label: "Failed" };
  }
  return { bg: "rgba(125, 133, 144, 0.14)", fg: "rgb(125, 133, 144)", label: status };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Agents() {
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [enableFilter, setEnableFilter] = useState<EnableFilter>("active");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [installItem, setInstallItem] = useState<RemoteItem | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [view, setView] = useLibraryViewMode("agents");
  const [selected, setSelected] = useState<AgentEntry | null>(null);

  // Optimistic toggle — mirrors Skills.tsx per-row approach.
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(new Set());

  // Recent delegations.
  const [delegations, setDelegations] = useState<DelegationLogEntry[]>([]);
  const [showAllRuns, setShowAllRuns] = useState(false);

  // Modal "Asignar tarea".
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignPreselected, setAssignPreselected] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Data loading
  // -------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    async function loadDelegations() {
      try {
        const list = (await invoke("list_delegations", { limit: 50 })) as DelegationLogEntry[];
        if (!cancelled) setDelegations(list);
      } catch {
        if (!cancelled) setDelegations([]);
      }
    }
    void loadDelegations();
    const t = setInterval(loadDelegations, 30_000);
    let unlisten: (() => void) | null = null;
    void listen("workflow:delegated", () => {
      if (!cancelled) void loadDelegations();
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      clearInterval(t);
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    invoke<ProjectLite[]>("list_projects")
      .then((list) => setProjects(list.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setProjects([]));
  }, []);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke("list_agents", { projectPath: null })) as AgentEntry[];
      setAgents(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const categories = useMemo(() => {
    const subset = scope === "all" ? agents : agents.filter((a) => a.origin === scope);
    const set = new Set<string>();
    for (const a of subset) set.add(deriveCategory(a));
    return Array.from(set).sort((a, b) => {
      if (a === NO_CATEGORY) return 1;
      if (b === NO_CATEGORY) return -1;
      return a.localeCompare(b);
    });
  }, [agents, scope]);

  useEffect(() => {
    if (category !== "all" && !categories.includes(category)) setCategory("all");
  }, [categories, category]);

  const enableCounts = useMemo(() => {
    let active = 0;
    let disabled = 0;
    for (const a of agents) {
      if (scope !== "all" && a.origin !== scope) continue;
      if (a.enabled) active += 1;
      else disabled += 1;
    }
    return { active, disabled };
  }, [agents, scope]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return agents.filter((a) => {
      if (scope !== "all" && a.origin !== scope) return false;
      if (category !== "all" && deriveCategory(a) !== category) return false;
      if (enableFilter === "active" && !a.enabled) return false;
      if (enableFilter === "disabled" && a.enabled) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q)
      );
    });
  }, [agents, scope, category, enableFilter, query]);

  // -------------------------------------------------------------------------
  // Toggle (optimistic, mirrors Skills.tsx)
  // -------------------------------------------------------------------------

  const toggleAgent = async (a: AgentEntry) => {
    if (a.origin !== "global") return;
    if (toggleBusy.has(a.path)) return;
    const next = !a.enabled;
    const previousEnabled = a.enabled;
    setToggleBusy((prev) => new Set(prev).add(a.path));
    setAgents((prev) => prev.map((x) => (x.path === a.path ? { ...x, enabled: next } : x)));
    // Mirror selected pane state optimistically.
    if (selected?.path === a.path) setSelected((s) => (s ? { ...s, enabled: next } : s));
    try {
      const updated = (await invoke("agent_toggle", { name: a.name, enabled: next })) as AgentEntry;
      setAgents((prev) => prev.map((x) => (x.path === a.path ? updated : x)));
      if (selected?.path === a.path) setSelected(updated);
    } catch (e) {
      setAgents((prev) =>
        prev.map((x) => (x.path === a.path ? { ...x, enabled: previousEnabled } : x)),
      );
      if (selected?.path === a.path) setSelected((s) => (s ? { ...s, enabled: previousEnabled } : s));
      setError(`toggle ${a.name}: ${e}`);
    } finally {
      setToggleBusy((prev) => {
        const n = new Set(prev);
        n.delete(a.path);
        return n;
      });
    }
  };

  const handleOpen = async (path: string) => {
    try {
      await openPath(path);
    } catch (e) {
      setError(`open ${path}: ${e}`);
    }
  };

  // -------------------------------------------------------------------------
  // Tree / Blocks adapters
  // -------------------------------------------------------------------------

  const treeOrigins: TreeOrigin<AgentEntry>[] = useMemo(() => {
    const buckets: Record<SkillOrigin, Record<string, AgentEntry[]>> = {
      global: {},
      project: {},
      plugin: {},
    };
    for (const a of filtered) {
      const cat = deriveCategory(a);
      (buckets[a.origin][cat] ??= []).push(a);
    }
    return (["global", "project", "plugin"] as SkillOrigin[]).map((id) => ({
      id,
      label: id.charAt(0).toUpperCase() + id.slice(1),
      groups: Object.entries(buckets[id])
        .sort(([a], [b]) => {
          if (a === NO_CATEGORY) return 1;
          if (b === NO_CATEGORY) return -1;
          return a.localeCompare(b);
        })
        .map(([name, list]) => ({
          name,
          leaves: list.map((a) => ({
            key: `${a.origin}-${a.path}`,
            label: a.name,
            data: a,
          })),
        })),
    }));
  }, [filtered]);

  const blockItems: BlocksItem<AgentEntry>[] = useMemo(
    () =>
      filtered.map((a) => ({
        key: `${a.origin}-${a.path}`,
        topGroup: deriveTopGroup(a),
        subGroup: deriveSubGroup(a),
        data: a,
      })),
    [filtered],
  );

  // -------------------------------------------------------------------------
  // Card grid — same 140px tall card pattern as Skills/Rules, violet accent
  // -------------------------------------------------------------------------

  const renderCardGrid = (items: AgentEntry[]) => (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
    >
      {items.map((a) => {
        const isActive = selected?.path === a.path;
        const cat = deriveCategory(a);

        return (
          <button
            key={`${a.origin}-${a.path}`}
            type="button"
            onClick={() => setSelected(a)}
            className="group flex h-[140px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive ? "var(--color-surface-3)" : "var(--color-surface-2)",
              border: `1px solid ${isActive ? AGENT_ACCENT : "var(--color-border)"}`,
              boxShadow: `inset 0 3px 0 ${AGENT_ACCENT}`,
              opacity: a.enabled ? 1 : 0.55,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = AGENT_ACCENT;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${AGENT_ACCENT}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = isActive ? AGENT_ACCENT : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${AGENT_ACCENT}`;
            }}
            title={a.description || a.name}
          >
            {/* Header row: label chip + origin badge */}
            <div className="flex items-center justify-between gap-1.5">
              <div
                className="flex items-center gap-1 text-[10.5px] uppercase tracking-[0.08em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                <Bot size={12} />
                Agent
              </div>
              <span
                className="rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: AGENT_ACCENT_SOFT,
                  color: "#c4b5fd",
                  border: "1px solid rgba(167, 139, 250, 0.35)",
                }}
              >
                {cat !== NO_CATEGORY ? cat : a.origin}
              </span>
            </div>

            {/* Agent name */}
            <div
              className="line-clamp-3 text-[18px] font-semibold leading-tight tracking-tight"
              style={{ color: a.enabled ? "var(--color-text)" : "var(--color-text-secondary)" }}
            >
              {a.name}
            </div>

            {/* Footer: origin badge + disabled label */}
            <div className="flex items-center justify-between">
              <span
                className="rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: AGENT_ACCENT_SOFT,
                  color: "#c4b5fd",
                  border: "1px solid rgba(167, 139, 250, 0.35)",
                }}
              >
                {a.origin}
              </span>
              {!a.enabled && (
                <span
                  className="text-[9.5px] uppercase tracking-wide"
                  style={{ color: "var(--color-text-faint)" }}
                >
                  disabled
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Page header — mirrors Skills.tsx */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Agents</h2>
          <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            ~/.claude/agents/**/*.md · {filtered.length} of {agents.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle mode={view} onChange={setView} />
          <button
            onClick={() => setSearchOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          >
            <Github size={12} /> Search GitHub
          </button>
          <button
            onClick={() => { setAssignPreselected(selected?.name ?? null); setAssignOpen(true); }}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1 text-xs font-medium"
            style={{
              borderColor: "rgba(167, 139, 250, 0.55)",
              background: "rgba(167, 139, 250, 0.12)",
              color: "#c4b5fd",
            }}
          >
            <Bot size={12} /> Asignar tarea
          </button>
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            <Plus size={12} /> New agent
          </button>
          <button
            onClick={reload}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: "var(--color-border-strong)",
              background: "var(--color-surface-2)",
              color: "var(--color-text)",
            }}
          >
            Refresh
          </button>
        </div>
      </header>

      {/* Active / Disabled / All tabs — same pill style as Skills.tsx */}
      <div
        className="inline-flex items-center gap-1 self-start rounded-lg p-1"
        style={{
          background: "var(--color-surface-2)",
          border: "1px solid var(--color-border)",
        }}
      >
        {(
          [
            { id: "active" as const, label: "Active", count: enableCounts.active },
            { id: "disabled" as const, label: "Disabled", count: enableCounts.disabled },
            { id: "all" as const, label: "All", count: enableCounts.active + enableCounts.disabled },
          ] as const
        ).map((tab) => {
          const isActive = enableFilter === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setEnableFilter(tab.id)}
              className="flex items-center gap-1.5 rounded px-3 py-1 text-xs font-medium transition-colors"
              style={{
                background: isActive ? "var(--color-surface-4)" : "transparent",
                color: isActive ? "var(--color-text)" : "var(--color-text-secondary)",
                border: isActive ? "1px solid var(--color-border-strong)" : "1px solid transparent",
              }}
            >
              {tab.label}
              <span
                className="rounded-full px-1.5 py-px text-[10px] font-semibold tabular-nums"
                style={{
                  background: isActive ? AGENT_ACCENT_SOFT : "var(--color-surface-3)",
                  color: isActive ? "#c4b5fd" : "var(--color-text-tertiary)",
                }}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Scope chips + Category pills — same structure as Skills.tsx */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {SCOPES.map((s) => {
            const isActive = scope === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setScope(s.id)}
                className="rounded-full border px-3 py-1 text-xs transition-colors"
                style={{
                  borderColor: isActive ? "var(--color-accent)" : "var(--color-border-strong)",
                  background: isActive ? "var(--color-accent)" : "transparent",
                  color: isActive ? "var(--color-accent-text)" : "var(--color-text-secondary)",
                }}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {view !== "blocks" && categories.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="text-[10.5px] uppercase tracking-wide"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Category
            </span>
            <button
              onClick={() => setCategory("all")}
              className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
              style={{
                borderColor: category === "all" ? "var(--color-text)" : "var(--color-border-strong)",
                background: category === "all" ? "var(--color-surface-4)" : "transparent",
                color: category === "all" ? "var(--color-text)" : "var(--color-text-secondary)",
              }}
            >
              All
            </button>
            {categories.map((c) => {
              const active = c === category;
              return (
                <button
                  key={c}
                  onClick={() => setCategory(c)}
                  className="rounded-full border px-2.5 py-0.5 text-[11.5px] transition-colors"
                  style={{
                    borderColor: active ? "var(--color-text)" : "var(--color-border-strong)",
                    background: active ? "var(--color-surface-4)" : "transparent",
                    color: active ? "var(--color-text)" : "var(--color-text-secondary)",
                  }}
                >
                  {c}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Search bar — identical to Skills/Rules */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search agents by name or description…"
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
        }}
      />

      {/* Error banner */}
      {error && (
        <div
          className="rounded-md p-3 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </div>
      )}

      {/* 2-pane: list + detail — same structure as Skills.tsx */}
      <div className="flex flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
        <div
          className={selected ? "min-w-0 flex-1 overflow-y-auto" : "flex-1 overflow-y-auto"}
          style={{ minWidth: 0 }}
        >
          {loading ? (
            <p className="text-xs" style={{ color: "var(--color-text-tertiary)" }}>
              Loading…
            </p>
          ) : filtered.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center gap-2 rounded-xl py-12 text-center"
              style={{
                background: "var(--color-surface-2)",
                border: "1px solid var(--color-border)",
              }}
            >
              <p className="text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
                {enableFilter === "disabled"
                  ? "No disabled agents matching the current filters."
                  : enableFilter === "active"
                    ? "No active agents matching the current filters."
                    : "No agents found."}
              </p>
              {enableFilter !== "all" && (
                <button
                  onClick={() => setEnableFilter("all")}
                  className="text-xs underline-offset-2 hover:underline"
                  style={{ color: "var(--color-text-tertiary)" }}
                >
                  Show all
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Recent delegations strip — pinned above the grid */}
              {delegations.length > 0 && (
                <section className="mb-4">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span
                      className="text-[11px] uppercase tracking-wide"
                      style={{ color: "var(--color-text-tertiary)" }}
                    >
                      Recent runs ({delegations.length})
                    </span>
                    {delegations.length > 3 && (
                      <button
                        type="button"
                        onClick={() => setShowAllRuns((v) => !v)}
                        className="text-[11px]"
                        style={{ color: "var(--color-text-secondary)" }}
                      >
                        {showAllRuns ? "Show fewer" : `Show all ${delegations.length}`}
                      </button>
                    )}
                  </div>
                  <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {(showAllRuns ? delegations : delegations.slice(0, 3)).map((d) => {
                      const chip = statusChip(d.status);
                      return (
                        <li
                          key={d.id}
                          className="flex gap-2 rounded-md p-2 text-xs"
                          style={{
                            border: "1px solid var(--color-border-strong)",
                            background: "var(--color-surface-2)",
                          }}
                        >
                          <img
                            src={diceBearUrl(d.agent)}
                            alt=""
                            width={32}
                            height={32}
                            className="shrink-0 rounded"
                            style={{ background: "var(--color-surface-3)" }}
                            onError={(e) => {
                              (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className="truncate font-medium"
                                style={{ color: "var(--color-text)" }}
                              >
                                {d.agent}
                              </span>
                              <span
                                className="shrink-0 rounded px-1.5 py-px text-[10px] font-medium"
                                style={{ background: chip.bg, color: chip.fg }}
                              >
                                {chip.label}
                              </span>
                              {d.used_cheap_model && (
                                <span
                                  className="shrink-0 rounded px-1 py-px text-[9px] uppercase"
                                  style={{
                                    background: "var(--color-surface-3)",
                                    color: "var(--color-text-tertiary)",
                                  }}
                                  title="Spawned with Haiku 4.5 (cheap model)"
                                >
                                  Haiku
                                </span>
                              )}
                            </div>
                            <p
                              className="mt-0.5 line-clamp-2 leading-snug"
                              style={{ color: "var(--color-text-secondary)" }}
                            >
                              {d.task_preview}
                            </p>
                            <div
                              className="mt-0.5 flex items-center gap-2 text-[10px]"
                              style={{ color: "var(--color-text-tertiary)" }}
                            >
                              <span>{ageFromEpochField(d.started_at)}</span>
                              {d.cwd && (
                                <span
                                  className="truncate"
                                  style={{ fontFamily: "var(--font-mono)" }}
                                  title={d.cwd}
                                >
                                  {d.cwd}
                                </span>
                              )}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {/* Main content: Blocks / Tree / Grid */}
              {view === "blocks" ? (
                <BlocksView<AgentEntry>
                  items={blockItems}
                  noun="agent"
                  emptyLabel="No agents for the current filter."
                  topGroupAccent={(g) => {
                    if (g === "Global") return AGENT_ACCENT;
                    if (g === "Project") return "rgba(168, 136, 168, 0.40)";
                    return "rgba(63, 185, 80, 0.32)";
                  }}
                  renderLeaves={(items) => renderCardGrid(items.map((it) => it.data))}
                />
              ) : view === "tree" ? (
                <TreeView<AgentEntry>
                  origins={treeOrigins}
                  selectedKey={selected ? `${selected.origin}-${selected.path}` : null}
                  onSelect={(leaf) => setSelected(leaf.data)}
                  query={query}
                />
              ) : (
                renderCardGrid(filtered)
              )}
            </>
          )}
        </div>

        {/* Detail pane — same 560px panel as Skills/Rules */}
        {selected && (
          <div className="overflow-hidden lg:w-[560px] lg:shrink-0" style={{ minWidth: 0 }}>
            {(() => {
              const ws = agentWorkspace(selected);
              const subtitleParts: string[] = [selected.origin];
              const cat = deriveCategory(selected);
              if (cat !== NO_CATEGORY) subtitleParts.push(cat);
              subtitleParts.push(selected.enabled ? "enabled" : "disabled");
              return (
                <div className="flex h-full flex-col gap-2">
                  <LibraryDetailPane
                    kind="agent"
                    name={selected.name}
                    subtitle={subtitleParts.join(" · ")}
                    filePath={ws.file}
                    folderPath={ws.folder}
                    onSave={
                      selected.origin === "global"
                        ? async (body: string) => {
                            await invoke("update_agent_md", { name: selected.name, content: body });
                            await reload();
                          }
                        : undefined
                    }
                    onClose={() => setSelected(null)}
                  />
                  {/* Secondary toggle button below the detail pane — mirrors Skills.tsx */}
                  {selected.origin === "global" && (
                    <button
                      type="button"
                      onClick={() => void toggleAgent(selected)}
                      disabled={toggleBusy.has(selected.path)}
                      className="rounded-md border px-3 py-1.5 text-[11.5px] disabled:opacity-50"
                      style={{
                        borderColor: selected.enabled
                          ? "var(--color-border-strong)"
                          : "var(--color-accent)",
                        background: selected.enabled
                          ? "var(--color-surface-2)"
                          : "var(--color-accent)",
                        color: selected.enabled
                          ? "var(--color-text)"
                          : "var(--color-accent-text)",
                      }}
                    >
                      {toggleBusy.has(selected.path)
                        ? "Saving…"
                        : selected.enabled
                          ? "Disable agent"
                          : "Enable agent"}
                    </button>
                  )}
                  {/* Botón "Asignar tarea" siempre visible en el panel de detalle */}
                  <button
                    type="button"
                    onClick={() => { setAssignPreselected(selected.name); setAssignOpen(true); }}
                    className="rounded-md border px-3 py-1.5 text-[11.5px] font-medium"
                    style={{
                      borderColor: "rgba(167, 139, 250, 0.55)",
                      background: "rgba(167, 139, 250, 0.12)",
                      color: "#c4b5fd",
                    }}
                  >
                    Asignar tarea a este agente
                  </button>
                  {/* Open in editor fallback for non-global agents */}
                  {selected.origin !== "global" && (
                    <button
                      type="button"
                      onClick={() => void handleOpen(selected.path)}
                      className="rounded-md border px-3 py-1.5 text-[11.5px]"
                      style={{
                        borderColor: "var(--color-border-strong)",
                        background: "var(--color-surface-2)",
                        color: "var(--color-text)",
                      }}
                    >
                      Open in editor
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* Modals */}
      {searchOpen && (
        <SearchGitHubModal
          kind="agent"
          onClose={() => setSearchOpen(false)}
          onInstall={(it) => {
            setSearchOpen(false);
            setInstallItem(it);
          }}
        />
      )}
      {installItem && (
        <InstallConfirmModal
          item={installItem}
          kind="agent"
          onClose={() => setInstallItem(null)}
          onInstalled={() => {
            setInstallItem(null);
            void reload();
          }}
        />
      )}
      {createOpen && (
        <CreateAgentModal
          projects={projects}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void reload();
          }}
        />
      )}
      {assignOpen && (
        <AssignTaskModal
          agents={agents}
          preselectedAgent={assignPreselected}
          onClose={() => { setAssignOpen(false); setAssignPreselected(null); }}
          onLaunched={() => {
            // Refrescar delegaciones tras lanzar.
            invoke<DelegationLogEntry[]>("list_delegations", { limit: 50 })
              .then((list) => setDelegations(list))
              .catch(() => {});
          }}
        />
      )}
    </div>
  );
}
