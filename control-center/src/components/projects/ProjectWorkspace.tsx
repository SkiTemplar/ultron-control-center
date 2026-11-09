// ULTRON Control Center 2.0 — Per-project workspace (Dashboard V2)
//
// Layout:
//   1. Identity bar — back button + project name/path + detach (in a detached
//      window: «Ventana principal» instead of both)
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

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Window, getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bot,
  Folder,
  Play,
  ExternalLink,
  GitBranch,
  Share2,
  Terminal,
  BookOpen,
  History,
} from "./icons";
import { ClaudeMdModal } from "./ClaudeMdModal";
import { SessionLogModal } from "./SessionLogModal";
import { UsageModal } from "./UsageModal";
import ProjectBoard from "./ProjectBoard";
import { RepoModal } from "./RepoModal";
import { ChevronLeft, CodeIcon, PrimaryCard, UsageIcon } from "./WorkspaceCards";
import { useProjectsTabs } from "../../state/ProjectsTabsContext";
import type { ProjectInfo, SessionLogEntry, SessionProvider } from "../../types";
import { providerBadge } from "./utils";
import { CodeGraphModal } from "./codegraph/CodeGraphModal";
import {
  codeGraphSubtitle,
  codeGraphTooltip,
  useCodeGraphCard,
} from "./codegraph/useCodeGraphCard";
import { fetchProjectUsage, usageSubtitle, type ProjectUsage } from "../../lib/project-usage";
// GitStatus vivia en RepoPanelWidget (borrado 2026-07); este era su unico consumidor real.
export type GitStatus = {
  state: GitRepoState | null;
  busy: boolean;
  error: string | null;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  projectId: string;
  /** True inside the detached project window (DetachedProjectView): there is
   *  no list to go back to and nothing left to detach. */
  detached?: boolean;
};

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
// ProjectWorkspace
// ---------------------------------------------------------------------------

export default function ProjectWorkspace({ projectId, detached = false }: Props) {
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  // Registered project without a folder: meta stays null (every action needs
  // the path), but the workspace says so instead of loading forever.
  const [noPath, setNoPath] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus>({ state: null, busy: false, error: null });
  const [repoModalOpen, setRepoModalOpen] = useState(false);
  const [claudeMdOpen, setClaudeMdOpen] = useState(false);
  // La bitacora se lee al abrir el workspace, no al abrir el modal: su
  // titular es justo el dato que se quiere de un vistazo ("que fue lo ultimo
  // que trabaje aqui"), asi que vive en el subtitulo del boton.
  const [sessionLog, setSessionLog] = useState<SessionLogEntry[] | null>(null);
  const [sessionLogOpen, setSessionLogOpen] = useState(false);
  // Uso de Claude: se calcula al entrar (30 d) para poner el titular en la
  // tarjeta; el detalle vive en UsageModal. Un fallo se muestra, no se traga.
  const [usage, setUsage] = useState<ProjectUsage | null | "error">(null);
  const [usageOpen, setUsageOpen] = useState(false);
  // Tarjeta CodeGraph: índice, resumen real del codegraph.db y visor.
  const codeGraph = useCodeGraphCard(meta?.path ?? null);
  const [codeGraphOpen, setCodeGraphOpen] = useState(false);

  const tabsCtx = useProjectsTabs();

  useEffect(() => {
    let cancelled = false;
    setUsage(null);
    (async () => {
      try {
        const r = await fetchProjectUsage(projectId, 30);
        if (!cancelled) setUsage(r.ok ? r : "error");
      } catch {
        if (!cancelled) setUsage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Load project meta from registry
  // Bitacora: se pide al entrar al proyecto porque su titular se enseña en el
  // boton. El listado no trae los cuerpos de los resumenes, asi que son unos
  // cientos de bytes aunque el proyecto lleve decenas de sesiones.
  useEffect(() => {
    let cancelled = false;
    setSessionLog(null);
    (async () => {
      try {
        const log = (await invoke("project_session_log", { projectId })) as SessionLogEntry[];
        if (!cancelled) setSessionLog(log);
      } catch {
        // Un fallo aqui no puede tumbar el workspace: la tarjeta se queda
        // sin titular y el modal enseña el error si se abre.
        if (!cancelled) setSessionLog([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await invoke("list_projects")) as ProjectListEntry[];
        const found = list.find((p) => p.id === projectId);
        if (!cancelled) {
          setNoPath(!!found && !found.path);
          if (found && !found.path) {
            setMeta(null);
            setProjectInfo(found as unknown as ProjectInfo);
          } else if (found && found.path) {
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
            setGit({ state: repoState, busy: false, error: gitErr });
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
  }, [projectId, reloadKey]);

  // Provider badge for the AI session button
  const provider: SessionProvider =
    (projectInfo?.default_provider as SessionProvider | null | undefined) ??
    "claude";
  const badge = providerBadge(provider);
  const executables = projectInfo?.executables ?? [];

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleBack = () => tabsCtx.close(projectId);

  // Ventana separada: no hay lista a la que volver. Se trae al frente la
  // ventana principal y se cierra esta.
  const handleBackToMain = async () => {
    try {
      const main = await Window.getByLabel("main");
      if (main) {
        await main.show();
        await main.setFocus();
      }
      await getCurrentWindow().close();
    } catch (e) {
      setError(`No se pudo volver a la ventana principal: ${String(e)}`);
    }
  };

  const handleAssignFolder = async () => {
    setError(null);
    try {
      const picked = await openDialog({ directory: true, multiple: false, title: "Carpeta del proyecto" });
      if (typeof picked !== "string" || !picked) return;
      await invoke("update_project", { id: projectId, path: picked });
      setReloadKey((k) => k + 1);
    } catch (e) {
      reportFailure("asignar la carpeta", e);
    }
  };

  // Mandamiento 11: un botón que falla dice por qué. Antes IA, IDE, carpeta y
  // ejecutables tragaban el error (p. ej. un proyecto
  // fuera del scope del opener no hacía nada al pulsar Folder).
  const reportFailure = (action: string, e: unknown) =>
    setError(`No se pudo ${action}: ${String(e)}`);

  const handleAi = async () => {
    if (!meta) return;
    setError(null);
    try {
      await invoke("spawn_session", {
        provider,
        cwd: meta.path,
        prompt: null,
        // Flujo interno sobre un proyecto propio: sin decisión explícita de
        // permisos manda el defecto de sessions.rs (resolve_dangerous).
        flags: {},
      });
    } catch (e) {
      reportFailure(`lanzar la sesión de ${badge.label}`, e);
    }
  };

  const handleIde = async () => {
    if (!meta) return;
    setError(null);
    try {
      await invoke("open_project_in_ide", {
        path: meta.path,
        preferredIde: projectInfo?.ide ?? null,
      });
    } catch (e) {
      reportFailure("abrir el IDE", e);
    }
  };

  const handleFolder = async () => {
    if (!meta) return;
    setError(null);
    try {
      await openPath(meta.path);
    } catch (e) {
      reportFailure(`abrir la carpeta ${meta.path}`, e);
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
    setError(null);
    try {
      await openPath(path);
    } catch (e) {
      reportFailure(`abrir ${path}`, e);
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

  // Tarjeta única CodeGraph: sin índice → indexar; error al comprobar →
  // reintentar; indexado → abrir el visor del grafo (pilar 3: ver el grafo,
  // no lanzar sesiones). Nunca es un no-op (mandamiento 11).
  const handleCodeGraphCard = async () => {
    if (!meta || codeGraph.busy || codeGraph.indexed === null) return;
    if (codeGraph.indexed === true) {
      setCodeGraphOpen(true);
    } else if (codeGraph.indexed === "error") {
      await codeGraph.refresh();
    } else {
      await codeGraph.init();
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

  const repoSub = noPath
    ? "Sin carpeta asignada"
    : !meta
    ? "Cargando…"
    : git.error
    ? "Error de estado: clic para reintentar"
    : git.state?.is_repo
    ? `${git.state.branch ?? "?"} · ${
        git.state.dirty
          ? `${git.state.dirty_count} cambio${git.state.dirty_count !== 1 ? "s" : ""}`
          : "limpio"
      }`
    : "Sin repositorio git: clic para crear";

  // El titular de la ultima sesion: la tarjeta lo corta a dos lineas y el
  // texto completo queda en el tooltip.
  // Sin resumenes se dice por que, en vez de dejar la tarjeta muda: el
  // generador solo escribe el resumen de una sesion al abrir la siguiente.
  const sessionLogSub = !sessionLog
    ? "Cargando…"
    : sessionLog.length === 0
    ? "Sin resúmenes todavía"
    : sessionLog[0].headline ?? "Resumen sin temas";

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
        {/* Back to projects (main window) / back to the main window (detached) */}
        <button
          type="button"
          onClick={detached ? () => void handleBackToMain() : handleBack}
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
          title={
            detached
              ? "Traer al frente la ventana principal y cerrar esta"
              : "Volver a la lista de proyectos"
          }
        >
          <ChevronLeft size={12} />
          {detached ? "Ventana principal" : "Proyectos"}
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
            {meta?.name ?? projectInfo?.name ?? projectId}
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

        {/* Detach (not inside a window that is already detached) */}
        {!detached && (
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
            Separar
          </button>
        )}
      </div>

      {noPath && (
        <div
          className="flex shrink-0 items-center gap-3 border-b px-5 py-2 text-[11.5px]"
          style={{
            borderColor: "var(--color-border)",
            background: "var(--color-surface-2)",
            color: "var(--color-text-secondary)",
          }}
          role="status"
        >
          <span className="min-w-0 flex-1">
            Este proyecto no tiene carpeta asignada: IA, IDE, carpeta, terminal,
            CodeGraph, repo y CLAUDE.md necesitan una para funcionar.
          </span>
          <button
            type="button"
            onClick={() => void handleAssignFolder()}
            className="shrink-0 rounded px-2.5 py-1 text-[11.5px] font-medium"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}
          >
            Asignar carpeta…
          </button>
        </div>
      )}

      {/* ── 2. Dashboard — Acciones rapidas ─────────────────────────────── */}
      <div
        className="shrink-0 border-b px-5 py-3"
        style={{ borderColor: "var(--color-border)" }}
      >
        {/* Dos grupos ESTABLES (antes: un solo flex-wrap donde CodeGraph/Repo
            caian a filas distintas segun el ancho de ventana). Fila 1 =
            lanzar cosas; fila 2 = proyecto (CodeGraph, Repo, Bitácora, uso y
            CLAUDE.md). Las dos son rejillas de 5 columnas con tiles compactos
            para que se alineen y dejen el alto al Kanban. */}
        <p
          className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Lanzar
        </p>
        <div className="grid grid-cols-5 gap-2">
          <PrimaryCard
            icon={<Bot size={20} />}
            label={badge.label}
            sub="Iniciar sesión de IA"
            tint={badge.tint}
            onClick={handleAi}
            disabled={!meta}
            title={`Lanzar sesión de ${badge.label} en este proyecto`}
          />
          <PrimaryCard
            icon={<CodeIcon size={20} />}
            label="IDE"
            sub={projectInfo?.ide ?? "Editor preferido"}
            tint="var(--color-text-secondary)"
            onClick={handleIde}
            disabled={!meta}
            title="Abrir en IDE preferido"
          />
          <PrimaryCard
            icon={<Folder size={20} />}
            label="Carpeta"
            sub="Abrir en el Explorador"
            tint="var(--color-text-secondary)"
            onClick={handleFolder}
            disabled={!meta}
            title="Abrir carpeta del proyecto"
          />
          <PrimaryCard
            icon={<Terminal size={20} />}
            label="Terminal"
            sub={
              meta?.default_shell === "cmd"
                ? "cmd.exe aquí"
                : meta?.default_shell === "powershell-admin"
                  ? "PowerShell (admin) aquí"
                  : "PowerShell aquí"
            }
            tint="var(--color-text-secondary)"
            onClick={() => void handleTerminal()}
            disabled={!meta}
            title="Abrir una consola en la raíz del proyecto"
          />
          {executables.map((exe, i) => (
            <PrimaryCard
              key={i}
              icon={<Play size={20} />}
              label={exe.name || "Lanzar"}
              sub={exe.path.split(/[/\\]/).pop() ?? exe.path}
              tint="var(--color-success, #3fb950)"
              onClick={() => void handleExe(exe.path)}
              title={exe.path}
            />
          ))}
        </div>

        <p
          className="mb-2 mt-3.5 text-[11px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--color-text-tertiary)" }}
        >
          Proyecto
        </p>
        <div className="grid grid-cols-5 gap-2">
          <PrimaryCard
            icon={<Share2 size={20} />}
            label="CodeGraph"
            sub={codeGraphSubtitle(codeGraph, noPath)}
            tint="var(--color-text-secondary)"
            onClick={() => void handleCodeGraphCard()}
            // Mientras se comprueba el índice no hay acción que elegir: un clic
            // antes de tiempo lanzaba `codegraph init` sobre un proyecto indexado.
            disabled={!meta || codeGraph.busy || codeGraph.indexed === null}
            title={codeGraphTooltip(codeGraph)}
          />
          <PrimaryCard
            icon={<GitBranch size={20} />}
            label="Repo"
            sub={repoSub}
            tint={git.state?.dirty ? "#ca8a04" : "var(--color-text-secondary)"}
            onClick={() => void handleRepoCard()}
            disabled={!meta || git.busy}
            title={repoTitle}
          />
          <PrimaryCard
            icon={<History size={20} />}
            label="Bitácora"
            sub={sessionLogSub}
            tint="var(--color-text-secondary)"
            onClick={() => setSessionLogOpen(true)}
            disabled={!meta && !noPath}
            title="Historial de sesiones resumidas: qué se trabajó, qué se decidió y qué quedó pendiente"
          />
          <PrimaryCard
            icon={<UsageIcon size={20} />}
            label="Uso de Claude"
            sub={
              usage === null
                ? "Calculando…"
                : usage === "error"
                ? "No disponible: clic para ver por qué"
                : usageSubtitle(usage)
            }
            tint="var(--color-text-secondary)"
            onClick={() => setUsageOpen(true)}
            disabled={!meta && !noPath}
            title="Coste nocional, modelos y subagentes de las sesiones de Claude Code de este proyecto"
          />
          <PrimaryCard
            icon={<BookOpen size={20} />}
            label="CLAUDE.md"
            sub="Instrucciones del proyecto"
            tint="var(--color-text-secondary)"
            onClick={() => setClaudeMdOpen(true)}
            disabled={!meta}
            title="Editar el CLAUDE.md que Claude Code carga en cada sesión de este proyecto"
          />
        </div>
      </div>

      {[error, codeGraph.error].filter(Boolean).map((msg) => (
        <div
          key={msg}
          className="shrink-0 border-b px-4 py-2 text-[11.5px]"
          style={{
            borderColor: "rgba(239,68,68,0.30)",
            color: "var(--color-danger, #ef4444)",
          }}
        >
          {msg}
        </div>
      ))}

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

      {codeGraphOpen && meta && (
        <CodeGraphModal
          path={meta.path}
          projectName={meta.name}
          onClose={() => setCodeGraphOpen(false)}
        />
      )}

      {sessionLogOpen && (meta || noPath) && (
        <SessionLogModal
          projectId={projectId}
          projectName={projectInfo?.name ?? projectId}
          onClose={() => setSessionLogOpen(false)}
        />
      )}

      {usageOpen && (meta || noPath) && (
        <UsageModal
          projectId={projectId}
          projectName={projectInfo?.name ?? projectId}
          onClose={() => setUsageOpen(false)}
        />
      )}

      {claudeMdOpen && meta && (
        <ClaudeMdModal
          projectPath={meta.path}
          projectName={projectInfo?.name ?? projectId}
          onClose={() => setClaudeMdOpen(false)}
        />
      )}
    </div>
  );
}
