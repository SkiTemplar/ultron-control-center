// ULTRON Control Center 2.0 — Per-project workspace (Dashboard V2)
//
// Layout:
//   1. Identity bar — back button + project name/path + detach
//   2. Dashboard — "Acciones rapidas": 2 primary cards + secondary tiles
//   3. Kanban board — fills all remaining space (flex-1 min-h-0)
//
// Design: no emojis, SVG icons from ./icons, semantic color tokens.

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Bot, Folder, Play, ExternalLink } from "./icons";
import ProjectBoard from "./ProjectBoard";
import { RepoModal } from "./RepoModal";
import BatchDropdown, { type BatchToast } from "./BatchDropdown";
import { useProjectsTabs } from "../../state/ProjectsTabsContext";
import type { ProjectInfo, SessionProvider } from "../../types";
import { providerBadge } from "./utils";
import { getPrompt } from "../../lib/button-prompts";

// ---------------------------------------------------------------------------
// Inline icons not yet in icons.tsx
// ---------------------------------------------------------------------------

function ChevronLeft({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function CodeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = { projectId: string };

type ProjectMeta = { id: string; name: string; path: string };

type GitRepoState = {
  is_repo: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  dirty_count: number;
};

type GitStatus = {
  state: GitRepoState | null;
  busy: boolean;
  error: string | null;
};

type ProjectListEntry = {
  id: string;
  name: string | null;
  path: string | null;
};

// ---------------------------------------------------------------------------
// PrimaryCard — Claude/AI + Kanban (large, 2-column)
// ---------------------------------------------------------------------------

interface PrimaryCardProps {
  icon: React.ReactNode;
  label: string;
  sub: string;
  tint: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

function PrimaryCard({
  icon,
  label,
  sub,
  tint,
  onClick,
  disabled = false,
  title,
}: PrimaryCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex flex-1 flex-col gap-3 rounded-lg p-4 text-left transition-colors disabled:opacity-40"
      style={{
        background: "var(--color-surface-2)",
        border: "1px solid var(--color-border)",
        minHeight: 88,
        minWidth: 0,
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.background = "var(--color-surface-3)";
        e.currentTarget.style.borderColor = "var(--color-border-strong)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "var(--color-surface-2)";
        e.currentTarget.style.borderColor = "var(--color-border)";
      }}
    >
      {/* Icon pill */}
      <div
        className="flex h-8 w-8 items-center justify-center rounded-md"
        style={{
          background: "var(--color-surface-1)",
          border: "1px solid var(--color-border)",
          color: tint,
        }}
      >
        {icon}
      </div>

      {/* Text */}
      <div>
        <div
          className="text-[13px] font-semibold leading-tight"
          style={{ color: "var(--color-text)" }}
        >
          {label}
        </div>
        <div
          className="mt-0.5 text-[11px] leading-snug"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          {sub}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// SecTile — IDE, Folder, Executables (secondary row, compact)
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// ProjectWorkspace
// ---------------------------------------------------------------------------

export default function ProjectWorkspace({ projectId }: Props) {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [batchToast, setBatchToast] = useState<BatchToast | null>(null);
  const [git, setGit] = useState<GitStatus>({ state: null, busy: false, error: null });
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [cgIndexed, setCgIndexed] = useState<boolean | null>(null);
  // cat2.5 (2026-06-10): resumen REAL del grafo leido del codegraph.db por la
  // app (codegraph_summary) — antes solo se comprobaba que el fichero existia.
  const [cgSummary, setCgSummary] = useState<{
    files: number;
    nodes: number;
    edges: number;
    languages: [string, number][];
    last_indexed_at: number | null;
  } | null>(null);
  const [cgBusy, setCgBusy] = useState(false);

  const tabsCtx = useProjectsTabs();

  // Auto-fade toast after 6s
  useEffect(() => {
    if (!batchToast) return;
    const t = window.setTimeout(() => setBatchToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [batchToast]);

  // Load project meta from registry
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await invoke("list_projects")) as ProjectListEntry[];
        const found = list.find((p) => p.id === projectId);
        if (!cancelled) {
          if (found && found.path) {
            setMeta({ id: found.id, name: found.name ?? found.id, path: found.path });
            setProjectInfo(found as unknown as ProjectInfo);
            // git_repo_state: NO tragar el error (antes .catch(()=>null) dejaba el
            // panel mudo — solo "Crear repo" sin pista). Exponerlo en git.error para
            // que el usuario VEA por que el panel no opera (mandamiento 11).
            let repoState: GitRepoState | null = null;
            let gitErr: string | null = null;
            try {
              repoState = (await invoke("git_repo_state", { path: found.path })) as GitRepoState;
            } catch (e) {
              gitErr = `git_repo_state fallo: ${String(e)}`;
            }
            const indexed = await invoke<boolean>("codegraph_is_indexed", { path: found.path }).catch(() => false);
            setGit({ state: repoState, busy: false, error: gitErr });
            setCgIndexed(indexed);
            if (indexed) {
              invoke<typeof cgSummary>("codegraph_summary", { path: found.path })
                .then((s) => {
                  if (!cancelled) setCgSummary(s);
                })
                .catch(() => {
                  /* resumen opcional: el panel sigue mostrando el estado básico */
                });
            }
          } else {
            setError(`Proyecto ${projectId} no encontrado`);
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Provider badge for the AI session button
  const provider: SessionProvider =
    (projectInfo?.default_provider as SessionProvider | null | undefined) ??
    "claude";
  const badge = providerBadge(provider);
  const executables = projectInfo?.executables ?? [];

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleBack = () => tabsCtx.close(projectId);

  const handleAi = async () => {
    if (!meta) return;
    try {
      await invoke("spawn_session", {
        provider,
        cwd: meta.path,
        prompt: null,
        flags: { dangerouslySkipPermissions: false },
      });
    } catch {
      /* silencioso */
    }
  };


  const handleIde = async () => {
    if (!meta) return;
    try {
      await invoke("open_project_in_ide", {
        path: meta.path,
        preferredIde: projectInfo?.ide ?? null,
      });
    } catch {
      /* silencioso */
    }
  };

  const handleFolder = async () => {
    if (!meta) return;
    try {
      await openPath(meta.path);
    } catch {
      /* silencioso */
    }
  };

  const handleDetach = async () => {
    if (!meta) return;
    try {
      await invoke("detach_project_window", { projectId: meta.id });
    } catch (e) {
      setError(String(e));
    }
  };

  const handleExe = async (path: string) => {
    try {
      await openPath(path);
    } catch {
      /* silencioso */
    }
  };

  const refreshGit = useCallback(async (path: string) => {
    // NO tragar el error: si git_repo_state falla, exponerlo (panel no-mudo).
    try {
      const repoState = (await invoke("git_repo_state", { path })) as GitRepoState;
      setGit({ state: repoState, busy: false, error: null });
    } catch (e) {
      setGit({ state: null, busy: false, error: `git_repo_state fallo: ${String(e)}` });
    }
  }, []);

  const runGitOp = useCallback(async (op: "git_pull" | "git_push" | "git_init" | "git_fetch") => {
    if (!meta) return;
    setGit((g) => ({ ...g, busy: true, error: null }));
    try {
      await invoke(op, { path: meta.path });
      await refreshGit(meta.path);
    } catch (e) {
      setGit((g) => ({ ...g, busy: false, error: String(e) }));
    }
  }, [meta, refreshGit]);

  const handleCodeGraphSession = async () => {
    if (!meta) return;
    try {
      await invoke("spawn_session", {
        provider: "claude",
        cwd: meta.path,
        prompt: await getPrompt("projects.codegraph_session", {
          project_name: meta.name,
        }),
        flags: { dangerouslySkipPermissions: false },
      });
    } catch {
      /* silencioso */
    }
  };

  const handleCodeGraphInit = async () => {
    if (!meta || cgBusy) return;
    setCgBusy(true);
    try {
      await invoke("codegraph_init_project", { path: meta.path });
      setCgIndexed(true);
    } catch {
      // si falla, dejamos cgIndexed en false para que el botón siga visible
    } finally {
      setCgBusy(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="flex h-full flex-col"
      style={{ background: "var(--color-surface-1)" }}
    >
      {/* ── 1. Identity bar ─────────────────────────────────────────────── */}
      <div
        className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
        style={{
          borderColor: "var(--color-border)",
          background: "var(--color-surface-2)",
        }}
      >
        {/* Back to projects */}
        <button
          type="button"
          onClick={handleBack}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors"
          style={{ color: "var(--color-text-tertiary)", background: "transparent" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--color-text)";
            e.currentTarget.style.background = "var(--color-surface-3)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--color-text-tertiary)";
            e.currentTarget.style.background = "transparent";
          }}
          title="Volver a la lista de proyectos"
        >
          <ChevronLeft size={12} />
          Projects
        </button>

        <span
          aria-hidden
          className="select-none text-[13px]"
          style={{ color: "var(--color-border-strong)" }}
        >
          /
        </span>

        {/* Project name */}
        <div className="min-w-0 flex-1">
          <span
            className="text-[13px] font-semibold"
            style={{ color: "var(--color-text)" }}
          >
            {meta?.name ?? projectId}
          </span>
          {meta?.path && (
            <span
              className="ml-2 truncate text-[10.5px]"
              style={{
                fontFamily: "var(--font-mono)",
                color: "var(--color-text-tertiary)",
              }}
              title={meta.path}
            >
              {meta.path}
            </span>
          )}
        </div>

        {/* Detach */}
        <button
          type="button"
          onClick={handleDetach}
          disabled={!meta}
          className="flex shrink-0 items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors disabled:opacity-40"
          style={{
            color: "var(--color-text-tertiary)",
            border: "1px solid var(--color-border)",
            background: "transparent",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--color-text)";
            e.currentTarget.style.borderColor = "var(--color-border-strong)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--color-text-tertiary)";
            e.currentTarget.style.borderColor = "var(--color-border)";
          }}
          title="Abrir en ventana independiente"
        >
          <ExternalLink size={11} />
          Detach
        </button>
      </div>

      {/* ── 2. Dashboard — Acciones rapidas ─────────────────────────────── */}
      <div
        className="shrink-0 border-b px-5 py-4"
        style={{ borderColor: "var(--color-border)" }}
      >
        {/* Section label */}
        <p
          className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Acciones rapidas
        </p>

        {/* Todos los botones como cards iguales */}
        <div className="flex flex-wrap gap-3">
          <PrimaryCard
            icon={<Bot size={16} />}
            label={badge.label}
            sub="Iniciar sesion de IA"
            tint={badge.tint}
            onClick={handleAi}
            disabled={!meta}
            title={`Lanzar sesion ${badge.label} en este proyecto`}
          />
          <PrimaryCard
            icon={<CodeIcon size={16} />}
            label="IDE"
            sub={projectInfo?.ide ?? "Editor preferido"}
            tint="var(--color-text-secondary)"
            onClick={handleIde}
            disabled={!meta}
            title="Abrir en IDE preferido"
          />
          <PrimaryCard
            icon={<Folder size={16} />}
            label="Folder"
            sub="Abrir en Explorer"
            tint="var(--color-text-secondary)"
            onClick={handleFolder}
            disabled={!meta}
            title="Abrir carpeta del proyecto"
          />
          <BatchDropdown onResult={setBatchToast} cardStyle />
          {executables.map((exe, i) => (
            <PrimaryCard
              key={i}
              icon={<Play size={16} />}
              label={exe.name || "Launch"}
              sub={exe.path.split(/[/\\]/).pop() ?? exe.path}
              tint="var(--color-success, #3fb950)"
              onClick={() => void handleExe(exe.path)}
              title={exe.path}
            />
          ))}
        </div>
      </div>

      {/* Batch result toast */}
      {batchToast && (
        <div
          className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-[11px]"
          style={{
            borderColor:
              batchToast.kind === "ok"
                ? "rgba(63,185,80,0.30)"
                : "rgba(239,68,68,0.30)",
            color:
              batchToast.kind === "ok"
                ? "var(--color-success, #3fb950)"
                : "var(--color-danger, #ef4444)",
          }}
        >
          <strong className="shrink-0">{batchToast.title}</strong>
          {batchToast.body && (
            <span
              className="min-w-0 truncate"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              {batchToast.body.slice(0, 200)}
              {batchToast.body.length > 200 ? "…" : ""}
            </span>
          )}
          <button
            onClick={() => setBatchToast(null)}
            className="ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100"
            aria-label="Cerrar notificacion"
            style={{ color: "inherit" }}
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              aria-hidden
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {error && (
        <div
          className="shrink-0 border-b px-4 py-2 text-[11.5px]"
          style={{
            borderColor: "rgba(239,68,68,0.30)",
            color: "var(--color-danger, #ef4444)",
          }}
        >
          {error}
        </div>
      )}

      {/* ── 3. CodeGraph + Git repo panels ──────────────────────────────── */}
      <div
        className="shrink-0 grid gap-3 border-b px-5 py-3"
        style={{ borderColor: "var(--color-border)", gridTemplateColumns: "1fr 1fr" }}
      >
        {/* CodeGraph panel */}
        <div
          className="flex flex-col gap-2 rounded-md p-3"
          style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
        >
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.07em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              CodeGraph
            </span>
            <div className="flex items-center gap-1.5">
              {cgIndexed === false && (
                <button
                  type="button"
                  onClick={() => void handleCodeGraphInit()}
                  disabled={!meta || cgBusy}
                  className="rounded px-2 py-0.5 text-[10.5px] font-medium disabled:opacity-40"
                  style={{
                    background: "#1d4ed8",
                    border: "1px solid #2563eb",
                    color: "#fff",
                  }}
                  title="Indexar este proyecto con codegraph init -i"
                >
                  {cgBusy ? "Indexando…" : "Indexar"}
                </button>
              )}
              <button
                type="button"
                onClick={() => void handleCodeGraphSession()}
                disabled={!meta}
                className="rounded px-2 py-0.5 text-[10.5px] font-medium disabled:opacity-40"
                style={{
                  background: "var(--color-surface-3)",
                  border: "1px solid var(--color-border-strong)",
                  color: "var(--color-text-secondary)",
                }}
                title="Abrir sesion Claude Code con herramientas codegraph"
              >
                Explorar
              </button>
            </div>
          </div>
          <p className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
            {cgIndexed === null
              ? "Verificando índice…"
              : cgIndexed
              ? "Indexado — codegraph_explore disponible"
              : "Sin índice — pulsa Indexar para construirlo"}
          </p>
          {cgSummary && (
            <p
              className="text-[10.5px] tabular-nums"
              style={{ color: "var(--color-text-secondary)", fontFamily: "var(--font-mono)" }}
              title={
                cgSummary.last_indexed_at
                  ? `Último indexado: ${new Date(cgSummary.last_indexed_at).toLocaleString()}`
                  : undefined
              }
            >
              {cgSummary.files} archivos · {cgSummary.nodes} símbolos · {cgSummary.edges} relaciones
              {cgSummary.languages.length > 0 &&
                ` · ${cgSummary.languages
                  .slice(0, 3)
                  .map(([l, n]) => `${l}:${n}`)
                  .join(" ")}`}
            </p>
          )}
        </div>

        {/* Git repo panel — mini GitHub Desktop */}
        <div
          className="flex flex-col gap-2 rounded-md p-3"
          style={{ background: "var(--color-surface-2)", border: "1px solid var(--color-border)" }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between">
            <span
              className="text-[10px] font-semibold uppercase tracking-[0.07em]"
              style={{ color: "var(--color-text-tertiary)" }}
            >
              Repositorio
            </span>
            {git.state?.is_repo && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setRepoModalOpen(true)}
                  className="rounded px-1.5 py-0.5 text-[9.5px] font-medium"
                  style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
                  title="Ver cambios, hacer commit y consultar el historial (micro GitHub Desktop)"
                >
                  Cambios{git.state.dirty_count > 0 ? ` (${git.state.dirty_count})` : ""}
                </button>
                <button
                  type="button"
                  onClick={() => void runGitOp("git_fetch")}
                  disabled={!meta || git.busy}
                  className="rounded px-1.5 py-0.5 text-[9.5px] disabled:opacity-40"
                  style={{ background: "transparent", border: "1px solid var(--color-border)", color: "var(--color-text-tertiary)" }}
                  title="git fetch (actualizar estado remoto)"
                >
                  Fetch
                </button>
              </div>
            )}
          </div>

          {/* No repo */}
          {!git.state?.is_repo && !git.error && (
            <div className="flex items-center justify-between">
              <span className="text-[10.5px]" style={{ color: "var(--color-text-tertiary)" }}>
                {meta ? "Sin repositorio git" : "Cargando…"}
              </span>
              {meta && (
                <button
                  type="button"
                  onClick={() => void runGitOp("git_init")}
                  disabled={git.busy}
                  className="rounded px-2 py-0.5 text-[10.5px] font-medium disabled:opacity-40"
                  style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
                  title="git init en este directorio"
                >
                  Crear repo
                </button>
              )}
            </div>
          )}

          {/* Repo state */}
          {git.state?.is_repo && (() => {
            const s = git.state!;
            const hasRemote = !!s.remote;
            const canPull = s.behind > 0;
            const canPush = s.ahead > 0;
            const canPublish = !hasRemote;
            return (
              <div className="flex flex-col gap-1.5">
                {/* Branch + dirty badge */}
                <div className="flex items-center gap-1.5">
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden
                    style={{ color: "var(--color-text-tertiary)", flexShrink: 0 }}>
                    <path d="M5.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zm-1.5.75a2.25 2.25 0 1 1 2.894 2.165v.585a2.25 2.25 0 0 1-2.25 2.25h-2a.75.75 0 0 1 0-1.5h2a.75.75 0 0 0 .75-.75v-.585A2.25 2.25 0 0 1 4.25 3.25zm7.5 1.25a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5zM10 5.414V7.75a.75.75 0 0 1-.75.75H7.5a.75.75 0 0 0 0 1.5h1.75v2.086a2.25 2.25 0 1 0 1.5 0V9.25a.75.75 0 0 0-.75-.75H8.5V7.75A2.25 2.25 0 0 0 6.25 5.5H4.5a.75.75 0 0 0 0 1.5h1.75a.75.75 0 0 1 .75.75v.414A2.25 2.25 0 0 0 10 5.414zm1.5 7.586a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/>
                  </svg>
                  <span className="text-[10.5px] font-medium" style={{ color: "var(--color-text)", fontFamily: "var(--font-mono)" }}>
                    {s.branch ?? "desconocida"}
                  </span>
                  {s.dirty && (
                    <span
                      className="rounded px-1 text-[9px] font-semibold"
                      style={{ background: "rgba(234,179,8,0.15)", color: "#ca8a04", border: "1px solid rgba(234,179,8,0.3)" }}
                      title={`${s.dirty_count} archivo(s) modificado(s)`}
                    >
                      {s.dirty_count} cambio{s.dirty_count !== 1 ? "s" : ""}
                    </span>
                  )}
                  {!s.dirty && s.is_repo && (
                    <span className="text-[9px]" style={{ color: "var(--color-text-tertiary)" }}>limpio</span>
                  )}
                </div>

                {/* Ahead / Behind indicators */}
                {hasRemote && (
                  <div className="flex items-center gap-2">
                    {canPull && (
                      <span className="flex items-center gap-0.5 text-[9.5px]" style={{ color: "#3b82f6" }} title="Commits remotos sin descargar">
                        <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 2a.75.75 0 0 1 .75.75v8.69l2.97-2.97a.749.749 0 1 1 1.06 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 9.53a.749.749 0 1 1 1.06-1.06l2.97 2.97V2.75A.75.75 0 0 1 8 2Z"/></svg>
                        {s.behind} por descargar
                      </span>
                    )}
                    {canPush && (
                      <span className="flex items-center gap-0.5 text-[9.5px]" style={{ color: "#a855f7" }} title="Commits locales sin subir">
                        <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M8 14a.75.75 0 0 1-.75-.75V4.56L4.28 7.53a.749.749 0 1 1-1.06-1.06l4.25-4.25a.749.749 0 0 1 1.06 0l4.25 4.25a.749.749 0 1 1-1.06 1.06L8.75 4.56v8.69A.75.75 0 0 1 8 14Z"/></svg>
                        {s.ahead} por subir
                      </span>
                    )}
                    {!canPull && !canPush && (
                      <span className="text-[9.5px]" style={{ color: "var(--color-text-tertiary)" }}>sincronizado con {s.remote}</span>
                    )}
                  </div>
                )}

                {/* Action buttons — siempre visibles (estilo GitHub Desktop):
                    Pull/Push aparecen siempre que haya remote, no solo cuando hay
                    commits pendientes; el badge (n) muestra ahead/behind si los hay. */}
                <div className="flex items-center gap-1.5 pt-0.5">
                  {canPublish && (
                    <button type="button" disabled className="rounded px-2 py-0.5 text-[10px] font-medium opacity-50"
                      style={{ background: "var(--color-surface-3)", border: "1px solid var(--color-border-strong)", color: "var(--color-text-secondary)" }}
                      title="Configura un remote (git remote add origin …) para publicar">
                      Publicar…
                    </button>
                  )}
                  {hasRemote && (
                    <button type="button" onClick={() => void runGitOp("git_pull")} disabled={git.busy}
                      className="rounded px-2 py-0.5 text-[10px] font-medium disabled:opacity-40"
                      style={{ background: "rgba(59,130,246,0.12)", border: "1px solid rgba(59,130,246,0.35)", color: "#3b82f6" }}
                      title="git pull --ff-only">
                      Pull {s.behind > 0 && <span className="ml-0.5 opacity-80">({s.behind})</span>}
                    </button>
                  )}
                  {hasRemote && (
                    <button type="button" onClick={() => void runGitOp("git_push")} disabled={git.busy}
                      className="rounded px-2 py-0.5 text-[10px] font-medium disabled:opacity-40"
                      style={{ background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.35)", color: "#a855f7" }}
                      title="git push">
                      Push {s.ahead > 0 && <span className="ml-0.5 opacity-80">({s.ahead})</span>}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Error + busy */}
          {git.error && (
            <p className="text-[10px]" style={{ color: "var(--color-danger, #ef4444)" }}>{git.error}</p>
          )}
          {git.busy && (
            <p className="text-[10px]" style={{ color: "var(--color-text-tertiary)" }}>Ejecutando…</p>
          )}
        </div>
      </div>

      {/* ── 4. Kanban board — fills all remaining space ──────────────────── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <ProjectBoard projectId={projectId} />
      </div>

      {repoModalOpen && meta && (
        <RepoModal
          path={meta.path}
          onClose={() => setRepoModalOpen(false)}
          onChanged={() => void refreshGit(meta.path)}
        />
      )}
    </div>
  );
}
