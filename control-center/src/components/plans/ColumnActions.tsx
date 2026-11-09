// ColumnActions — per-column action bar for the Plans kanban.
// Each lane owns 0..N buttons that only make sense for items in that column.
// Extracted from Plans.tsx as part of the cat7 split refactor.

import { type CSSProperties, type ReactElement } from "react";
import { useRoutingTitle } from "../../lib/button-prompts";

// v2.x slim: per-tab stats strip removed. The Plans tab is intentionally
// minimal — the user asked for the kanban board only, no rolled-up counts.
// The per-status counts that the UI still needs (resolvedCount for the
// archive button) are computed inline in <Plans />.

// How many plans each AI flow would act on (see usePlans). A zero disables
// the button: launching a session with nothing in scope is a silent no-op.
export type FlowTargetCount = { execute: number; review: number; resolve: number };

// Per-column action bar. Each kanban column owns 0..N buttons that only
// make sense for items in that lane. Centralising the switch here keeps
// the column-rendering JSX in <Plans /> readable.
export function ColumnActions(props: {
  column: string;
  onNew: () => void;
  onSprintAi: () => void;
  sprintAiBusy: boolean;
  onExecute: () => void;
  onReview: () => void;
  onResolveBlock: () => void;
  onArchiveSelected: () => void;
  archiveDisabled: boolean;
  archiveCount: number;
  flowTargetCount: FlowTargetCount;
}) {
  const baseBtn =
    "rounded px-2 py-1 text-[10.5px] font-medium transition-colors disabled:opacity-40";
  const accent: CSSProperties = {
    background: "var(--color-accent)",
    color: "var(--color-accent-text)",
  };
  const subtle: CSSProperties = {
    background: "var(--color-surface-3)",
    color: "var(--color-text-secondary)",
    border: "1px solid var(--color-border)",
  };

  // Destino de cada botón de IA: la clave del catálogo se resuelve con el
  // Router de IA para ver proveedor y modelo antes de pulsar.
  const sprintTitle = useRoutingTitle(
    "plans.sprint_ai",
    "Genera una propuesta de sprint accionable con los planes abiertos y reescribe o mejora los añadidos a mano.",
  );
  const executeTitle = useRoutingTitle(
    "plans.execute",
    "Lanza una sesión de IA que ejecuta los planes abiertos por orden de prioridad.",
  );
  const reviewTitle = useRoutingTitle(
    "plans.review",
    "Lanza una sesión de IA que hace una revisión adversarial de los planes en revisión.",
  );
  const resolveBlockTitle = useRoutingTitle(
    "plans.resolve_in_progress",
    "Lanza una sesión de IA para desbloquear el plan: lee la descripción y la spec y propone una salida.",
  );

  let buttons: ReactElement[] = [];
  switch (props.column) {
    case "open":
      buttons = [
        <button
          key="new"
          type="button"
          onClick={props.onNew}
          className={baseBtn}
          style={subtle}
          title="Crea un plan vacío a mano (título, prioridad, tipo, tags y descripción)."
        >
          Nuevo plan
        </button>,
        <button
          key="sprint"
          type="button"
          onClick={props.onSprintAi}
          disabled={props.sprintAiBusy}
          className={baseBtn}
          style={accent}
          title={sprintTitle}
        >
          {props.sprintAiBusy ? "Abriendo…" : "Sprint con IA"}
        </button>,
      ];
      break;
    case "in_progress":
      buttons = [
        <button
          key="exec"
          type="button"
          onClick={props.onExecute}
          disabled={props.flowTargetCount.execute === 0}
          className={baseBtn}
          style={accent}
          title={props.flowTargetCount.execute === 0 ? "No hay planes abiertos que ejecutar." : executeTitle}
        >
          Ejecutar
        </button>,
      ];
      break;
    case "revision":
      buttons = [
        <button
          key="review"
          type="button"
          onClick={props.onReview}
          disabled={props.flowTargetCount.review === 0}
          className={baseBtn}
          style={accent}
          title={
            props.flowTargetCount.review === 0
              ? "No hay planes en revisión (ni abiertos p0/p1) que revisar."
              : reviewTitle
          }
        >
          Revisar con IA
        </button>,
      ];
      break;
    case "blocked":
      buttons = [
        <button
          key="resolve"
          type="button"
          onClick={props.onResolveBlock}
          disabled={props.flowTargetCount.resolve === 0}
          className={baseBtn}
          style={subtle}
          title={
            props.flowTargetCount.resolve === 0
              ? "No hay planes en curso (ni abiertos p0/p1) que resolver."
              : resolveBlockTitle
          }
        >
          Desbloquear
        </button>,
      ];
      break;
    case "resolved":
      buttons = [
        <button
          key="archive"
          type="button"
          onClick={props.onArchiveSelected}
          disabled={props.archiveDisabled}
          className={baseBtn}
          style={subtle}
          title="Mueve todos los planes resueltos a plans/_archive/resolved-YYYY-MM.json (atómico, no destructivo)."
        >
          Archivar resueltos ({props.archiveCount})
        </button>,
      ];
      break;
  }

  if (buttons.length === 0) return null;
  return (
    <div
      className="flex flex-wrap gap-1 border-b px-2 py-1.5"
      style={{ borderColor: "var(--color-border)" }}
    >
      {buttons}
    </div>
  );
}
