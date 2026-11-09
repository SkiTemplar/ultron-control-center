// Tarjeta de una tarea de Motores: estado, tokens, resumen, eventos y
// acciones («Traer a Claude» una sola vez, cancelar).

import { useState } from "react";
import { reportError } from "../../bootstrap";
import { useApi } from "../../context";
import { ENGINE_LABEL, formatUsage } from "../../engines";
import { formatAgo } from "../../parse";
import type { EngineTask, SessionInfo } from "../../types";
import { Markdown } from "../chat/Markdown";

const STATUS_LABEL: Record<EngineTask["status"], string> = { running: "en curso", done: "terminada", error: "con error", cancelled: "cancelada" };
const KIND_LABEL: Partial<Record<EngineTask["kind"], string>> = { opinion: "Segunda opinión", review: "Revisión automática" };

/** «Traer a Claude» con estado de envío: un doble clic no manda dos veces. */
function BringButton({ task, target }: { task: EngineTask; target: string }) {
  const api = useApi();
  const [sending, setSending] = useState(false);
  async function bring() {
    setSending(true);
    try {
      await api.engineBring({ taskId: task.id, sessionId: target });
    } catch (e) {
      reportError(e);
    } finally {
      setSending(false);
    }
  }
  return (
    <button className="btn sm pri" disabled={sending} aria-busy={sending} onClick={() => void bring()}>
      {sending ? "Enviando…" : "Traer a Claude"}
    </button>
  );
}

/** En un Tribunal, el título es el del grupo; cada tarjeta muestra solo su motor. */
export function TaskCard({ task, session, inTribunal = false }: { task: EngineTask; session: SessionInfo | null; inTribunal?: boolean }) {
  const api = useApi();
  const dot = task.status === "running" ? `${task.engine} running` : task.status === "error" ? "error" : task.engine;
  const target = task.sessionId ?? session?.id;
  const usage = formatUsage(task);
  const title = KIND_LABEL[task.kind] ?? task.prompt;
  return (
    <div className={`cx ${task.engine}`} data-testid="engine-task">
      <div className="cx-head">
        <span className={`dot ${dot}`} />
        {!inTribunal && <span className="t" title={task.prompt}>{title}</span>}
        <span className={`badge ${task.engine}`}>{ENGINE_LABEL[task.engine]}{task.engine === "codex" ? ` · ${task.mode}` : ""}{task.model ? ` · ${task.model}` : ""}</span>
        <span className="s">
          {STATUS_LABEL[task.status]} · {formatAgo(task.startedAt)}{task.cloudTaskId ? ` · ${task.cloudTaskId}` : ""}
          {usage && <span title={task.usage ? `Entrada ${task.usage.inputTokens} (caché ${task.usage.cachedInputTokens}) · salida ${task.usage.outputTokens}` : undefined}> · {usage}</span>}
        </span>
      </div>
      {task.summary && <div className="cx-sum"><Markdown text={task.summary} /></div>}
      {task.events.length > 0 && (
        <div className="cx-events" aria-label="Eventos de la tarea">
          {task.events.slice(-10).map((e, i) => (
            <div key={i} className={e.kind}>{e.kind === "command" ? "$ " : e.kind === "patch" ? "± " : ""}{e.text}</div>
          ))}
        </div>
      )}
      <div className="cx-acts">
        {task.status === "done" && !task.broughtAt && target && <BringButton task={task} target={target} />}
        {task.broughtAt && <span className="s">Traído a Claude</span>}
        {task.status === "running" && <button className="btn sm danger" onClick={() => api.engineCancel(task.id).catch(reportError)}>Cancelar</button>}
      </div>
    </div>
  );
}
