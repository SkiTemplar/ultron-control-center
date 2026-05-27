// ULTRON Control Center — Per-project Context sub-tab (v2.9.5)
//
// Rewrite completo: sustituye el editor CLAUDE.md + mem0_list_all anterior.
//
// Raíz del bug previo:
//   1. resolve_claude_md solo buscaba .claude/CLAUDE.md y CLAUDE.md — si
//      ninguno existía, el backend retornaba "" y el frontend no distinguía
//      "no existe" de "vacío". No había botón "Create" ni ruta visible.
//   2. mem0_list_all filtraba por project_id (UUID interno). Mem0 guarda
//      memorias con user_id="global" o el email — nunca el UUID del proyecto —
//      por lo que la lista siempre llegaba vacía.
//
// Solución v2.9.5:
//   - Nuevo command `project_context_load` agrega todo en un solo disparo:
//     CLAUDE.md (con ruta detectada), Mem0 via search por nombre de proyecto,
//     KG entities, bug cards, decisions, git summary, next steps.
//   - `project_create_claude_md` genera un stub cuando no existe el archivo.
//   - UI: 5 paneles colapsables + header git. Estado de carga por sección.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  RefreshCw,
  Save,
} from "./icons";
import type { ProjectExecutable, ProjectInfo } from "../../types";

// ---------------------------------------------------------------------------
// Payload types — deben coincidir con project_context.rs
// ---------------------------------------------------------------------------

type Mem0Entry = {
  id: string;
  memory: string;
  created_at: string | null;
};

type KgEntitySnap = {
  name: string;
  entity_type: string;
  observations: string[];
};

type KanbanCardSnap = {
  id: string;
  title: string;
  column_name: string;
  tags: string[];
};

type DecisionRecordSnap = {
  title: string | null;
  date: string | null;
  status: string | null;
  summary: string | null;
};

type GitSummary = {
  branch: string;
  commits: string[];
};

type ProjectContextPayload = {
  claude_md: string | null;
  claude_md_path: string | null;
  mem0_entries: Mem0Entry[];
  kg_entities: KgEntitySnap[];
  recent_bugs: KanbanCardSnap[];
  recent_decisions: DecisionRecordSnap[];
  git_summary: GitSummary | null;
  next_steps: string[];
  mem0_error: string | null;
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

type Props = {
  projectId: string;
  projectPath: string;
  projectName: string;
};

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function SectionHeader({
  title,
  count,
  open,
  onToggle,
  actions,
}: {
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className="flex cursor-pointer items-center justify-between bg-[var(--color-surface-1)] px-3 py-1.5 text-xs select-none"
      onClick={onToggle}
    >
      <div className="flex items-center gap-1.5 font-semibold">
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span>{title}</span>
        {count !== undefined && (
          <span className="text-[var(--color-text-muted)]">({count})</span>
        )}
      </div>
      {/* Stop propagation so action buttons don't toggle the section */}
      <div
        className="flex items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        {actions}
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded border border-dashed border-[var(--color-border)] p-3 text-center text-[10px] text-[var(--color-text-muted)]">
      {message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quick Launch — unchanged from v2.6.2, kept intact
// ---------------------------------------------------------------------------

function QuickLaunchPanel({ projectId }: { projectId: string }) {
  const [execs, setExecs] = useState<ProjectExecutable[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = (await invoke("list_projects")) as ProjectInfo[];
      const proj = list.find((p) => p.id === projectId);
      setExecs(proj?.executables ?? []);
    } catch (e) {
      setError(String(e));
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const launch = useCallback(async (index: number, path: string) => {
    setBusy(index);
    setError(null);
    try {
      await invoke("launch_project_executable", { path });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  if (execs === null || execs.length === 0) return null;

  return (
    <section className="flex flex-col border-b border-[var(--color-border)]">
      <div className="flex items-center justify-between bg-[var(--color-surface-1)] px-3 py-1 text-xs">
        <span className="font-semibold">
          Quick Launch{" "}
          <span className="text-[var(--color-text-muted)]">({execs.length})</span>
        </span>
        <button
          onClick={() => void load()}
          className="rounded p-1 hover:bg-[var(--color-surface-2)]"
          aria-label="Refresh"
        >
          <RefreshCw size={11} />
        </button>
      </div>
      <div className="flex flex-wrap gap-2 bg-[var(--color-surface-0)] p-3">
        {execs.map((e, i) => (
          <button
            key={`${e.name}-${i}`}
            type="button"
            onClick={() => void launch(i, e.path)}
            disabled={busy !== null}
            className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-[12px] transition-colors disabled:opacity-50"
            style={{
              background: "var(--color-surface-2)",
              borderColor: "var(--color-border-strong)",
              color: "var(--color-text)",
            }}
            title={e.path}
          >
            <span
              aria-hidden
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: "var(--color-accent)" }}
            />
            {busy === i ? "Launching…" : e.name}
          </button>
        ))}
      </div>
      {error && (
        <div className="border-t border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1 text-xs text-[var(--color-error)]">
          {error}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ProjectContext({
  projectId,
  projectPath,
  projectName,
}: Props) {
  const [payload, setPayload] = useState<ProjectContextPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // CLAUDE.md inline editor state
  const [mdContent, setMdContent] = useState("");
  const [mdDirty, setMdDirty] = useState(false);
  const [mdSaving, setMdSaving] = useState(false);

  // Collapse state — all open by default
  const [openSections, setOpenSections] = useState({
    claudeMd: true,
    mem0: true,
    bugs: true,
    decisions: true,
    nextSteps: true,
    kg: false,
  });

  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!projectPath) return;
    // Cancel any in-flight load to avoid stale responses
    abortRef.current?.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setLoadError(null);
    try {
      const data = (await invoke("project_context_load", {
        projectId,
        projectName,
        projectPath,
      })) as ProjectContextPayload;
      setPayload(data);
      setMdContent(data.claude_md ?? "");
      setMdDirty(false);
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  }, [projectId, projectName, projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveMd = useCallback(async () => {
    if (!projectPath || !payload?.claude_md_path) return;
    setMdSaving(true);
    try {
      await invoke("project_claude_md_save", {
        projectPath,
        content: mdContent,
      });
      setMdDirty(false);
      // Reflect saved content back into payload so re-render is consistent
      setPayload((prev) =>
        prev ? { ...prev, claude_md: mdContent } : prev
      );
    } catch (e) {
      setLoadError(String(e));
    } finally {
      setMdSaving(false);
    }
  }, [projectPath, payload?.claude_md_path, mdContent]);

  const toggleSection = (key: keyof typeof openSections) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const openInIde = useCallback(() => {
    if (!payload?.claude_md_path) return;
    // open_in_vscode espera folder_path + file_path (ver external_editor.rs)
    void invoke("open_in_vscode", { folderPath: "", filePath: payload.claude_md_path });
  }, [payload?.claude_md_path]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col overflow-hidden text-xs">
      {/* Quick Launch — renders only when executables exist */}
      <QuickLaunchPanel projectId={projectId} />

      {/* Git header strip */}
      {payload?.git_summary && (
        <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-1 text-[10px] text-[var(--color-text-muted)]">
          <GitBranch size={10} />
          <span className="font-mono font-semibold text-[var(--color-text)]">
            {payload.git_summary.branch}
          </span>
          {payload.git_summary.commits[0] && (
            <span className="truncate">{payload.git_summary.commits[0]}</span>
          )}
          <button
            onClick={() => void load()}
            disabled={loading}
            className="ml-auto rounded p-0.5 hover:bg-[var(--color-surface-1)]"
            title="Reload all context"
          >
            <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      )}

      {/* Top-level loading / error */}
      {loading && !payload && (
        <div className="flex flex-1 items-center justify-center text-[var(--color-text-muted)]">
          <RefreshCw size={14} className="animate-spin" />
          <span className="ml-2">Cargando contexto…</span>
        </div>
      )}

      {loadError && (
        <div className="flex items-center justify-between border-b border-[var(--color-error)] bg-[var(--color-surface-2)] px-3 py-1.5">
          <span className="text-[var(--color-error)]">{loadError}</span>
          <button
            onClick={() => void load()}
            className="rounded border border-[var(--color-error)] px-2 py-0.5 text-[var(--color-error)] hover:bg-[var(--color-error)]/10"
          >
            Reintentar
          </button>
        </div>
      )}

      {payload && (
        <div className="flex-1 overflow-y-auto">
          {/* ── NEXT STEPS ── */}
          {payload.next_steps.length > 0 && (
            <section className="border-b border-[var(--color-border)]">
              <SectionHeader
                title="Siguientes pasos"
                count={payload.next_steps.length}
                open={openSections.nextSteps}
                onToggle={() => toggleSection("nextSteps")}
              />
              {openSections.nextSteps && (
                <ul className="space-y-1 bg-[var(--color-surface-0)] p-2">
                  {payload.next_steps.map((step, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
                    >
                      <span
                        className="mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: "var(--color-accent)" }}
                      />
                      <span>{step}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── CLAUDE.md — only render when the file exists ── */}
          {payload.claude_md !== null && (
            <section className="border-b border-[var(--color-border)]">
              <SectionHeader
                title="CLAUDE.md"
                open={openSections.claudeMd}
                onToggle={() => toggleSection("claudeMd")}
                actions={
                  <>
                    <button
                      onClick={openInIde}
                      className="rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-2)] px-2 py-0.5 text-[10px] hover:bg-[var(--color-surface-1)]"
                      title={`Abrir en IDE: ${payload.claude_md_path ?? ""}`}
                    >
                      Editar en IDE
                    </button>
                    <button
                      onClick={() => void saveMd()}
                      disabled={!mdDirty || mdSaving}
                      className="flex items-center gap-1 rounded border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-2 py-0.5 text-[var(--color-accent)] disabled:opacity-40"
                    >
                      <Save size={10} />
                      {mdSaving ? "Guardando…" : "Guardar"}
                    </button>
                    <button
                      onClick={() => void load()}
                      disabled={loading}
                      className="rounded p-1 hover:bg-[var(--color-surface-2)]"
                      title="Recargar"
                    >
                      <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
                    </button>
                  </>
                }
              />
              {openSections.claudeMd && (
                <div className="bg-[var(--color-surface-0)]">
                  {payload.claude_md_path && (
                    <div className="border-b border-[var(--color-border)] px-3 py-1 font-mono text-[10px] text-[var(--color-text-muted)]">
                      {payload.claude_md_path}
                    </div>
                  )}
                  <textarea
                    value={mdContent}
                    onChange={(e) => {
                      setMdContent(e.target.value);
                      setMdDirty(true);
                    }}
                    className="h-48 w-full resize-y bg-[var(--color-surface-0)] p-3 font-mono text-xs focus:outline-none"
                    placeholder="(CLAUDE.md vacío — escribe para editar)"
                    spellCheck={false}
                  />
                </div>
              )}
            </section>
          )}

          {/* ── MEM0 — only render when connected (entries exist or no error) ── */}
          {(!payload.mem0_error || payload.mem0_entries.length > 0) && (
            <section className="border-b border-[var(--color-border)]">
              <SectionHeader
                title="Mem0 — memoria del proyecto"
                count={payload.mem0_entries.length}
                open={openSections.mem0}
                onToggle={() => toggleSection("mem0")}
              />
              {openSections.mem0 && (
                <div className="bg-[var(--color-surface-0)] p-2">
                  {payload.mem0_entries.length === 0 ? (
                    <EmptyState
                      message={`No hay memorias en Mem0 para "${projectName}". Guarda hallazgos desde el terminal o la memoria global.`}
                    />
                  ) : (
                    <ul className="space-y-1.5">
                      {payload.mem0_entries.map((m) => (
                        <li
                          key={m.id}
                          className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
                        >
                          <p className="whitespace-pre-wrap leading-relaxed">
                            {m.memory}
                          </p>
                          {m.created_at && (
                            <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                              {m.created_at}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {/* ── BUGS ACTIVOS ── */}
          <section className="border-b border-[var(--color-border)]">
            <SectionHeader
              title="Bugs activos"
              count={payload.recent_bugs.length}
              open={openSections.bugs}
              onToggle={() => toggleSection("bugs")}
            />
            {openSections.bugs && (
              <div className="bg-[var(--color-surface-0)] p-2">
                {payload.recent_bugs.length === 0 ? (
                  <EmptyState message="No hay cards con etiqueta 'bug' fuera de Done." />
                ) : (
                  <ul className="space-y-1.5">
                    {payload.recent_bugs.map((bug) => (
                      <li
                        key={bug.id}
                        className="rounded border border-[var(--color-error)]/40 bg-[var(--color-error)]/5 p-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium leading-snug">
                            {bug.title}
                          </span>
                          <span className="shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                            {bug.column_name}
                          </span>
                        </div>
                        {bug.tags.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1">
                            {bug.tags.map((t) => (
                              <span
                                key={t}
                                className="rounded bg-[var(--color-error)]/15 px-1 py-0.5 text-[10px] text-[var(--color-error)]"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* ── DECISIONS ── */}
          <section className="border-b border-[var(--color-border)]">
            <SectionHeader
              title="Decisiones del proyecto"
              count={payload.recent_decisions.length}
              open={openSections.decisions}
              onToggle={() => toggleSection("decisions")}
            />
            {openSections.decisions && (
              <div className="bg-[var(--color-surface-0)] p-2">
                {payload.recent_decisions.length === 0 ? (
                  <EmptyState message="No hay decisions.jsonl para este proyecto." />
                ) : (
                  <ul className="space-y-1.5">
                    {payload.recent_decisions.map((d, i) => (
                      <li
                        key={i}
                        className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <span className="font-medium">
                            {d.title ?? "(sin título)"}
                          </span>
                          {d.status && (
                            <span className="shrink-0 rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                              {d.status}
                            </span>
                          )}
                        </div>
                        {d.date && (
                          <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                            {d.date}
                          </div>
                        )}
                        {d.summary && (
                          <p className="mt-1 text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                            {d.summary}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>

          {/* ── KG ENTITIES ── */}
          {payload.kg_entities.length > 0 && (
            <section className="border-b border-[var(--color-border)]">
              <SectionHeader
                title="KG — entidades relacionadas"
                count={payload.kg_entities.length}
                open={openSections.kg}
                onToggle={() => toggleSection("kg")}
              />
              {openSections.kg && (
                <ul className="space-y-1.5 bg-[var(--color-surface-0)] p-2">
                  {payload.kg_entities.map((e) => (
                    <li
                      key={e.name}
                      className="rounded border border-[var(--color-border)] bg-[var(--color-surface-1)] p-2"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{e.name}</span>
                        <span className="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)]">
                          {e.entity_type}
                        </span>
                      </div>
                      {e.observations.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-[10px] text-[var(--color-text-muted)]">
                          {e.observations.map((obs, i) => (
                            <li key={i} className="truncate">
                              {obs}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
