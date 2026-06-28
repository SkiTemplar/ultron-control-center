// ULTRON Control Center 2.9.5 — Agents viewer (aligned with Skills/Rules UI).
//
// Brings Agents to full parity with the Skills and Rules layout:
//   - Same 2-pane layout: category sidebar chips + content grid + AgentDetailPane.
//   - Same 140px tall cards with violet inset ribbon (Bot accent) + selected state.
//   - Same header/search bar structure as Skills.tsx.
//   - Active/Disabled/All tab strip (already present, kept).
//   - Scope chips (already present, kept).
//   - Category pills row (same shape as Rules.tsx, now always visible in grid/tree modes).
//   - AgentDetailPane wired for the selected agent (edit + AI + open externally).
//   - Recent delegations strip preserved below the filter controls.
//   - Color: violet — rgba(167, 139, 250, …) consistent with AgentDetailPane agent accent.
//
// Recent delegations strip: conectado a list_delegations (polling 30s + evento
// workflow:delegated). Es una vista READ-ONLY de las delegaciones que dispara el
// kanban (kanban_dispatch_card); NO hay botón "Asignar tarea" manual en esta vista
// (delegate_task_launch no está cableado a la UI — pendiente de decisión: cablear
// un modal de delegación manual o des-registrar el comando).

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentEntry, RemoteItem, SkillOrigin } from "../types";
import { InstallConfirmModal } from "./library/InstallConfirmModal";
import { CreateAgentModal } from "./library/CreateAgentModal";
import { TreeView, type TreeOrigin } from "./library/TreeView";
import { BlocksView, type BlocksItem } from "./library/BlocksView";
import { useLibraryViewMode } from "./library/ViewToggle";
import { rankBySearch, type SearchableItem } from "../lib/ranked-search";

import type { ProjectLite, ScopeFilter, EnableFilter, DelegationLogEntry, AgentUsage } from "./agents/types";
import { NO_CATEGORY } from "./agents/types";
import { deriveCategory, deriveTopGroup, deriveSubGroup } from "./agents/helpers";
import { AgentsHeader } from "./agents/AgentsHeader";
import { AgentsFilters } from "./agents/AgentsFilters";
import { BulkActionBar } from "./agents/BulkActionBar";
import { DelegationsStrip } from "./agents/DelegationsStrip";
import { AgentUsageStrip } from "./agents/AgentUsageStrip";
import { AgentCardGrid } from "./agents/AgentCardGrid";
import { AgentDetailPane } from "./agents/AgentDetailPane";

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
  const [createOpen, setCreateOpen] = useState(false);
  const [installItem, setInstallItem] = useState<RemoteItem | null>(null);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [view, setView] = useLibraryViewMode("agents");
  const [selected, setSelected] = useState<AgentEntry | null>(null);

  // Optimistic toggle — mirrors Skills.tsx per-row approach.
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(new Set());

  // Bulk multi-select mode — mirrors Skills.tsx.
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Whether any toggle happened this session — controls the restart banner.
  const [hasToggled, setHasToggled] = useState(false);

  // Recent delegations.
  const [delegations, setDelegations] = useState<DelegationLogEntry[]>([]);

  // Agent usage stats (from subagent-harvest.jsonl via agent_usage_stats).
  const [usage, setUsage] = useState<AgentUsage[]>([]);

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

  // Agent usage stats — polling 30s, gemelo del de delegaciones.
  useEffect(() => {
    let cancelled = false;
    async function loadUsage() {
      try {
        const list = (await invoke("agent_usage_stats", { project: null })) as AgentUsage[];
        if (!cancelled) setUsage(list);
      } catch {
        if (!cancelled) setUsage([]);
      }
    }
    void loadUsage();
    const t = setInterval(loadUsage, 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
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
    // 1. Hard filters (scope / category / enable tab).
    const base = agents.filter((a) => {
      if (scope !== "all" && a.origin !== scope) return false;
      if (category !== "all" && deriveCategory(a) !== category) return false;
      if (enableFilter === "active" && !a.enabled) return false;
      if (enableFilter === "disabled" && a.enabled) return false;
      return true;
    });

    // 2. Ranked search — fuzzy + synonyms + name/description/origin weighting.
    const q = query.trim();
    if (!q) return base;

    const decorated = base.map((a) => {
      const item: SearchableItem & { __entry: AgentEntry } = {
        name: a.name,
        description: a.description,
        origin: a.origin,
        // The agent category derived from its on-disk path is a useful extra
        // signal, surfaced through the `tags` field of the ranker.
        tags: [deriveCategory(a)].filter((c) => c && c !== NO_CATEGORY),
        __entry: a,
      };
      return item;
    });
    return rankBySearch(decorated, q).map((d) => d.__entry);
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

  // -------------------------------------------------------------------------
  // Bulk enable / disable (mirrors Skills.tsx)
  // -------------------------------------------------------------------------

  const toggleChecked = (name: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleBulk = async (targetEnabled: boolean) => {
    if (bulkBusy || checked.size === 0) return;
    const names = Array.from(
      new Set(
        agents
          .filter((a) => a.origin === "global" && checked.has(a.name))
          .map((a) => a.name),
      ),
    );
    if (names.length === 0) {
      setError("Selection has no global agents to toggle.");
      return;
    }
    setBulkBusy(true);
    setHasToggled(true);
    setError(null);
    try {
      await invoke("agents_bulk_toggle", { names, disabled: !targetEnabled });
      setChecked(new Set());
      await reload();
    } catch (e) {
      setError(`Bulk toggle failed: ${e}`);
    } finally {
      setBulkBusy(false);
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
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Page header — mirrors Skills.tsx */}
      <AgentsHeader
        totalCount={agents.length}
        filteredCount={filtered.length}
        view={view}
        selectMode={selectMode}
        onViewChange={setView}
        onCreateOpen={() => setCreateOpen(true)}
        onToggleSelectMode={() => {
          setSelectMode((v) => !v);
          setChecked(new Set());
        }}
        onReload={reload}
      />

      {/* Restart banner — appears after any toggle this session */}
      {hasToggled && (
        <div
          className="flex items-center gap-2 rounded-md px-3 py-2 text-xs"
          style={{
            background: "rgba(234, 179, 8, 0.08)",
            border: "1px solid rgba(234, 179, 8, 0.30)",
            color: "var(--color-warn, #ca8a04)",
          }}
        >
          <span
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: "var(--color-warn, #ca8a04)" }}
          />
          Restart Claude Code to apply agent changes.
        </div>
      )}

      {/* Bulk action bar — visible in select mode */}
      {selectMode && (
        <BulkActionBar
          checkedCount={checked.size}
          bulkBusy={bulkBusy}
          onBulkEnable={() => void handleBulk(true)}
          onBulkDisable={() => void handleBulk(false)}
        />
      )}

      {/* Filters: enable tabs + scope chips + category pills + search */}
      <AgentsFilters
        scope={scope}
        category={category}
        categories={categories}
        enableFilter={enableFilter}
        enableCounts={enableCounts}
        query={query}
        view={view}
        onScopeChange={setScope}
        onCategoryChange={setCategory}
        onEnableFilterChange={setEnableFilter}
        onQueryChange={setQuery}
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
          {/* Telemetry strips — driven by their own 30s polling, independent of
              the agent grid filter; each guards its own empty state. Kept ABOVE
              the loading/empty/grid switch so they never vanish when a filter
              empties the grid (mand. 11). */}
          <AgentUsageStrip usage={usage} />
          <DelegationsStrip delegations={delegations} />

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
              {/* Main content: Blocks / Tree / Grid */}
              {view === "blocks" ? (
                <BlocksView<AgentEntry>
                  items={blockItems}
                  noun="agent"
                  emptyLabel="No agents for the current filter."
                  topGroupAccent={(g) => {
                    if (g === "Global") return "rgba(167, 139, 250, 0.55)";
                    if (g === "Project") return "rgba(168, 136, 168, 0.40)";
                    return "rgba(63, 185, 80, 0.32)";
                  }}
                  renderLeaves={(items) => (
                    <AgentCardGrid
                      items={items.map((it) => it.data)}
                      selected={selected}
                      selectMode={selectMode}
                      checked={checked}
                      onSelect={setSelected}
                      onToggleChecked={toggleChecked}
                    />
                  )}
                />
              ) : view === "tree" ? (
                <TreeView<AgentEntry>
                  origins={treeOrigins}
                  selectedKey={selected ? `${selected.origin}-${selected.path}` : null}
                  onSelect={(leaf) => setSelected(leaf.data)}
                  query={query}
                />
              ) : (
                <AgentCardGrid
                  items={filtered}
                  selected={selected}
                  selectMode={selectMode}
                  checked={checked}
                  onSelect={setSelected}
                  onToggleChecked={toggleChecked}
                />
              )}
            </>
          )}
        </div>

        {/* Detail pane — same 560px panel as Skills/Rules */}
        {selected && (
          <AgentDetailPane
            selected={selected}
            toggleBusy={toggleBusy}
            onReload={reload}
            onClose={() => setSelected(null)}
            onToggle={toggleAgent}
            onError={setError}
          />
        )}
      </div>

      {/* Modals */}
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
    </div>
  );
}
