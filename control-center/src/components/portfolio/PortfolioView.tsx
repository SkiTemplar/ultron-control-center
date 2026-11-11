// Sección Portfolio: el tablero macro de todos los proyectos (kanban del
// proyecto `proyectos`) a ancho completo. Cada tarjeta vinculada a un proyecto
// registrado (`Card.project`) lleva «Abrir», que abre su workspace igual que
// la rejilla de Projects; un vínculo a un id que ya no existe se marca con
// «proyecto no encontrado» en vez de dejar un botón que no hace nada.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import ProjectBoard, { type BoardHeaderContext } from "../projects/ProjectBoard";
import type { BoardExtensions } from "../projects/project-board/BoardExtensions";
import { useDismissable } from "../useDismissable";
import type { Card, ProjectInfo } from "../../types";
import { AddProjectPicker } from "./AddProjectPicker";
import {
  PORTFOLIO_PROJECT_ID,
  cardLink,
  projectDisplayName,
  projectsWithoutCard,
  registeredProjects,
  toLinkable,
} from "./portfolioModel";

type Props = {
  /** Abre el workspace del proyecto (mismo camino que Projects → tarjeta). */
  onOpenProject: (id: string, title: string) => void;
};

type ProjectsState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; list: ProjectInfo[] };

function useRegisteredProjects() {
  const [state, setState] = useState<ProjectsState>({ status: "loading" });
  const reload = useCallback(async () => {
    try {
      const list = (await invoke("list_projects")) as ProjectInfo[];
      setState({ status: "ready", list: registeredProjects(list) });
    } catch (e) {
      setState({ status: "error", error: String(e) });
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { state, reload };
}

function CardLinkActions({
  card,
  byId,
  onOpenProject,
}: {
  card: Card;
  byId: Map<string, ProjectInfo>;
  onOpenProject: Props["onOpenProject"];
}) {
  const link = cardLink(card, byId);
  if (link.kind === "none") return null;
  if (link.kind === "missing") {
    return (
      <span
        className="rounded px-1.5 py-0.5 text-[10px] font-medium"
        style={{ background: "rgba(210, 153, 34, 0.18)", color: "var(--color-warn)" }}
        title={`La tarjeta apunta a «${link.projectId}», que no está en el registro de proyectos. Edita la tarjeta para vincularla a otro.`}
      >
        proyecto no encontrado
      </span>
    );
  }
  const name = projectDisplayName(link.project);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpenProject(link.project.id, name);
      }}
      onPointerDown={(e) => e.stopPropagation()}
      draggable={false}
      className="rounded border border-[var(--color-accent)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/15"
      title={`Abrir el workspace de ${name}`}
      aria-label={`Abrir ${name}`}
    >
      Abrir
    </button>
  );
}

function PortfolioHeader({
  ctx,
  projects,
  onRetryProjects,
}: {
  ctx: BoardHeaderContext;
  projects: ProjectsState;
  onRetryProjects: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useDismissable(popRef, open, () => setOpen(false));
  const pending =
    projects.status === "ready" ? projectsWithoutCard(ctx.board, projects.list).length : null;

  const onCreated = (message: string) => {
    setOpen(false);
    setNotice(message);
    void ctx.reload();
  };

  return (
    <div className="flex items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface-0)] px-3 py-2">
      <h1 className="text-sm font-semibold text-[var(--color-text)]">Portfolio</h1>
      <span className="text-[11.5px] text-[var(--color-text-muted)]">
        {ctx.board.cards.length} tarjetas
        {pending !== null && pending > 0 && ` · ${pending} proyecto${pending === 1 ? "" : "s"} sin tarjeta`}
      </span>
      {projects.status === "error" && (
        <span role="alert" className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-error)]">
          No se pudo leer el registro de proyectos: {projects.error}
          <button type="button" onClick={onRetryProjects} className="underline">
            Reintentar
          </button>
        </span>
      )}
      {notice && (
        <span role="status" className="text-[11.5px] text-[var(--color-text-muted)]">
          {notice}
        </span>
      )}
      <div ref={popRef} className="relative ml-auto">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={projects.status !== "ready"}
          onClick={() => {
            setNotice(null);
            setOpen((v) => !v);
          }}
          className="rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)]/20 px-3 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent)]/30 disabled:opacity-50"
          title={projects.status === "loading" ? "Cargando el registro de proyectos…" : undefined}
        >
          + Añadir proyecto
        </button>
        {open && projects.status === "ready" && (
          <div
            role="dialog"
            aria-label="Añadir proyecto al Portfolio"
            className="absolute right-0 top-full z-40 mt-1 rounded-md border border-[var(--color-border-strong)] bg-[var(--color-surface-1)] shadow-xl"
          >
            <AddProjectPicker board={ctx.board} projects={projects.list} onCreated={onCreated} />
          </div>
        )}
      </div>
    </div>
  );
}

export function PortfolioView({ onOpenProject }: Props) {
  const { state, reload } = useRegisteredProjects();
  const ready = state.status === "ready" ? state.list : null;
  const byId = useMemo(() => new Map((ready ?? []).map((p) => [p.id, p])), [ready]);

  // Hasta tener el registro no se pinta nada por tarjeta: sin él, todos los
  // vínculos parecerían «no encontrados».
  const extensions = useMemo<BoardExtensions>(
    () => ({
      showColumnFooterAdd: true,
      linkableProjects: ready ? toLinkable(ready) : undefined,
      renderCardActions: ready
        ? (card) =>
            card.project ? (
              <CardLinkActions card={card} byId={byId} onOpenProject={onOpenProject} />
            ) : null
        : undefined,
    }),
    [ready, byId, onOpenProject],
  );

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      <ProjectBoard
        projectId={PORTFOLIO_PROJECT_ID}
        extensions={extensions}
        renderHeader={(ctx) => (
          <PortfolioHeader ctx={ctx} projects={state} onRetryProjects={() => void reload()} />
        )}
      />
    </div>
  );
}
