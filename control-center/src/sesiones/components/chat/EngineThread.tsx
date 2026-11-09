// Turno del relevo automático (Claude → Codex → Gemini) como hilo legible del
// chat: el mensaje del usuario (o el traspaso desde Claude, plegado), todos los
// eventos del motor plegados en «N acciones» salvo los errores, que se ven
// siempre, y la respuesta con el mismo Markdown que los mensajes de Claude.

import { memo } from "react";
import { ENGINE_LABEL } from "../../engines";
import { formatAgo } from "../../parse";
import type { EngineEvent, EngineTask } from "../../types";
import { EngineActions } from "./EngineBlock";
import { Markdown } from "./Markdown";

const STATUS_LABEL: Record<EngineTask["status"], string> = {
  running: "en curso",
  done: "terminado",
  error: "con error",
  cancelled: "cancelado",
};

const EVENT_MARK: Record<EngineEvent["kind"], string> = { command: "$ ", patch: "± ", error: "! ", warning: "· ", message: "" };

/** Inicio del prompt que compone `compose_handoff` (relevo.rs). */
const HANDOFF_PREFIX = "Continua el trabajo de Claude";

export function isHandoff(prompt: string): boolean {
  return prompt.trimStart().startsWith(HANDOFF_PREFIX);
}

function UserTurn({ prompt }: { prompt: string }) {
  if (isHandoff(prompt)) {
    return (
      <details className="et-handoff" data-testid="engine-handoff">
        <summary>Traspaso desde Claude</summary>
        <pre className="et-handoff-text">{prompt}</pre>
      </details>
    );
  }
  return (
    <div className="line">
      <span className="mk prompt" aria-hidden="true">❯</span>
      <div className="ubody"><div className="utext">{prompt}</div></div>
    </div>
  );
}

export function EventLine({ e }: { e: EngineEvent }) {
  return (
    <div className={`tl-res ${e.kind}`}>
      <span className="mk res" aria-hidden="true">⎿</span>
      <span className="r">{EVENT_MARK[e.kind]}{e.text}</span>
    </div>
  );
}

function Events({ events }: { events: EngineEvent[] }) {
  const errors = events.filter((e) => e.kind === "error");
  const actions = events.filter((e) => e.kind !== "error");
  return (
    <>
      {actions.length > 0 && (
        <details className="et-actions" data-testid="engine-actions">
          <summary>{actions.length === 1 ? "1 acción" : `${actions.length} acciones`}</summary>
          <div className="eb-events">{actions.map((e, i) => <EventLine key={i} e={e} />)}</div>
        </details>
      )}
      {errors.length > 0 && (
        <div className="eb-events" role="alert" data-testid="engine-errors">
          {errors.map((e, i) => <EventLine key={i} e={e} />)}
        </div>
      )}
    </>
  );
}

function EngineThreadImpl({ task }: { task: EngineTask }) {
  const running = task.status === "running";
  return (
    <article
      className="msg engine relay"
      id={`engine-task-${task.id}`}
      data-engine-task={task.id}
      data-engine={task.engine}
      data-testid="engine-thread"
      aria-label={`${ENGINE_LABEL[task.engine]}: relevo`}
    >
      <UserTurn prompt={task.prompt} />
      <div className="meta">
        <span className={`who ${task.engine}`}>{ENGINE_LABEL[task.engine]}</span>
        <span>relevo · {STATUS_LABEL[task.status]} · {formatAgo(task.startedAt)}</span>
        {running && <span className="spin" aria-label="En curso" />}
      </div>
      <Events events={task.events} />
      {task.summary && (
        <div className="line">
          <span className="mk reply" aria-hidden="true">⏺</span>
          <Markdown text={task.summary} />
        </div>
      )}
      <EngineActions task={task} />
    </article>
  );
}

export const EngineThread = memo(EngineThreadImpl);
