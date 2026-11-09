// Intervención de Codex o Gemini dentro del hilo de Claude (E8): cabecera con
// el color del motor, prompt, últimos eventos con `⎿`, resumen y las acciones
// «Traer a Claude» (pega el resumen en el PTY) y «Descartar».

import { memo, useState } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { ENGINE_LABEL } from "../../engines";
import { formatAgo } from "../../parse";
import { saveDismissed } from "../../engine-dismissed";
import { store } from "../../store";
import type { EngineTask } from "../../types";
import { useChatScope } from "./ChatContext";
import { EngineThread } from "./EngineThread";
import { Markdown } from "./Markdown";

const STATUS_LABEL: Record<EngineTask["status"], string> = {
  running: "en curso",
  done: "terminada",
  error: "con error",
  cancelled: "cancelada",
};

const EVENT_MARK: Record<EngineTask["events"][number]["kind"], string> = { command: "$ ", patch: "± ", error: "! ", warning: "· ", message: "" };

function headline(task: EngineTask): string {
  const kind = task.kind === "opinion" ? "segunda opinión" : "tarea";
  const where = task.engine === "codex" ? ` · ${task.mode === "cloud" ? "cloud" : "local"}` : "";
  const ctx = task.contextChars ? ` · contexto ${task.contextChars.toLocaleString("es-ES")} car.` : "";
  return `${kind}${where} · ${STATUS_LABEL[task.status]}${ctx} · ${formatAgo(task.startedAt)}`;
}

function promptPreview(task: EngineTask): string {
  if (task.kind === "opinion") return "Revisa críticamente la última respuesta de Claude";
  return task.prompt.split("\n")[0];
}

export function EngineActions({ task }: { task: EngineTask }) {
  const api = useApi();
  const scope = useChatScope();
  const [sending, setSending] = useState(false);
  const sessionId = scope?.sessionId ?? task.sessionId;
  const brought = Boolean(task.broughtAt);
  const canBring = task.status === "done" && !brought && Boolean(sessionId) && !scope?.readOnly;

  async function bring() {
    if (!sessionId) return;
    setSending(true);
    try {
      await api.engineBring({ taskId: task.id, sessionId });
    } catch (e) {
      reportError(e);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="eb-acts">
      {task.status === "running" && (
        <button className="btn sm danger" onClick={() => api.engineCancel(task.id).catch(reportError)}>Cancelar</button>
      )}
      {canBring && (
        <button className="btn sm pri" disabled={sending} onClick={() => void bring()}
          title="Pega el resumen en la sesión de Claude; nada entra en su contexto hasta pulsar aquí">
          Traer a Claude
        </button>
      )}
      {brought && <span className="live-tag" title={task.broughtAt}>Traído a Claude</span>}
      <button className="btn sm ghost" onClick={() => dismiss(task.id)}
        title="Quita el bloque del hilo; la tarea sigue en la pestaña Motores">
        Descartar
      </button>
    </div>
  );
}

/** Quita el bloque y lo recuerda entre recargas; si no se puede guardar, lo dice. */
function dismiss(taskId: string) {
  store.dispatch({ type: "engineDismiss", taskId });
  if (!saveDismissed(store.getState().dismissed)) reportError("No se pudo guardar el descarte: el bloque volverá al recargar la ventana.");
}

function EngineBlockImpl({ task }: { task: EngineTask }) {
  // El relevo automático se lee como hilo completo; el resto, en bloque compacto.
  if (task.kind === "relay") return <EngineThread task={task} />;
  const events = task.events.slice(-6);
  return (
    <article className="msg engine" id={`engine-task-${task.id}`} data-engine-task={task.id} data-engine={task.engine} data-testid="engine-block" aria-label={`${ENGINE_LABEL[task.engine]}: ${task.kind === "opinion" ? "segunda opinión" : "tarea"}`}>
      <div className="meta">
        <span className={`who ${task.engine}`}>{ENGINE_LABEL[task.engine]}</span>
        <span>{headline(task)}</span>
        {task.status === "running" && <span className="spin" aria-label="En curso" />}
      </div>
      <div className="line">
        <span className="mk prompt" aria-hidden="true">❯</span>
        <div className="ubody eb-prompt" title={task.prompt}>{promptPreview(task)}</div>
      </div>
      {events.length > 0 && (
        <div className="eb-events" aria-label="Eventos">
          {events.map((e, i) => (
            <div key={i} className={`tl-res ${e.kind}`}>
              <span className="mk res" aria-hidden="true">⎿</span>
              <span className="r">{EVENT_MARK[e.kind]}{e.text}</span>
            </div>
          ))}
        </div>
      )}
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

export const EngineBlock = memo(EngineBlockImpl);
