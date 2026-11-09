// usePlans — state, data-fetching, and action handlers for the Plans tab.
// Extracted from Plans.tsx as part of the cat7 split refactor.

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ARCHIVED_STATUSES,
  COLUMNS,
  EMPTY_FORM,
} from "./types";
import type { PlanFormState, PlanItem, PlansReport } from "./types";
import { instructionsCwd, openInSessionsMessage, openPromptInSessions } from "../sessionsLaunch";

export function usePlans() {
  const [report, setReport] = useState<PlansReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<Set<string>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [modalState, setModalState] = useState<PlanFormState | null>(null);
  const [modalBusy, setModalBusy] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PlanItem | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [pendingClean, setPendingClean] = useState(false);
  const [cleanBusy, setCleanBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedDays, setArchivedDays] = useState<number>(30);
  // Drag-and-drop state for the kanban. `draggingId` is the plan being
  // dragged (used to dim its card); `dragOverColumn` is the lane currently
  // hovered (used to highlight the drop target). Both reset on drop/end.
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const r = (await invoke("list_plans")) as PlansReport;
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

  // Auto-archive resolved plans older than `archivedDays` days. Runs on
  // mount and every 5 minutes after. Backend flips status="resolved" →
  // "archived" in place (no file moves), so the kanban filter drops them
  // and the "Show archived" drawer surfaces them when the user wants.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const n = (await invoke("auto_archive_resolved_plans", {
          days: archivedDays,
        })) as number;
        if (alive && n > 0) {
          await load();
        }
      } catch {
        // Silent: stale/missing PLANS.json shouldn't spam the toast.
      }
    }
    tick();
    const id = window.setInterval(tick, 5 * 60 * 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [archivedDays]);

  async function move(id: string, target: string) {
    try {
      await invoke("patch_plan_status", { id, status: target });
      await load();
    } catch (e) {
      setError(String(e));
    }
  }

  async function submitPlan() {
    if (!modalState) return;
    setModalBusy(true);
    setModalError(null);
    try {
      const tagList = modalState.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      if (modalState.id) {
        await invoke("update_plan", {
          id: modalState.id,
          title: modalState.title.trim() || null,
          priority: modalState.priority,
          kind: modalState.kind,
          description: modalState.description,
          tags: tagList,
        });
      } else {
        await invoke("add_plan", {
          title: modalState.title.trim(),
          priority: modalState.priority,
          status: "open",
          kind: modalState.kind,
          description: modalState.description,
          tags: tagList,
        });
      }
      setModalState(null);
      await load();
    } catch (e) {
      setModalError(String(e));
    } finally {
      setModalBusy(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await invoke("delete_plan", { id: pendingDelete.id });
      setPendingDelete(null);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleteBusy(false);
    }
  }

  // Nombre visible de cada flujo de planes.
  const FLOW_LABEL: Record<"execute" | "review" | "add" | "resolve", string> = {
    execute: "ejecutar",
    review: "revisar",
    add: "añadir",
    resolve: "desbloquear",
  };

  // Open a Sessions chat targeted at one of four plan workflows.
  // cwd = ~/.ultron/instructions/plans/ so Claude auto-reads the GUIDE.md
  // and knows the schema, status names, atomic-write rules, etc. — saves
  // a re-discovery pass each turn.
  async function spawnClaudePlanFlow(
    kind: "execute" | "review" | "add" | "resolve",
  ) {
    setError(null);
    if (kind !== "add" && flowTargetCount[kind] === 0) {
      setError(`Nada que hacer en «${FLOW_LABEL[kind]}»: no hay planes para este flujo.`);
      return;
    }
    try {
      const instrPath = await instructionsCwd("plans");
      // v15.3.5: prompt bodies migrated to the central button-prompts
      // catalog. Each header button maps 1:1 to a `plans.*` key so the
      // user can refine the prompts from Settings → Button prompts
      // without recompiling. The kind→key mapping mirrors the four flows.
      const keyByKind: Record<typeof kind, string> = {
        execute: "plans.execute",
        review: "plans.review",
        add: "plans.add_from_goal",
        resolve: "plans.resolve_in_progress",
      };
      const { getPrompt } = await import("../../lib/button-prompts");
      const prompt = await getPrompt(keyByKind[kind]);
      const r = await openPromptInSessions({ cwd: instrPath, prompt, permissionMode: "default" });
      setInfo(openInSessionsMessage(`Planes · ${FLOW_LABEL[kind]}`, r));
      if (!r.warning) window.setTimeout(() => setInfo(null), 3500);
    } catch (e) {
      setError(String(e));
    }
  }

  async function aiSprintPlan() {
    setAiBusy(true);
    setError(null);
    try {
      const opens = (report?.items ?? [])
        .filter((it) => it.status === "open")
        .sort((a, b) => a.priority.localeCompare(b.priority));
      const open_plans_block = opens
        .map((it) => {
          const effort = it.effort_hours ? ` (~${it.effort_hours[0]}-${it.effort_hours[1]}h)` : "";
          const desc = it.description ? `\n  ${it.description.slice(0, 150)}` : "";
          return `[${it.priority.toUpperCase()}] ${it.title}${effort}${desc}`;
        })
        .join("\n");
      const { getPrompt } = await import("../../lib/button-prompts");
      const prompt = await getPrompt("plans.sprint_ai", {
        open_plans_block: open_plans_block || "(no open plans)",
      });
      const r = await openPromptInSessions({
        cwd: await instructionsCwd("plans"),
        prompt,
        permissionMode: "default",
      });
      setInfo(openInSessionsMessage("Sprint con IA", r));
      if (!r.warning) window.setTimeout(() => setInfo(null), 5000);
    } catch (e) {
      setError(String(e));
    } finally {
      setAiBusy(false);
    }
  }

  async function cleanResolved() {
    setCleanBusy(true);
    try {
      const n = (await invoke("clean_resolved_plans")) as number;
      setInfo(`${n} plan${n === 1 ? "" : "es"} resuelto${n === 1 ? "" : "s"} archivado${n === 1 ? "" : "s"} en plans/_archive/.`);
      window.setTimeout(() => setInfo(null), 3000);
      setPendingClean(false);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setCleanBusy(false);
    }
  }

  async function openResolutionSession(plan: PlanItem) {
    try {
      // El cuerpo del prompt sale del catálogo central (clave
      // "plans.resolve_one"); las variables cubren todos los campos del plan
      // que la plantilla pueda interpolar. Se abre en Sessions, no en wt.exe.
      const { getPrompt } = await import("../../lib/button-prompts");
      const prompt = await getPrompt("plans.resolve_one", {
        plan_id: plan.id,
        plan_title: plan.title,
        plan_status: plan.status,
        plan_priority: plan.priority,
        plan_description: plan.description ?? "",
      });
      const r = await openPromptInSessions({
        cwd: await instructionsCwd("plans"),
        prompt,
        permissionMode: "default",
      });
      setInfo(openInSessionsMessage(`Resolver «${plan.title}»`, r));
      if (!r.warning) window.setTimeout(() => setInfo(null), 3500);
    } catch (e) {
      setError(String(e));
    }
  }

  function togglePriority(p: string) {
    const next = new Set(priorityFilter);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setPriorityFilter(next);
  }

  const filtered = useMemo(() => {
    if (!report) return [];
    const q = query.trim().toLowerCase();
    return report.items
      .filter((it) => !ARCHIVED_STATUSES.has(it.status)) // kanban hides archived + merged (both in the drawer)
      .filter((it) => {
        if (priorityFilter.size === 0) return true;
        return priorityFilter.has(it.priority);
      })
      .filter((it) => {
        if (!q) return true;
        const hay = [
          it.id,
          it.title,
          it.description ?? "",
          ...it.tags,
        ]
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
  }, [report, query, priorityFilter]);

  const archivedItems = useMemo(() => {
    if (!report) return [] as PlanItem[];
    // The drawer holds terminal plans that left the kanban: `archived`
    // (stale resolved, auto-archived) and `merged` (shipped via merge).
    // Routing `merged` here keeps those items findable without letting
    // them inflate the open/total counts on the board.
    return report.items.filter((it) => ARCHIVED_STATUSES.has(it.status));
  }, [report]);

  const grouped = useMemo(() => {
    const m: Record<string, PlanItem[]> = {};
    for (const c of COLUMNS) m[c.key] = [];
    for (const it of filtered) {
      const key = COLUMNS.some((c) => c.key === it.status) ? it.status : "open";
      m[key].push(it);
    }
    for (const k of Object.keys(m)) {
      m[k].sort(
        (a, b) =>
          priorityWeight(a.priority) - priorityWeight(b.priority) ||
          a.id.localeCompare(b.id),
      );
    }
    return m;
  }, [filtered]);

  // v2.x slim: previously a full `stats` memo (total, byStatus, byPriority)
  // fed the rolled-up stats strip. The strip is gone, but the "Archive
  // selected" button still needs to know how many cards live in the
  // `resolved` column. Compute just that — nothing else.
  const resolvedCount = useMemo(() => {
    if (!report) return 0;
    return report.items.filter(
      (it) => !ARCHIVED_STATUSES.has(it.status) && it.status === "resolved",
    ).length;
  }, [report]);

  // Plans each AI flow would act on, mirroring the scope of its prompt
  // (button_prompts/defaults.rs): execute walks `open`; review takes
  // `revision` and falls back to open p0/p1; resolve takes `in_progress`
  // with the same fallback. Zero means the button would launch a session
  // with nothing to do, so the UI disables it and the flow refuses.
  const flowTargetCount = useMemo(() => {
    const active = (report?.items ?? []).filter((it) => !ARCHIVED_STATUSES.has(it.status));
    const byStatus = (s: string) => active.filter((it) => it.status === s).length;
    const urgentOpen = active.filter(
      (it) => it.status === "open" && priorityWeight(it.priority) <= 1,
    ).length;
    return {
      execute: byStatus("open"),
      review: byStatus("revision") || urgentOpen,
      resolve: byStatus("in_progress") || urgentOpen,
    };
  }, [report]);

  const totalActive = useMemo(() => {
    if (!report) return 0;
    return report.items.filter((it) => !ARCHIVED_STATUSES.has(it.status)).length;
  }, [report]);

  const priorityKeys = useMemo(() => {
    if (!report) return [] as string[];
    return Array.from(new Set(report.items.map((it) => it.priority).filter(Boolean))).sort();
  }, [report]);

  function toggleExpanded(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  }

  function startNew() {
    setModalError(null);
    setModalState({ ...EMPTY_FORM });
  }

  function startEdit(p: PlanItem) {
    setModalError(null);
    setModalState({
      id: p.id,
      title: p.title,
      priority: p.priority || "p3",
      kind: p.kind || "task",
      description: p.description ?? "",
      tags: p.tags.join(", "),
    });
  }

  return {
    // state
    report,
    loading,
    error,
    query,
    setQuery,
    priorityFilter,
    expanded,
    modalState,
    setModalState,
    modalBusy,
    modalError,
    pendingDelete,
    setPendingDelete,
    deleteBusy,
    pendingClean,
    setPendingClean,
    cleanBusy,
    info,
    aiBusy,
    archivedOpen,
    setArchivedOpen,
    archivedDays,
    setArchivedDays,
    draggingId,
    setDraggingId,
    dragOverColumn,
    setDragOverColumn,
    // derived
    filtered,
    archivedItems,
    grouped,
    resolvedCount,
    flowTargetCount,
    totalActive,
    priorityKeys,
    // actions
    load,
    move,
    submitPlan,
    confirmDelete,
    spawnClaudePlanFlow,
    aiSprintPlan,
    cleanResolved,
    openResolutionSession,
    togglePriority,
    toggleExpanded,
    startNew,
    startEdit,
  };
}

// Local helper — needed for sorting inside the hook's `grouped` memo.
function priorityWeight(p: string): number {
  const m = p.match(/p(\d+)/i);
  if (!m) return 99;
  return parseInt(m[1], 10);
}
