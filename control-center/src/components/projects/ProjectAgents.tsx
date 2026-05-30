// ULTRON Control Center — ProjectAgents (P0 rewrite 2026-05-27)
//
// Orquestador real conectado a sesión activa.
//
// Secciones:
//   1. Agent Team — cards de la plantilla del proyecto (agent-roster.json).
//      Cada card tiene botón "Invoke from session" que escribe la instrucción
//      en la PTY activa del proyecto.
//   2. "Propose roster (AI)" — llama a project_propose_agent_roster + modal
//      de confirmación con recommended + gaps. Confirmar persiste el roster.
//   3. "+ Add agent" — picker overlay del catálogo global (conservado de v2.6).
//   4. Generate — CreateSkillFromProjectButton (conservado).
//
// Identificación de sesión activa: project_invoke_agent_from_session elige
// la PTY Running más reciente del proyecto (lógica en el backend).
// Si no hay sesión activa, el botón muestra "No hay sesión activa" y un
// link a la pestaña Terminal.
//
// Lo eliminado vs v2.6:
//   - Tile "AI Configure Team Beta" (heurístico local sin AI real).
//   - Sección Workflows con pills Beta y toasts vacíos.
//   - proposeTeam() / detectLanguages() / LANG_RULES — toda la lógica
//     heurística local. El backend la hace mejor con ai_router.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Bot, Check, Circle, Plus, Sparkles, Tag, X } from "./icons";
import type { KanbanBoard } from "../../types";
import { categorize } from "../../lib/skill-categories";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = { projectId: string; projectPath: string };

type AgentEntry = {
  name: string;
  path: string;
  description: string;
  origin: "global" | "project" | "plugin";
};

type PinnedAgents = {
  pinned: string[];
  roles?: Record<string, string>;
};

// Roster types — mirror project_agents.rs
type RosterEntry = {
  name: string;
  reason: string;
  suggested_role: string;
};

type GapEntry = {
  suggested_name: string;
  reason: string;
};

type AgentRosterProposal = {
  recommended: RosterEntry[];
  gaps: GapEntry[];
  detected_stack: string[];
};

type AgentRosterFile = {
  entries: RosterEntry[];
};

type InvokeResult = {
  pty_id: string;
  sent: boolean;
};

// Skill suggestion types — mirror project_propose_skill_roster response
type SkillSuggestion = {
  name: string;
  reason: string;
  tags: string[];
};

type SkillRosterProposal = {
  suggestions: SkillSuggestion[];
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CATEGORIES = "__all__";
const NO_CATEGORY = "Uncategorized";

// ---------------------------------------------------------------------------
// Visual helpers
// ---------------------------------------------------------------------------

function originStyle(origin: AgentEntry["origin"]): {
  background: string;
  color: string;
  border: string;
} {
  switch (origin) {
    case "global":
      return {
        background: "var(--color-surface-3)",
        color: "var(--color-text)",
        border: "1px solid var(--color-border-strong)",
      };
    case "project":
      return {
        background: "rgba(136, 136, 204, 0.16)",
        color: "#b6b6ff",
        border: "1px solid rgba(136, 136, 204, 0.40)",
      };
    case "plugin":
      return {
        background: "rgba(231, 187, 99, 0.16)",
        color: "#e0af68",
        border: "1px solid rgba(231, 187, 99, 0.40)",
      };
  }
}

function deriveCategory(a: AgentEntry): string {
  const domain = categorize(a.name, a.description);
  if (domain) return domain;
  if (a.origin === "plugin") {
    const norm = a.path.replace(/\\/g, "/");
    const m = norm.match(/\/plugins\/cache\/[^/]+\/([^/]+)\//);
    if (m && m[1]) return `Plugin · ${m[1]}`;
  }
  return NO_CATEGORY;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ProjectAgents({ projectId, projectPath }: Props) {
  // Global agent catalogue (for picker)
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  // Legacy pinned list — kept for the kanban default-agent select and picker
  const [pinned, setPinned] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  // New: roster from agent-roster.json
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [board, setBoard] = useState<KanbanBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Picker overlay state
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const [pickerCategory, setPickerCategory] = useState<string>(ALL_CATEGORIES);

  // Inline role editor for roster cards
  const [editingRoleFor, setEditingRoleFor] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState("");

  // Invoke-from-session state per card
  const [invokingFor, setInvokingFor] = useState<string | null>(null);
  const [invokeTaskFor, setInvokeTaskFor] = useState<string | null>(null);
  const [invokePrompt, setInvokePrompt] = useState("");

  // AI propose roster modal
  const [proposeOpen, setProposeOpen] = useState(false);
  const [proposal, setProposal] = useState<AgentRosterProposal | null>(null);
  const [proposeBusy, setProposeBusy] = useState(false);
  const [proposeError, setProposeError] = useState<string | null>(null);
  const [proposeSelected, setProposeSelected] = useState<Set<string>>(new Set());

  // AI propose skills modal
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsProposal, setSkillsProposal] = useState<SkillRosterProposal | null>(null);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);

  // Abort controller for in-flight invoke requests
  const invokeAbort = useRef<AbortController | null>(null);

  // ---------------------------------------------------------------------------
  // Load
  // ---------------------------------------------------------------------------

  const loadAll = useCallback(async () => {
    try {
      const [p, list, b, rosterFile] = await Promise.all([
        invoke("agents_pinned_load", { projectId }) as Promise<PinnedAgents>,
        invoke("list_agents", { projectPath: null }) as Promise<AgentEntry[]>,
        invoke("kanban_load", { projectId }) as Promise<KanbanBoard>,
        invoke("project_roster_load", { projectId }) as Promise<AgentRosterFile>,
      ]);
      setPinned(p.pinned);
      setRoles(p.roles ?? {});
      setAgents(list);
      setBoard(b);
      setRoster(rosterFile.entries);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // ESC closes modals
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pickerOpen) setPickerOpen(false);
      if (proposeOpen) setProposeOpen(false);
      if (skillsOpen) setSkillsOpen(false);
      if (invokeTaskFor) setInvokeTaskFor(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pickerOpen, proposeOpen, skillsOpen, invokeTaskFor]);

  // ---------------------------------------------------------------------------
  // Persist pinned (for picker and kanban default-agent)
  // ---------------------------------------------------------------------------

  const persistPinned = useCallback(
    async (nextPinned: string[], nextRoles: Record<string, string>) => {
      setPinned(nextPinned);
      setRoles(nextRoles);
      try {
        await invoke("agents_pinned_save", {
          projectId,
          pinned: { pinned: nextPinned, roles: nextRoles },
        });
      } catch (e) {
        setError(String(e));
        await loadAll();
      }
    },
    [projectId, loadAll],
  );

  // TODO: remove orphan pin_agent command (agents_pinned_save is still used by kanban selector)


  // ---------------------------------------------------------------------------
  // Roster persistence
  // ---------------------------------------------------------------------------

  const persistRoster = useCallback(
    async (entries: RosterEntry[]) => {
      setRoster(entries);
      try {
        await invoke("project_roster_save", { projectId, entries });
      } catch (e) {
        setError(String(e));
        await loadAll();
      }
    },
    [projectId, loadAll],
  );

  const removeFromRoster = useCallback(
    (name: string) => {
      void persistRoster(roster.filter((e) => e.name !== name));
    },
    [roster, persistRoster],
  );

  const saveRosterRole = useCallback(
    (name: string, role: string) => {
      const trimmed = role.trim();
      const next = roster.map((e) =>
        e.name === name
          ? { ...e, suggested_role: trimmed || e.suggested_role }
          : e,
      );
      void persistRoster(next);
      setEditingRoleFor(null);
      setRoleDraft("");
    },
    [roster, persistRoster],
  );

  // ---------------------------------------------------------------------------
  // Kanban default agent
  // ---------------------------------------------------------------------------

  const setDefaultAgent = useCallback(
    async (slug: string | null) => {
      if (!board) return;
      const next: KanbanBoard = { ...board, default_agent: slug };
      try {
        await invoke("kanban_save", { board: next });
        setBoard(next);
      } catch (e) {
        setError(String(e));
      }
    },
    [board],
  );

  // ---------------------------------------------------------------------------
  // Invoke from active session
  // ---------------------------------------------------------------------------

  const invokeFromSession = useCallback(
    async (agentName: string, taskPrompt: string) => {
      // Cancel any previous in-flight invoke
      invokeAbort.current?.abort();
      const ctrl = new AbortController();
      invokeAbort.current = ctrl;

      setInvokingFor(agentName);
      try {
        const result = (await invoke("project_invoke_agent_from_session", {
          projectId,
          agentName,
          taskPrompt,
        })) as InvokeResult;
        if (!ctrl.signal.aborted) {
          setToast(
            result.sent
              ? `Delegado a ${agentName} en sesión ${result.pty_id.slice(-8)}`
              : `No se pudo enviar a ${agentName}`,
          );
          setInvokeTaskFor(null);
          setInvokePrompt("");
        }
      } catch (e) {
        if (!ctrl.signal.aborted) {
          setToast(String(e));
        }
      } finally {
        if (!ctrl.signal.aborted) setInvokingFor(null);
      }
    },
    [projectId],
  );

  // ---------------------------------------------------------------------------
  // AI propose roster
  // ---------------------------------------------------------------------------

  const openPropose = useCallback(async () => {
    setProposeBusy(true);
    setProposeError(null);
    setProposal(null);
    setProposeOpen(true);
    try {
      const result = (await invoke("project_propose_agent_roster", {
        projectId,
        projectPath,
      })) as AgentRosterProposal;
      setProposal(result);
      setProposeSelected(new Set(result.recommended.map((r) => r.name)));
    } catch (e) {
      setProposeError(String(e));
    } finally {
      setProposeBusy(false);
    }
  }, [projectId, projectPath]);

  const applyProposal = useCallback(async () => {
    if (!proposal) return;
    const selected = proposal.recommended.filter((r) =>
      proposeSelected.has(r.name),
    );
    if (selected.length === 0) return;
    // Merge into roster — skip duplicates, keep existing roles
    const existingNames = new Set(roster.map((e) => e.name));
    const toAdd = selected.filter((r) => !existingNames.has(r.name));
    await persistRoster([...roster, ...toAdd]);
    // Also pin new agents so they show in the kanban selector
    const newPinned = toAdd
      .map((r) => r.name)
      .filter((n) => !pinned.includes(n));
    if (newPinned.length > 0) {
      await persistPinned([...pinned, ...newPinned], roles);
    }
    setProposeOpen(false);
    setToast(
      `${toAdd.length} agente${toAdd.length === 1 ? "" : "s"} añadido${toAdd.length === 1 ? "" : "s"} al roster`,
    );
  }, [proposal, proposeSelected, roster, pinned, roles, persistRoster, persistPinned]);

  // ---------------------------------------------------------------------------
  // AI propose skills
  // ---------------------------------------------------------------------------

  const openSkillsPropose = useCallback(async () => {
    setSkillsBusy(true);
    setSkillsError(null);
    setSkillsProposal(null);
    setSkillsOpen(true);
    try {
      const result = (await invoke("project_propose_skill_roster", {
        projectPath,
      })) as SkillRosterProposal;
      setSkillsProposal(result);
    } catch (e) {
      setSkillsError(String(e));
    } finally {
      setSkillsBusy(false);
    }
  }, [projectPath]);

  // ---------------------------------------------------------------------------
  // Picker helpers
  // ---------------------------------------------------------------------------

  const pickerCandidates = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    return agents
      .filter((a) => !pinned.includes(a.name))
      .filter(
        (a) =>
          q === "" ||
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      )
      .filter(
        (a) =>
          pickerCategory === ALL_CATEGORIES ||
          deriveCategory(a) === pickerCategory,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [agents, pinned, pickerQuery, pickerCategory]);

  const pickerCategoryCounts = useMemo(() => {
    const q = pickerQuery.trim().toLowerCase();
    const counts = new Map<string, number>();
    for (const a of agents) {
      if (pinned.includes(a.name)) continue;
      if (
        q !== "" &&
        !a.name.toLowerCase().includes(q) &&
        !a.description.toLowerCase().includes(q)
      )
        continue;
      const cat = deriveCategory(a);
      counts.set(cat, (counts.get(cat) ?? 0) + 1);
    }
    return counts;
  }, [agents, pinned, pickerQuery]);

  const sortedCategories = useMemo(() => {
    const list = Array.from(pickerCategoryCounts.entries());
    list.sort((a, b) => {
      if (a[0] === NO_CATEGORY) return 1;
      if (b[0] === NO_CATEGORY) return -1;
      return a[0].localeCompare(b[0]);
    });
    return list;
  }, [pickerCategoryCounts]);

  const totalUnpinned = useMemo(
    () =>
      Array.from(pickerCategoryCounts.values()).reduce(
        (sum, n) => sum + n,
        0,
      ),
    [pickerCategoryCounts],
  );

  // Agent catalogue lookup (for picker-added agents not yet in roster)
  const agentByName = useMemo(
    () => new Map(agents.map((a) => [a.name, a] as const)),
    [agents],
  );

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-xs">
        <span className="text-[var(--color-text-muted)]">Default agent:</span>
        <select
          value={board?.default_agent ?? ""}
          onChange={(e) => void setDefaultAgent(e.target.value || null)}
          className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 py-1"
          title="Usado por el kanban cuando una card no tiene agente explícito."
        >
          <option value="">(ninguno)</option>
          {roster.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name}
            </option>
          ))}
          {pinned
            .filter((n) => !roster.some((e) => e.name === n))
            .map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
        </select>

        {/* Propose roster (AI) — llama al backend real */}
        <button
          type="button"
          onClick={() => void openPropose()}
          disabled={proposeBusy}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/15 px-2 py-1 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/25 disabled:opacity-40"
          title="El AI Router analiza el stack del proyecto y sugiere los agentes óptimos."
        >
          {proposeBusy ? "Analizando…" : "Propose roster (AI)"}
        </button>

        {/* Proponer skills (AI) */}
        <button
          type="button"
          onClick={() => void openSkillsPropose()}
          disabled={skillsBusy}
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-2 py-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-3)] disabled:opacity-40"
          title="El AI Router analiza el proyecto y sugiere qué skills activar."
        >
          <Sparkles size={11} />
          {skillsBusy ? "Analizando…" : "Proponer skills (AI)"}
        </button>

        <button
          type="button"
          onClick={() => {
            setPickerQuery("");
            setPickerCategory(ALL_CATEGORIES);
            setPickerOpen(true);
          }}
          className="inline-flex items-center gap-1 rounded-md border border-[var(--color-border)] px-2 py-1 hover:bg-[var(--color-surface-2)]"
          title="Añadir agente del catálogo global al proyecto."
        >
          <Plus size={12} />
          Add agent
        </button>

        {error && (
          <span
            className="ml-2 text-[var(--color-error)]"
            title={error}
            onClick={() => setError(null)}
          >
            error
          </span>
        )}
      </div>

      {/* ── Main scroll area ── */}
      <div className="flex-1 overflow-y-auto px-3 py-3">
        {/* Agent Team */}
        <section className="mb-5">
          <h3 className="mb-1 text-[11.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Agent Team ({roster.length})
          </h3>
          <p className="mb-2 text-[11.5px] text-[var(--color-text-muted)]">
            Plantilla de agentes del proyecto. "Invoke from session" escribe la
            instrucción en la terminal activa; Claude Code delega al subagente.
          </p>

          {roster.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] bg-[var(--color-surface-0)] p-4 text-center text-xs text-[var(--color-text-muted)]">
              El roster está vacío.{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void openPropose()}
              >
                Proponer roster con AI
              </button>{" "}
              o{" "}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setPickerQuery("");
                  setPickerCategory(ALL_CATEGORIES);
                  setPickerOpen(true);
                }}
              >
                añadir agente manualmente
              </button>
              .
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {roster.map((entry) => {
                const catalogAgent = agentByName.get(entry.name);
                const isEditing = editingRoleFor === entry.name;
                const isInvoking = invokingFor === entry.name;
                const isTaskOpen = invokeTaskFor === entry.name;
                const chip = catalogAgent
                  ? originStyle(catalogAgent.origin)
                  : {
                      background: "var(--color-surface-3)",
                      color: "var(--color-text-muted)",
                      border: "1px solid var(--color-border)",
                    };

                return (
                  <div
                    key={entry.name}
                    className="flex flex-col gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-xs transition-colors hover:border-[var(--color-border-strong)]"
                    title={
                      catalogAgent?.description ||
                      `${entry.name} — ${entry.reason}`
                    }
                  >
                    {/* Card header */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          aria-hidden
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
                          title={`Role: ${entry.suggested_role}`}
                        >
                          <Bot size={14} />
                        </span>
                        <span className="font-semibold text-[var(--color-text)]">
                          {entry.name}
                        </span>
                      </div>
                      <span
                        className="rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                        style={chip}
                      >
                        {catalogAgent?.origin ?? "roster"}
                      </span>
                    </div>

                    {/* Role badge — inline editable */}
                    <div>
                      {isEditing ? (
                        <input
                          autoFocus
                          value={roleDraft}
                          onChange={(e) => setRoleDraft(e.target.value)}
                          onBlur={() => saveRosterRole(entry.name, roleDraft)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              saveRosterRole(entry.name, roleDraft);
                            } else if (e.key === "Escape") {
                              setEditingRoleFor(null);
                              setRoleDraft("");
                            }
                          }}
                          placeholder="Role (p.ej. Backend reviewer, QA)…"
                          className="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-0)] px-1.5 py-0.5 text-[11px] outline-none"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingRoleFor(entry.name);
                            setRoleDraft(entry.suggested_role);
                          }}
                          className="inline-flex items-center gap-1 rounded border border-dashed border-[var(--color-border)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-2)]"
                          title="Editar el rol de este agente en el proyecto."
                        >
                          {entry.suggested_role ? (
                            <span style={{ color: "var(--color-text)" }}>
                              {entry.suggested_role}
                            </span>
                          ) : (
                            <span className="italic text-[var(--color-text-faint)]">
                              + Asignar rol
                            </span>
                          )}
                        </button>
                      )}
                    </div>

                    {/* Description / reason */}
                    <p className="line-clamp-2 flex-1 text-[var(--color-text-muted)]">
                      {catalogAgent?.description || entry.reason || (
                        <span className="italic text-[var(--color-text-faint)]">
                          Sin descripción.
                        </span>
                      )}
                    </p>

                    {/* Invoke task input — expands inline */}
                    {isTaskOpen && (
                      <div className="flex flex-col gap-1.5 rounded border border-[var(--color-accent)]/40 bg-[var(--color-surface-0)] p-2">
                        <label className="text-[10.5px] text-[var(--color-text-secondary)]">
                          Tarea para{" "}
                          <span className="font-semibold text-[var(--color-accent)]">
                            {entry.name}
                          </span>
                          :
                        </label>
                        <textarea
                          autoFocus
                          value={invokePrompt}
                          onChange={(e) => setInvokePrompt(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                              e.preventDefault();
                              if (invokePrompt.trim()) {
                                void invokeFromSession(
                                  entry.name,
                                  invokePrompt.trim(),
                                );
                              }
                            } else if (e.key === "Escape") {
                              setInvokeTaskFor(null);
                              setInvokePrompt("");
                            }
                          }}
                          placeholder="Describe la tarea… (Ctrl+Enter para enviar)"
                          rows={2}
                          className="w-full resize-none rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1 text-[11px] outline-none"
                        />
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              setInvokeTaskFor(null);
                              setInvokePrompt("");
                            }}
                            className="rounded border border-[var(--color-border)] px-2 py-0.5 text-[10.5px] hover:bg-[var(--color-surface-2)]"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={!invokePrompt.trim() || isInvoking}
                            onClick={() =>
                              void invokeFromSession(
                                entry.name,
                                invokePrompt.trim(),
                              )
                            }
                            className="rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-2 py-0.5 text-[10.5px] text-[var(--color-accent)] disabled:opacity-40"
                          >
                            {isInvoking ? "Enviando…" : "Enviar"}
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Footer actions */}
                    {!isTaskOpen && (
                      <div className="mt-1 flex items-center justify-between gap-1">
                        <button
                          type="button"
                          disabled={isInvoking}
                          onClick={() => {
                            setInvokeTaskFor(entry.name);
                            setInvokePrompt("");
                          }}
                          className="inline-flex items-center gap-1 rounded border border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 px-2 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20 disabled:opacity-40"
                          title="Escribe la instrucción en la sesión activa del proyecto."
                        >
                          {isInvoking ? "Invocando…" : "Invoke from session"}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeFromRoster(entry.name)}
                          className="inline-flex items-center gap-1 rounded border border-[var(--color-border)] px-2 py-0.5 text-[10.5px] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-text)]"
                          title="Quitar del roster del proyecto."
                        >
                          <X size={10} /> Quitar
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* No-session hint — shown only when roster has agents */}
        {roster.length > 0 && (
          <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2 text-[11px] text-[var(--color-text-muted)]">
            "Invoke from session" escribe en la terminal activa del proyecto.
            Si no hay ninguna abierta, el botón devolverá un error con
            instrucciones para abrir una.
          </div>
        )}

        {/* Generate skill */}
        <section className="mt-2">
          <h3 className="mb-2 text-[11.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
            Generate
          </h3>
          <CreateSkillFromProjectButton
            projectId={projectId}
            projectPath={projectPath}
          />
        </section>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-3)] px-3 py-2 text-xs text-[var(--color-text)] shadow-lg"
        >
          {toast}
        </div>
      )}

      {/* ── Propose roster modal ── */}
      {proposeOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Propose agent roster"
          onClick={() => setProposeOpen(false)}
        >
          <div
            className="flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-4 text-xs shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Propose roster (AI)</h2>
              <button
                type="button"
                onClick={() => setProposeOpen(false)}
                aria-label="Cerrar"
                className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-3)]"
              >
                <X size={12} />
              </button>
            </div>

            {/* Stack detected */}
            {proposal && (
              <p className="text-[var(--color-text-secondary)]">
                Stack detectado:{" "}
                {proposal.detected_stack.length === 0 ? (
                  <span className="italic text-[var(--color-text-muted)]">
                    no se detectó stack — se proponen agentes generales.
                  </span>
                ) : (
                  proposal.detected_stack.map((s) => (
                    <span
                      key={s}
                      className="mr-1 inline-block rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[10.5px]"
                    >
                      {s}
                    </span>
                  ))
                )}
              </p>
            )}

            {/* Loading skeleton */}
            {proposeBusy && (
              <div className="flex flex-col gap-1.5 py-4">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-12 animate-pulse rounded bg-[var(--color-surface-3)]"
                  />
                ))}
                <p className="mt-1 text-center text-[10.5px] text-[var(--color-text-muted)]">
                  El AI Router analiza el proyecto…
                </p>
              </div>
            )}

            {/* Error */}
            {proposeError && (
              <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-[var(--color-error)]">
                {proposeError}
              </div>
            )}

            {/* Recommended */}
            {!proposeBusy && proposal && (
              <>
                {proposal.recommended.length === 0 ? (
                  <div className="rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-center text-[var(--color-text-muted)]">
                    No hay agentes nuevos que sugerir — el roster ya tiene los
                    relevantes.
                  </div>
                ) : (
                  <div className="max-h-[40vh] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2">
                    <p className="mb-1.5 text-[10.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
                      Recomendados ({proposal.recommended.length})
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {proposal.recommended.map((r) => {
                        const selected = proposeSelected.has(r.name);
                        const catalogAgent = agentByName.get(r.name);
                        return (
                          <button
                            key={r.name}
                            type="button"
                            onClick={() => {
                              const next = new Set(proposeSelected);
                              if (next.has(r.name)) next.delete(r.name);
                              else next.add(r.name);
                              setProposeSelected(next);
                            }}
                            className="flex items-start gap-2 rounded-md border p-2 text-left transition-colors"
                            style={{
                              background: selected
                                ? "var(--color-surface-3)"
                                : "var(--color-surface-1)",
                              borderColor: selected
                                ? "var(--color-accent)"
                                : "var(--color-border)",
                            }}
                            title={catalogAgent?.description || r.reason}
                          >
                            <span
                              aria-hidden
                              className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
                            >
                              <Bot size={14} />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-semibold text-[var(--color-text)]">
                                {r.name}
                              </div>
                              <div className="text-[10.5px] text-[var(--color-accent)]">
                                {r.suggested_role}
                              </div>
                              <p className="mt-0.5 line-clamp-2 text-[10.5px] text-[var(--color-text-muted)]">
                                {r.reason}
                              </p>
                            </div>
                            <span
                              aria-hidden
                              className="grid shrink-0 place-items-center"
                              style={{
                                color: selected
                                  ? "var(--color-accent)"
                                  : "var(--color-text-faint)",
                              }}
                            >
                              {selected ? <Check size={14} /> : <Circle size={14} />}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Gaps */}
                {proposal.gaps.length > 0 && (
                  <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2">
                    <p className="mb-1.5 text-[10.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
                      Gaps detectados — agentes que no existen aún
                    </p>
                    <div className="flex flex-col gap-1">
                      {proposal.gaps.map((g) => (
                        <div
                          key={g.suggested_name}
                          className="flex items-start gap-2 rounded border border-dashed border-[var(--color-border)] px-2 py-1.5"
                        >
                          <div>
                            <span className="font-semibold text-[var(--color-text-secondary)]">
                              {g.suggested_name}
                            </span>
                            <span className="ml-1.5 text-[var(--color-text-muted)]">
                              — {g.reason}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="flex items-center justify-between gap-2 pt-1 text-[var(--color-text-muted)]">
              <span>
                {proposeSelected.size} de{" "}
                {proposal?.recommended.length ?? 0} seleccionados
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setProposeOpen(false)}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-3)]"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void applyProposal()}
                  disabled={
                    proposeBusy ||
                    proposeSelected.size === 0 ||
                    proposal === null
                  }
                  className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-3 py-1 text-[var(--color-accent)] disabled:opacity-40"
                >
                  Aplicar roster
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Propose skills modal ── */}
      {skillsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Proponer skills para el proyecto"
          onClick={() => setSkillsOpen(false)}
        >
          <div
            className="flex w-full max-w-2xl flex-col gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-4 text-xs shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sparkles size={14} />
                <h2 className="text-sm font-semibold">Skills sugeridas (AI)</h2>
              </div>
              <button
                type="button"
                onClick={() => setSkillsOpen(false)}
                aria-label="Cerrar"
                className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-3)]"
              >
                <X size={12} />
              </button>
            </div>

            {/* Aviso de persistencia */}
            <p className="rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] px-3 py-2 text-[var(--color-text-muted)]">
              Estas sugerencias son de solo lectura por ahora. La asociación
              persistente de skills al proyecto llegará en una versión próxima.
            </p>

            {/* Loading skeleton */}
            {skillsBusy && (
              <div className="flex flex-col gap-1.5 py-4">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-14 animate-pulse rounded bg-[var(--color-surface-3)]"
                  />
                ))}
                <p className="mt-1 text-center text-[10.5px] text-[var(--color-text-muted)]">
                  El AI Router analiza el proyecto…
                </p>
              </div>
            )}

            {/* Error */}
            {skillsError && (
              <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-[var(--color-error)]">
                {skillsError}
              </div>
            )}

            {/* Sugerencias */}
            {!skillsBusy && skillsProposal && (
              <>
                {skillsProposal.suggestions.length === 0 ? (
                  <div className="rounded border border-dashed border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-center text-[var(--color-text-muted)]">
                    No se detectaron skills relevantes para este proyecto.
                  </div>
                ) : (
                  <div className="max-h-[50vh] overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2">
                    <p className="mb-1.5 text-[10.5px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
                      Sugeridas ({skillsProposal.suggestions.length})
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {skillsProposal.suggestions.map((s) => (
                        <div
                          key={s.name}
                          className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] p-2"
                        >
                          <span
                            aria-hidden
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-[var(--color-surface-3)] text-[var(--color-text-muted)]"
                          >
                            <Sparkles size={13} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-semibold text-[var(--color-text)]">
                              {s.name}
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-[10.5px] text-[var(--color-text-muted)]">
                              {s.reason}
                            </p>
                            {s.tags.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {s.tags.map((tag) => (
                                  <span
                                    key={tag}
                                    className="inline-flex items-center gap-0.5 rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[9.5px] text-[var(--color-text-secondary)]"
                                  >
                                    <Tag size={9} />
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            <div className="flex items-center justify-end pt-1">
              <button
                type="button"
                onClick={() => setSkillsOpen(false)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-3)]"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Add agent picker overlay ── */}
      {pickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Add agent to project"
          onClick={() => setPickerOpen(false)}
        >
          <div
            className="my-auto flex w-full max-w-4xl flex-col rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-3 py-2">
              <h2 className="text-sm font-semibold">Add agent to project</h2>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                aria-label="Cerrar"
                className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-3)]"
              >
                <X size={12} />
              </button>
            </div>
            <div className="border-b border-[var(--color-border)] p-2">
              <input
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Filtrar agentes por nombre o descripción…"
                className="w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] px-2 py-1.5 text-xs outline-none"
                autoFocus
              />
            </div>
            <div className="flex max-h-[60vh] min-h-[300px]">
              <aside className="w-44 shrink-0 overflow-y-auto border-r border-[var(--color-border)] p-2">
                <button
                  type="button"
                  onClick={() => setPickerCategory(ALL_CATEGORIES)}
                  className="mb-0.5 flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11.5px]"
                  style={{
                    background:
                      pickerCategory === ALL_CATEGORIES
                        ? "var(--color-surface-3)"
                        : "transparent",
                    color: "var(--color-text)",
                    border:
                      pickerCategory === ALL_CATEGORIES
                        ? "1px solid var(--color-border-strong)"
                        : "1px solid transparent",
                  }}
                >
                  <span>All</span>
                  <span className="text-[10px] text-[var(--color-text-faint)]">
                    {totalUnpinned}
                  </span>
                </button>
                {sortedCategories.map(([cat, n]) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setPickerCategory(cat)}
                    className="mb-0.5 flex w-full items-center justify-between rounded px-2 py-1 text-left text-[11.5px]"
                    style={{
                      background:
                        pickerCategory === cat
                          ? "var(--color-surface-3)"
                          : "transparent",
                      color:
                        pickerCategory === cat
                          ? "var(--color-text)"
                          : "var(--color-text-secondary)",
                      border:
                        pickerCategory === cat
                          ? "1px solid var(--color-border-strong)"
                          : "1px solid transparent",
                    }}
                  >
                    <span className="truncate" title={cat}>
                      {cat}
                    </span>
                    <span className="ml-2 shrink-0 text-[10px] text-[var(--color-text-faint)]">
                      {n}
                    </span>
                  </button>
                ))}
              </aside>

              <div className="flex-1 overflow-y-auto p-2">
                {pickerCandidates.length === 0 ? (
                  <div className="p-4 text-center text-xs text-[var(--color-text-muted)]">
                    {pinned.length === agents.length
                      ? "Todos los agentes disponibles ya están en el proyecto."
                      : "Ningún agente coincide con el filtro."}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2">
                    {pickerCandidates.map((a) => {
                      const chip = originStyle(a.origin);
                      const inRoster = roster.some((e) => e.name === a.name);
                      return (
                        <div
                          key={a.name}
                          className="flex items-start justify-between gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2 text-xs"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="truncate font-semibold">
                                {a.name}
                              </span>
                              <span
                                className="shrink-0 rounded px-1.5 py-0.5 text-[9.5px] uppercase tracking-wide"
                                style={chip}
                              >
                                {a.origin}
                              </span>
                            </div>
                            <p className="mt-0.5 line-clamp-2 text-[var(--color-text-muted)]">
                              {a.description}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-col gap-1">
                            {!inRoster && (
                              <button
                                type="button"
                                onClick={() => {
                                  void persistRoster([
                                    ...roster,
                                    {
                                      name: a.name,
                                      reason: "Added manually",
                                      suggested_role: "",
                                    },
                                  ]);
                                }}
                                className="inline-flex items-center gap-1 rounded border border-[var(--color-accent)]/60 bg-[var(--color-accent)]/10 px-2 py-1 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/20"
                                title="Añadir al roster del proyecto."
                              >
                                + Roster
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] px-3 py-2 text-xs">
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-3)]"
              >
                Listo
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreateSkillFromProjectButton — unchanged from v2.6
// ---------------------------------------------------------------------------

function CreateSkillFromProjectButton({
  projectId,
  projectPath,
}: {
  projectId: string;
  projectPath: string;
}) {
  const [open, setOpen] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const slug = useMemo(
    () => projectId.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
    [projectId],
  );
  const destination = `~/.claude/skills/project-${slug}/`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const run = async () => {
    setSpawning(true);
    setErr(null);
    const prompt =
      "Lee este proyecto (árbol, CLAUDE.md si existe, README) y crea un skill nuevo que codifique cómo trabajar aquí.\n\n" +
      `Ubicación destino: ~/.claude/skills/project-${slug}/SKILL.md\n\n` +
      "Estructura del skill:\n" +
      "- Frontmatter YAML: name (kebab-case: `project-" +
      slug +
      "`), description (cuándo activarse, no qué hace).\n" +
      "- Cuerpo: cómo arrancar el proyecto, convenciones críticas, gotchas conocidos, comandos comunes, qué NO tocar.\n\n" +
      "IMPORTANTE: La ubicación destino es ~/.claude/skills/project-" +
      slug +
      "/SKILL.md (no la carpeta del proyecto). Crea la carpeta si no existe.\n\n" +
      "Muéstrame el contenido propuesto ANTES de escribir el archivo. Espera mi OK.";
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(prompt);
      }
      await invoke("spawn_session", {
        provider: "claude",
        cwd: projectPath,
        prompt,
        flags: { dangerouslySkipPermissions: false },
      });
      setOpen(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSpawning(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex flex-col items-start gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-1)] p-3 text-left text-xs transition-colors hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-2)]"
        title="Genera un skill con SKILL.md para este proyecto."
      >
        <div className="flex w-full items-center gap-2">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: "var(--color-accent)" }}
          />
          <span className="font-semibold text-[var(--color-text)]">
            Create skill from project
          </span>
        </div>
        <p className="text-[var(--color-text-muted)]">
          Spawn a Claude session that drafts a SKILL.md describing how to work
          on this project. The skill is saved under{" "}
          <span style={{ fontFamily: "var(--font-mono)" }}>{destination}</span>{" "}
          and appears in Library → Skills.
        </p>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Create skill from project"
          onClick={() => setOpen(false)}
        >
          <div
            className="flex w-full max-w-lg flex-col gap-3 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] p-4 text-xs shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Create skill from project</h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Cerrar"
                className="rounded p-1 text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-3)]"
              >
                <X size={12} />
              </button>
            </div>
            <p className="text-[var(--color-text-secondary)]">
              Esto pedirá a Claude que analice el proyecto y proponga una skill
              útil. La skill se creará en{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {destination}
              </span>{" "}
              y aparecerá automáticamente en Library → Skills.
            </p>
            <ul className="list-disc space-y-0.5 pl-5 text-[var(--color-text-muted)]">
              <li>Claude leerá el árbol del proyecto, el CLAUDE.md y el README.</li>
              <li>
                Generará un SKILL.md con frontmatter (
                <span style={{ fontFamily: "var(--font-mono)" }}>
                  name: project-{slug}
                </span>
                ).
              </li>
              <li>
                Te enseñará el contenido propuesto antes de escribirlo — puedes
                vetar o pedir cambios.
              </li>
            </ul>
            {err && (
              <div className="rounded border border-[var(--color-error)] bg-[var(--color-surface-1)] p-2 text-[var(--color-error)]">
                {err}
              </div>
            )}
            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={spawning}
                className="rounded-md border border-[var(--color-border)] px-3 py-1 hover:bg-[var(--color-surface-3)] disabled:opacity-40"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void run()}
                disabled={spawning}
                className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-3 py-1 text-[var(--color-accent)] disabled:opacity-40"
              >
                {spawning ? "Spawning…" : "Spawn Claude session"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
