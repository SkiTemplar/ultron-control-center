// Tarjeta en vivo de un run de `Workflow` bajo su llamada en el chat: nombre,
// fases con progreso, una fila por agente (estado, tiempo, última actividad,
// tokens) y el resultado final. Clic en un agente: abre su transcript en el
// panel con foco; Mayús+clic: en un panel nuevo. Mientras corre va
// desplegada y el tiempo avanza cada segundo; al terminar se pliega.

import { useEffect, useState, type ReactNode } from "react";
import { openAgentThread } from "../../open-agents";
import { formatTokens } from "../../parse";
import { useStore } from "../../store";
import type { ToolResultBlock, ToolUseBlock } from "../../parse";
import type { ChatMessage, SessionId } from "../../types";
import {
  activePhase, effectiveStatus, elapsedMs, formatElapsed, notifiedStatus, runIdFromWorkflowTool, runProgress,
  type WfAgentStatus, type WorkflowAgent, type WorkflowPhase, type WorkflowRun, type WorkflowStatus,
} from "../../workflows";
import { useChatScope } from "./ChatContext";
import "../../styles/workflow.css";

/** Lista vacía estable: `notifiedStatus` indexa por identidad de la lista. */
const NO_MESSAGES: readonly ChatMessage[] = [];

const RUN_LABEL: Record<WorkflowStatus, string> = {
  running: "en curso", completed: "completado", failed: "fallido", killed: "abortado", stopped: "detenido sin cerrar",
};

const AGENT_LABEL: Record<WfAgentStatus, string> = {
  running: "en curso", done: "hecho", failed: "fallido", cached: "reutilizado", stopped: "detenido",
};

/** Hora actual que avanza cada segundo solo mientras `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

function Phases({ phases, active }: { phases: WorkflowPhase[]; active: number | null }) {
  if (phases.length === 0) return null;
  return (
    <ol className="wf-phases" aria-label="Fases">
      {phases.map((p) => (
        <li key={p.index} className="wf-phase" aria-current={p.index === active ? "step" : undefined} title={p.detail ?? p.title}>
          <span className="wf-phase-t">{p.title}</span>
          <span className="wf-phase-n num">{p.total > 0 ? `${p.done}/${p.total}` : "—"}{p.failed > 0 && <span className="errc"> · {p.failed} ✗</span>}</span>
          <span className="wf-meter"><i style={{ width: `${p.total > 0 ? (p.done / p.total) * 100 : 0}%` }} /></span>
        </li>
      ))}
    </ol>
  );
}

function AgentRow({ a, sessionId, now }: { a: WorkflowAgent; sessionId: SessionId; now: number }) {
  const running = a.status === "running";
  const retry = a.attempt > 1;
  const kind = [a.agentType, a.model].filter(Boolean).join(" · ");
  return (
    <li>
      <button className="wf-agent" data-status={a.status} onClick={(e) => openAgentThread(sessionId, a.agentId, e.shiftKey)} title="Ver transcript · Mayús: en panel nuevo">
        <span className={`wf-dot ${a.status}`} aria-label={AGENT_LABEL[a.status]} />
        <span className="wf-label">{a.label}</span>
        {retry && <span className="wf-retry">{running ? `reintento ${a.attempt}` : `intento ${a.attempt}`}</span>}
        <span className="wf-nums num">
          {formatElapsed(elapsedMs(a, running, now))}
          {a.contextTokens != null && ` · ${formatTokens(a.contextTokens)} tok`}
          {a.toolCalls != null && ` · ${a.toolCalls} herr.`}
        </span>
        {kind && <span className="wf-kind">{kind}</span>}
        <span className="wf-act">{a.status === "done" && a.resultPreview ? `⎿ ${a.resultPreview.split("\n")[0]}` : a.lastActivity ?? AGENT_LABEL[a.status]}</span>
      </button>
    </li>
  );
}

export function WorkflowCard({ run, sessionId, notified }: { run: WorkflowRun; sessionId: SessionId; notified: WorkflowStatus | null }) {
  const status = effectiveStatus(run, notified);
  const running = status === "running";
  const now = useNow(running);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? running;
  const prog = runProgress(run);
  const tokens = run.totalTokens ?? run.agents.reduce((n, a) => n + (a.contextTokens ?? 0), 0);
  return (
    <section className="wf-card" data-status={status} aria-label={`Workflow ${run.name}`}>
      <button className="wf-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)} title={expanded ? "Plegar" : "Desplegar"}>
        <span className={`wf-dot ${status}`} />
        <span className="wf-name">{run.name}</span>
        <span className="wf-st">{RUN_LABEL[status]}</span>
        <span className="wf-nums num">
          {prog.done}/{prog.total} agentes{prog.failed > 0 && ` · ${prog.failed} fallidos`} · {formatElapsed(elapsedMs(run, running, now))}
          {tokens > 0 && ` · ${formatTokens(tokens)} tok`}
          {run.totalToolCalls != null && ` · ${run.totalToolCalls} herr.`}
        </span>
      </button>
      {expanded && run.description && <p className="wf-desc">{run.description}</p>}
      {expanded && <Phases phases={run.phases} active={activePhase(run)} />}
      {expanded && run.agents.length > 0 && (
        <ul className="wf-agents" aria-label="Agentes">
          {run.agents.map((a) => <AgentRow key={a.key} a={a} sessionId={sessionId} now={now} />)}
        </ul>
      )}
      {expanded && run.agents.length === 0 && running && <p className="wf-desc">Esperando al primer agente…</p>}
      {status === "stopped" && <p className="wf-note">El run no dejó resultado final: el proceso de Claude que lo ejecutaba ya no está.</p>}
      {run.error && <p className="wf-err" role="alert">{run.error}</p>}
      {run.resultPreview && (
        <details className="wf-result">
          <summary>Resultado</summary>
          <pre>{run.resultPreview}</pre>
        </details>
      )}
    </section>
  );
}

/**
 * Llamada `Workflow`: la fila de herramienta de siempre (`children`) y, debajo,
 * la tarjeta de su run. Sin runId, en un hilo de subagente o sin lista cargada,
 * solo la fila; con la lista cargada y el run ausente, un aviso explícito.
 */
export function WorkflowToolRow({ tool, result, children }: { tool: ToolUseBlock; result?: ToolResultBlock; children: ReactNode }) {
  const scope = useChatScope();
  const sessionId = scope && !scope.readOnly ? scope.sessionId : null;
  const runId = runIdFromWorkflowTool(tool.input, result?.text);
  const run = useStore((s) => (sessionId && runId ? s.bySession[sessionId]?.workflows[runId] ?? null : null));
  const loaded = useStore((s) => (sessionId ? s.bySession[sessionId]?.workflowsLoaded === true : false));
  const notified = useStore((s) => (sessionId && run ? notifiedStatus(s.bySession[sessionId]?.messages ?? NO_MESSAGES, tool.id) : null));
  return (
    <>
      {children}
      {sessionId && run && <WorkflowCard run={run} sessionId={sessionId} notified={notified} />}
      {sessionId && runId && !run && loaded && (
        <p className="wf-missing" role="status">No se encuentra el registro del run {runId} en disco (borrado o de otra máquina).</p>
      )}
    </>
  );
}
