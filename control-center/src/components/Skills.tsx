// ULTRON Control Center 2.7.2 — Skills viewer with Active/Disabled/All tabs.
//
// Changes vs 2.7.1:
//   - Three filter tabs: Active (default) · Disabled · All — each with a count badge.
//   - Inline toggle switch on every Global card (optimistic UI: visual flips
//     immediately, calls skill_toggle, reverts + shows toast on error).
//   - "Restart Claude Code to apply changes" banner appears after the first
//     toggle in the session (changes are not live).
//   - Cards for disabled skills render with reduced opacity + muted text so
//     the enabled/disabled state is scannable at a glance.
//   - Existing detail-pane toggle button is kept as a secondary action.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SkillEntry, SkillInfo, SkillOrigin } from "../types";
import { CreateSkillModal } from "./library/CreateSkillModal";
import { Plus, Sparkle } from "./library/icons";
import { TreeView, type TreeOrigin } from "./library/TreeView";
import { BlocksView, type BlocksItem } from "./library/BlocksView";
import { ViewToggle, useLibraryViewMode } from "./library/ViewToggle";
import { categorize } from "../lib/skill-categories";
import { LibraryDetailPane } from "./library/LibraryDetailPane";
import { rankBySearch, type SearchableItem } from "../lib/ranked-search";

// Registry-sourced metadata (priority / usage_count / tags) the origin-aware
// SkillEntry shape does not carry. Keyed by skill name so the ranked search
// can weight by these signals when they are available.
type SkillMeta = { priority?: number; usageCount?: number; tags?: string[] };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProjectLite = { id: string; name: string };

type ScopeFilter = "all" | SkillOrigin;

type EnableFilter = "active" | "disabled" | "all";

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

// Cyan accent — distinguishes skill cards from agents (violet) and rules (lime).
const SKILL_ACCENT = "rgba(56, 189, 248, 0.55)";
const SKILL_ACCENT_SOFT = "rgba(56, 189, 248, 0.16)";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function deriveCategory(s: SkillEntry): string {
  const norm = s.path.replace(/\\/g, "/");
  if (s.origin === "plugin") {
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\//);
    if (m && m[1]) return m[1];
  }
  const m = norm.match(/\/skills\/([^/]+)\/[^/]+\/?(?:SKILL\.md)?$/);
  if (m && m[1] && m[1] !== s.name) return m[1];
  return NO_CATEGORY;
}

function deriveTopGroup(s: SkillEntry): string {
  if (s.origin === "global") return "Global";
  if (s.origin === "project") return "Project";
  return deriveCategory(s);
}

function deriveSubGroup(s: SkillEntry): string | null {
  const domain = categorize(s.name, s.description);
  if (domain) return domain;
  const norm = s.path.replace(/\\/g, "/");
  if (s.origin === "plugin") {
    const m = norm.match(/\/skills\/([^/]+)\/[^/]+\/?(?:SKILL\.md)?$/);
    if (m && m[1] && m[1] !== s.name) return m[1];
    return null;
  }
  const cat = deriveCategory(s);
  if (cat === NO_CATEGORY) return null;
  return cat;
}

function skillWorkspace(s: SkillEntry): { folder: string; file: string } {
  const file = s.path;
  const norm = file.replace(/\\/g, "/");
  if (/\/SKILL\.md$/i.test(norm)) {
    return { folder: file.replace(/[\\/]SKILL\.md$/i, ""), file };
  }
  if (!/\.md$/i.test(norm)) {
    const sep = file.includes("\\") ? "\\" : "/";
    return { folder: file, file: file + sep + "SKILL.md" };
  }
  const lastSep = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  return { folder: lastSep > 0 ? file.slice(0, lastSep) : "", file };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface EnableTabsProps {
  value: EnableFilter;
  onChange: (v: EnableFilter) => void;
  activeCount: number;
  disabledCount: number;
}

function EnableTabs({ value, onChange, activeCount, disabledCount }: EnableTabsProps) {
  const tabs: { id: EnableFilter; label: string; count: number }[] = [
    { id: "active", label: "Active", count: activeCount },
    { id: "disabled", label: "Disabled", count: disabledCount },
    { id: "all", label: "All", count: activeCount + disabledCount },
  ];

  return (
    <div
      className="flex items-center gap-1 rounded-lg p-1"
      style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
    >
      {tabs.map((tab) => {
        const isActive = value === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
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
                background: isActive ? SKILL_ACCENT_SOFT : "var(--color-surface-3)",
                color: isActive ? "#67e8f9" : "var(--color-text-tertiary)",
              }}
            >
              {tab.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface ToggleSwitchProps {
  enabled: boolean;
  busy: boolean;
  readonly: boolean;
  onToggle: () => void;
}

function ToggleSwitch({ enabled, busy, readonly, onToggle }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      disabled={busy || readonly}
      title={
        readonly
          ? "Only global skills can be toggled"
          : enabled
            ? "Disable skill"
            : "Enable skill"
      }
      className="flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-40"
      style={{
        background: enabled ? "var(--color-success)" : "var(--color-surface-3)",
        border: "1px solid var(--color-border-strong)",
        padding: "1px",
        cursor: busy || readonly ? "not-allowed" : "pointer",
      }}
    >
      <span
        className="block h-3.5 w-3.5 rounded-full transition-transform"
        style={{
          background: "var(--color-text)",
          transform: enabled ? "translateX(16px)" : "translateX(0)",
        }}
      />
    </button>
  );
}

interface RestartBannerProps {
  visible: boolean;
}

function RestartBanner({ visible }: RestartBannerProps) {
  if (!visible) return null;
  return (
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
      Restart Claude Code to apply skill changes.
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function Skills() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [enableFilter, setEnableFilter] = useState<EnableFilter>("active");
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectLite[]>([]);
  const [view, setView] = useLibraryViewMode("skills");
  const [selected, setSelected] = useState<SkillEntry | null>(null);

  // Optimistic toggle state: maps skill path → optimistic enabled value.
  const [optimisticMap, setOptimisticMap] = useState<Record<string, boolean>>({});
  // Tracks which skills have an in-flight toggle request.
  const [toggleBusy, setToggleBusy] = useState<Set<string>>(new Set());
  // Flash toast for toggle errors.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether any toggle has happened this session — controls the restart banner.
  const [hasToggled, setHasToggled] = useState(false);

  // Registry metadata (priority / usage_count / tags) keyed by skill name,
  // used to weight the ranked search. Best-effort: an empty map just means the
  // search ranks on text relevance alone.
  const [metaByName, setMetaByName] = useState<Record<string, SkillMeta>>({});

  // Bulk multi-select mode: when on, cards show a checkbox and a bulk action
  // bar lets the user enable/disable the whole selection at once.
  const [selectMode, setSelectMode] = useState(false);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    invoke<ProjectLite[]>("list_projects")
      .then((list) => setProjects(list.map((p) => ({ id: p.id, name: p.name }))))
      .catch(() => setProjects([]));
  }, []);

  // Pull registry metadata once. The legacy registry listing carries the
  // priority / usage_count / tags fields the origin-aware list omits.
  useEffect(() => {
    invoke<SkillInfo[]>("list_skills_legacy")
      .then((list) => {
        const map: Record<string, SkillMeta> = {};
        for (const s of list) {
          // `priority` is serialised by the backend but absent from the TS
          // SkillInfo type; read it defensively.
          const priority = (s as unknown as { priority?: number }).priority;
          map[s.name] = {
            priority: typeof priority === "number" ? priority : undefined,
            usageCount: s.usage_count,
            tags: s.tags,
          };
        }
        setMetaByName(map);
      })
      .catch(() => setMetaByName({}));
  }, []);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = (await invoke("list_skills", { projectPath: null })) as SkillEntry[];
      setSkills(res);
      // Clear optimistic overrides after a fresh fetch — the server is now the truth.
      setOptimisticMap({});
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
  }, []);

  // Show a toast and auto-dismiss after 4 s.
  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }

  // Derive effective enabled state: optimistic override > server state.
  function isEnabled(s: SkillEntry): boolean {
    if (s.path in optimisticMap) return optimisticMap[s.path];
    return s.enabled;
  }

  const handleToggle = async (s: SkillEntry) => {
    if (s.origin !== "global") return;
    if (toggleBusy.has(s.path)) return;

    const currentEnabled = isEnabled(s);
    const nextEnabled = !currentEnabled;

    // Optimistic update.
    setOptimisticMap((m) => ({ ...m, [s.path]: nextEnabled }));
    setToggleBusy((b) => { const n = new Set(b); n.add(s.path); return n; });
    setHasToggled(true);

    try {
      await invoke("skill_toggle", { name: s.name, enabled: nextEnabled });
      // Full re-fetch so path (which changes on disk) stays accurate.
      await reload();
    } catch (e) {
      // Revert optimistic override.
      setOptimisticMap((m) => { const n = { ...m }; delete n[s.path]; return n; });
      showToast(`Toggle failed for "${s.name}": ${e}`);
    } finally {
      setToggleBusy((b) => { const n = new Set(b); n.delete(s.path); return n; });
    }
  };

  // -------------------------------------------------------------------------
  // Bulk enable / disable
  // -------------------------------------------------------------------------

  // Toggle a card's checkbox membership in the bulk selection.
  const toggleChecked = (name: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // Apply a bulk enable/disable to every checked GLOBAL skill. Names are
  // deduped (a skill could appear under multiple paths) before the single
  // backend call so we never toggle the same slug twice.
  const handleBulk = async (targetEnabled: boolean) => {
    if (bulkBusy || checked.size === 0) return;
    // Only global skills can be toggled; filter the selection to those.
    const names = Array.from(
      new Set(
        skills
          .filter((s) => s.origin === "global" && checked.has(s.name))
          .map((s) => s.name),
      ),
    );
    if (names.length === 0) {
      showToast("Selection has no global skills to toggle.");
      return;
    }
    setBulkBusy(true);
    setHasToggled(true);
    try {
      await invoke("skills_bulk_toggle", { names, disabled: !targetEnabled });
      setChecked(new Set());
      await reload();
    } catch (e) {
      showToast(`Bulk toggle failed: ${e}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const buildOnSave = (s: SkillEntry): ((body: string) => Promise<void>) | undefined => {
    if (s.origin !== "global") return undefined;
    return async (body: string) => {
      await invoke("update_skill_md", { name: s.name, content: body });
      await reload();
    };
  };

  // ---------------------------------------------------------------------------
  // Derived lists
  // ---------------------------------------------------------------------------

  const categories = useMemo(() => {
    const subset = scope === "all" ? skills : skills.filter((s) => s.origin === scope);
    const set = new Set<string>();
    for (const s of subset) set.add(deriveCategory(s));
    return Array.from(set).sort((a, b) => {
      if (a === NO_CATEGORY) return 1;
      if (b === NO_CATEGORY) return -1;
      return a.localeCompare(b);
    });
  }, [skills, scope]);

  useEffect(() => {
    if (category !== "all" && !categories.includes(category)) setCategory("all");
  }, [categories, category]);

  // Count by enable state (using optimistic overrides) for the tab badges.
  const { activeCount, disabledCount } = useMemo(() => {
    const scopeFiltered = scope === "all" ? skills : skills.filter((s) => s.origin === scope);
    let a = 0;
    let d = 0;
    for (const s of scopeFiltered) {
      if (isEnabled(s)) a++;
      else d++;
    }
    return { activeCount: a, disabledCount: d };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills, scope, optimisticMap]);

  const filtered = useMemo(() => {
    // 1. Hard filters (scope / category / enable tab) — these gate membership.
    const base = skills.filter((s) => {
      if (scope !== "all" && s.origin !== scope) return false;
      if (category !== "all" && deriveCategory(s) !== category) return false;
      const enabled = isEnabled(s);
      if (enableFilter === "active" && !enabled) return false;
      if (enableFilter === "disabled" && enabled) return false;
      return true;
    });

    // 2. Ranked search — fuzzy + synonyms + name/tags/desc + priority/usage.
    const q = query.trim();
    if (!q) return base;

    // Decorate each entry with registry metadata so the ranker can weight it.
    const decorated = base.map((s) => {
      const meta = metaByName[s.name];
      const item: SearchableItem & { __entry: SkillEntry } = {
        name: s.name,
        description: s.description,
        origin: s.origin,
        tags: meta?.tags,
        priority: meta?.priority,
        usageCount: meta?.usageCount,
        __entry: s,
      };
      return item;
    });
    return rankBySearch(decorated, q).map((d) => d.__entry);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills, scope, category, enableFilter, query, optimisticMap, metaByName]);

  // ---------------------------------------------------------------------------
  // Tree / Blocks adapters
  // ---------------------------------------------------------------------------

  const treeOrigins: TreeOrigin<SkillEntry>[] = useMemo(() => {
    const buckets: Record<SkillOrigin, Record<string, SkillEntry[]>> = {
      global: {},
      project: {},
      plugin: {},
    };
    for (const s of filtered) {
      const cat = deriveCategory(s);
      (buckets[s.origin][cat] ??= []).push(s);
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
          leaves: list.map((s) => ({
            key: `${s.origin}-${s.path}`,
            label: s.name,
            data: s,
          })),
        })),
    }));
  }, [filtered]);

  const blockItems: BlocksItem<SkillEntry>[] = useMemo(
    () =>
      filtered.map((s) => ({
        key: `${s.origin}-${s.path}`,
        topGroup: deriveTopGroup(s),
        subGroup: deriveSubGroup(s),
        data: s,
      })),
    [filtered],
  );

  // ---------------------------------------------------------------------------
  // Card grid renderer
  // ---------------------------------------------------------------------------

  const renderCardGrid = (items: SkillEntry[]) => (
    <div
      className="grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}
    >
      {items.map((s) => {
        const isActive = selected?.path === s.path;
        const enabled = isEnabled(s);
        const busy = toggleBusy.has(s.path);
        const isChecked = checked.has(s.name);
        const selectable = selectMode && s.origin === "global";

        return (
          <button
            key={`${s.origin}-${s.path}`}
            type="button"
            onClick={() => (selectable ? toggleChecked(s.name) : setSelected(s))}
            className="group relative flex h-[140px] flex-col justify-between rounded-xl p-4 text-left transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            style={{
              background: isActive ? "var(--color-surface-3)" : "var(--color-surface-2)",
              border: `1px solid ${
                selectable && isChecked ? SKILL_ACCENT : isActive ? SKILL_ACCENT : "var(--color-border)"
              }`,
              boxShadow: `inset 0 3px 0 ${SKILL_ACCENT}`,
              opacity: enabled ? 1 : 0.55,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = SKILL_ACCENT;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${SKILL_ACCENT}, 0 6px 18px rgba(0,0,0,0.28)`;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor =
                selectable && isChecked ? SKILL_ACCENT : isActive ? SKILL_ACCENT : "var(--color-border)";
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = `inset 0 3px 0 ${SKILL_ACCENT}`;
            }}
            title={s.description || s.name}
          >
            {/* Bulk-select checkbox overlay (only in select mode, global skills) */}
            {selectMode && (
              <input
                type="checkbox"
                checked={isChecked}
                disabled={s.origin !== "global"}
                onChange={() => toggleChecked(s.name)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${s.name}`}
                className="absolute right-2 top-2 h-4 w-4"
                style={{ accentColor: "#38bdf8", cursor: s.origin === "global" ? "pointer" : "not-allowed" }}
              />
            )}
            {/* Header row: label chip + toggle */}
            <div className="flex items-center justify-between gap-1.5">
              <div
                className="flex items-center gap-1 text-[10.5px] uppercase tracking-[0.08em]"
                style={{ color: "var(--color-text-tertiary)" }}
              >
                <Sparkle size={12} />
                Skill
              </div>
              <div className="flex items-center gap-1.5">
                {busy && (
                  <span
                    className="text-[9px]"
                    style={{ color: "var(--color-text-faint)" }}
                  >
                    …
                  </span>
                )}
                <ToggleSwitch
                  enabled={enabled}
                  busy={busy}
                  readonly={s.origin !== "global"}
                  onToggle={() => void handleToggle(s)}
                />
              </div>
            </div>

            {/* Skill name */}
            <div
              className="line-clamp-3 text-[18px] font-semibold leading-tight tracking-tight"
              style={{ color: enabled ? "var(--color-text)" : "var(--color-text-secondary)" }}
            >
              {s.name}
            </div>

            {/* Footer: origin badge */}
            <div className="flex items-center justify-between">
              <span
                className="rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide"
                style={{
                  background: SKILL_ACCENT_SOFT,
                  color: "#67e8f9",
                  border: "1px solid rgba(56, 189, 248, 0.35)",
                }}
              >
                {s.origin}
              </span>
              {!enabled && (
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

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col gap-4 p-6">
      {/* Page header */}
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold">Skills</h2>
          <span className="text-[11.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {filtered.length} of {skills.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle mode={view} onChange={setView} />
          <button
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            <Plus size={12} /> New skill
          </button>
          <button
            onClick={() => {
              setSelectMode((v) => !v);
              setChecked(new Set());
            }}
            className="rounded-md border px-3 py-1 text-xs"
            style={{
              borderColor: selectMode ? SKILL_ACCENT : "var(--color-border-strong)",
              background: selectMode ? SKILL_ACCENT_SOFT : "var(--color-surface-2)",
              color: selectMode ? "#67e8f9" : "var(--color-text)",
            }}
            title="Toggle multi-select mode to bulk enable/disable global skills"
          >
            {selectMode ? "Done selecting" : "Select"}
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

      {/* Restart banner */}
      <RestartBanner visible={hasToggled} />

      {/* Bulk action bar — visible in select mode */}
      {selectMode && (
        <div
          className="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-xs"
          style={{
            background: SKILL_ACCENT_SOFT,
            border: `1px solid ${SKILL_ACCENT}`,
            color: "var(--color-text)",
          }}
        >
          <span style={{ color: "var(--color-text-secondary)" }}>
            {checked.size} seleccionado{checked.size === 1 ? "" : "s"} (solo global)
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleBulk(true)}
              disabled={bulkBusy || checked.size === 0}
              className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
              style={{
                borderColor: "var(--color-success)",
                background: "transparent",
                color: "var(--color-success)",
              }}
            >
              {bulkBusy ? "Aplicando…" : "Activar seleccionados"}
            </button>
            <button
              type="button"
              onClick={() => void handleBulk(false)}
              disabled={bulkBusy || checked.size === 0}
              className="rounded-md border px-3 py-1 font-medium disabled:opacity-40"
              style={{
                borderColor: "var(--color-danger)",
                background: "transparent",
                color: "var(--color-danger)",
              }}
            >
              {bulkBusy ? "Aplicando…" : "Desactivar seleccionados"}
            </button>
          </div>
        </div>
      )}

      {/* Enable-state tabs */}
      <EnableTabs
        value={enableFilter}
        onChange={setEnableFilter}
        activeCount={activeCount}
        disabledCount={disabledCount}
      />

      {/* Scope chips */}
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

      {/* Search */}
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search skills — fuzzy + synonyms, ranked by relevance…"
        className="w-full rounded-md px-3 py-2 text-sm outline-none"
        style={{
          border: "1px solid var(--color-border-strong)",
          background: "var(--color-surface-2)",
          color: "var(--color-text)",
        }}
      />

      {/* Error */}
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

      {/* Toast */}
      {toast && (
        <div
          className="rounded-md p-3 text-xs"
          style={{
            border: "1px solid rgba(248, 81, 73, 0.30)",
            background: "rgba(248, 81, 73, 0.08)",
            color: "var(--color-danger)",
          }}
        >
          {toast}
        </div>
      )}

      {/* 2-pane: list + detail */}
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
              style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
            >
              <p className="text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
                {enableFilter === "disabled"
                  ? "No disabled skills matching the current filters."
                  : enableFilter === "active"
                    ? "No active skills matching the current filters."
                    : "No skills found."}
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
          ) : view === "blocks" ? (
            <BlocksView<SkillEntry>
              items={blockItems}
              noun="skill"
              emptyLabel="No skills for the current filter."
              topGroupAccent={() => SKILL_ACCENT}
              renderLeaves={(items) => renderCardGrid(items.map((it) => it.data))}
            />
          ) : view === "tree" ? (
            <TreeView<SkillEntry>
              origins={treeOrigins}
              selectedKey={selected ? `${selected.origin}-${selected.path}` : null}
              onSelect={(leaf) => setSelected(leaf.data)}
              query={query}
            />
          ) : (
            renderCardGrid(filtered)
          )}
        </div>

        {selected && (
          <div className="overflow-hidden lg:w-[560px] lg:shrink-0" style={{ minWidth: 0 }}>
            {(() => {
              const ws = skillWorkspace(selected);
              const subtitleParts: string[] = [selected.origin];
              const cat = deriveCategory(selected);
              if (cat !== NO_CATEGORY) subtitleParts.push(cat);
              if (selected.origin === "global") {
                subtitleParts.push(isEnabled(selected) ? "enabled" : "disabled");
              }
              return (
                <div className="flex h-full flex-col gap-2">
                  <LibraryDetailPane
                    kind="skill"
                    name={selected.name}
                    subtitle={subtitleParts.join(" · ")}
                    filePath={ws.file}
                    folderPath={ws.folder}
                    onSave={buildOnSave(selected)}
                    onClose={() => setSelected(null)}
                  />
                  {selected.origin === "global" && (
                    <button
                      type="button"
                      onClick={() => void handleToggle(selected)}
                      disabled={toggleBusy.has(selected.path)}
                      className="rounded-md border px-3 py-1.5 text-[11.5px] disabled:opacity-50"
                      style={{
                        borderColor: isEnabled(selected)
                          ? "var(--color-border-strong)"
                          : "var(--color-accent)",
                        background: isEnabled(selected)
                          ? "var(--color-surface-2)"
                          : "var(--color-accent)",
                        color: isEnabled(selected)
                          ? "var(--color-text)"
                          : "var(--color-accent-text)",
                      }}
                    >
                      {toggleBusy.has(selected.path)
                        ? "Saving…"
                        : isEnabled(selected)
                          ? "Disable skill"
                          : "Enable skill"}
                    </button>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {createOpen && (
        <CreateSkillModal
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
