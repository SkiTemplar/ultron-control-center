import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SkillEntry, SkillInfo, SkillOrigin } from "../../types";
import { useLibraryViewMode } from "../library/ViewToggle";
import { rankBySearch, type SearchableItem } from "../../lib/ranked-search";
import { NO_CATEGORY } from "./constants";
import { deriveCategory, deriveTopGroup, deriveSubGroup } from "./helpers";
import type { SkillMeta, ProjectLite, ScopeFilter, EnableFilter } from "./types";
import type { TreeOrigin } from "../library/TreeView";
import type { BlocksItem } from "../library/BlocksView";

export function useSkillsState() {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  // Arranca en "global" = TUS skills (el núcleo lazy de ULTRON, ~8 activas), no
  // en "all", que sumaba las skills de plugins de terceros y mostraba un "activas"
  // engañoso (~45). El scope "all" sigue disponible para ver todo el catálogo.
  const [scope, setScope] = useState<ScopeFilter>("global");
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

  return {
    // state
    skills,
    scope,
    setScope,
    enableFilter,
    setEnableFilter,
    category,
    setCategory,
    query,
    setQuery,
    loading,
    error,
    createOpen,
    setCreateOpen,
    projects,
    view,
    setView,
    selected,
    setSelected,
    optimisticMap,
    toggleBusy,
    toast,
    hasToggled,
    selectMode,
    setSelectMode,
    checked,
    setChecked,
    bulkBusy,
    // derived
    categories,
    activeCount,
    disabledCount,
    filtered,
    treeOrigins,
    blockItems,
    // handlers
    reload,
    isEnabled,
    handleToggle,
    toggleChecked,
    handleBulk,
    buildOnSave,
  };
}
