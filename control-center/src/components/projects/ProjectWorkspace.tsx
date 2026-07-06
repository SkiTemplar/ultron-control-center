// ULTRON Control Center 2.0 — Per-project workspace (Dashboard V2)
//
// Layout:
//   1. Identity bar — back button + project name/path + detach
//   2. Dashboard — "Acciones rapidas": barra de 5 botones (AI, IDE, Folder,
//      CodeGraph, Repo) + tiles de ejecutables
//   3. Kanban board — fills all remaining space (flex-1 min-h-0)
//
// masterplan 3.6 (2026-07-02): Batch salio de esta barra (el backend de colas
// —execute_batch/list_batches/etc.— sigue intacto; Batch sigue visible en el
// header de la lista de proyectos, Projects.tsx). CodeGraph y el panel Git
// subieron de la grid dedicada (seccion 3 vieja) a esta barra como botones
// compactos, liberando esa franja de alto fijo para el Kanban. El detalle
// full de Git (cambios/commit/historial/pull/push) sigue vivo en RepoModal.
// (RepoPanelWidget.tsx, el panel viejo que quedo huerfano, se borro en la
// limpieza de codigo muerto 2026-07.)
//
// Design: no emojis, SVG icons from ./icons, semantic color tokens.

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { Bot, Folder, Play, ExternalLink, GitBranch, Share2, Terminal } from "./icons";
import ProjectBoard from "./ProjectBoard";
import { RepoModal } from "./RepoModal";
import { useProjectsTabs } from "../../state/ProjectsTabsContext";
import type { ProjectInfo, SessionProvider } from "../../types";
import { providerBadge } from "./utils";
import { getPrompt } from "../../lib/button-prompts";
// GitStatus vivia en RepoPanelWidget (borrado 2026-07); este era su unico consumidor real.
export type GitStatus = {
  state: GitRepoState | null;
  busy: boolean;
  error: string | null;
};

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

type ProjectMeta = {
  id: string;
  name: string;
  path: string;
  /** fb-016: shell preferida del wizard (powershell | powershell-admin | cmd). */
  default_shell?: string | null;
};

type GitRepoState = {
  is_repo: boolean;
  branch: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  dirty_count: number;
  path: string;
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

  // Load project meta from registry
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await invoke("list_projects")) as ProjectListEntry[];
        const found = list.find((p) => p.id === projectId);
        if (!cancelled) {
          if (found && found.path) {
            setMeta({
              id: found.id,
              name: found.name ?? found.id,
              path: found.path,
              default_shell:
                (found as { default_shell?: string | null }).default_shell ?? null,
            });
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

  const handleTerminal = async () => {
    if (!meta) return;
    try {
      await invoke("open_project_terminal", {
        path: meta.path,
        shell: meta.default_shell ?? null,
      });
    } catch (e) {
      // Mandamiento 11: si no puede abrir, que se VEA por que.
      setError(`No se pudo abrir la terminal: ${String(e)}`);
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

  // Tarjeta única CodeGraph (masterplan 3.6): sin índice → indexar; indexado →
  // abrir sesión de exploración. Nunca es un no-op (mandamiento 11).
  const handleCodeGraphCard = async () => {
    if (!meta || cgBusy) return;
    if (cgIndexed) {
      await handleCodeGraphSession();
    } else {
      await handleCodeGraphInit();
    }
  };

  // Tarjeta única Repo (masterplan 3.6): error de estado → reintenta refresh;
  // sin repo → git init; con repo → abre el micro GitHub Desktop (RepoModal),
  // que ya cubre pull/push/fetch/commit/historial.
  const handleRepoCard = async () => {
    if (!meta || git.busy) return;
    if (git.error) {
      await refreshGit(meta.path);
      return;
    }
    if (git.state?.is_repo) {
      setRepoModalOpen(true);
      return;
    }
    await runGitOp("git_init");
  };

  const codeGraphSub = cgBusy
    ? "Indexando…"
    : cgIndexed === null
    ? "Verificando índice…"
    : cgIndexed
    ? cgSummary
      ? `${cgSummary.files} archivos · ${cgSummary.nodes} símbolos`
      : "Indexado"
    : "Sin índice — click para indexar";

  const codeGraphTitle = cgIndexed
    ? "Abrir sesión Claude Code con herramientas codegraph"
    : "Indexar este proyecto con codegraph init -i";

  const repoSub = !meta
    ? "Cargando…"
    : git.error
    ? "Error de estado — click para reintentar"
    : git.state?.is_repo
    ? `${git.state.branch ?? "?"} · ${
        git.state.dirty
          ? `${git.state.dirty_count} cambio${git.state.dirty_count !== 1 ? "s" : ""}`
          : "limpio"
      }`
    : "Sin repositorio git — click para crear";

  const repoTitle = git.state?.is_repo
    ? "Ver cambios, commit e historial (micro GitHub Desktop)"
    : "git init en este directorio";

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
        {/* Dos grupos ESTABLES (antes: un solo flex-wrap donde CodeGraph/Repo
            caian a filas distintas segun el ancho de ventana). Fila 1 =
            lanzar cosas; fila 2 = codigo (CodeGraph + Repo siempre juntos). */}
        <p
          className="mb-3 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Lanzar
        </p>
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
          <PrimaryCard
            icon={<Terminal size={16} />}
            label="Terminal"
            sub={
              meta?.default_shell === "cmd"
                ? "cmd.exe aqui"
                : meta?.default_shell === "powershell-admin"
                  ? "PowerShell (admin) aqui"
                  : "PowerShell aqui"
            }
            tint="var(--color-text-secondary)"
            onClick={() => void handleTerminal()}
            disabled={!meta}
            title="Abrir una consola en la raiz del proyecto"
          />
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

        <p
          className="mb-3 mt-4 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Codigo
        </p>
        <div className="flex flex-wrap gap-3">
          <PrimaryCard
            icon={<Share2 size={16} />}
            label="CodeGraph"
            sub={codeGraphSub}
            tint="var(--color-text-secondary)"
            onClick={() => void handleCodeGraphCard()}
            disabled={!meta || cgBusy}
            title={codeGraphTitle}
          />
          <PrimaryCard
            icon={<GitBranch size={16} />}
            label="Repo"
            sub={repoSub}
            tint={git.state?.dirty ? "#ca8a04" : "var(--color-text-secondary)"}
            onClick={() => void handleRepoCard()}
            disabled={!meta || git.busy}
            title={repoTitle}
          />
        </div>
      </div>

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

      {/* ── 3. Kanban board — fills all remaining space ─────────────────── */}
      {/* CodeGraph y Repo ya no tienen una franja dedicada aparte (masterplan
          3.6): sus botones viven en la barra de "Acciones rapidas" de arriba
          y el detalle completo de Git vive en RepoModal. Ese espacio queda
          para el Kanban. */}
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
